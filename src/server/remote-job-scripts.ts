import type { ProjectSshQuery, RemoteParamType } from '../shared/project-cli-context.ts';
import { spawnTarget, terminateProcess } from './adapters/process.ts';
import { sanitized } from './project-cli-context.ts';
import { hardenedSshOptions } from './ssh-options.ts';

export { hardenedSshOptions };
export const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

const patterns: Record<RemoteParamType, RegExp> = {
  sha: /^[0-9a-f]{40}$/,
  branch: /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/,
  relpath: /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/,
  word: /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,
  int: /^[0-9]{1,9}$/,
};

export function validateJobOptions(
  input: Record<string, unknown>,
): Pick<ProjectSshQuery, 'params' | 'push' | 'cwd' | 'background' | 'readOnly'> {
  const fail = () => {
    throw new Error('远程作业配置无效。');
  };
  const result: Pick<ProjectSshQuery, 'params' | 'push' | 'cwd' | 'background' | 'readOnly'> = {};
  if (input.params !== undefined) {
    if (!input.params || typeof input.params !== 'object' || Array.isArray(input.params)) fail();
    const entries = Object.entries(input.params as object);
    if (
      entries.length > 8 ||
      entries.some(
        ([name, type]) =>
          !/^[a-z][a-z0-9_]{0,31}$/.test(name) || typeof type !== 'string' || !Object.hasOwn(patterns, type),
      )
    )
      fail();
    result.params = Object.fromEntries(entries);
  }
  for (const [index, arg] of (input.argv as string[]).entries()) {
    if (!arg.includes('{')) continue;
    const match = /^\{([a-z][a-z0-9_]{0,31})\}$/.exec(arg);
    if (!index || !match || !Object.hasOwn(result.params ?? {}, match[1]!)) fail();
  }
  for (const key of ['background', 'readOnly'] as const) {
    if (input[key] !== undefined) {
      if (input[key] !== true) fail();
      result[key] = true;
    }
  }
  if (input.cwd !== undefined) {
    if (typeof input.cwd !== 'string' || !input.cwd.startsWith('/') || /[\x00-\x1f\x7f]/.test(input.cwd)) fail();
    result.cwd = input.cwd as string;
  }
  if (input.push !== undefined) {
    if (!result.background || !input.push || typeof input.push !== 'object' || Array.isArray(input.push)) fail();
    const push = input.push as Record<string, unknown>;
    if (
      Object.keys(push).some((key) => !['repository', 'refs'].includes(key)) ||
      typeof push.repository !== 'string' ||
      !/^(?:~\/|\/)[A-Za-z0-9._\/-]{1,255}$/.test(push.repository) ||
      push.repository.includes('..') ||
      !Array.isArray(push.refs) ||
      !push.refs.length ||
      push.refs.length > 4
    )
      fail();
    for (const ref of push.refs as unknown[]) {
      if (typeof ref !== 'string' || !/^\+?[A-Za-z0-9{}._\/-]+:[A-Za-z0-9{}._\/-]+$/.test(ref)) fail();
      const literal = (ref as string).replace(/\{(sha|branch)\}/g, (_placeholder, name: string) => {
        if (result.params?.[name] !== name) fail();
        return 'value';
      });
      if (/[{}]/.test(literal)) fail();
    }
    result.push = { repository: push.repository as string, refs: [...(push.refs as string[])] };
  }
  return result;
}

