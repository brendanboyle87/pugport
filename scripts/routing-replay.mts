import { readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { layaInputCompacted, layaPolicy } from '../src/server/laya-policy.ts';
import { applyLayaRunHints, flagLocalComplexity } from '../src/server/laya-workflow.ts';
import { modelTier } from '../src/server/model-selection.ts';
import { locallyComplex, quotaPoolKey, route } from '../src/server/routing.ts';
import type { LayaReviewRecord } from '../src/shared/laya.ts';
import type { Provider, RunInput, RuntimeSnapshot, RuntimeTarget, Settings, Workflow } from '../src/shared/types.ts';

type Tier = 'light' | 'standard' | 'strong';
type Value = { tier: Tier | 'unknown'; effort: string; provider: string; model?: string };
type Failure = { id: string; date: string; rule: string; code: string; expected: Value; actual: Value };
const now = Date.parse('2026-10-27T01:00:00Z');
const iso = (offset = 0) => new Date(now + offset).toISOString();
const providers = ['codex', 'claude', 'grok', 'cursor'] as const;
const models: Record<(typeof providers)[number], string[]> = {
  codex: ['gpt-6.1-terra', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'],
  claude: ['claude-opus-4-6', 'claude-sonnet-4-6'],
  grok: ['grok-4.7'],
  cursor: ['composer-2.5', 'claude-opus-4-6'],
};
export const targets: RuntimeTarget[] = providers.map((provider) => ({
  id: provider,
  provider,
  label: provider,
  command: provider,
  environment: 'native',
  enabled: true,
}));
export const snapshots: RuntimeSnapshot[] = providers.map((provider) => ({
  id: provider,
  provider,
  label: provider,
  accountFingerprint: provider,
  environment: 'native',
  installed: true,
  status: 'ready',
  models: models[provider].map((id, index) => ({
    id,
    label: id,
    efforts: ['low', 'medium', 'high'],
    ...(provider === 'cursor' ? { quotaPool: index === 0 ? ('cursor' as const) : ('other' as const) } : {}),
  })),
  capabilities: { execute: true, resume: true, cancel: true, approvals: true },
  quota: {
    status: 'known',
    source: 'fixture',
    observedAt: iso(),
    windows:
      provider === 'cursor'
        ? (['cursor', 'other'] as const).map((pool) => ({
            id: pool,
            label: pool,
            modelPool: pool,
            usedPercent: 40,
            resetsAt: iso(7 * 86400000),
          }))
        : [{ id: 'week', label: 'week', usedPercent: 40, resetsAt: iso(7 * 86400000) }],
  },
  refreshedAt: iso(),
}));
const settings: Settings = {
  refreshSeconds: 60,
  reservePercent: 10,
  maxQuotaAgeSeconds: 180,
  preferCli: false,
  routePreferencesEnabled: false,
  routeGoal: 'balanced',
  designProvider: 'claude',
  architectureProvider: 'codex',
  routineProvider: 'cursor',
  unknownQuotaPolicy: 'manual-only',
  defaultProjectPath: 'synthetic',
  maxConcurrentRuns: 100,
};
const mapping = {
  simple: { tier: 'light', effort: 'low' },
  standard: { tier: 'standard', effort: 'medium' },
  complex: { tier: 'strong', effort: 'high' },
} as const;
const blank = (): Value => ({ tier: 'unknown', effort: 'unknown', provider: 'unknown' });
const safeId = (id: unknown) =>
  typeof id === 'string' &&
  /^\d{4}-\d{2}-\d{2}\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)
    ? id
    : 'unknown';
const safeDate = (date: unknown) =>
  typeof date === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(date) &&
  Number.isFinite(Date.parse(date))
    ? new Date(date).toISOString()
    : 'unknown';
const safeEffort = (value: unknown) =>
  typeof value === 'string' &&
  ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'minimal', 'off', 'none'].includes(value)
    ? value
    : 'unknown';
const fixedProvider = (id: string | undefined) => providers.find((provider) => provider === id) ?? 'unknown';

