import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, Maximize2, Minimize2, PenLine, X } from 'lucide-react';
import { annotatedName, type MarkupMark, type MarkupSource } from '../shared/markup';
import { ImageMarkup, type ImageMarkupHandle, type MarkupResult, type PageMarkupQuery } from './ImageMarkup';
import { confirmDialog } from './confirm-dialog';
import { translateInterfaceText, withNames } from './i18n';
import type { Size } from './markup-geometry';

export type ViewerImage = { src: string; name: string; detail?: string };
export type ViewerMarkup = {
  kind: 'image' | 'page';
  immediate?: boolean;
  initial?: MarkupMark[];
  source?: { src: string; name: string; metadata?: MarkupSource };
  page?: PageMarkupQuery;
  onAdd(result: MarkupResult, index: number): boolean | Promise<boolean>;
};

/** The shared full-window picture preview and optional annotation surface. */
export function ImageViewer({
  images,
  index,
  onIndex,
  onClose,
  actions,
  markup,
}: {
  images: ViewerImage[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  actions?: (image: ViewerImage, index: number) => ReactNode;
  markup?: ViewerMarkup;
}) {
  const [actual, setActual] = useState(false);
  const [mode, setMode] = useState<'view' | 'markup'>(markup?.immediate ? 'markup' : 'view');
  const [loaded, setLoaded] = useState<'loading' | 'ok' | 'failed'>('loading');
  const [size, setSize] = useState<Size>(),
    [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const close = useRef<HTMLButtonElement>(null),
    markupRef = useRef<ImageMarkupHandle>(null),
    asking = useRef(false);
  const image = images[index],
    many = images.length > 1;
  const source = markup?.source ?? image;
  const go = (step: number) => {
    if (!many) return;
    setActual(false);
    setLoaded('loading');
    setError('');
    onIndex((index + step + images.length) % images.length);
  };
  async function leaveMarkup(closeViewer = false) {
    if (busy || asking.current) return;
    if (markupRef.current?.hasMarks()) {
      asking.current = true;
      const discard = await confirmDialog({
        title: '放弃这些标注？',
        summary: '已画的标注不会添加到消息。',
        action: '放弃',
        tone: 'danger',
      });
      asking.current = false;
      if (!discard) return;
    }
    if (closeViewer || markup?.immediate) onClose();
    else {
      setMode('view');
      setError('');
      close.current?.focus();
    }
  }
  function requestClose() {
    if (mode === 'markup') void leaveMarkup(true);
    else onClose();
  }
  const onLoad = useCallback((next: Size | null, markCount: number) => {
    setSize(next ?? undefined);
    setLoaded(next ? 'ok' : 'failed');
    setCount(markCount);
  }, []);
  async function finish() {
    if (!markup || !markupRef.current || !source || !size || busy) return;
    setBusy(true);
    setError('');
    try {
      const composed = await markupRef.current.compose(annotatedName(source.name, translateInterfaceText('-标注.png')));
      const metadata = markup.source?.metadata;
      const origin: MarkupSource =
        markup.kind === 'page' && (markup.page || metadata?.kind === 'page')
          ? {
              kind: 'page',
              name: source.name,
              ...size,
              url: markup.page?.url ?? (metadata as Extract<MarkupSource, { kind: 'page' }>).url,
              title: markup.page?.title ?? (metadata?.kind === 'page' ? metadata.title : undefined),
              viewport: markup.page?.viewport ?? (metadata as Extract<MarkupSource, { kind: 'page' }>).viewport,
            }
          : { kind: 'image', name: source.name, ...size };
      const result: MarkupResult = {
        file: composed.file,
        markup: { version: 1, source: origin, attachment: composed.file.name, marks: composed.marks },
        src: source.src,
      };
      if (await markup.onAdd(result, index)) onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  const latest = useRef({ mode, go, requestClose, leaveMarkup, busy });
  latest.current = { mode, go, requestClose, leaveMarkup, busy };
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    if (!markup?.immediate) close.current?.focus();
    return () => trigger?.focus();
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (asking.current || latest.current.busy) return;
      if (event.key === 'Tab') {
        const dialog = close.current?.closest('.image-viewer');
        const items = Array.from(
          dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, textarea, [tabindex="0"]') ??
            [],
        );
        const first = items[0],
          last = items.at(-1);
        if (event.shiftKey ? document.activeElement === first : document.activeElement === last) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (latest.current.mode === 'markup') {
          if (!markupRef.current?.closeNote()) void latest.current.leaveMarkup();
        } else latest.current.requestClose();
      } else if (latest.current.mode === 'view') {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          latest.current.go(event.key === 'ArrowLeft' ? -1 : 1);
        }
      } else if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'z' &&
        !event.shiftKey &&
        !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
      ) {
        event.preventDefault();
        event.stopPropagation();
        markupRef.current?.undo();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, []);
  if (!image) return null;
  return createPortal(
    <div
      className="image-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={withNames('图片预览 {0}', [image.name])}
      data-names
      onClick={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div className="image-viewer-bar">
        <span className="image-viewer-actions">
          {mode === 'view' && (
            <>
              {markup && (
                <>
                  <button type="button" className="button tiny quiet" onClick={() => setActual((value) => !value)}>
                    {actual ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                    {actual ? '适应窗口' : '原始大小'}
                  </button>
                  <button
                    type="button"
                    className="button tiny quiet"
                    disabled={loaded !== 'ok'}
                    onClick={() => {
                      setActual(false);
                      setMode('markup');
                    }}
                  >
                    <PenLine size={13} />
                    {markup.initial?.length ? '编辑标注' : '标注'}
                  </button>
                </>
              )}
              {actions?.(image, index)}
              <a className="button tiny quiet" href={image.src} download={image.name} title="保存到电脑">
                <Download size={13} />
                下载
              </a>
            </>
          )}
          <button
            ref={close}
            type="button"
            className="image-viewer-close"
            aria-label="关闭预览"
            disabled={busy}
            onClick={requestClose}
          >
            <X size={16} />
          </button>
        </span>
      </div>
      {error && (
        <p className="image-markup-error" role="alert">
          {error}
        </p>
      )}
      <div
        className={`image-viewer-stage ${actual && mode === 'view' ? 'actual' : ''}`}
        onClick={(event) => {
          if (event.target === event.currentTarget) requestClose();
        }}
      >
        {mode === 'markup' && markup ? (
          <ImageMarkup
            key={source.src}
            ref={markupRef}
            src={source.src}
            name={source.name}
            kind={markup.kind}
            page={markup.page}
            initial={markup.initial}
            onLoad={onLoad}
            onCancel={() => void leaveMarkup()}
            onFinish={() => void finish()}
            busy={busy}
          />
        ) : (
          <>
            <img
              key={image.src}
              src={image.src}
              alt={image.name}
              title={translateInterfaceText(
                markup ? (markup.initial?.length ? '编辑标注' : '标注') : actual ? '点击适应窗口' : '点击查看原始大小',
              )}
              data-names
              onLoad={() => setLoaded('ok')}
              onError={() => setLoaded('failed')}
              onClick={() => {
                if (markup) {
                  if (loaded === 'ok') {
                    setActual(false);
                    setMode('markup');
                  }
                } else setActual((value) => !value);
              }}
              draggable={false}
            />
            {markup && loaded === 'failed' && (
              <p className="image-markup-error" role="alert">
                图片无法加载，无法标注。
              </p>
            )}
          </>
        )}
      </div>
      <div className="image-viewer-caption">
        <span className="image-viewer-name" title={image.name} data-names>
          <span translate="no">{image.name}</span>
          {mode === 'markup' ? (
            <small data-names>{withNames('已标注 {0} 处', [String(count)])}</small>
          ) : (
            <>
              {image.detail ? <small translate="no">{image.detail}</small> : null}
              {many ? (
                <small>
                  {index + 1} / {images.length}
                </small>
              ) : null}
            </>
          )}
        </span>
      </div>
      {many && mode === 'view' && (
        <>
          <button type="button" className="image-viewer-step previous" aria-label="上一张" onClick={() => go(-1)}>
            <ChevronLeft size={22} />
          </button>
          <button type="button" className="image-viewer-step next" aria-label="下一张" onClick={() => go(1)}>
            <ChevronRight size={22} />
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}
