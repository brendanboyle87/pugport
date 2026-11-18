import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { grokAdapter } from '../src/server/adapters/grok.ts';
import { contentRelayModel, contentRelayStep } from '../src/server/content-refusal.ts';
import { route } from '../src/server/routing.ts';
import { candidateInputs } from '../src/server/routing-rules.ts';
import { contentRelayLimit } from '../src/server/content-refusal.ts';
import { modelDemand } from '../src/server/model-selection.ts';
import { cursorModelPool } from '../src/shared/cursor-models.ts';
import type {
  ExecuteContext,
  ExecuteResult,
  ModelInfo,
  RunInput,
  RunRecord,
  RuntimeSnapshot,
  RuntimeTarget,
  Settings,
  Workflow,
} from '../src/shared/types.ts';

// Synthetic catalogs and run records only; no executor or provider is contacted.

const refusal = "I can't help with sexually explicit content.";

function fixture() {
  const now = Date.now();
  const iso = (offset = 0) => new Date(now + offset).toISOString();
  const settings: Settings = {
    refreshSeconds: 60,
    reservePercent: 10,
    maxQuotaAgeSeconds: 180,
    preferCli: true,
    designProvider: 'claude',
    architectureProvider: 'codex',
    routineProvider: 'codex',
    defaultProjectPath: 'C:/synthetic',
    maxConcurrentRuns: 0,
    unknownQuotaPolicy: 'manual-only',
    toolApprovalMode: 'auto',
  };
  const card = (id: string, provider: RuntimeTarget['provider']): RuntimeTarget => ({
    id,
    provider,
    label: `${provider[0]!.toUpperCase()}${provider.slice(1)} A`,
    command: 'never-executed',
    environment: 'native',
    enabled: true,
  });
  const targets = [
    card('codex-a', 'codex'),
    card('claude-a', 'claude'),
    card('grok-a', 'grok'),
    card('cursor-a', 'cursor'),
  ];
  const window = (used: number, pool?: 'cursor' | 'other') => ({
    id: pool ?? 'week',
    label: pool ?? 'week',
    usedPercent: used,
    resetsAt: iso(86_400_000),
    ...(pool ? { modelPool: pool } : {}),
  });
  const snapshot = (target: RuntimeTarget, models: string[]): RuntimeSnapshot => ({
    id: target.id,
    provider: target.provider,
    label: target.label,
    environment: 'native',
    installed: true,
    status: 'ready',
    models: models.map((id) => ({
      id,
      label: id,
      efforts: ['low', 'medium', 'high'],
      ...(target.provider === 'cursor' ? { quotaPool: cursorModelPool(id) } : {}),
    })),
    quota: {
      status: 'known',
      source: 'synthetic',
      observedAt: iso(-1000),
      windows: target.provider === 'cursor' ? [window(20, 'cursor'), window(20, 'other')] : [window(20)],
    },
    capabilities: {
      execute: true,
      resume: true,
      cancel: true,
      approvals: false,
      ...(['claude', 'grok'].includes(target.provider) ? { toolless: true } : {}),
    },
    refreshedAt: iso(-1000),
  });
  const snapshots = [
    snapshot(targets[0]!, ['gpt-5.6-sol']),
    snapshot(targets[1]!, ['claude-opus-5']),
    snapshot(targets[2]!, ['grok-4.7']),
    snapshot(targets[3]!, ['composer-2.5', 'grok-4.7', 'claude-sonnet-5', 'glm-5.2', 'glm-5p3']),
  ];
  const input: RunInput = {
    prompt: 'Write the next chapter of the story.',
    userInput: 'Write the next chapter of the story.',
    projectPath: settings.defaultProjectPath,
    kind: 'general',
    workflowId: 'workflow',
    stepId: 'step',
    permissionMode: 'read-only',
    allowExecutorFallback: true,
  };
  const records = new Map<string, RunRecord>();
  let count = 0;
  /** A finished run on `runtimeId`; `from` makes it a content relay of that run. */
  const ran = (runtimeId: string, model: string, from?: RunRecord, output = refusal): RunRecord => {
    const run: RunRecord = {
      id: `run-${++count}`,
      prompt: input.prompt,
      projectPath: input.projectPath,
      kind: 'general',
      status: 'completed',
      route: { runtimeId, model, kind: 'general', reasons: [], warnings: [] },
      startedAt: iso(),
      endedAt: iso(),
      output,
      events: [],
      workflowId: input.workflowId,
      stepId: input.stepId,
      ...(from
        ? { relay: { fromRunId: from.id, fromRuntimeId: from.route.runtimeId, reason: 'content' as const } }
        : {}),
    };
    records.set(run.id, run);
    return run;
  };
  const controller = Object.assign(Object.create(Controller.prototype), {
    settings,
    targets,
    snapshots,
    active: new Map(),
    store: { run: (id: string) => records.get(id) },
    accountHealth: { apply: (value: RuntimeSnapshot) => value },
    freeHealth: { apply: (value: RuntimeSnapshot) => value },
    cooldown: { apply: (value: RuntimeSnapshot) => value },
  }) as Controller;
  const spend = (id: string, pool?: 'cursor' | 'other') => {
    const found = snapshots.find((value) => value.id === id)!;
    // These relay scenarios exhaust the pool; a near-reset remainder is still usable.
    found.quota.windows = found.quota.windows.map((value) =>
      !pool || value.modelPool === pool ? { ...value, usedPercent: 100 } : value,
    );
  };
  return { controller, input, settings, targets, snapshots, ran, spend };
}

