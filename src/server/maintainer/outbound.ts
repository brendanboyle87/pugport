import { scanOutbound, type ScanHit } from '../github-gate.ts';

export function defuseMentions(text: string): string {
  return text.replace(/(`+)[\s\S]*?\1|@[A-Za-z0-9][A-Za-z0-9_/-]*/g, (part) =>
    part.startsWith('`') ? part : `\`${part}\``,
  );
}
export function clampSection(text: string, max: number): string {
  if (text.length <= max) return text;
  const prefix = text.slice(0, Math.max(0, max - 2));
  const boundary = prefix.lastIndexOf('\n');
  return (boundary > 0 ? prefix.slice(0, boundary) : prefix) + ' …';
}
export function checkOutbound(
  fields: { field: string; value: string }[],
): { ok: true } | { ok: false; hits: ScanHit[] } {
  const hits = scanOutbound(fields, { allowEmails: [] });
  return hits.length ? { ok: false, hits } : { ok: true };
}
