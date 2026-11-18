import type { PresentationItem } from '../shared/conversation-presentation';

/** Details may arrive behind compact state or the live stream. Never replace a body with a preview. */
export function mergeNarration(
  projection: PresentationItem[],
  detail: PresentationItem[] = [],
  live?: { runId: string; text: string },
): PresentationItem[] {
  const byKey = new Map(detail.map((item) => [item.key, item]));
  const items: PresentationItem[] = projection.map((item) => {
    const other = byKey.get(item.key);
    byKey.delete(item.key);
    return {
      ...other,
      ...item,
      tools: other?.tools ?? item.tools,
      text: (other?.text?.length ?? 0) > (item.text?.length ?? 0) ? other?.text : item.text,
    };
  });
  items.push(...[...byKey.values()].map((item) => ({ ...item })));
  if (!live?.text) return items;
  const bodies = items.filter((item) => item.runId === live.runId && item.kind === 'narration');
  const body = bodies.map((item) => item.text ?? '').join('');
  if (body.length >= live.text.length) return items;
  if (bodies.length && live.text.startsWith(body)) {
    const last = bodies.at(-1)!;
    last.text = (last.text ?? '') + live.text.slice(body.length);
    return items;
  }
  // Older servers may only supply previews, or the retained event window may be incomplete.
  const remaining = items.filter((item) => !bodies.includes(item));
  remaining.push({
    key: bodies[0]?.key ?? `${live.runId}:live`,
    kind: 'narration',
    runId: live.runId,
    text: live.text,
  });
  return remaining;
}