const relayed = (value: ReturnType<Controller['contentRelay']>) => {
  assert.ok(value && 'input' in value, 'expected a relay');
  return value.input;
};
const stopped = (value: ReturnType<Controller['contentRelay']>) => {
  assert.ok(value && 'stopped' in value, 'expected the chain to stop');
  return value.stopped;
};

test('content relay keeps profile model exclusions when advancing outside a soft rule', () => {
  const f = fixture();
  f.input.routingRules = {
    version: 2,
    text: '',
    rules: [],
    unparsed: [],
    updatedAt: '',
    excludeModels: ['grok-*', 'glm-*'],
  };
  assert.equal(f.controller.contentRelay(f.input, f.ran('codex-a', 'gpt-5.6-sol')), undefined);
  f.input.routingRules.excludeModels = ['grok-*', 'glm-5p3'];
  const relay = relayed(f.controller.contentRelay(f.input, f.ran('codex-a', 'gpt-5.6-sol')));
  assert.equal(relay.model, 'glm-5.2');
  assert.deepEqual(relay.routingRules?.excludeModels, ['grok-*', 'glm-5p3']);
});

test('executor checklist: content relay respects the checklist despite its internal Grok/Cursor pins', () => {
  const f = fixture();
  const codex = f.ran('codex-a', 'gpt-5.6-sol');
  f.settings.excludedExecutors = ['claude-a', 'grok-a'];
  const relay = relayed(f.controller.contentRelay(f.input, codex));
  assert.equal(relay.provider, 'cursor');
  assert.equal(relay.automaticExecutorSelection, true);
  f.settings.excludedExecutors = ['claude-a', 'grok-a', 'cursor-a'];
  assert.equal(f.controller.contentRelay(f.input, codex), undefined);
});

test('a refusal goes to native Grok, then Grok through Cursor, and stops after two relays', () => {
  const f = fixture();
  const codex = f.ran('codex-a', 'gpt-5.6-sol');
  const first = relayed(f.controller.contentRelay(f.input, codex));
  assert.equal(first.provider, 'grok');
  assert.equal(first.runtimeId, undefined);
  assert.equal(first.model, undefined);
  assert.equal(first.relayReason, 'content');
  assert.equal(first.relayFromRunId, codex.id);
  assert.equal(first.allowExecutorFallback, false, 'a relay never wanders to an executor that declines the material');
  assert.equal(first.resumeRunId, undefined);
  assert.equal(first.prompt, f.input.prompt);

  const grok = f.ran('grok-a', 'grok-4.7', codex);
  const second = relayed(f.controller.contentRelay(first, grok));
  assert.deepEqual([second.provider, second.model, second.relayFromRunId], ['cursor', 'grok-4.7', grok.id]);

  // GLM is still available, but two relays is the limit for one message.
  const cursor = f.ran('cursor-a', 'grok-4.7', grok);
  assert.equal(
    stopped(f.controller.contentRelay(second, cursor)),
    '这条消息先后交给了 Codex A、Grok A、Cursor A 的 grok-4.7，都拒绝处理这类内容。已经停下，不再换别的执行器。',
  );
  // A relay that answered ends the chain quietly.
  assert.equal(f.controller.contentRelay(second, f.ran('cursor-a', 'grok-4.7', grok, 'Chapter two.')), undefined);
});