export function substituteParams(query: ProjectSshQuery, input: unknown): { argv: string[]; refs: string[] } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('远程作业参数无效。');
  const values = input as Record<string, unknown>,
    declared = query.params ?? {};
  if (
    Object.keys(values).length !== Object.keys(declared).length ||
    Object.keys(values).some((key) => !Object.hasOwn(declared, key))
  )
    throw new Error('远程作业参数必须与定义一一对应。');
  for (const [name, type] of Object.entries(declared)) {
    const value = values[name];
    if (
      typeof value !== 'string' ||
      !patterns[type].test(value) ||
      (type === 'branch' &&
        (value.includes('..') ||
          value.endsWith('/') ||
          value.endsWith('.') ||
          value.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'))))
    )
      throw new Error('远程作业参数无效：' + name);
  }
  const replace = (text: string) =>
    text.replace(/\{([a-z][a-z0-9_]{0,31})\}/g, (_all, name: string) => values[name] as string);
  return { argv: query.argv.map(replace), refs: query.push?.refs.map(replace) ?? [] };
}

function jobDirectory(id: string) {
  if (!/^rj-[0-9]{8}-[0-9a-f]{8}$/.test(id)) throw new Error('远程作业编号无效。');
  return 'd="$HOME/.pugport-jobs/' + id + '"';
}

export const runScript = [
  '#!/bin/sh',
  'd=$1; t=$2; c=$3; shift 3',
  'cd "$c" || { echo 4 >"$d/exit"; exit 4; }',
  'timeout -k 30 "$t" "$@" &',
  'echo $! >"$d/tpid"',
  'wait $!',
  'echo $? >"$d/exit"',
  '',
].join('\n');

export function startScript(id: string, timeout: number, cwd: string | undefined, argv: string[]) {
  if (
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > 14400 ||
    !argv.length ||
    argv.some((arg) => arg.includes('\0')) ||
    cwd?.includes('\0')
  )
    throw new Error('远程作业启动参数无效。');
  // A daemon started by the job must close fd 9, or it will keep the server lock.
  return [
    'set -eu',
    'for tool in flock setsid timeout; do',
    'command -v "$tool" >/dev/null || { echo NOTOOLS; exit 5; }',
    'done',
    'base="$HOME/.pugport-jobs"',
    'mkdir -p "$base"',
    'find "$base" -maxdepth 1 -name \'rj-*\' -mtime +7 -exec rm -rf {} + 2>/dev/null || :',
    'exec 9>>"$base/lock"',
    'flock -n 9 || { echo BUSY; exit 3; }',
    'tmp="$base/run.sh.$$"',
    'cat >"$tmp" <<\'PUGPORT_RUNNER\'',
    runScript + 'PUGPORT_RUNNER',
    'chmod +x "$tmp"',
    'mv -f "$tmp" "$base/run.sh"',
    jobDirectory(id),
    'mkdir "$d"',
    'setsid nohup "$base/run.sh" "$d" ' +
      [String(timeout), cwd ?? '.', ...argv].map(shellQuote).join(' ') +
      ' >"$d/out.log" 2>&1 </dev/null &',
    'echo STARTED',
    '',
  ].join('\n');
}

export function statusScript(id: string) {
  return [
    'set -eu',
    jobDirectory(id),
    'cat "$d/exit" 2>/dev/null || :',
    'echo ---',
    '{ grep \'^RESULT:\' "$d/out.log" 2>/dev/null || :; } | head -n 50 | head -c 4000',
    "printf '\\n---\\n'",
    'tail -c 32768 "$d/out.log" 2>/dev/null || :',
    '',
  ].join('\n');
}

export function cancelScript(id: string) {
  return [
    'set -eu',
    jobDirectory(id),
    'p=$(cat "$d/tpid")',
    '[ -e "$d/exit" ] && exit 0',
    '[ "$(ps -o comm= -p "$p")" = timeout ] || exit 0',
    'kill -TERM "$p"',
    '',
  ].join('\n');
}

export function jobSshArgs(host: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(host)) throw new Error('SSH 主机别名无效。');
  return ['-T', ...hardenedSshOptions(), '--', host, 'sh -s'];
}

/** The caller awaits this before starting SSH; a failure must stop the job start. */
export async function pushRemoteJob(
  projectPath: string,
  query: ProjectSshQuery,
  params: unknown,
  signal?: AbortSignal,
  launch: typeof spawnTarget = spawnTarget,
  terminate: typeof terminateProcess = terminateProcess,
): Promise<void> {
  if (!query.push) return;
  const { refs } = substituteParams(query, params);
  const repository = query.push.repository.startsWith('~/')
    ? '/~/' + query.push.repository.slice(2)
    : query.push.repository;
  const controller = new AbortController();
  const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
  const timer = setTimeout(() => controller.abort(), 300_000);
  let child: Awaited<ReturnType<typeof spawnTarget>> | undefined;
  let stopping: Promise<void> | undefined;
  let stderr = '';
  let rejectAbort: (error: Error) => void = () => {};
  const failure = () => new Error('远程作业推送失败，未启动作业。' + (stderr ? '\n' + sanitized(stderr) : ''));
  const abort = () => {
    if (child) {
      stopping ??= terminate(child);
      void stopping.catch(() => {});
    }
    rejectAbort(failure());
  };
  combined.addEventListener('abort', abort, { once: true });
  try {
    combined.throwIfAborted();
    child = await launch(
      {
        id: 'project-remote-job-push',
        provider: 'codex',
        label: 'Remote job push',
        command: 'git',
        environment: 'native',
        enabled: true,
      },
      ['push', '--', 'ssh://' + query.host + repository, ...refs],
      {
        cwd: projectPath,
        syncAccountConfig: false,
        signal: combined,
        env: {
          ...process.env,
          GIT_SSH_COMMAND: ['ssh', '-T', ...hardenedSshOptions()].map(shellQuote).join(' '),
          GIT_SSH_VARIANT: 'ssh',
          GIT_TERMINAL_PROMPT: '0',
        },
      },
    );
    const closed = new Promise<number | null>((resolve, reject) => {
      rejectAbort = reject;
      child!.once('close', resolve);
      child!.once('error', reject);
      if (child!.exitCode !== null) resolve(child!.exitCode);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) <= 4096) return;
      const data = Buffer.from(stderr);
      let offset = data.length - 4096;
      while (offset < data.length && (data[offset]! & 0xc0) === 0x80) offset++;
      stderr = data.subarray(offset).toString('utf8');
    });
    child.stdout.resume();
    child.stdin.end();
    if (combined.aborted) abort();
    if ((await closed) !== 0 || combined.aborted) throw failure();
  } finally {
    clearTimeout(timer);
    combined.removeEventListener('abort', abort);
    if (child) await (stopping ?? terminate(child));
  }
}

/** Start/status/cancel use the same stdin transport; callers own output and process cleanup. */
export async function spawnJobScript(
  host: string,
  script: string,
  options: Parameters<typeof spawnTarget>[2],
  launch: typeof spawnTarget = spawnTarget,
) {
  const child = await launch(
    {
      id: 'project-remote-job',
      provider: 'codex',
      label: 'Remote job',
      command: 'ssh',
      environment: 'native',
      enabled: true,
    },
    jobSshArgs(host),
    { ...options, syncAccountConfig: false },
  );
  child.stdin.end(script);
  return child;
}
