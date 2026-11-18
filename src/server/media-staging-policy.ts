const GIB = 1024 ** 3;

export interface MediaStagingSource {
  path: string;
  size: number;
}

/** Cache reuse dominates ordering. Within one shared-source group, cheaper peers come first. */
export function mediaStagingPairPriority(
  sources: readonly MediaStagingSource[],
  cached: ReadonlySet<string>,
  uses: ReadonlyMap<string, number>,
): number {
  const unique = [...new Map(sources.map((source) => [source.path, source])).values()];
  let hits = 0,
    cachedBytes = 0,
    missingBytes = 0,
    reuse = 0;
  for (const source of unique) {
    const size = Number.isFinite(source.size) && source.size > 0 ? source.size : 0;
    if (cached.has(source.path)) {
      hits++;
      cachedBytes += size;
    } else missingBytes += size;
    reuse += Math.max(0, Math.min(20_000, (uses.get(source.path) ?? 1) - 1));
  }
  return hits * 1_000_000 + Math.min(64, cachedBytes / GIB) * 1000 - Math.min(64, missingBytes / GIB) * 100 + reuse;
}

/** A larger library may borrow SSD space, while preserving ample free space for the user's other work. */
export function mediaStagingBudget(availableBytes: number, videoPairs: number) {
  const baseline = { maxBytes: 8 * GIB, minFreeBytes: 4 * GIB };
  if (!Number.isFinite(availableBytes) || availableBytes < 0 || videoPairs < 128) return baseline;
  const gigabytes = Math.min(64, Math.floor(Math.max(0, availableBytes / GIB - 32) / 4));
  return gigabytes > 8 ? { maxBytes: gigabytes * GIB, minFreeBytes: 32 * GIB } : baseline;
}