test('steps that cannot run now are skipped, and the chain only moves forward', () => {
  // Native Grok out of quota: Grok through Cursor, then GLM 5.3.
  const f = fixture();
  f.spend('grok-a');
  const claude = f.ran('claude-a', 'claude-opus-5');
  const first = relayed(f.controller.contentRelay(f.input, claude));
  assert.deepEqual([first.provider, first.model], ['cursor', 'grok-4.7']);
  const viaCursor = f.ran('cursor-a', 'grok-4.7', claude);
  const second = relayed(f.controller.contentRelay(first, viaCursor));
  assert.deepEqual([second.provider, second.model], ['cursor', 'glm-5p3']);

  // Cursor's own pool used up: from native Grok straight to GLM, which bills the frontier pool.
  const g = fixture();
  g.spend('cursor-a', 'cursor');
  const codex = g.ran('codex-a', 'gpt-5.6-sol');
  const grok = g.ran('grok-a', 'grok-4.7', codex);
  assert.equal(relayed(g.controller.contentRelay(g.input, grok)).model, 'glm-5p3');

  // A disabled native Grok is skipped too.
  const h = fixture();
  h.targets.find((target) => target.id === 'grok-a')!.enabled = false;
  assert.equal(relayed(h.controller.contentRelay(h.input, h.ran('codex-a', 'gpt-5.6-sol'))).model, 'grok-4.7');

  // After one relay with nothing left to try, the chain stops and says what was tried.
  const k = fixture();
  k.spend('cursor-a');
  const start = k.ran('codex-a', 'gpt-5.6-sol');
  assert.match(
    stopped(k.controller.contentRelay(k.input, k.ran('grok-a', 'grok-4.7', start))),
    /^这条消息先后交给了 Codex A、Grok A，都拒绝处理这类内容。/,
  );
  // With nothing able to take the first refusal, it simply stands.
  const m = fixture();
  m.spend('grok-a');
  m.spend('cursor-a');
  assert.equal(m.controller.contentRelay(m.input, m.ran('codex-a', 'gpt-5.6-sol')), undefined);
});

test('turning off the Cursor fallback, or a task with other people’s words, keeps the relay off Cursor', () => {
  const f = fixture();
  f.settings.cursorFallback = false;
  const codex = f.ran('codex-a', 'gpt-5.6-sol');
  assert.equal(relayed(f.controller.contentRelay(f.input, codex)).provider, 'grok');
  f.spend('grok-a');
  assert.equal(f.controller.contentRelay(f.input, codex), undefined);

  const g = fixture();
  const toolless = { ...g.input, untrustedContent: true };
  const claude = g.ran('claude-a', 'claude-opus-5');
  assert.equal(relayed(g.controller.contentRelay(toolless, claude)).provider, 'grok');
  assert.match(
    stopped(g.controller.contentRelay(toolless, g.ran('grok-a', 'grok-4.7', claude))),
    /Claude A、Grok A，都拒绝/,
    'Cursor cannot run tool-less, so it is never tried',
  );
  g.spend('grok-a');
  assert.equal(g.controller.contentRelay(toolless, claude), undefined);
});

