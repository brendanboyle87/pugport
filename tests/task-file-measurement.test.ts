import assert from 'node:assert/strict';
import { execFileSync } from '../src/server/platform/test-process.ts';
import { mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Controller } from '../src/server/controller.ts';
import { cursorAdapter } from '../src/server/adapters/cursor.ts';
import { grokAdapter } from '../src/server/adapters/grok.ts';
import { piAdapter } from '../src/server/adapters/pi.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import type { ExecuteContext, Provider, RuntimeSnapshot, RunInput } from '../src/shared/types.ts';

function fixture(t: TestContext, provider: Provider, git = true) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-file-measurement-')));
  if (git) execFileSync('git', ['init', '-q'], { cwd: directory });
  writeFileSync(join(directory, '.gitignore'), '.data/\n');
  const controller = new Controller(directory, join(directory, '.data'));
  clearInterval(controller.timer);
  controller.settings.allowDirectPiApi = true;
  controller.targets = [
    { id: 'mock', provider, label: 'Synthetic', command: 'unused', environment: 'native', enabled: true },
  ];
  const snapshot: RuntimeSnapshot = {
    ...controller.targets[0]!,
    installed: true,
    status: 'ready',
    accountFingerprint: 'fixture-account',
    models: [{ id: 'fixture-model', label: 'Fixture', efforts: ['low', 'medium', 'high'] }],
    quota: {
      status: 'known',
      source: 'fixture',
      observedAt: new Date().toISOString(),
      windows: [{ id: 'week', label: 'Week', usedPercent: 10, resetsAt: new Date(Date.now() + 3600000).toISOString() }],
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: new Date().toISOString(),
  };
  controller.snapshots = [snapshot];
  const adapter = { cursor: cursorAdapter, grok: grokAdapter, pi: piAdapter, codex: codexAdapter }[
    provider as 'cursor' | 'grok' | 'pi' | 'codex'
  ];
  t.mock.method(adapter, 'discover', async () => snapshot);
  t.mock.method(controller, 'refresh', async () => {});
  t.after(async () => {
    await controller.close();
    assert.equal(dirname(directory).toLowerCase(), realpathSync.native(tmpdir()).toLowerCase());
    assert.ok(basename(directory).startsWith('pugport-file-measurement-'));
    rmSync(directory, { recursive: true, force: true });
  });
  const execute = async (
    work: (ctx: ExecuteContext) => void,
    output = 'Done.\nCOMBORUNNER_TASK_RESULT: {"status":"completed","summary":"Done"}',
    extra: Partial<RunInput> = {},
  ) => {
    t.mock.method(adapter, 'execute', async (ctx: ExecuteContext) => {
      work(ctx);
      return { output };
    });
    const started = await controller.start({
      prompt: 'Update the synthetic project file.',
      projectPath: directory,
      runtimeId: 'mock',
      model: 'fixture-model',
      kind: 'routine',
      permissionMode: 'workspace-write',
      executionPolicy: provider === 'pi' ? 'api-only' : 'cli-only',
      reportTaskOutcome: true,
      requiresFileChanges: true,
      ...extra,
    });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const saved = controller.run(started.id)!;
      if (!['queued', 'running', 'waiting-approval'].includes(saved.status)) return controller.runWithAudit(saved.id)!;
      await new Promise((done) => setTimeout(done, 10));
    }
    throw new Error('Synthetic file run did not finish');
  };
  return { directory, execute, controller };
}

test('Cursor, Grok and Pi changes are confirmed by PugPort measurement without adapter-specific receipts', async (t) => {
  for (const provider of ['cursor', 'grok', 'pi'] as const) {
    await t.test(provider, async (t) => {
      const f = fixture(t, provider);
      const record = await f.execute(() => writeFileSync(join(f.directory, 'result.txt'), 'synthetic edit'));
      assert.equal(record.status, 'completed', record.error ?? 'measured change must complete');
      assert.equal(record.taskOutcome?.status, 'completed');
      assert.deepEqual(record.measuredFileChanges, { source: 'pugport-scope-snapshot', paths: ['result.txt'] });
      assert.ok(
        record.events.some((event) => event.data?.hostAudit === true && event.data?.kind === 'measured-file-changes'),
      );
    });
  }
});

test('a git mv command is confirmed by measured changes even without an operation receipt', async (t) => {
  const f = fixture(t, 'codex');
  writeFileSync(join(f.directory, 'source.txt'), 'synthetic move');
  execFileSync('git', ['add', '--', 'source.txt'], { cwd: f.directory });
  const record = await f.execute((ctx) => {
    execFileSync('git', ['mv', '--', 'source.txt', 'target.txt'], { cwd: f.directory });
    ctx.emit({
      at: '',
      type: 'tool',
      data: {
        kind: 'commandExecution',
        itemId: 'shell',
        status: 'completed',
        exitCode: 0,
        input: { command: 'git mv source.txt target.txt' },
      },
    });
  });
  assert.equal(record.status, 'completed', record.error ?? 'measured move must complete');
  assert.ok(record.measuredFileChanges?.paths.includes('target.txt'));
});

test('pre-existing dirty files and a no-op shell command do not confirm a change', async (t) => {
  const f = fixture(t, 'codex');
  writeFileSync(join(f.directory, 'old.txt'), 'already dirty');
  const record = await f.execute((ctx) =>
    ctx.emit({
      at: '',
      type: 'tool',
      data: { kind: 'commandExecution', itemId: 'shell', status: 'completed', exitCode: 0 },
    }),
  );
  assert.equal(record.taskOutcome?.status, 'unverified');
  assert.deepEqual(record.measuredFileChanges?.paths, []);
});

