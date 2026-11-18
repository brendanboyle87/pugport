import { open, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MoveJournal } from './file-manager.ts';

/** Read only candidate bodies, four at a time; directory precedence overrides legacy copies. */
export async function findMoveJournal(
  folders: string[],
  id: string,
  conversationId?: string,
  read = (path: string) => readFile(path, 'utf8'),
): Promise<MoveJournal | undefined> {
  const load = async (path: string) => {
    try {
      return JSON.parse(await read(path)) as MoveJournal;
    } catch {
      return undefined;
    }
  };
  if (id) {
    if (!/^[\w-]+$/.test(id)) return;
    for (const folder of folders) {
      const path = join(folder, id + '.json');
      // An invalid current copy also shadows an older journal, as in the previous inventory.
      try {
        const journal = JSON.parse(await read(path)) as MoveJournal;
        return journal?.id === id ? journal : undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
      }
    }
    return;
  }
  const seen = new Set<string>();
  const candidates: { path: string; at: string; order: number }[] = [];
  let order = 0;
  for (const folder of folders) {
    const names = (await readdir(folder).catch(() => [] as string[])).filter(
      (name) => name.endsWith('.json') && !seen.has(name),
    );
    for (const name of names) seen.add(name);
    for (let offset = 0; offset < names.length; offset += 4) {
      await Promise.all(
        names.slice(offset, offset + 4).map(async (name) => {
          const position = order++;
          const path = join(folder, name);
          const file = await open(path, 'r').catch(() => undefined);
          if (!file) return;
          let at: string | undefined;
          try {
            const prefix = Buffer.alloc(4096);
            const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
            // Our journals write id and at before the large move list. Older layouts fall back to one body.
            at = /^\s*\{[^{}]*"at"\s*:\s*"([^"\\]+)"/.exec(prefix.toString('utf8', 0, bytesRead))?.[1];
          } finally {
            await file.close();
          }
          at ??= (await load(path))?.at;
          if (at) candidates.push({ path, at, order: position });
        }),
      );
    }
  }
  candidates.sort((a, b) => b.at.localeCompare(a.at) || a.order - b.order);
  for (let offset = 0; offset < candidates.length; offset += 4) {
    const journals = await Promise.all(candidates.slice(offset, offset + 4).map(({ path }) => load(path)));
    const selected = journals.find(
      (journal) => journal && !journal.undoneAt && (!conversationId || journal.conversationId === conversationId),
    );
    if (selected) return selected;
  }
}
