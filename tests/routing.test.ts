import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { AccountHealth } from '../src/server/account-health.ts';
import { providerSpecs, type ProviderSpec } from '../src/shared/provider-registry.ts';
import { TASK_JUDGMENT_CONTRACT_VERSION, type TaskJudgment } from '../src/shared/task-judgment.ts';
import { estimateTaskMinutes, quotaPoolKey, route, RouteUnavailableError } from '../src/server/routing.ts';
import type { QuotaWindow, RunInput, RuntimeSnapshot, Settings } from '../src/shared/types.ts';

const timestamp = Date.parse('2026-09-26T12:00:00.000Z');
const iso = (offset = 0) => new Date(timestamp + offset).toISOString();
const settings: Settings = {
  routePreferencesEnabled: true,
  refreshSeconds: 60,
  reservePercent: 10,
  maxQuotaAgeSeconds: 180,
  preferCli: true,
  designProvider: 'claude',
  architectureProvider: 'codex',
  routineProvider: 'codex',
  unknownQuotaPolicy: 'manual-only',
  defaultProjectPath: 'C:/projects/example',
  maxConcurrentRuns: 2,
};
const input: RunInput = { prompt: 'Implement a parser', projectPath: settings.defaultProjectPath, kind: 'general' };
const window = (id: string, usedPercent: number | null, resetsAt = iso(60_000)): QuotaWindow => ({
  id,
  label: id,
  usedPercent,
  resetsAt,
});

function snapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    id: 'codex-native',
    provider: 'codex',
    label: 'Codex native',
    environment: 'native',
    installed: true,
    status: 'ready',
    models: [
      { id: 'gpt-6-sol', label: 'Sol', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
      { id: 'gpt-6-luna', label: 'Luna', efforts: ['low', 'medium', 'high'], lightweight: true },
    ],
    quota: {
      status: 'known',
      source: 'mock protocol',
      observedAt: iso(-1000),
      windows: [window('five-hour', 20), window('weekly', 40)],
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: iso(-1000),
    ...overrides,
  };
}

test('a per-task ask override allows approval-only models without changing global routing', () => {
  const target = snapshot({ models: [{ id: 'no-auto', label: 'No auto', efforts: [], noAutoApproval: true }] });
  const pinned = { ...input, runtimeId: target.id, model: 'no-auto' };
  const global = { ...settings, toolApprovalMode: 'auto' as const };
  assert.throws(() => route(pinned, [target], global, new Set(), timestamp), /不支持自动执行/);
  assert.equal(route({ ...pinned, toolApprovalMode: 'ask' }, [target], global, new Set(), timestamp).model, 'no-auto');
  assert.equal(global.toolApprovalMode, 'auto');
  assert.throws(() => route(pinned, [target], global, new Set(), timestamp), /不支持自动执行/);
});

function withQuota(patch: Partial<RuntimeSnapshot['quota']>): RuntimeSnapshot {
  const value = snapshot();
  value.quota = { ...value.quota, ...patch };
  return value;
}

const choose = (value: RuntimeSnapshot, changes: Partial<RunInput> = {}, config = settings) =>
  route({ ...input, ...changes }, [value], config, new Set(), timestamp);

test('saved Gemini CLI snapshots never route automatically or from a saved selection', () => {
  const legacy = snapshot({ id: 'gemini-native', provider: 'gemini' });
  const available = snapshot();
  assert.equal(route(input, [legacy, available], settings, new Set(), timestamp).runtimeId, available.id);
  for (const pin of [{}, { runtimeId: legacy.id }, { provider: 'gemini' as const }])
    assert.throws(() => route({ ...input, ...pin }, [legacy], settings, new Set(), timestamp), RouteUnavailableError);
});

test('self-contained greetings and literal replies use light routing without overriding user selections', () => {
  for (const prompt of [
    '你好！',
    '你好，请只回复一句简短的问候。不调用工具，不读取文件。',
    '再只回复两个字：收到。不调用工具，不读取文件。',
  ]) {
    const decision = choose(snapshot(), { prompt, kind: 'auto' });
    assert.equal(decision.kind, 'routine', prompt);
    assert.equal(decision.model, 'gpt-6-luna', prompt);
    assert.equal(decision.effort, 'low', prompt);
    const pinned = choose(snapshot(), {
      prompt,
      kind: 'auto',
      runtimeId: 'codex-native',
      model: 'gpt-6-sol',
      effort: 'high',
    });
    assert.equal(pinned.model, 'gpt-6-sol');
    assert.equal(pinned.effort, 'high');
    const quality = choose(snapshot(), { prompt, kind: 'auto' }, { ...settings, routeGoal: 'quality' });
    assert.equal(quality.model, 'gpt-6-sol');
    assert.notEqual(quality.effort, 'low');
  }
  const complex = choose(snapshot(), { prompt: '你好，检查认证逻辑是否存在并发安全漏洞。', kind: 'auto' });
  assert.equal(complex.kind, 'architecture');
  assert.notEqual(complex.effort, 'low');
});

test('compound security requests keep complex routing instead of the file-lookup shortcut', () => {
  for (const prompt of [
    'Read docs/security.md and explain how authentication can fail under concurrent requests.',
    'Find config.json and patch its security settings.',
    'Read docs/security.md and audit authentication.',
  ]) {
    const decision = choose(snapshot(), { prompt, kind: 'auto' });
    assert.equal(decision.kind, 'architecture', prompt);
    assert.equal(decision.model, 'gpt-6-sol', prompt);
    assert.notEqual(decision.effort, 'low', prompt);
  }
});

test('complete concept explanations use general routing while implementation and compound requests stay complex', () => {
  for (const prompt of [
    '解释并发',
    '解释一下并发是什么意思',
    '请简单解释一下并发的概念。',
    '什么是认证？',
    '安全是什么意思？',
    'Explain concurrency.',
    'Please explain authentication in simple terms.',
    'What is software architecture?',
    'Define refactoring.',
  ]) {
    const decision = choose(snapshot(), { prompt, kind: 'auto' });
    assert.equal(decision.kind, 'general', prompt);
    assert.equal(decision.effort, 'medium', prompt);
    const pinned = choose(snapshot(), { prompt, kind: 'auto', model: 'gpt-6-luna', effort: 'high' });
    assert.equal(pinned.model, 'gpt-6-luna', prompt);
    assert.equal(pinned.effort, 'high', prompt);
  }
  for (const prompt of [
    '解释并发并修复支付服务。',
    '解释并发\n检查认证漏洞',
    '简单解释我们系统的并发安全设计',
    'Explain concurrency in our payment service and fix its races.',
    'Explain authentication vulnerabilities in this code.',
    'Design a concurrent database migration.',
  ]) {
    const decision = choose(snapshot(), { prompt, kind: 'auto' });
    assert.equal(decision.kind, 'architecture', prompt);
    assert.equal(decision.effort, 'high', prompt);
  }
});

test('concept explanations respect accepted judgment strength and keep resource guards', () => {
  const judgment: TaskJudgment = {
    contractVersion: TASK_JUDGMENT_CONTRACT_VERSION,
    inputHash: 'synthetic-concept',
    status: 'accepted',
    source: 'jev',
    intent: 'question',
    kind: 'general',
    complexity: 'simple',
    confidence: { intent: null, kind: null, complexity: null },
    observedAt: iso(),
    latencyMs: 0,
    reason: 'accepted',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: null },
    requestAttempted: true,
  };
  const request = { prompt: 'Explain concurrency.', kind: 'auto' as const, taskJudgment: judgment };
  const simple = choose(snapshot(), request);
  assert.equal(simple.kind, 'general');
  assert.equal(simple.model, 'gpt-6-luna');
  assert.equal(simple.effort, 'low');
  const complex = choose(snapshot(), { ...request, taskJudgment: { ...judgment, complexity: 'complex' } });
  assert.equal(complex.kind, 'general');
  assert.equal(complex.model, 'gpt-6-sol');
  assert.equal(complex.effort, 'high');
  const architecture = choose(snapshot(), { ...request, taskJudgment: { ...judgment, kind: 'architecture' } });
  assert.equal(architecture.kind, 'architecture');
  assert.equal(architecture.effort, 'high');
  assert.throws(
    () => choose(withQuota({ windows: [window('weekly', 100)] }), request),
    (error: unknown) => error instanceof RouteUnavailableError && error.kind === 'quota',
  );
  assert.throws(
    () => choose(withQuota({ observedAt: iso(-1_000_000) }), request),
    (error: unknown) => error instanceof RouteUnavailableError && error.kind === 'refresh',
  );
});

