import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { externalNoToolsRunner, JudgeUnavailableError, pinnedJudgeProblem } from '../src/server/maintainer/executor.ts';
import { readDesktopConfig, readHostFlag, writeHostFlag, type JudgePin } from '../src/server/maintainer/config.ts';
import { githubHostRequestSchema } from '../src/server/node/peer-protocol.ts';
import { buildPrJudgePrompt } from '../src/server/maintainer/pr-judge.ts';
import { fetchPullMaterial } from '../src/server/maintainer/pr-material.ts';
import { classifyPullRequest } from '../src/server/maintainer/tiers.ts';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { ExternalTasks } from '../src/server/external-tasks.ts';
import { piAdapter } from '../src/server/adapters/pi.ts';
import { claudeAdapter } from '../src/server/adapters/claude.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import type { ExecuteContext, ExecuteResult, RuntimeSnapshot, RuntimeTarget, Workflow } from '../src/shared/types.ts';
import { hostFixture } from './helpers/maintainer-host.ts';
import { pullFixture } from './helpers/maintainer.ts';

// Synthetic executors only: no model, network or GitHub call is made.
const stamp = '2026-11-10T12:00:00.000Z';
const target = (
  id: string,
  provider: RuntimeTarget['provider'],
  label: string,
  extra: Partial<RuntimeTarget> = {},
): RuntimeTarget => ({ id, provider, label, command: 'unused', environment: 'native', enabled: true, ...extra });
const snapshot = (
  card: RuntimeTarget,
  model: string,
  toolless: boolean,
  extra: Partial<RuntimeSnapshot> = {},
): RuntimeSnapshot => ({
  id: card.id,
  provider: card.provider,
  label: card.label,
  environment: 'native',
  installed: true,
  status: 'ready',
  models: [{ id: model, label: model, efforts: ['low', 'medium', 'high'] }],
  quota: {
    status: 'known',
    source: 'fixture',
    observedAt: new Date(Date.now() - 1000).toISOString(),
    windows: [{ id: 'week', label: 'week', usedPercent: 10, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }],
  },
  capabilities: { execute: true, resume: true, cancel: true, approvals: false, ...(toolless ? { toolless } : {}) },
  refreshedAt: new Date(Date.now() - 1000).toISOString(),
  ...(card.gateway ? { gateway: card.gateway, apiProvider: card.apiProvider } : {}),
  ...extra,
});
/**
 * A local model added twice (a free-source card with a custom address and a Custom API card), plus the paid CLI
 * subscriptions automatic routing would otherwise pick: Claude can run tool-less, Codex cannot.
 */
