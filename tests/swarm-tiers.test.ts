import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quotaPoolKey, route, type RouteCapacity } from '../src/server/routing.ts';
import type { ModelInfo, RunInput, RuntimeSnapshot, Settings } from '../src/shared/types.ts';

const now = Date.parse('2026-10-10T12:00:00Z');
const settings: Settings = {
  refreshSeconds: 60,
  reservePercent: 10,
  maxQuotaAgeSeconds: 180,
  preferCli: true,
  designProvider: 'claude',
  architectureProvider: 'codex',
  routineProvider: 'codex',
  unknownQuotaPolicy: 'manual-only',
  defaultProjectPath: '/fixture',
  maxConcurrentRuns: 0,
};
const efforts = ['low', 'medium', 'high', 'xhigh'];
const model = (id: string): ModelInfo => ({ id, label: id, efforts });
const runtime = (id: string, provider: RuntimeSnapshot['provider'], models: string[], used = 10): RuntimeSnapshot => ({
  id,
  provider,
  label: id,
  environment: 'native',
  installed: true,
  status: 'ready',
  accountFingerprint: id,
  models: models.map(model),
  refreshedAt: new Date(now).toISOString(),
  capabilities: { execute: true, resume: true, cancel: true, approvals: false },
  quota: {
    status: 'known',
    source: 'Fixture only',
    observedAt: new Date(now).toISOString(),
    windows: [{ id: 'week', label: 'Week', usedPercent: used, resetsAt: new Date(now + 6 * 3_600_000).toISOString() }],
  },
});
const claude = () => runtime('claude', 'claude', ['claude-haiku-5', 'claude-sonnet-5', 'claude-opus-5']);
const base: RunInput = { prompt: 'Organise the work', projectPath: '/fixture', kind: 'general' };
const pick = (
  input: Partial<RunInput>,
  snapshots: RuntimeSnapshot[],
  changes: Partial<Settings> = {},
  capacity?: RouteCapacity,
) => route({ ...base, ...input }, snapshots, { ...settings, ...changes }, capacity ?? new Set(), now);

test('the swarm coordinator plans and merges on the strongest tier at high effort', () => {
  const plain = pick({}, [claude()]);
  assert.deepEqual([plain.model, plain.effort], ['claude-sonnet-5', 'medium'], 'an ordinary task stays balanced');
  const coordinator = pick({ coordinator: true }, [claude()]);
  assert.deepEqual([coordinator.model, coordinator.effort], ['claude-opus-5', 'high']);
  assert.ok(coordinator.reasons.some((reason) => reason.startsWith('蜂群协调者')));
  assert.deepEqual(
    [pick({ coordinator: true }, [claude()], { routeGoal: 'quality' }).effort],
    ['xhigh'],
    'quality-first goes one step higher',
  );
  const thrifty = pick({ coordinator: true }, [claude()], { routeGoal: 'save' });
  assert.deepEqual(
    [thrifty.model, thrifty.effort],
    ['claude-sonnet-5', 'medium'],
    'the user’s saving goal still bounds it',
  );
  const pinned = pick({ coordinator: true, model: 'claude-haiku-5', effort: 'low' }, [claude()]);
  assert.deepEqual([pinned.model, pinned.effort], ['claude-haiku-5', 'low'], 'a pin always wins');
  // The category prefers Codex, which only offers a standard model; the coordinator goes where the strong tier is.
  const codex = runtime('codex', 'codex', ['gpt-6-sol']);
  assert.equal(pick({}, [codex, claude()], { routePreferencesEnabled: true }).runtimeId, 'codex');
  assert.equal(pick({ coordinator: true }, [codex, claude()], { routePreferencesEnabled: true }).runtimeId, 'claude');
  // A coordinator pinned to a light-only account is not refused; it asks for the strongest tier, it does not demand it.
  const light = runtime('light', 'claude', ['claude-haiku-5']);
  assert.equal(pick({ coordinator: true, runtimeId: 'light' }, [light]).model, 'claude-haiku-5');
  assert.equal(
    pick({ coordinator: true, agentChild: true }, [claude()]).model,
    'claude-sonnet-5',
    'members are not coordinators',
  );
});

