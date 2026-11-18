import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { JudgeRunner } from '../src/server/judge-runner.ts';
import { removeDetachedCheckout } from '../src/server/managed-worktrees.ts';
import { join } from 'node:path';

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  finish(code: number) {
    this.exitCode = code;
    this.emit('close', code);
  }
}

test('start returns while running, limits concurrency and sends prompt only on stdin', async (t) => {
  // The judge runs as on Linux; its checkout cleanup refuses links on the path, like macOS /var for the temporary
  // folder, so the fixture uses the folder's real location.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pugport-judge-fixture-')));
  const repo = join(root, 'repo');
  await mkdir(join(repo, '.pugport'), { recursive: true });
  await writeFile(join(repo, '.pugport', 'judge.md'), 'Synthetic {{sha}} {{claim}}');
  const original = childProcess.execFile;
  const originalGitDir = process.env.GIT_DIR;
  process.env.GIT_DIR = 'synthetic-unrelated-git-directory';
  let tracked = false;
  const gitCalls: string[][] = [];
  const fakeGit = ((
    _command: unknown,
    args: string[],
    _options: unknown,
    callback: (error: unknown, stdout: Buffer, stderr: Buffer) => void,
  ) => {
    gitCalls.push(args);
    const child = new FakeChild();
    queueMicrotask(() =>
      callback(
        args.includes('ls-files') && !tracked ? Object.assign(new Error('untracked'), { code: 1 }) : null,
        Buffer.alloc(0),
        Buffer.alloc(0),
      ),
    );
    return child;
  }) as unknown as typeof childProcess.execFile;
  childProcess.execFile = fakeGit;
  syncBuiltinESMExports();
  t.after(async () => {
    if (originalGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = originalGitDir;
    childProcess.execFile = original;
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  });
  const records = new Map<string, unknown>([['project:p', { id: 'p', path: repo, scope: 'project' }]]);
  const store = {
    get: (kind: string, id: string) => records.get(`${kind}:${id}`),
    list: (kind: string) => [...records].filter(([key]) => key.startsWith(`${kind}:`)).map(([, value]) => value),
    save: (kind: string, id: string, _owner: string, value: unknown) => records.set(`${kind}:${id}`, value),
  };
  let child = new FakeChild();
  let provider: 'codex' | 'claude' = 'codex';
  let terminated = 0;
  const removed: string[] = [];
  const removalFailures = new Set<string>();
  const calls: { args: string[]; options: Record<string, unknown> }[] = [];
  let prompt = '';
  child.stdin.on('data', (chunk) => {
    prompt += chunk.toString();
  });
  const runner = new JudgeRunner(
    {
      dataDir: root,
      store: store as never,
      targets: () => [{ id: 'c', provider, label: 'test', command: 'fake', environment: 'native', enabled: true }],
      snapshots: () => [{ id: 'c', status: 'ready', version: 'synthetic' } as never],
    },
    {
      platform: 'linux',
      createCheckout: async () => {},
      removeCheckout: async (_repo, dir) => {
        removed.push(dir);
        if (removalFailures.has(dir)) throw new Error('synthetic removal failure');
        if (dir.includes('jg-20000101-abcdef12')) await removeDetachedCheckout(_repo, dir);
      },
      spawn: async (_target, args, options) => {
        calls.push({ args, options: options as Record<string, unknown> });
        return child as never;
      },
      terminate: async () => {
        terminated++;
        child.finish(255);
      },
    },
  );
  t.after(() => runner.close());
  const sha = 'a'.repeat(40);
  const callerAbort = new AbortController();
  const [one, two] = await Promise.all([
    runner.start({ projectId: 'p', sha, claim: 'private claim' }, { signal: callerAbort.signal }),
    runner.start({ projectId: 'p', sha, claim: 'private claim' }, { signal: callerAbort.signal }),
  ]);
  const running = [one, two].find((value) => value.status === 'running')!;
  assert.equal([one, two].filter((value) => value.status === 'busy').length, 1);
  assert.equal([...records.keys()].filter((key) => key.startsWith('judge-run:')).length, 1);
  const dir = join(root, 'judge', running.judge_id);
  assert.equal(calls[0].options.cwd, join(dir, 'checkout'));
  assert.equal(calls[0].options.syncAccountConfig, false);
  assert.equal(calls[0].options.runTemp, join(dir, 'tmp'));
  assert.equal(Object.hasOwn(calls[0].options.env as object, 'GIT_DIR'), false);
  callerAbort.abort();
  assert.equal(terminated, 0);
  assert.equal((await runner.result('p', running.judge_id, 0)).status, 'running');
  assert.deepEqual(calls[0].args, [
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--ephemeral',
    '-C',
    join(dir, 'checkout'),
    '-s',
    'workspace-write',
    '-c',
    'sandbox_workspace_write.network_access=false',
    '--disable',
    'hooks',
    '--disable',
    'plugins',
    '--color',
    'never',
    '--json',
    '-o',
    join(dir, 'last.txt'),
    '-',
  ]);
  assert.equal(prompt, `Synthetic ${sha} private claim`);
  assert.ok(!calls[0].args.join(' ').includes('private claim'));
  await writeFile(join(dir, 'last.txt'), `PASS @ ${sha.slice(0, 7)}\nJUDGE: synthetic`);
  child.finish(0);
  const result = await runner.result('p', running.judge_id, 1);
  assert.equal(result.status, 'completed');
  assert.equal(result.verdict, 'pass');
  assert.match(result.provenance!, /config=untracked/);
  await writeFile(join(repo, '.pugport', 'judge.md'), '---\ntimeout_minutes: 1\n---\nSynthetic');
  child = new FakeChild();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const next = await runner.start({ projectId: 'p', sha, claim: 'claim' });
  t.mock.timers.tick(60_000);
  const timeoutResult = await runner.result('p', next.judge_id, 0);
  await runner.close();
  assert.equal((await runner.result('p', next.judge_id, 0)).status, 'timed-out');
  assert.equal(timeoutResult.status === 'running' || timeoutResult.status === 'timed-out', true);
  assert.equal(terminated, 1);
  t.mock.timers.reset();
  provider = 'claude';
  child = new FakeChild();
  await writeFile(join(repo, '.pugport', 'judge.md'), '---\nexecutor: claude\n---\nSynthetic');
  const claude = await runner.start({ projectId: 'p', sha, claim: 'claim' });
  const claudeDir = join(root, 'judge', claude.judge_id);
  assert.deepEqual(calls[2].args, [
    '-p',
    '--output-format',
    'json',
    '--safe-mode',
    '--restricted',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--tools',
    'Read,Glob,Grep',
    '--permission-prompts',
    'none',
    '--settings',
    JSON.stringify({ autoMemoryDirectory: join(claudeDir, 'memory') }),
  ]);
  child.stdout.write(JSON.stringify({ result: `FAIL @ ${sha.slice(0, 7)}` }));
  child.finish(0);
  assert.equal((await runner.result('p', claude.judge_id, 1)).verdict, 'fail');
  // A Claude that fails without output reports its stderr, not "unreadable output".
  child = new FakeChild();
  const crashed = await runner.start({ projectId: 'p', sha, claim: 'claim' });
  child.stderr.write('synthetic login expired');
  child.finish(1);
  const crashedResult = await runner.result('p', crashed.judge_id, 1);
  assert.equal(crashedResult.status, 'failed');
  assert.match(crashedResult.error!, /synthetic login expired/);
  // Regression: a plugin server the CLI started kept the pipes open after it was killed, so 'close' never came.
  child = new FakeChild();
  const orphaned = await runner.start({ projectId: 'p', sha, claim: 'claim' });
  child.stdout.write(JSON.stringify({ result: `PASS @ ${sha.slice(0, 7)}` }));
  child.emit('exit', 0);
  assert.equal((await runner.result('p', orphaned.judge_id, 5)).verdict, 'pass');
  child = new FakeChild();
  const rejected = await runner.start({ projectId: 'p', sha, claim: 'claim' });
  child.stdout.write(JSON.stringify({ is_error: true, result: 'synthetic authentication error' }));
  child.finish(0);
  const rejectedResult = await runner.result('p', rejected.judge_id, 1);
  assert.equal(rejectedResult.status, 'failed');
  assert.match(rejectedResult.error!, /synthetic authentication error/);
  const blockedId = 'jg-20000101-00000000';
  const blockedDir = join(root, 'judge', blockedId);
  await mkdir(join(blockedDir, 'checkout'), { recursive: true });
  records.set('judge-run:' + blockedId, {
    id: blockedId,
    projectId: 'p',
    startedAt: new Date(Date.now() - 15 * 86400_000).toISOString(),
    checkoutRetainedAt: new Date().toISOString(),
  });
  removalFailures.add(join(blockedDir, 'checkout'));
  const oldId = 'jg-20000101-12345678';
  const oldDir = join(root, 'judge', oldId);
  await mkdir(join(oldDir, 'checkout'), { recursive: true });
  records.set('judge-run:' + oldId, {
    id: oldId,
    projectId: 'p',
    startedAt: '2000-01-01T00:00:00.000Z',
    checkoutRetainedAt: '2000-01-01T00:00:00.000Z',
  });
  const missingId = 'jg-20000101-abcdef12';
  const missingDir = join(root, 'judge', missingId);
  await mkdir(missingDir);
  records.set('judge-run:' + missingId, {
    id: missingId,
    projectId: 'p',
    startedAt: '2000-01-01T00:00:00.000Z',
    checkoutRetainedAt: '2000-01-01T00:00:00.000Z',
  });
  tracked = true;
  provider = 'codex';
  child = new FakeChild();
  await writeFile(join(repo, '.pugport', 'judge.md'), 'Current worktree {{claim}}');
  let currentPrompt = '';
  child.stdin.on('data', (chunk) => {
    currentPrompt += chunk.toString();
  });
  const trackedRuns = await Promise.all([
    runner.start({ projectId: 'p', sha, claim: 'current' }),
    runner.start({ projectId: 'p', sha, claim: 'current' }),
  ]);
  const trackedRun = trackedRuns.find((value) => value.status === 'running')!;
  assert.equal(trackedRun.status, 'running');
  assert.ok(removed.includes(join(blockedDir, 'checkout')));
  await access(blockedDir);
  assert.equal(trackedRuns.filter((value) => value.status === 'busy').length, 1);
  assert.equal(currentPrompt, 'Current worktree current');
  assert.ok(removed.includes(join(oldDir, 'checkout')));
  assert.equal(removed.filter((dir) => dir === join(oldDir, 'checkout')).length, 1);
  await assert.rejects(access(oldDir));
  await assert.rejects(access(missingDir));
  assert.ok(gitCalls.some((args) => args.includes('remove') && args.includes(join(missingDir, 'checkout'))));
  assert.ok(gitCalls.some((args) => args.includes('prune')));
  assert.ok(records.has('judge-run:' + oldId));
  const trackedDir = join(root, 'judge', trackedRun.judge_id);
  await writeFile(join(trackedDir, 'last.txt'), `PASS @ ${sha.slice(0, 7)}`);
  child.finish(0);
  const trackedResult = await runner.result('p', trackedRun.judge_id, 1);
  assert.match(trackedResult.provenance!, /config=tracked/);
  assert.match(trackedResult.note!, /已被 git 跟踪/);
  child = new FakeChild();
  const invalid = await runner.start({ projectId: 'p', sha, claim: 'invalid verdict' });
  await writeFile(join(root, 'judge', invalid.judge_id, 'last.txt'), 'hello');
  child.finish(0);
  const invalidResult = await runner.result('p', invalid.judge_id, 1);
  assert.equal(invalidResult.status, 'invalid');
  assert.equal(invalidResult.verdict, 'invalid');
  assert.match(invalidResult.error!, /不符合结论格式/);
  child = new FakeChild();
  const finished = await runner.start({ projectId: 'p', sha, claim: 'cleanup failure' });
  const finishedDir = join(root, 'judge', finished.judge_id);
  removalFailures.add(join(finishedDir, 'checkout'));
  await writeFile(join(finishedDir, 'last.txt'), `PASS @ ${sha.slice(0, 7)}`);
  child.finish(0);
  const finishedResult = await runner.result('p', finished.judge_id, 1);
  assert.equal(finishedResult.status, 'completed');
  assert.ok((records.get('judge-run:' + finished.judge_id) as { checkoutRetainedAt?: string }).checkoutRetainedAt);
  assert.match(finishedResult.note!, /已被 git 跟踪/);
  assert.ok(finishedResult.note!.includes(join(finishedDir, 'checkout')));
  child = new FakeChild();
  const windows = new JudgeRunner(
    {
      dataDir: root,
      store: store as never,
      targets: () => [
        { id: 'c', provider: 'codex', label: 'test', command: 'fake', environment: 'native', enabled: true },
      ],
      snapshots: () => [{ id: 'c', status: 'ready' } as never],
    },
    {
      platform: 'win32',
      sandboxStatus: async () => ({ available: false }) as never,
      createCheckout: async () => {},
      removeCheckout: async () => {},
      spawn: async (_target, args, options) => {
        calls.push({ args, options: options as Record<string, unknown> });
        return child as never;
      },
    },
  );
  const windowsRun = await windows.start({ projectId: 'p', sha, claim: 'windows' });
  assert.ok(calls.at(-1)!.args.includes("windows.sandbox='elevated'"));
  await writeFile(join(root, 'judge', windowsRun.judge_id, 'last.txt'), `PASS @ ${sha.slice(0, 7)}`);
  child.finish(0);
  assert.equal((await windows.result('p', windowsRun.judge_id, 1)).status, 'completed');
  const failingCheckout = new JudgeRunner(
    {
      dataDir: root,
      store: store as never,
      targets: () => [
        { id: 'c', provider: 'codex', label: 'test', command: 'fake', environment: 'native', enabled: true },
      ],
      snapshots: () => [{ id: 'c', status: 'ready' } as never],
    },
    {
      // As above: the tool-using judge is refused on macOS, so this runner states a system where it runs.
      platform: 'linux',
      createCheckout: async () => {
        throw Object.assign(new Error('synthetic cleanup failure'), { checkoutRetained: true });
      },
    },
  );
  await assert.rejects(failingCheckout.start({ projectId: 'p', sha, claim: 'claim' }), /synthetic cleanup failure/);
  const retained = [...records.values()].find((value) =>
    (value as { error?: string }).error?.includes('synthetic cleanup failure'),
  ) as { status: string; checkoutRetainedAt?: string };
  assert.equal(retained.status, 'failed');
  assert.ok(retained.checkoutRetainedAt);
});

test('judge runner is available and enforces project isolation', async () => {
  const records = new Map<string, unknown>([['judge-run:one', { id: 'one', projectId: 'p', status: 'completed' }]]);
  const store = {
    get: (kind: string, id: string) => records.get(`${kind}:${id}`),
    list: (kind: string) => [...records].filter(([key]) => key.startsWith(`${kind}:`)).map(([, value]) => value),
    save: (kind: string, id: string, _owner: string, value: unknown) => records.set(`${kind}:${id}`, value),
  };
  const runner = new JudgeRunner({ dataDir: '.', store: store as never, targets: () => [], snapshots: () => [] });
  await assert.rejects(runner.result('other', 'one', 0), /判官记录不属于这个项目/);
  await assert.rejects(runner.start({ projectId: 'p', sha: 'HEAD', claim: 'claim' }), /sha 必须是 40 位/);
});

test('close stops waiting after five seconds when a child never closes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const runner = new JudgeRunner({ dataDir: '.', store: {} as never, targets: () => [], snapshots: () => [] });
  const abort = new AbortController();
  Object.assign(runner, { active: { id: 'synthetic', abort, done: new Promise<void>(() => {}) } });
  let closed = false;
  const done = runner.close().then(() => {
    closed = true;
  });
  assert.equal(abort.signal.aborted, true);
  t.mock.timers.tick(4999);
  await Promise.resolve();
  assert.equal(closed, false);
  t.mock.timers.tick(1);
  await done;
  assert.equal(closed, true);
});