test('executor checklist: hard filter applies before scoring, planners, members and internally pinned relays', () => {
  const codex = snapshot();
  const claude = snapshot({ id: 'claude', provider: 'claude', label: 'Claude' });
  const config = { ...settings, designProvider: 'claude' as const, excludedExecutors: [claude.id] };
  const requests: Partial<RunInput>[] = [
    { kind: 'design' },
    { coordinator: true, swarm: true },
    { agentChild: true, readOnlyMember: true },
    { relayReason: 'quota' },
    { relayReason: 'technical' },
    { relayReason: 'content' },
    { automaticExecutorSelection: true, runtimeId: codex.id },
  ];
  for (const request of requests) {
    const decision = route({ ...input, ...request }, [claude, codex], config, new Set(), timestamp);
    assert.equal(decision.runtimeId, codex.id);
    assert.ok(decision.reasons.includes('已按勾选排除：Claude'));
  }
  // Internal relay pins must never gain the explicit user's exemption.
  for (const relayReason of ['quota', 'technical', 'content'] as const)
    assert.throws(
      () => route({ ...input, runtimeId: claude.id, relayReason }, [claude, codex], config, new Set(), timestamp),
      /已按勾选排除：Claude/,
    );
  const exhausted = { ...codex, quota: { ...codex.quota, windows: [window('weekly', 100)] } };
  assert.throws(
    () => route(input, [claude, exhausted], config, new Set(), timestamp),
    (error: unknown) => {
      assert.ok(error instanceof RouteUnavailableError);
      assert.equal(error.kind, 'quota');
      assert.match(error.message, /已按勾选排除：Claude/);
      return true;
    },
  );
});

test('executor checklist: explicit pins win and per-task/conversation checklists override global', () => {
  const claude = snapshot({ id: 'claude', provider: 'claude', label: 'Claude' });
  const config = { ...settings, excludedExecutors: ['claude'] };
  for (const pin of [{ runtimeId: 'claude' }, { provider: 'claude' as const }])
    assert.equal(route({ ...input, ...pin }, [snapshot(), claude], config, new Set(), timestamp).runtimeId, 'claude');
  assert.equal(
    route({ ...input, automaticExecutors: ['claude'] }, [snapshot(), claude], config, new Set(), timestamp).runtimeId,
    'claude',
  );
  assert.throws(
    () =>
      route(
        { ...input, runtimeId: 'claude', automaticExecutorSelection: true },
        [snapshot(), claude],
        config,
        new Set(),
        timestamp,
      ),
    /已按勾选排除/,
  );
});

test('a flexible executor preference stays selected while its image channel is usable', () => {
  const preferred = snapshot({ id: 'preferred' });
  const selected = route(
    { ...input, runtimeId: preferred.id, model: 'gpt-6-sol', effort: 'low', allowExecutorFallback: true },
    [snapshot(), preferred],
    settings,
    new Set(),
    timestamp,
  );
  assert.equal(selected.runtimeId, preferred.id);
  assert.equal(selected.effort, 'low');
});

test('an unverified Grok image channel falls through unsupported accounts to a real image channel', () => {
  const grok = snapshot({
    id: 'grok-b',
    provider: 'grok',
    capabilities: { execute: true, resume: true, cancel: true, approvals: false },
  });
  const otherGrok = { ...grok, id: 'grok-c' };
  const request: RunInput = {
    ...input,
    runtimeId: grok.id,
    provider: 'grok',
    model: 'grok-4.7',
    effort: 'ultra',
    allowExecutorFallback: true,
    attachments: [
      { id: 'synthetic', name: 'fixture.png', mimeType: 'image/png', size: 1, kind: 'image', path: 'never-read.png' },
    ],
  };
  const selected = route(request, [grok, otherGrok, snapshot()], settings, new Set(), timestamp);
  assert.equal(selected.runtimeId, 'codex-native');
  assert.ok(selected.reasons.some((reason) => reason.includes('已自动切换')));
  assert.throws(
    () => route({ ...request, allowExecutorFallback: false }, [grok, snapshot()], settings, new Set(), timestamp),
    /不会自动替换/,
  );
});

test('flexible preferences try another account on the same platform before the general pool', () => {
  const first = snapshot({ id: 'first', status: 'auth-required' });
  const second = snapshot({ id: 'second' });
  const other = snapshot({ id: 'claude', provider: 'claude' });
  assert.equal(
    route(
      { ...input, runtimeId: first.id, allowExecutorFallback: true },
      [first, other, second],
      settings,
      new Set(),
      timestamp,
    ).runtimeId,
    second.id,
  );
  assert.equal(
    route(
      { ...input, runtimeId: second.id, model: 'missing-model', allowExecutorFallback: true },
      [other, second],
      settings,
      new Set(),
      timestamp,
    ).runtimeId,
    second.id,
  );
});

test('when every flexible image candidate fails the remaining quota classification still waits', () => {
  const grok = snapshot({
    id: 'grok-b',
    provider: 'grok',
    capabilities: { execute: true, resume: true, cancel: true, approvals: false },
  });
  const exhausted = withQuota({ windows: [window('week', 100)] });
  const request: RunInput = {
    ...input,
    runtimeId: grok.id,
    allowExecutorFallback: true,
    attachments: [
      { id: 'synthetic', name: 'fixture.png', mimeType: 'image/png', size: 1, kind: 'image', path: 'never-read.png' },
    ],
  };
  const failure = unavailableError(() => route(request, [grok, exhausted], settings, new Set(), timestamp));
  assert.equal(failure.kind, 'quota');
  assert.equal(failure.retryAt, iso(60_000));
  assert.equal(unavailableError(() => route(request, [grok], settings, new Set(), timestamp)).kind, 'unavailable');
});

test('confirmed routes, resumed sessions, policy blocks and excluded providers never widen a preference', () => {
  const unsupported = snapshot({
    id: 'preferred',
    capabilities: { execute: true, resume: true, cancel: true, approvals: true, imageInput: false },
  });
  const visual: RunInput = {
    ...input,
    runtimeId: unsupported.id,
    allowExecutorFallback: true,
    attachments: [
      { id: 'synthetic', name: 'fixture.png', mimeType: 'image/png', size: 1, kind: 'image', path: 'never-read.png' },
    ],
  };
  for (const changes of [
    { resumeRunId: 'existing-run' },
    { confirmedRoute: { runtimeId: unsupported.id, model: 'gpt-6-sol' } },
  ])
    assert.throws(
      () => route({ ...visual, ...changes }, [unsupported, snapshot()], settings, new Set(), timestamp),
      /不会自动替换/,
    );
  assert.throws(
    () => route({ ...visual, executionPolicy: 'api-only' }, [unsupported, snapshot()], settings, new Set(), timestamp),
    RouteUnavailableError,
  );
  assert.throws(
    () => route({ ...visual, excludeProviders: ['codex'] }, [unsupported, snapshot()], settings, new Set(), timestamp),
    RouteUnavailableError,
  );
  const blocked = snapshot({
    id: 'blocked',
    models: [{ id: 'no-auto', label: 'No auto', efforts: [], noAutoApproval: true }],
  });
  assert.throws(
    () =>
      route(
        { ...input, runtimeId: blocked.id, model: 'no-auto', allowExecutorFallback: true },
        [blocked, snapshot()],
        settings,
        new Set(),
        timestamp,
      ),
    /不支持自动执行/,
  );
  const removed = snapshot({ id: 'pi-magpie', provider: 'pi', gateway: 'magpie' });
  assert.throws(
    () =>
      route(
        { ...visual, runtimeId: blocked.id, model: 'no-auto' },
        [{ ...blocked, capabilities: { ...blocked.capabilities, imageInput: false } }, snapshot()],
        settings,
        new Set(),
        timestamp,
      ),
    /不会自动替换/,
  );
  assert.throws(
    () =>
      route(
        { ...input, runtimeId: removed.id, allowExecutorFallback: true },
        [removed, snapshot()],
        settings,
        new Set(),
        timestamp,
      ),
    /已移除/,
  );
  assert.throws(
    () =>
      route(
        { ...input, runtimeId: 'absent-disabled-target', allowExecutorFallback: true },
        [snapshot()],
        settings,
        new Set(),
        timestamp,
      ),
    RouteUnavailableError,
  );
});

