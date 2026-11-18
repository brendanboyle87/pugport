import { z } from 'zod';
import { markupColors, markupLimits, inlineText, type MarkupColor } from '../shared/markup.ts';
import { markupQuoteText, markupNotes } from '../shared/markup-text.ts';
import { MAX_QUOTE_LENGTH, MAX_QUOTE_NOTE_LENGTH, type MessageQuote } from '../shared/quotes.ts';

const fraction = z.number().finite().min(0).max(1);
const point = z.object({ x: fraction, y: fraction });
const box = z
  .object({ x0: fraction, y0: fraction, x1: fraction, y1: fraction })
  .refine((b) => b.x0 <= b.x1 && b.y0 <= b.y1);
const size = z.number().int().min(1).max(markupLimits.size);
const short = (n: number) => z.string().transform((value) => inlineText(value, n));
function isPlainHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}
const markSchema = z
  .object({
    n: z.number().int().min(1).max(markupLimits.marks),
    kind: z.enum(['pen', 'ellipse', 'arrow', 'rect', 'text', 'marker', 'element']),
    color: z.enum(markupColors.map((c) => c.value) as [MarkupColor, ...MarkupColor[]]),
    box,
    point: point.optional(),
    line: z.object({ from: point, to: point }).optional(),
    points: z.array(point).min(2).max(markupLimits.penPoints).optional(),
    label: short(markupLimits.label).optional(),
    note: short(markupLimits.note).optional(),
    element: z
      .object({
        tag: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
        selector: short(markupLimits.selector),
        role: short(40).optional(),
        name: short(markupLimits.name).optional(),
        text: short(markupLimits.elementText).optional(),
        frame: z.boolean().optional(),
      })
      .optional(),
    text: short(markupLimits.boxText).optional(),
  })
  .refine(
    (m) =>
      ({
        pen: !!m.points,
        ellipse: true,
        arrow: !!m.line,
        rect: true,
        text: !!m.point && !!m.label,
        marker: !!m.point,
        element: !!m.element,
      })[m.kind],
    '标记缺少该种类需要的几何信息。',
  )
  .refine((m) => m.text === undefined || m.kind === 'rect', '只有区域标记带区域文字。');
export const markupSchema = z
  .object({
    version: z.literal(1),
    source: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('image'), name: short(markupLimits.sourceName), width: size, height: size }),
      z.object({
        kind: z.literal('page'),
        name: short(markupLimits.sourceName),
        width: size,
        height: size,
        url: z.string().max(markupLimits.url).refine(isPlainHttpUrl, '网页地址只能是 http(s)，且不含查询参数和片段。'),
        title: short(markupLimits.title).optional(),
        viewport: z.object({ width: size, height: size }),
      }),
    ]),
    attachment: short(200).refine((v) => v.length > 0 && !/[\\/\x00-\x1f\x7f]/.test(v)),
    marks: z.array(markSchema).min(1).max(markupLimits.marks),
  })
  .refine((m) => m.marks.every((mark, i) => mark.n === i + 1), '标记编号必须从 1 连续。')
  .refine(
    (m) => m.marks.every((mark) => mark.kind !== 'element' || m.source.kind === 'page'),
    '元素标记只能来自网页。',
  );
export const messageQuoteSchema = z
  .object({
    text: z.string().trim().max(MAX_QUOTE_LENGTH),
    note: z.string().trim().max(MAX_QUOTE_NOTE_LENGTH).optional(),
    messageId: z.string().max(100).optional(),
    markup: markupSchema.optional(),
  })
  .refine((q) => q.text.length > 0 || !!q.markup, '引用内容不能为空。');
/** Geometry is reference material; only the mark notes express the user's instructions. */
export const canonicalQuote = (quote: MessageQuote): MessageQuote =>
  quote.markup ? { ...quote, text: markupQuoteText(quote.markup), note: markupNotes(quote.markup) } : quote;
