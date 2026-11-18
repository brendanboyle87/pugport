import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess, ExecFileOptions, SpawnOptions } from 'node:child_process';
import { FullSuiteRunner, type SuiteRequest, type SuiteResult } from '../src/server/maintainer/suite-runner.ts';
import { readDesktopConfig, type DesktopMaintainerConfig } from '../src/server/maintainer/config.ts';
import { MaintainerDesk, memoryHostLink, type HostLink } from '../src/server/maintainer/desktop.ts';
import { StoreOutbox } from '../src/server/maintainer/outbox.ts';
import { Inbox } from '../src/server/inbox.ts';
import { githubResolveSchema, type GitHubResolve } from '../src/server/node/peer-protocol.ts';
import type { AuditLine } from '../src/server/maintainer/audit.ts';
import { card, fakeGh, memoryStore, sha } from './helpers/maintainer.ts';

type RunnerDeps = ConstructorParameters<typeof FullSuiteRunner>[0];
const request: SuiteRequest = {
  cardId: card().id,
  number: 7,
  sha,
  author: 'contributor',
  external: false,
};
const report = (extra = {}) => JSON.stringify({ sha, tests: 10, passed: 10, failed: 0, ...extra });
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(predicate: () => boolean) {
  for (let i = 0; i < 30 && !predicate(); i++) await turn();
  assert.ok(predicate(), 'expected fake operation to arrive');
}
function fixture() {
  const store = memoryStore();
  let clock = new Date(2026, 9, 28, 12).getTime();
  const config: DesktopMaintainerConfig = {
    repository: 'o/r',
    fullSuite: {
      argv: ['fake-coordinator', 'run', '{sha}', 'literal-{sha}', '{other}'],
      cwd: tmpdir(),
      timeoutMinutes: 5,
    },
  };
  const state = { permission: 'write', head: sha, stdout: report(), stderr: '', code: 0, slow: false };
  const owner = fakeGh(() => state.permission);
  const gitCalls: { cwd: string; args: string[]; options: ExecFileOptions }[] = [];
  const execCalls: { file: string; args: string[]; options: SpawnOptions }[] = [];
  const audit: AuditLine[] = [];
  const children: { child: ChildProcess; finish: () => void; kills: string[] }[] = [];
  const exec = ((file: string, args: string[], options: ExecFileOptions, callback?: (...args: unknown[]) => void) => {
    execCalls.push({ file, args, options });
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, {
      pid: 7654321,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill: (signal: string) => {
        kills.push(signal);
        child.signalCode = signal;
        child.emit('close', null);
        return true;
      },
    });
    const kills: string[] = [];
    const finish = () => {
      child.stdout.write(state.stdout);
      child.stderr.write(state.stderr);
      child.exitCode = state.code;
      child.emit('close', state.code);
    };
    if (/taskkill\.exe$/i.test(file)) queueMicrotask(() => callback?.(null, '', ''));
    else {
      children.push({ child: child as unknown as ChildProcess, finish, kills });
      if (!state.slow) queueMicrotask(finish);
    }
    return child;
  }) as unknown as RunnerDeps['exec'];
  const deps: RunnerDeps = {
    config: async () => config,
    store,
    ownerGh: owner.gh,
    exec,
    spawn: exec as unknown as RunnerDeps['spawn'],
    now: () => clock,
    git: async (cwd, args, options) => {
      gitCalls.push({ cwd, args, options });
      return { code: 0, stdout: args[0] === 'rev-parse' ? state.head + '\n' : '', stderr: '' };
    },
    audit: (line) => audit.push(line),
  };
  return {
    store,
    config,
    state,
    owner,
    gitCalls,
    execCalls,
    audit,
    children,
    deps,
    runner: new FullSuiteRunner(deps),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test('fullSuite config validates bounds, exact placeholder, absolute cwd, and defaults', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'maintainer-suite-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'maintainer.json');
  const parse = async (fullSuite?: unknown) => {
    await writeFile(file, JSON.stringify({ repository: 'o/r', fullSuite }));
    return readDesktopConfig(file);
  };
  assert.equal((await parse()).config?.fullSuite, undefined);
  const valid = { argv: ['fake', '{sha}'], cwd: dir };
  assert.equal((await parse(valid)).config?.fullSuite?.timeoutMinutes, 120);
  for (const patch of [
    { argv: [] },
    { argv: ['fake'] },
    { argv: ['fake', 'x{sha}'] },
    { argv: ['fake', '{sha}', '{sha}'] },
    { argv: ['fake', '{sha}', ...Array(39).fill('x')] },
    { argv: ['x'.repeat(4001), '{sha}'] },
    { cwd: 'relative' },
    { timeoutMinutes: 4 },
    { timeoutMinutes: 241 },
  ])
    assert.ok((await parse({ ...valid, ...patch })).error, JSON.stringify(patch));
  for (const timeoutMinutes of [5, 240]) assert.ok((await parse({ ...valid, timeoutMinutes })).config);
  assert.ok((await parse({ ...valid, argv: ['x'.repeat(4000), '{sha}', ...Array(38).fill('x')] })).config);
});

