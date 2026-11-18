import type { DraftMark, MarkRect, PixelPoint } from '../shared/markup.ts';

export type Tool = 'pen' | 'ellipse' | 'arrow' | 'rect' | 'text' | 'marker';
export type Size = { width: number; height: number };
export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export function fitSize(natural: Size, box: Size) {
  const k = Math.max(0, Math.min(1, box.width / natural.width, box.height / natural.height));
  return { width: Math.round(natural.width * k), height: Math.round(natural.height * k), k };
}
export function markStyle(longEdge: number) {
  const unit = clamp(longEdge / 900, 1, 6);
  return {
    unit,
    stroke: 3 * unit,
    halo: 1.5 * unit,
    badge: 11 * unit,
    font: 12 * unit,
    label: 16 * unit,
    dot: 6 * unit,
    head: 14 * unit,
  };
}
export type MarkStyle = ReturnType<typeof markStyle>;
export type Primitive =
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'polyline'; points: PixelPoint[] }
  | { kind: 'rect'; x: number; y: number; width: number; height: number; radius: number }
  | { kind: 'text'; x: number; y: number; text: string; size: number }
  | { kind: 'badge'; cx: number; cy: number; r: number; text: string };

export function badgeAnchor(mark: DraftMark, style: MarkStyle, k: number, size: Size) {
  const r = style.badge;
  let x = 0,
    y = 0;
  if (mark.kind === 'pen' && mark.raw?.length) {
    x = mark.raw[0][0] * k + r;
    y = mark.raw[0][1] * k - r;
  } else if (mark.kind === 'arrow' && mark.line) {
    x = mark.line.x1 * k + r;
    y = mark.line.y1 * k - r;
  } else if (mark.point) {
    x = mark.point[0] * k - (mark.kind === 'text' ? 2 * r : 0);
    y = mark.point[1] * k;
  } else if (mark.rect) {
    x = (mark.rect.x + (mark.kind === 'ellipse' ? mark.rect.width : 0)) * k;
    y = mark.rect.y * k;
  }
  return { cx: clamp(x, r, Math.max(r, size.width - r)), cy: clamp(y, r, Math.max(r, size.height - r)) };
}

export function markPrimitives(
  mark: DraftMark,
  style: MarkStyle,
  k: number,
  size: Size = { width: Infinity, height: Infinity },
): Primitive[] {
  const result: Primitive[] = [];
  const rect = mark.rect;
  if (mark.kind === 'ellipse' && rect)
    result.push({
      kind: 'ellipse',
      cx: (rect.x + rect.width / 2) * k,
      cy: (rect.y + rect.height / 2) * k,
      rx: Math.max(3, (rect.width * k) / 2),
      ry: Math.max(3, (rect.height * k) / 2),
    });
  else if ((mark.kind === 'rect' || mark.kind === 'element') && rect)
    result.push({
      kind: 'rect',
      x: rect.x * k,
      y: rect.y * k,
      width: rect.width * k,
      height: rect.height * k,
      radius: 2 * style.unit,
    });
  else if (mark.kind === 'pen' && mark.raw)
    result.push({ kind: 'polyline', points: mark.raw.map(([x, y]) => [x * k, y * k]) });
  else if (mark.kind === 'arrow' && mark.line) {
    const { x1, y1, x2, y2 } = mark.line;
    result.push({ kind: 'line', x1: x1 * k, y1: y1 * k, x2: x2 * k, y2: y2 * k });
    const angle = Math.atan2(y2 - y1, x2 - x1),
      spread = (28 * Math.PI) / 180;
    result.push({
      kind: 'polyline',
      points: [
        [x2 * k - style.head * Math.cos(angle - spread), y2 * k - style.head * Math.sin(angle - spread)],
        [x2 * k, y2 * k],
        [x2 * k - style.head * Math.cos(angle + spread), y2 * k - style.head * Math.sin(angle + spread)],
      ],
    });
  } else if (mark.kind === 'text' && mark.point)
    result.push({
      kind: 'text',
      x: mark.point[0] * k,
      y: mark.point[1] * k,
      text: mark.label ?? '',
      size: style.label,
    });
  result.push({ kind: 'badge', ...badgeAnchor(mark, style, k, size), r: style.badge, text: String(mark.n) });
  return result;
}

export type MarkGeometry = Omit<DraftMark, 'n' | 'color'>;
export function gestureToMark(
  kind: 'image' | 'page',
  tool: Tool,
  from: PixelPoint,
  to: PixelPoint,
  raw: PixelPoint[],
  k = 1,
): MarkGeometry | null {
  const distance = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const click = distance * k < 4;
  if (kind === 'page' && click) return { kind: 'marker', point: to };
  if (kind === 'page') tool = 'rect';
  if (tool === 'text' || tool === 'marker') return click ? { kind: tool, point: to } : null;
  if (tool === 'pen') return raw.length >= 2 ? { kind: tool, raw } : null;
  if (click) return null;
  if (tool === 'arrow')
    return distance >= 6 ? { kind: tool, line: { x1: from[0], y1: from[1], x2: to[0], y2: to[1] } } : null;
  const rect: MarkRect = {
    x: Math.min(from[0], to[0]),
    y: Math.min(from[1], to[1]),
    width: Math.abs(to[0] - from[0]),
    height: Math.abs(to[1] - from[1]),
  };
  return rect.width >= 6 && rect.height >= 6 ? { kind: tool, rect } : null;
}

export const markHalo = (color: string) => (color === '#ffffff' ? 'rgba(0,0,0,.65)' : 'rgba(255,255,255,.92)');
export const badgeInk = (color: string) => (color === '#ffffff' || color === '#f59e0b' ? '#111827' : '#ffffff');
export const markFont = (size: number) =>
  `700 ${size}px "Inter Variable", "Noto Sans SC Variable", "Segoe UI", sans-serif`;