test('read-only members prefer the light tier at low effort unless the work is complex, novel writing or asked up', () => {
  const member = (prompt: string, extra: Partial<RunInput> = {}) =>
    pick({ prompt, routingPrompt: prompt, agentChild: true, readOnlyMember: true, ...extra }, [claude()]);
  const review = member('Review the parser change and list problems');
  assert.deepEqual([review.model, review.effort], ['claude-haiku-5', 'low']);
  const writer = pick({ prompt: 'Review the parser change and list problems', agentChild: true }, [claude()]);
  assert.equal(writer.model, 'claude-sonnet-5', 'a writing member keeps the standard tier');
  assert.equal(member('Determine the root cause of this complex failure').model, 'claude-opus-5');
  assert.equal(member('Read chapter 3 and note what feels unnatural', { fiction: true }).model, 'claude-sonnet-5');
  const asked = member('Review the parser change and list problems', { suggestedTier: 'standard' });
  assert.deepEqual([asked.model, asked.effort], ['claude-sonnet-5', 'medium']);
  assert.equal(member('Review the parser change', { suggestedTier: 'strong' }).model, 'claude-opus-5');
  assert.equal(
    member('Determine the root cause of this complex failure', { suggestedTier: 'light' }).model,
    'claude-haiku-5',
    'the caller’s tier replaces the guess',
  );
  assert.equal(member('Review it', { suggestedTier: 'light', suggestedEffort: 'high' }).effort, 'high');
  assert.equal(
    pick({ prompt: 'Review it', agentChild: true, readOnlyMember: true }, [claude()], { routeGoal: 'quality' }).model,
    'claude-opus-5',
    'quality-first never drops to light',
  );
});

test('a light member goes to the account offering a light model, and to an API executor when subscriptions run low', () => {
  const standardOnly = runtime('standard-only', 'codex', ['gpt-6-sol']);
  const withLight = runtime('with-light', 'claude', ['claude-haiku-5', 'claude-sonnet-5']);
  const member = { prompt: 'Read the docs and summarise', agentChild: true, readOnlyMember: true };
  assert.equal(pick(member, [standardOnly, withLight]).runtimeId, 'with-light');
  const api = runtime('api-pi', 'pi', ['deepseek/deepseek-flash']);
  api.quota = { status: 'unknown', source: 'Synthetic API', observedAt: null, windows: [] };
  api.accounting = { mode: 'usage', source: 'Synthetic API' };
  const healthy = runtime('healthy', 'claude', ['claude-haiku-5'], 20);
  const scarce = runtime('scarce', 'claude', ['claude-haiku-5', 'claude-sonnet-5'], 80);
  const cliFirst = { ...member, executionPolicy: 'cli-first' as const };
  assert.equal(pick(cliFirst, [healthy, api]).runtimeId, 'healthy', 'plenty of subscription left: use it');
  assert.equal(pick(cliFirst, [scarce, api]).runtimeId, 'api-pi', 'nearly used up: the cheap API takes light work');
  assert.equal(
    pick({ ...cliFirst, prompt: 'Update the parser', readOnlyMember: false }, [scarce, api]).runtimeId,
    'scarce',
    'a writing member keeps the subscription',
  );
});

test('light read-only members may share an account more widely than writers', () => {
  const account = runtime('roomy', 'claude', ['claude-haiku-5', 'claude-sonnet-5'], 3);
  const busy = (count: number): RouteCapacity => ({
    reservations: new Map([[quotaPoolKey(account), count]]),
    settlingPools: new Set(),
  });
  const reader = { prompt: 'Read the docs and summarise', agentChild: true, readOnlyMember: true };
  const writer = { prompt: 'Update the parser', agentChild: true };
  assert.equal(pick(reader, [account], {}, busy(6)).runtimeId, 'roomy');
  assert.throws(() => pick(writer, [account], {}, busy(5)), /同时最多 5 个成员/);
  assert.throws(() => pick(reader, [account], {}, busy(7)), /同时最多 7 个成员/);
});
