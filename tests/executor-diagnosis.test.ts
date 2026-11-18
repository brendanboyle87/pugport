import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ExecutorDiagnosis } from '../src/server/executor-diagnosis.ts';
import { RouteUnavailableError } from '../src/server/routing.ts';
import { fill, Inbox } from '../src/server/inbox.ts';
import { inboxText, type InboxNotice } from '../src/shared/inbox.ts';
import type { RunInput, RunRecord, RuntimeSnapshot, RuntimeTarget } from '../src/shared/types.ts';

const hour = 3_600_000;
const dataDir = 'C:/synthetic/pugport-data';
const projectPath = 'C:/synthetic/private-project';
const plantedPrompt = 'PLANTED PROMPT TEXT that must never reach the diagnosis';
const card = (id: string, provider: RuntimeTarget['provider'], extra: Partial<RuntimeSnapshot> = {}) => ({
  target: { id, provider, label: `Synthetic ${id}`, command: provider, enabled: true } as RuntimeTarget,
  snapshot: {
    id,
    provider,
    label: `Synthetic ${id}`,
    status: 'ready',
    version: '1.2.3',
    capabilities: { toolless: provider === 'claude' || provider === 'grok' },
    ...extra,
  } as RuntimeSnapshot,
});
const reply = (value: unknown) => JSON.stringify(value);

function fixture(
  t: TestContext,
  cards = [card('codex-a', 'codex'), card('claude-a', 'claude'), card('grok-a', 'grok')],
  options: { timeoutMs?: number } = {},
) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let now = Date.now();
  const inbox = new Inbox(
    db,
    () => {},
    () => now,
  );
  const failedRun = (runtimeId: string, id = `failed-${runtimeId}`) =>
    ({
      id,
      prompt: plantedPrompt,
      projectPath,
      kind: 'routine',
      status: 'failed',
      route: { runtimeId },
      startedAt: new Date(now).toISOString(),
      endedAt: new Date(now).toISOString(),
      output: '',
      error: `failed while running ${plantedPrompt} in ${projectPath}`,
      errorCode: 'runtime-process-closed',
      errorDetail: `unknown option --mode in ${projectPath}`,
      startupFailure: { exitCode: 1, elapsedMs: 40, firstLine: 'error: unknown option --mode' },
      events: [
        {
          at: new Date(now).toISOString(),
          type: 'status',
          data: {
            kind: 'process-start',
            detail: { args: ['--mode', 'ask', '--workspace', `${projectPath}/src`, '--print'] },
          },
        },
      ],
    }) as unknown as RunRecord;
  const runs: RunRecord[] = cards.map((c) => failedRun(c.target.id));
  const starts: RunInput[] = [];
  const cancelled: string[] = [];
  const state = {
    capacity: true,
    output: reply({ action: 'none', happened: 'The CLI quit before it started.' }),
    status: 'completed' as RunRecord['status'],
    hang: false,
    locale: undefined as 'en' | undefined,
  };
  const host: ConstructorParameters<typeof ExecutorDiagnosis>[0] = {
    dataDir,
    targets: cards.map((c) => c.target),
    snapshots: cards.map((c) => c.snapshot),
    settings: {},
    inbox,
    store: {
      run: (id) => runs.find((r) => r.id === id),
      runSummaries: () => runs.map((r) => ({ ...r, events: [] })),
    },
    hasExecutionCapacity: () => state.capacity,
    uiLocaleHint: () => state.locale,
    async start(input, _lease, _signal, _before, onCreated) {
      starts.push(input);
      const run = {
        id: `diagnosis-${starts.length}`,
        status: state.hang ? 'running' : state.status,
        output: state.output,
        ...(state.hang ? {} : { endedAt: new Date().toISOString() }),
      } as RunRecord;
      onCreated?.(run);
      return run;
    },
    cancel(id) {
      cancelled.push(id);
    },
  };
  const diagnosis = new ExecutorDiagnosis(host, options.timeoutMs);
  const failing = (runtimeId = 'codex-a') =>
    inbox.raise({
      kind: 'executor-failing',
      key: runtimeId,
      severity: 'warning',
      title: `Synthetic ${runtimeId} failed 3 times`,
      body: inboxText.failingBody,
      action: { kind: 'view-run', runId: `failed-${runtimeId}` },
      source: { runtimeId, label: `Synthetic ${runtimeId}`, runId: `failed-${runtimeId}` },
    });
  const notice = (kind: InboxNotice['kind'], key: string) =>
    inbox.list().find((n) => n.kind === kind && n.key === key)!;
  return {
    inbox,
    host,
    diagnosis,
    starts,
    cancelled,
    state,
    failing,
    notice,
    advance: (ms: number) => (now += ms),
  };
}
test('an open failing notice is diagnosed once per notice id, and again after it is raised anew', async (t) => {
  const f = fixture(t);
  f.failing();
  await f.diagnosis.check();
  assert.equal(f.starts.length, 1);
  assert.equal(f.diagnosis.check(), undefined);
  assert.equal(f.starts.length, 1);
  f.inbox.resolve('executor-failing', 'codex-a');
  f.advance(hour + 1);
  f.failing();
  await f.diagnosis.check();
  assert.equal(f.starts.length, 2);
});