function executors() {
  const free = target('api-custom', 'pi', 'Local coder', {
    gateway: 'api',
    apiProvider: 'custom',
    apiBaseUrl: 'http://127.0.0.1:8000/v1',
    apiMayLog: false,
  });
  const custom = target('api-custom-api', 'pi', 'Local coder API', { gateway: 'api', apiProvider: 'custom-api' });
  const claude = target('claude', 'claude', 'Claude');
  const codex = target('codex', 'codex', 'Codex');
  return {
    targets: [free, custom, claude, codex],
    snapshots: [
      snapshot(free, 'local-coder', true, { costTier: 'free', local: true, mayLog: false }),
      snapshot(custom, 'local-coder', true),
      snapshot(claude, 'claude-model', true),
      snapshot(codex, 'codex-model', false),
    ],
  };
}
type Executors = ReturnType<typeof executors>;
const card = (env: Executors, id: string) => ({
  target: env.targets.find((item) => item.id === id)!,
  snapshot: env.snapshots.find((item) => item.id === id)!,
});
const freePin: JudgePin = { executor: 'api-custom', model: 'local-coder' };
const customPin: JudgePin = { executor: 'api-custom-api', model: 'local-coder' };
/** Each way a pinned judge can be unavailable, applied to a fresh set of executors. */
const unavailableCases: { name: string; pin: JudgePin; apply?: (env: Executors) => void; reason: RegExp }[] = [
  {
    name: 'missing',
    pin: { executor: 'api-removed', model: 'local-coder' },
    reason: /executor api-removed not found \(tool-less cards: api-custom, api-custom-api, claude\)/,
  },
  {
    name: 'disabled',
    pin: freePin,
    apply: (env) => (card(env, 'api-custom').target.enabled = false),
    reason: /api-custom\) is disabled/,
  },
  {
    name: 'turned off for execution',
    pin: customPin,
    apply: (env) => (card(env, 'api-custom-api').target.executionDisabledByUser = true),
    reason: /api-custom-api\) is disabled/,
  },
  {
    name: 'not ready',
    pin: freePin,
    apply: (env) => (card(env, 'api-custom').snapshot.status = 'error'),
    reason: /is not ready \(error\)/,
  },
  {
    name: 'not discovered yet',
    pin: freePin,
    apply: (env) => (env.snapshots = env.snapshots.filter((item) => item.id !== 'api-custom')),
    reason: /is not ready yet/,
  },
  {
    name: 'without the toolless capability',
    pin: freePin,
    apply: (env) =>
      (card(env, 'api-custom').snapshot.capabilities = {
        ...card(env, 'api-custom').snapshot.capabilities,
        toolless: false,
      }),
    reason: /cannot run without tools/,
  },
  {
    name: 'needing a new sign-in',
    pin: customPin,
    apply: (env) =>
      (card(env, 'api-custom-api').snapshot.availability = { reason: 'authentication', observedAt: stamp }),
    reason: /needs to sign in again/,
  },
  {
    name: 'rate-limited',
    pin: freePin,
    apply: (env) =>
      (card(env, 'api-custom').snapshot.availability = {
        reason: 'quota',
        observedAt: stamp,
        retryAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    reason: /is rate-limited/,
  },
  {
    name: 'model not offered',
    pin: { executor: 'api-custom', model: 'other-model' },
    reason: /does not offer model other-model \(offers: local-coder\)/,
  },
];

function fakeTasks(answer: (input: { task: string; title?: string }) => string = () => 'answer') {
  const dispatched: Record<string, unknown>[] = [];
  const cancelled: string[] = [];
  const outcomes = new Map<string, { status: string; result?: string; error?: string }>();
  let settle: ((id: string) => { status: string; result?: string; error?: string }) | undefined;
  const tasks = {
    async dispatch(input: Record<string, unknown>) {
      dispatched.push(input);
      const taskId = `task-${dispatched.length}`;
      outcomes.set(taskId, { status: 'completed', result: answer(input as { task: string; title?: string }) });
      return { taskId };
    },
    async result(id: string) {
      return settle?.(id) ?? outcomes.get(id);
    },
    status: () => ({ executor: 'Local coder', model: 'local-coder' }),
    cancel(id: string) {
      cancelled.push(id);
    },
  };
  return {
    tasks,
    dispatched,
    cancelled,
    onResult(fn: typeof settle) {
      settle = fn;
    },
  };
}

test('a pinned judge dispatches exactly that card and model, for a free source and a Custom API card', async () => {
  for (const pin of [freePin, customPin]) {
    const env = executors();
    const fake = fakeTasks();
    const runner = externalNoToolsRunner(fake.tasks as never, env, 'GitHub maintenance', () => pin);
    assert.equal(runner.toollessReady(), true);
    assert.equal(runner.unavailable?.(), undefined);
    const run = await runner.dispatch({ prompt: 'synthetic prompt', title: 'GitHub maintenance · PR #1' });
    assert.deepEqual(fake.dispatched, [
      {
        task: 'synthetic prompt',
        title: 'GitHub maintenance · PR #1',
        caller: 'GitHub maintenance',
        readOnly: true,
        untrusted: true,
        pin: { runtimeId: pin.executor, model: pin.model },
      },
    ]);
    assert.deepEqual(await runner.result(run.taskId, 0), {
      status: 'completed',
      result: 'answer',
      executor: 'Local coder',
      model: 'local-coder',
    });
  }
});

test('without a pin the runner dispatches exactly as before', async () => {
  const env = executors();
  const fake = fakeTasks();
  for (const runner of [
    externalNoToolsRunner(fake.tasks as never, env, 'GitHub maintenance'),
    externalNoToolsRunner(fake.tasks as never, env, 'GitHub maintenance', () => undefined),
  ]) {
    assert.equal(runner.toollessReady(), true);
    assert.equal(runner.unavailable?.(), undefined);
    await runner.dispatch({ prompt: 'p', title: 't' });
  }
  for (const call of fake.dispatched)
    assert.deepEqual(call, { task: 'p', title: 't', caller: 'GitHub maintenance', readOnly: true, untrusted: true });
  // Today's refusal is unchanged too: no tool-less executor ready means no dispatch.
  env.snapshots = env.snapshots.filter((item) => item.id === 'codex');
  const runner = externalNoToolsRunner(fake.tasks as never, env, 'GitHub maintenance', () => undefined);
  assert.equal(runner.toollessReady(), false);
  assert.equal(runner.unavailable?.(), undefined);
  await assert.rejects(runner.dispatch({ prompt: 'p', title: 't' }), /noToollessExecutor/);
  assert.equal(fake.dispatched.length, 2);
});

test('an unavailable pinned judge dispatches nothing, even with ready tool-less executors elsewhere', async () => {
  for (const item of unavailableCases) {
    const env = executors();
    item.apply?.(env);
    assert.ok(
      env.snapshots.some((s) => s.id === 'claude' && s.status === 'ready'),
      'a paid fallback is ready',
    );
    const fake = fakeTasks();
    const runner = externalNoToolsRunner(fake.tasks as never, env, 'GitHub maintenance', () => item.pin);
    assert.equal(runner.toollessReady(), false, item.name);
    assert.match(runner.unavailable?.() ?? '', /^Pinned judge unavailable: /, item.name);
    assert.match(runner.unavailable?.() ?? '', item.reason, item.name);
    await assert.rejects(runner.dispatch({ prompt: 'p', title: 't' }), (error: unknown) => {
      assert.ok(error instanceof JudgeUnavailableError, item.name);
      assert.match(error.message, item.reason);
      return true;
    });
    assert.equal(fake.dispatched.length, 0, item.name);
    // The explicit opt-in restores automatic routing, without the pin.
    const fallback = externalNoToolsRunner(fake.tasks as never, env, 'GitHub maintenance', () => ({
      ...item.pin,
      fallback: 'automatic',
    }));
    assert.equal(fallback.toollessReady(), true, item.name);
    assert.equal(fallback.unavailable?.(), undefined, item.name);
    await fallback.dispatch({ prompt: 'p', title: 't' });
    assert.deepEqual(fake.dispatched.at(-1), {
      task: 'p',
      title: 't',
      caller: 'GitHub maintenance',
      readOnly: true,
      untrusted: true,
    });
  }
});

test('a pinned paid CLI executor without tool-less support is refused', async () => {
  const env = executors();
  const fake = fakeTasks();
  const pin = { executor: 'codex', model: 'codex-model' };
  assert.equal(pinnedJudgeProblem(pin, env), 'Codex (codex) cannot run without tools');
  const runner = externalNoToolsRunner(fake.tasks as never, env, 'GitHub maintenance', () => pin);
  assert.equal(runner.toollessReady(), false);
  await assert.rejects(runner.dispatch({ prompt: 'p', title: 't' }), JudgeUnavailableError);
  assert.equal(fake.dispatched.length, 0);
});

test('a pinned run that ends because its card went away is unavailable, not a verdict', async () => {
  const env = executors();
  const fake = fakeTasks();
  const runner = externalNoToolsRunner(fake.tasks as never, env, 'GitHub maintenance', () => freePin);
  const first = await runner.dispatch({ prompt: 'p', title: 't' });
  fake.onResult(() => ({ status: 'failed', error: 'synthetic connection refused' }));
  // The card is still ready: the failure is reported as today (the judge turns it into "could not run").
  assert.deepEqual(await runner.result(first.taskId, 0), {
    status: 'failed',
    error: 'synthetic connection refused',
    executor: 'Local coder',
    model: 'local-coder',
  });
  const second = await runner.dispatch({ prompt: 'p', title: 't' });
  card(env, 'api-custom').snapshot.status = 'error';
  await assert.rejects(runner.result(second.taskId, 0), /is not ready \(error\)/);
  // Discovery has not noticed yet: the runner looks at that one card again before deciding.
  card(env, 'api-custom').snapshot.status = 'ready';
  const refreshed: unknown[] = [];
  const watched = Object.assign(env, {
    refresh: async (options: unknown) => {
      refreshed.push(options);
      card(env, 'api-custom').snapshot.status = 'missing';
    },
  });
  const probing = externalNoToolsRunner(fake.tasks as never, watched, 'GitHub maintenance', () => freePin);
  const third = await probing.dispatch({ prompt: 'p', title: 't' });
  await assert.rejects(probing.result(third.taskId, 0), /is not ready \(missing\)/);
  assert.deepEqual(refreshed, [{ runtimeIds: ['api-custom'], fresh: true }]);
});

test('maintainer configuration accepts a judge pin and rejects malformed ones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'judge-pin-config-'));
  try {
    const file = join(dir, 'maintainer.json');
    const judge: JudgePin = { executor: 'api-custom', model: 'local-coder', fallback: 'none', maxPromptKB: 96 };
    await writeFile(file, JSON.stringify({ repository: 'o/r', judge }));
    assert.deepEqual((await readDesktopConfig(file)).config?.judge, judge);
    for (const bad of [
      { executor: 'api-custom' },
      { executor: 'api-custom', model: 'local-coder', fallback: 'cheapest' },
      { executor: 'api-custom', model: 'local-coder', maxPromptKB: 8 },
      { executor: 'api-custom', model: 'local-coder', tools: true },
      { executor: ' ', model: 'local-coder' },
    ]) {
      await writeFile(file, JSON.stringify({ repository: 'o/r', judge: bad }));
      assert.ok((await readDesktopConfig(file)).error, JSON.stringify(bad));
    }
    // The pin travels with the hosting request to this computer or a paired device, and is saved with the flag.
    const request = githubHostRequestSchema.parse({ host: true, repository: 'o/r', hostedBy: 'desk', judge });
    assert.deepEqual('judge' in request && request.judge, judge);
    const flagFile = join(dir, 'github-host.json');
    writeHostFlag(flagFile, { host: true, repository: 'o/r', stage: 0, judge });
    assert.deepEqual(readHostFlag(flagFile).judge, judge);
    // Without the option nothing new is written.
    writeHostFlag(flagFile, { host: true, repository: 'o/r', stage: 0, judge: undefined });
    assert.ok(!('judge' in readHostFlag(flagFile)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a smaller prompt budget drops base files first and blocks a diff that cannot fit', async () => {
  const material = await fetchPullMaterial(pullFixture().gh, 'o/r', 7);
  assert.ok(!('blocked' in material));
  const tier = classifyPullRequest({ paths: material.paths, authorIsCollaborator: true });
  material.files[0]!.baseText = 'x'.repeat(50_000);
  const full = buildPrJudgePrompt({ material, tier, trusted: true });
  assert.equal(full.blocked, undefined);
  assert.ok(Buffer.byteLength(full.prompt) > 50_000);
  const small = buildPrJudgePrompt({ material, tier, trusted: true, maxPromptBytes: 32_000 });
  assert.equal(small.blocked, undefined);
  assert.ok(Buffer.byteLength(small.prompt) <= 32_000);
  assert.ok(small.omitted.includes('BASE FILE src/widget.ts: budget'));
  const large = buildPrJudgePrompt({
    material: { ...material, diff: 'y'.repeat(40_000) },
    tier,
    trusted: true,
    maxPromptBytes: 32_000,
  });
  assert.equal(large.blocked, 'too large for a no-tools review: prompt exceeds 32 kB after omitting context');
});

test('the judge prompt asks for a bare verdict line first, overriding general reply formatting', async () => {
  const material = await fetchPullMaterial(pullFixture().gh, 'o/r', 7);
  assert.ok(!('blocked' in material));
  const tier = classifyPullRequest({ paths: material.paths, authorIsCollaborator: true });
  const { prompt } = buildPrJudgePrompt({ material, tier, trusted: true });
  const sha = material.headSha;
  for (const word of ['PASS', 'FAIL', 'BLOCKED'])
    assert.match(prompt, new RegExp(`^${word} @ ${sha}$`, 'm'), `${word} is shown alone on its own line`);
  assert.match(prompt, /Write nothing before line 1: no title, greeting or heading\./);
  assert.match(prompt, /no bold, heading, list marker, quote or code fence\) and add nothing after the commit id/);
  assert.match(prompt, /takes precedence over any general formatting guidance/);
  assert.ok(prompt.endsWith(`alone and unformatted: PASS @ ${sha}, FAIL @ ${sha} or BLOCKED @ ${sha}.`));
});

// --- The maintainer host: poll, status, GitHub writes and retry with the real runner over fake tasks.

async function pinnedHost(t: TestContext, judge?: JudgePin, env = executors()) {
  let f!: Awaited<ReturnType<typeof hostFixture>>;
  const fake = fakeTasks((input) => {
    const number = Number(/PR #(\d+)/.exec(input.title ?? '')?.[1]);
    return `PASS @ ${f.data.prs.get(number)!.view.headRefOid.slice(0, 7)}\n## Risks\nnone\n## Tests\nsynthetic\n## Missing\nnone\nJUDGE: pr-judge`;
  });
  f = await hostFixture(t, {
    runner: (flagFile) =>
      externalNoToolsRunner(fake.tasks as never, env, 'GitHub maintenance', () => readHostFlag(flagFile).judge),
  });
  if (judge) writeHostFlag(f.flagFile, { ...readHostFlag(f.flagFile), judge });
  const statuses = () =>
    f.writes
      .filter((call) => call.args[3]?.includes('/statuses/'))
      .map((call) => JSON.parse(call.input!) as { state: string; description: string });
  const comments = () => f.writes.filter((call) => /\/comments$/.test(call.args[3] ?? ''));
  return { f, fake, env, statuses, comments };
}

test('host: a pinned and ready judge reviews on that card and model', async (t) => {
  const { f, fake, statuses } = await pinnedHost(t, freePin);
  f.addPr(1);
  await f.poll();
  assert.equal(fake.dispatched.length, 1);
  assert.deepEqual(fake.dispatched[0]!.pin, { runtimeId: 'api-custom', model: 'local-coder' });
  assert.equal(fake.dispatched[0]!.untrusted, true);
  assert.equal(fake.dispatched[0]!.readOnly, true);
  assert.equal(f.record(1).verdict, 'pass');
  assert.deepEqual(
    statuses().map((s) => s.state),
    ['pending', 'success'],
  );
  assert.equal(statuses()[0]!.description, 'Review queued');
  assert.equal((await f.host.status()).ready.problem, undefined);
});

test('host: without a pin, dispatch and statuses are unchanged', async (t) => {
  const { f, fake, statuses } = await pinnedHost(t);
  f.addPr(1);
  await f.poll();
  assert.deepEqual(
    fake.dispatched.map((call) => Object.keys(call).sort()),
    [['caller', 'readOnly', 'task', 'title', 'untrusted']],
  );
  assert.equal(f.record(1).verdict, 'pass');
  assert.deepEqual(
    statuses().map((s) => [s.state, s.description]),
    [
      ['pending', 'Review queued'],
      ['success', 'PASS — see the review comment'],
    ],
  );
  assert.ok(!('queuedNote' in f.record(1)));
  assert.ok(!('judge' in readHostFlag(f.flagFile)));
});

test('host: each unavailable pin leaves the review pending and retries it on a later poll', async (t) => {
  for (const item of unavailableCases) {
    const env = executors();
    item.apply?.(env);
    const { f, fake, statuses, comments } = await pinnedHost(t, item.pin, env);
    f.addPr(1);
    await f.poll();
    assert.equal(fake.dispatched.length, 0, item.name);
    assert.equal(f.record(1).outcome, undefined, item.name);
    assert.equal(f.record(1).phase, 'queued', item.name);
    assert.equal(comments().length, 0, item.name);
    assert.deepEqual(
      statuses(),
      [{ context: 'pugport/judge', state: 'pending', description: 'Review unavailable for now; it will be retried' }],
      item.name,
    );
    const status = await f.host.status();
    assert.equal(status.ready.toolless, false);
    assert.match(status.ready.problem ?? '', /^Pinned judge unavailable: /);
    assert.match(status.ready.problem ?? '', item.reason);
    // Another poll while still unavailable writes nothing new and still dispatches nothing.
    f.advance(120_000);
    await f.poll();
    assert.equal(fake.dispatched.length, 0, item.name);
    assert.equal(statuses().length, 1, item.name);
    // The card is back: the next poll says so on the PR and reviews on the pinned card.
    const fixed = executors();
    env.targets = fixed.targets;
    env.snapshots = fixed.snapshots;
    writeHostFlag(f.flagFile, { ...readHostFlag(f.flagFile), judge: freePin });
    f.advance(120_000);
    await f.poll();
    assert.equal(fake.dispatched.length, 1, item.name);
    assert.deepEqual(fake.dispatched[0]!.pin, { runtimeId: 'api-custom', model: 'local-coder' }, item.name);
    assert.equal(f.record(1).verdict, 'pass', item.name);
    assert.deepEqual(
      statuses().map((s) => [s.state, s.description]),
      [
        ['pending', 'Review unavailable for now; it will be retried'],
        ['pending', 'Review queued'],
        ['success', 'PASS — see the review comment'],
      ],
      item.name,
    );
    assert.equal((await f.host.status()).ready.problem, undefined, item.name);
  }
});

test('host: a pinned paid CLI without tool-less support never reviews, and nothing else does either', async (t) => {
  const { f, fake, statuses } = await pinnedHost(t, { executor: 'codex', model: 'codex-model' });
  f.addPr(1);
  await f.poll();
  assert.equal(fake.dispatched.length, 0);
  assert.equal(f.record(1).outcome, undefined);
  assert.deepEqual(
    statuses().map((s) => s.state),
    ['pending'],
  );
  assert.match((await f.host.status()).ready.problem ?? '', /Codex \(codex\) cannot run without tools/);
});

test('host: a pin that fails while material is collected, or during the run, gives no verdict and retries', async (t) => {
  const { f, fake, env, statuses, comments } = await pinnedHost(t, freePin);
  f.addPr(1);
  // The card stops being ready after the queue check, before dispatch.
  f.data.readWait = async (args) => {
    if (args[1]?.includes('/compare/')) card(env, 'api-custom').snapshot.status = 'refreshing';
  };
  await f.poll();
  f.data.readWait = undefined;
  assert.equal(fake.dispatched.length, 0);
  assert.equal(f.record(1).outcome, undefined);
  assert.equal(f.record(1).phase, 'queued');
  assert.equal(comments().length, 0);
  assert.ok(statuses().every((s) => s.state === 'pending'));
  const audit = f.audit.recent(20);
  assert.ok(audit.some((line) => line.number === 1 && line.action === 'skip'));
  // Back, but it goes away while the review runs.
  card(env, 'api-custom').snapshot.status = 'ready';
  fake.onResult(() => {
    card(env, 'api-custom').target.enabled = false;
    return { status: 'failed', error: 'synthetic: executor disabled' };
  });
  f.advance(120_000);
  await f.poll();
  assert.equal(fake.dispatched.length, 1);
  assert.equal(f.record(1).outcome, undefined);
  assert.equal(f.record(1).phase, 'queued');
  assert.equal(comments().length, 0);
  assert.ok(statuses().every((s) => s.state === 'pending'));
  // Restored: the next poll reviews it.
  fake.onResult(undefined);
  card(env, 'api-custom').target.enabled = true;
  f.advance(120_000);
  await f.poll();
  assert.equal(fake.dispatched.length, 2);
  assert.equal(f.record(1).verdict, 'pass');
});

test('host: the configured prompt budget reaches the judge', async (t) => {
  const { f, fake } = await pinnedHost(t, { ...freePin, maxPromptKB: 32 });
  f.addPr(1).diff = 'y'.repeat(40_000);
  await f.poll();
  assert.equal(fake.dispatched.length, 0);
  assert.equal(f.record(1).verdict, 'blocked');
  assert.match(f.record(1).outcome!.text, /prompt exceeds 32 kB/);
});

// --- External tasks: what a pinned dispatch asks routing for, and which executor actually runs.

function tasksFixture(t: TestContext) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'judge-pin-tasks-')));
  const previousMemory = process.env.COMBORUNNER_MEMORY_DIR;
  process.env.COMBORUNNER_MEMORY_DIR = join(directory, 'memory');
  const calls: ExecuteContext[] = [];
  const execute = async (context: ExecuteContext): Promise<ExecuteResult> => {
    calls.push(context);
    return { output: `${context.target.label} answer`, nativeSessionId: `session-${calls.length}` };
  };
  for (const adapter of [piAdapter, claudeAdapter, codexAdapter]) t.mock.method(adapter, 'execute', execute);
  const controller = new Controller(directory, join(directory, 'data'));
  clearInterval(controller.timer);
  controller.settings.decisionMode = 'auto';
  controller.agentBridgeUrl = 'http://127.0.0.1:0/mcp';
  const env = executors();
  controller.targets = env.targets;
  controller.snapshots = env.snapshots;
  t.mock.method(controller, 'refresh', async () => {});
  const workspace = new Workspace(controller, {
    autoTick: false,
    retrieveMemory: async () => ({ context: '', excerpts: [], paths: [], elapsedMs: 0 }),
  });
  t.after(async () => {
    await workspace.close();
    await controller.close();
    if (previousMemory === undefined) delete process.env.COMBORUNNER_MEMORY_DIR;
    else process.env.COMBORUNNER_MEMORY_DIR = previousMemory;
    const absolute = resolve(directory);
    assert.ok(absolute.startsWith(realpathSync.native(tmpdir()) + sep) && basename(absolute).startsWith('judge-pin-'));
    rmSync(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { controller, workspace, tasks: new ExternalTasks(workspace), calls };
}
async function finish(workspace: Workspace, id: string) {
  for (let i = 0; i < 1000; i++) {
    await workspace.tickQueue();
    const workflow = workspace.store.get<Workflow>('workflow', id)!;
    if (['completed', 'blocked', 'cancelled', 'failed'].includes(workflow.status)) return workflow;
    await new Promise((wait) => setTimeout(wait, 10));
  }
  throw new Error('fixture workflow did not finish');
}

test('external tasks: a pinned judge run asks for that card only and runs tool-less there', async (t) => {
  const f = tasksFixture(t);
  for (const pin of [freePin, customPin]) {
    const runner = externalNoToolsRunner(f.tasks, f.controller, 'GitHub maintenance', () => pin);
    const { taskId } = await runner.dispatch({
      prompt: 'Review this synthetic diff',
      title: 'GitHub maintenance · PR #1',
    });
    const workflow = f.workspace.store.get<Workflow>('workflow', taskId)!;
    assert.equal(workflow.input.runtimeId, pin.executor);
    assert.equal(workflow.input.model, pin.model);
    assert.equal(workflow.input.allowExecutorFallback, false);
    assert.equal(workflow.input.autoEscalate, false);
    assert.equal(workflow.input.untrustedContent, true);
    assert.equal(workflow.input.permissionMode, 'read-only');
    assert.equal(workflow.input.automaticExecutors, undefined);
    assert.equal((await finish(f.workspace, taskId)).status, 'completed');
    const call = f.calls.at(-1)!;
    assert.equal(call.target.id, pin.executor);
    assert.equal(call.route.model, pin.model);
    assert.equal(call.input.untrustedContent, true);
    assert.equal(call.input.permissionMode, 'read-only');
    assert.equal(call.agentBridge, undefined, 'no tools, no bridge');
  }
  assert.deepEqual(
    f.calls.map((call) => call.target.id),
    ['api-custom', 'api-custom-api'],
  );
});

test('external tasks: routing refuses a pinned card that cannot run tool-less instead of moving it', async (t) => {
  const f = tasksFixture(t);
  const created = await f.tasks.dispatch({
    task: 'Review this synthetic diff',
    caller: 'GitHub maintenance',
    readOnly: true,
    untrusted: true,
    pin: { runtimeId: 'codex', model: 'codex-model' },
  });
  const workflow = await finish(f.workspace, created.taskId);
  assert.notEqual(workflow.status, 'completed');
  assert.equal(f.calls.length, 0, 'neither Codex nor the ready Claude card ran it');
  await assert.rejects(
    f.tasks.dispatch({ task: 'x', untrusted: true, readOnly: true, pin: { runtimeId: 'api-removed', model: 'm' } }),
    /Pinned executor api-removed is not available/,
  );
  await assert.rejects(
    f.tasks.dispatch({
      task: 'x',
      untrusted: true,
      readOnly: true,
      agent: 'Claude',
      pin: { runtimeId: 'api-custom', model: 'local-coder' },
    }),
    /names only its executor and model/,
  );
});
