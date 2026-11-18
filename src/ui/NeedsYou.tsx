import { useRef, useState } from 'react';
import { CircleAlert, ListChecks, MessageCircleQuestion, RotateCcw, ShieldCheck, X } from 'lucide-react';
import type { Conversation, RunRecord, Workflow } from '../shared/types';
import { workflowAttention } from '../shared/conversation-activity';
import type { Api, Notice } from './Workspace';
import { currentLocale } from './i18n';

export function NeedsYou({
  conversations,
  workflows,
  runs,
  onSelect,
  api,
  notify,
  now = Date.now(),
}: {
  conversations: Conversation[];
  workflows: Workflow[];
  runs: RunRecord[];
  onSelect: (conversation: Conversation, workflow: Workflow) => void;
  api: Api;
  notify: (notice: Notice) => void;
  now?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState<string[]>([]);
  const busy = useRef(new Set<string>());
  const byId = new Map(
    conversations
      .filter((item) => !item.archivedAt && !item.deletedAt && !item.sideChat)
      .map((item) => [item.id, item]),
  );
  const runById = new Map(runs.map((run) => [run.id, run]));
  const items = workflows
    .flatMap((workflow) => {
      const conversation = byId.get(workflow.conversationId);
      const attention = workflowAttention(workflow, runById.get(workflow.runIds?.at(-1) ?? ''), now);
      return conversation && attention ? [{ workflow, conversation, attention }] : [];
    })
    .sort(
      (a, b) =>
        (b.workflow.createdAt ?? '').localeCompare(a.workflow.createdAt ?? '') ||
        a.workflow.id.localeCompare(b.workflow.id),
    );
  async function act(workflow: Workflow, action: 'continue' | 'dismiss-attention') {
    if (busy.current.has(workflow.id)) return;
    busy.current.add(workflow.id);
    setPending([...busy.current]);
    try {
      await api(
        `/api/workflows/${encodeURIComponent(workflow.id)}/${action}`,
        action === 'continue' ? { uiLocale: currentLocale() } : {},
        'POST',
      );
    } catch (error) {
      notify({ tone: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      busy.current.delete(workflow.id);
      setPending([...busy.current]);
    }
  }
  if (!items.length) return null;
  return (
    <section className="needs-you" aria-label="等你处理">
      <div className="project-heading">
        <span>等你处理</span>
        <span className="nav-count">{items.length}</span>
      </div>
      {(expanded ? items : items.slice(0, 5)).map(({ workflow, conversation, attention }) => {
        const Icon = {
          question: MessageCircleQuestion,
          approval: ShieldCheck,
          confirmation: ListChecks,
          stopped: CircleAlert,
        }[attention.kind];
        return (
          <div className="needs-you-row" key={workflow.id}>
            <button className="conversation-link needs-you-link" onClick={() => onSelect(conversation, workflow)}>
              <Icon
                size={14}
                className={attention.kind === 'stopped' ? 'needs-you-warning' : undefined}
                aria-hidden="true"
              />
              <span className="needs-you-copy">
                <span className="needs-you-title" translate="no">
                  {conversation.title}
                </span>
                <span className="needs-you-reason">
                  {attention.kind === 'question' ? (
                    <span translate="no">{attention.text}</span>
                  ) : attention.kind === 'approval' ? (
                    '等你批准'
                  ) : attention.kind === 'confirmation' ? (
                    '等你确认方案'
                  ) : (
                    <>
                      <span>停下了</span>
                      {attention.text && (
                        <>
                          {' '}
                          · <span translate="no">{attention.text}</span>
                        </>
                      )}
                    </>
                  )}
                </span>
              </span>
            </button>
            {attention.kind === 'stopped' && (
              <div className="needs-you-actions">
                <button
                  className="icon-button"
                  title="继续"
                  aria-label="继续"
                  disabled={pending.includes(workflow.id)}
                  onClick={() => void act(workflow, 'continue')}
                >
                  <RotateCcw size={14} />
                </button>
                <button
                  className="icon-button"
                  title="忽略"
                  aria-label="忽略"
                  disabled={pending.includes(workflow.id)}
                  onClick={() => void act(workflow, 'dismiss-attention')}
                >
                  <X size={14} />
                </button>
              </div>
            )}
          </div>
        );
      })}
      {!expanded && items.length > 5 && (
        <button className="needs-you-more" onClick={() => setExpanded(true)}>{`还有 ${items.length - 5} 项`}</button>
      )}
    </section>
  );
}
