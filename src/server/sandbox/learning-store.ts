import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { DesktopPermissionRequired } from '../permission-guards.ts';
import type { LearningResult, LearningProvider } from '../../shared/sandbox.ts';
import { groupLearningEntries, parseLearningReport } from './learning-report.ts';
import { isLearningProvider } from './provider-profiles.ts';

/** Bounded, process-local observations. Only explicitly adopted entries are persisted. */
export class LearningStore {
  private results = new Map<LearningProvider, LearningResult>();
  constructor(private dataDir: string) {}
  record(result: LearningResult) {
    const merged = parseLearningReport({
      denials: [...(this.results.get(result.provider)?.entries ?? []), ...result.entries],
    });
    this.results.set(result.provider, {
      ...result,
      ...merged,
      truncated: result.truncated || merged.truncated || !!this.results.get(result.provider)?.truncated,
      groups: groupLearningEntries(merged.entries),
    });
  }
  list() {
    return [...this.results.values()];
  }
  selection(provider: string, ids: string[]) {
    if (!isLearningProvider(provider) || ids.length > 10_000) throw new Error('学习记录已变化，请刷新后重试。');
    const result = this.results.get(provider);
    const selected = new Set(ids);
    const entries = result?.entries.filter((entry) => selected.has(entry.id)) ?? [];
    if (!entries.length || entries.length !== selected.size) throw new Error('学习记录已变化，请刷新后重试。');
    return entries;
  }
  addedGrants(provider: string, ids: string[]) {
    const entries = this.selection(provider, ids);
    const file = join(this.dataDir, 'sandbox', 'policies', `${provider}.json`);
    const previous = existsSync(file)
      ? (JSON.parse(readFileSync(file, 'utf8')).entries as LearningResult['entries'])
      : [];
    const allowed = new Set(previous.map((entry) => JSON.stringify(entry)));
    return entries.filter((entry) => !allowed.has(JSON.stringify(entry)));
  }
  assertAdoptNarrowing(provider: string, ids: string[]) {
    if (this.addedGrants(provider, ids).length) throw new DesktopPermissionRequired();
  }
  async adopt(provider: string, ids: string[], narrowOnly = false) {
    const entries = this.selection(provider, ids);
    const directory = join(this.dataDir, 'sandbox', 'policies');
    await mkdir(directory, { recursive: true });
    const file = join(directory, `${provider}.json`);
    const temporary = join(directory, `${provider}-${randomUUID()}.tmp`);
    try {
      await writeFile(
        temporary,
        JSON.stringify({ version: 1, provider, adoptedAt: new Date().toISOString(), entries }, null, 2) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
      // Recheck after IO and commit synchronously so another adoption cannot widen an HTTP write.
      if (narrowOnly) this.assertAdoptNarrowing(provider, ids);
      renameSync(temporary, file);
    } finally {
      await unlink(temporary).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    return { adopted: entries.length };
  }
}
