import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Download, FileUp, FolderOpen, Play, Plus, Save, Trash2, X } from 'lucide-react';
import {
  mediaWorkflowSchema,
  mediaWorkflowStepLabels,
  type MediaWorkflow,
  type MediaWorkflowEntry,
  type MediaWorkflowPreview,
} from '../shared/media-workflows';
import type { Api, Notice } from './Workspace';
import { desktopBridge } from './desktop';
import { confirmDialog } from './confirm-dialog';
import { currentLocale } from './i18n';
import { revealReplyPath } from './ReplyPaths';
import type { MediaAnalysisReport } from '../server/media-analysis';
import { mediaEvidenceSampleLabel, mediaEvidenceTitle } from '../server/media-analysis-display';

const message = (error: unknown) => (error instanceof Error ? error.message : '本地流程操作失败。');
export type MediaWorkflowsProps = {
  api: Api;
  notify: (notice: Notice) => void;
  conversationId?: string;
  defaultFolder?: string;
  ensureConversation?: () => Promise<string>;
  onStarted?: (id: string) => void;
};

export function MediaWorkflowDialog({ onClose, ...props }: MediaWorkflowsProps & { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => {
      if (node?.open) node.close();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="native-dialog media-workflow-dialog"
      aria-labelledby={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dialog-inner">
        <div className="dialog-title">
          <h2 id={title}>本地流程</h2>
          <button type="button" className="icon-button" aria-label="关闭本地流程" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <MediaWorkflows {...props} />
      </div>
    </dialog>
  );
}

/** One portable parameter recipe, always applied to directories chosen for this run. */
export function MediaWorkflows({
  api,
  notify,
  conversationId,
  defaultFolder,
  ensureConversation,
  onStarted,
}: MediaWorkflowsProps) {
  const [items, setItems] = useState<MediaWorkflowEntry[]>([]);
  const [selected, setSelected] = useState('builtin-gemma-fast');
  const [draft, setDraft] = useState<MediaWorkflow>();
  const [editingId, setEditingId] = useState<string>();
  const [folders, setFolders] = useState(defaultFolder ?? '');
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState<MediaWorkflowPreview>();
  const [createdConversationId, setCreatedConversationId] = useState<string>();
  const ownerId = conversationId ?? createdConversationId;
  const [jobs, setJobs] = useState<MediaAnalysisReport[]>([]);
  const jobsRef = useRef<MediaAnalysisReport[]>([]);
  const [jobError, setJobError] = useState('');
  const [report, setReport] = useState<MediaAnalysisReport>();
  const [reportBusy, setReportBusy] = useState(false);
  const reportRef = useRef<MediaAnalysisReport | undefined>(undefined);
  reportRef.current = report;
  const detailPending = useRef(false);
  const lastDetailRefresh = useRef('');
  const [expandedResults, setExpandedResults] = useState(false);
  const jobSequence = useRef(0);
  const detailSequence = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);
  const operation = useRef(false);
  const current = items.find((item) => item.id === selected);
  const load = useCallback(async () => {
    const key = ++sequence.current;
    try {
      const data = await api<{ items: MediaWorkflowEntry[]; warning?: string }>(
        '/api/media-workflows',
        undefined,
        'GET',
      );
      if (key === sequence.current) {
        setItems(data.items);
        setError(data.warning ?? '');
      }
    } catch (reason) {
      if (key === sequence.current) setError(message(reason));
    }
  }, [api]);
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
    };
  }, [load]);
  const loadJobs = useCallback(async () => {
    if (!ownerId) return;
    const key = ++jobSequence.current;
    try {
      const data = await api<{ jobs: MediaAnalysisReport[] }>(
        `/api/media-analysis?conversationId=${encodeURIComponent(ownerId)}`,
        undefined,
        'GET',
      );
      if (key === jobSequence.current) {
        jobsRef.current = data.jobs;
        setJobs(data.jobs);
        setJobError('');
        refreshReportIfStale(reportRef.current);
      }
    } catch (reason) {
      if (key === jobSequence.current) setJobError(message(reason));
    }
  }, [api, ownerId]);
  useEffect(() => {
    jobSequence.current++;
    detailSequence.current++;
    jobsRef.current = [];
    lastDetailRefresh.current = '';
    setJobs([]);
    setReport(undefined);
    setExpandedResults(false);
    setReportBusy(false);
    detailPending.current = false;
    if (ownerId) void loadJobs();
    return () => {
      jobSequence.current++;
      detailSequence.current++;
    };
  }, [ownerId, loadJobs]);
  const hasRunningAnalysis = jobs.some((job) => job.status === 'running' || job.status === 'queued');
  useEffect(() => {
    if (!hasRunningAnalysis) return;
    const timer = setInterval(() => void loadJobs(), 2000);
    return () => clearInterval(timer);
  }, [hasRunningAnalysis, loadJobs]);
  function refreshReportIfStale(showing: MediaAnalysisReport | undefined) {
    if (!showing || detailPending.current) return;
    const updated = jobsRef.current.find((job) => job.id === showing.id);
    if (!updated || (updated.status === showing.status && updated.counts.results === showing.counts.results)) return;
    // Reconcile a final list update even if it arrived during an older detail request.
    // Try once per server revision so inconsistent/error responses cannot create a fetch loop.
    const version = `${showing.id}:${showing.offset}:${updated.status}:${updated.counts.results}`;
    if (lastDetailRefresh.current === version) return;
    lastDetailRefresh.current = version;
    void viewReport(showing.id, showing.offset, false);
  }
  async function viewReport(id: string, offset = 0, resetExpanded = true) {
    if (!ownerId) return;
    const key = ++detailSequence.current;
    setReportBusy(true);
    detailPending.current = true;
    setJobError('');
    let loaded: MediaAnalysisReport | undefined;
    try {
      const data = await api<MediaAnalysisReport>(
        `/api/media-analysis/${encodeURIComponent(id)}?conversationId=${encodeURIComponent(ownerId)}&offset=${offset}&limit=20`,
        undefined,
        'GET',
      );
      if (key === detailSequence.current) {
        loaded = data;
        setReport(data);
        if (resetExpanded) setExpandedResults(false);
      }
    } catch (reason) {
      if (key === detailSequence.current) setJobError(message(reason));
    } finally {
      if (key === detailSequence.current) {
        setReportBusy(false);
        detailPending.current = false;
        // An owner/page change invalidates key above; never revive a previous selection.
        if (loaded) refreshReportIfStale(loaded);
      }
    }
  }
  async function run(work: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (reason) {
      setError(message(reason));
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }
  function edit(item: MediaWorkflowEntry, copy: boolean) {
    setEditingId(copy || item.builtin ? undefined : item.id);
    setDraft({
      ...structuredClone(item.workflow),
      name: copy || item.builtin ? `${item.workflow.name}（副本）` : item.workflow.name,
    });
  }
  async function exportRecipe(item: MediaWorkflowEntry) {
    const blob = new Blob([JSON.stringify(item.workflow, null, 2) + '\n'], { type: 'application/json' });
    const link = document.createElement('a');
    const objectUrl = URL.createObjectURL(blob);
    link.href = objectUrl;
    link.download = `${item.workflow.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')}.pugport-workflow.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
  const activeWorkflow = preview?.workflow;
  return (
    <section className="media-workflows" aria-label="本地媒体流程">
      <div className="media-workflows-heading">
        <div>
          <h3>本地媒体流程</h3>
          <p>选择流程和目录，由本地程序筛选与核验。可以保存自己的参数，也可以导入第三方 JSON 流程。</p>
        </div>
      </div>
      {error && (
        <p role="alert" className="media-workflow-error">
          {error}
        </p>
      )}
      <div className="media-workflows-select">
        <label>
          使用流程
          <select
            value={selected}
            disabled={busy}
            onChange={(event) => {
              setSelected(event.target.value);
              setDraft(undefined);
            }}
          >
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.workflow.name}
                {item.builtin ? ' · 内置' : ''}
              </option>
            ))}
          </select>
        </label>
        <div className="media-workflow-actions">
          <button disabled={!current || busy} onClick={() => current && edit(current, true)}>
            <Plus size={14} />
            另存副本
          </button>
          {current && !current.builtin && (
            <button disabled={busy} onClick={() => edit(current, false)}>
              编辑
            </button>
          )}
          <button disabled={!current || busy} onClick={() => current && void exportRecipe(current)}>
            <Download size={14} />
            导出流程
          </button>
          {current && !current.builtin && (
            <button
              disabled={busy}
              onClick={async () => {
                if (
                  !(await confirmDialog({
                    title: '删除流程「{0}」？',
                    names: [current.workflow.name],
                    action: '删除流程',
                    tone: 'danger',
                  }))
                )
                  return;
                void run(async () => {
                  await api(`/api/media-workflows/${encodeURIComponent(current.id)}`, undefined, 'DELETE');
                  setSelected('builtin-gemma-fast');
                  setDraft(undefined);
                  await load();
                });
              }}
            >
              <Trash2 size={14} />
              删除流程
            </button>
          )}
        </div>
      </div>
      {current && !draft && (
        <div className="media-workflow-detail">
          <p>{current.workflow.description}</p>
          <ol>
            {current.workflow.steps.map((step) => (
              <li key={step}>{mediaWorkflowStepLabels[step]}</li>
            ))}
          </ol>
          <p className="media-workflow-meta">
            流程作者：{current.workflow.author} · 流程许可：{current.workflow.license}
          </p>
          <p className="media-workflow-meta">来源：{current.source}</p>
          <p className="media-workflow-meta">
            {current.workflow.parameters.retrievalMode === 'adaptive'
              ? `快速预筛：每条视频 6 帧 · 每文件最多 ${current.workflow.parameters.topK} 个核验候选`
              : '对应位置指纹流程：视频候选主要覆盖时长相近的版本'}
          </p>
        </div>
      )}
      {draft && (
        <div className="media-workflow-editor">
          <label>
            流程名称
            <input
              value={draft.name}
              maxLength={80}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <label>
            说明
            <textarea
              value={draft.description}
              maxLength={600}
              rows={2}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </label>
          <div className="media-workflow-fields">
            <label>
              作者
              <input
                value={draft.author}
                maxLength={100}
                onChange={(event) => setDraft({ ...draft, author: event.target.value })}
              />
            </label>
            <label>
              流程许可
              <input
                value={draft.license}
                maxLength={100}
                onChange={(event) => setDraft({ ...draft, license: event.target.value })}
              />
            </label>
            <label>
              检索方式
              <select
                aria-label="检索方式"
                value={draft.parameters.retrievalMode ?? 'full-index'}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    parameters: { ...draft.parameters, retrievalMode: event.target.value as 'adaptive' | 'full-index' },
                  })
                }
              >
                <option value="adaptive">快速去重（指纹预筛与本地核验）</option>
                <option value="full-index">对应位置指纹（时长相近的视频）</option>
              </select>
            </label>
            <label>
              素材类型
              <select
                value={draft.parameters.kind}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    parameters: {
                      ...draft.parameters,
                      kind: event.target.value as MediaWorkflow['parameters']['kind'],
                    },
                  })
                }
              >
                <option value="all">图片与视频</option>
                <option value="images">图片</option>
                <option value="videos">视频</option>
              </select>
            </label>
            <label>
              文件上限
              <input
                type="number"
                min={1}
                max={20_000}
                value={draft.parameters.maxFiles}
                onChange={(event) =>
                  setDraft({ ...draft, parameters: { ...draft.parameters, maxFiles: Number(event.target.value) } })
                }
              />
            </label>
            <label>
              每文件候选数
              <input
                type="number"
                min={1}
                max={20}
                disabled={draft.parameters.retrievalMode !== 'adaptive'}
                value={draft.parameters.topK}
                onChange={(event) =>
                  setDraft({ ...draft, parameters: { ...draft.parameters, topK: Number(event.target.value) } })
                }
              />
            </label>
            <label>
              同时读取数
              <input
                type="number"
                min={1}
                max={8}
                placeholder="自动"
                value={draft.parameters.ioConcurrency ?? ''}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    parameters: {
                      ...draft.parameters,
                      ioConcurrency: event.target.value ? Number(event.target.value) : undefined,
                    },
                  })
                }
              />
            </label>
          </div>
          <p className="media-workflow-meta">
            快速预筛使用固定的 6 帧采样，可能漏掉极短或变速片段；疑似组合由本地程序继续核验。
          </p>
          <p className="media-workflow-meta">机械硬盘建议同时读取 1–2 份文件；SSD 可增加。更多线程不一定更快。</p>
          <div className="media-workflow-actions">
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const parsed = mediaWorkflowSchema.safeParse(draft);
                  if (!parsed.success) throw new Error('请填写名称、说明、作者和许可，并检查参数范围。');
                  const saved = await api<{ item: MediaWorkflowEntry }>('/api/media-workflows/save', {
                    workflow: parsed.data,
                    id: editingId,
                  });
                  await load();
                  setSelected(saved.item.id);
                  setDraft(undefined);
                  notify({ tone: 'success', message: '流程已保存，可以使用或导出。' });
                })
              }
            >
              <Save size={14} />
              保存流程
            </button>
            <button disabled={busy} onClick={() => setDraft(undefined)}>
              取消编辑
            </button>
          </div>
        </div>
      )}
      <details className="media-workflow-import">
        <summary>导入文件或下载第三方流程</summary>
        <p>导入前展示来源、许可与所需组件。流程只包含允许的本地分析参数，不运行脚本，也不包含模型或文件操作权限。</p>
        <input
          ref={file}
          type="file"
          hidden
          accept=".json,application/json"
          onChange={(event) => {
            const selectedFile = event.target.files?.[0];
            event.target.value = '';
            if (!selectedFile) return;
            void run(async () => {
              if (selectedFile.size > 64 * 1024) throw new Error('流程文件不能超过 64 KB。');
              setPreview(
                await api<MediaWorkflowPreview>('/api/media-workflows/preview', { text: await selectedFile.text() }),
              );
            });
          }}
        />
        <button disabled={busy} onClick={() => file.current?.click()}>
          <FileUp size={14} />
          选择 JSON 文件
        </button>
        <div className="media-workflow-download">
          <input
            type="url"
            placeholder="https://…/workflow.json"
            value={url}
            disabled={busy}
            onChange={(event) => setUrl(event.target.value)}
            aria-label="第三方流程下载地址"
          />
          <button
            disabled={busy || !url.trim()}
            onClick={() =>
              void run(async () =>
                setPreview(await api<MediaWorkflowPreview>('/api/media-workflows/preview', { url: url.trim() })),
              )
            }
          >
            <Download size={14} />
            下载并预览
          </button>
        </div>
      </details>
      {preview && activeWorkflow && (
        <div className="media-workflow-preview" role="region" aria-label="待导入流程预览">
          <h4>{activeWorkflow.name}</h4>
          <p>{activeWorkflow.description}</p>
          <p>来源：{preview.source}</p>
          <p>
            作者：{activeWorkflow.author} · 流程许可：{activeWorkflow.license}
          </p>
          <p>所需组件：本地媒体解码与核验程序</p>
          <ol>
            {activeWorkflow.steps.map((step) => (
              <li key={step}>{mediaWorkflowStepLabels[step]}</li>
            ))}
          </ol>
          <p>
            文件上限：{activeWorkflow.parameters.maxFiles} · 候选数：
            {activeWorkflow.parameters.topK}
            {activeWorkflow.parameters.retrievalMode === 'adaptive'
              ? ' · 快速去重：指纹预筛与本地核验'
              : ' · 对应位置指纹：视频候选主要覆盖时长相近的版本'}
          </p>
          <div className="media-workflow-actions">
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const saved = await api<{ item: MediaWorkflowEntry }>('/api/media-workflows/import', {
                    token: preview.token,
                  });
                  await load();
                  setSelected(saved.item.id);
                  setPreview(undefined);
                  setUrl('');
                  notify({ tone: 'success', message: '流程已导入，开始分析前请选择本次目录。' });
                })
              }
            >
              导入这个流程
            </button>
            <button disabled={busy} onClick={() => setPreview(undefined)}>
              取消预览
            </button>
          </div>
        </div>
      )}
      <div className="media-workflow-scope">
        <label>
          本次分析目录
          <textarea
            rows={3}
            placeholder="每行一个文件夹完整路径"
            value={folders}
            disabled={busy}
            onChange={(event) => setFolders(event.target.value)}
          />
        </label>
        <div className="media-workflow-actions">
          {desktopBridge() && (
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const folder = await desktopBridge()!.pickDirectory();
                  if (folder)
                    setFolders((value) => [...new Set([...value.split(/\r?\n/).filter(Boolean), folder])].join('\n'));
                })
              }
            >
              <FolderOpen size={14} />
              选择目录
            </button>
          )}
          <button
            disabled={busy || !current || !!draft || !folders.trim() || (!conversationId && !ensureConversation)}
            onClick={() =>
              void run(async () => {
                const id = conversationId ?? (await ensureConversation!());
                setCreatedConversationId(id);
                const started = await api<{ id: string }>('/api/media-analysis', {
                  workflowId: selected,
                  conversationId: id,
                  folders: folders
                    .split(/\r?\n/)
                    .map((folder) => folder.trim())
                    .filter(Boolean),
                });
                notify({ tone: 'success', message: '本地分析已开始，可在“更多 → 本地流程”查看进度与匹配证据。' });
                await loadJobs();
                onStarted?.(started.id);
              })
            }
          >
            <Play size={14} />
            {busy ? '正在处理…' : '开始本地分析'}
          </button>
        </div>
        <p className="media-workflow-meta">
          {conversationId || ensureConversation
            ? '仅分析你在这里选择的目录，不移动、改名或删除文件。'
            : '在对话中打开本地流程即可开始分析；此页用于管理和分享流程。'}
        </p>
      </div>
      {ownerId && (
        <section className="media-workflow-history" aria-label="本地分析记录">
          <div className="media-workflow-history-heading">
            <h4>本地分析记录</h4>
            <button disabled={reportBusy} onClick={() => void loadJobs()}>
              刷新记录
            </button>
          </div>
          {jobError && (
            <p role="alert" className="media-workflow-error">
              {jobError}
            </p>
          )}
          {!jobs.length && <p className="media-workflow-meta">这条对话还没有本地分析记录。</p>}
          <div className="media-workflow-jobs">
            {jobs.map((job) => (
              <div key={job.id} className="media-workflow-job">
                <div>
                  <strong>
                    {job.status === 'completed' && job.scope?.status === 'partial'
                      ? '本批结束 · 目录未扫描完整'
                      : job.status === 'completed' && job.limits?.length
                        ? '本批结束 · 有未覆盖项'
                        : mediaStatusLabels[job.status]}
                  </strong>
                  <small>{new Date(job.createdAt).toLocaleString(currentLocale())}</small>
                  <p>{job.progress}</p>
                  <small>
                    {job.counts.files} 个文件 · {job.counts.results} 项匹配 · {job.counts.errors} 项读取问题
                  </small>
                </div>
                <button disabled={reportBusy} onClick={() => void viewReport(job.id)}>
                  查看证据
                </button>
              </div>
            ))}
          </div>
          {report && (
            <div className="media-workflow-results" aria-label="媒体匹配证据">
              <div className="media-workflow-history-heading">
                <h4>
                  分析结果 · {mediaStatusLabels[jobs.find((job) => job.id === report.id)?.status ?? report.status]}
                </h4>
                <button disabled={reportBusy} onClick={() => void viewReport(report.id, report.offset, false)}>
                  刷新结果
                </button>
              </div>
              {report.execution?.actualEngine && (
                <p className="media-workflow-meta">
                  实际引擎：{report.execution.actualEngine === 'gemma' ? 'EmbeddingGemma' : '原有指纹'}
                  {report.execution.backend && <> · {report.execution.backend.toUpperCase()}</>}
                  {report.execution.retrievalMode === 'adaptive' ? (
                    report.execution.actualEngine === 'gemma' ? (
                      <> · 快速预筛，模型只辅助疑似组合排序</>
                    ) : (
                      <> · 快速预筛，本次未调用模型</>
                    )
                  ) : (
                    report.execution.actualEngine === 'gemma' && (
                      <>
                        {' '}
                        · 视频约每 {report.execution.videoSampleSeconds} 秒取样 · 每文件最多 {report.execution.topK}{' '}
                        个候选
                      </>
                    )
                  )}
                </p>
              )}
              {(report.scope?.status === 'partial' || !!report.limits?.length) && (
                <div className="media-workflow-warning">
                  {report.scope?.status === 'partial' && <p>目录未扫描完整，结果仅覆盖已列出的文件。</p>}
                  {!!report.limits?.length && (
                    <ul>
                      {report.limits.slice(0, 3).map((limit, index) => (
                        <li key={index}>{limit.message}</li>
                      ))}
                    </ul>
                  )}
                  {report.limits?.length > 3 && <p>其他未覆盖项请展开“分析说明与覆盖范围”。</p>}
                </div>
              )}
              <details>
                <summary>分析说明与覆盖范围</summary>
                <pre>{report.summary}</pre>
                <ul>
                  {report.coverage.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              </details>
              {!report.results.length && (
                <p>
                  {report.status === 'running' || report.status === 'queued'
                    ? '正在分析，匹配结果会逐步更新。'
                    : '本页没有匹配证据。'}
                </p>
              )}
              <div className="media-workflow-evidence-list">
                {report.results.slice(0, expandedResults ? report.results.length : 3).map((item, index) => (
                  <article key={`${item.a}:${item.b}`} className="media-workflow-evidence">
                    <strong>
                      {report.offset + index + 1}. {mediaEvidenceTitle(item)}
                    </strong>
                    <button
                      title={item.a}
                      className="media-workflow-path"
                      onClick={() =>
                        void revealReplyPath(item.a, api).catch((reason) =>
                          notify({ tone: 'error', message: message(reason) }),
                        )
                      }
                    >
                      {item.a}
                    </button>
                    <button
                      title={item.b}
                      className="media-workflow-path"
                      onClick={() =>
                        void revealReplyPath(item.b, api).catch((reason) =>
                          notify({ tone: 'error', message: message(reason) }),
                        )
                      }
                    >
                      {item.b}
                    </button>
                    <p>{item.explanation}</p>
                    {item.visual && <p className="media-workflow-meta">{mediaEvidenceSampleLabel(item)}</p>}
                    {item.visual && (
                      <p className="media-workflow-meta">
                        匹配位置：第一份 {item.visual.spanA[0].toFixed(1)}–{item.visual.spanA[1].toFixed(1)} 秒；第二份{' '}
                        {item.visual.spanB[0].toFixed(1)}–{item.visual.spanB[1].toFixed(1)} 秒
                      </p>
                    )}
                  </article>
                ))}
              </div>
              <div className="media-workflow-actions">
                {report.results.length > 3 && (
                  <button onClick={() => setExpandedResults(!expandedResults)}>
                    {expandedResults ? '收起本页证据' : `显示本页全部 ${report.results.length} 项`}
                  </button>
                )}
                {report.offset > 0 && (
                  <button
                    disabled={reportBusy}
                    onClick={() => void viewReport(report.id, Math.max(0, report.offset - 20))}
                  >
                    上一页证据
                  </button>
                )}
                {report.nextOffset !== null && (expandedResults || report.results.length <= 3) && (
                  <button disabled={reportBusy} onClick={() => void viewReport(report.id, report.nextOffset!)}>
                    下一页证据
                  </button>
                )}
              </div>
            </div>
          )}
        </section>
      )}
    </section>
  );
}

const mediaStatusLabels: Record<MediaAnalysisReport['status'], string> = {
  queued: '等待本地分析',
  running: '正在本地分析',
  completed: '本地分析完成',
  interrupted: '本地分析已暂停',
  cancelled: '本地分析已停止',
  failed: '本地分析失败',
};
