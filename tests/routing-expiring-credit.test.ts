import assert from 'node:assert/strict';
import { test } from 'node:test';
import { route, type RouteCapacity } from '../src/server/routing.ts';
import { apiBudgetPolicy, apiBudgetView } from '../src/server/api-budget.ts';
import { burnKey } from '../src/server/quota-history.ts';
import { applyLayaRunHints } from '../src/server/laya-workflow.ts';
import type { LayaChoices } from '../src/shared/laya.ts';
import type { RunInput, RuntimeSnapshot, Settings, Workflow } from '../src/shared/types.ts';

// Synthetic mirror of a real case: two behind-pace expiring API credits lost to a subscription whose weekly window
// was forecast to go partly unused. No real accounts, no network.
const now = Date.parse('2026-11-04T02:39:00Z');
const hour = 3_600_000;
const day = 24 * hour;
const iso = (offset = 0) => new Date(now + offset).toISOString();
const settings: Settings = {
  refreshSeconds: 60,
  reservePercent: 10,
  maxQuotaAgeSeconds: 180,
  preferCli: false,
  routePreferencesEnabled: false,
  routeGoal: 'balanced',
  designProvider: 'claude',
  architectureProvider: 'codex',
  routineProvider: 'codex',
  unknownQuotaPolicy: 'manual-only',
  defaultProjectPath: 'synthetic',
  maxConcurrentRuns: 8,
};
// An ordinary chat question: nothing to run, so the API harness can take it.
const input: RunInput = {
  prompt: '用三句话解释一下浏览器缓存和 CDN 缓存有什么区别',
  kind: 'general',
  projectPath: 'synthetic',
  permissionMode: 'workspace-write',
  suggestedTier: 'standard',
  suggestedEffort: 'medium',
};
const base = {
  environment: 'native',
  installed: true,
  status: 'ready',
  capabilities: { execute: true, resume: true, cancel: true, approvals: true },
  refreshedAt: iso(),
} as const;
/** A subscription CLI: 24% of the weekly window used, resetting in three days. */
const subscription = (id: string, label: string, provider: 'claude' | 'codex'): RuntimeSnapshot => ({
  ...base,
  id,
  provider,
  label,
  accountFingerprint: id,
  models: [
    provider === 'claude'
      ? { id: 'synthetic-sonnet', label: 'Sonnet', efforts: ['low', 'medium', 'high'] }
      : { id: 'synthetic-sol', label: 'Sol', efforts: ['low', 'medium', 'high'] },
  ],
  quota: {
    status: 'known',
    source: 'synthetic',
    observedAt: iso(),
    windows: [{ id: 'weekly', label: 'Weekly', durationMinutes: 10080, usedPercent: 24, resetsAt: iso(3 * day) }],
  },
});
/** An expiring credit `limit` dollars, `spent` used, expiring in `expiresIn`, recorded from `startedAgo`. */
const credit = (
  id: string,
  label: string,
  apiProvider: string,
  limit: number,
  spent: number,
  expiresIn: number,
  startedAgo: number,
  patch: Partial<RuntimeSnapshot> = {},
): RuntimeSnapshot => ({
  ...base,
  id,
  provider: 'pi',
  gateway: 'api',
  apiProvider,
  label,
  models: [{ id: `${id}-model`, label: 'Model', efforts: ['low', 'medium', 'high'], price: { input: 3, output: 15 } }],
  accounting: { mode: 'usage', source: 'synthetic' },
  quota: { status: 'unknown', source: 'synthetic', observedAt: null, windows: [] },
  apiBudgetState: apiBudgetView(
    apiBudgetPolicy({ limitUsd: limit, expiresAt: iso(expiresIn) }, undefined, iso(-startedAgo)),
    spent,
    0,
    0,
    now,
  ),
  ...patch,
});
const work = subscription('cli-work', 'Claude Work', 'claude');
// $176.45 of $200, under three hours left: about $198.66 planned by now.
const soon = credit('api-soon', 'Anthropic', 'anthropic', 200, 176.45, 2.25 * hour, 30 * day);
// $32.22 of $56, three days left of nine: about $37.33 planned by now.
const later = credit('api-later', 'OpenAI临时', 'openai', 56, 32.22, 3 * day, 6 * day);
// The subscription's usual pace leaves about a third of its weekly window unused at the reset.
const capacity = (...ids: string[]): RouteCapacity => ({
  reservations: new Map(),
  settlingPools: new Set(),
  burn: new Map(ids.map((id) => [burnKey(id, 'weekly'), { account: '', perHour: 0.6, periods: 3 }])),
});
const orders = <T>(items: T[]) => [items, [...items].reverse(), [items[1]!, items[0]!, ...items.slice(2)]];