test('external heads are refused before gh, fetch or spawn', async () => {
  const f = fixture();
  const input = { ...request, external: true };
  assert.deepEqual(await f.runner.canRun(input), { ok: false, reason: 'untrusted' });
  await assert.rejects(f.runner.run(input), /^Error: untrusted$/);
  assert.equal(f.owner.calls.length + f.gitCalls.length + f.execCalls.length, 0);
});

test('owner collaborator lookup is rechecked and read permission never fetches', async () => {
  const f = fixture();
  f.state.permission = 'read';
  await assert.rejects(f.runner.run(request), /^Error: untrusted$/);
  assert.deepEqual(f.owner.calls[0].args, [
    'api',
    'repos/o/r/collaborators/contributor/permission',
    '--jq',
    '.permission',
  ]);
  assert.equal(f.gitCalls.length + f.execCalls.length + f.runner.today(), 0);
  f.state.permission = 'write';
  assert.equal((await f.runner.run(request)).status, 'passed');
});

test('missing runner config and malformed requests never fetch', async () => {
  const f = fixture();
  delete f.config.fullSuite;
  assert.deepEqual(await f.runner.canRun(request), { ok: false, reason: 'no-config' });
  await assert.rejects(f.runner.run(request), /no-config/);
  for (const patch of [{ number: 0 }, { number: -1 }, { number: 1.5 }, { sha: 'A'.repeat(40) }, { sha: 'bad' }])
    await assert.rejects(f.runner.run({ ...request, ...patch }), /invalid request/);
  assert.equal(f.gitCalls.length + f.execCalls.length, 0);
});

test('fetch arguments, cwd and noninteractive env are exact; moved head does not spawn', async () => {
  const f = fixture();
  f.state.head = 'b'.repeat(40);
  const result = await f.runner.run(request);
  assert.equal(result.status, 'error');
  assert.equal(result.detail, 'head moved');
  assert.deepEqual(
    f.gitCalls.map((call) => call.args),
    [
      ['fetch', '--no-tags', '--quiet', 'origin', '+refs/pull/7/head:refs/pugport/maintainer/pr-7'],
      ['rev-parse', 'refs/pugport/maintainer/pr-7'],
    ],
  );
  assert.ok(f.gitCalls.every((call) => call.cwd === tmpdir() && call.options.env?.GIT_TERMINAL_PROMPT === '0'));
  assert.equal(f.execCalls.length, 0);
});