test('verified image channels retain account and model pins without bypassing resource protections', () => {
  const grok = snapshot({
    id: 'grok-b',
    provider: 'grok',
    label: 'Grok B',
    models: [{ id: 'grok-4.7', label: 'Grok 4.7', efforts: ['low', 'medium', 'high'] }],
    capabilities: { execute: true, resume: true, cancel: true, approvals: false, imageInput: true },
  });
  const visual: RunInput = {
    ...input,
    runtimeId: grok.id,
    model: 'grok-4.7',
    effort: 'low',
    attachments: [
      { id: 'picture', name: 'picture.png', mimeType: 'image/png', size: 1, kind: 'image', path: 'test.png' },
    ],
  };
  const run = (runtime: RuntimeSnapshot, changes: Partial<RunInput> = {}, capacity = new Set<string>()) =>
    route({ ...visual, ...changes }, [snapshot(), runtime], settings, capacity, timestamp);
  const chosen = run(grok);
  assert.equal(chosen.runtimeId, 'grok-b');
  assert.equal(chosen.model, 'grok-4.7');
  assert.equal(chosen.effort, 'low');
  assert.equal(run(grok, { runtimeId: undefined, provider: 'grok' }).runtimeId, 'grok-b');
  assert.equal(
    route(
      { ...visual, runtimeId: undefined, provider: undefined, model: undefined, effort: undefined },
      [snapshot(), grok],
      { ...settings, routePolicy: { general: ['grok'] } },
      new Set(),
      timestamp,
    ).runtimeId,
    'grok-b',
  );
  assert.throws(() => run({ ...grok, status: 'auth-required', note: 'Sign in first' }), /Sign in first/);
  assert.throws(() => run({ ...grok, quota: { ...grok.quota, windows: [window('week', 100)] } }), /剩余额度不足/);
  assert.throws(() => run(grok, {}, new Set(['grok'])), /执行其他任务/);
  assert.throws(() => run(grok, { effort: 'ultra' }), /不支持 ultra/);
  assert.throws(
    () => run({ ...grok, capabilities: { ...grok.capabilities, imageInput: false } }),
    /不会自动替换已指定的执行器/,
  );
});

test('retired gateways never route automatically or from a saved selection while direct APIs remain available', () => {
  const native = snapshot();
  const gateway = snapshot({
    id: 'pi-magpie',
    provider: 'pi',
    gateway: 'magpie',
    models: [{ id: 'magpie/group/pool', label: 'Account pool', efforts: ['low', 'high'] }],
    quota: { status: 'unknown', source: 'gateway', observedAt: iso(), windows: [] },
    accounting: { mode: 'usage', source: 'events' },
  });
  const api = snapshot({
    id: 'api-deepseek',
    provider: 'pi',
    gateway: 'api',
    apiProvider: 'deepseek',
    models: [{ id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat', efforts: ['off'] }],
    quota: { status: 'unknown', source: 'Pi RPC', observedAt: iso(), windows: [] },
    accounting: { mode: 'usage', source: 'events' },
  });
  const select = (patch: Partial<RunInput> = {}, values = [native, api, gateway]) =>
    route({ ...input, ...patch }, values, settings, new Set(), timestamp);
  assert.equal(select().runtimeId, 'codex-native');
  assert.equal(select({ executionPolicy: 'cli-only' }).runtimeId, 'codex-native');
  assert.equal(select({ executionPolicy: 'api-only' }).runtimeId, 'api-deepseek');
  assert.equal(select({ runtimeId: 'api-deepseek' }).model, 'deepseek/deepseek-chat');
  assert.equal(select({ runtimeId: 'codex-native' }).runtimeId, 'codex-native');
  for (const legacy of [gateway, { ...gateway, id: 'renamed-gateway' }, { ...gateway, gateway: undefined }]) {
    assert.equal(select({}, [native, legacy]).runtimeId, 'codex-native');
    assert.throws(() => select({ runtimeId: legacy.id }, [native, legacy]), /Magpie 网关已移除/);
    assert.throws(() => select({ executionPolicy: 'api-only' }, [native, legacy]), /Magpie 网关已移除/);
  }
  assert.throws(() => select({ runtimeId: 'pi-magpie' }, [native, api]), /Magpie 网关已移除/);
});

test('an API reasoning model with no medium level does not silently disable automatic effort', () => {
  const api = snapshot({
    id: 'api-openai',
    provider: 'pi',
    gateway: 'api',
    apiProvider: 'openai',
    models: [{ id: 'openai/reasoner', label: 'Reasoner', efforts: ['off', 'low', 'high'] }],
    accounting: { mode: 'usage', source: 'events' },
    quota: { status: 'unknown', source: 'Pi RPC', observedAt: null, windows: [] },
  });
  assert.equal(choose(api, { runtimeId: api.id }).effort, 'low');
  assert.equal(choose(api, { runtimeId: api.id, effort: 'off' }).effort, 'off');
});

test('known quota accepts zero use only when every reported window is above reserve', () => {
  const result = choose(withQuota({ windows: [window('five-hour', 0), window('weekly', 89.999)] }));
  assert.equal(result.runtimeId, 'codex-native');
  assert.deepEqual(result.warnings, []);
});

test('a later quota window blocks routing at the reserve boundary or exhaustion', () => {
  for (const used of [90, 100]) {
    const value = withQuota({ windows: [window('five-hour', 0), window('weekly', used, iso(7 * 86_400_000))] });
    assert.throws(() => choose(value), /weekly.*保护阈值/);
    // Unknown-quota consent must not override a known depleted window.
    assert.throws(
      () =>
        choose(value, { runtimeId: value.id, allowUnknownQuota: true }, { ...settings, unknownQuotaPolicy: 'allow' }),
      /weekly.*保护阈值/,
    );
  }
});

test('known quota rejects incomplete or malformed windows instead of inventing a balance', () => {
  assert.throws(() => choose(withQuota({ windows: [] })), /额度窗口缺失/);
  for (const used of [null, NaN, Infinity, -1, 101]) {
    assert.throws(
      () => choose(withQuota({ windows: [window('five-hour', 0), window('weekly', used)] })),
      /weekly.*额度未知/,
    );
  }
});

test('quota observations expire exactly at max age and reject future or missing timestamps', () => {
  assert.equal(choose(withQuota({ observedAt: iso(-179_999) })).runtimeId, 'codex-native');
  for (const observedAt of [iso(-180_000), iso(-180_001), iso(1), 'invalid-date', null]) {
    assert.throws(() => choose(withQuota({ observedAt })), /额度数据已过期/);
  }
});

test('passing a reset time never replenishes quota without a new observation', () => {
  for (const resetsAt of [iso(), iso(-1), 'invalid-date', null]) {
    const expired = { ...window('weekly', 0), resetsAt };
    assert.throws(
      () => choose(withQuota({ observedAt: iso(), windows: [window('five-hour', 0), expired] })),
      /weekly.*重新获取重置后的额度/,
    );
  }
  assert.equal(
    choose(withQuota({ observedAt: iso(), windows: [window('weekly', 0, iso(1))] })).runtimeId,
    'codex-native',
  );
});

test('fresh live notifications cannot renew the ages of preserved quota windows', () => {
  for (const observedAt of [iso(-180_000), iso(1), 'invalid-date']) {
    const value = withQuota({
      observedAt: iso(),
      windows: [window('five-hour', 20), { ...window('weekly', 40), observedAt }],
    });
    assert.throws(() => choose(value), /weekly 额度读数需要更新/);
    assert.equal(unavailableError(() => choose(value, { allowUnknownQuota: true })).kind, 'refresh');
  }
  const value = withQuota({
    observedAt: iso(),
    windows: [window('five-hour', 20), { ...window('weekly', 40), observedAt: iso(-179_999) }],
  });
  assert.equal(choose(value).runtimeId, 'codex-native');
});

test('a last-known display reference cannot admit a failed or unauthenticated account', () => {
  for (const status of ['error', 'auth-required'] as const) {
    const value = snapshot({ status });
    value.lastKnownQuota = value.quota;
    value.quota = { status: 'unknown', source: 'failed probe', observedAt: null, windows: [] };
    assert.throws(() => choose(value, { allowUnknownQuota: true }), RouteUnavailableError);
  }
});

test('an explicitly unreported reset permits fresh valid quota but preserves reserve and refresh guards', () => {
  const unreported: QuotaWindow = { ...window('five-hour', 0), resetsAt: null, resetNotReported: true };
  const value = withQuota({ windows: [unreported, window('weekly', 34)] });
  const decision = choose(value);
  assert.equal(decision.runtimeId, value.id);
  assert.match(decision.warnings.join('\n'), /未报告重置时间/);

  for (const usedPercent of [90, 100]) {
    const blocked = withQuota({ windows: [{ ...unreported, usedPercent }] });
    const error = unavailableError(() =>
      choose(blocked, { allowUnknownQuota: true }, { ...settings, unknownQuotaPolicy: 'allow' }),
    );
    assert.equal(error.kind, 'quota');
    assert.equal(error.retryAt, undefined, 'an unreported reset cannot invent a recovery timestamp');
  }
  assert.equal(
    unavailableError(() => choose(withQuota({ windows: [unreported, window('weekly', 95, iso(7 * 86_400_000))] })))
      .kind,
    'quota',
  );
  assert.equal(
    unavailableError(() => choose({ ...value, quota: { ...value.quota, observedAt: iso(-180_000) } })).kind,
    'refresh',
  );

  const malformed: Partial<QuotaWindow>[] = [
    { resetNotReported: undefined },
    { resetNotReported: false },
    { resetsAt: undefined },
    { resetsAt: 'invalid-date' },
    { resetsAt: iso() },
    { resetsAt: iso(-1) },
    ...[null, NaN, Infinity, -1, 101].map((usedPercent) => ({ usedPercent })),
  ];
  for (const patch of malformed) {
    const invalid = withQuota({ windows: [{ ...unreported, ...patch }] });
    assert.equal(unavailableError(() => choose(invalid)).kind, 'refresh');
  }
});

test('unknown quota without a verified subscription login still requires explicit consent', () => {
  for (const status of ['unknown', 'error'] as const) {
    const value = withQuota({ status, observedAt: null, windows: [] });
    for (const changes of [{}, { runtimeId: value.id }, { runtimeId: value.id, allowUnknownQuota: false }]) {
      assert.throws(() => choose(value, changes), /额度未知/);
    }
    const result = choose(value, { allowUnknownQuota: true });
    assert.equal(result.runtimeId, value.id);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0]!, /未知/);
  }
  const uncheckedClaude = snapshot({
    provider: 'claude',
    quota: { status: 'unknown', source: 'synthetic', observedAt: null, windows: [] },
  });
  assert.throws(() => choose(uncheckedClaude), /额度未知/);
});

