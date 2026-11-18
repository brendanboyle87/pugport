import fs from 'node:fs';
import promises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import type { TestContext } from 'node:test';

export const largeFileId = 2n ** 54n;

/** Change only synthetic file IDs, leaving bytes, sizes and timestamps untouched. */
export function mockFileIds(
  t: TestContext,
  entries: [string, bigint][],
  fallback?: (path: string) => bigint | undefined,
) {
  const key = (path: unknown) => resolve(String(path)).toLowerCase();
  const ids = new Map(entries.map(([path, ino]) => [key(path), ino]));
  const openedIds = new Map<string, bigint>();
  const withId = <T extends { ino: number | bigint }>(info: T, path: unknown, opened = false): T => {
    const ino = (opened ? openedIds.get(key(path)) : undefined) ?? ids.get(key(path)) ?? fallback?.(String(path));
    if (ino !== undefined) info.ino = typeof info.ino === 'bigint' ? ino : Number(ino);
    return info;
  };
  for (const method of ['stat', 'lstat'] as const) {
    const original = promises[method];
    t.mock.method(promises, method, (async (...args: Parameters<typeof original>) => {
      const info = await Reflect.apply(original, promises, args);
      return info && withId(info, args[0]);
    }) as typeof original);
  }
  for (const method of ['statSync', 'lstatSync'] as const) {
    const original = fs[method];
    t.mock.method(fs, method, ((...args: Parameters<typeof original>) => {
      const info = Reflect.apply(original, fs, args);
      return info && withId(info, args[0]);
    }) as typeof original);
  }
  const descriptors = new Map<number, string>();
  const originalOpenSync = fs.openSync;
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    const fd = originalOpenSync(...args);
    descriptors.set(fd, String(args[0]));
    return fd;
  });
  const originalFstat = fs.fstatSync;
  t.mock.method(fs, 'fstatSync', ((...args: Parameters<typeof fs.fstatSync>) =>
    withId(originalFstat(...args), descriptors.get(args[0]), true)) as typeof fs.fstatSync);
  const originalOpen = promises.open;
  t.mock.method(promises, 'open', async (...args: Parameters<typeof promises.open>) => {
    const file = await originalOpen(...args);
    const originalStat = file.stat.bind(file);
    t.mock.method(file, 'stat', (async (...argsStat: Parameters<typeof file.stat>) =>
      withId(await originalStat(...argsStat), args[0], true)) as typeof file.stat);
    return file;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return {
    set: (path: string, ino: bigint) => ids.set(key(path), ino),
    opened: (path: string, ino: bigint) => openedIds.set(key(path), ino),
  };
}