test('behind-pace expiring credit goes before a subscription with forecast waste, earliest expiry first', () => {
  for (const preferCli of [false, true])
    for (const sources of orders([work, soon, later])) {
      const decision = route(input, sources, { ...settings, preferCli }, capacity(work.id), now);
      const why = decision.reasons.join('\n');
      assert.equal(decision.runtimeId, soon.id, why);
      assert.ok(why.includes('落后计划'), why);
      // The other behind card is named with the reason it waits this time.
      assert.ok(
        decision.reasons.some((reason) => reason.startsWith('OpenAI临时') && reason.includes('Anthropic')),
        why,
      );
    }
});

test('a behind-pace card that cannot take this task is named with the reason', () => {
  // A credit whose only model is below the requested tier keeps losing, and the trace says why.
  const light = credit('api-light', 'Light credit', 'deepseek', 56, 32.22, 3 * day, 6 * day, {
    models: [
      { id: 'light-model', label: 'Light', efforts: ['low'], lightweight: true, price: { input: 1, output: 2 } },
    ],
  });
  const decision = route(input, [work, light], settings, capacity(work.id), now);
  assert.equal(decision.runtimeId, work.id);
  assert.ok(
    decision.reasons.some((reason) => reason.startsWith('Light credit') && reason.includes('档')),
    decision.reasons.join('\n'),
  );
  // Commands this turn needs, in a chat whose folder is not trusted: the API harness is rejected and named.
  const commands = route(
    { ...input, prompt: '运行测试并修复失败的用例' },
    [work, soon],
    settings,
    capacity(work.id),
    now,
  );
  assert.equal(commands.runtimeId, work.id);
  assert.ok(
    commands.reasons.some((reason) => reason.startsWith('Anthropic') && reason.includes('命令')),
    commands.reasons.join('\n'),
  );
});

test('the same rule covers a newly added API card and a CLI card carrying an expiring credit', () => {
  // A differently named API card on another gateway provider, nearly spent but still behind its line.
  const added = credit('api-added', 'Nimbus 赠金', 'synthetic-gateway', 120, 110, 20 * hour, 30 * day);
  for (const sources of orders([work, added]).slice(0, 2)) {
    const decision = route(input, sources, settings, capacity(work.id), now);
    assert.equal(decision.runtimeId, added.id, decision.reasons.join('\n'));
  }
  // A new CLI card with a time-limited credit attached, against another subscription with forecast waste.
  const other = subscription('cli-other', 'Other CLI', 'claude');
  const cli = subscription('cli-orbit', 'Orbit CLI', 'codex');
  const orbit: RuntimeSnapshot = {
    ...cli,
    models: cli.models.map((model) => ({ ...model, price: { input: 2, output: 8 } })),
    apiBudgetState: added.apiBudgetState,
  };
  for (const sources of orders([other, orbit]).slice(0, 2)) {
    const decision = route(input, sources, settings, capacity(other.id, orbit.id), now);
    assert.equal(decision.runtimeId, orbit.id, decision.reasons.join('\n'));
  }
  // Once the CLI card is back on its line, the subscription waste decides again.
  const onLine = {
    ...orbit,
    apiBudgetState: apiBudgetView(added.apiBudgetState!.policy, 113, 0, 0, now),
  };
  assert.equal(route(input, [other, onLine], settings, capacity(other.id), now).runtimeId, other.id);
});