test('checked subscription CLIs can try unknown quota once at a time without consent or unlimited capacity', () => {
  for (const provider of ['codex', 'claude', 'grok', 'cursor'] as const) {
    const value = snapshot({
      provider,
      authMode: provider === 'codex' ? 'chatgpt' : undefined,
      accounting: { mode: 'subscription', source: 'synthetic login check' },
      quota: { status: 'unknown', source: 'synthetic', observedAt: null, windows: [], unlimited: true },
    });
    assert.equal(choose(value).runtimeId, value.id);
    assert.match(choose(value).warnings.join(' '), /未知/);
    const capacity = { reservations: new Map([[quotaPoolKey(value), 1]]), settlingPools: new Set<string>() };
    assert.throws(() => route(input, [value], settings, capacity, timestamp), /一次只尝试一个任务/);
    assert.throws(
      () =>
        route(
          { ...input, allowUnknownQuota: true },
          [value],
          { ...settings, unknownQuotaPolicy: 'allow' },
          capacity,
          timestamp,
        ),
      /一次只尝试一个任务/,
    );
  }
});

test('known usable quota goes before a checked unknown CLI, within and across platforms', () => {
  const unknown = snapshot({
    authMode: 'chatgpt',
    quota: { status: 'unknown', source: 'synthetic', observedAt: null, windows: [] },
  });
  for (const known of [snapshot({ id: 'second' }), snapshot({ id: 'claude-known', provider: 'claude' })]) {
    assert.equal(route(input, [unknown, known], settings, new Set(), timestamp).runtimeId, known.id);
  }
});

test('an authenticated unknown-quota first attempt enters the existing real rate-limit cooldown', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const value = snapshot({
      authMode: 'chatgpt',
      accountFingerprint: 'synthetic-account',
      quota: { status: 'unknown', source: 'synthetic', observedAt: null, windows: [] },
    });
    const health = new AccountHealth(db, () => timestamp);
    const picked = choose(health.apply(value));
    health.failure(
      {
        id: value.id,
        provider: value.provider,
        label: value.label,
        environment: 'native',
        enabled: true,
        command: 'unused',
        accountFingerprint: value.accountFingerprint,
      },
      {
        id: 'synthetic-limit',
        prompt: input.prompt,
        projectPath: input.projectPath,
        kind: 'general',
        status: 'failed',
        route: picked,
        startedAt: iso(-1000),
        endedAt: iso(),
        output: '',
        events: [],
        errorCode: 'quota-or-rate-limit',
      },
      value,
    );
    const blocked = health.apply(value);
    assert.equal(blocked.quota.status, 'unknown');
    assert.equal(blocked.availability?.retryAt, iso(60_000));
    assert.throws(() => choose(blocked), /账号刚返回额度不足或限流/);
    assert.throws(
      () => choose(blocked, { allowUnknownQuota: true }, { ...settings, unknownQuotaPolicy: 'allow' }),
      /账号刚返回额度不足或限流/,
    );
  } finally {
    db.close();
  }
});

test('a global explicit allow policy permits unknown quota but keeps a visible warning', () => {
  const result = choose(
    withQuota({ status: 'unknown', observedAt: null, windows: [] }),
    {},
    { ...settings, unknownQuotaPolicy: 'allow' },
  );
  assert.equal(result.runtimeId, 'codex-native');
  assert.match(result.warnings.join(' '), /不是按已知余额派发/);
});

test('quota consent does not make a missing, unauthenticated, or non-executable runtime usable', () => {
  const unavailable = [
    snapshot({ installed: false }),
    ...(['missing', 'auth-required', 'error'] as const).map((status) => snapshot({ status })),
    snapshot({ capabilities: { execute: false, resume: true, cancel: true, approvals: true } }),
    snapshot({ models: [] }),
  ];
  for (const value of unavailable) {
    value.quota = { status: 'unknown', source: 'mock protocol', observedAt: null, windows: [] };
    assert.throws(() =>
      choose(value, { runtimeId: value.id, allowUnknownQuota: true }, { ...settings, unknownQuotaPolicy: 'allow' }),
    );
  }
});

test('a busy provider blocks both its native accounts while another provider can run', () => {
  const native = snapshot();
  const second = snapshot({ id: 'codex-second', label: 'Codex second' });
  const claude = snapshot({
    id: 'claude-native',
    provider: 'claude',
    label: 'Claude native',
    models: [{ id: 'sonnet', label: 'Sonnet', efforts: ['low', 'medium', 'high'] }],
  });
  const busy = new Set(['codex']);
  const result = route(input, [native, second, claude], settings, busy, timestamp);
  assert.equal(result.runtimeId, claude.id);
  assert.match(result.reasons.join('\n'), /Codex native.*额度结算/);
  assert.match(result.reasons.join('\n'), /Codex second.*额度结算/);
  assert.throws(
    () => route({ ...input, runtimeId: second.id }, [native, second, claude], settings, busy, timestamp),
    /额度结算/,
  );
});

test('quota reservations permit independent sessions and separate accounts without a provider-wide lock', () => {
  const first = snapshot({ accountFingerprint: 'account-a' });
  const second = snapshot({ id: 'codex-second', label: 'Codex second', accountFingerprint: 'account-b' });
  const reservations = new Map([[quotaPoolKey(first), 1]]);
  const capacity = { reservations, settlingPools: new Set<string>(), maxRunsPerPool: 2 };
  const pinned = route({ ...input, runtimeId: first.id }, [first, second], settings, capacity, timestamp);
  assert.equal(pinned.runtimeId, first.id, 'a second native session may use the same fresh account');
  assert.match(pinned.warnings.join('\n'), /本地缓冲/);
  reservations.set(quotaPoolKey(first), 2);
  assert.equal(route(input, [first, second], settings, capacity, timestamp).runtimeId, second.id);
  assert.throws(
    () => route({ ...input, runtimeId: first.id }, [first, second], settings, capacity, timestamp),
    /此账号的并发容量/,
  );
});

test('zero per-account cap routes a second run on the same healthy account', () => {
  const account = snapshot({ accountFingerprint: 'unlimited-account' });
  const decision = route(
    { ...input, runtimeId: account.id },
    [account],
    { ...settings, maxRunsPerAccount: 0 },
    {
      reservations: new Map([[quotaPoolKey(account), 1]]),
      settlingPools: new Set<string>(),
      maxRunsPerPool: 0,
    },
    timestamp,
  );
  assert.equal(decision.runtimeId, account.id);
});

