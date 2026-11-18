import { z } from 'zod';
import { countChecks } from '../../shared/lane-github.ts';
import { repositorySchema } from './config.ts';
import type { Gh } from './gh.ts';

export function ciState(rollup: unknown, required: string[]) {
  const names = [...new Set(required.filter((name) => !name.startsWith('pugport/')))];
  const missing: string[] = [],
    failed: string[] = [],
    pending: string[] = [];
  const rows = Array.isArray(rollup) ? rollup : [];
  if (!names.length) missing.push('no required checks configured');
  for (const name of names) {
    const matches = rows.filter((row) => row && (row.name ?? row.context) === name);
    if (!matches.length) {
      missing.push(name);
      continue;
    }
    const checks = countChecks(matches);
    if (checks.failed) failed.push(name);
    else if (checks.pending) pending.push(name);
  }
  return { green: !missing.length && !failed.length && !pending.length, missing, failed, pending };
}

export async function requiredChecks(
  gh: Gh,
  repository: string,
  base: string,
  fallback: string[] = [],
  signal?: AbortSignal,
): Promise<string[]> {
  repositorySchema.parse(repository);
  const rules = z.array(
    z.object({
      type: z.string(),
      parameters: z
        .object({ required_status_checks: z.array(z.object({ context: z.string().min(1) })).optional() })
        .passthrough()
        .optional(),
    }),
  );
  try {
    const rows = await gh.json(rules, ['api', `repos/${repository}/rules/branches/${encodeURIComponent(base)}`], {
      signal,
    });
    const names = rows
      .filter((row) => row.type === 'required_status_checks')
      .flatMap((row) => row.parameters?.required_status_checks?.map((check) => check.context) ?? []);
    return names.length ? names : fallback;
  } catch {
    signal?.throwIfAborted();
    return fallback;
  }
}
