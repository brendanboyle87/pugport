/*
 * Calling someone by name in a message, in three tiers: `@` roles and executors, `@@` devices and bots, `@@@`
 * servers (phase 3; until then `@@@` reaches what `@@` does). The desktop composer, the terminal and the server all
 * read mentions through this file, so a name means the same everywhere.
 */

export type MentionTier = 1 | 2 | 3;

const nameEnd = /[\p{L}\p{N}_-]/u;
/** What may stand right before a prefix: whitespace or non-ASCII text (请@Claude, ，@@Mac-mini); never mail@x. */
const opener = String.raw`\s|[^\x00-\x7f]`;
const openerPattern = new RegExp(opener, 'u');
export const mentionPrefix = new RegExp(String.raw`(?:^|${opener})@{1,3}(?!@)`, 'u');
const opensAt = (text: string, at: number) => at === 0 || openerPattern.test(text[at - 1]!);

/** The mention being typed at the caret, for the menu: `start` is the first `@`, `query` what follows it. */
export function mentionPrefixAt(
  text: string,
  caret: number,
): { start: number; tier: MentionTier; query: string } | undefined {
  const before = text.slice(0, caret);
  const match = /(@+)([^\s@]*)$/u.exec(before);
  if (!match || match[1]!.length > 3 || !opensAt(before, match.index)) return undefined;
  return { start: match.index, tier: match[1]!.length as MentionTier, query: match[2]! };
}

/**
 * Who a text calls, in the order they appear, each once. A prefix with N `@` reaches names whose minimum tier is at
 * most N; at one place the longest name wins, and between equal names the higher minimum tier (`@@Claude` is the
 * device named Claude, `@@Claude B` still the executor). A name must not run on into a word (`@Claude的方案`).
 */
export function findMentions<T extends { name: string; minTier: MentionTier }>(
  text: string,
  items: readonly T[],
): { item: T; at: number; tier: MentionTier }[] {
  const found: { item: T; at: number; tier: MentionTier }[] = [];
  for (let at = text.indexOf('@'); at >= 0; at = text.indexOf('@', at)) {
    let end = at;
    while (text[end] === '@') end++;
    const tier = end - at;
    let best: T | undefined;
    if (tier <= 3 && opensAt(text, at))
      for (const item of items) {
        const size = item.name.length;
        if (
          !size ||
          item.minTier > tier ||
          text.slice(end, end + size).toLowerCase() !== item.name.toLowerCase() ||
          nameEnd.test(text[end + size] ?? ' ')
        )
          continue;
        if (!best || size > best.name.length || (size === best.name.length && item.minTier > best.minTier)) best = item;
      }
    if (best && !found.some((entry) => entry.item === best)) found.push({ item: best, at, tier: tier as MentionTier });
    at = end + (best?.name.length ?? 0);
  }
  return found;
}

/** The text without `@{1,3}名字` and one space after it, wherever a mention of that name could stand. */
export function withoutMentionName(text: string, name: string, names: readonly string[] = []): string {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const longer = names.filter(
    (value) => value.length > name.length && value.toLowerCase().startsWith(name.toLowerCase()),
  );
  const protect = longer.length ? `(?!(?:${longer.map(escape).join('|')})(?![\\p{L}\\p{N}_-]))` : '';
  return text.replace(new RegExp(`(?<=^|${opener})@{1,3}${protect}${escape(name)}(?![\\p{L}\\p{N}_-]) ?`, 'giu'), '');
}