test('spawn substitutes only the whole sha argument, hides windows, allow-lists env and stores one audit', async (t) => {
  const f = fixture();
  const allowed = {
    PATH: '/synthetic/bin',
    Path: 'C:/synthetic/bin',
    PATHEXT: '.EXE',
    SystemRoot: 'C:/synthetic',
    SYSTEMROOT: 'C:/synthetic',
    ComSpec: 'C:/synthetic/cmd.exe',
    WINDIR: 'C:/synthetic',
    HOME: '/synthetic/home',
    USERPROFILE: 'C:/synthetic/home',
    HOMEDRIVE: 'C:',
    HOMEPATH: '/synthetic/home',
    APPDATA: 'C:/synthetic/roaming',
    LOCALAPPDATA: 'C:/synthetic/local',
    TEMP: tmpdir(),
    TMP: tmpdir(),
    TMPDIR: tmpdir(),
    USER: 'synthetic',
    USERNAME: 'synthetic',
    LOGNAME: 'synthetic',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
    SSH_AUTH_SOCK: '/synthetic/socket',
  };
  t.mock.property(process, 'env', {
    ...allowed,
    GH_TOKEN: 'synthetic-token',
    GITHUB_TOKEN: 'synthetic-token',
    OPENAI_API_KEY: 'synthetic-key',
    AWS_SECRET_ACCESS_KEY: 'synthetic-key',
    NODE_OPTIONS: '--require=synthetic',
    UNLISTED: 'synthetic',
    GIT_TERMINAL_PROMPT: '1',
  });
  assert.equal((await f.runner.run(request)).status, 'passed');
  assert.deepEqual(f.execCalls[0].args, ['run', sha, 'literal-{sha}', '{other}']);
  const options = f.execCalls[0].options;
  assert.equal(options.cwd, tmpdir());
  assert.equal(options.windowsHide, true);
  assert.equal(options.shell, false);
  assert.deepEqual(options.env, { ...allowed, GIT_TERMINAL_PROMPT: '0' });
  assert.ok(f.gitCalls.every((call) => JSON.stringify(call.options.env) === JSON.stringify(options.env)));
  assert.equal(options.detached, process.platform !== 'win32');
  assert.equal(f.audit.length, 1);
  assert.equal(f.audit[0].event, 'suite');
  assert.equal(f.audit[0].credential, 'gh-desktop');
  assert.equal(f.store.list('maintainer-suite', 'maintainer').length, 1);
});

for (const [name, stdout, code, expected] of [
  ['last JSON with trailing garbage', report({ failed: 3 }) + '\nlog\n' + report() + '\ntrailing garbage', 0, 'passed'],
  [
    'multiline with quoted braces',
    JSON.stringify({ sha, tests: 2, passed: 1, failed: 1, failingFiles: ['tests/{quoted}.ts'] }, null, 2),
    0,
    'failed',
  ],
  ['wrong sha', report() + '\n' + report({ sha: 'b'.repeat(40) }), 0, 'error'],
  ['no JSON', 'diagnostics only', 0, 'error'],
  ['exit one', report(), 1, 'error'],
  ['invalid count', report({ failed: 'one' }), 0, 'error'],
  ['too many files', report({ failingFiles: Array(51).fill('x') }), 0, 'error'],
  ['long file', report({ failingFiles: ['x'.repeat(201)] }), 0, 'error'],
] as const)
  test(`result parsing: ${name}`, async () => {
    const f = fixture();
    Object.assign(f.state, { stdout, code });
    assert.equal((await f.runner.run(request)).status, expected);
  });

test('bounded output retains the tail and redacts stdout, stderr, result and audit', async () => {
  const f = fixture();
  f.state.stdout = 'prefix'.repeat(800_000) + '\ntoken=synthetic-secret\n' + report();
  f.state.stderr = 'prefix'.repeat(12_000) + '\npassword=synthetic-secret ghp_syntheticsecret tail-marker';
  f.state.code = 1;
  const result = await f.runner.run(request);
  assert.equal(result.status, 'error');
  assert.match(result.detail!, /tail-marker/);
  const record = f.store.get<{ stdout: string; stderr: string }>('maintainer-suite', sha)!;
  assert.ok(Buffer.byteLength(record.stdout) <= 4 * 1024 * 1024);
  assert.ok(Buffer.byteLength(record.stderr) <= 64 * 1024);
  assert.ok(record.stdout.endsWith(report()));
  assert.ok(record.stderr.endsWith('tail-marker'));
  assert.doesNotMatch(JSON.stringify([record, result, f.audit]), /synthetic-secret|ghp_syntheticsecret/);
});