test('a route unavailable error allows the same notice to be retried', async (t) => {
  const f = fixture(t);
  f.failing();
  const start = f.host.start;
  let attempts = 0;
  f.host.start = async (...args) => {
    attempts++;
    if (attempts === 1) throw new RouteUnavailableError('quota', ['synthetic quota']);
    return start(...args);
  };
  await f.diagnosis.check();
  await f.diagnosis.check();
  assert.equal(attempts, 2);
  assert.equal(f.starts.length, 1);
});

test('an incompatible notice raised by reconcile is diagnosed once, not on every refresh', async (t) => {
  const f = fixture(t, [card('cursor-a', 'cursor'), card('claude-a', 'claude')]);
  f.inbox.reconcile(f.host.snapshots, f.host.targets);
  const broken = { ...f.host.snapshots[0], status: 'error' as const, note: 'runtime-protocol-incompatible' };
  f.host.snapshots[0] = broken;
  for (let refresh = 0; refresh < 3; refresh++) {
    f.inbox.reconcile(f.host.snapshots, f.host.targets);
    await f.diagnosis.check();
  }
  assert.equal(f.starts.length, 1);
  assert.equal(
    f.notice('executor-incompatible', 'cursor-a').body?.split('\n\n')[1],
    fill(inboxText.incompatiblePausedBody, 'Synthetic cursor-a'),
  );
});

test('no spare capacity skips without using up the notice; a diagnosis run never triggers another', async (t) => {
  const f = fixture(t);
  f.failing();
  f.state.capacity = false;
  assert.equal(f.diagnosis.check(), undefined);
  assert.equal(f.starts.length, 0);
  assert.equal(f.diagnosis.check({ stepId: 'executor-diagnosis' }), undefined);
  assert.equal(f.starts.length, 0);
  f.state.capacity = true;
  assert.equal(f.diagnosis.check({ stepId: 'executor-diagnosis' }), undefined);
  assert.equal(f.starts.length, 0);
  await f.diagnosis.check({ stepId: 'chat' });
  assert.equal(f.starts.length, 1);
});