test('two CLI homes for the same identity share reservations and low headroom waits for settlement', () => {
  const first = snapshot({ accountFingerprint: 'same-account' });
  const alias = snapshot({ id: 'codex-alias', accountFingerprint: 'same-account' });
  const other = snapshot({ id: 'codex-other', accountFingerprint: 'other-account' });
  const capacity = {
    reservations: new Map([[quotaPoolKey(first), 1]]),
    settlingPools: new Set([quotaPoolKey(first)]),
  };
  assert.equal(route(input, [first, alias, other], settings, capacity, timestamp).runtimeId, other.id);
  assert.throws(() => route({ ...input, runtimeId: alias.id }, [alias], settings, capacity, timestamp), /额度结算/);
  capacity.settlingPools.clear();
  const nearReserve = { ...first, quota: { ...first.quota, windows: [window('weekly', 85, iso(7 * 86_400_000))] } };
  const error = unavailableError(() => route(input, [nearReserve], settings, capacity, timestamp));
  assert.equal(error.kind, 'capacity', 'in-flight buffering waits for completion rather than inventing a reset');
  assert.equal(error.retryAt, undefined);
  assert.equal(nearReserve.quota.windows[0]?.usedPercent, 85, 'provider quota readouts are never mutated');
});

test('planner routine uses a standard model and architecture uses higher effort', () => {
  assert.deepEqual(
    ['model', 'effort'].map(
      (key) => choose(snapshot(), { kind: 'routine', plannerStep: true })[key as 'model' | 'effort'],
    ),
    ['gpt-6-sol', 'medium'],
  );
  const architecture = choose(snapshot(), { kind: 'architecture' });
  assert.equal(architecture.model, 'gpt-6-sol');
  assert.equal(architecture.effort, 'high');
  assert.throws(
    () =>
      choose(snapshot({ models: [{ id: 'gpt-6-luna', label: 'Luna', efforts: ['low'], lightweight: true }] }), {
        kind: 'architecture',
      }),
    /仅有轻量模型/,
  );
});

test('pinned executors keep automatic model routing and apply supported effort or explain the nearest level', () => {
  for (const provider of ['codex', 'claude', 'grok', 'cursor', 'pi'] as const) {
    const value = snapshot({
      provider,
      models: [
        { id: 'fixture-standard', label: 'Standard', efforts: ['off', 'low', 'medium', 'high'] },
        { id: 'fixture-strong', label: 'Strong', efforts: ['xhigh', 'max', 'ultra'] },
      ],
    });
    const automatic = choose(value, { runtimeId: value.id });
    for (const [requested, expected] of [
      ['off', 'off'],
      ['low', 'low'],
      ['xhigh', 'high'],
      ['ultra', 'high'],
    ]) {
      const selected = choose(value, { runtimeId: value.id, effort: requested });
      assert.equal(selected.model, automatic.model);
      assert.equal(selected.effort, expected);
      const reason = `所选模型不支持 ${requested}，改用 ${expected}`;
      assert.equal(selected.reasons.filter((line) => line === reason).length, requested === expected ? 0 : 1);
    }
  }
});

test('automatic model without effort settings uses its default and explains the unsupported request', () => {
  const value = snapshot({ models: [{ id: 'fixture', label: 'Fixture', efforts: [] }] });
  const selected = choose(value, { runtimeId: value.id, effort: 'high' });
  assert.equal(selected.effort, undefined);
  assert.ok(selected.reasons.includes('所选模型不支持 high，改用 模型默认'));
  assert.throws(() => choose(value, { runtimeId: value.id, effort: 'not-supported' }), /不支持/);
});

test('explicit model and effort are validated without silently changing the request', () => {
  assert.throws(() => choose(snapshot(), { model: 'unavailable-model' }), /未发现指定模型/);
  assert.throws(() => choose(snapshot(), { model: 'gpt-6-sol', effort: 'ultra' }), /不支持 ultra/);
  const result = choose(snapshot(), { model: 'gpt-6-sol', effort: 'low' });
  assert.equal(result.model, 'gpt-6-sol');
  assert.equal(result.effort, 'low');
});

test('quota headroom controls same-provider native account routing without overriding a fixed account', () => {
  const low = snapshot({
    quota: { status: 'known', source: 'mock', observedAt: iso(-100), windows: [window('weekly', 87)] },
  });
  const roomy = snapshot({
    id: 'codex-second',
    quota: { status: 'known', source: 'mock', observedAt: iso(-100), windows: [window('weekly', 20)] },
  });
  assert.equal(route(input, [low, roomy], settings, new Set(), timestamp).runtimeId, 'codex-second');
  assert.equal(
    route({ ...input, runtimeId: 'codex-native' }, [low, roomy], settings, new Set(), timestamp).runtimeId,
    'codex-native',
  );
});

test('retired WSL snapshots are never candidates even with healthy quota, explicit selection or exhausted native accounts', () => {
  const native = snapshot({
    quota: { status: 'known', source: 'mock', observedAt: iso(-100), windows: [window('weekly', 87)] },
  });
  const retired = [
    snapshot({ id: 'custom-linux', environment: 'wsl' }),
    snapshot({ id: 'codex-wsl', environment: 'native' }),
  ];
  for (const preferNative of [true, false]) {
    const config = { ...settings, preferNative, unknownQuotaPolicy: 'allow' as const };
    assert.equal(route(input, [...retired, native], config, new Set(), timestamp).runtimeId, native.id);
    for (const target of retired) {
      const error = unavailableError(() =>
        route(
          { ...input, runtimeId: target.id, allowUnknownQuota: true },
          [native, ...retired],
          config,
          new Set(),
          timestamp,
        ),
      );
      assert.equal(error.kind, 'unavailable');
      assert.match(error.message, /WSL/);
      assert.equal(error.retryAt, undefined);
    }
    const depleted = { ...native, quota: { ...native.quota, windows: [window('weekly', 100)] } };
    const blocked = unavailableError(() => route(input, [depleted, ...retired], config, new Set(), timestamp));
    assert.equal(blocked.kind, 'quota');
    assert.match(blocked.message, /保护阈值/);
    assert.match(blocked.message, /WSL/);
  }
});

test('consumption monitoring can route without a balance but subscription mode keeps quota protection', () => {
  const runtime = snapshot({
    provider: 'pi',
    id: 'pi-local',
    quota: { status: 'unknown', source: 'usage', observedAt: null, windows: [] },
    accounting: { mode: 'usage', source: 'runtime events' },
  });
  assert.equal(choose(runtime).runtimeId, 'pi-local');
  runtime.accounting = { mode: 'subscription', source: 'user' };
  assert.throws(() => choose(runtime), /额度未知/);
  runtime.accounting = { mode: 'usage', source: 'runtime events' };
  runtime.quota = { status: 'known', source: 'mock', observedAt: iso(-100), windows: [window('weekly', 100)] };
  assert.throws(() => choose(runtime), /保护阈值/);
});

test('CLI-only and API-only transport policies filter execution engines before scoring', () => {
  const cli = snapshot();
  const api = snapshot({ id: 'pi-local', provider: 'pi' });
  assert.equal(
    route({ ...input, executionPolicy: 'api-only' }, [cli, api], settings, new Set(), timestamp).runtimeId,
    'pi-local',
  );
  assert.equal(
    route({ ...input, executionPolicy: 'cli-only' }, [cli, api], settings, new Set(), timestamp).runtimeId,
    'codex-native',
  );
  assert.throws(() =>
    route({ ...input, executionPolicy: 'api-only', runtimeId: cli.id }, [cli, api], settings, new Set(), timestamp),
  );
});

function unavailableError(run: () => unknown): RouteUnavailableError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof RouteUnavailableError);
    return error;
  }
  assert.fail('Expected routing to be unavailable');
}

test('quota retry waits for every blocking window, then chooses the earliest eligible candidate recheck', () => {
  const codex = withQuota({
    windows: [window('five-hour', 100, iso(5 * 60_000)), window('weekly', 100, iso(60 * 60_000))],
  });
  const claude = snapshot({
    id: 'claude-native',
    provider: 'claude',
    label: 'Claude',
    quota: {
      status: 'known',
      source: 'mock',
      observedAt: iso(-1000),
      windows: [
        window('session', 100, iso(10 * 60_000)),
        window('weekly', 100, iso(20 * 60_000)),
        window('monthly', 10, iso(30 * 86400_000)),
      ],
    },
  });
  const error = unavailableError(() => route(input, [codex, claude], settings, new Set(), timestamp));
  assert.equal(error.kind, 'quota');
  assert.equal(error.retryAt, iso(20 * 60_000));
  assert.match(error.reasons.join('\n'), /Codex native.*five-hour/);
  assert.match(error.reasons.join('\n'), /Codex native.*weekly/);
  assert.equal(unavailableError(() => choose(codex, { runtimeId: codex.id })).retryAt, iso(60 * 60_000));
});

