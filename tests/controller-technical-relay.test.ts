import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/server/controller.ts';
import { route } from '../src/server/routing.ts';
import { handoffNoteIn } from '../src/shared/handoff-note.ts';
import { dataInputsBlock, relayPrompt } from '../src/server/handoff-note.ts';
import type { RunInput, RunRecord, RuntimeSnapshot, RuntimeTarget, Settings } from '../src/shared/types.ts';

function fixture() {
  const now = new Date().toISOString();
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
  const targets: RuntimeTarget[] = [
    {
      id: 'a',
      provider: 'grok',
      label: 'A',
      command: 'never-executed',
      environment: 'native',
      enabled: true,
      accountFingerprint: 'identity-a',
    },
    {
      id: 'alias-a',
      provider: 'grok',
      label: 'Alias A',
      command: 'never-executed',
      environment: 'native',
      enabled: true,
      accountFingerprint: 'identity-a',
    },
    {
      id: 'b',
      provider: 'grok',
      label: 'B',
      command: 'never-executed',
      environment: 'native',
      enabled: true,
      accountFingerprint: 'identity-b',
    },
    {
      id: 'c',
      provider: 'codex',
      label: 'C',
      command: 'never-executed',
      environment: 'native',
      enabled: true,
      accountFingerprint: 'identity-c',
    },
  ];
  const snapshots: RuntimeSnapshot[] = targets.map((target) => ({
    id: target.id,
    provider: target.provider,
    label: target.label,
    environment: 'native',
    accountFingerprint: target.accountFingerprint,
    installed: true,
    status: 'ready',
    models: [
      { id: target.provider === 'grok' ? 'grok-model' : 'codex-model', label: 'Synthetic model', efforts: ['medium'] },
    ],
    quota: { status: 'unknown', source: 'synthetic', observedAt: null, windows: [] },
    capabilities: { execute: true, resume: true, cancel: true, approvals: false, imageInput: true },
    refreshedAt: now,
  }));
  const input: RunInput = {
    prompt: 'Complete the entire synthetic task',
    continuationRunId: 'old-session',
    continuationPrompt: 'compact',
    continuationAlternates: [{ runId: 'older-session', runtimeId: 'c', prompt: 'compact-c' }],
    userInput: 'Original human request',
    projectPath: settings.defaultProjectPath,
    kind: 'general',
    workflowId: 'workflow',
    stepId: 'step',
    permissionMode: 'read-only',
    connectorRevision: 'revision',
    runtimeId: 'a',
    provider: 'grok',
    model: 'grok-model',
    effort: 'medium',
    allowExecutorFallback: true,
    allowUnknownQuota: true,
    executionPolicy: 'cli-only',
  };
  const previous: RunRecord = {
    id: 'previous',
    prompt: input.prompt,
    userInput: input.userInput,
    projectPath: input.projectPath,
    kind: 'general',
    status: 'failed',
    route: {
      runtimeId: 'a',
      model: 'grok-model',
      effort: 'medium',
      kind: 'general',
      accountFingerprint: 'identity-a',
      reasons: [],
      warnings: [],
    },
    startedAt: now,
    endedAt: now,
    output: 'Completed the first part.',
    errorCode: 'runtime-network-error',
    events: [],
    workflowId: input.workflowId,
    stepId: input.stepId,
    permissionMode: 'read-only',
    toolApprovalMode: 'auto',
    connectorRevision: input.connectorRevision,
    account: { id: 'a', label: 'A', provider: 'grok', fingerprint: 'identity-a' },
    steeringInputs: ['Use the accepted correction'],
    handoffCheckpoint: {
      version: 1,
      source: 'native-tool-results',
      safe: true,
      observedAt: now,
      completedToolIds: ['confirmed-tool'],
      unconfirmedTools: [],
    },
  };
  const records = new Map([[previous.id, previous]]);
  // Avoid construction/discovery altogether: these methods consume synthetic catalog and saved-record state only.
  const controller = Object.assign(Object.create(Controller.prototype), {
    settings,
    targets,
    snapshots,
    active: new Map(),
    store: { run: (id: string) => records.get(id) },
    accountHealth: { apply: (snapshot: RuntimeSnapshot) => snapshot },
    freeHealth: { apply: (snapshot: RuntimeSnapshot) => snapshot, failure: () => {}, clear: () => {} },
    cooldown: { apply: (snapshot: RuntimeSnapshot) => snapshot },
  }) as Controller;
  return { controller, input, previous, snapshots, targets, records };
}