test('only another provider’s toolless, unbilled card may diagnose', async (t) => {
  await t.test('Codex broken: Claude diagnoses', async (t) => {
    const f = fixture(t, [card('codex-a', 'codex'), card('claude-a', 'claude')]);
    f.failing('codex-a');
    await f.diagnosis.check();
    assert.deepEqual(f.starts[0]?.automaticExecutors, ['claude-a']);
    assert.deepEqual(f.starts[0]?.excludeRuntimeIds, ['codex-a']);
    assert.deepEqual(f.starts[0]?.excludeProviders, ['codex']);
  });
  await t.test('Claude broken: Grok diagnoses, never a second Claude card', async (t) => {
    const f = fixture(t, [card('claude-a', 'claude'), card('claude-b', 'claude'), card('grok-a', 'grok')]);
    f.failing('claude-a');
    await f.diagnosis.check();
    assert.deepEqual(f.starts[0]?.automaticExecutors, ['grok-a']);
    assert.deepEqual(f.starts[0]?.excludeProviders, ['claude']);
  });
  await t.test('only Claude and Codex with Claude broken: skipped', async (t) => {
    const f = fixture(t, [card('claude-a', 'claude'), card('codex-a', 'codex')]);
    f.failing('claude-a');
    assert.equal(f.diagnosis.check(), undefined);
    assert.equal(f.starts.length, 0);
  });
  await t.test('billed cards are excluded', async (t) => {
    const f = fixture(t, [
      card('codex-a', 'codex'),
      card('claude-key', 'claude', { authMode: 'apiKey' }),
      card('claude-usage', 'claude', { accounting: { mode: 'usage', source: 'synthetic' } }),
      card('claude-api', 'claude', { apiProvider: 'anthropic' }),
      card('grok-a', 'grok'),
    ]);
    f.failing('codex-a');
    await f.diagnosis.check();
    assert.deepEqual(f.starts[0]?.automaticExecutors, ['grok-a']);
  });
});

test('the prompt carries redacted evidence and launch arguments, never the task prompt or project path', async (t) => {
  const f = fixture(t);
  f.failing();
  await f.diagnosis.check();
  const input = f.starts[0]!;
  assert.equal(input.projectPath, dataDir);
  assert.equal(input.stepId, 'executor-diagnosis');
  assert.equal(input.untrustedContent, true);
  assert.equal(input.explicitNoTools, true);
  assert.equal(input.permissionMode, 'read-only');
  assert.match(input.prompt, /runtime-process-closed/);
  assert.match(input.prompt, /error: unknown option --mode/);
  assert.match(input.prompt, /--workspace/);
  assert.match(input.prompt, /\[private path\]/);
  assert.match(input.prompt, /untrusted/);
  assert.match(input.prompt, /Simplified Chinese/);
  assert.doesNotMatch(input.prompt, /PLANTED PROMPT/);
  assert.doesNotMatch(input.prompt, /private-project/);
});

test('the prompt asks for English when the interface is English', async (t) => {
  const f = fixture(t);
  f.state.locale = 'en';
  f.failing();
  await f.diagnosis.check();
  assert.match(f.starts[0]!.prompt, /in English/);
});

test('a valid answer rebuilds the failing notice into three paragraphs written mostly by PugPort', async (t) => {
  const f = fixture(t);
  const raised = f.failing();
  f.inbox.markRead([raised.id]);
  f.state.output = reply({
    action: 'sign-in',
    happened: 'The sign-in expired. Details at https://example.invalid/login with token=abc123',
    proposedChange: 'Check the login before launching.',
  });
  await f.diagnosis.check();
  const notice = f.notice('executor-failing', 'codex-a');
  const paragraphs = notice.body!.split('\n\n');
  assert.equal(paragraphs.length, 3);
  assert.match(paragraphs[0]!, /^The sign-in expired\./);
  assert.match(paragraphs[0]!, /\[redacted URL\]/);
  assert.doesNotMatch(paragraphs[0]!, /abc123/);
  assert.equal(paragraphs[1], inboxText.incompatibleRetryBody);
  assert.equal(paragraphs[2], inboxText.diagnosisSignInBody);
  assert.deepEqual(notice.action, { kind: 'sign-in', runtimeId: 'codex-a' });
  assert.equal(notice.severity, 'action');
  assert.match(notice.details!, /unknown option --mode/);
  assert.ok(notice.details!.endsWith(`${inboxText.diagnosisProposalLabel}Check the login before launching.`));
  assert.equal(notice.count, raised.count);
  assert.equal(notice.readAt, undefined);
});

test('paragraph 2 says paused only for an error status or an active cooldown', async (t) => {
  for (const extra of [
    { status: 'error' as const },
    {
      executorCooldown: {
        reason: 'failures' as const,
        streak: 3,
        errorCode: 'runtime-process-closed',
        observedAt: new Date().toISOString(),
        retryAt: new Date(Date.now() + hour).toISOString(),
      },
    },
  ]) {
    const f = fixture(t, [card('codex-a', 'codex', extra), card('claude-a', 'claude')]);
    f.failing();
    await f.diagnosis.check();
    assert.equal(
      f.notice('executor-failing', 'codex-a').body!.split('\n\n')[1],
      fill(inboxText.incompatiblePausedBody, 'Synthetic codex-a'),
    );
  }
});

