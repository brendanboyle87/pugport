import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { AppState } from '../shared/types';
import type { BackgroundWork, ConversationPresentation } from '../shared/conversation-presentation';
import { currentLocale, withNames } from './i18n';
import { formatConversationDuration } from './WorkflowElapsed';

export function ConversationBackground({
  state,
  conversationId,
  load,
  inspect,
  openConversation,
}: {
  state: Pick<AppState, 'workflows' | 'conversationPresentations' | 'backgroundTasks'>;
  conversationId: string;
  load: (workflowId: string) => Promise<ConversationPresentation>;
  inspect: (runId: string) => void;
  openConversation: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<Record<string, string>>({});
  const [now, setNow] = useState(Date.now());
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const jobs = new Map<string, BackgroundWork & { owner?: string }>();
  for (const workflow of state.workflows ?? []) {
    if (workflow.conversationId !== conversationId) continue;
    for (const job of state.conversationPresentations?.[workflow.id]?.background ?? [])
      jobs.set(job.key, { ...job, owner: workflow.id });
  }
  for (const job of state.backgroundTasks ?? []) {
    if (job.conversationId !== conversationId) continue;
    jobs.set('helper:' + job.id, {
      key: 'helper:' + job.id,
      title: job.title,
      kind: 'PugPort',
      status: 'running',
      startedAt: job.startedAt,
      tail: job.detail.split('\n').slice(-40).join('\n').slice(-8000),
    });
  }
  const visible = [...jobs.values()].filter((job) => job.status === 'running' || !hidden.has(job.key));
  const running = visible.some((job) => job.status === 'running');
  useEffect(() => {
    setHidden(new Set());
    setExpanded(new Set());
    setDetails({});
    setOpen(false);
  }, [conversationId]);
  useEffect(() => {
    if (!open || !running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open, running]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open]);
  if (!visible.length) return null;
  return (
    <div className="conversation-background" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="background-trigger"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span translate="no">{withNames('{0} 个后台任务', [String(visible.length)])}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="background-popover" aria-label="后台工作">
          <header>
            <strong>后台工作</strong>
            <button
              type="button"
              onClick={() =>
                setHidden(new Set([...jobs.values()].filter((job) => job.status !== 'running').map((job) => job.key)))
              }
            >
              <span data-i18n="清空后台任务">清空</span>
            </button>
          </header>
          {(['running', 'ended'] as const).map((section) => {
            const entries = visible.filter((job) => (job.status === 'running') === (section === 'running'));
            if (!entries.length) return null;
            return (
              <details open key={section} className="background-section">
                <summary>
                  <span>{section === 'running' ? '运行中' : '已结束'}</span> {entries.length}
                </summary>
                {entries.map((job) => (
                  <div key={job.key} className="background-work-row">
                    <button
                      type="button"
                      className="background-work-summary"
                      aria-expanded={expanded.has(job.key)}
                      onClick={() =>
                        setExpanded((previous) => {
                          const next = new Set(previous);
                          next.has(job.key) ? next.delete(job.key) : next.add(job.key);
                          return next;
                        })
                      }
                    >
                      <i className={'background-dot ' + job.status} />
                      <span>{job.kind}</span>
                      <span
                        className={
                          'background-work-title' + (['pwsh', 'bash'].includes(job.kind) ? ' background-command' : '')
                        }
                        title={job.title}
                        translate="no"
                      >
                        {job.title}
                      </span>
                      <small>
                        {job.status === 'failed' ? (
                          '失败'
                        ) : job.exitCode !== undefined ? (
                          <span translate="no">{'exit code ' + job.exitCode}</span>
                        ) : (
                          ''
                        )}
                      </small>
                      <time translate="no">
                        {formatConversationDuration(
                          (job.status === 'running' ? now : Date.parse(job.endedAt ?? '')) -
                            Date.parse(job.startedAt ?? ''),
                          currentLocale(),
                        )}
                      </time>
                      <ChevronRight size={14} />
                    </button>
                    {expanded.has(job.key) && (
                      <div className="background-work-body">
                        <pre translate="no">{details[job.key] ?? job.tail}</pre>
                        {job.owner && !details[job.key] && (
                          <button
                            type="button"
                            onClick={() =>
                              void load(job.owner!)
                                .then((value) => {
                                  const full = value.background?.find((item) => item.key === job.key);
                                  setDetails((previous) => ({
                                    ...previous,
                                    [job.key]: full?.output || full?.tail || job.tail,
                                  }));
                                })
                                .catch(() => setDetails((previous) => ({ ...previous, [job.key]: job.tail })))
                            }
                          >
                            加载完整输出
                          </button>
                        )}
                        {(job.runId || job.conversationId) && (
                          <button
                            type="button"
                            onClick={() =>
                              job.conversationId && job.conversationId !== conversationId
                                ? openConversation(job.conversationId)
                                : job.runId && inspect(job.runId)
                            }
                          >
                            打开
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </details>
            );
          })}
        </div>
      )}
    </div>
  );
}