function emptyGrokRequestFixture() {
  const f = fixture();
  f.input.permissionMode = 'workspace-write';
  f.previous.permissionMode = 'workspace-write';
  f.previous.output = '';
  f.previous.errorCode = 'runtime-request-failed';
  f.previous.error = 'runtime-request-failed';
  f.previous.handoffCheckpoint!.completedToolIds = [];
  const identity = { provider: 'grok', transport: 'acp', runtimeId: 'a', pid: 123 };
  const at = f.previous.startedAt;
  // The failure's nine-event shape: host configuration and a native session, no tool or model delta.
  f.previous.events = [
    { seq: 1, at, type: 'status', data: { source: 'pugport', kind: 'source' } },
    { seq: 2, at, type: 'status', data: { source: 'pugport', kind: 'configuration' } },
    { seq: 3, at, type: 'status', data: { source: 'native', kind: 'configuration' } },
    { seq: 4, at, type: 'status', data: { source: 'native', kind: 'process-start', detail: { ...identity } } },
    { seq: 5, at, type: 'session', data: { sessionId: 'synthetic-session' } },
    { seq: 6, at, type: 'status', data: { source: 'native', kind: 'permissions' } },
    { seq: 7, at, type: 'status', data: { source: 'native', kind: 'configuration' } },
    {
      seq: 8,
      at,
      type: 'status',
      data: { source: 'native', kind: 'process-exit', detail: { ...identity, exitCode: 1, signal: null } },
    },
    { seq: 9, at, type: 'error', text: 'runtime-request-failed' },
  ];
  return f;
}

test('executor checklist: technical relay cannot use an unchecked same-platform account', () => {
  const f = fixture();
  f.controller.settings.excludedExecutors = ['alias-a', 'b'];
  const relay = f.controller.technicalRelay(f.input, f.previous)!;
  assert.equal(relay.runtimeId, 'c');
  assert.equal(relay.automaticExecutorSelection, true);
  f.controller.settings.excludedExecutors = ['alias-a', 'b', 'c'];
  assert.equal(f.controller.technicalRelay(f.input, f.previous), undefined);
});

test('executor checklist: quota relay retains the hard filter after excluding the spent account and aliases', () => {
  const f = fixture();
  f.controller.settings.excludedExecutors = ['alias-a', 'b'];
  f.previous.errorCode = 'quota-or-rate-limit';
  const input = { ...f.input, runtimeId: undefined, provider: undefined, model: undefined, effort: undefined };
  const relay = f.controller.accountRelay(input, f.previous)!;
  assert.ok(relay);
  assert.equal(relay.relayReason, 'quota');
  assert.equal(route(relay, f.snapshots, f.controller.settings).runtimeId, 'c');
});

test("an empty timeout relay adds no note of its own and keeps an earlier relay's note", () => {
  for (const wrapped of [false, true]) {
    const f = fixture();
    f.previous.output = '';
    f.previous.events = [];
    f.previous.hadToolActivity = false;
    f.previous.errorCode = 'runtime-timeout';
    f.previous.steeringInputs = wrapped ? ['Synthetic accepted correction'] : [];
    f.previous.dataInputs = wrapped ? ['Synthetic peer data'] : [];
    if (wrapped) f.input.prompt = relayPrompt(f.input.prompt, 'Synthetic earlier note');
    const relay = f.controller.technicalRelay(f.input, f.previous)!;
    assert.ok(relay);
    const steering = wrapped ? '\n\n用户已接受的最新补充（优先于先前任务描述）：\nSynthetic accepted correction' : '';
    assert.equal(relay.prompt, f.input.prompt + steering + dataInputsBlock(f.previous.dataInputs));
    assert.doesNotMatch(relay.prompt, /read_run_detail/);
    if (wrapped) {
      // The earlier account's work is still described, so the next account does not redo it.
      assert.match(relay.prompt, /Synthetic earlier note/);
      assert.match(relay.prompt, /不重放已完成的写入/);
    } else assert.doesNotMatch(relay.prompt, /接续当前步骤|PUGPORT_HANDOFF_NOTE/);
    assert.equal(relay.relayReason, 'technical');
  }
});

