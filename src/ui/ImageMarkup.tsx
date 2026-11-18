import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { ArrowUpRight, Check, Circle, MapPin, Pencil, Square, Type, Undo2, X } from 'lucide-react';
import {
  inlineText,
  markupColors,
  markupLimits,
  markBox,
  normalizeMark,
  type DraftMark,
  type MarkRect,
  type MarkupColor,
  type MarkupMark,
  type MessageMarkup,
  type PageElement,
  type PixelPoint,
} from '../shared/markup';
import { QuoteEditor } from './Quotes';
import { translateInterfaceText, withNames } from './i18n';
import { composeMarkupPng } from './markup-compose';
import {
  badgeAnchor,
  badgeInk,
  clamp,
  fitSize,
  gestureToMark,
  markFont,
  markHalo,
  markPrimitives,
  markStyle,
  type MarkGeometry,
  type Primitive,
  type Size,
  type Tool,
} from './markup-geometry';

export type PageMarkupQuery = {
  url: string;
  title?: string;
  viewport: Size;
  elementAt(point: { x: number; y: number }): Promise<(PageElement & { rect: MarkRect }) | null>;
  textIn(rect: MarkRect): Promise<string>;
};
export type MarkupResult = { file: File; markup: MessageMarkup; src: string };
export type ImageMarkupHandle = {
  hasMarks(): boolean;
  undo(): void;
  closeNote(): boolean;
  compose(fileName: string): Promise<{ file: File; marks: MarkupMark[] }>;
};
type Props = {
  src: string;
  name: string;
  kind: 'image' | 'page';
  page?: PageMarkupQuery;
  initial?: MarkupMark[];
  onLoad(size: Size | null, count: number): void;
  onCancel(): void;
  onFinish(): void;
  busy: boolean;
};
const tools = [
  { kind: 'pen', name: '画笔', Icon: Pencil },
  { kind: 'ellipse', name: '圆圈', Icon: Circle },
  { kind: 'arrow', name: '箭头', Icon: ArrowUpRight },
  { kind: 'rect', name: '方框', Icon: Square },
  { kind: 'text', name: '文字', Icon: Type },
  { kind: 'marker', name: '编号点', Icon: MapPin },
] as const;

function draftMark(mark: MarkupMark, size: Size): DraftMark {
  const point = (p: { x: number; y: number }): PixelPoint => [
    Math.round(p.x * size.width),
    Math.round(p.y * size.height),
  ];
  return {
    n: mark.n,
    kind: mark.kind,
    color: mark.color,
    label: mark.label,
    note: mark.note,
    element: mark.element,
    text: mark.text,
    rect: {
      x: mark.box.x0 * size.width,
      y: mark.box.y0 * size.height,
      width: (mark.box.x1 - mark.box.x0) * size.width,
      height: (mark.box.y1 - mark.box.y0) * size.height,
    },
    ...(mark.point ? { point: point(mark.point) } : {}),
    ...(mark.line
      ? {
          line: {
            x1: mark.line.from.x * size.width,
            y1: mark.line.from.y * size.height,
            x2: mark.line.to.x * size.width,
            y2: mark.line.to.y * size.height,
          },
        }
      : {}),
    ...(mark.points ? { raw: mark.points.map(point) } : {}),
  };
}

function shapeElement(shape: Primitive): ReactNode {
  if (shape.kind === 'ellipse') return <ellipse cx={shape.cx} cy={shape.cy} rx={shape.rx} ry={shape.ry} />;
  if (shape.kind === 'line') return <line x1={shape.x1} y1={shape.y1} x2={shape.x2} y2={shape.y2} />;
  if (shape.kind === 'rect')
    return <rect x={shape.x} y={shape.y} width={shape.width} height={shape.height} rx={shape.radius} />;
  if (shape.kind === 'polyline') return <polyline points={shape.points.map((point) => point.join(',')).join(' ')} />;
  if (shape.kind === 'text')
    return (
      <text className="image-mark-label" x={shape.x} y={shape.y} fontSize={shape.size} {...{ translate: 'no' }}>
        {shape.text}
      </text>
    );
  return null;
}