test('judge runner contains no GitHub write path', async () => {
  const source = await readFile(new URL('../src/server/judge-runner.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /execFile\('gh'|'gh',|api\.github\.com|githubcopilot\.com/);
});

test('recover fails interrupted runs and removes their detached checkout', async () => {
  const record = {
    id: 'jg-20261027-12345678',
    projectId: 'p',
    sha: 'a'.repeat(40),
    executor: 'codex',
    status: 'running',
    file: 'verdict.md',
    startedAt: '2026-10-27T00:00:00.000Z',
    events: [],
  };
  const records = new Map<string, unknown>([
    ['project:p', { id: 'p', path: 'synthetic-repo' }],
    ['judge-run:' + record.id, record],
  ]);
  const removed: string[][] = [];
  const store = {
    get: (kind: string, id: string) => records.get(`${kind}:${id}`),
    list: (kind: string) => [...records].filter(([key]) => key.startsWith(`${kind}:`)).map(([, value]) => value),
    save: (kind: string, id: string, _owner: string, value: unknown) => records.set(`${kind}:${id}`, value),
  };
  const runner = new JudgeRunner(
    { dataDir: 'synthetic-data', store: store as never, targets: () => [], snapshots: () => [] },
    {
      removeCheckout: async (repo, dir) => {
        removed.push([repo, dir]);
      },
    },
  );
  await runner.recover();
  assert.deepEqual(removed, [['synthetic-repo', join('synthetic-data', 'judge', record.id, 'checkout')]]);
  assert.equal(record.status, 'failed');
  assert.equal((records.get('judge-run:' + record.id) as { error: string }).error, '应用重启，判官中断。');
});

test('recover records a retained checkout if removal fails', async () => {
  const record = { id: 'jg-20261027-87654321', projectId: 'p', status: 'running', events: [] };
  const records = new Map<string, unknown>([
    ['project:p', { path: 'synthetic-repo' }],
    ['judge-run:' + record.id, record],
  ]);
  const store = {
    get: (kind: string, id: string) => records.get(`${kind}:${id}`),
    list: (kind: string) => [...records].filter(([key]) => key.startsWith(`${kind}:`)).map(([, value]) => value),
    save: (kind: string, id: string, _owner: string, value: unknown) => records.set(`${kind}:${id}`, value),
  };
  const runner = new JudgeRunner(
    { dataDir: 'synthetic-data', store: store as never, targets: () => [], snapshots: () => [] },
    {
      removeCheckout: async () => {
        throw new Error('synthetic failure');
      },
    },
  );
  await runner.recover();
  assert.ok((records.get('judge-run:' + record.id) as { checkoutRetainedAt?: string }).checkoutRetainedAt);
  assert.match((records.get('judge-run:' + record.id) as { note: string }).note, /清理失败/);
});

for (const deps of [
  { platform: 'darwin' as const, role: 'desktop' as const },
  { platform: 'win32' as const, role: 'node' as const },
]) {
  test(`tool-using judge refuses ${deps.platform}/${deps.role} before checkout or spawn`, async () => {
    let checkouts = 0,
      spawns = 0;
    const runner = new JudgeRunner(
      {
        dataDir: 'unused',
        store: { get: () => ({ id: 'p', path: 'unused', scope: 'project' }), list: () => [], save: () => {} } as never,
        targets: () => [],
        snapshots: () => [],
      },
      {
        ...deps,
        createCheckout: async () => {
          checkouts++;
        },
        spawn: async () => {
          spawns++;
          throw new Error('unexpected spawn');
        },
      },
    );
    await assert.rejects(runner.start({ projectId: 'p', sha: 'a'.repeat(40), claim: 'synthetic' }), /Windows/);
    assert.equal(checkouts, 0);
    assert.equal(spawns, 0);
  });
}
