import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { mergeNarration } from './narration';
import {
  ChevronRight,
  FileText,
  Image,
  Search,
  Pencil,
  Terminal,
  Globe,
  Users,
  ListChecks,
  MessageCircle,
  Brain,
  Wrench,
} from 'lucide-react';
import type { ConversationPresentation, PresentationItem } from '../shared/conversation-presentation';
import {
  activityArgument,
  activityCategory,
  activityLabel,
  activitySummary,
  toolFailureReason,
  type ActivityCategory,
} from '../shared/activity-vocabulary';
import type { TrajectoryRow } from '../shared/trajectory';
import type { RunRecord, Workflow } from '../shared/types';
import { WorkflowElapsed, formatConversationDuration } from './WorkflowElapsed';
import { currentLocale, shownName, translateInterfaceText, withNames } from './i18n';
import { reasoningPreview } from '../shared/reasoning-preview';
import type { ReactNode } from 'react';

const icons = {
  read: FileText,
  image: Image,
  search: Search,
  write: Pencil,
  edit: Pencil,
  command: Terminal,
  webSearch: Globe,
  webFetch: Globe,
  browser: Globe,
  member: Users,
  plan: ListChecks,
  question: MessageCircle,
  thinking: Brain,
  pugport: Wrench,
  other: Wrench,
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown) =>
  typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value, null, 2);
