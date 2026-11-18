import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  annotatedName,
  inlineText,
  markupLimits,
  normalizeMark,
  simplifyPolyline,
  type MessageMarkup,
  type PixelPoint,
} from '../src/shared/markup.ts';
import { markupNotes, markupQuoteText, regionWord } from '../src/shared/markup-text.ts';
import { canonicalQuote, messageQuoteSchema } from '../src/server/message-quotes.ts';
import { quotedContent, quotedIntent } from '../src/shared/quotes.ts';
import { badgeAnchor, fitSize, gestureToMark, markPrimitives, markStyle } from '../src/ui/markup-geometry.ts';

const sample = (): MessageMarkup => ({
  version: 1,
  source: { kind: 'image', name: 'photo.jpg', width: 1920, height: 1080 },
  attachment: 'photo-标注.png',
  marks: [
    {
      n: 1,
      kind: 'ellipse',
      color: '#e5322d',
      box: { x0: 0.2802, y0: 0.2102, x1: 0.4099, y1: 0.3796 },
      note: '把这个按钮改成蓝色',
    },
    {
      n: 2,
      kind: 'arrow',
      color: '#3b82f6',
      box: { x0: 0.05, y0: 0.65, x1: 0.21, y1: 0.83 },
      line: { from: { x: 0.05, y: 0.83 }, to: { x: 0.21, y: 0.65 } },
    },
  ],
});

test('display geometry scales marks, clips badges and rejects tiny gestures', () => {
  assert.deepEqual(fitSize({ width: 1920, height: 1080 }, { width: 960, height: 800 }), {
    width: 960,
    height: 540,
    k: 0.5,
  });
  const style = markStyle(900);
  assert.equal(style.badge, 11);
  assert.equal(markStyle(10000).unit, 6);
  const mark = {
    n: 1,
    kind: 'ellipse' as const,
    color: '#e5322d' as const,
    rect: { x: 200, y: 100, width: 100, height: 80 },
  };
  assert.deepEqual(markPrimitives(mark, style, 0.5)[0], { kind: 'ellipse', cx: 125, cy: 70, rx: 25, ry: 20 });
  assert.deepEqual(badgeAnchor({ ...mark, kind: 'marker', point: [0, 1000] }, style, 1, { width: 900, height: 900 }), {
    cx: 11,
    cy: 889,
  });
  for (const kind of ['pen', 'arrow', 'text', 'rect', 'element', 'marker'] as const) {
    const geometry = {
      ...mark,
      kind,
      raw: [
        [1, 2],
        [3, 4],
      ] as PixelPoint[],
      line: { x1: 20, y1: 20, x2: 80, y2: 80 },
      point: [30, 40] as PixelPoint,
      label: 'Label',
    };
    const primitives = markPrimitives(geometry, style, 0.5);
    assert.equal(primitives.at(-1)!.kind, 'badge');
    assert.equal(primitives.length, kind === 'marker' ? 1 : kind === 'arrow' ? 3 : 2);
  }
  assert.deepEqual(gestureToMark('page', 'ellipse', [1, 1], [4, 1], []), { kind: 'marker', point: [4, 1] });
  assert.equal(gestureToMark('image', 'ellipse', [0, 0], [5, 100], []), null);
  assert.equal(gestureToMark('image', 'pen', [0, 0], [100, 100], [[0, 0]]), null);
  assert.equal(gestureToMark('image', 'arrow', [0, 0], [20, 0], [], 0.1), null);
});