test('update-cli takes the command from a fixed table, never from the AI', async (t) => {
  const answer = reply({ action: 'update-cli', happened: 'Too old. Run `npm i -g evil-cli` to fix it.' });
  const f = fixture(t, [card('cursor-a', 'cursor'), card('claude-a', 'claude')]);
  f.state.output = answer;
  f.failing('cursor-a');
  await f.diagnosis.check();
  const cursor = f.notice('executor-failing', 'cursor-a');
  assert.equal(cursor.body!.split('\n\n')[2], '在终端运行 `cursor-agent update` 更新命令行。');
  assert.deepEqual(cursor.action, { kind: 'update-cli', runtimeId: 'cursor-a' });

  const g = fixture(t);
  g.state.output = answer;
  g.failing('codex-a');
  await g.diagnosis.check();
  assert.equal(
    g.notice('executor-failing', 'codex-a').body!.split('\n\n')[2],
    fill(inboxText.diagnosisUpdateCliFallbackBody, 'Synthetic codex-a'),
  );
});

test('update-cli never names a Google CLI command', async (t) => {
  const f = fixture(t, [card('gemini-a', 'gemini'), card('claude-a', 'claude')]);
  f.state.output = reply({ action: 'update-cli', happened: 'Too old.' });
  f.failing('gemini-a');
  await f.diagnosis.check();
  const body = f.notice('executor-failing', 'gemini-a').body!;
  assert.equal(body.split('\n\n')[2], fill(inboxText.diagnosisUpdateCliFallbackBody, 'Synthetic gemini-a'));
  assert.doesNotMatch(body, /npm install -g @google\/gemini-cli/);
});

test('an incompatible notice keeps PugPort’s paragraph 2', async (t) => {
  const f = fixture(t, [card('cursor-a', 'cursor'), card('claude-a', 'claude')]);
  f.state.output = reply({ action: 'wait', happened: 'The CLI changed a flag.' });
  f.inbox.reconcile(f.host.snapshots, f.host.targets);
  f.host.snapshots[0] = { ...f.host.snapshots[0]!, status: 'error', note: 'runtime-protocol-incompatible' };
  f.inbox.reconcile(f.host.snapshots, f.host.targets);
  const before = f.notice('executor-incompatible', 'cursor-a');
  await f.diagnosis.check();
  const after = f.notice('executor-incompatible', 'cursor-a');
  const paragraphs = after.body!.split('\n\n');
  assert.deepEqual(paragraphs, ['The CLI changed a flag.', before.body!.split('\n\n')[1], inboxText.diagnosisNoneBody]);
  assert.equal(after.severity, before.severity);
  assert.deepEqual(after.action, before.action);
});

test('invalid JSON, extra keys, a failed run or a timeout leave the notice unchanged', async (t) => {
  for (const setup of [
    (f: ReturnType<typeof fixture>) => (f.state.output = 'not json'),
    (f: ReturnType<typeof fixture>) =>
      (f.state.output = reply({ action: 'none', happened: 'Fine.', command: 'rm -rf /' })),
    (f: ReturnType<typeof fixture>) => (f.state.output = reply({ action: 'reinstall', happened: 'Fine.' })),
    (f: ReturnType<typeof fixture>) => (f.state.status = 'failed'),
    (f: ReturnType<typeof fixture>) => (f.state.hang = true),
  ]) {
    const f = fixture(t, undefined, { timeoutMs: 50 });
    setup(f);
    f.failing();
    const before = f.notice('executor-failing', 'codex-a');
    await f.diagnosis.check();
    assert.equal(f.starts.length, 1);
    assert.deepEqual(f.notice('executor-failing', 'codex-a'), before);
    if (f.state.hang) assert.deepEqual(f.cancelled, ['diagnosis-1']);
  }
});
