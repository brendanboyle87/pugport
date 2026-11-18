import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const fakeCursorToken = 'FAKE_CURSOR_AUTH_NEVER_EXPORT';
export function cursorDatabase(file: string, table: string, rows: Record<string, unknown>, blob = false) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY, value BLOB)`);
  for (const [key, value] of Object.entries(rows)) {
    const text = JSON.stringify(value);
    db.prepare(`INSERT OR REPLACE INTO ${table} VALUES (?, ?)`).run(key, blob ? Buffer.from(text) : text);
  }
  db.close();
}
export function cursorWorkspace(root: string, hash: string, metadata: object, chats: unknown[], blob = false) {
  const directory = join(root, 'workspaceStorage', hash);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'workspace.json'), JSON.stringify(metadata));
  cursorDatabase(
    join(directory, 'state.vscdb'),
    'ItemTable',
    { 'composer.composerData': { allComposers: chats } },
    blob,
  );
}
export function cursorFixture(root: string, folder: string, name = 'Design notes', inline = true, blob = false) {
  cursorWorkspace(
    root,
    'one',
    { folder: pathToFileURL(folder).href },
    [{ composerId: 'chat', name, createdAt: 1700000000000, lastUpdatedAt: 1700000100000 }],
    blob,
  );
  const bubbles = [
    { type: 1, text: 'Explain the synthetic design.' },
    { type: 2, text: 'First reply.', thinking: fakeCursorToken },
    { type: 2, text: '', toolFormerData: { name: 'read_file', rawInput: fakeCursorToken, rawOutput: fakeCursorToken } },
    { type: 2, text: '```ts\nconst x = 1;\n```' },
    { type: 1, text: 'Continue.' },
    { type: 2, text: '```js\nunclosed()' },
    { type: 1, text: 'Check the tools.' },
    { type: 2, toolFormerData: { name: 'search' } },
    { type: 2, toolFormerData: { name: 'read_file' } },
    { type: 2, text: '', thinking: fakeCursorToken },
  ];
  const ids = ['z', 'a', 'y', 'b', 'x', 'c', 'w', 'd', 'v', 'e'];
  const rows = inline
    ? { 'composerData:chat': { conversation: bubbles } }
    : {
        'composerData:chat': {
          fullConversationHeadersOnly: bubbles.map((bubble, index) => ({ bubbleId: ids[index], type: bubble.type })),
        },
        ...Object.fromEntries(bubbles.map((bubble, index) => [`bubbleId:chat:${ids[index]}`, bubble])),
      };
  const file = join(root, 'globalStorage', 'state.vscdb');
  cursorDatabase(file, 'cursorDiskKV', rows, blob);
  cursorDatabase(file, 'ItemTable', { 'cursorAuth/accessToken': fakeCursorToken });
  return { file, ids };
}