test('technical relay prefers another account with the same model, retains all context, and excludes aliases', () => {
  const f = fixture();
  const relay = f.controller.technicalRelay(f.input, f.previous)!;
  assert.equal(relay.runtimeId, 'b');
  assert.equal(relay.model, 'grok-model');
  assert.equal(relay.relayReason, 'technical');
  assert.deepEqual(relay.excludeRuntimeIds, ['a', 'alias-a']);
  assert.equal(relay.resumeRunId, undefined);
  assert.equal(relay.continuationRunId, undefined);
  assert.equal(relay.continuationPrompt, undefined);
  assert.equal(relay.continuationAlternates, undefined);
  assert.equal(relay.userInput, 'Original human request');
  for (const text of [f.input.prompt, f.previous.output, 'Original human request', 'Use the accepted correction'])
    assert.ok(relay.prompt.includes(text));
  // A short handoff note replaces the raw native tool IDs, which mean nothing to the next model.
  assert.match(handoffNoteIn(relay.prompt) ?? '', /交接原因：技术输入通道或服务故障（runtime-network-error）/);
  assert.ok(!relay.prompt.includes('confirmed-tool'));
  assert.equal(relay.permissionMode, 'read-only');
  assert.equal(relay.connectorRevision, 'revision');
});

test('automatic technical, authentication and quota relays preserve task demand without inventing user pins', () => {
  for (const failure of ['runtime-network-error', 'authentication-required', 'quota-or-rate-limit'] as const) {
    const f = fixture();
    for (const snapshot of f.snapshots)
      snapshot.models = (
        snapshot.provider === 'codex' ? ['gpt-6-astra', 'gpt-6-sol'] : ['grok-4.7-heavy', 'grok-4.7']
      ).map((id) => ({ id, label: id, efforts: ['low', 'medium', 'high'] }));
    const input: RunInput = {
      ...f.input,
      prompt: 'Compare the two proposals',
      runtimeId: undefined,
      provider: undefined,
      model: undefined,
      effort: undefined,
      suggestedTier: 'strong',
      suggestedEffort: 'high',
    };
    f.previous.errorCode = failure;
    f.previous.route.model = 'grok-4.7-heavy';
    f.previous.route.effort = 'high';
    f.previous.output = '';
    Object.assign(f.controller, {
      tracksIdentity: () => true,
      accountIdentity: (target: RuntimeTarget) => target.accountFingerprint,
      nativeLoginPending: () => false,
    });
    const relay =
      failure === 'runtime-network-error'
        ? f.controller.technicalRelay(input, f.previous)
        : f.controller.accountRelay(input, f.previous);
    assert.ok(relay, failure);
    for (const key of ['runtimeId', 'provider', 'model', 'effort', 'relayPin', 'continuationRunId'] as const)
      assert.equal(relay[key], undefined, failure);
    assert.equal(relay.routingPrompt, input.prompt);
    const decision = route(relay, f.snapshots, f.controller.settings);
    assert.match(decision.model, /astra|heavy/);
    assert.equal(decision.effort, 'high');
    assert.doesNotMatch(decision.reasons.join('\n'), /用户(?:指定|锁定)/);
    const reassessed = route(
      { ...relay, suggestedTier: 'standard', suggestedEffort: 'medium' },
      f.snapshots,
      f.controller.settings,
    );
    assert.match(reassessed.model, /^(gpt-6-sol|grok-4\.7)$/);
    assert.equal(reassessed.effort, 'medium', 'a completed assessment can update automatic demand');
    if (failure === 'runtime-network-error') {
      const target = f.targets.find((item) => item.id === decision.runtimeId)!;
      const second: RunRecord = {
        ...f.previous,
        id: 'second',
        route: decision,
        account: {
          id: target.id,
          label: target.label,
          provider: target.provider,
          fingerprint: target.accountFingerprint!,
        },
        relay: { fromRunId: f.previous.id, fromRuntimeId: f.previous.route.runtimeId, reason: 'technical' },
      };
      f.records.set(second.id, second);
      const next = f.controller.technicalRelay(relay, second)!;
      assert.ok(next);
      assert.equal(next.relayPin, undefined);
      assert.equal(next.model, undefined);
      assert.equal(next.routingPrompt, input.prompt);
      const nextDecision = route(next, f.snapshots, f.controller.settings);
      assert.doesNotMatch(nextDecision.reasons.join('\n'), /用户(?:指定|锁定)/);
      assert.equal(nextDecision.effort, 'high');
    }
  }
});

