import { currentLocale } from './i18n';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { executionModel } from '../shared/execution-model';
import { namedIdentity, replyIdentity } from '../shared/reply-identity';
import { ReplyIdentity } from './ReplyIdentity';
import { ArrowUp, Loader2, LockKeyhole, MessageSquare, Pencil, RefreshCw, X } from 'lucide-react';
import type { AppState, ConversationMessage, RunRecord, Workflow } from '../shared/types';
import type { Api } from './Workspace';
import { ReasoningStream } from './ReasoningStream';
import { SteeringProgress } from './SteeringProgress';
import { ReplyPaths, useProjectPaths } from './ReplyPaths';
import { renderMarkdown } from './markdown';
import { resolveComposerSteering } from './composer-steering';
import { createFollowBottom } from './follow-bottom';
import { isActiveWorkflow, workflowDisplayStatus } from './queue-utils';
import {
  getSideChatSession,
  mergeSideChatMessages,
  sideChatEnterAction,
  type Notify,
  type SideChatLaunch,
} from './side-chat';

export type { SideChatLaunch, Notify } from './side-chat';
export type SideChatPanelProps = {
  state: AppState;
  api: Api;
  launch: SideChatLaunch;
  onClose: () => void;
  notify: Notify;
};

const SideChatText = memo(function SideChatText({ text }: { text: string }) {
  const relativePaths = useProjectPaths();
  return (
    <div className="side-chat-text markdown" data-path-scope>
      {renderMarkdown(text, { relativePaths: relativePaths || undefined })}
    </div>
  );
});

const missingDeliveryReceipt = '补充消息未确认送达，请核对侧聊任务。';

function DeliveryStatus({ message }: { message: ConversationMessage }) {
  const delivery = message.steering;
  if (!delivery) return null;
  return (
    <p
      className={`steering-status steering-${delivery.status}${delivery.status === 'failed' ? ' side-chat-error' : ''}`}
      role={delivery.status === 'failed' ? 'alert' : 'status'}
    >
      {delivery.status === 'pending'
        ? '正在补充到侧聊当前任务…'
        : delivery.status === 'accepted'
          ? '执行器已接收补充（steer）'
          : delivery.error || missingDeliveryReceipt}
    </p>
  );
}

function SideChatRun({ workflow, run, showOutput }: { workflow: Workflow; run?: RunRecord; showOutput: boolean }) {
  const status = workflowDisplayStatus(workflow, run ? [run] : []);
  return (
    <div className="side-chat-run" aria-label="侧聊执行状态">
      <div className="side-chat-run-heading">
        <span>{status.label}</span>
        {run && (
          <code>
            {executionModel(run).model}
            {executionModel(run).effort ? ` · ${executionModel(run).effort}` : ''}
          </code>
        )}
        {run?.status === 'running' && run.steerAvailable && <span className="side-chat-steer">可补充消息</span>}
      </div>
      {showOutput && run && isActiveWorkflow(workflow) && <SteeringProgress run={run} />}
      {showOutput && run?.reasoning && <ReasoningStream text={run.reasoning} open={!run.output} />}
      {showOutput && run?.output && <SideChatText text={run.output} />}
      {showOutput && run?.summary && <p className="side-chat-note">当前执行输出为摘要，完整聊天记录仍保留。</p>}
      {isActiveWorkflow(workflow) && !run?.output && !run?.reasoning && (
        <p className="side-chat-note" role="status">
          <Loader2 size={13} className="spinning" />
          正在等待侧聊回复…
        </p>
      )}
      {workflow.error && (
        <p className="side-chat-error" role="alert">
          {workflow.error}
        </p>
      )}
      {run?.error && run.error !== workflow.error && (
        <p className="side-chat-error" role="alert">
          {run.error}
        </p>
      )}
      {run?.steeringStatus?.state === 'waiting' && (
        <p className="side-chat-note">{run.steeringStatus.reason || '正在等待原生侧聊回合。'}</p>
      )}
    </div>
  );
}

