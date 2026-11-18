import { execFile } from '../server/platform/test-process.ts';
import { readFile, readlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import type { CallerProbeInput } from '../shared/caller-signals.ts';

export type { CallerProbeInput } from '../shared/caller-signals.ts';

type ProcessEntry = { exe: string; args: string[]; ppid: number; cwd?: string };
/** All IO is injectable. Synthetic tests never consult the real process tree or home. */
export type CallerProbeDependencies = {
  platform: string;
  ppid: number;
  env: Record<string, string | undefined>;
  cwd: () => string;
  home: () => string;
  now: () => number;
  fs: { readFile: (path: string) => Promise<string>; readlink: (path: string) => Promise<string> };
  run: (file: string, args: string[], timeout: number) => Promise<string>;
};

const envNames = ['WSL_DISTRO_NAME', 'WSL_INTEROP'];

/** Windows argv quoting (backslashes before quotes); ps fallback uses shell-style quoting. */
function splitCommand(command: string, windows: boolean): string[] {
  const args: string[] = [];
  let value = '',
    quote = '',
    started = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (windows && char === '\\') {
      let end = i;
      while (command[end] === '\\') end++;
      const count = end - i;
      if (command[end] === '"') {
        value += '\\'.repeat(Math.floor(count / 2));
        if (count % 2) value += '"';
        else quote = quote ? '' : '"';
        i = end;
      } else {
        value += '\\'.repeat(count);
        i = end - 1;
      }
      started = true;
    } else if (!windows && char === '\\' && quote !== "'") {
      value += command[++i] ?? '';
      started = true;
    } else if (char === '"' || (!windows && char === "'")) {
      if (!quote) quote = char;
      else if (quote === char) quote = '';
      else value += char;
      started = true;
    } else if (/\s/.test(char) && !quote) {
      if (started) args.push(value);
      value = '';
      started = false;
    } else {
      value += char;
      started = true;
    }
  }
  if (started) args.push(value);
  return args;
}

export function createCallerProbe(deps: CallerProbeDependencies): () => Promise<CallerProbeInput> {
  let cached: Promise<CallerProbeInput> | undefined;
  return () =>
    (cached ??= collect(deps).then((result) => {
      if (result.timedOut || !result.chain.length) cached = undefined;
      return result;
    }));
}