for (const failed of [0, 1])
  test(`${failed ? 'failed' : 'passed'} locks sha across runner restart`, async () => {
    const f = fixture();
    f.state.stdout = report({ failed, passed: 10 - failed });
    await f.runner.run(request);
    const restarted = new FullSuiteRunner(f.deps);
    assert.deepEqual(await restarted.canRun(request), { ok: false, reason: 'same-sha' });
    await assert.rejects(restarted.run(request), /same-sha/);
    assert.equal(f.execCalls.length, 1);
  });

test('error permits retry and daily cap persists across restart, resets by local day', async () => {
  const f = fixture();
  f.state.stdout = 'no JSON';
  for (let i = 0; i < 6; i++) assert.equal((await new FullSuiteRunner(f.deps).run(request)).status, 'error');
  const restarted = new FullSuiteRunner(f.deps);
  assert.equal(restarted.today(), 6);
  assert.deepEqual(await restarted.canRun(request), { ok: false, reason: 'daily-cap' });
  await assert.rejects(restarted.run(request), /daily-cap/);
  assert.equal(f.execCalls.length, 6);
  f.advance(24 * 60 * 60_000);
  f.state.stdout = report();
  assert.equal((await restarted.run(request)).status, 'passed');
  assert.equal(restarted.today(), 1);
});

test('one running slot is reserved before async config/permission checks', async () => {
  const f = fixture();
  f.state.slow = true;
  const first = f.runner.run(request);
  assert.equal(f.runner.running(), sha);
  await assert.rejects(f.runner.run({ ...request, sha: 'b'.repeat(40) }), /running/);
  await until(() => f.children.length === 1);
  f.children[0].finish();
  await first;
  assert.equal(f.runner.running(), undefined);
});

for (const platform of ['win32', 'linux'] as const)
  test(`timeout kills the ${platform} process tree and remains retryable`, async (t) => {
    t.mock.property(process, 'platform', platform);
    const f = fixture();
    f.state.slow = true;
    const signals: unknown[][] = [];
    if (process.platform !== 'win32')
      t.mock.method(process, 'kill', (...args: unknown[]) => {
        signals.push(args);
        return true;
      });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = f.runner.run(request);
    await until(() => f.children.length === 1);
    assert.equal(f.execCalls[0].options.detached, platform !== 'win32');
    t.mock.timers.tick(5 * 60_000);
    const result = await pending;
    assert.equal(result.status, 'error');
    assert.equal(result.detail, 'timed out');
    if (process.platform === 'win32') {
      assert.match(f.execCalls[1].file, /System32[\\/]taskkill\.exe$/);
      assert.deepEqual(f.execCalls[1].args, ['/pid', '7654321', '/t', '/f']);
    } else assert.deepEqual(signals, [[-7654321, 'SIGKILL']]);
    assert.deepEqual(f.children[0].kills, ['SIGKILL']);
    assert.deepEqual(await f.runner.canRun(request), { ok: true });
  });

function deskFixture(t: TestContext, configured = true) {
  const f = fixture();
  const db = new DatabaseSync(':memory:');
  const inbox = new Inbox(db, () => {}, f.deps.now);
  const outbox = new StoreOutbox(f.store, f.deps.now);
  const local = memoryHostLink(outbox);
  const events: { id: string; resolution: GitHubResolve }[] = [];
  const link: HostLink = {
    ...local,
    resolve: async (id, resolution) => {
      events.push({ id, resolution: githubResolveSchema.parse(resolution) });
      return local.resolve(id, resolution);
    },
  };
  const desk = new MaintainerDesk({
    inbox,
    store: f.store,
    config: f.deps.config,
    gh: f.owner.gh,
    audit: f.deps.audit,
    suite: configured ? f.runner : undefined,
    link: () => link,
    now: f.deps.now,
  });
  t.after(async () => {
    await desk.close();
    db.close();
  });
  return { ...f, desk, inbox, outbox, events, link };
}