test('retry timestamps never count as restored quota and malformed data requests refresh', () => {
  const exhausted = withQuota({ windows: [window('weekly', 100, iso(60_000))] });
  assert.equal(unavailableError(() => choose(exhausted)).kind, 'quota');
  const atReset = unavailableError(() => route(input, [exhausted], settings, new Set(), timestamp + 60_000));
  assert.equal(atReset.kind, 'refresh');
  assert.equal(atReset.retryAt, undefined);
  const mixed = withQuota({ windows: [window('session', null), window('weekly', 100, iso(80_000))] });
  assert.equal(unavailableError(() => choose(mixed)).kind, 'refresh');
  assert.equal(unavailableError(() => choose(mixed)).retryAt, iso(80_000));
  assert.equal(unavailableError(() => choose(withQuota({ observedAt: iso(-180_000) }))).kind, 'refresh');
});

test('temporary capacity and refresh are distinct from authentication and unsupported model failures', () => {
  assert.equal(
    unavailableError(() => route(input, [snapshot()], settings, new Set(['codex']), timestamp)).kind,
    'capacity',
  );
  assert.equal(unavailableError(() => choose(snapshot({ status: 'refreshing' }))).kind, 'refresh');
  assert.equal(unavailableError(() => choose(snapshot({ status: 'auth-required' }))).kind, 'unavailable');
  const exhausted = withQuota({ windows: [window('weekly', 100)] });
  for (const changes of [{ model: 'not-installed' }, { effort: 'not-supported' }]) {
    const failure = unavailableError(() => choose(exhausted, changes));
    assert.equal(failure.kind, 'unavailable');
    assert.equal(failure.retryAt, undefined);
  }
  const noAuth = snapshot({ id: 'claude-native', provider: 'claude', status: 'auth-required' });
  assert.equal(unavailableError(() => route(input, [exhausted, noAuth], settings, new Set(), timestamp)).kind, 'quota');
});

test('direct runs respect notBefore and validate malformed schedule dates', () => {
  const early = unavailableError(() => choose(snapshot(), { schedule: { notBefore: iso(300_000) } }));
  assert.equal(early.kind, 'capacity');
  assert.equal(early.retryAt, iso(300_000));
  assert.equal(choose(snapshot(), { schedule: { notBefore: iso() } }).runtimeId, 'codex-native');
  for (const schedule of [{ notBefore: 'invalid' }, { deadlineAt: 'invalid' }]) {
    assert.equal(unavailableError(() => choose(snapshot(), { schedule })).kind, 'unavailable');
  }
});

function expiringPair(): [RuntimeSnapshot, RuntimeSnapshot] {
  const codex = withQuota({ windows: [window('weekly', 20, iso(90 * 60_000))] });
  const claude = snapshot({
    id: 'claude-native',
    provider: 'claude',
    label: 'Claude',
    models: [
      { id: 'sonnet', label: 'Sonnet', efforts: ['low', 'medium', 'high'] },
      { id: 'haiku', label: 'Haiku', efforts: ['low', 'medium'], lightweight: true },
    ],
    quota: {
      status: 'known',
      source: 'mock',
      observedAt: iso(-1000),
      windows: [{ ...window('weekly', 80, iso(10 * 60_000)), durationMinutes: 7 * 24 * 60 }],
    },
  });
  return [codex, claude];
}

test('an explicitly unreported reset cannot create a cross-provider reset opportunity', () => {
  const [codex, claude] = expiringPair();
  claude.quota.windows = [{ ...window('five-hour', 0), resetsAt: null, resetNotReported: true }];
  const scheduled = { ...input, schedule: { estimatedMinutes: 20, preferExpiringQuota: true } };
  assert.equal(route(scheduled, [codex, claude], settings, new Set(), timestamp).runtimeId, codex.id);
  const explicit = route({ ...scheduled, runtimeId: claude.id }, [codex, claude], settings, new Set(), timestamp);
  assert.equal(explicit.runtimeId, claude.id, 'the account is available; it simply has no reset preference');
  assert.match(explicit.warnings.join('\n'), /不参与重置时间排序/);
  assert.doesNotMatch(explicit.reasons.join('\n'), /近期机会窗口内/);
  claude.quota.windows = [{ ...window('five-hour', 10, iso(10 * 60_000)), durationMinutes: 300 }];
  assert.equal(route(scheduled, [codex, claude], settings, new Set(), timestamp).runtimeId, claude.id);
});

test('near resets with predicted waste can change the cross-provider choice without asking for difficulty', () => {
  const [codex, claude] = expiringPair();
  for (const request of [input, { ...input, prompt: 'fix the typo', kind: 'auto' as const }]) {
    const scheduled = { ...request, schedule: { estimatedMinutes: 20, preferExpiringQuota: true } };
    const decision = route(scheduled, [codex, claude], settings, new Set(), timestamp);
    assert.equal(decision.runtimeId, claude.id);
    assert.match(decision.reasons.join('\n'), /临近重置偏好优先于默认平台/);
    assert.match(decision.warnings.join('\n'), /不承诺额度恢复/);
    assert.equal(
      route(
        { ...scheduled, schedule: { ...scheduled.schedule, preferExpiringQuota: false } },
        [codex, claude],
        settings,
        new Set(),
        timestamp,
      ).runtimeId,
      codex.id,
    );
  }
});

test('reset opportunities use a near-term horizon while deadline risks stay explicit', () => {
  const pair = expiringPair();
  pair[1].quota.windows[0]!.resetsAt = iso(75 * 60_000);
  assert.equal(
    route({ ...input, schedule: { estimatedMinutes: 5 } }, pair, settings, new Set(), timestamp).runtimeId,
    'codex-native',
  );
  assert.equal(
    route({ ...input, schedule: { estimatedMinutes: 50 } }, pair, settings, new Set(), timestamp).runtimeId,
    'claude-native',
  );
  pair[1].quota.windows[0]!.resetsAt = iso(10 * 60_000);
  const late = route(
    { ...input, schedule: { estimatedMinutes: 20, deadlineAt: iso(5 * 60_000) } },
    pair,
    settings,
    new Set(),
    timestamp,
  );
  assert.equal(late.runtimeId, 'claude-native');
  assert.match(late.reasons.join('\n'), /少于 20 分钟/);
  assert.match(late.warnings.join('\n'), /不为赶截止时间自动降低能力/);
  const past = route({ ...input, schedule: { deadlineAt: iso(-1) } }, pair, settings, new Set(), timestamp);
  assert.match(past.warnings.join('\n'), /截止时间已过/);
});

test('a 21:30 task estimated at 15 minutes can prefer a 22:00 reset even with a 21:50 deadline', () => {
  const pair = expiringPair();
  const start = Date.parse('2026-09-26T21:30:00.000Z');
  for (const runtime of pair) runtime.quota.observedAt = new Date(start - 1000).toISOString();
  pair[0].quota.windows[0]!.resetsAt = '2026-09-26T23:00:00.000Z';
  pair[1].quota.windows[0]!.resetsAt = '2026-09-26T22:00:00.000Z';
  const decision = route(
    { ...input, schedule: { estimatedMinutes: 15, deadlineAt: '2026-09-26T21:50:00.000Z' } },
    pair,
    settings,
    new Set(),
    start,
  );
  assert.equal(decision.runtimeId, 'claude-native');
  assert.match(decision.reasons.join('\n'), /22:00:00/);
  assert.match(decision.reasons.join('\n'), /21:50:00.*实际耗时仍可能超出估计/);
  assert.match(decision.warnings.join('\n'), /不承诺额度恢复/);
});

