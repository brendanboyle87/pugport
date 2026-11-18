import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { Camera, Check, MessageSquareWarning, Shield, X } from 'lucide-react';
import type { AppState } from '../shared/types';
import type {
  ProblemReportImage,
  ProblemReportPayload,
  ProblemReportSummary,
  ProblemReportInboxItem,
} from '../shared/problem-report';
import { GITHUB_REPO_URL } from '../shared/identity';
import type { Api, Notice } from './Workspace';
import { desktopBridge } from './desktop';
import { ImageViewer } from './ImageViewer';

const openEvent = 'pugport:report-problem';
export function openProblemReport(taskId?: string) {
  window.dispatchEvent(new CustomEvent(openEvent, { detail: { taskId } }));
}
export function ReportProblemAction({ taskId }: { taskId?: string }) {
  return (
    <button type="button" className="button tiny quiet report-problem-action" onClick={() => openProblemReport(taskId)}>
      <MessageSquareWarning size={14} />
      报告问题
    </button>
  );
}
export async function prepareProblemImage(source: Blob | string): Promise<ProblemReportImage> {
  const url = typeof source === 'string' ? source : URL.createObjectURL(source);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1600 / image.naturalWidth);
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw Error('无法处理截图。');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.85, 0.7, 0.5, 0.3]) {
      const dataUrl = canvas.toDataURL('image/webp', quality);
      if (Math.ceil(((dataUrl.split(',')[1]?.length ?? 0) * 3) / 4) <= 1024 * 1024) return { dataUrl };
    }
    throw Error('图片超过 1 MB，请选择较小的图片。');
  } finally {
    if (typeof source !== 'string') URL.revokeObjectURL(url);
  }
}
const frames = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
export function ProblemReporter({
  api,
  state,
  notify,
  currentTaskId,
  currentConversationId,
}: {
  api: Api;
  state?: AppState;
  currentTaskId?: string;
  currentConversationId?: string;
  notify: (notice: Notice) => void;
}) {
  const currentConversation = useRef(currentConversationId);
  currentConversation.current = currentConversationId;
  const [conversationId, setConversationId] = useState<string>();
  const currentTask = useRef(currentTaskId);
  currentTask.current = currentTaskId;
  const [open, setOpen] = useState(false),
    [hidden, setHidden] = useState(false),
    [nudge, setNudge] = useState(false);
  const [description, setDescription] = useState(''),
    [images, setImages] = useState<ProblemReportImage[]>([]);
  const [taskId, setTaskId] = useState<string>(),
    [includeConversation, setIncludeConversation] = useState(false);
  const [payload, setPayload] = useState<ProblemReportPayload>(),
    [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [sent, setSent] = useState<ProblemReportSummary>(),
    [mine, setMine] = useState<ProblemReportSummary[]>();
  const [supplement, setSupplement] = useState<ProblemReportSummary>();
  const [viewer, setViewer] = useState<number>();
  const textarea = useRef<HTMLTextAreaElement>(null),
    opening = useRef(false),
    previewRevision = useRef(0);
  const previous = useRef<Map<string, string> | undefined>(undefined),
    nudgeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [dockBottom, setDockBottom] = useState(112);
  useLayoutEffect(() => {
    const composer = document.querySelector('.conversation-composer');
    const position = () =>
      setDockBottom(composer ? Math.max(60, window.innerHeight - composer.getBoundingClientRect().top + 12) : 112);
    position();
    const observer = new ResizeObserver(position);
    if (composer) observer.observe(composer);
    window.addEventListener('resize', position);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
    };
  }, [state, currentTaskId]);
  const [sidebar, setSidebar] = useState<Element | null>(null);
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 559px)').matches);
  const reportError = (cause: unknown) => setError(cause instanceof Error ? cause.message : '操作没有完成，请重试。');
  const capture = async () => {
    const image = await desktopBridge()?.captureProblemScreenshot?.();
    return image ? prepareProblemImage(image) : undefined;
  };
  const show = async (id?: string) => {
    if (opening.current) return;
    opening.current = true;
    try {
      flushSync(() => {
        setOpen(false);
        setHidden(true);
      });
      await frames();
      let shot: ProblemReportImage | undefined;
      try {
        shot = await capture();
      } catch {
        /* Text reports remain available if capture fails. */
      }
      setImages(shot ? [shot] : []);
      setDescription('');
      setIncludeConversation(false);
      setPayload(undefined);
      setTaskId(id ?? currentTask.current);
      setConversationId(currentConversation.current);
      setSent(undefined);
      setMine(undefined);
      setSupplement(undefined);
      setError('');
      setPreview(false);
      setHidden(false);
      setOpen(true);
    } finally {
      opening.current = false;
    }
  };
  useEffect(() => {
    const listener = (event: Event) => void show((event as CustomEvent<{ taskId?: string }>).detail?.taskId);
    window.addEventListener(openEvent, listener);
    const off = desktopBridge()?.onReportProblem?.(() => void show());
    const media = matchMedia('(max-width: 559px)');
    const resize = () => {
      setNarrow(media.matches);
      setSidebar(document.querySelector('.sidebar-status'));
    };
    resize();
    media.addEventListener('change', resize);
    return () => {
      window.removeEventListener(openEvent, listener);
      off?.();
      media.removeEventListener('change', resize);
    };
  }, []);
  useEffect(() => {
    const next = new Map(state?.workflows?.map((task) => [task.id, task.status]) ?? []);
    if (
      previous.current &&
      [...next].some(([id, status]) => status === 'failed' && previous.current?.get(id) !== 'failed')
    ) {
      setNudge(true);
      clearTimeout(nudgeTimer.current);
      nudgeTimer.current = setTimeout(() => setNudge(false), 6000);
    }
    previous.current = next;
  }, [state?.workflows]);
  useEffect(() => () => clearTimeout(nudgeTimer.current), []);
  useEffect(() => {
    const focus = () => {
      void api('/api/problem-reports/focus', {}).catch(() => {});
    };
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [api]);
  useEffect(() => {
    if (!open || sent || mine || supplement) return;
    const revision = ++previewRevision.current;
    setPayload(undefined);
    const timer = setTimeout(() => {
      void api<ProblemReportPayload>('/api/problem-reports/preview', {
        taskId,
        conversationId,
        description,
        includeConversation,
      })
        .then((value) => {
          if (previewRevision.current === revision) setPayload(value);
        })
        .catch((cause) => {
          if (previewRevision.current === revision) reportError(cause);
        });
    }, 120);
    return () => {
      clearTimeout(timer);
      previewRevision.current++;
    };
  }, [open, taskId, conversationId, description, includeConversation, sent, mine, supplement, api]);
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy && viewer === undefined) setOpen(false);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [open, busy, viewer]);
  useEffect(() => {
    const check = async () => {
      try {
        const value = await api<{ reports: ProblemReportSummary[] }>('/api/problem-reports');
        for (const report of value.reports)
          if (report.status === 'fixed') {
            const key = 'pugport.report-fixed.' + report.localId + '.' + report.fixedIn;
            if (!localStorage.getItem(key)) {
              notify({ tone: 'success', message: `报告 ${report.id} 已在 ${report.fixedIn ?? ''} 修复。` });
              localStorage.setItem(key, '1');
            }
          }
      } catch {
        /* Status checks never interrupt the conversation. */
      }
    };
    void check();
    const timer = setInterval(() => void check(), 60 * 1000);
    const focus = () => void check();
    window.addEventListener('focus', focus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', focus);
    };
  }, [api, notify]);
  const maxImages = 4 - (supplement?.imageCount ?? 0);
  const addFiles = async (files: File[]) => {
    try {
      const additions = await Promise.all(
        files
          .filter((file) => file.type.startsWith('image/'))
          .slice(0, Math.max(0, maxImages - images.length))
          .map(prepareProblemImage),
      );
      setImages((current) => [...current, ...additions].slice(0, maxImages));
    } catch (cause) {
      reportError(cause);
    }
  };
  const another = async () => {
    if (images.length >= maxImages || busy) return;
    setBusy(true);
    flushSync(() => setHidden(true));
    try {
      await frames();
      const shot = await capture();
      if (shot) setImages((current) => [...current, shot].slice(0, maxImages));
    } catch (cause) {
      reportError(cause);
    } finally {
      setHidden(false);
      setBusy(false);
    }
  };
  const submit = async () => {
    if (busy || (!supplement && !payload) || (!description.trim() && !images.length)) return;
    setBusy(true);
    setError('');
    try {
      const result = supplement
        ? await api<ProblemReportSummary>(`/api/problem-reports/${encodeURIComponent(supplement.localId)}/files`, {
            images,
          })
        : await api<ProblemReportSummary>('/api/problem-reports', { payload, images });
      setSent(result);
      setSupplement(undefined);
      setImages([]);
    } catch (cause) {
      reportError(cause);
    } finally {
      setBusy(false);
    }
  };
  const myReports = async () => {
    try {
      const value = await api<{ reports: ProblemReportSummary[] }>('/api/problem-reports');
      setMine(value.reports);
      setSent(undefined);
    } catch (cause) {
      reportError(cause);
    }
  };
  const addTo = (report: ProblemReportSummary) => {
    setSupplement(report);
    setSent(undefined);
    setMine(undefined);
    setImages([]);
    setError('');
  };
  const button = (
    <button
      type="button"
      style={narrow && sidebar ? undefined : { bottom: dockBottom }}
      className={`problem-report-fab${nudge && !open ? ' nudge' : ''}${open ? ' open' : ''}`}
      aria-label="报告问题"
      title="报告问题"
      aria-expanded={open}
      onClick={() => (open ? setOpen(false) : void show())}
    >
      {nudge && !open && <i />}
      <MessageSquareWarning size={16} />
      {nudge && !open && <span>遇到问题？</span>}
    </button>
  );
  const task = state?.workflows?.find((item) => item.id === taskId);
  const taskTitle = task?.input?.content?.split('\n')[0]?.slice(0, 40);
  return (
    <>
      {narrow && sidebar ? createPortal(button, sidebar) : button}
      {open && !hidden && (
        <section
          style={narrow ? undefined : { bottom: dockBottom + 38 }}
          className={`problem-report-panel${sent ? ' sent' : ''}`}
          role="dialog"
          aria-label="报告问题"
          onPaste={(event) => {
            const files = [...event.clipboardData.files];
            if (files.length) {
              event.preventDefault();
              void addFiles(files);
            }
          }}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            void addFiles([...event.dataTransfer.files]);
          }}
        >
          <header>
            <strong>{mine ? '我的报告' : supplement ? '补发截图' : '报告问题'}</strong>
            <button
              className="icon-button"
              type="button"
              aria-label="关闭报告"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              <X size={16} />
            </button>
          </header>
          {sent ? (
            <>
              <span className="problem-report-success">
                <Check size={20} />
              </span>
              <strong>{sent.status === 'draft' ? '已保存草稿' : '已发送'}</strong>
              {sent.id && <code translate="no">{sent.id}</code>}
              <p>{sent.status === 'draft' ? '已存为草稿，联网后自动发送。' : '修好后会在 PugPort 里通知你。'}</p>
              <footer>
                {sent.id && (
                  <button
                    className="button secondary"
                    onClick={() => void navigator.clipboard.writeText(sent.id!).catch(reportError)}
                  >
                    复制编号
                  </button>
                )}
                <button className="button secondary" disabled={sent.imageCount >= 4} onClick={() => addTo(sent)}>
                  补发截图
                </button>
                <button className="button quiet" onClick={() => setOpen(false)}>
                  完成
                </button>
              </footer>
            </>
          ) : mine ? (
            <>
              <ul className="problem-report-list">
                {mine.map((report) => (
                  <li key={report.localId}>
                    <strong translate="no">{report.id ?? '—'}</strong>
                    <span>{report.status === 'draft' ? '草稿' : report.status === 'fixed' ? '已修复' : '已发送'}</span>
                    <p translate="no">{report.description.split('\n')[0]}</p>
                    {report.fixedIn && <code translate="no">{report.fixedIn}</code>}
                    <button
                      className="button quiet tiny"
                      disabled={report.imageCount >= 4}
                      onClick={() => addTo(report)}
                    >
                      补发截图
                    </button>
                  </li>
                ))}
              </ul>
              <a
                className="problem-report-github"
                href={`${GITHUB_REPO_URL}/issues/new`}
                target="_blank"
                rel="noreferrer"
              >
                改在 GitHub 报告
              </a>
              <button
                className="button quiet"
                onClick={() => {
                  setMine(undefined);
                }}
              >
                返回
              </button>
            </>
          ) : (
            <>
              <div className="problem-report-shots">
                {images.map((image, index) => (
                  <div className="problem-report-shot" key={index}>
                    <button type="button" className="problem-report-image" onClick={() => setViewer(index)}>
                      <img src={image.dataUrl} alt="截图" />
                    </button>
                    <button
                      className="problem-report-remove"
                      aria-label="移除截图"
                      onClick={() => setImages((current) => current.filter((_, i) => i !== index))}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
                {images.length < maxImages && (
                  <button className="problem-report-add" disabled={busy} onClick={() => void another()}>
                    <Camera size={16} />
                    再截一张
                  </button>
                )}
              </div>
              <p className="problem-report-hint">也可以粘贴或拖进图片</p>
              {!supplement && (
                <>
                  <div className="problem-report-description">
                    <textarea
                      ref={textarea}
                      aria-label="问题描述"
                      placeholder="发生了什么？说一句就行，比如：发了消息没反应"
                      maxLength={4000}
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                    />
                  </div>
                  <div className="problem-report-attach">
                    <Shield size={16} />
                    <span>
                      {taskTitle
                        ? `自动附上版本、系统、最近的错误和「${taskTitle}」这个任务的经过，密钥和路径已打码。`
                        : '自动附上版本、系统和最近的错误，密钥和路径已打码。'}
                    </span>
                    <button
                      className="problem-report-link"
                      onClick={() => setPreview(!preview)}
                      aria-expanded={preview}
                    >
                      查看
                    </button>
                  </div>
                  {preview && (
                    <pre className="problem-report-preview" translate="no">
                      {payload ? JSON.stringify(payload, null, 2) : '…'}
                    </pre>
                  )}
                  <label className="problem-report-check">
                    <input
                      type="checkbox"
                      checked={includeConversation}
                      onChange={(event) => setIncludeConversation(event.target.checked)}
                    />
                    同时附上这段对话的内容
                  </label>
                </>
              )}
              <footer>
                <button className="problem-report-link mine" onClick={() => void myReports()}>
                  我的报告
                </button>
                <button className="button quiet" disabled={busy} onClick={() => setOpen(false)}>
                  取消
                </button>
                <button
                  className="button primary"
                  disabled={
                    busy ||
                    (!supplement && !payload) ||
                    (supplement ? !images.length : !description.trim() && !images.length)
                  }
                  onClick={() => void submit()}
                >
                  发送
                </button>
              </footer>
            </>
          )}
          {error && (
            <p className="problem-report-error" role="alert">
              {error}
            </p>
          )}
        </section>
      )}
      {viewer !== undefined && images[viewer] && (
        <ImageViewer
          images={images.map((image, index) => ({ src: image.dataUrl, name: `Screenshot ${index + 1}` }))}
          index={viewer}
          onIndex={setViewer}
          onClose={() => setViewer(undefined)}
        />
      )}
    </>
  );
}