test('desk sync returns while suite is slow, starts at most one and reports ordered lifecycle', async (t) => {
  const f = deskFixture(t);
  f.state.slow = true;
  const item = f.outbox.raise(card({ kind: 'suite' }));
  f.outbox.raise(card({ kind: 'suite', number: 8, judgedSha: 'b'.repeat(40) }));
  await f.desk.sync();
  await until(() => f.children.length === 1);
  assert.deepEqual(
    f.events.map((e) => e.resolution.outcome),
    ['suite-started'],
  );
  assert.equal(f.outbox.open().length, 2, 'started is not a terminal resolution');
  await f.desk.sync();
  assert.equal(f.children.length, 1);
  f.children[0].finish();
  await until(() => f.events.length === 2);
  assert.deepEqual(
    f.events.map((e) => [e.id, e.resolution.outcome]),
    [
      [item.id, 'suite-started'],
      [item.id, 'suite-result'],
    ],
  );
  assert.equal(f.events[1].resolution.suite?.tests, 10);
  assert.equal(f.events[1].resolution.suite?.status, 'passed');
});

test('desk close aborts a suite and stores its error', async (t) => {
  const f = deskFixture(t);
  f.state.slow = true;
  if (process.platform !== 'win32') t.mock.method(process, 'kill', () => true);
  f.outbox.raise(card({ kind: 'suite' }));
  await f.desk.sync();
  await until(() => f.children.length === 1);
  await f.desk.close();
  assert.equal(f.events[1].resolution.suite?.detail, 'aborted');
  assert.deepEqual(f.children[0].kills, ['SIGKILL']);
  await f.desk.sync();
  assert.equal(f.children.length, 1);
});

test('closed host card still leaves local suite result and ignores false resolve', async (t) => {
  const f = deskFixture(t);
  f.state.slow = true;
  const item = f.outbox.raise(card({ kind: 'suite' }));
  await f.desk.sync();
  await until(() => f.children.length === 1);
  f.outbox.resolve(item.id, { outcome: 'superseded', at: new Date(f.deps.now!()).toISOString() });
  f.children[0].finish();
  await until(() => f.events.length === 2);
  assert.equal(f.store.get<{ result: SuiteResult }>('maintainer-suite', sha)?.result.status, 'passed');
});

test('review and external cards never offer a suite action or execute', async (t) => {
  const f = deskFixture(t);
  f.outbox.raise(card({ kind: 'review', suite: { state: 'not-run' } }));
  f.outbox.raise(card({ kind: 'review', number: 8, external: true, suite: { state: 'not-run' } }));
  f.outbox.raise(card({ kind: 'merge', number: 9 }));
  await f.desk.sync();
  for (const item of f.inbox.list()) assert.notEqual(item.action?.kind, 'github-run-suite');
  assert.equal(f.gitCalls.length + f.execCalls.length, 0);
});

test('desk daily cap leaves host request open without lifecycle messages', async (t) => {
  const f = deskFixture(t);
  f.state.stdout = 'error';
  for (let i = 0; i < 6; i++) await f.runner.run(request);
  const item = f.outbox.raise(card({ kind: 'suite' }));
  await f.desk.sync();
  await turn();
  assert.equal(f.events.length, 0);
  assert.equal(f.outbox.open()[0].id, item.id);
  assert.equal(f.execCalls.length, 6);
  f.advance(24 * 60 * 60_000);
  f.state.stdout = report();
  await f.desk.sync();
  await until(() => f.events.length === 2);
  assert.equal(f.events[1].resolution.suite?.status, 'passed');
  assert.equal(f.outbox.open().length, 0);
});