test('a move without git or receipts remains unverified', async (t) => {
  const f = fixture(t, 'codex', false);
  writeFileSync(join(f.directory, 'source.txt'), 'synthetic file outside git');
  const record = await f.execute(() => renameSync(join(f.directory, 'source.txt'), join(f.directory, 'result.txt')));
  assert.equal(record.taskOutcome?.status, 'unverified');
  assert.equal(record.measuredFileChanges, undefined);
});

test('committed changes are measured and confirm a file outcome', async (t) => {
  const f = fixture(t, 'codex');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: f.directory });
  git('add', '.gitignore');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-q', '-m', 'init');
  const record = await f.execute(() => {
    writeFileSync(join(f.directory, 'feature.ts'), 'new');
    git('add', 'feature.ts');
    git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-q', '-m', 'feature');
  });
  assert.equal(record.taskOutcome?.status, 'completed');
  assert.ok(record.measuredFileChanges?.paths.includes('feature.ts'));
  assert.notEqual(record.measuredFileChanges?.commits?.before, record.measuredFileChanges?.commits?.after);
});

test('first commit, failed file receipt and limited checks use host evidence', async (t) => {
  const f = fixture(t, 'codex');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: f.directory });
  const record = await f.execute((ctx) => {
    writeFileSync(join(f.directory, 'feature.ts'), 'new');
    ctx.emit({
      at: '',
      type: 'tool',
      data: {
        itemId: 'file',
        kind: 'fileChange',
        status: 'failed',
        isError: true,
        input: { changes: [{ path: 'feature.ts' }] },
        failureMessage: 'Failed to write file: EACCES',
      },
    });
    ctx.emit({
      at: '',
      type: 'tool',
      data: {
        itemId: 'check',
        kind: 'commandExecution',
        status: 'failed',
        exitCode: 1,
        input: { command: 'test' },
        output: 'listen EACCES',
      },
    });
    git('add', '.gitignore', 'feature.ts');
    git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-q', '-m', 'first');
  }, 'COMBORUNNER_TASK_RESULT: {"status":"blocked","summary":"Tests could not run: listen EACCES"}');
  assert.equal(record.taskOutcome?.status, 'blocked');
  assert.equal(record.taskOutcome?.limitedChecks?.length, 1);
  assert.equal(record.status, 'failed');
  assert.equal(record.measuredFileChanges?.commits?.before, undefined);
  assert.ok(record.measuredFileChanges?.paths.includes('feature.ts'));
});

test('committing an untouched pre-existing dirty file does not vouch for another receipt', async (t) => {
  const f = fixture(t, 'codex');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: f.directory });
  writeFileSync(join(f.directory, 'old.txt'), 'original');
  git('add', '.gitignore', 'old.txt');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-q', '-m', 'init');
  writeFileSync(join(f.directory, 'old.txt'), 'already dirty');
  const record = await f.execute((ctx) => {
    ctx.emit({
      at: '',
      type: 'tool',
      data: { itemId: 'file', kind: 'fileChange', status: 'failed', input: { changes: [{ path: 'new.ts' }] } },
    });
    git('add', '-A');
    git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-q', '-m', 'dirty');
  });
  assert.equal(record.taskOutcome?.status, 'unverified');
  assert.deepEqual(record.measuredFileChanges?.paths, []);
});

test('checking out a divergent branch is not evidence of a run change', async (t) => {
  const f = fixture(t, 'codex');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: f.directory });
  git('add', '.gitignore');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-q', '-m', 'init');
  git('checkout', '-q', '-b', 'side');
  writeFileSync(join(f.directory, 'x.ts'), 'side');
  git('add', 'x.ts');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-q', '-m', 'side');
  git('checkout', '-q', '--detach', 'HEAD~1');
  writeFileSync(join(f.directory, 'main.ts'), 'main');
  git('add', 'main.ts');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-q', '-m', 'main');
  const record = await f.execute(() => git('checkout', '-q', 'side'));
  assert.deepEqual(record.measuredFileChanges?.paths, []);
  assert.equal(record.measuredFileChanges?.commits, undefined);
});

test('approved format baseline runs before executor; only newly failing files fail the run', async (t) => {
  for (const newFailure of [false, true])
    await t.test(String(newFailure), async (t) => {
      const f = fixture(t, 'codex');
      f.controller.isVerificationApproved = () => true;
      let executed = false;
      let checks = 0;
      t.mock.method(f.controller, 'verify', async (command: string) => {
        checks++;
        assert.equal(executed, checks > 1);
        const file = executed && newFailure ? 'new.ts' : 'old.ts';
        return {
          command,
          status: 'failed' as const,
          exitCode: 1,
          output: `Checking formatting...\n[warn] ${file}\n[warn] Code style issues found in 1 file. Run Prettier with --write to fix.`,
        };
      });
      const record = await f.execute(
        () => {
          executed = true;
          writeFileSync(join(f.directory, 'result.txt'), 'synthetic');
        },
        undefined,
        { verificationCommand: 'npm run format:check' },
      );
      assert.equal(checks, 2);
      assert.equal(record.status, newFailure ? 'failed' : 'completed');
      assert.equal(record.verification?.status, newFailure ? 'failed' : 'skipped');
      if (!newFailure) assert.match(record.verification!.output, /check already failed before this task/);
    });
});