export function ProblemReportCard({
  report,
  api,
  onChanged,
  onTask,
  onViewerChange,
}: {
  report: ProblemReportInboxItem;
  api: Api;
  onChanged: () => void;
  onTask: (id: string) => unknown;
  onViewerChange?: (open: boolean) => void;
}) {
  const [busy, setBusy] = useState(false),
    [fixing, setFixing] = useState(false),
    [version, setVersion] = useState(''),
    [error, setError] = useState(''),
    [viewer, setViewer] = useState<number>();
  useEffect(() => {
    onViewerChange?.(viewer !== undefined);
    return () => onViewerChange?.(false);
  }, [viewer, onViewerChange]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作没有完成，请重试。');
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="inbox-row external-request problem-report-card">
      <MessageSquareWarning size={16} className="external-request-icon" />
      <div className="inbox-content">
        <div className="external-request-heading">
          <strong>{`用户报告 ${report.id}`}</strong>
          {report.duplicateCount > 0 && <span>{`+${report.duplicateCount} 个相同问题`}</span>}
        </div>
        {report.images[0] && (
          <button className="problem-report-inbox-image" onClick={() => setViewer(0)}>
            <img src={report.images[0]} alt="截图" />
          </button>
        )}
        <p translate="no">{report.description}</p>
        <small translate="no">
          {report.version} · {report.os}
        </small>
        <div className="external-request-actions">
          <button
            className="button inbox-action primary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await api<{ taskId: string }>(`/api/problem-reports/${report.id}/diagnose`, {});
                onTask(result.taskId);
              })
            }
          >
            诊断
          </button>
          <button className="button quiet inbox-action" disabled={busy} onClick={() => setFixing(!fixing)}>
            标为已修复
          </button>
          <button
            className="button quiet inbox-action"
            disabled={busy}
            onClick={() => void run(() => api(`/api/problem-reports/${report.id}/status`, { status: 'ignored' }))}
          >
            忽略
          </button>
          {report.taskId && (
            <button className="button quiet inbox-action" onClick={() => onTask(report.taskId!)}>
              查看诊断
            </button>
          )}
        </div>
        {fixing && (
          <form
            className="problem-report-fixed"
            onSubmit={(event) => {
              event.preventDefault();
              if (version.trim())
                void run(() =>
                  api(`/api/problem-reports/${report.id}/status`, { status: 'fixed', fixedIn: version.trim() }),
                );
            }}
          >
            <input
              aria-label="修复版本"
              placeholder="修复版本"
              value={version}
              maxLength={120}
              onChange={(event) => setVersion(event.target.value)}
            />
            <button className="button secondary" disabled={!version.trim() || busy}>
              确认
            </button>
          </form>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
      {viewer !== undefined && (
        <ImageViewer
          images={report.images.map((src, index) => ({ src, name: `${report.id} ${index + 1}` }))}
          index={viewer}
          onIndex={setViewer}
          onClose={() => setViewer(undefined)}
        />
      )}
    </li>
  );
}