test('unbalanced log braces do not hide a later complete JSON result', async () => {
  const f = fixture();
  f.state.stdout = 'truncated log {\n' + report() + '\ntrailing {';
  assert.equal((await f.runner.run(request)).status, 'passed');
});

test('default owner gh uses login environment and fake exec before fetch', async (t) => {
  const f = fixture();
  t.mock.property(process, 'env', {
    ...process.env,
    GH_TOKEN: 'synthetic-app-token',
    GITHUB_TOKEN: 'synthetic-app-token',
  });
  const exec: NonNullable<RunnerDeps['exec']> = ((
    file: string,
    args: string[],
    options: ExecFileOptions,
    callback?: (error: null, stdout: string, stderr: string) => void,
  ) => {
    if (args[0] === 'api') {
      assert.equal(options.env?.GH_TOKEN, undefined);
      assert.equal(options.env?.GITHUB_TOKEN, undefined);
      assert.equal(options.windowsHide, true);
      assert.equal(f.gitCalls.length, 0);
      assert.deepEqual(args, ['api', 'repos/o/r/collaborators/contributor/permission', '--jq', '.permission']);
      queueMicrotask(() => callback?.(null, 'read', ''));
      return Object.assign(new EventEmitter(), { stdin: new PassThrough() });
    }
    throw new Error(`Unexpected process: ${file}`);
  }) as unknown as NonNullable<RunnerDeps['exec']>;
  const runner = new FullSuiteRunner({ ...f.deps, ownerGh: undefined, exec });
  await assert.rejects(runner.run(request), /untrusted/);
  assert.equal(f.gitCalls.length + f.execCalls.length, 0);
});

test('default git execution uses fake spawn with noninteractive env and no checkout', async () => {
  const f = fixture();
  const spawn: NonNullable<RunnerDeps['spawn']> = ((file: string, args: string[], options: ExecFileOptions) => {
    if (file === 'git') {
      f.gitCalls.push({ cwd: String(options.cwd), args, options });
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      queueMicrotask(() => {
        child.stdout.write(args[0] === 'rev-parse' ? sha : '');
        child.emit('close', 0);
      });
      return child;
    }
    return f.deps.spawn!(file, args, options);
  }) as unknown as NonNullable<RunnerDeps['spawn']>;
  assert.equal((await new FullSuiteRunner({ ...f.deps, git: undefined, spawn }).run(request)).status, 'passed');
  assert.deepEqual(
    f.gitCalls.map((call) => call.args),
    [
      ['fetch', '--no-tags', '--quiet', 'origin', '+refs/pull/7/head:refs/pugport/maintainer/pr-7'],
      ['rev-parse', 'refs/pugport/maintainer/pr-7'],
    ],
  );
  assert.ok(f.gitCalls.every((call) => call.options.env?.GIT_TERMINAL_PROMPT === '0'));
});

test('host started-report failure stores an error without executing', async (t) => {
  const f = deskFixture(t);
  f.outbox.raise(card({ kind: 'suite' }));
  f.link.resolve = async () => {
    throw new Error('synthetic host unavailable');
  };
  await f.desk.sync();
  await until(() => !!f.store.get<{ result: SuiteResult }>('maintainer-suite', sha)?.result);
  assert.equal(f.gitCalls.length + f.execCalls.length, 0);
  assert.equal(f.store.get<{ result: SuiteResult }>('maintainer-suite', sha)?.result.status, 'error');
});

test('a report with no tests or inconsistent counts is an error, not a pass', async () => {
  for (const extra of [{ tests: 0, passed: 0 }, { passed: 9, failed: 2 }, { passed: 9.5 }]) {
    const f = fixture();
    f.state.stdout = report(extra);
    assert.equal((await f.runner.run(request)).status, 'error', JSON.stringify(extra));
  }
});