/** `extra` sets what a record does not carry, such as a step's permission, size and file-change requirement. */
export function replayRoute(
  record: LayaReviewRecord,
  extra: Partial<RunInput> = {},
  settingsPatch: Partial<Settings> = {},
) {
  const config = { ...settings, ...settingsPatch };
  const policy = layaPolicy(record.state, record.inference, {}, targets);
  // As the workspace does: a request the local classifier reads as complex is only flagged.
  flagLocalComplexity(policy, record.inference, config.routeGoal, locallyComplex(record.state.message));
  const base: RunInput = { prompt: record.state.message, kind: 'general', projectPath: 'synthetic', ...extra };
  const workflow = {
    input: {},
    laya: { policy, inference: record.inference },
    requiresConfirmation: false,
  } as Workflow;
  const input = applyLayaRunHints(base, workflow);
  const decision = route(input, snapshots, config, new Set(), now);
  const source = snapshots.find((item) => item.id === decision.runtimeId)!;
  const model = source.models.find((item) => item.id === decision.model)!;
  const actual: Value = {
    tier: modelTier(model, source.provider),
    effort: safeEffort(decision.effort),
    provider: source.provider,
    model: model.id,
  };
  return { policy, actual, reasons: decision.reasons };
}

const difficultyConflict = (conflicts: string[]) =>
  conflicts.some((item) => /Model (?:command|input-modality|browser) judgment/.test(item));
const executorConflict = (conflicts: string[]) =>
  conflicts.some((item) => /executor|assignments|selection/i.test(item));
const equal = (actual: Value, expected: Value, provider = false) =>
  actual.tier === expected.tier &&
  actual.effort === expected.effort &&
  (!provider || (actual.provider === expected.provider && actual.model === expected.model));
const expectedFor = (record: LayaReviewRecord): Value | undefined => {
  if (record.inference.status !== 'ok' || layaInputCompacted(record.inference))
    return { tier: 'strong', effort: 'high', provider: 'codex', model: 'gpt-6.1-terra' };
  const difficulty = record.inference.choices?.difficulty;
  return difficulty && difficulty !== 'unclear' ? { ...mapping[difficulty], provider: 'any' } : undefined;
};
type RecordedRoute = NonNullable<LayaReviewRecord['outcome']>['routes'][number];
function recordedValue(item: RecordedRoute): Value {
  // Records from 10-28 on carry the target tier; older ones only have it in the reason text.
  const tierMatch = /自动模型选择：目标(轻量|常规|高能力)档/.exec(item.reason ?? '');
  const tiers: Record<string, Tier> = { 轻量: 'light', 常规: 'standard', 高能力: 'strong' };
  return {
    tier: item.targetTier ?? (tierMatch ? tiers[tierMatch[1]!]! : 'unknown'),
    effort: safeEffort(
      item.effort ?? /自动思考强度：(minimal|low|medium|high|xhigh|ultra|max)/.exec(item.reason ?? '')?.[1],
    ),
    provider: fixedProvider(item.runtimeId),
  };
}
export function checkRecord(record: LayaReviewRecord, actual: Value, conflicts: string[]): Failure[] {
  const failures: Failure[] = [];
  const id = safeId(record.id),
    date = safeDate(record.createdAt);
  const add = (rule: string, code: string, expected: Value, observed: Value) =>
    failures.push({ id, date, rule, code, expected, actual: observed });
  const expected = expectedFor(record);
  const unjudged = record.inference.status !== 'ok' || layaInputCompacted(record.inference);
  if (unjudged && expected) {
    if (!equal(actual, expected, true)) add('R1', 'route_mismatch', expected, actual);
    if (
      record.outcome?.assessment?.status === 'skipped' &&
      /No spare execution capacity/i.test(record.outcome.assessment.reason)
    )
      add('R1', 'assessment_capacity_skipped', expected, actual);
  }
  if (!unjudged && !difficultyConflict(conflicts)) {
    if (!expected) add('R2', 'difficulty_unknown', blank(), actual);
    else if (!equal(actual, expected)) add('R2', 'difficulty_mismatch', expected, actual);
  }
  if (
    executorConflict(conflicts) &&
    (unjudged || !difficultyConflict(conflicts)) &&
    expected &&
    !equal(actual, expected, unjudged)
  )
    add('R3', 'executor_conflict_mismatch', expected, actual);
  const routes = record.outcome?.routes;
  if (!routes?.length) add('R4', 'missing_routes', blank(), blank());
  else {
    const first = recordedValue(routes[0]!);
    const rank: Record<Tier, number> = { light: 0, standard: 1, strong: 2 };
    if (first.tier === 'unknown') add('R4', 'missing_demand', blank(), first);
    for (const step of routes.slice(1)) {
      const next = recordedValue(step);
      if (next.tier === 'unknown') add('R4', 'missing_demand', first, next);
      else if (first.tier !== 'unknown' && rank[next.tier] < rank[first.tier]) {
        // A lower tier is allowed only for a step that started after a completed assessment.
        const assessment = record.outcome?.assessment;
        const after = Date.parse(step.startedAt ?? '') >= Date.parse(assessment?.completedAt ?? '');
        if (assessment?.status !== 'completed') add('R4', 'tier_dropped', first, next);
        else if (!assessment.completedAt || !step.startedAt) add('R4', 'assessment_order_unknown', first, next);
        else if (!after) add('R4', 'tier_dropped_before_assessment', first, next);
      }
    }
  }
  return failures;
}
export function checkDistribution(counts: Record<string, number>): boolean {
  return (
    providers.reduce((sum, provider) => sum + (counts[provider] ?? 0), 0) === 20 &&
    providers.every(
      (provider) =>
        Number.isInteger(counts[provider] ?? 0) && (counts[provider] ?? 0) >= 0 && (counts[provider] ?? 0) <= 10,
    )
  );
}
export function distribution() {
  const counts: Record<string, number> = Object.fromEntries(providers.map((provider) => [provider, 0]));
  const reservations = new Map<string, number>();
  for (let i = 0; i < 20; i++) {
    const selected = route(
      {
        prompt: 'Evaluate the project requirements',
        kind: 'general',
        projectPath: 'synthetic',
        suggestedTier: 'standard',
        suggestedEffort: 'medium',
      },
      snapshots,
      settings,
      { reservations, settlingPools: new Set() },
      now,
    );
    const source = snapshots.find((item) => item.id === selected.runtimeId)!;
    counts[source.provider] = (counts[source.provider] ?? 0) + 1;
    const key = quotaPoolKey(source);
    reservations.set(key, (reservations.get(key) ?? 0) + 1);
  }
  return counts;
}
export function summarize(records: LayaReviewRecord[]) {
  const failures: Failure[] = [];
  let fallback = 0,
    conflicts = 0,
    assessments = 0,
    completed = 0;
  for (const record of records) {
    try {
      const result = replayRoute(record);
      fallback += Number(record.inference.status === 'fallback');
      conflicts += Number(result.policy.conflicts.length > 0);
      assessments += Number(!!record.outcome?.assessment);
      completed += Number(record.outcome?.assessment?.status === 'completed');
      failures.push(...checkRecord(record, result.actual, result.policy.conflicts));
    } catch {
      failures.push({
        id: safeId(record?.id),
        date: safeDate(record?.createdAt),
        rule: 'R1-R4',
        code: 'record_invalid',
        expected: blank(),
        actual: blank(),
      });
    }
  }
  const counts = distribution();
  return {
    records: records.length,
    failures,
    metrics: {
      fallback: { count: fallback, total: records.length },
      conflicts: { count: conflicts, total: records.length },
      assessmentCompleted: { count: completed, total: assessments },
    },
    r5: { counts, passed: checkDistribution(counts) },
    passed: records.length > 0 && failures.length === 0 && checkDistribution(counts),
  };
}