test('technical relay falls to a verified image channel and never repeats accounts from an earlier relay', () => {
  const f = fixture();
  f.previous.errorCode = 'runtime-image-input-unavailable';
  f.input.attachments = [
    { id: 'synthetic', name: 'fixture.png', kind: 'image', path: 'never-read.png', mimeType: 'image/png', size: 1 },
  ];
  for (const snapshot of f.snapshots.filter((snapshot) => snapshot.provider === 'grok'))
    snapshot.capabilities.imageInput = false;
  f.previous.relay = { fromRunId: 'older', fromRuntimeId: 'b', reason: 'technical' };
  f.records.set('older', {
    ...f.previous,
    id: 'older',
    route: { ...f.previous.route, runtimeId: 'b', accountFingerprint: 'identity-b' },
    account: { id: 'b', label: 'B', provider: 'grok', fingerprint: 'identity-b' },
    relay: undefined,
  });
  const relay = f.controller.technicalRelay(f.input, f.previous)!;
  assert.equal(relay.runtimeId, 'c');
  assert.ok(relay.excludeRuntimeIds?.includes('b'));
  assert.deepEqual(relay.attachments, f.input.attachments);
});

test('billing-failed accounts and aliases stay excluded when no unused catalog remains, so the original 402 stands', () => {
  const f = fixture();
  f.snapshots.splice(2);
  f.previous.errorCode = 'quota-or-rate-limit';
  f.previous.events = [
    {
      at: f.previous.startedAt,
      type: 'status',
      data: { source: 'native', kind: 'billing-exhausted', billingSource: 'grok-build', detail: { statusCode: 402 } },
    },
  ];
  f.previous.relay = { fromRunId: 'older-quota', fromRuntimeId: 'alias-a', reason: 'quota' };
  f.records.set('older-quota', {
    ...f.previous,
    id: 'older-quota',
    route: { ...f.previous.route, runtimeId: 'alias-a' },
    events: [],
    relay: undefined,
  });
  // Both remaining catalogs are routable, so any relay would mean one of them was readmitted. With nothing
  // else able to take over, the failed run's own 402 message stays instead of "no executor available".
  assert.equal(f.controller.technicalRelay(f.input, f.previous), undefined);
  assert.equal(
    f.controller.accountRelay({ ...f.input, runtimeId: undefined, provider: undefined, model: undefined }, f.previous),
    undefined,
  );
  // A codex account that is only refreshing is a temporary wait: the relay still keeps both excluded.
  const waiting = { ...f.snapshots[0]!, id: 'c', provider: 'codex' as const, status: 'refreshing' as const };
  f.snapshots.push(waiting);
  const relay = f.controller.technicalRelay(f.input, f.previous)!;
  assert.equal(relay.runtimeId, undefined);
  assert.deepEqual(relay.excludeRuntimeIds, ['a', 'alias-a']);
  assert.deepEqual(relay.relayPin, { runtimeId: 'a', provider: 'grok' });
});