export function SideChatPanel({ state, api, launch, onClose, notify }: SideChatPanelProps) {
  const session = useMemo(() => getSideChatSession(api, launch), [api, launch.requestId, launch.parentConversationId]);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const conversationId = snapshot.conversation?.id;
  const projectId =
    snapshot.conversation?.projectId ??
    state.conversations?.find((item) => item.id === launch.parentConversationId)?.projectId;
  const projectPath = state.projects?.find((item) => item.id === projectId)?.path;
  const ownLaunch = session.launch;
  const workflows = (state.workflows ?? []).filter(
    (workflow) => workflow.conversationId === conversationId && !workflow.deletedAt,
  );
  const messages = useMemo(
    () =>
      conversationId ? mergeSideChatMessages(conversationId, snapshot.messages, state.conversationMessages ?? []) : [],
    [conversationId, snapshot.messages, state.conversationMessages],
  );
  const { active, steeringRun, caption } = resolveComposerSteering(state, conversationId);
  const composition = useRef({ active: false, endedAt: -Infinity });
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const follow = useRef(createFollowBottom());
  const inputBlocked = !!active && snapshot.conversation?.queueingEnabled === false && !steeringRun;
  const available = !!conversationId && !snapshot.loading && !snapshot.sending && !inputBlocked;
  const deliveryErrorInHistory = messages.some(
    (message) =>
      message.steering?.status === 'failed' &&
      (message.steering.error || missingDeliveryReceipt) === snapshot.deliveryError,
  );
  useEffect(() => {
    void session.open().catch(() => undefined);
  }, [session]);
  const workflowSignature = workflows
    .map((workflow) => `${workflow.id}:${workflow.status}:${workflow.finalMessageId ?? ''}`)
    .join('|');
  useEffect(() => {
    if (conversationId) void session.refresh().catch(() => undefined);
  }, [session, conversationId, workflowSignature]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      void session.refresh().catch(() => undefined);
    }, 3000);
    return () => clearInterval(timer);
  }, [session, !!active]);
  useEffect(() => {
    composition.current = { active: false, endedAt: -Infinity };
    input.current?.focus();
  }, [session]);
  const streamSignature = state.runs
    .filter((run) => workflows.some((workflow) => workflow.id === run.workflowId))
    .map(
      (run) =>
        `${run.id}:${run.output.length}:${run.output.slice(-64)}:${run.reasoning?.length ?? 0}:${run.reasoning?.slice(-64) ?? ''}`,
    )
    .join('|');
  useLayoutEffect(() => {
    if (list.current) follow.current.update(list.current);
  }, [messages, streamSignature]);

  async function send() {
    if (!available || !snapshot.draft.trim()) return;
    try {
      await session.send();
      void session.refresh().catch(() => undefined);
      input.current?.focus();
    } catch {
      // The session retains the draft and exposes the delivery error inline.
    }
  }
  return (
    <aside className="side-chat-panel" aria-label="独立侧聊" data-side-chat-request={ownLaunch.requestId}>
      <header className="side-chat-heading">
        <div>
          <MessageSquare size={17} />
          <h2>侧聊</h2>
          <div className="side-chat-permission" role="radiogroup" aria-label="侧聊文件权限">
            {(['read-only', 'workspace-write'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={snapshot.permission === value}
                className={snapshot.permission === value ? 'selected' : ''}
                onClick={() => session.setPermission(value)}
              >
                {value === 'read-only' ? <LockKeyhole size={11} /> : <Pencil size={11} />}
                {value === 'read-only' ? '只读' : '可写'}
              </button>
            ))}
          </div>
        </div>
        <button
          type="button"
          className="icon-button"
          title="关闭侧聊，保留任务与记录"
          aria-label="关闭侧聊"
          onClick={onClose}
        >
          <X size={17} />
        </button>
      </header>
      {ownLaunch.quote && (
        <details className="side-chat-reference">
          <summary>引用内容 · 仅供讨论参考</summary>
          <blockquote>{ownLaunch.quote}</blockquote>
        </details>
      )}
      {snapshot.error && (
        <div className="side-chat-error" role="alert">
          <span>{snapshot.error}</span>
          <button
            type="button"
            className="button tiny secondary"
            disabled={snapshot.loading}
            onClick={() => void session.open().catch(() => undefined)}
          >
            <RefreshCw size={12} />
            重试连接
          </button>
        </div>
      )}
      <ReplyPaths key={conversationId ?? launch.requestId} projectPath={projectPath} api={api} notify={notify}>
        <div
          className="side-chat-messages"
          ref={list}
          onScroll={(event) => follow.current.onScroll(event.currentTarget)}
          aria-label="侧聊消息"
        >
          {snapshot.loading && !messages.length ? (
            <p className="side-chat-empty" role="status">
              <Loader2 size={15} className="spinning" />
              正在连接侧聊…
            </p>
          ) : null}
          {!snapshot.loading && !messages.length && (
            <p className="side-chat-empty">针对当前上下文提问，主聊任务会继续运行。</p>
          )}
          {messages.map((message) => {
            const workflow =
              message.role === 'user' ? workflows.find((item) => item.id === message.workflowId) : undefined;
            const run = workflow
              ? workflow.runIds
                  .map((id) => state.runs.find((item) => item.id === id && item.workflowId === workflow.id))
                  .filter((item): item is RunRecord => !!item)
                  .at(-1)
              : undefined;
            const showOutput =
              !!workflow &&
              (isActiveWorkflow(workflow) || !messages.some((item) => item.id === workflow.finalMessageId));
            return (
              <article key={message.id} className={`side-chat-message message-${message.role}`}>
                <div className="message-heading">
                  <span>{message.role === 'user' ? '你' : 'PugPort'}</span>
                  <time>
                    {new Date(message.createdAt).toLocaleTimeString(currentLocale(), {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </time>
                  {state.settings?.showAutomaticReplyIdentity !== false && (
                    <ReplyIdentity
                      identity={namedIdentity(
                        replyIdentity(
                          message,
                          workflows.find((item) => item.id === message.workflowId),
                          state.runs,
                        ),
                        state.targets,
                      )}
                    />
                  )}
                </div>
                <SideChatText text={message.content} />
                <DeliveryStatus message={message} />
                {workflow && !message.steering && <SideChatRun workflow={workflow} run={run} showOutput={showOutput} />}
              </article>
            );
          })}
        </div>
      </ReplyPaths>
      <form
        className="side-chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {snapshot.deliveryError && !deliveryErrorInHistory && (
          <p className="side-chat-error" role="alert">
            {snapshot.deliveryError}
          </p>
        )}
        <label className="sr-only" htmlFor={`side-chat-input-${ownLaunch.requestId}`}>
          侧聊问题
        </label>
        <textarea
          id={`side-chat-input-${ownLaunch.requestId}`}
          ref={input}
          rows={3}
          value={snapshot.draft}
          onChange={(event) => session.setDraft(event.target.value)}
          placeholder="询问当前上下文…"
          onCompositionStart={() => {
            composition.current = { active: true, endedAt: -Infinity };
          }}
          onCompositionEnd={() => {
            composition.current = { active: false, endedAt: performance.now() };
          }}
          onBlur={() => {
            composition.current = { active: false, endedAt: -Infinity };
          }}
          onKeyDown={(event) => {
            const action = sideChatEnterAction(
              {
                key: event.key,
                shiftKey: event.shiftKey,
                altKey: event.altKey,
                repeat: event.repeat,
                isComposing: event.nativeEvent.isComposing,
                keyCode: event.nativeEvent.keyCode,
              },
              composition.current,
              performance.now(),
            );
            if (action === 'send' || action === 'ignore') event.preventDefault();
            if (action === 'send') void send();
          }}
          onKeyUp={(event) => {
            if (event.key === 'Enter' && !composition.current.active) composition.current.endedAt = -Infinity;
          }}
        />
        <div className="side-chat-composer-actions">
          <small>Enter 发送 · Shift + Enter 换行</small>
          <button type="submit" className="button primary" disabled={!available || !snapshot.draft.trim()}>
            {snapshot.sending ? <Loader2 size={14} className="spinning" /> : <ArrowUp size={14} />}
            {steeringRun ? '补充' : '发送'}
          </button>
        </div>
        {inputBlocked ? (
          <p className="side-chat-note">侧聊插话通道暂不可用，当前会话未开启排队。请等待回合结束后发送。</p>
        ) : caption ? (
          <p className="side-chat-note">{caption}</p>
        ) : null}
      </form>
    </aside>
  );
}