export async function readRecords(data: string, limit: number): Promise<LayaReviewRecord[]> {
  const root = join(resolve(data), 'routing-training');
  const records: LayaReviewRecord[] = [];
  for (const directory of await readdir(root, { withFileTypes: true })) {
    if (!directory.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(directory.name)) continue;
    for (const file of await readdir(join(root, directory.name), { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      const record = JSON.parse(await readFile(join(root, directory.name, file.name), 'utf8')) as LayaReviewRecord;
      if (record.origin !== 'steering') records.push(record);
    }
  }
  return records.sort((a, b) => safeDate(b.createdAt).localeCompare(safeDate(a.createdAt))).slice(0, limit);
}
async function main() {
  const args = process.argv.slice(2);
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (!key || !['--data', '--limit', '--json'].includes(key) || !value || value.startsWith('--') || opts[key])
      throw new Error('invalid_arguments');
    opts[key] = value;
  }
  const limit = opts['--limit'] === undefined ? 50 : Number(opts['--limit']);
  if (!opts['--data'] || !Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid_arguments');
  if (opts['--json']) {
    const dataRoot = await realpath(opts['--data']);
    const output = join(await realpath(dirname(resolve(opts['--json']))), basename(opts['--json']));
    const path = relative(dataRoot, output);
    if (
      !path ||
      (!path.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && path !== '..' && !isAbsolute(path))
    )
      throw new Error('output_inside_data');
  }
  const result = summarize(await readRecords(opts['--data'], limit));
  const output = JSON.stringify(result, null, 2);
  if (opts['--json']) await writeFile(opts['--json'], output + '\n', { flag: 'wx' });
  process.stdout.write(output + '\n');
  if (!result.passed) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    process.stderr.write('replay_error\n');
    process.exitCode = 1;
  });
}