test('silent native Grok ACP nonzero exit can hand off without changing scope or pretending to know the cause', () => {
  const f = emptyGrokRequestFixture();
  const relay = f.controller.technicalRelay(f.input, f.previous)!;
  assert.ok(relay);
  assert.equal(relay.runtimeId, 'b');
  assert.equal(relay.provider, 'grok');
  assert.equal(relay.model, f.input.model);
  assert.equal(relay.effort, f.input.effort);
  assert.equal(relay.relayReason, 'technical');
  assert.equal(relay.relayFromRunId, f.previous.id);
  assert.deepEqual(relay.excludeRuntimeIds, ['a', 'alias-a']);
  assert.equal(relay.permissionMode, 'workspace-write');
  assert.equal(relay.projectPath, f.input.projectPath);
  assert.equal(relay.connectorRevision, f.input.connectorRevision);
  assert.equal(relay.userInput, f.input.userInput);
  assert.equal(relay.workflowId, f.input.workflowId);
  assert.equal(relay.stepId, f.input.stepId);
  assert.equal(relay.resumeRunId, undefined);
  assert.equal(relay.continuationRunId, undefined);
  assert.equal(relay.continuationPrompt, undefined);
  assert.equal(relay.continuationAlternates, undefined);
  assert.ok(relay.prompt.includes(f.input.prompt));
  assert.ok(relay.prompt.includes('Use the accepted correction'));
  assert.doesNotMatch(relay.prompt, /接续当前步骤|read_run_detail|原原因未报告/);
  assert.ok(!relay.prompt.includes('runtime-network-error'));
});

