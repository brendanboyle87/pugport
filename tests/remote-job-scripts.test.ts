import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { ProjectCliContextService } from '../src/server/project-cli-context.ts';
import {
  cancelScript,
  hardenedSshOptions,
  jobSshArgs,
  pushRemoteJob,
  runScript,
  spawnJobScript,
  startScript,
  statusScript,
  substituteParams,
} from '../src/server/remote-job-scripts.ts';
import type { ProjectSshQuery, RemoteParamType } from '../src/shared/project-cli-context.ts';
import type { WorkspaceStore } from '../src/server/workspace-store.ts';
import type { spawnTarget } from '../src/server/adapters/process.ts';

const query: ProjectSshQuery = {
  name: 'build',
  host: 'saved-alias',
  argv: ['printf', '{sha}'],
  params: { sha: 'sha' },
  background: true,
};
function service() {
  const records = new Map<string, unknown>([['project:p', { id: 'p', path: process.cwd(), scope: 'project' }]]);
  return new ProjectCliContextService({
    get: <T>(kind: string, id: string) => structuredClone(records.get(kind + ':' + id)) as T | undefined,
    save: (kind: string, id: string, _owner: string, value: unknown) => {
      records.set(kind + ':' + id, structuredClone(value));
    },
  } as Pick<WorkspaceStore, 'get' | 'save'>);
}
async function save(value: unknown) {
  const context = service();
  await context.update('p', { revision: 0, autoMemoryDirectory: null, sshQueries: [value] } as never, {
    source: 'user',
  });
  return context;
}

test('job schema persists all options, preserves legacy queries and separates timeout limits', async () => {
  const full: ProjectSshQuery = {
    ...query,
    timeoutSeconds: 14400,
    cwd: '/tmp/build',
    readOnly: true,
    push: { repository: '~/bare.git', refs: ['{sha}:refs/heads/check'] },
  };
  assert.deepEqual((await save(full)).listQueries('p'), [full]);
  const forced = {
    ...query,
    params: { sha: 'sha' as const, branch: 'branch' as const },
    push: { repository: '/repo.git', refs: ['+{branch}:refs/heads/x'] },
  };
  assert.deepEqual((await save(forced)).listQueries('p'), [forced]);
  const legacy = { name: 'status', host: 'saved-alias', argv: ['true'], timeoutSeconds: 120 };
  assert.deepEqual((await save(legacy)).listQueries('p'), [legacy]);
  for (const patch of [
    { timeoutSeconds: 14401 },
    { timeoutSeconds: 0 },
    { timeoutSeconds: 1.5 },
    { background: undefined, timeoutSeconds: 121 },
    { background: false },
    { readOnly: false },
    { cwd: 'relative' },
    { cwd: '/tmp/line\n' },
    { cwd: 'C:/windows' },
  ])
    await assert.rejects(save({ ...query, ...patch }), Error, JSON.stringify(patch));
});

test('schema rejects partial, unknown and executable placeholders and unsafe declarations', async () => {
  for (const patch of [
    { argv: ['{sha}'] },
    { argv: ['echo', '--sha={sha}'] },
    { argv: ['echo', '{missing}'] },
    { argv: ['echo', '{sha}{sha}'] },
    { argv: ['echo', '{'] },
    { params: { sha: 'unknown' } },
    { params: { Sha: 'sha' } },
    { params: { ['a'.repeat(33)]: 'word' } },
    { params: Object.fromEntries(Array.from({ length: 9 }, (_, i) => ['p' + i, 'word'])) },
    { params: [] },
    { params: null },
    { push: { repository: '/repo', refs: [] } },
    { push: { repository: '/repo/../bad', refs: ['main:main'] } },
    { push: { repository: 'repo', refs: ['main:main'] } },
    { push: { repository: '/repo', refs: ['{missing}:main'] } },
    { params: { sha: 'word' }, push: { repository: '/repo', refs: ['{sha}:main'] } },
    { push: { repository: '/repo', refs: ['main:main'], extra: true } },
    { push: { repository: '/repo', refs: Array(5).fill('main:main') } },
    { background: undefined, push: { repository: '/repo', refs: ['main:main'] } },
  ])
    await assert.rejects(save({ ...query, ...patch }), Error, JSON.stringify(patch));
});

test('synchronous query refuses either params or background before launching', async () => {
  for (const job of [
    query,
    { ...query, background: undefined },
    { name: 'build', host: 'alias', argv: ['true'], background: true },
  ])
    await assert.rejects((await save(job)).runQuery('p', 'build'), /这是远程作业，请用 run_remote_job。/);
});

