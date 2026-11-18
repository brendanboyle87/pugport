/** Markup data contract, version 1. Coordinates are fractions of the source image's width/height. */
export const MARKUP_VERSION = 1 as const;
export type Fraction = number;
export type MarkupPoint = { x: Fraction; y: Fraction };
export type MarkupBox = { x0: Fraction; y0: Fraction; x1: Fraction; y1: Fraction };
export type MarkupKind = 'pen' | 'ellipse' | 'arrow' | 'rect' | 'text' | 'marker' | 'element';
export type MarkupColor = '#e5322d' | '#f59e0b' | '#22c55e' | '#3b82f6' | '#ffffff' | '#111827';
export const markupColors: Array<{ value: MarkupColor; name: string }> = [
  { value: '#e5322d', name: '红色' },
  { value: '#f59e0b', name: '橙色' },
  { value: '#22c55e', name: '绿色' },
  { value: '#3b82f6', name: '蓝色' },
  { value: '#ffffff', name: '白色' },
  { value: '#111827', name: '黑色' },
];
/** Page reference facts, never a form control's value. */
export type PageElement = {
  tag: string;
  selector: string;
  role?: string;
  name?: string;
  text?: string;
  frame?: boolean;
};
export type MarkupMark = {
  n: number;
  kind: MarkupKind;
  color: MarkupColor;
  box: MarkupBox;
  point?: MarkupPoint;
  line?: { from: MarkupPoint; to: MarkupPoint };
  points?: MarkupPoint[];
  label?: string;
  note?: string;
  element?: PageElement;
  text?: string;
};
export type MarkupSource =
  | { kind: 'image'; name: string; width: number; height: number }
  | {
      kind: 'page';
      name: string;
      width: number;
      height: number;
      url: string;
      title?: string;
      viewport: { width: number; height: number };
    };
export type MarkupCrop = { n: number; attachmentId: string; name: string };
export type MessageMarkup = {
  version: typeof MARKUP_VERSION;
  source: MarkupSource;
  attachment: string;
  marks: MarkupMark[];
  crops?: MarkupCrop[];
};
export const markupLimits = {
  marks: 20,
  note: 200,
  label: 60,
  penPoints: 64,
  elementText: 120,
  boxText: 300,
  selector: 300,
  name: 120,
  title: 120,
  url: 2048,
  sourceName: 200,
  size: 65535,
  crops: 12,
  quoteText: 12000,
} as const;
export type MarkRect = { x: number; y: number; width: number; height: number };
export type PixelPoint = [number, number];
export type DraftMark = {
  n: number;
  kind: MarkupKind;
  color: MarkupColor;
  rect?: MarkRect;
  line?: { x1: number; y1: number; x2: number; y2: number };
  raw?: PixelPoint[];
  point?: PixelPoint;
  label?: string;
  note?: string;
  element?: PageElement;
  text?: string;
};

export function inlineText(value: string, limit: number = markupLimits.boxText): string {
  return Array.from(
    value
      .replace(/\s+/gu, ' ')
      .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
      .trim(),
  )
    .slice(0, limit)
    .join('');
}
export function annotatedName(name: string, suffix = '-标注.png'): string {
  const stem =
    inlineText(name, markupLimits.sourceName)
      .replace(/[\\/]/g, '-')
      .replace(/\.[^.]*$/, '') || '图片';
  return stem.slice(0, Math.max(0, 200 - suffix.length)).replace(/[\ud800-\udbff]$/, '') + suffix;
}
/** Ramer–Douglas–Peucker, with an explicit stack so long pointer strokes cannot overflow it. */
export function simplifyPolyline(points: PixelPoint[], epsilon: number): PixelPoint[] {
  if (points.length <= 2) return points.slice();
  const keep = new Set([0, points.length - 1]),
    pending: PixelPoint[] = [[0, points.length - 1]];
  while (pending.length) {
    const [start, end] = pending.pop()!,
      [ax, ay] = points[start]!,
      [bx, by] = points[end]!;
    const dx = bx - ax,
      dy = by - ay,
      length = dx * dx + dy * dy;
    let farthest = -1,
      distance = epsilon * epsilon;
    for (let i = start + 1; i < end; i++) {
      const [x, y] = points[i]!,
        t = length ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length)) : 0;
      const squared = (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2;
      if (squared > distance) {
        distance = squared;
        farthest = i;
      }
    }
    if (farthest >= 0) {
      keep.add(farthest);
      pending.push([start, farthest], [farthest, end]);
    }
  }
  return [...keep].sort((a, b) => a - b).map((i) => points[i]!);
}
export function sampled<T>(values: T[], count: number): T[] {
  return values.length <= count
    ? values
    : Array.from({ length: count }, (_, i) => values[Math.round((i * (values.length - 1)) / (count - 1))]!);
}
export function markBox(mark: DraftMark, width: number, height: number): MarkRect {
  if (mark.rect) return mark.rect;
  if (mark.kind === 'marker' && mark.point) {
    const r = 11 * Math.min(6, Math.max(1, Math.max(width, height) / 900));
    return { x: mark.point[0] - r, y: mark.point[1] - r, width: 2 * r, height: 2 * r };
  }
  const points =
    mark.raw ??
    (mark.line
      ? [
          [mark.line.x1, mark.line.y1],
          [mark.line.x2, mark.line.y2],
        ]
      : [mark.point ?? [0, 0]]);
  let x = Infinity,
    y = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const point of points) {
    x = Math.min(x, point[0]!);
    y = Math.min(y, point[1]!);
    right = Math.max(right, point[0]!);
    bottom = Math.max(bottom, point[1]!);
  }
  return { x, y, width: right - x, height: bottom - y };
}
export function normalizeMark(mark: DraftMark, width: number, height: number): MarkupMark {
  const f = (v: number, size: number) => Math.max(0, Math.min(1, Math.round((v / size) * 10000) / 10000));
  const point = ([x, y]: PixelPoint): MarkupPoint => ({ x: f(x, width), y: f(y, height) });
  const rect = markBox(mark, width, height);
  return {
    n: mark.n,
    kind: mark.kind,
    color: mark.color,
    box: {
      x0: f(rect.x, width),
      y0: f(rect.y, height),
      x1: f(rect.x + rect.width, width),
      y1: f(rect.y + rect.height, height),
    },
    ...(mark.point ? { point: point(mark.point) } : {}),
    ...(mark.line
      ? { line: { from: point([mark.line.x1, mark.line.y1]), to: point([mark.line.x2, mark.line.y2]) } }
      : {}),
    ...(mark.raw
      ? {
          points: sampled(
            simplifyPolyline(mark.raw, Math.max(2, 0.0025 * Math.max(width, height))),
            markupLimits.penPoints,
          ).map(point),
        }
      : {}),
    ...(mark.label ? { label: inlineText(mark.label, markupLimits.label) } : {}),
    ...(mark.note ? { note: inlineText(mark.note, markupLimits.note) } : {}),
    ...(mark.element ? { element: mark.element } : {}),
    ...(mark.text ? { text: inlineText(mark.text, markupLimits.boxText) } : {}),
  };
}