export const ImageMarkup = forwardRef<ImageMarkupHandle, Props>(function ImageMarkup(
  { src, name, kind, page, initial, onLoad, onCancel, onFinish, busy: composing },
  ref,
) {
  const stage = useRef<HTMLDivElement>(null),
    picture = useRef<HTMLDivElement>(null),
    image = useRef<HTMLImageElement>(null);
  const [natural, setNatural] = useState<Size>({ width: 1, height: 1 });
  const [available, setAvailable] = useState<Size>({ width: 1, height: 1 });
  const [loaded, setLoaded] = useState(false),
    [error, setError] = useState('');
  const [querying, setQuerying] = useState(false);
  const busy = composing || querying;
  const [tool, setTool] = useState<Tool>('ellipse'),
    [color, setColor] = useState<MarkupColor>('#e5322d');
  const [marks, setMarks] = useState<DraftMark[]>([]),
    history = useRef<DraftMark[][]>([]),
    marksRef = useRef(marks);
  const [note, setNote] = useState<number>(),
    [text, setText] = useState<{ point: PixelPoint; value: string }>();
  const textRef = useRef<typeof text>(undefined);
  const [preview, setPreview] = useState<MarkGeometry | null>(null);
  const [hover, setHover] = useState<(PageElement & { rect: MarkRect }) | null>(null);
  const gesture = useRef<{ id: number; from: PixelPoint; to: PixelPoint; raw: PixelPoint[] } | undefined>(undefined);
  const hoverPending = useRef<PixelPoint | undefined>(undefined),
    hoverBusy = useRef(false),
    hoverFrame = useRef(0),
    hoverVersion = useRef(0),
    alive = useRef(true);
  const fitted = fitSize(natural, available),
    { k } = fitted;
  const style = markStyle(Math.max(fitted.width, fitted.height)),
    scale = page ? natural.width / page.viewport.width : 1;
  const focusStage = () => stage.current?.focus();
  function changeText(next: typeof text) {
    textRef.current = next;
    setText(next);
  }
  const closeNote = () => {
    const open = note !== undefined || !!textRef.current;
    setNote(undefined);
    changeText(undefined);
    if (open) focusStage();
    return open;
  };
  function change(next: DraftMark[]) {
    history.current = [...history.current.slice(-49), marksRef.current];
    marksRef.current = next;
    setMarks(next);
    setError('');
  }
  function undo() {
    if (busy) return;
    const previous = history.current.pop();
    if (previous) {
      marksRef.current = previous;
      setMarks(previous);
    }
    closeNote();
  }
  function add(mark: MarkGeometry) {
    if (marksRef.current.length >= markupLimits.marks) {
      setError('每张图最多 20 处标注。');
      return;
    }
    const next = { ...mark, n: marksRef.current.length + 1, color: kind === 'page' ? ('#e5322d' as const) : color };
    change([...marksRef.current, next]);
    if (mark.kind !== 'text') setNote(next.n);
  }
  useImperativeHandle(ref, () => ({
    // Unsaved changes, not marks: reopening a capsule and closing it unchanged must not ask to discard.
    hasMarks: () => history.current.length > 0,
    undo,
    closeNote,
    compose: async (fileName) => {
      if (!image.current || !loaded) throw new Error('图片无法加载，无法标注。');
      return {
        file: await composeMarkupPng(image.current, marksRef.current, fileName),
        marks: marksRef.current.map((mark) => normalizeMark(mark, natural.width, natural.height)),
      };
    },
  }));
  useLayoutEffect(() => {
    const root = stage.current;
    if (!root) return;
    const measure = () => {
      const rect = root.getBoundingClientRect();
      setAvailable({ width: rect.width, height: Math.max(1, rect.height - (rect.width <= 640 ? 100 : 60)) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    focusStage();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (loaded) onLoad(natural, marks.length);
  }, [loaded, natural, marks.length, onLoad]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      cancelAnimationFrame(hoverFrame.current);
    };
  }, []);

  function sourcePoint(event: { clientX: number; clientY: number }): PixelPoint {
    const rect = picture.current!.getBoundingClientRect();
    return [
      clamp(Math.round((event.clientX - rect.left) / k), 0, natural.width),
      clamp(Math.round((event.clientY - rect.top) / k), 0, natural.height),
    ];
  }
  async function queryHover() {
    if (!page || hoverBusy.current || !hoverPending.current) return;
    const point = hoverPending.current;
    const version = hoverVersion.current;
    hoverPending.current = undefined;
    hoverBusy.current = true;
    try {
      const hit = await page.elementAt({ x: point[0] / scale, y: point[1] / scale });
      if (alive.current && !gesture.current && version === hoverVersion.current) setHover(hit);
    } catch {
      if (alive.current) setHover(null);
    } finally {
      hoverBusy.current = false;
      if (hoverPending.current && alive.current) hoverFrame.current = requestAnimationFrame(() => void queryHover());
    }
  }
  async function finishGesture() {
    const current = gesture.current;
    if (!current) return;
    gesture.current = undefined;
    setPreview(null);
    const geometry = gestureToMark(kind, tool, current.from, current.to, current.raw, k);
    if (!geometry) return;
    if (geometry.kind === 'text' && geometry.point) {
      changeText({ point: geometry.point, value: '' });
      return;
    }
    if (kind === 'page' && page) {
      setQuerying(true);
      if (geometry.kind === 'marker') {
        try {
          // A failed query leaves the frozen screenshot usable when the live page changes.
          const hit = await page.elementAt({ x: current.to[0] / scale, y: current.to[1] / scale }).catch(() => null);
          if (alive.current && hit) {
            const { rect, ...element } = hit;
            add({
              kind: 'element',
              element,
              rect: { x: rect.x * scale, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale },
            });
          }
          // Nothing to name there (blank space, a page that moved on): still mark the spot.
          else if (alive.current) add(geometry);
        } finally {
          if (alive.current) setQuerying(false);
        }
        return;
      }
      if (geometry.rect) {
        const rect = geometry.rect;
        try {
          geometry.text = inlineText(
            await page.textIn({
              x: rect.x / scale,
              y: rect.y / scale,
              width: rect.width / scale,
              height: rect.height / scale,
            }),
            markupLimits.boxText,
          );
        } catch {
          /* Keep the marked region without page text. */
        } finally {
          if (alive.current) setQuerying(false);
        }
      }
    }
    if (alive.current) add(geometry);
  }
  function submitText() {
    const current = textRef.current;
    if (!current) return;
    const label = inlineText(current.value, markupLimits.label),
      point = current.point;
    changeText(undefined);
    focusStage();
    if (!label) return;
    const context = document.createElement('canvas').getContext('2d')!;
    const font = markStyle(Math.max(natural.width, natural.height)).label;
    context.font = markFont(font);
    const metric = context.measureText(label);
    add({
      kind: 'text',
      point,
      label,
      rect: {
        x: point[0] - metric.actualBoundingBoxLeft,
        y: point[1] - metric.actualBoundingBoxAscent,
        width: metric.actualBoundingBoxLeft + metric.actualBoundingBoxRight,
        height: metric.actualBoundingBoxAscent + metric.actualBoundingBoxDescent,
      },
    });
  }
  function saveNote(value: string) {
    const current = marksRef.current.find((mark) => mark.n === note),
      next = inlineText(value, markupLimits.note) || undefined;
    if (current && current.note !== next)
      change(marksRef.current.map((mark) => (mark.n === current.n ? { ...mark, note: next } : mark)));
    closeNote();
  }
  const selected = marks.find((mark) => mark.n === note),
    anchor = selected && badgeAnchor(selected, style, k, fitted),
    selectedBox = selected && markBox(selected, natural.width, natural.height);
  const pictureRect = picture.current?.getBoundingClientRect();
  const label = selected
    ? `${withNames('标注 {0}', [String(selected.n)])} · ${selected.kind === 'element' ? `${selected.element?.tag} ${selected.element?.name || selected.element?.text || ''}${selected.element?.frame ? ` · ${translateInterfaceText('iframe（内容无法读取）')}` : ''}` : translateInterfaceText(kind === 'page' && selected.kind === 'rect' ? '区域' : (tools.find((item) => item.kind === selected.kind)?.name ?? '标注'))}${selected.text ? `\n${withNames('区域内文字：{0}', [selected.text])}` : ''}`
    : '';

  function renderMark(mark: DraftMark, temporary = false) {
    return (
      <g key={temporary ? 'preview' : mark.n} data-mark={mark.n}>
        {markPrimitives(mark, style, k, fitted).map((shape, i) =>
          shape.kind === 'badge' ? (
            <g
              key={i}
              className="image-mark-badge"
              role="button"
              tabIndex={temporary ? -1 : 0}
              aria-label={withNames('标注 {0}', [String(mark.n)])}
              data-names
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => !temporary && setNote(mark.n)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setNote(mark.n);
                }
              }}
            >
              <circle
                cx={shape.cx}
                cy={shape.cy}
                r={shape.r}
                fill={mark.color}
                stroke={markHalo(mark.color)}
                strokeWidth={2 * style.halo}
              />
              <text
                x={shape.cx}
                y={shape.cy}
                textAnchor="middle"
                dominantBaseline="central"
                fill={badgeInk(mark.color)}
                fontSize={style.font}
              >
                {shape.text}
              </text>
            </g>
          ) : (
            <g key={i} fill="none" strokeLinecap="round" strokeLinejoin="round" pointerEvents="none">
              <g stroke={markHalo(mark.color)} strokeWidth={style.stroke + 2 * style.halo}>
                {shapeElement(shape)}
              </g>
              <g
                stroke={shape.kind === 'text' ? 'none' : mark.color}
                fill={shape.kind === 'text' ? mark.color : 'none'}
                strokeWidth={style.stroke}
              >
                {shapeElement(shape)}
              </g>
            </g>
          ),
        )}
      </g>
    );
  }

  return (
    <div className="image-markup-stage" tabIndex={-1} ref={stage}>
      <div
        className="image-markup"
        ref={picture}
        style={{ width: fitted.width, height: fitted.height }}
        data-k={k}
        data-scale={scale}
      >
        <img
          ref={image}
          src={src}
          alt={name}
          data-names
          draggable={false}
          onLoad={(event) => {
            const next = { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight };
            setNatural(next);
            setLoaded(true);
            const restored = (initial ?? []).map((mark) => draftMark(mark, next));
            marksRef.current = restored;
            setMarks(restored);
          }}
          onError={() => {
            setError('图片无法加载，无法标注。');
            setLoaded(false);
            onLoad(null, 0);
          }}
        />
        <svg
          viewBox={`0 0 ${fitted.width} ${fitted.height}`}
          onPointerDown={(event) => {
            if (!loaded || busy || !event.isPrimary || event.button !== 0) return;
            if (gesture.current) void finishGesture();
            if (text) submitText();
            closeNote();
            focusStage();
            hoverVersion.current++;
            setHover(null);
            const point = sourcePoint(event);
            gesture.current = { id: event.pointerId, from: point, to: point, raw: [point] };
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              /* Synthetic and interrupted pointers may have no capture target. */
            }
          }}
          onPointerMove={(event) => {
            if (!loaded || !event.isPrimary) return;
            const point = sourcePoint(event),
              current = gesture.current;
            if (current && current.id === event.pointerId) {
              current.to = point;
              const last = current.raw.at(-1)!;
              if (Math.hypot(point[0] - last[0], point[1] - last[1]) * k >= 2) current.raw.push(point);
              setPreview(gestureToMark(kind, tool, current.from, point, current.raw, k));
            } else if (page) {
              hoverPending.current = point;
              cancelAnimationFrame(hoverFrame.current);
              hoverFrame.current = requestAnimationFrame(() => void queryHover());
            }
          }}
          onPointerUp={(event) => {
            if (gesture.current?.id !== event.pointerId) return;
            gesture.current.to = sourcePoint(event);
            void finishGesture();
            try {
              event.currentTarget.releasePointerCapture(event.pointerId);
            } catch {
              /* Capture can already have been released by the host. */
            }
          }}
          onLostPointerCapture={(event) => {
            if (gesture.current?.id === event.pointerId) void finishGesture();
          }}
          onPointerCancel={(event) => {
            if (gesture.current?.id !== event.pointerId) return;
            gesture.current = undefined;
            setPreview(null);
          }}
          onPointerLeave={() => {
            hoverVersion.current++;
            hoverPending.current = undefined;
            setHover(null);
          }}
        >
          {hover && !gesture.current && (
            <rect
              className="image-markup-hover"
              x={hover.rect.x * scale * k}
              y={hover.rect.y * scale * k}
              width={hover.rect.width * scale * k}
              height={hover.rect.height * scale * k}
            />
          )}
          {marks.map((mark) => renderMark(mark))}
          {preview && renderMark({ ...preview, n: marks.length + 1, color }, true)}
        </svg>
        {hover && !gesture.current && (
          <div
            className="image-markup-hover-label"
            translate="no"
            style={{
              left: clamp(hover.rect.x * scale * k, 0, Math.max(0, fitted.width - 300)),
              maxWidth: fitted.width,
              top: clamp(
                hover.rect.y * scale * k >= 31
                  ? hover.rect.y * scale * k - 31
                  : (hover.rect.y + hover.rect.height) * scale * k + 6,
                0,
                Math.max(0, fitted.height - 25),
              ),
            }}
          >
            {hover.tag} · {inlineText(hover.name || hover.text || '', 40)}
          </div>
        )}
        {text && (
          <input
            className="image-markup-text"
            autoFocus
            maxLength={markupLimits.label}
            value={text.value}
            aria-label="输入文字，Enter 确定"
            placeholder="输入文字，Enter 确定"
            style={{
              left: Math.min(text.point[0] * k, Math.max(0, fitted.width - 180)),
              top: clamp(text.point[1] * k - style.label, 0, Math.max(0, fitted.height - 32)),
              color,
              fontSize: style.label,
              maxWidth: fitted.width,
            }}
            onChange={(event) => changeText({ ...text, value: event.target.value })}
            onBlur={submitText}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submitText();
              }
            }}
          />
        )}
      </div>
      {error && (
        <p className="image-markup-error" role="alert">
          {error}
        </p>
      )}
      <div className="image-markup-toolbar" role="toolbar" aria-label="标注">
        {kind === 'image' && (
          <>
            {tools.map(({ kind: value, name: title, Icon }) => (
              <button
                key={value}
                type="button"
                className="icon-button"
                title={title}
                aria-label={title}
                aria-pressed={tool === value}
                disabled={busy || !loaded}
                onClick={() => {
                  setTool(value);
                  closeNote();
                }}
              >
                <Icon size={16} />
              </button>
            ))}
            <hr />
            <div className="image-markup-colors" role="group" aria-label="颜色">
              {markupColors.map(({ value, name: title }) => (
                <button
                  key={value}
                  type="button"
                  className="image-markup-swatch"
                  style={{ '--swatch': value } as CSSProperties}
                  aria-pressed={color === value}
                  aria-label={title}
                  title={title}
                  disabled={busy}
                  onClick={() => setColor(value)}
                />
              ))}
            </div>
            <hr />
          </>
        )}
        <button
          type="button"
          className="icon-button"
          aria-label="撤销"
          title="撤销"
          disabled={busy || !history.current.length}
          onClick={undo}
        >
          <Undo2 size={16} />
        </button>
        <button type="button" className="icon-button" aria-label="取消" title="取消" disabled={busy} onClick={onCancel}>
          <X size={16} />
        </button>
        <button
          type="button"
          className="button tiny primary"
          disabled={busy || !marks.length || !!text}
          onClick={onFinish}
        >
          <Check size={14} />
          完成
        </button>
      </div>
      {selected && anchor && pictureRect && (
        <QuoteEditor
          key={selected.n}
          text=""
          label={label}
          note={selected.note ?? ''}
          maxLength={markupLimits.note}
          placeholder="想对这里做什么？例如：改成蓝色、删掉、对齐（可留空）"
          // Below the whole mark (above it near the bottom), so the note never hides what it describes.
          left={pictureRect.left + (selectedBox!.x + selectedBox!.width / 2) * k}
          top={pictureRect.top + Math.max(selectedBox!.y + selectedBox!.height, anchor.cy / k) * k + style.badge + 6}
          above={pictureRect.top + Math.min(selectedBox!.y * k, anchor.cy) - style.badge - 6}
          editing
          onSave={saveNote}
          // Clicking Done, another mark or the picture keeps what was typed; only Esc / Cancel drop it.
          onOutside={saveNote}
          onCancel={closeNote}
          onRemove={() => {
            change(
              marksRef.current
                .filter((mark) => mark.n !== selected.n)
                .map((mark, index) => ({ ...mark, n: index + 1 })),
            );
            closeNote();
          }}
        />
      )}
    </div>
  );
});
