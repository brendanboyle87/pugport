export type FileReference = { path: string; kind: 'file' | 'folder' };
export function insertFileReference(text: string, at: { start: number; query: string }, item: FileReference) {
  const reference = item.path + (item.kind === 'folder' ? '/' : '');
  const before = text.slice(0, at.start) + JSON.stringify(reference) + ' ';
  return { text: before + text.slice(at.start + at.query.length + 1), caret: before.length };
}
