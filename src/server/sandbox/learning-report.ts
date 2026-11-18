import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, unlink } from 'node:fs/promises';
import { extname, join, win32 } from 'node:path';
import type { ExecutionMetadata } from '@microsoft/mxc-sdk/v1';
import type { LearningAccess, LearningGroup, LearningProvider, LearningResult } from '../../shared/sandbox.ts';

export const learningLimit = 10_000;
export function parseLearningReport(
  value: unknown,
  cap = learningLimit,
): { entries: LearningAccess[]; truncated: boolean } {
  const document = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const rows = Array.isArray(document.denials) ? document.denials : [];
  const unique = new Map<string, LearningAccess>();
  const limit = Math.max(0, Math.min(learningLimit, cap));
  let truncated = false;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const { resource, accessType, resourceType } = row;
    if (
      typeof resource !== 'string' ||
      typeof accessType !== 'string' ||
      resource.length > 8192 ||
      accessType.length > 256 ||
      /[\0\r\n]/.test(resource)
    )
      continue;
    const key = JSON.stringify([resource, accessType]);
    if (unique.has(key)) continue;
    if (unique.size >= limit) {
      truncated = true;
      continue;
    }
    unique.set(key, {
      id: createHash('sha256').update(key).digest('hex'),
      resource,
      accessType,
      resourceType: /network|tcp|udp|socket/i.test(String(resourceType))
        ? 'network'
        : /file|directory/i.test(String(resourceType))
          ? 'file'
          : 'other',
    });
  }
  const summary = document.summary as Record<string, unknown> | undefined;
  return {
    entries: [...unique.values()],
    truncated: truncated || summary?.deniedResourcesTruncated === true || summary?.truncated === true,
  };
}

export function groupLearningEntries(entries: LearningAccess[]): LearningGroup[] {
  const groups = new Map<string, LearningGroup>();
  for (const entry of entries) {
    const p = win32.normalize(entry.resource);
    const root = win32.parse(p).root;
    const label = entry.resourceType === 'file' ? root + p.slice(root.length).split('\\')[0] : entry.resource;
    const key = `${entry.resourceType}:${label}`;
    const group = groups.get(key) ?? { label, read: 0, write: 0, execute: 0, entries: [] };
    if (/read|list|enumerate/i.test(entry.accessType)) group.read++;
    if (/write|append|delete|create/i.test(entry.accessType)) group.write++;
    if (/execute/i.test(entry.accessType)) group.execute++;
    group.entries.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** Paths come only from SDK metadata. Delete the individual ETL, never its parent or link target. */
export async function deleteRetainedEtl(metadata?: ExecutionMetadata) {
  for (const file of new Set([metadata?.captureDenials?.etlPath, metadata?.captureDenialsError?.etlPath])) {
    if (!file || extname(file).toLowerCase() !== '.etl') continue;
    await unlink(file).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export async function readLearningReport(directory: string, provider: LearningProvider): Promise<LearningResult> {
  try {
    const file = join(directory, 'denials.json');
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024)
      throw new Error('invalid-sandbox-report');
    const report = parseLearningReport(JSON.parse(await readFile(file, 'utf8')));
    return { provider, observedAt: new Date().toISOString(), ...report, groups: groupLearningEntries(report.entries) };
  } finally {
    // Also clean traces left next to a report after an interrupted native finalisation.
    for (const entry of await readdir(directory, { withFileTypes: true }))
      if (extname(entry.name).toLowerCase() === '.etl' && !entry.isDirectory())
        await unlink(join(directory, entry.name));
  }
}