test('untyped Grok startup recovery requires complete matching ACP lifecycle evidence and no work or refusal', () => {
  type Fixture = ReturnType<typeof emptyGrokRequestFixture>;
  const cases: Array<{ name: string; change: (f: Fixture) => void }> = [
    {
      name: 'visible output',
      change: (f) => {
        f.previous.output = 'I started checking the files.';
      },
    },
    {
      name: 'reasoning already produced',
      change: (f) => {
        f.previous.reasoning = 'Planning work';
      },
    },
    {
      name: 'delta not reflected in output',
      change: (f) => {
        f.previous.events.push({ at: f.previous.startedAt, type: 'text', text: 'Checking' });
      },
    },
    {
      name: 'reasoning delta',
      change: (f) => {
        f.previous.events.push({ at: f.previous.startedAt, type: 'reasoning', text: 'Planning' });
      },
    },
    {
      name: 'read tool completed',
      change: (f) => {
        f.previous.events.push({
          at: f.previous.startedAt,
          type: 'tool',
          data: { id: 'read', status: 'completed', readOnly: true },
        });
      },
    },
    {
      name: 'trimmed tool history',
      change: (f) => {
        f.previous.hadToolActivity = true;
      },
    },
    {
      name: 'completed tool checkpoint',
      change: (f) => {
        f.previous.handoffCheckpoint!.completedToolIds.push('done');
      },
    },
    {
      name: 'approval',
      change: (f) => {
        f.previous.events.push({ at: f.previous.startedAt, type: 'approval', data: { tool: 'write' } });
      },
    },
    {
      name: 'native denial',
      change: (f) => {
        f.previous.events.push({ at: f.previous.startedAt, type: 'status', data: { executionBlocked: true } });
      },
    },
    {
      name: 'decision denial',
      change: (f) => {
        f.previous.events.push({ at: f.previous.startedAt, type: 'status', data: { decision: 'deny' } });
      },
    },
    {
      name: 'content refusal',
      change: (f) => {
        f.previous.error = 'content-policy refusal';
      },
    },
    {
      name: 'raw refusal detail behind the generic code',
      change: (f) => {
        f.previous.error = 'Request refused: policy involving minors';
      },
    },
    {
      name: 'another native error',
      change: (f) => {
        f.previous.events.push({
          at: f.previous.startedAt,
          type: 'error',
          text: 'runtime-permission-or-sandbox-error',
        });
      },
    },
    {
      name: 'unmapped native observation',
      change: (f) => {
        f.previous.events.push({
          at: f.previous.startedAt,
          type: 'status',
          data: { source: 'native', kind: 'protocol-unmapped' },
        });
      },
    },
    {
      name: 'unconfirmed write',
      change: (f) => {
        f.previous.handoffCheckpoint!.unconfirmedTools.push({ id: 'write', status: 'running' });
      },
    },
    {
      name: 'unsafe checkpoint',
      change: (f) => {
        f.previous.handoffCheckpoint!.safe = false;
      },
    },
    {
      name: 'missing archive events',
      change: (f) => {
        f.previous.auditEventsMissing = 1;
      },
    },
    {
      name: 'summary record',
      change: (f) => {
        f.previous.summary = true;
      },
    },
    {
      name: 'fallback opted out',
      change: (f) => {
        f.input.allowExecutorFallback = false;
      },
    },
    {
      name: 'confirmed native session',
      change: (f) => {
        f.input.confirmedRoute = { runtimeId: 'a', model: 'grok-model' };
      },
    },
    {
      name: 'explicit resume',
      change: (f) => {
        f.input.resumeRunId = 'synthetic-session';
      },
    },
    {
      name: 'scope changed',
      change: (f) => {
        f.input.projectPath = 'C:/other';
      },
    },
    {
      name: 'permissions changed',
      change: (f) => {
        f.input.permissionMode = 'read-only';
      },
    },
    {
      name: 'connectors changed',
      change: (f) => {
        f.input.connectorRevision = 'other';
      },
    },
    {
      name: 'source is Cursor',
      change: (f) => {
        f.targets[0].provider = 'cursor';
      },
    },
    {
      name: 'gateway source',
      change: (f) => {
        f.targets[0].gateway = 'api';
      },
    },
    {
      name: 'missing start',
      change: (f) => {
        f.previous.events.splice(3, 1);
      },
    },
    {
      name: 'missing exit',
      change: (f) => {
        f.previous.events.splice(7, 1);
      },
    },
    {
      name: 'exit precedes start',
      change: (f) => {
        [f.previous.events[3], f.previous.events[7]] = [f.previous.events[7], f.previous.events[3]];
      },
    },
    {
      name: 'second process',
      change: (f) => {
        f.previous.events.push(f.previous.events[3]);
      },
    },
    {
      name: 'untrusted lifecycle source',
      change: (f) => {
        f.previous.events[3].data!.source = 'model';
      },
    },
    {
      name: 'headless Grok transport',
      change: (f) => {
        (f.previous.events[7].data!.detail as Record<string, unknown>).transport = 'streaming-messages-json';
      },
    },
    {
      name: 'runtime identity changed',
      change: (f) => {
        (f.previous.events[7].data!.detail as Record<string, unknown>).runtimeId = 'b';
      },
    },
    {
      name: 'different process',
      change: (f) => {
        (f.previous.events[7].data!.detail as Record<string, unknown>).pid = 999;
      },
    },
    {
      name: 'successful empty process',
      change: (f) => {
        (f.previous.events[7].data!.detail as Record<string, unknown>).exitCode = 0;
      },
    },
    {
      name: 'null exit',
      change: (f) => {
        (f.previous.events[7].data!.detail as Record<string, unknown>).exitCode = null;
      },
    },
    {
      name: 'missing exit code',
      change: (f) => {
        delete (f.previous.events[7].data!.detail as Record<string, unknown>).exitCode;
      },
    },
    {
      name: 'untyped exit code',
      change: (f) => {
        (f.previous.events[7].data!.detail as Record<string, unknown>).exitCode = '1';
      },
    },
    {
      name: 'signal cancellation',
      change: (f) => {
        (f.previous.events[7].data!.detail as Record<string, unknown>).signal = 'SIGTERM';
      },
    },
  ];
  for (const { name, change } of cases) {
    const f = emptyGrokRequestFixture();
    change(f);
    assert.equal(f.controller.technicalRelay(f.input, f.previous), undefined, name);
  }
});

