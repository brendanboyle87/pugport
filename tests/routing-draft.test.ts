import assert from 'node:assert/strict';
import test from 'node:test';
import { compileRoutingDraft, draftRoutingProfile } from '../src/server/routing-draft.ts';
import { routedMessage } from '../src/server/conversation-routing.ts';
import { route } from '../src/server/routing.ts';
import { apiBudgetPolicy, apiBudgetView } from '../src/server/api-budget.ts';
import type { RoutingCard } from '../src/shared/conversation-routing.ts';
import type { RunInput, RunRecord, RuntimeSnapshot, RuntimeTarget, Settings } from '../src/shared/types.ts';

const text =
  '直接使用Opus5.5作为开始，不需要判断，然后后面分配具体的任务给不同的模型和强度，codex astra或者sol进行核验';
const cards: RoutingCard[] = [
  {
    id: 'claude',
    provider: 'claude',
    label: 'Claude',
    models: [{ id: 'opus-5.5', label: 'Claude Opus 5.5', efforts: ['high'] }],
  },
  {
    id: 'codex',
    provider: 'codex',
    label: 'Codex',
    models: [
      { id: 'gpt-6-astra', label: 'Astra', efforts: ['high'] },
      { id: 'gpt-6-sol', label: 'Sol', efforts: ['medium', 'high'] },
    ],
  },
  {
    id: 'cursor-sol',
    provider: 'cursor',
    label: 'Cursor account',
    models: [{ id: 'gpt-6-sol', label: 'Sol', efforts: ['high'] }],
  },
];
const draft = () => ({
  version: 2,
  text,
  rules: [],
  unparsed: [],
  chapterAgents: false,
  mask: false,
  roles: {
    coordinator: { provider: 'claude', model: 'opus-5.5', effort: 'high' },
    verifier: [
      { provider: 'codex', model: 'gpt-6-astra' },
      { provider: 'codex', model: 'gpt-6-sol' },
    ],
  },
});

test('model draft validates JSON and catalog without applying anything', async () => {
  let calls = 0;
  const result = await compileRoutingDraft({ text }, cards, async (prompt, signal) => {
    calls++;
    assert.equal(signal.aborted, false);
    assert.match(prompt, /untrusted data/);
    assert.match(prompt, /gpt-6-astra/);
    assert.match(prompt, /efforts/);
    assert.match(prompt, /research/);
    return JSON.stringify(draft());
  });
  assert.equal(calls, 1);
  assert.equal(result.fallback, false);
  assert.deepEqual(result.draft.roles, draft().roles);
  assert.deepEqual(result.draft.rules, []);
  assert.deepEqual(result.draft.unparsed, []);
});

test('junk JSON and invalid schema fall back to the offline owner flow', async () => {
  for (const output of ['not json', '{"version":1}', JSON.stringify({ ...draft(), unknown: true })]) {
    const result = await compileRoutingDraft({ text }, cards, async () => output);
    assert.equal(result.fallback, true);
    assert.equal(result.draft.roles?.coordinator?.model, 'opus-5.5');
    assert.deepEqual(result.draft.roles?.verifier, draft().roles.verifier);
    assert.deepEqual(result.draft.rules, []);
    assert.deepEqual(result.draft.unparsed, []);
  }
});

test('model-only coordinator drafts resolve a unique catalog executor before message routing', async () => {
  const result = await compileRoutingDraft({ text }, cards, async () =>
    JSON.stringify({ ...draft(), roles: { coordinator: { model: 'opus-5.5', effort: 'high' } } }),
  );
  assert.equal(result.fallback, false);
  const input = routedMessage(
    { content: 'Plan this work', mode: 'chat', permissionMode: 'read-only', executionPolicy: 'cli-first' },
    { ...result.draft, updatedAt: '2026-10-31T12:00:00Z' },
    cards,
  );
  assert.equal(input.runtimeId, 'claude');
  assert.equal(input.model, 'opus-5.5');
  assert.equal(input.effort, 'high');
  const ambiguous = await compileRoutingDraft({ text }, cards, async () =>
    JSON.stringify({ ...draft(), roles: { coordinator: { model: 'gpt-6-sol' } } }),
  );
  assert.equal(ambiguous.fallback, false);
  assert.equal(ambiguous.draft.roles?.coordinator, undefined);
  assert.match(ambiguous.draft.unparsed.join('\n'), /ambiguous/);
});