test('a reset preference never overrides runtime pins, task capability floor, domain preference, or CLI policy', () => {
  const [codex, claude] = expiringPair();
  const schedule = { estimatedMinutes: 30, preferExpiringQuota: true };
  assert.equal(
    route({ ...input, schedule, runtimeId: codex.id }, [codex, claude], settings, new Set(), timestamp).runtimeId,
    codex.id,
  );
  assert.equal(
    route({ ...input, schedule, kind: 'architecture' }, [codex, claude], settings, new Set(), timestamp).runtimeId,
    codex.id,
  );
  assert.equal(
    route(
      { ...input, schedule, kind: 'design' },
      [codex, claude],
      { ...settings, designProvider: 'codex' },
      new Set(),
      timestamp,
    ).runtimeId,
    codex.id,
  );
  const light = { ...claude, models: [claude.models[1]!] };
  assert.equal(route({ ...input, schedule }, [codex, light], settings, new Set(), timestamp).runtimeId, codex.id);
  assert.equal(
    unavailableError(() => route({ ...input, kind: 'architecture', schedule }, [light], settings, new Set(), timestamp))
      .kind,
    'unavailable',
  );
  const api = { ...claude, id: 'pi-local', provider: 'pi' as const };
  assert.equal(
    route(
      { ...input, schedule, executionPolicy: 'cli-first' },
      [api, codex],
      { ...settings, preferCli: false },
      new Set(),
      timestamp,
    ).runtimeId,
    codex.id,
  );
  assert.equal(
    route({ ...input, schedule, executionPolicy: 'api-only' }, [api, codex], settings, new Set(), timestamp).runtimeId,
    api.id,
  );
});

test('provider percentages never serve as a cross-provider capacity ranking', () => {
  const [codex, claude] = expiringPair();
  const grok = { ...codex, id: 'grok-native', provider: 'grok' as const };
  const policy = { ...settings, architectureProvider: 'codex' as const };
  const request = { ...input, schedule: { preferExpiringQuota: false } };
  assert.equal(route(request, [grok, claude], policy, new Set(), timestamp).runtimeId, claude.id);
  claude.quota.windows[0]!.usedPercent = 1;
  grok.quota.windows[0]!.usedPercent = 89;
  assert.equal(route(request, [grok, claude], policy, new Set(), timestamp).runtimeId, claude.id);
});

test('routing classification excludes historical context and keeps user model and effort pins', () => {
  const request = {
    ...input,
    prompt: 'Previous work: architecture and security. Current task: fix typo.',
    routingPrompt: 'fix typo',
    kind: 'auto' as const,
  };
  const result = route(request, [snapshot()], settings, new Set(), timestamp);
  assert.equal(result.kind, 'routine');
  assert.equal(result.model, 'gpt-6-luna');
  const pinned = route(
    { ...request, model: 'gpt-6-sol', effort: 'high' },
    [snapshot()],
    settings,
    new Set(),
    timestamp,
  );
  assert.equal(pinned.model, 'gpt-6-sol');
  assert.equal(pinned.effort, 'high');
});

test('duration estimates are initial heuristics, honor explicit estimates, and tolerate missing or invalid hints', () => {
  assert.equal(estimateTaskMinutes({ schedule: { estimatedMinutes: 12.3 } }), 13);
  const complex = estimateTaskMinutes({ content: 'design authentication architecture', mode: 'build' });
  const simple = estimateTaskMinutes({ content: 'fix typo', mode: 'build' });
  assert.ok(complex > simple);
  assert.ok(estimateTaskMinutes({ content: 'fix typo', mode: 'chat' }) < simple);
  for (const estimatedMinutes of [0, -1, NaN, Infinity]) {
    const estimate = estimateTaskMinutes({ schedule: { estimatedMinutes } });
    assert.ok(Number.isFinite(estimate) && estimate > 0);
  }
});

test('automatic execution skips models whose CLI cannot run in auto mode', () => {
  const claude = snapshot({
    id: 'claude-native',
    provider: 'claude',
    label: 'Claude native',
    models: [
      { id: 'haiku', label: 'Haiku', efforts: [], lightweight: true, noAutoApproval: true },
      { id: 'sonnet', label: 'Sonnet', efforts: ['low', 'medium', 'high'] },
    ],
  });
  const routine = { kind: 'auto' as const, prompt: 'Fix the typo' };
  // A light task would normally take Haiku, which falls back to asking for every tool.
  assert.equal(choose(claude, routine).model, 'sonnet');
  assert.equal(choose(claude, routine, { ...settings, toolApprovalMode: 'ask' }).model, 'haiku');
  assert.throws(() => choose(claude, { ...routine, model: 'haiku' }), /不支持自动执行模式/);
});

test('task categories route by the configured platforms, with quota deciding between several', () => {
  const provider = (id: string, kind: RuntimeSnapshot['provider'], used: number): RuntimeSnapshot =>
    snapshot({ id, provider: kind, label: id, quota: { ...snapshot().quota, windows: [window('weekly', used)] } });
  const all = [
    provider('codex-native', 'codex', 70),
    provider('claude-native', 'claude', 20),
    provider('grok-native', 'grok', 5),
  ];
  const policy = {
    ...settings,
    routePolicy: { architecture: ['codex', 'claude'] as const, design: ['claude'] as const },
  };
  const pick = (changes: Partial<RunInput>, config: Settings = policy as unknown as Settings) =>
    route({ ...input, kind: 'auto', ...changes }, all, config, new Set(), timestamp).runtimeId;
  // Back-end work may go to Codex or Claude: Claude has more quota left, Grok is not listed.
  assert.equal(pick({ prompt: 'Refactor the service architecture and fix the concurrency deadlock' }), 'claude-native');
  // Adult content goes to Grok by default, from local wording or a sure Jev answer.
  assert.equal(pick({ prompt: '继续写这篇成人小说' }), 'grok-native');
  const judged = {
    contractVersion: 'comborunner-task-judgment-v1',
    inputHash: 'x',
    status: 'accepted',
    source: 'jev',
    content: 'adult',
    confidence: { intent: null, kind: null, complexity: null },
    observedAt: iso(),
    latencyMs: 1,
    reason: 'accepted',
    usage: { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null },
    requestAttempted: true,
  } as const;
  assert.equal(pick({ prompt: 'Continue the story', taskJudgment: judged as never }), 'grok-native');
  // Without a policy, the earlier single preferences still apply.
  assert.equal(
    pick({ prompt: 'Refactor the service architecture and fix the concurrency deadlock' }, settings),
    'codex-native',
  );
});

test('API platforms sharing Pi remain separate candidates for an explicit route policy', () => {
  const api = (platform: string): RuntimeSnapshot =>
    snapshot({
      id: `api-${platform}`,
      provider: 'pi',
      apiProvider: platform,
      label: platform,
      quota: { status: 'unknown', source: 'API', observedAt: iso(), windows: [] },
      accounting: { mode: 'usage', source: 'API' },
    });
  const deepseek = api('deepseek'),
    openai = api('openai');
  const policy: Settings = { ...settings, routePolicy: { general: ['api:openai'] } };
  for (const catalogs of [
    [deepseek, openai],
    [openai, deepseek],
  ])
    assert.equal(
      route({ ...input, executionPolicy: 'api-only' }, catalogs, policy, new Set(), timestamp).runtimeId,
      openai.id,
    );
  assert.equal(
    route(
      { ...input, executionPolicy: 'api-only' },
      [openai, deepseek],
      {
        ...policy,
        routePolicy: { general: ['api:deepseek'] },
      },
      new Set(),
      timestamp,
    ).runtimeId,
    deepseek.id,
  );
});

test('fixed platform preferences are opt-in while explicit runtime choices still win', () => {
  const other = snapshot({ id: 'claude-native', provider: 'claude', label: 'Claude native' });
  const native = snapshot();
  const configured: Settings = { ...settings, routePolicy: { general: ['codex'] }, routePreferencesEnabled: true };
  const request = { ...input, schedule: { preferExpiringQuota: false } };
  assert.equal(route(request, [other, native], configured, new Set(), timestamp).runtimeId, native.id);
  for (const enabled of [false, undefined]) {
    const automatic = { ...configured, routePreferencesEnabled: enabled };
    assert.equal(route(request, [other, native], automatic, new Set(), timestamp).runtimeId, other.id);
    assert.equal(
      route({ ...request, runtimeId: native.id }, [other, native], automatic, new Set(), timestamp).runtimeId,
      native.id,
    );
  }
});