test('technical relay rejects unsafe checkpoints, altered scope, confirmed sessions and untyped failures after progress', () => {
  for (const errorCode of [
    'runtime-request-failed',
    'runtime-permission-or-sandbox-error',
    'operation-cancelled',
    'content-policy',
    'runtime-image-input-invalid',
  ]) {
    const f = fixture();
    f.previous.errorCode = errorCode;
    assert.equal(f.controller.technicalRelay(f.input, f.previous), undefined, errorCode);
  }
  for (const change of [
    { allowExecutorFallback: false },
    { confirmedRoute: { runtimeId: 'a', model: 'grok-model' } },
    { resumeRunId: 'old-session' },
    { connectorRevision: 'changed' },
    { permissionMode: 'workspace-write' as const },
    { workflowId: 'other-workflow' },
    { stepId: 'other-step' },
  ]) {
    const f = fixture();
    assert.equal(f.controller.technicalRelay({ ...f.input, ...change }, f.previous), undefined);
  }
  const f = fixture();
  f.previous.handoffCheckpoint!.unconfirmedTools.push({ id: 'uncertain', status: 'running' });
  assert.equal(f.controller.technicalRelay(f.input, f.previous), undefined);
  const blocked = fixture();
  blocked.previous.events.push({
    at: new Date().toISOString(),
    type: 'status',
    data: { executionBlocked: true, reason: 'permission' },
  });
  assert.equal(blocked.controller.technicalRelay(blocked.input, blocked.previous), undefined);
  const policy = fixture();
  policy.previous.output = 'I cannot help create this content because of our content policy.';
  assert.equal(policy.controller.technicalRelay(policy.input, policy.previous), undefined);
});

test('unclassified native causes block technical and automatic account relay even behind typed auth or quota codes', () => {
  for (const errorCode of ['runtime-request-failed', 'authentication-required', 'quota-or-rate-limit']) {
    const f = emptyGrokRequestFixture();
    f.previous.errorCode = errorCode;
    f.previous.error = errorCode;
    // A full persisted event is authoritative even if the caller holds a bounded copy.
    f.previous.events.push({
      at: f.previous.startedAt,
      type: 'status',
      data: { source: 'native', kind: 'protocol-unmapped', relayBlocked: true },
    });
    const bounded = { ...f.previous, events: [] };
    assert.equal(f.controller.technicalRelay(f.input, bounded), undefined, errorCode);
    assert.equal(f.controller.accountRelay({ ...f.input, runtimeId: undefined }, bounded), undefined, errorCode);
  }
});

test('human selection creates a fresh session with the checkpoint but cannot cross scope or unconfirmed tools', () => {
  const f = fixture();
  f.previous.status = 'cancelled';
  f.previous.errorCode = 'operation-cancelled';
  const relay = f.controller.selectionRelay(
    { ...f.input, confirmedRoute: { runtimeId: 'a', model: 'grok-model' }, resumeRunId: 'old-session' },
    f.previous,
    { runtimeId: 'c', provider: 'codex', model: 'codex-model' },
  )!;
  assert.equal(relay.runtimeId, 'c');
  assert.equal(relay.relayReason, 'selection');
  assert.equal(relay.confirmedRoute, undefined);
  assert.equal(relay.resumeRunId, undefined);
  assert.equal(relay.excludeRuntimeIds, undefined);
  assert.match(handoffNoteIn(relay.prompt) ?? '', /交接原因：用户已选择新的执行器/);
  assert.ok(!relay.prompt.includes('confirmed-tool'));
  assert.equal(
    f.controller.selectionRelay({ ...f.input, connectorRevision: 'changed' }, f.previous, { runtimeId: 'c' }),
    undefined,
  );
  f.previous.handoffCheckpoint!.safe = false;
  assert.equal(f.controller.selectionRelay(f.input, f.previous, { runtimeId: 'c' }), undefined);
});