test('compiled drafts preserve supplied categories when the model omits or replaces them', async () => {
  const categories = [{ id: 'custom:legal', label: 'Legal', keywords: ['contract'] }];
  for (const modelCategories of [undefined, [{ id: 'custom:invented', label: 'Invented' }]]) {
    const result = await compileRoutingDraft({ text, categories }, cards, async () =>
      JSON.stringify({
        ...draft(),
        categories: modelCategories,
        rules: [
          { id: 'legal', category: 'custom:legal', candidates: [], strict: false, enabled: true, source: 'parsed' },
        ],
      }),
    );
    assert.equal(result.fallback, false);
    assert.deepEqual(result.draft.categories, categories);
    assert.equal(result.draft.rules[0]?.category, 'custom:legal');
    const withoutCategories = await compileRoutingDraft({ text }, cards, async () =>
      JSON.stringify({ ...draft(), categories: modelCategories }),
    );
    assert.equal(withoutCategories.fallback, false);
    assert.equal(withoutCategories.draft.categories, undefined);
  }
});

test('unknown models, cards, provider mismatches and efforts are dropped with reasons', async () => {
  const result = await compileRoutingDraft({ text }, cards, async () =>
    JSON.stringify({
      ...draft(),
      roles: {
        coordinator: { provider: 'claude', model: 'imaginary' },
        verifier: [
          { runtimeId: 'missing', model: 'gpt-6-astra' },
          { runtimeId: 'claude', provider: 'codex', model: 'gpt-6-astra' },
          { provider: 'codex', model: 'gpt-6-astra', effort: 'ultra' },
          { provider: 'codex', model: 'gpt-6-sol', effort: 'high' },
        ],
      },
      rules: [
        {
          id: 'code',
          category: 'code',
          candidates: [{ provider: 'codex', model: 'unknown' }],
          strict: true,
          enabled: true,
          source: 'parsed',
        },
      ],
    }),
  );
  assert.equal(result.fallback, false);
  assert.equal(result.draft.roles?.coordinator, undefined);
  assert.deepEqual(result.draft.roles?.verifier, [{ provider: 'codex', model: 'gpt-6-sol', effort: 'high' }]);
  assert.equal(result.draft.rules[0]?.enabled, false);
  assert.equal(result.draft.unparsed.length, 5);
  assert.ok(result.draft.unparsed.every((clause) => clause.includes('unavailable')));
});

test('timeout aborts even a runner that never settles and shows the offline draft', async () => {
  let signal: AbortSignal | undefined;
  const result = await compileRoutingDraft(
    { text },
    cards,
    async (_prompt, abort) => {
      signal = abort;
      return new Promise<string>(() => {});
    },
    10,
  );
  assert.equal(result.fallback, true);
  assert.equal(signal?.aborted, true);
  assert.equal(result.draft.roles?.verifier?.length, 2);
});

function hostFixture() {
  const starts: RunInput[] = [],
    cancelled: string[] = [];
  const targets = cards
    .slice(0, 2)
    .map((card) => ({ ...card, enabled: true, command: 'synthetic' })) as RuntimeTarget[];
  const snapshots = cards.slice(0, 2).map((card) => ({
    ...card,
    status: 'ready',
    capabilities: { toolless: true },
  })) as RuntimeSnapshot[];
  const host: Parameters<typeof draftRoutingProfile>[0] = {
    targets,
    snapshots,
    settings: {} as never,
    dataDir: 'C:/synthetic/drafts',
    async start(input, _lease, _signal, _before, created) {
      starts.push(input);
      const record = {
        id: 'synthetic',
        status: 'completed',
        endedAt: 'now',
        output: JSON.stringify(draft()),
      } as RunRecord;
      created?.(record);
      return record;
    },
    cancel(id) {
      cancelled.push(id);
    },
  };
  return { host, starts, cancelled };
}

test('compiler uses one automatic read-only toolless run and avoids billed cards when a subscription exists', async () => {
  const { host, starts } = hostFixture();
  host.snapshots[1]!.authMode = 'apiKey';
  assert.equal((await draftRoutingProfile(host, { text })).fallback, false);
  assert.equal(starts.length, 1);
  const input = starts[0]!;
  assert.deepEqual(input.automaticExecutors, ['claude']);
  assert.equal(input.automaticExecutorSelection, true);
  assert.equal(input.permissionMode, 'read-only');
  assert.equal(input.explicitNoTools, true);
  assert.equal(input.prohibitCommands, true);
  assert.equal(input.untrustedContent, true);
  assert.equal(input.agentCalls, false);
  assert.equal(input.allowExecutorFallback, false);
  assert.equal(input.runtimeId, undefined);
  assert.equal(input.model, undefined);
  assert.equal(input.executionPolicy, undefined);
  host.snapshots[0]!.authMode = 'apiKey';
  await draftRoutingProfile(host, { text });
  assert.deepEqual(starts[1]!.automaticExecutors, ['claude', 'codex']);
  assert.equal(starts[1]!.executionPolicy, undefined);
});