test('quota that resets sooner goes first, so a nearly expiring account is used before a fuller one', () => {
  const hour = 3_600_000;
  const quota = (used: number, hours: number) => ({
    status: 'known' as const,
    source: 'mock',
    observedAt: iso(-100),
    windows: [window('weekly', used, iso(hours * hour))],
  });
  // As with two Grok accounts: 52% left resetting in a day beats 76% left that must last four more days.
  const expiring = snapshot({ id: 'grok-native', provider: 'grok', label: 'Grok · 本机', quota: quota(48, 24) });
  const fuller = snapshot({ id: 'grok-second', provider: 'grok', label: 'Grok B', quota: quota(24, 97) });
  const grok = { ...input, provider: 'grok' as const };
  const chosen = route(grok, [fuller, expiring], settings, new Set(), timestamp);
  assert.equal(chosen.runtimeId, 'grok-native');
  assert.ok(chosen.reasons.some((reason) => /优先用快重置的额度：Grok · 本机 还剩 52%，约 24 小时后重置/.test(reason)));
  // With the preference turned off for a message, the account with more left wins as before.
  assert.equal(
    route({ ...grok, schedule: { preferExpiringQuota: false } }, [fuller, expiring], settings, new Set(), timestamp)
      .runtimeId,
    'grok-second',
  );
  // Similar paces (within a fifth) fall back to the larger share left.
  const close = snapshot({ id: 'grok-second', provider: 'grok', label: 'Grok B', quota: quota(10, 40) });
  const slower = snapshot({ id: 'grok-native', provider: 'grok', label: 'Grok · 本机', quota: quota(30, 30) });
  assert.equal(route(grok, [slower, close], settings, new Set(), timestamp).runtimeId, 'grok-second');
  // A short window does not make an account look urgent: its longest window sets the pace.
  const shortFresh = snapshot({
    id: 'codex-second',
    quota: {
      status: 'known',
      source: 'mock',
      observedAt: iso(-100),
      windows: [window('five-hour', 0, iso(5 * hour)), window('weekly', 60, iso(100 * hour))],
    },
  });
  const weeklyExpiring = snapshot({ quota: quota(50, 30) });
  assert.equal(route(input, [shortFresh, weeklyExpiring], settings, new Set(), timestamp).runtimeId, 'codex-native');
});

test('Cursor never picks a "NO ZDR" build on its own, and sends adult material to its Grok models', () => {
  const cursor = snapshot({
    id: 'cursor-native',
    provider: 'cursor',
    label: 'Cursor',
    models: [
      { id: 'claude-fable-5-1-high', label: 'Claude Fable 5.1 1M (NO ZDR)', efforts: [] },
      { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 1M High', efforts: [] },
      { id: 'grok-4.7-high', label: 'Grok 4.7 High', efforts: [] },
    ],
    quota: { status: 'known', source: 'mock', observedAt: iso(-100), windows: [window('month', 10)] },
  });
  const pick = (prompt: string, model?: string) =>
    route(
      { ...input, prompt, runtimeId: 'cursor-native', ...(model ? { model } : {}) },
      [cursor],
      settings,
      new Set(),
      timestamp,
    ).model;
  assert.notEqual(pick('Review chapter one'), 'claude-fable-5-1-high');
  assert.equal(pick('写一段情色描写'), 'grok-4.7-high');
  // The user may still pin it.
  assert.equal(pick('Review chapter one', 'claude-fable-5-1-high'), 'claude-fable-5-1-high');
});

test('automatic routing excludes paid API cards while explicit pins remain usable', () => {
  const cli = snapshot({ quota: { ...snapshot().quota, windows: [window('weekly', 100)] } });
  const api = snapshot({
    id: 'paid',
    provider: 'pi',
    gateway: 'api',
    apiProvider: 'deepseek',
    accounting: { mode: 'usage', source: 'events' },
    quota: { status: 'unknown', source: 'fixture', observedAt: iso(), windows: [] },
  });
  assert.throws(() => route(input, [cli, api], settings, new Set(), timestamp), /API/);
  assert.equal(route({ ...input, runtimeId: 'paid' }, [cli, api], settings, new Set(), timestamp).runtimeId, 'paid');
});

test('new accounts join automatically and excluded accounts stay out', () => {
  const exhausted = snapshot({
    id: 'first',
    provider: 'claude',
    quota: { ...snapshot().quota, windows: [window('weekly', 100)] },
  });
  const second = snapshot({ id: 'second', provider: 'claude' });
  assert.equal(route(input, [exhausted, second], settings, new Set(), timestamp).runtimeId, 'second');
  assert.throws(
    () => route(input, [exhausted, second], { ...settings, excludedExecutors: ['second'] }, new Set(), timestamp),
    RouteUnavailableError,
  );
});

test('a new registry CLI is routed without a Cursor fallback', () => {
  const registry = providerSpecs as unknown as Record<string, ProviderSpec>;
  registry.zcode = { transport: 'cli', bridge: { callSeconds: 240, restoreMarginMs: 10000 } };
  try {
    const next = snapshot({ id: 'zcode-native', provider: 'zcode' as RuntimeSnapshot['provider'] });
    const decision = route(input, [next], settings, new Set(), timestamp);
    assert.equal(decision.runtimeId, 'zcode-native');
    assert.equal(
      decision.reasons.some((reason) => /Cursor/.test(reason)),
      false,
    );
  } finally {
    delete registry.zcode;
  }
});

const picture = {
  id: 'synthetic',
  name: 'fixture.png',
  mimeType: 'image/png',
  size: 1,
  kind: 'image' as const,
  path: 'never-read.png',
};
const apiCard = (id: string, models: RuntimeSnapshot['models'], imageInput: boolean) =>
  snapshot({
    id,
    label: id,
    provider: 'pi',
    gateway: 'api',
    apiProvider: id,
    models,
    capabilities: { execute: true, resume: true, cancel: true, approvals: false, imageInput },
  });

test('a plan step that prefers API cards moves to a CLI when no API card reads its picture', () => {
  const deepseek = apiCard(
    'deepseek',
    [{ id: 'deepseek/deepseek-chat', label: 'DeepSeek', efforts: ['off'], imageInput: false }],
    false,
  );
  const step: RunInput = {
    ...input,
    executionPolicy: 'api-only',
    stepTransport: 'api',
    allowExecutorFallback: true,
    attachments: [picture],
  };
  const decision = route(step, [deepseek, snapshot()], settings, new Set(), timestamp);
  assert.equal(decision.runtimeId, 'codex-native');
  assert.match(
    decision.reasons[0]!,
    /这一步首选API 卡，但API 卡都不能接（当前执行器的图片输入通道不可用），改用 Codex native/,
  );
  // The user's own API-only choice, or a task that forbids another executor, still stops here.
  for (const changes of [{ stepTransport: undefined }, { allowExecutorFallback: false }])
    assert.throws(
      () => route({ ...step, ...changes }, [deepseek, snapshot()], settings, new Set(), timestamp),
      /图片输入通道不可用/,
    );
  // A step that prefers CLIs widens to the normal pool, where paid API cards still join only by their usual rule.
  const anthropic = apiCard(
    'anthropic',
    [{ id: 'anthropic/claude-fixture', label: 'Claude', efforts: ['off'], imageInput: true }],
    true,
  );
  const blind = snapshot({
    capabilities: { execute: true, resume: true, cancel: true, approvals: true, imageInput: false },
  });
  assert.throws(
    () =>
      route(
        { ...step, executionPolicy: 'cli-only', stepTransport: 'cli' },
        [anthropic, blind],
        settings,
        new Set(),
        timestamp,
      ),
    /按次计费的 API 卡默认不参与自动选择/,
  );
});

test('an API card sends a picture only to a model whose catalog reads images', () => {
  const glm = apiCard(
    'zhipu',
    [
      { id: 'zhipu/glm-5.3', label: 'GLM', efforts: ['off'], imageInput: false },
      { id: 'zhipu/glm-5v', label: 'GLM vision', efforts: ['off'], imageInput: true },
    ],
    true,
  );
  const visual: RunInput = { ...input, executionPolicy: 'api-only', attachments: [picture] };
  assert.equal(route(visual, [glm], settings, new Set(), timestamp).model, 'zhipu/glm-5v');
  assert.throws(
    () => route({ ...visual, runtimeId: 'zhipu', model: 'zhipu/glm-5.3' }, [glm], settings, new Set(), timestamp),
    /模型不支持图片输入/,
  );
  // Without a picture the text model stays available.
  assert.equal(
    route(
      { ...input, executionPolicy: 'api-only', runtimeId: 'zhipu', model: 'zhipu/glm-5.3' },
      [glm],
      settings,
      new Set(),
      timestamp,
    ).model,
    'zhipu/glm-5.3',
  );
});

test('continuing a step that was widened to a CLI stays on that session', () => {
  const step: RunInput = {
    ...input,
    executionPolicy: 'api-only',
    stepTransport: 'api',
    allowExecutorFallback: true,
    resumeRunId: 'earlier-run',
    confirmedRoute: { runtimeId: 'codex-native', model: 'gpt-6-sol' },
  };
  assert.equal(route(step, [snapshot()], settings, new Set(), timestamp).runtimeId, 'codex-native');
});