test('minors, images, resumed sessions and refusals by other executors are never relayed', () => {
  const f = fixture();
  const codex = f.ran('codex-a', 'gpt-5.6-sol');
  assert.equal(f.controller.contentRelay({ ...f.input, prompt: 'A story about a minor.' }, codex), undefined);
  assert.equal(f.controller.contentRelay({ ...f.input, userInput: '写一个关于未成年人的故事' }, codex), undefined);
  // The refusal itself names minors.
  const minors = f.ran('codex-a', 'gpt-5.6-sol', undefined, "I can't write sexual content involving minors.");
  assert.equal(f.controller.contentRelay(f.input, minors), undefined);
  // An earlier refusal in the chain named minors: the chain ends there too.
  const earlier = f.ran('codex-a', 'gpt-5.6-sol', undefined, "I can't help with that; it involves children.");
  assert.equal(f.controller.contentRelay(f.input, f.ran('grok-a', 'grok-4.7', earlier)), undefined);
  const image = {
    ...f.input,
    attachments: [
      {
        id: 'image',
        name: 'fixture.png',
        kind: 'image' as const,
        path: 'never-read.png',
        mimeType: 'image/png',
        size: 1,
      },
    ],
  };
  assert.equal(f.controller.contentRelay(image, codex), undefined);
  assert.equal(f.controller.contentRelay({ ...f.input, resumeRunId: 'earlier-session' }, codex), undefined);
  // Grok refusing first, or an ordinary failure, is not a content relay.
  assert.equal(f.controller.contentRelay(f.input, f.ran('grok-a', 'grok-4.7')), undefined);
  assert.equal(
    f.controller.contentRelay(f.input, f.ran('codex-a', 'gpt-5.6-sol', undefined, 'Done: renamed three files.')),
    undefined,
  );
});

test('the Cursor relay models: the newest Grok in Cursor’s own pool, and GLM 5.3 before other GLMs', () => {
  const models = (ids: string[]): ModelInfo[] =>
    ids.map((id) => ({ id, label: id, efforts: [], quotaPool: cursorModelPool(id) }));
  const demand = modelDemand('balanced', false, false);
  const pick = (ids: string[], step: 'cursor-grok' | 'cursor-glm') => contentRelayModel(models(ids), step, demand)?.id;
  assert.equal(pick(['grok-4.6', 'grok-4.7', 'claude-sonnet-5'], 'cursor-grok'), 'grok-4.7');
  assert.equal(pick(['grok-5-preview', 'composer-2.5'], 'cursor-grok'), undefined, 'a Grok outside Cursor’s pool');
  assert.equal(pick(['glm-5.2', 'glm-5p3', 'glm-5p3-flash'], 'cursor-glm'), 'glm-5p3');
  assert.equal(pick(['glm-5p3-flash', 'glm-5.2', 'glm-4.5'], 'cursor-glm'), 'glm-5.2');
  assert.equal(pick(['glm-5p3-flash', 'claude-sonnet-5'], 'cursor-glm'), 'glm-5p3-flash');
  assert.equal(pick(['claude-sonnet-5'], 'cursor-glm'), undefined);
  assert.equal(contentRelayStep('grok', 'grok-4.7'), 'grok');
  assert.equal(contentRelayStep('cursor', 'grok-4.7-high'), 'cursor-grok');
  assert.equal(contentRelayStep('cursor', 'glm-5p3'), 'cursor-glm');
  assert.equal(contentRelayStep('cursor', 'composer-2.5'), undefined);
});