const cases: Record<RemoteParamType, { yes: string[]; no: string[] }> = {
  sha: {
    yes: ['a'.repeat(40), '0123456789'.repeat(4)],
    no: ['A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), '-abc', '..'],
  },
  branch: {
    yes: ['main', 'User/fix-7185', 'a'.repeat(128)],
    no: ['-main', 'a..b', 'a'.repeat(129), 'a/', 'a//b', 'a/.b', 'a.lock', 'a.', 'a@{b', 'a b'],
  },
  relpath: {
    yes: ['internal/foo', 'a..b', 'a/./b', 'a'.repeat(256)],
    no: ['../x', 'a/../x', 'a/..', '/root', '-file', 'a'.repeat(257), 'a\\b'],
  },
  word: { yes: ['fast', 'A_1-b', 'a'.repeat(64)], no: ['..', '-fast', 'a/b', 'a'.repeat(65), '中文'] },
  int: { yes: ['0', '0001', '123456789'], no: ['-1', '1.0', '..', '1234567890', '1e2'] },
};
for (const type of Object.keys(cases) as RemoteParamType[]) {
  test('parameter boundaries: ' + type, () => {
    const definition: ProjectSshQuery = { ...query, params: { value: type }, argv: ['echo', '{value}'] };
    for (const value of cases[type].yes)
      assert.deepEqual(substituteParams(definition, { value }).argv, ['echo', value]);
    for (const value of [...cases[type].no, '', cases[type].yes[0] + '\n', 'x\0'])
      assert.throws(() => substituteParams(definition, { value }), Error, value);
    for (const values of [{}, { value: cases[type].yes[0], extra: 'x' }, { other: 'x' }, { value: 1 }, null, []])
      assert.throws(() => substituteParams(definition, values));
  });
}

test('script contract: lock inheritance, atomic runner, timeout PID and bounded status', () => {
  const script = startScript('rj-20261027-0123abcd', 14400, undefined, ['echo', "it's", '$HOME']);
  assert.ok(script.startsWith('set -eu\nfor tool in flock setsid timeout; do'));
  assert.match(script, /echo NOTOOLS; exit 5/);
  assert.ok(script.includes('command -v "$tool" >/dev/null || { echo NOTOOLS; exit 5; }'));
  assert.match(script, /exec 9>>"\$base\/lock"/);
  assert.ok(script.indexOf('flock -n 9') < script.indexOf('mv -f'));
  assert.ok(script.indexOf('mv -f') < script.indexOf('setsid nohup'));
  assert.match(script, /mkdir -p "\$base"\nfind "\$base" -maxdepth 1 -name 'rj-\*' -mtime \+7/);
  assert.match(script, /echo BUSY; exit 3/);
  assert.match(script, /<<'PUGPORT_RUNNER'/);
  assert.match(script, /'14400' '\.' 'echo'/);
  assert.doesNotMatch(script, /sh -c|\[ -x/);
  assert.match(runScript, /cd "\$c" \|\| \{ echo 4/);
  assert.match(runScript, /timeout -k 30 "\$t" "\$@" &\necho \$! >"\$d\/tpid"\nwait \$!\necho \$\? >"\$d\/exit"/);
  assert.match(cancelScript('rj-20261027-0123abcd'), /p=\$\(cat "\$d\/tpid"\)/);
  assert.match(cancelScript('rj-20261027-0123abcd'), /\[ -e "\$d\/exit" \] && exit 0/);
  assert.match(cancelScript('rj-20261027-0123abcd'), /ps -o comm=/);
  assert.match(cancelScript('rj-20261027-0123abcd'), /kill -TERM "\$p"/);
  assert.match(statusScript('rj-20261027-0123abcd'), /head -n 50/);
  assert.match(statusScript('rj-20261027-0123abcd'), /head -c 4000/);
  assert.match(statusScript('rj-20261027-0123abcd'), /tail -c 32768/);
  for (const builder of [statusScript, cancelScript]) assert.throws(() => builder('../bad'));
  assert.throws(() => startScript('bad', 1, '/', ['true']));
});

test('real sh -s preserves the arguments generated on the start invocation line', (t) => {
  const candidates =
    process.platform === 'win32'
      ? ['C:/Program Files/Git/bin/sh.exe', 'C:/Program Files/Git/usr/bin/sh.exe', 'sh']
      : ['sh'];
  const attempts = candidates.map((command) => ({
    command,
    result: spawnSync(command, ['-s'], { input: 'exit 0\n', windowsHide: true }),
  }));
  const shell = attempts.find(({ result }) => result.status === 0)?.command;
  if (!shell)
    return t.skip(
      'sh 无法执行：' +
        attempts
          .map(
            ({ command, result }) =>
              command +
              ': ' +
              (result.error?.message ||
                result.stderr?.toString().trim() ||
                'exit=' + result.status + ', signal=' + result.signal),
          )
          .join('; '),
    );
  const script = startScript('rj-20261027-0123abcd', 1, '/', ['printf', '%s\\n', "it's", '$HOME', 'a b', '中文']);
  const line = script.split('\n').find((value) => value.startsWith('setsid nohup '))!;
  // Test only the invocation's quoting boundary, without pretending to run Linux flock/setsid.
  const invocation = line.slice(0, line.indexOf(' >"$d/out.log"'));
  const result = spawnSync(shell, ['-s'], {
    input: 'base=/synthetic; d=/synthetic\nsetsid() { shift 5; "$@"; }\n' + invocation + '\n',
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split('\n'), ["it's", '$HOME', 'a b', '中文', '']);
});

class Child extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
}
test('all job scripts use stdin and hardened SSH without -n', async () => {
  for (const script of [
    startScript('rj-20261027-0123abcd', 1, '/', ['true']),
    statusScript('rj-20261027-0123abcd'),
    cancelScript('rj-20261027-0123abcd'),
  ]) {
    const child = new Child();
    let received = '';
    child.stdin.on('data', (bytes) => {
      received += bytes.toString();
    });
    await spawnJobScript('saved-alias', script, { cwd: process.cwd() }, (async (target, args, options) => {
      assert.ok(options);
      assert.equal(target.command, 'ssh');
      assert.deepEqual(args, jobSshArgs('saved-alias'));
      assert.equal(args.includes('-n'), false);
      assert.deepEqual(args.slice(-3), ['--', 'saved-alias', 'sh -s']);
      assert.equal(options.syncAccountConfig, false);
      return child as unknown as Awaited<ReturnType<typeof spawnTarget>>;
    }) as typeof spawnTarget);
    assert.equal(received, script);
    assert.equal(child.stdin.writableEnded, true);
  }
});

test('push uses project cwd, ssh URLs, substituted refs and the query SSH settings; failures reject', async () => {
  for (const repository of ['/srv/bare.git', '~/bare.git'])
    for (const exitCode of [0, 1]) {
      const child = new Child();
      let launches = 0,
        terminations = 0;
      const pending = pushRemoteJob(
        process.cwd(),
        { ...query, push: { repository, refs: ['{sha}:refs/heads/check'] } },
        { sha: 'a'.repeat(40) },
        undefined,
        (async (target, args, options) => {
          launches++;
          assert.ok(options?.env?.GIT_SSH_COMMAND);
          assert.equal(target.command, 'git');
          assert.deepEqual(args, [
            'push',
            '--',
            repository.startsWith('~') ? 'ssh://saved-alias/~/bare.git' : 'ssh://saved-alias/srv/bare.git',
            'a'.repeat(40) + ':refs/heads/check',
          ]);
          assert.equal(options.cwd, process.cwd());
          assert.equal(options.syncAccountConfig, false);
          assert.equal(options.env.GIT_SSH_VARIANT, 'ssh');
          for (const [key, value] of Object.entries(process.env)) {
            if (['PATH', 'HOME', 'USERPROFILE', 'SSH_AUTH_SOCK'].includes(key.toUpperCase()))
              assert.ok(options.env[key] === value, key + ' is preserved');
          }
          for (const setting of hardenedSshOptions()) assert.ok(options.env.GIT_SSH_COMMAND.includes(setting));
          setImmediate(() => {
            child.exitCode = exitCode;
            child.emit('close', exitCode);
          });
          return child as unknown as Awaited<ReturnType<typeof spawnTarget>>;
        }) as typeof spawnTarget,
        async () => {
          terminations++;
        },
      );
      if (exitCode) await assert.rejects(pending, /推送失败/);
      else await pending;
      assert.equal(launches, 1);
      assert.equal(terminations, 1);
    }
});

test('push cancellation terminates the owned process, including termination failures', async () => {
  for (const failTermination of [false, true]) {
    const child = new Child(),
      controller = new AbortController();
    let terminated = 0;
    const pending = pushRemoteJob(
      process.cwd(),
      { ...query, push: { repository: '/repo', refs: ['{sha}:main'] } },
      { sha: 'a'.repeat(40) },
      controller.signal,
      (async () => {
        setImmediate(() => controller.abort());
        return child as unknown as Awaited<ReturnType<typeof spawnTarget>>;
      }) as typeof spawnTarget,
      async () => {
        terminated++;
        if (failTermination) throw new Error('synthetic cleanup failure');
        child.exitCode = 1;
        child.emit('close', 1);
      },
    );
    await assert.rejects(pending, failTermination ? /synthetic cleanup failure/ : /取消|失败/);
    assert.equal(terminated, 1);
  }
});