test('paid-only draft helpers pass the real router while keeping API budget enforcement', async () => {
  const { host, starts } = hostFixture();
  const now = Date.parse('2026-10-31T12:00:00Z');
  const api: RuntimeSnapshot = {
    id: 'paid-api',
    label: 'Synthetic API',
    provider: 'pi',
    gateway: 'api',
    apiProvider: 'openai',
    environment: 'native',
    installed: true,
    status: 'ready',
    accounting: { mode: 'usage', source: 'events' },
    models: [{ id: 'gpt-6-sol', label: 'Sol', efforts: ['medium', 'high'], price: { input: 1, output: 2 } }],
    quota: { status: 'unknown', source: 'fixture', observedAt: new Date(now).toISOString(), windows: [] },
    capabilities: { execute: true, resume: false, cancel: true, approvals: false, toolless: true },
    refreshedAt: new Date(now).toISOString(),
    apiBudgetState: apiBudgetView(
      apiBudgetPolicy({ limitUsd: 100 }, undefined, new Date(now).toISOString()),
      0,
      0,
      0,
      now,
    ),
  };
  host.snapshots = [api];
  host.targets = [
    { id: api.id, label: api.label, provider: api.provider, enabled: true, command: 'synthetic' } as RuntimeTarget,
  ];
  host.settings = {
    refreshSeconds: 60,
    reservePercent: 10,
    maxQuotaAgeSeconds: 180,
    preferCli: true,
    designProvider: 'claude',
    architectureProvider: 'codex',
    routineProvider: 'codex',
    unknownQuotaPolicy: 'manual-only',
    defaultProjectPath: 'C:/synthetic/drafts',
    maxConcurrentRuns: 2,
  } satisfies Settings;
  await draftRoutingProfile(host, { text });
  const input = starts[0]!;
  assert.equal(route(input, host.snapshots, host.settings, new Set(), now).runtimeId, api.id);
  assert.throws(() => route({ ...input, executionPolicy: undefined }, host.snapshots, host.settings, new Set(), now));
  api.apiBudgetState = apiBudgetView(api.apiBudgetState!.policy, 100, 0, 0, now);
  assert.throws(() => route(input, host.snapshots, host.settings, new Set(), now), /预算|额度/);

  const native: RuntimeSnapshot = {
    ...api,
    id: 'native-api-key',
    provider: 'claude',
    gateway: undefined,
    apiProvider: undefined,
    authMode: 'apiKey',
    apiBudgetState: undefined,
    quota: {
      ...api.quota,
      status: 'known',
      windows: [{ id: 'weekly', label: 'Weekly', usedPercent: 0, resetsAt: new Date(now + 86_400_000).toISOString() }],
    },
  };
  host.snapshots = [native];
  host.targets = [{ ...host.targets[0]!, id: native.id, provider: native.provider }];
  await draftRoutingProfile(host, { text });
  const nativeInput = starts[1]!;
  assert.equal(nativeInput.executionPolicy, undefined);
  assert.equal(route(nativeInput, host.snapshots, host.settings, new Set(), now).runtimeId, native.id);
});

test('no available toolless card falls back without starting a run', async () => {
  const { host, starts } = hostFixture();
  host.snapshots[0]!.capabilities.toolless = false;
  host.settings.excludedExecutors = ['codex'];
  assert.equal((await draftRoutingProfile(host, { text })).fallback, true);
  assert.equal(starts.length, 0);
});

test('timeout cancels a created run and also cancels a run created after the deadline', async () => {
  for (const late of [false, true]) {
    const { host, cancelled } = hostFixture();
    let release: (() => void) | undefined;
    host.start = async (_input, _lease, _signal, _before, created) => {
      if (late)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      const record = { id: 'pending', status: 'running', output: '' } as RunRecord;
      created?.(record);
      return record;
    };
    assert.equal((await draftRoutingProfile(host, { text }, 10)).fallback, true);
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(cancelled, ['pending']);
  }
});
