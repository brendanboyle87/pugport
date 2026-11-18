/** Snippets are plain text segments: consumers never interpret archived content as HTML. */
export type SearchSnippet = Array<{ text: string; match: boolean }>;
export type ConversationSearchResult = {
  conversationId: string;
  title: string;
  archivedAt?: string | null;
  messageId: string | null;
  snippet: SearchSnippet;
  createdAt: string;
};

const literalPattern = (query: string) => new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');

export function textMatches(text: string, query: string): Array<{ start: number; end: number }> {
  if (!query) return [];
  const pattern = literalPattern(query);
  return [...text.matchAll(pattern)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
}

export function searchSnippet(text: string, query: string): SearchSnippet {
  const first = query ? literalPattern(query).exec(text) : null;
  const start = Math.max(0, (first?.index ?? 0) - 70);
  const end = Math.min(text.length, start + Math.max(240, query.length + 70));
  const excerpt = text.slice(start, end);
  const parts: SearchSnippet = [];
  let offset = 0;
  if (start) parts.push({ text: '…', match: false });
  for (const match of textMatches(excerpt, query)) {
    if (match.start > offset) parts.push({ text: excerpt.slice(offset, match.start), match: false });
    parts.push({ text: excerpt.slice(match.start, match.end), match: true });
    offset = match.end;
  }
  if (offset < excerpt.length) parts.push({ text: excerpt.slice(offset), match: false });
  if (end < text.length) parts.push({ text: '…', match: false });
  return parts;
}