function sourceOf(row: TrajectoryRow) {
  const detail = object(JSON.parse(row.detail || '{}'));
  return { ...object(detail.native), ...object(detail.pugport) };
}
function argumentsOf(source: Record<string, unknown>) {
  const input = source.arguments ?? source.input;
  if (typeof input !== 'string') return object(input);
  try {
    return object(JSON.parse(input));
  } catch {
    return {};
  }
}
const toolSentences: Record<ActivityCategory, string> = {
  read: '读取 {0}',
  image: '查看图片 {0}',
  search: '搜索 {0}',
  write: '写入 {0}',
  edit: '修改 {0}',
  command: '运行 {0}',
  webSearch: '搜索网页 {0}',
  webFetch: '访问网页 {0}',
  browser: '操作浏览器 {0}',
  member: '协调成员 {0}',
  plan: '更新计划 {0}',
  question: '提问 {0}',
  thinking: '分析 {0}',
  pugport: '使用 PugPort 工具 {0}',
  other: '调用工具 {0}',
};
const turnDuration = (ms: number) => formatConversationDuration(ms, currentLocale());
function toolCategory(row: TrajectoryRow) {
  const detail = object(JSON.parse(row.detail || '{}'));
  const observations = Array.isArray(detail.observations) ? detail.observations : [];
  return activityCategory(row.label, String(object(object(observations.at(-1)).data).kind ?? ''));
}
export function turnStatus(workflow: Workflow) {
  if (workflow.status === 'completed') return '已完成';
  if (workflow.status === 'failed') return '处理失败';
  if (workflow.stopped || ['cancelled', 'interrupted'].includes(workflow.status)) return '已停止';
  if (workflow.userQuestion && !workflow.userQuestion.answeredMessageId) return '等待你的回答';
  if (workflow.status === 'waiting-approval') return '等待审批';
  if (['blocked', 'waiting-resource', 'waiting-confirmation', 'queued'].includes(workflow.status)) return '等待处理';
  return '处理中';
}
function Icon({ category }: { category: ActivityCategory }) {
  const Glyph = icons[category];
  return <Glyph size={14} aria-hidden="true" />;
}
export function ToolBody({ row, inspect }: { row: TrajectoryRow; inspect: () => void }) {
  const source = sourceOf(row);
  const input = source.arguments ?? source.input;
  const args = argumentsOf(source);
  const command = text(source.command ?? args.command ?? args.cmd);
  const output = text(source.output ?? source.result ?? row.text);
  const category = toolCategory(row);
  const results = object(source.result).results ?? source.result;
  const cards =
    ['webSearch', 'webFetch'].includes(category) && Array.isArray(results)
      ? results.map(object).filter((card) => typeof card.url === 'string' && /^https?:\/\//i.test(card.url))
      : [];
  const body = ['read', 'search'].includes(category)
    ? output.split('\n').slice(0, 8).join('\n')
    : category === 'edit'
      ? output.split('\n').slice(0, 9).join('\n')
      : output;
  return (
    <div className="turn-tool-body">
      <div className="turn-tool-body-head">
        <small translate="no">{category === 'edit' ? text(args.path ?? args.file_path ?? args.file) : ''}</small>
        <button type="button" className="turn-inspect" onClick={inspect}>
          在轨迹中查看
        </button>
      </div>
      {command && (
        <pre className="turn-command" translate="no">
          {command}
        </pre>
      )}
      {!command && category !== 'edit' && input !== undefined && <pre translate="no">{text(input)}</pre>}
      {cards.length > 0 && (
        <ul className="turn-web-results">
          {cards.map((card, index) => (
            <li key={index}>
              <a href={String(card.url)} target="_blank" rel="noreferrer" translate="no">
                {text(card.title || card.url)}
              </a>
              <p translate="no">{text(card.snippet || card.description)}</p>
            </li>
          ))}
        </ul>
      )}
      {body && !cards.length && (
        <pre className="turn-output" translate="no">
          {body}
        </pre>
      )}
      {!body && !command && input === undefined && <p>此调用未保留详情。</p>}
    </div>
  );
}
/** Everything a failed tool reported about its failure, only to classify it. */
function failureText(source: Record<string, unknown>, row: TrajectoryRow) {
  const result = object(source.result);
  const observations = object(JSON.parse(row.detail || '{}')).observations;
  const last = object(Array.isArray(observations) ? observations.at(-1) : undefined);
  return [
    source.failureMessage,
    source.failureDetail,
    source.error,
    result.error,
    result.message,
    source.output,
    typeof source.result === 'string' ? source.result : undefined,
    last.text,
    row.text,
  ]
    .map((value) => (typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value)))
    .filter(Boolean)
    .join('\n');
}
export function ToolRow({ row, inspect }: { row: TrajectoryRow; inspect: (key: string) => void }) {
  const source = sourceOf(row);
  const args = argumentsOf(source);
  const category = toolCategory(row);
  const keyArgument =
    category === 'command'
      ? (source.command ?? args.command ?? args.cmd)
      : ['read', 'write', 'edit', 'image'].includes(category)
        ? (args.path ?? args.file_path ?? args.file)
        : ['search', 'webSearch'].includes(category)
          ? (args.query ?? args.pattern)
          : category === 'webFetch'
            ? args.url
            : undefined;
  const argument = activityArgument({ command: keyArgument }) || activityArgument({ ...source, ...args });
  const title = withNames(toolSentences[category], [argument]).trim();
  const exitCode = source.exitCode ?? object(source.result).exitCode;
  const output = text(source.output ?? source.result);
  const lines = output.split('\n');
  const diff =
    category === 'edit'
      ? `+${lines.filter((line) => /^\+(?!\+\+)/.test(line)).length} −${lines.filter((line) => /^-(?!--)/.test(line)).length}`
      : undefined;
  // A failed command says its exit code; any other failed tool a short reason, never the raw error or address.
  const failure =
    row.status !== 'failed'
      ? ''
      : category === 'command' && exitCode !== undefined
        ? withNames('退出码 {0}', [String(exitCode)])
        : translateInterfaceText(toolFailureReason(failureText(source, row)));
  return (
    <details className={`turn-tool turn-tool-${row.status}`}>
      <summary>
        <ChevronRight size={14} />
        <Icon category={category} />
        <span className="turn-tool-title" translate="no">
          {title}
        </span>
        <small translate="no">{failure || diff || ''}</small>
      </summary>
      <ToolBody row={row} inspect={() => inspect(row.key)} />
    </details>
  );
}