test('unavailable native sessions never qualify for technical relay', () => {
  const f = fixture();
  f.previous.errorCode = 'native-session-unavailable';
  f.previous.output = '';
  assert.equal(f.controller.technicalRelay(f.input, f.previous), undefined);
});

test('quota, authentication and selection relays clear every continuation candidate', () => {
  for (const errorCode of ['quota-or-rate-limit', 'authentication-required']) {
    const f = fixture();
    f.previous.errorCode = errorCode;
    f.previous.output = '';
    Object.assign(f.controller, {
      tracksIdentity: () => true,
      accountIdentity: (target: RuntimeTarget) => target.accountFingerprint,
      nativeLoginPending: () => false,
    });
    const next = f.controller.accountRelay(
      { ...f.input, runtimeId: undefined, provider: undefined, model: undefined },
      f.previous,
    )!;
    assert.ok(next, errorCode);
    assert.equal(next.continuationRunId, undefined);
    assert.equal(next.continuationPrompt, undefined);
    assert.equal(next.continuationAlternates, undefined);
  }
  const f = fixture();
  const selected = f.controller.selectionRelay(f.input, f.previous, { runtimeId: 'c' })!;
  assert.ok(selected);
  assert.equal(selected.continuationAlternates, undefined);
});

test('a step that only preferred API cards relays to the normal pool after its executor fails', () => {
  const f = fixture();
  const input = {
    ...f.input,
    runtimeId: undefined,
    provider: undefined,
    model: undefined,
    effort: undefined,
    executionPolicy: 'api-only' as const,
    stepTransport: 'api' as const,
  };
  const technical = f.controller.technicalRelay(input, f.previous);
  assert.ok(technical);
  assert.equal(technical.executionPolicy, 'cli-first');
  assert.equal(technical.stepTransport, undefined);
  f.previous.errorCode = 'quota-or-rate-limit';
  const quota = f.controller.accountRelay(input, f.previous);
  assert.ok(quota);
  assert.equal(quota.executionPolicy, 'cli-first');
});

for (const label of ['Synthetic API credit', 'Newly added Aurora card']) {
  test(`command denial routes ${label} with context and preserves pins`, () => {
    const f = fixture();
    f.targets[0]!.label = label;
    f.targets[0]!.gateway = 'api';
    f.snapshots[0]!.gateway = 'api';
    f.input = {
      ...f.input,
      runtimeId: undefined,
      provider: undefined,
      model: undefined,
      permissionMode: 'workspace-write',
      executionPolicy: undefined,
      automaticExecutorSelection: true,
    };
    f.previous.status = 'completed';
    f.previous.errorCode = undefined;
    f.previous.permissionMode = 'workspace-write';
    const relay = f.controller.commandDeniedRelay(f.input, f.previous, true);
    assert.ok(relay.input);
    assert.notEqual(relay.input.runtimeId, 'a');
    assert.equal(relay.input.needsLocalPrograms, true);
    assert.equal(relay.input.workflowId, f.input.workflowId);
    assert.match(relay.notice, /Pi 在这里不能跑命令，已转交给/);
    Object.assign(f.controller, { commandRelays: new Map([[f.previous.id, relay.input]]) });
    const next = f.controller.takeCommandRelay(f.previous)!;
    assert.ok(next.prompt.includes('Original human request'));
    assert.ok(next.prompt.includes('Use the accepted correction'));
    assert.equal(next.relayFromRunId, f.previous.id);
    assert.equal(f.controller.takeCommandRelay(f.previous), undefined);
    const pinned = f.controller.commandDeniedRelay(
      { ...f.input, runtimeId: 'a', automaticExecutorSelection: false },
      f.previous,
      true,
    );
    assert.equal(pinned.input, undefined);
    assert.match(pinned.notice, /已固定执行器/);
    f.snapshots.splice(1);
    const unavailable = f.controller.commandDeniedRelay(f.input, f.previous, true);
    assert.equal(unavailable.input, undefined);
    assert.match(unavailable.notice, /没有可用的命令执行器/);
  });
}