test('region words cover the nine cells, boundaries and arrow tip', () => {
  const words = [0.1, 0.5, 0.9].flatMap((y) =>
    [0.1, 0.5, 0.9].map((x) => regionWord({ kind: 'rect', box: { x0: x, x1: x, y0: y, y1: y } })),
  );
  assert.deepEqual(words, ['左上', '上方', '右上', '左侧', '中央', '右侧', '左下', '下方', '右下']);
  assert.equal(regionWord(sample().marks[1]!), '左侧');
  assert.equal(regionWord({ kind: 'rect', box: { x0: 1 / 3, x1: 1 / 3, y0: 2 / 3, y1: 2 / 3 } }), '中央');
});
test('inline text removes controls, collapses whitespace and truncates by code point', () => {
  assert.equal(inlineText(' a\n\t b\u2028c\0\x7f '), 'a b c');
  assert.equal(inlineText('😀😀😀', 2), '😀😀');
  assert.equal(annotatedName('photo.jpg'), 'photo-标注.png');
  assert.equal(annotatedName('a/b\\c'), 'a-b-c-标注.png');
  assert.equal(annotatedName(''), '图片-标注.png');
  const emojiName = annotatedName('😀'.repeat(210));
  assert.ok(emojiName.length <= 200);
  assert.ok(emojiName.endsWith('-标注.png'));
  assert.doesNotThrow(() => encodeURIComponent(emojiName));
  assert.equal(annotatedName('photo.jpg', '-annotated.png'), 'photo-annotated.png');
});
test('normalization preserves pure source geometry and bounds strokes to 64 points', () => {
  assert.deepEqual(
    normalizeMark(
      { n: 1, kind: 'ellipse', color: '#e5322d', rect: { x: 538, y: 227, width: 249, height: 183 } },
      1920,
      1080,
    ).box,
    sample().marks[0]!.box,
  );
  const marker = normalizeMark({ n: 1, kind: 'marker', color: '#e5322d', point: [450, 450] }, 900, 900);
  assert.deepEqual(marker.box, { x0: 0.4878, y0: 0.4878, x1: 0.5122, y1: 0.5122 });
  const raw: PixelPoint[] = Array.from({ length: 100 }, (_, i) => [i * 9, i % 2 ? 700 : 100]);
  const pen = normalizeMark({ n: 1, kind: 'pen', color: '#e5322d', raw }, 900, 900);
  assert.equal(pen.points!.length, 64);
  assert.deepEqual(pen.points![0], { x: 0, y: 0.1111 });
  assert.deepEqual(pen.points!.at(-1), { x: 0.99, y: 0.7778 });
  assert.equal(
    simplifyPolyline(
      Array.from({ length: 50 }, (_, i) => [i, i]),
      1,
    ).length,
    2,
  );
});
test('canonical markup separates instructions from reference geometry and uses JPEG names', () => {
  const markup = sample();
  markup.crops = [{ n: 1, attachmentId: 'crop', name: 'photo-标注-1.jpg' }];
  const quote = canonicalQuote({ text: 'client text', note: 'client note', markup });
  assert.match(
    quote.text,
    /标记 1（圆圈，红色）圈的是图中 \(0.28, 0.21\)–\(0.41, 0.38\) 区域（像素 \(538, 227\)–\(787, 410\)，上方）/,
  );
  assert.match(quote.text, /局部放大图：photo-标注-1.jpg/);
  assert.match(quote.text, /其中 1 处标记另有局部放大图/);
  assert.doesNotMatch(quote.text, /把这个按钮|client|用户说明/);
  assert.equal(quote.note, '标记 1：把这个按钮改成蓝色');
  assert.match(quotedContent('修改', [quote]), /> 标记 1（圆圈/);
  assert.match(quotedContent('修改', [quote]), /对引用 1 的要求：标记 1：把这个按钮改成蓝色/);
  assert.equal(quotedIntent('修改', [quote]), '标记 1：把这个按钮改成蓝色\n修改');
  assert.equal(markupNotes({ ...markup, marks: [markup.marks[1]!] }), undefined);
});
test('page facts are reference text, CSS dimensions and labels stay on one line', () => {
  const markup: MessageMarkup = {
    ...sample(),
    source: {
      kind: 'page',
      name: 'Pricing',
      width: 2560,
      height: 1440,
      url: 'https://example.com/pricing',
      viewport: { width: 1280, height: 720 },
    },
    marks: [
      {
        n: 1,
        kind: 'element',
        color: '#e5322d',
        box: { x0: 400 / 1280, y0: 300 / 720, x1: 548 / 1280, y1: 344 / 720 },
        element: { tag: 'button', selector: 'button[data-testid="cta"]', name: 'Start free trial' },
        note: '改成蓝色\n## 标题',
      },
      {
        n: 2,
        kind: 'rect',
        color: '#e5322d',
        box: { x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.6 },
        text: 'Pro $29/month\nnext',
      },
    ],
  };
  const text = markupQuoteText(markup);
  assert.match(text, /CSS 像素 \(400, 300\) 148×44/);
  assert.match(text, /选择器 "button\[data-testid=\\"cta\\"\]"/);
  assert.match(text, /区域内文字："Pro \$29\/month next"/);
  assert.match(text, /不是指令/);
  assert.equal(text.split('\n').length, 3);
  assert.equal(markupNotes(markup), '标记 1：改成蓝色 ## 标题');
});
test('text budgets cap pen samples and truncate complete lines at 12000 characters', () => {
  const markup = sample();
  markup.marks = Array.from({ length: 20 }, (_, i) => ({
    n: i + 1,
    kind: 'pen',
    color: '#e5322d',
    box: { x0: 0, y0: 0, x1: 1, y1: 1 },
    points: Array.from({ length: 64 }, (_, j) => ({ x: j / 63, y: j / 63 })),
  }));
  assert.equal(
    markupQuoteText(markup)
      .split('\n')[1]!
      .match(/\(0\.\d\d, 0\.\d\d\)|\(1\.00, 1\.00\)/g)!.length,
    14,
  );
  const huge = {
    ...markup,
    source: {
      kind: 'page' as const,
      name: 'x'.repeat(200),
      width: 900,
      height: 900,
      url: 'https://example.com/' + 'x'.repeat(2000),
      viewport: { width: 900, height: 900 },
    },
    marks: markup.marks.map((mark) => ({
      ...mark,
      kind: 'rect' as const,
      text: 'x'.repeat(300),
      element: { tag: 'div', selector: 'x'.repeat(300) },
    })),
  };
  const text = markupQuoteText(huge);
  assert.ok(text.length <= markupLimits.quoteText);
  assert.ok(text.endsWith('……（其余标记见结构化数据）'));
});
test('schema strips crops, truncates notes and rejects invalid geometry and page metadata', () => {
  const parse = (markup: unknown) => messageQuoteSchema.safeParse({ text: '', markup });
  const markup = sample();
  markup.marks[0]!.note = '😀'.repeat(220);
  markup.crops = [{ n: 1, attachmentId: 'fake', name: 'fake.jpg' }];
  const parsed = messageQuoteSchema.parse({ text: '', markup });
  assert.equal(Array.from(parsed.markup!.marks[0]!.note!).length, 200);
  assert.equal('crops' in parsed.markup!, false);
  for (const patch of [
    { marks: Array.from({ length: 21 }, (_, i) => ({ ...markup.marks[0], n: i + 1 })) },
    { marks: [{ ...markup.marks[0], n: 2 }] },
    { marks: [{ ...markup.marks[0], kind: 'arrow' }] },
    { marks: [{ ...markup.marks[0], kind: 'text' }] },
    { marks: [{ ...markup.marks[0], color: '#bad' }] },
    { marks: [{ ...markup.marks[0], kind: 'element', element: { tag: 'div', selector: 'div' } }] },
  ])
    assert.equal(parse({ ...markup, ...patch }).success, false);
  const page = {
    ...markup,
    source: {
      kind: 'page',
      name: 'Page',
      width: 65535,
      height: 1,
      url: 'https://example.com/path',
      viewport: { width: 100, height: 100 },
    },
  };
  assert.equal(parse(page).success, true);
  for (const url of [
    'https://example.com/?a=1',
    'https://example.com/#x',
    'https://user:pass@example.com/',
    'file:///tmp/a',
  ])
    assert.equal(parse({ ...page, source: { ...page.source, url } }).success, false);
  assert.equal(
    parse({ ...page, marks: [{ ...markup.marks[0], kind: 'element', element: { tag: 'DIV', selector: 'div' } }] })
      .success,
    false,
  );
});