export function ConversationTurn({
  workflow,
  runs,
  projection,
  targets = [],
  loadDetail,
  inspect,
  renderText,
  liveReply,
}: {
  workflow: Workflow;
  runs: RunRecord[];
  projection: ConversationPresentation;
  targets?: { id: string; label: string }[];
  loadDetail: () => Promise<ConversationPresentation>;
  inspect: (runId: string, key: string) => void;
  renderText: (text: string) => ReactNode;
  liveReply?: { runId: string; text: string };
}) {
  const completed = workflow.status === 'completed';
  const active = ['running', 'planning'].includes(workflow.status);
  const [expanded, setExpanded] = useState(!completed);
  const [detail, setDetail] = useState<ConversationPresentation>();
  const [error, setError] = useState(false);
  const [groups, setGroups] = useState<Set<string>>(new Set());
  const explicit = useRef<boolean | undefined>(undefined);
  const root = useRef<HTMLDivElement>(null);
  const previous = useRef(completed);
  const loader = useRef(loadDetail);
  loader.current = loadDetail;
  // Before a run starts there is no detail to load; the compact projection carries the waiting reason.
  const started = !!workflow.runIds?.length;
  useEffect(() => {
    if (!expanded || !started) return;
    let disposed = false;
    let busy = false;
    let failures = 0;
    let notice: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (busy || retry) return;
      busy = true;
      try {
        const value = await loader.current();
        failures = 0;
        clearTimeout(notice);
        notice = undefined;
        if (!disposed) {
          setDetail(value);
          setError(false);
        }
      } catch {
        // A restart or a not-yet-saved task fails a load for a moment; keep retrying instead of staying stuck.
        if (!disposed) {
          notice ??= setTimeout(() => {
            if (!disposed) setError(true);
          }, 30_000);
          retry = setTimeout(
            () => {
              retry = undefined;
              void refresh();
            },
            Math.min(15_000, 1_000 * 2 ** failures++),
          );
        }
      } finally {
        busy = false;
      }
    };
    setError(false);
    void refresh();
    const timer = active ? setInterval(() => void refresh(), 500) : undefined;
    return () => {
      disposed = true;
      clearInterval(timer);
      clearTimeout(retry);
      clearTimeout(notice);
    };
  }, [expanded, started, workflow.id, workflow.status, active]);
  useLayoutEffect(() => {
    if (previous.current === completed) return;
    previous.current = completed;
    if (!completed) {
      setExpanded(true);
      return;
    }
    if (explicit.current === true) return;
    const element = root.current;
    if (!element) {
      setExpanded(false);
      return;
    }
    const scroller = element.closest('.conversation-scroll') as HTMLElement | null;
    const overflowAnchor = scroller?.style.overflowAnchor ?? '';
    if (scroller) scroller.style.overflowAnchor = 'none';
    if (scroller) scroller.dataset.turnFolding = 'true';
    const anchor = scroller
      ? [...scroller.querySelectorAll<HTMLElement>('.conversation-message, .turn-status')].find(
          (node) => node.getBoundingClientRect().top >= scroller.getBoundingClientRect().top,
        )
      : undefined;
    const top = anchor?.getBoundingClientRect().top;
    let anchorFrame = 0;
    const keepAnchor = () => {
      if (scroller && anchor?.isConnected && top !== undefined)
        scroller.scrollTop += anchor.getBoundingClientRect().top - top;
    };
    const settle = () => {
      if (explicit.current === true) {
        element
          .querySelector('.turn-process')
          ?.getAnimations()
          .forEach((animation) => animation.cancel());
        cancelAnimationFrame(anchorFrame);
        if (scroller) {
          delete scroller.dataset.turnFolding;
          scroller.style.overflowAnchor = overflowAnchor;
        }
        return;
      }
      setExpanded(false);
      requestAnimationFrame(() => {
        if (scroller) delete scroller.dataset.turnFolding;
        if (scroller && anchor?.isConnected && top !== undefined)
          scroller.scrollTop += anchor.getBoundingClientRect().top - top;
        requestAnimationFrame(() => {
          keepAnchor();
          cancelAnimationFrame(anchorFrame);
          if (scroller) scroller.style.overflowAnchor = overflowAnchor;
        });
      });
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      settle();
      return;
    }
    const process = element.querySelector<HTMLElement>('.turn-process');
    if (!process) {
      settle();
      return;
    }
    let disposed = false;
    const followAnchor = () => {
      if (disposed) return;
      keepAnchor();
      anchorFrame = requestAnimationFrame(followAnchor);
    };
    anchorFrame = requestAnimationFrame(followAnchor);
    const fade = process.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 70, fill: 'forwards' });
    let shrink: Animation | undefined;
    void fade.finished
      .then(async () => {
        if (disposed) return;
        shrink = process.animate([{ height: `${process.offsetHeight}px` }, { height: '0px' }], {
          duration: 110,
          fill: 'forwards',
        });
        await shrink.finished;
        if (!disposed) settle();
      })
      .catch(() => {});
    return () => {
      disposed = true;
      cancelAnimationFrame(anchorFrame);
      if (scroller) delete scroller.dataset.turnFolding;
      if (scroller) scroller.style.overflowAnchor = overflowAnchor;
      fade.cancel();
      shrink?.cancel();
    };
  }, [completed]);
  const detailLimited = detail?.workflowId === workflow.id ? detail.detailLimited : projection.detailLimited;
  const items = mergeNarration(projection.items, detail?.workflowId === workflow.id ? detail.items : [], liveReply);
  const runLabel = (run: RunRecord) =>
    shownName(
      run.account?.label || targets.find((target) => target.id === run.route.runtimeId)?.label || run.route.runtimeId,
    );
  const executor = [...new Set(runs.map(runLabel))].join(' → ');
  const latestReasoning = [...items].reverse().find((item) => item.kind === 'reasoning');
  const thinking = active && !items.some((item) => item.kind === 'activity-group' && item.live);
  const headline =
    latestReasoning?.live?.detail ?? reasoningPreview(runs.at(-1)?.reasoning ?? latestReasoning?.text ?? '', active);
  // The effective model is an object (model, effort, source); only its name belongs in the header.
  const model = runs.at(-1)?.effectiveModel?.model || runs.at(-1)?.route.model;
  const waiting = started ? undefined : projection.waiting;
  const language = currentLocale() === 'en' ? 'en' : 'zh';
  // The tail names who works now: the runs still going (parallel steps), else the latest one.
  const shownRuns = runs.filter((run) => !run.visualAssistant);
  const liveRuns = shownRuns.filter((run) => ['queued', 'running', 'waiting-approval'].includes(run.status));
  const current = liveRuns.length ? liveRuns : shownRuns.slice(-1);
  const worker = [...new Set(current.map(runLabel))].join(language === 'en' ? ', ' : '、');
  const only = current.length === 1 ? current[0] : undefined;
  // The route is fixed when a run is created; until its first word, say where the task went.
  const silent =
    !!only &&
    !only.output?.trim() &&
    !only.reasoning?.trim() &&
    liveReply?.runId !== only.id &&
    !items.some((item) => item.runId === only.id && item.kind !== 'handoff');
  const stage = !active ? undefined : !current.length ? 'choosing' : silent ? 'starting' : undefined;
  const route = only
    ? [worker, only.effectiveModel?.model || only.route.model, only.effectiveModel?.effort ?? only.route.effort].filter(
        Boolean,
      )
    : [];
  const plan = workflow.plan ?? [];
  const stepIndex = only && plan.length > 1 ? plan.findIndex((step) => step.runIds.includes(only.id)) : -1;
  const toggleGroup = (key: string) =>
    setGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const renderItem = (item: PresentationItem) => {
    if (item.kind === 'final-answer') return null;
    if (item.kind === 'narration')
      return (
        <div key={item.key} className="turn-narration" translate="no">
          {renderText(item.text ?? '')}
        </div>
      );
    if (item.kind === 'activity-group') {
      const tools = item.tools?.map((row) => (
        <ToolRow key={row.key} row={row} inspect={(key) => inspect(item.runId!, key)} />
      ));
      if (completed) return <div key={item.key}>{tools || <p>{activitySummary(item.calls ?? [], language)}</p>}</div>;
      const calls = item.calls ?? [];
      const counts = new Map<ActivityCategory, number>();
      for (const call of calls) counts.set(call.category, (counts.get(call.category) ?? 0) + 1);
      const dominant = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'thinking';
      return (
        <div key={item.key} className="turn-group">
          <button type="button" aria-expanded={groups.has(item.key)} onClick={() => toggleGroup(item.key)}>
            <ChevronRight size={14} />
            <Icon category={item.live?.category ?? dominant} />
            <span>
              {item.live ? activityLabel(item.live.category, true, language) : activitySummary(calls, language)}
            </span>
            {item.live?.detail && (
              <span className="turn-live-detail" translate="no">
                {' '}
                · {item.live.detail}
              </span>
            )}
          </button>
          {groups.has(item.key) && tools}
        </div>
      );
    }
    if (item.kind === 'reasoning')
      return (
        <details key={item.key} className="turn-reasoning">
          <summary>
            <ChevronRight size={14} />
            <Brain size={14} />
            <span className={thinking && item === latestReasoning ? 'turn-shimmer' : ''}>思考</span>
            <span translate="no">
              {' '}
              · {item === latestReasoning && active ? headline : reasoningPreview(item.text ?? item.preview ?? '')}
            </span>
          </summary>
          <div translate="no">{renderText(item.text ?? item.preview ?? '')}</div>
        </details>
      );
    return (
      <p key={item.key} className={`turn-${item.kind}`}>
        {item.kind === 'handoff' ? (
          <>
            <span>交接给</span> <span translate="no">{item.target}</span>{' '}
            <span>
              （
              {(
                {
                  quota: '额度用完',
                  authentication: '需要登录',
                  content: '内容限制',
                  technical: '连接中断',
                  selection: '切换执行器',
                } as Record<string, string>
              )[item.reason ?? ''] ?? item.reason}
              ）
            </span>
          </>
        ) : (
          <span translate="no">{item.preview}</span>
        )}
      </p>
    );
  };
  return (
    <div ref={root} className={`conversation-turn turn-${workflow.status}`}>
      {!active && (
        <button
          type="button"
          className="turn-status"
          aria-expanded={expanded}
          onClick={() => {
            explicit.current = !expanded;
            setExpanded(!expanded);
          }}
          disabled={!completed}
        >
          <ChevronRight size={14} />
          <span>{turnStatus(workflow)}</span>
          <span> · 用时 </span>
          <WorkflowElapsed workflow={workflow} runs={runs} minimumMs={1000} formatDuration={turnDuration} />
          <span translate="no">
            {executor && ` · ${executor}`}
            {model && ` · ${model}`}
          </span>
        </button>
      )}
      {expanded ? (
        <div className="turn-process">
          {items.map(renderItem)}
          {detailLimited && (
            <div className="turn-detail-notice" role="status">
              详情记录较多，当前显示摘要；完整记录仍保留。
            </div>
          )}
          {error && (
            <div className="turn-detail-notice" role="status">
              详情暂时不可用，正在自动重试。
            </div>
          )}
        </div>
      ) : completed ? null : (
        <div className="turn-narrations">{items.filter((item) => item.kind === 'narration').map(renderItem)}</div>
      )}
      {!completed && !['failed', 'cancelled', 'interrupted'].includes(workflow.status) && (
        <div className="turn-tail" role="status">
          {stepIndex >= 0 && (
            <span className="turn-tail-step" translate="no">
              {`${withNames('第 {0}/{1} 步', [String(stepIndex + 1), String(plan.length)])} ·`}
            </span>
          )}
          {stepIndex >= 0 && ' '}
          {stage === 'choosing' ? (
            <span className="turn-tail-stage turn-shimmer">正在判断交给谁</span>
          ) : stage === 'starting' ? (
            <span className="turn-tail-stage turn-shimmer" translate="no">
              {withNames('已交给 {0}，正在启动', [route.join(' · ')])}
            </span>
          ) : (
            <>
              <span className="turn-tail-worker" translate="no">
                {worker}
              </span>{' '}
              <span className={active ? 'turn-shimmer' : ''}>{turnStatus(workflow)}</span>
            </>
          )}
          <span>，用时 </span>
          <WorkflowElapsed workflow={workflow} runs={runs} minimumMs={1000} formatDuration={turnDuration} />
          <span translate="no">…</span>
          {waiting ? (
            <span className="turn-tail-preview"> · {waiting}</span>
          ) : (
            thinking &&
            headline && (
              <span className="turn-tail-preview" translate="no">
                {' '}
                · {headline}
              </span>
            )
          )}
        </div>
      )}
    </div>
  );
}

export function ReasoningTail({
  workflow,
  runs,
  targets,
}: {
  workflow: Workflow;
  runs: RunRecord[];
  targets: { id: string; label: string }[];
}) {
  const run = runs.at(-1);
  const active = workflow.status === 'running' || workflow.status === 'planning';
  const headline = reasoningPreview(run?.reasoning ?? '', active);
  const executor =
    run?.account?.label || targets.find((target) => target.id === run?.route.runtimeId)?.label || run?.route.runtimeId;
  return (
    <div className="turn-tail" role="status">
      <span className="turn-tail-worker" translate="no">
        {executor}
      </span>{' '}
      <span className={active ? 'turn-shimmer' : ''}>{turnStatus(workflow)}</span>
      <span>，用时 </span>
      <WorkflowElapsed workflow={workflow} runs={runs} minimumMs={1000} formatDuration={turnDuration} />
      <span translate="no">…</span>
      {headline && (
        <span className="turn-tail-preview" translate="no">
          {' '}
          · {headline}
        </span>
      )}
    </div>
  );
}