async function collect(deps: CallerProbeDependencies): Promise<CallerProbeInput> {
  const result: CallerProbeInput = { chain: [], envNames: [] };
  if (deps.env.PUGPORT_MCP_PROBE === 'off') return result;
  const deadline = deps.now() + 10_000;
  const remaining = () => Math.max(0, deadline - deps.now());
  // Also bound unresponsive filesystem operations. Late results are discarded.
  async function bounded<T>(work: () => Promise<T>): Promise<T | undefined> {
    const ms = remaining();
    if (!ms) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        work(),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), ms);
        }),
      ]);
      return remaining() > 0 ? value : undefined;
    } catch {
      return undefined;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const read = (path: string) => bounded(() => deps.fs.readFile(path));
  const run = (file: string, args: string[]) =>
    bounded(() => deps.run(file, args, Math.max(1, Math.floor(remaining()))));
  const windows = deps.platform === 'win32';
  const paths = windows ? win32 : posix;
  result.envNames = envNames.filter((name) => deps.env[name] !== undefined);
  // The caller marker is the sole identity value; CODEX_HOME is used only to locate its allowed config.
  if (deps.env.PUGPORT_CALLER !== undefined) result.pugportCaller = deps.env.PUGPORT_CALLER;
  try {
    result.cwd = deps.cwd();
  } catch {
    /* cwd may have been removed */
  }

  async function lookup(pid: number): Promise<ProcessEntry | undefined> {
    const command = await read(`/proc/${pid}/cmdline`);
    if (command) {
      const argv = command.split('\0');
      if (argv.at(-1) === '') argv.pop();
      // /proc/stat is needed only for the next parent PID, not for environment or other process data.
      const stat = await read(`/proc/${pid}/stat`);
      const parent = stat && /^\d+ \([\s\S]*\) \S (\d+)\s/.exec(stat)?.[1];
      const cwd = await bounded(() => deps.fs.readlink(`/proc/${pid}/cwd`));
      if (parent) return { exe: argv[0], args: argv.slice(1), ppid: Number(parent), cwd };
    }
    const text = await run('ps', ['-o', 'ppid=,command=', '-p', String(pid)]);
    const row = text && /^\s*(\d+)\s+([^\r\n]+)/.exec(text);
    if (!row) return undefined;
    const argv = splitCommand(row[2], false);
    return argv[0] ? { exe: argv[0], args: argv.slice(1), ppid: Number(row[1]) } : undefined;
  }

  const push = (entry: ProcessEntry) => {
    if (!/^(?:cmd|powershell|pwsh)(?:\.exe)?$/i.test(paths.basename(entry.exe))) {
      if (!result.chain.length && entry.cwd) result.cwd = entry.cwd;
      result.chain.push({ exe: entry.exe, args: entry.args });
    }
  };
  let pid = deps.ppid;
  if (windows && Number.isSafeInteger(pid) && pid > 0) {
    const script = `$id = ${pid}; $seen = @{}; $rows = @(); for ($i = 0; $i -lt 5 -and $id -gt 0 -and -not $seen.ContainsKey($id); $i++) { $seen[$id] = $true; $row = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $id); if (-not $row) { break }; $rows += $row | Select-Object ExecutablePath,CommandLine,ParentProcessId; $id = [int]$row.ParentProcessId }; ConvertTo-Json -Compress -InputObject @($rows)`;
    const text = await run(
      win32.join(deps.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', script],
    );
    if (text) {
      try {
        const rows = JSON.parse(text);
        if (Array.isArray(rows))
          for (const row of rows.slice(0, 5)) {
            const argv = splitCommand(typeof row.CommandLine === 'string' ? row.CommandLine : '', true);
            const exe = typeof row.ExecutablePath === 'string' ? row.ExecutablePath : argv[0];
            if (exe) push({ exe, args: argv.slice(1), ppid: Number(row.ParentProcessId) });
          }
      } catch {
        /* Invalid process output is treated as an empty chain. */
      }
    }
  } else if (!windows) {
    const seen = new Set<number>();
    for (let hop = 0; hop < 5 && remaining() > 0 && Number.isSafeInteger(pid) && pid > 0 && !seen.has(pid); hop++) {
      seen.add(pid);
      const entry = await lookup(pid);
      if (!entry || remaining() <= 0) break;
      push(entry);
      pid = entry.ppid;
    }
  }
  result.timedOut = remaining() <= 0;

  let home: string;
  try {
    home = deps.home();
  } catch {
    return result;
  }
  const config: NonNullable<CallerProbeInput['config']> = {};
  const codexHome =
    deps.env.CODEX_HOME && paths.isAbsolute(deps.env.CODEX_HOME) ? deps.env.CODEX_HOME : paths.join(home, '.codex');
  const codex = await read(paths.join(codexHome, 'config.toml'));
  if (codex !== undefined) config.codexToml = codex;
  const claudeFiles = [paths.join(home, '.claude', 'settings.json')];
  if (result.cwd)
    claudeFiles.push(
      paths.join(result.cwd, '.claude', 'settings.json'),
      paths.join(result.cwd, '.claude', 'settings.local.json'),
    );
  const settings: string[] = [];
  for (const file of new Set(claudeFiles)) {
    const text = await read(file);
    if (text !== undefined) settings.push(text);
  }
  if (settings.length) config.claudeSettings = settings;
  const grok = await read(paths.join(home, '.grok', 'config.toml'));
  if (grok !== undefined) config.grokToml = grok;
  if (Object.keys(config).length) result.config = config;
  result.timedOut = remaining() <= 0;
  return result;
}

const nativeProbe = createCallerProbe({
  platform: process.platform,
  ppid: process.ppid,
  env: process.env,
  cwd: () => process.cwd(),
  home: homedir,
  now: () => performance.now(),
  fs: { readFile: (path) => readFile(path, 'utf8'), readlink },
  run: (file, args, timeout) =>
    new Promise((resolve, reject) => {
      execFile(
        file,
        args,
        { timeout: Math.max(1, timeout), windowsHide: true, encoding: 'utf8', maxBuffer: 256 * 1024 },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        },
      );
    }),
});

/** One cached probe per stdio server process, including concurrent callers. */
export function probeCaller(): Promise<CallerProbeInput> {
  return nativeProbe();
}