test('in a conversation, Grok answers what Codex refused; when Grok refuses too, a plain note says what was tried', async (t) => {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'content-relay-test-')));
  const previousMemory = process.env.COMBORUNNER_MEMORY_DIR;
  process.env.COMBORUNNER_MEMORY_DIR = join(directory, 'memory');
  const calls: string[] = [];
  let grokReply = 'Chapter two.';
  const execute =
    (reply: () => string) =>
    async (context: ExecuteContext): Promise<ExecuteResult> => {
      calls.push(context.target.provider);
      return { output: reply() };
    };
  t.mock.method(
    codexAdapter,
    'execute',
    execute(() => refusal),
  );
  t.mock.method(
    grokAdapter,
    'execute',
    execute(() => grokReply),
  );
  const controller = new Controller(directory, join(directory, 'data'), { readAccountIdentity: () => 'synthetic' });
  clearInterval(controller.timer);
  controller.settings.decisionMode = 'auto';
  const now = Date.now();
  const card = (id: string, provider: RuntimeTarget['provider']): RuntimeTarget => ({
    id,
    provider,
    label: id,
    command: 'unused',
    environment: 'native',
    enabled: true,
  });
  // Codex's window resets soon, so it takes the message first.
  const runtime = (id: string, provider: RuntimeSnapshot['provider'], resetMs: number): RuntimeSnapshot => ({
    id,
    provider,
    label: id,
    environment: 'native',
    installed: true,
    status: 'ready',
    models: [{ id: `${provider}-model`, label: 'Model', efforts: ['low', 'medium', 'high'] }],
    quota: {
      status: 'known',
      source: 'fixture',
      observedAt: new Date(now - 1000).toISOString(),
      windows: [{ id: 'week', label: 'week', usedPercent: 10, resetsAt: new Date(now + resetMs).toISOString() }],
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: new Date(now - 1000).toISOString(),
  });
  controller.targets = [card('codex-b', 'codex'), card('grok-b', 'grok')];
  controller.snapshots = [runtime('codex-b', 'codex', 1_800_000), runtime('grok-b', 'grok', 172_800_000)];
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
    assert.ok(
      absolute.startsWith(realpathSync.native(tmpdir()) + sep) && basename(absolute).startsWith('content-relay-'),
    );
    rmSync(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const finish = async (id: string) => {
    for (let i = 0; i < 1000; i++) {
      await workspace.tickQueue();
      const workflow = workspace.store.get<Workflow>('workflow', id)!;
      if (['completed', 'blocked', 'cancelled', 'failed'].includes(workflow.status)) return workflow;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    throw new Error('fixture workflow did not finish');
  };
  const folder = join(directory, 'repo');
  mkdirSync(folder);
  const project = await workspace.createProject(folder);
  const conversation = workspace.createConversation(project.id);
  const message = {
    content: 'Write the next chapter of the story.',
    mode: 'chat' as const,
    permissionMode: 'read-only' as const,
    executionPolicy: 'cli-first' as const,
  };
  const replies = () =>
    workspace.store
      .messages(conversation.id)
      .filter((value) => value.role === 'assistant' && !value.systemNotice)
      .map((value) => value.content);

  const first = await finish((await workspace.send(conversation.id, message)).workflow.id);
  assert.equal(first.status, 'completed');
  assert.deepEqual(calls, ['codex', 'grok']);
  assert.equal(controller.run(first.runIds.at(-1)!)?.relay?.reason, 'content');
  assert.deepEqual(replies(), ['Chapter two.']);

  grokReply = refusal;
  calls.length = 0;
  await finish((await workspace.send(conversation.id, message)).workflow.id);
  assert.deepEqual(calls, ['codex', 'grok'], 'each step once, and nothing else is set up');
  const notices = workspace.store.messages(conversation.id).filter((value) => value.systemNotice);
  assert.equal(notices.length, 3, 'one notice per handoff, plus the final stop');
  assert.equal(notices[0]!.systemNotice!.text, 'codex-b 拒绝处理这类内容，改由 Grok 接手。');
  assert.equal(notices[0]!.systemNotice!.details, refusal);
  assert.equal(
    notices.at(-1)!.systemNotice!.text,
    '这条消息先后交给了 codex-b、grok-b，都拒绝处理这类内容。已经停下，不再换别的执行器。',
  );
  assert.equal(notices.at(-1)!.systemNotice!.details, refusal);
  assert.equal(notices.at(-1)!.replyIdentity?.kind, 'system');
});

function ruleFixture(strict = true, providers: Array<'codex' | 'claude' | 'grok' | 'cursor'> = ['grok', 'cursor']) {
  const f = fixture();
  const rule = {
    id: 'story',
    category: 'writing',
    strict,
    enabled: true,
    source: 'manual' as const,
    candidates: providers.map((provider) => ({ provider, ...(provider === 'cursor' ? { model: 'glm-5p3' } : {}) })),
  };
  f.input.routingRules = { version: 2, text: '', rules: [rule], unparsed: [], updatedAt: '' };
  f.input.category = { id: 'writing', confidence: 'high', reason: 'fixture' };
  const runCandidate = (index: number, from?: RunRecord) => {
    const input = candidateInputs(rule, f.input)[index]!;
    const decision = route(input, f.snapshots, f.settings);
    const run = f.ran(decision.runtimeId, decision.model, from);
    run.route = decision;
    return run;
  };
  return { ...f, rule, runCandidate };
}

test('quota-ordered content relay can try an earlier original candidate once without looping', () => {
  const f = ruleFixture(true, ['claude', 'codex']);
  f.input.routingRules!.selection = 'quota';
  const first = f.runCandidate(1);
  const next = relayed(f.controller.contentRelay(f.input, first));
  assert.equal(next.routeRule?.index, 0);
  assert.equal(next.provider, 'claude');
  const second = f.runCandidate(0, first);
  assert.match(stopped(f.controller.contentRelay(next, second)), /均已拒绝|已经停下/);
});

test('a rule refusal starts on any executor, advances its saved index, and stops strictly', () => {
  const f = ruleFixture();
  const first = f.runCandidate(0);
  const handoff = f.controller.contentRelay(f.input, first);
  assert.ok(handoff && 'input' in handoff);
  assert.equal(handoff.input.routeRule?.index, 1);
  assert.equal(handoff.notice, 'Grok A 拒绝处理这类内容，改由 Cursor A · glm-5p3 接手。');
  const second = f.runCandidate(1, first);
  assert.equal(stopped(f.controller.contentRelay(handoff.input, second)), '规则只允许 Grok、Cursor·glm-5p3，均已拒绝');
});

test('non-strict exhaustion resumes the old chain without restarting the rule', () => {
  const f = ruleFixture(false, ['cursor']);
  // Legacy fallback starts at Grok, skipping executors already tried by the rule.
  assert.equal(relayed(f.controller.contentRelay(f.input, f.runCandidate(0))).provider, 'grok');
  const g = ruleFixture(false, ['claude']);
  const first = g.runCandidate(0);
  const relay = relayed(g.controller.contentRelay(g.input, first));
  assert.equal(relay.provider, 'grok');
  assert.equal(relay.routeRule, undefined);
  assert.equal(route(relay, g.snapshots, g.settings).runtimeId, 'grok-a');
  const grok = g.ran('grok-a', 'grok-4.7', first);
  assert.equal(relayed(g.controller.contentRelay(relay, grok)).model, 'grok-4.7');
});

test('rule relay uses the checklist, skips unavailable candidates, and preserves user pins', () => {
  const f = ruleFixture(true, ['codex', 'claude', 'cursor']);
  const first = f.runCandidate(0);
  f.settings.excludedExecutors = ['claude-a', 'grok-a'];
  const next = relayed(f.controller.contentRelay(f.input, first));
  assert.equal(next.routeRule?.index, 2);
  assert.equal(next.automaticExecutorSelection, true);
  for (const pin of [{ provider: 'codex' as const }, { runtimeId: 'codex-a' }, { model: 'gpt-5.6-sol' }])
    assert.equal(f.controller.contentRelay({ ...f.input, ...pin }, first), undefined);
  f.spend('cursor-a');
  assert.match(stopped(f.controller.contentRelay(f.input, first)), /^规则只允许/);
});

test('the rule relay cap is max(2, candidates), capped at four actual handoffs', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 8].map(contentRelayLimit), [2, 2, 2, 3, 4, 4]);
  const f = ruleFixture(false, ['codex', 'claude', 'codex', 'claude']);
  let previous = f.runCandidate(0);
  let input = f.input;
  for (let index = 1; index < 4; index++) {
    input = relayed(f.controller.contentRelay(input, previous));
    assert.equal(input.routeRule?.index, index);
    previous = f.runCandidate(index, previous);
  }
  input = relayed(f.controller.contentRelay(input, previous));
  assert.equal(input.provider, 'grok');
  previous = f.ran('grok-a', 'grok-4.7', previous);
  assert.match(stopped(f.controller.contentRelay(input, previous)), /已经停下/);
});