// The real request: a video link to turn into HTML with key-frame screenshots and subtitles, in a chat with no project.
const video: RunInput = {
  ...input,
  prompt:
    'https://www.bilibili.com/video/BV1Synthetic\n\n你把这个视频转换成HTML，相对的里面的关键帧截图截出来，然后把对应的字幕列出来',
};
const layaWorkflow = (content: string, choices: Partial<LayaChoices>) =>
  ({
    input: { content },
    laya: {
      inference: {
        status: 'ok',
        reason: 'accepted',
        modelVersion: 'pugport-laya-v4',
        latencyMs: 1,
        choices: {
          task_type: 'conversation',
          difficulty: 'standard',
          web_search: 'no',
          input_modality: 'text',
          document_read: 'no',
          media_output: 'none',
          project_access: 'none',
          run_commands: 'no',
          browser_use: 'no',
          executor_intent: 'none',
          ...choices,
        },
      },
    },
  }) as unknown as Workflow;

test('a media conversion in an untrusted chat skips API-harness cards with a visible reason', () => {
  const added = credit('api-added', 'Nimbus 赠金', 'synthetic-gateway', 120, 110, 20 * hour, 30 * day);
  // The words alone, or Laya's run-commands judgment alone, each mark the turn as needing programs.
  const variants: RunInput[] = [
    video,
    { ...input, prompt: 'https://www.bilibili.com/video/BV1Synthetic', needsLocalPrograms: true },
  ];
  for (const turn of variants) {
    const decision = route(turn, [work, soon, later, added], settings, capacity(work.id), now);
    const why = decision.reasons.join('\n');
    assert.equal(decision.runtimeId, work.id, why);
    // Every API-harness card, whatever its name, is named with the same reason.
    for (const label of ['Anthropic', 'OpenAI临时', 'Nimbus 赠金'])
      assert.ok(
        decision.reasons.some((reason) => reason.startsWith(`${label}：Pi 只在可信项目`) && reason.includes('命令')),
        why,
      );
  }
  assert.ok(
    route(video, [work, soon], settings, capacity(work.id), now).reasons.some((reason) => reason.includes('本机程序')),
  );
  // In a trusted project Pi runs commands itself, so behind-pace credit goes first again.
  const trusted = { ...capacity(work.id), trustedProject: true };
  assert.equal(route(video, [work, soon, added], settings, trusted, now).runtimeId, soon.id);
  // A read-only turn runs nothing locally either.
  assert.equal(
    route({ ...video, permissionMode: 'read-only' }, [work, soon], settings, capacity(work.id), now).runtimeId,
    soon.id,
  );
});

test('ordinary questions still go to behind-pace expiring credit', () => {
  const added = credit('api-added', 'Nimbus 赠金', 'synthetic-gateway', 120, 110, 20 * hour, 30 * day);
  for (const prompt of [
    '关键帧是什么意思？',
    '把这段话翻译成英文：今天天气很好',
    '这个视频讲了什么？我只想知道大意',
    'What is a keyframe in animation?',
    'Explain how video compression works in two sentences',
  ]) {
    assert.equal(
      route({ ...input, prompt }, [work, soon], settings, capacity(work.id), now).runtimeId,
      soon.id,
      prompt,
    );
    assert.equal(route({ ...input, prompt }, [work, added], settings, capacity(work.id), now).runtimeId, added.id);
  }
});

test("only Laya's run-commands judgment marks the turn as needing local programs", () => {
  const write = { ...input, permissionMode: 'workspace-write' } as RunInput;
  const link = 'https://www.bilibili.com/video/BV1Synthetic 讲了什么';
  assert.equal(applyLayaRunHints(write, layaWorkflow('跑一下', { run_commands: 'yes' })).needsLocalPrograms, true);
  // A video link or a media judgment alone does not: its transcript is pre-read, and a Pi refusal still hands off.
  assert.equal(applyLayaRunHints(write, layaWorkflow(link, {})).needsLocalPrograms, undefined);
  assert.equal(applyLayaRunHints(write, layaWorkflow('转一下', { task_type: 'media' })).needsLocalPrograms, undefined);
  assert.equal(applyLayaRunHints(write, layaWorkflow('什么是缓存？', {})).needsLocalPrograms, undefined);
});
