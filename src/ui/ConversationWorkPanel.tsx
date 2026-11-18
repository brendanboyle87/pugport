import { currentLocale } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { Conversation, Project, Workflow } from '../shared/types';
import { ProjectCliContext } from './ProjectCliContext';
import { CreateChildDialog } from './CreateChildDialog';
import type { ConversationJob, ConversationMail } from '../server/conversation-automation';
import type { Api, Notice } from './Workspace';
import { useUiUpdateBlocker } from './ui-update-guard';
import { canUseConversationCollaboration } from '../shared/conversation-collaboration';

export function ConversationWorkPanel({
  conversation,
  project,
  workflows = [],
  api,
  reload,
  notify,
  onConversation,
  onClose,
}: {
  conversation: Conversation;
  project?: Project;
  workflows?: readonly Workflow[];
  api: Api;
  reload(): Promise<void>;
  notify(notice: Notice): void;
  onConversation(conversation: Conversation): void;
  onClose(): void;
}) {
  const [data, setData] = useState<{ jobs: ConversationJob[]; messages: ConversationMail[] }>({
    jobs: [],
    messages: [],
  });
  const [peers, setPeers] = useState<Array<Pick<Conversation, 'id' | 'title'>>>([]);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [name, setName] = useState(''),
    [prompt, setPrompt] = useState('');
  const [kind, setKind] = useState('once'),
    [at, setAt] = useState(''),
    [minutes, setMinutes] = useState('5');
  const [repository, setRepository] = useState(''),
    [number, setNumber] = useState('');
  const [recipient, setRecipient] = useState(''),
    [message, setMessage] = useState('');
  const [laneTitle, setLaneTitle] = useState('');
  const [childParent, setChildParent] = useState<Workflow>();
  const [parentId, setParentId] = useState('');
  const active = useRef(true),
    pending = useRef(false);
  const requestIds = useRef<Partial<Record<'lane' | 'job' | 'mail', { key: string; id: string }>>>({});
  function requestId(kind: 'lane' | 'job' | 'mail', payload: unknown) {
    const key = JSON.stringify(payload);
    if (requestIds.current[kind]?.key !== key) requestIds.current[kind] = { key, id: crypto.randomUUID() };
    return requestIds.current[kind]!.id;
  }
  useUiUpdateBlocker(() => !!(name || prompt || message || laneTitle || pending.current), 'conversation-work');
  const root = `/api/conversations/${encodeURIComponent(conversation.id)}/work`;
  const collaborationAllowed = canUseConversationCollaboration(project, conversation);
  const plainChat = project?.scope === 'chat';
  const completedParents = workflows
    .filter(
      (workflow) =>
        workflow.conversationId === conversation.id &&
        workflow.status === 'completed' &&
        !workflow.deletedAt &&
        !workflow.delegation &&
        !workflow.parentWorkflowId,
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const selectedParent = completedParents.find((workflow) => workflow.id === parentId) ?? completedParents[0];
  async function refresh() {
    const [next, nextPeers] = await Promise.all([
      api<typeof data>(root, undefined, 'GET'),
      api<typeof peers>(`${root}/peers`, undefined, 'GET'),
    ]);
    if (active.current) {
      setData(next);
      setPeers(nextPeers.filter((peer) => peer.id !== conversation.id));
    }
  }
  useEffect(() => {
    active.current = true;
    const read = () =>
      void refresh().catch((reason) => {
        if (active.current) setError(reason instanceof Error ? reason.message : String(reason));
      });
    read();
    const timer = setInterval(read, 5000);
    return () => {
      active.current = false;
      clearInterval(timer);
    };
  }, [conversation.id]);
  async function run(operation: () => Promise<unknown>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await operation();
      await refresh();
      await reload();
    } catch (reason) {
      if (active.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }
  return (
    <section className="conversation-work-panel" aria-label="协作与后台工作">
      <header>
        <div>
          <strong>协作与后台工作</strong>
          <p className="quiet-text">让 PugPort 在后台替你做事：定时提醒、循环任务、给别的对话捎话、拆分子任务。</p>
        </div>
        <button type="button" className="icon-button" aria-label="关闭协作面板" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <div className="conversation-work-body">
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <details>
          <summary>
            <span>安排提醒或循环工作</span>
            <span className="quiet-text">指定时间提醒你，或定期执行同一件事；PugPort 关着时不会执行。</span>
          </summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const schedule =
                  kind === 'once'
                    ? { type: 'once', at: new Date(at).toISOString() }
                    : { type: 'interval', minutes: Number(minutes) };
                const payload = {
                  name,
                  prompt,
                  schedule,
                  write: false,
                  ...(kind === 'ci' ? { pullRequest: { repository, number: Number(number) } } : {}),
                };
                await api(`${root}/jobs`, { ...payload, requestId: requestId('job', payload) });
                delete requestIds.current.job;
                setName('');
                setPrompt('');
              });
            }}
          >
            <label className="field">
              <span>名称</span>
              <input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              <span>要做什么</span>
              <textarea value={prompt} maxLength={12000} onChange={(e) => setPrompt(e.target.value)} />
            </label>
            <label className="field">
              <span>运行方式</span>
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="once">到点执行一次</option>
                <option value="interval">循环执行</option>
                {!plainChat && <option value="ci">PR 检查变化时提醒</option>}
              </select>
            </label>
            {kind === 'once' ? (
              <label className="field">
                <span>本地时间</span>
                <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
              </label>
            ) : (
              <label className="field">
                <span>间隔（分钟）</span>
                <input
                  type="number"
                  min="1"
                  max="525600"
                  value={minutes}
                  onChange={(e) => setMinutes(e.target.value)}
                />
              </label>
            )}
            {kind === 'ci' && (
              <>
                <label className="field">
                  <span>仓库</span>
                  <input
                    value={repository}
                    onChange={(e) => setRepository(e.target.value)}
                    placeholder="owner/repository"
                  />
                </label>
                <label className="field">
                  <span>PR 编号</span>
                  <input type="number" min="1" value={number} onChange={(e) => setNumber(e.target.value)} />
                </label>
              </>
            )}
            <button
              type="submit"
              className="button secondary"
              disabled={busy || !name.trim() || !prompt.trim() || (kind === 'once' && !at)}
            >
              安排工作
            </button>
          </form>
          <p className="quiet-text">
            {plainChat
              ? '界面创建的后台工作默认为只读。'
              : '界面创建的后台工作默认为只读。PR 监控使用本机 gh 登录，只在检查变化时唤醒模型。'}
          </p>
          <div className="conversation-job-list">
            {data.jobs.map((job) => (
              <article key={job.id}>
                <strong>{job.name}</strong>
                <span>
                  {job.enabled ? '已启用' : '已暂停'} · {new Date(job.nextAt).toLocaleString(currentLocale())}
                </span>
                {job.pending && <small>等待当前对话空闲</small>}
                {job.error && <p className="inline-error">{job.error}</p>}
                <div>
                  <button
                    type="button"
                    className="button tiny quiet"
                    disabled={busy}
                    onClick={() => void run(() => api(`${root}/jobs/${job.id}`, { enabled: !job.enabled }, 'PATCH'))}
                  >
                    {job.enabled ? '暂停' : '恢复'}
                  </button>
                  <button
                    type="button"
                    className="button tiny quiet"
                    disabled={busy}
                    onClick={() => void run(() => api(`${root}/jobs/${job.id}`, undefined, 'DELETE'))}
                  >
                    删除
                  </button>
                </div>
              </article>
            ))}
          </div>
        </details>
        <details>
          <summary>
            <span>给其他对话发消息</span>
            <span className="quiet-text">把信息捎给另一条对话，等它空闲时处理。</span>
          </summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await api(`${root}/messages`, {
                  requestId: requestId('mail', { recipient, message }),
                  toConversationId: recipient,
                  text: message,
                  wake: true,
                });
                delete requestIds.current.mail;
                setMessage('');
              });
            }}
          >
            <label className="field">
              <span>接收对话</span>
              <select value={recipient} onChange={(e) => setRecipient(e.target.value)}>
                <option value="">选择对话</option>
                {peers.map((peer) => (
                  <option key={peer.id} value={peer.id}>
                    {peer.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>协作信息</span>
              <textarea value={message} maxLength={12000} onChange={(e) => setMessage(e.target.value)} />
            </label>
            <button type="submit" className="button secondary" disabled={busy || !recipient || !message.trim()}>
              发送并在空闲时提醒
            </button>
          </form>
          <p className="quiet-text">消息保留来源；对方收到后以只读方式回应，消息不能替用户批准新操作。</p>
          {data.messages.length > 0 && (
            <section aria-label="收到的协作信息">
              <h3>收到的协作信息 · {data.messages.length}</h3>
              {data.messages.map((mail) => (
                <article className="conversation-mail" key={mail.id}>
                  <small>
                    {mail.source === 'human' ? '用户' : 'Agent'} ·{' '}
                    {new Date(mail.createdAt).toLocaleString(currentLocale())}
                  </small>
                  <p>{mail.text}</p>
                  <small>{mail.deliveredAt ? '已提醒' : (mail.error ?? '已保存')}</small>
                </article>
              ))}
            </section>
          )}
        </details>
        <details>
          <summary>
            <span>子代理与工作线</span>
            <span className="quiet-text">拆分子任务，或另开一条对话持续跟进。</span>
          </summary>
          {completedParents.length > 1 && (
            <label className="field">
              <span>父任务</span>
              <select
                aria-label="父任务"
                value={selectedParent.id}
                disabled={busy}
                onChange={(event) => setParentId(event.target.value)}
              >
                {completedParents.map((workflow) => (
                  <option key={workflow.id} value={workflow.id} translate="no">
                    {workflow.input.content}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="chip-check conversation-collaboration-opt-in">
            <input
              type="checkbox"
              checked={conversation.collaborationEnabled === true}
              disabled={busy}
              onChange={(event) =>
                void run(async () => {
                  const saved = await api<Conversation>(
                    `${root}/settings`,
                    {
                      collaborationEnabled: event.target.checked,
                      childWorkspaceMode: conversation.childWorkspaceMode ?? 'snapshot',
                    },
                    'PATCH',
                  );
                  onConversation(saved);
                })
              }
            />
            普通对话也启用子代理（项目对话默认可用）
          </label>
          <button
            type="button"
            className="button secondary"
            disabled={busy || !collaborationAllowed || !!conversation.deletedAt || !!conversation.closedAt}
            onClick={() =>
              void run(async () => {
                const result = selectedParent
                  ? { workflow: selectedParent }
                  : await api<{ workflow?: Workflow; reason?: string }>(
                      `/api/conversations/${encodeURIComponent(conversation.id)}/delegation-parent`,
                      undefined,
                      'GET',
                    );
                if (!active.current) return;
                if (!result.workflow || result.workflow.conversationId !== conversation.id)
                  throw Error(result.reason ?? '当前对话尚无可派生的任务，请先发送一条任务。');
                setChildParent(result.workflow);
              })
            }
          >
            新建子代理
          </button>
          <label className="field">
            <span>子任务如何交付</span>
            <select
              value={conversation.childWorkspaceMode ?? 'snapshot'}
              disabled={busy}
              onChange={(event) =>
                void run(async () => {
                  const saved = await api<Conversation>(
                    `${root}/settings`,
                    {
                      collaborationEnabled: conversation.collaborationEnabled === true,
                      childWorkspaceMode: event.target.value,
                    },
                    'PATCH',
                  );
                  onConversation(saved);
                })
              }
            >
              <option value="snapshot">把文件交回主任务</option>
              <option value="branch">独立分支，通过提交和 PR 交付</option>
            </select>
          </label>
          <p className="quiet-text">独立分支从已提交版本开始，支持大型仓库；原目录未提交的文件不会带入。</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const lane = await api<Conversation>(`${root}/lanes`, {
                  requestId: requestId('lane', { title: laneTitle }),
                  title: laneTitle,
                });
                delete requestIds.current.lane;
                setLaneTitle('');
                onConversation(lane);
                onClose();
                notify({ tone: 'success', message: '已创建独立工作线，可以持续对话和续接。' });
              });
            }}
          >
            <label className="field">
              <span>新建长期工作线</span>
              <input
                value={laneTitle}
                maxLength={120}
                onChange={(e) => setLaneTitle(e.target.value)}
                placeholder="例如：实现、测试或审查"
              />
            </label>
            <button
              type="submit"
              className="button secondary"
              disabled={busy || !laneTitle.trim() || !collaborationAllowed}
            >
              创建工作线
            </button>
          </form>
          {peers.length > 0 && (
            <div className="conversation-peer-list">
              {peers.map((peer) => (
                <button
                  type="button"
                  className="button tiny quiet"
                  key={peer.id}
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent('pugport:select-conversation', { detail: peer.id }));
                    onClose();
                  }}
                >
                  {peer.title}
                </button>
              ))}
            </div>
          )}
          {!plainChat && (
            <details>
              <summary>
                <span>高级</span>
                <span className="quiet-text">设置项目上下文和固定远程查询。</span>
              </summary>
              <details>
                <summary>项目上下文与固定远程查询</summary>
                <ProjectCliContext projectId={conversation.projectId} api={api} notify={notify} />
              </details>
            </details>
          )}
        </details>
      </div>
      {childParent && (
        <CreateChildDialog
          parent={childParent}
          initialRole={childParent.status === 'completed' ? 'reviewer' : 'worker'}
          api={api}
          notify={notify}
          onClose={() => setChildParent(undefined)}
          onCreated={() => {
            void reload().catch((reason) =>
              notify({
                tone: 'error',
                message: `子任务已创建，但列表刷新失败：${reason instanceof Error ? reason.message : String(reason)}`,
              }),
            );
          }}
        />
      )}
    </section>
  );
}
