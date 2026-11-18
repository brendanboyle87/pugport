import { currentLocale, translateInterfaceText } from './i18n';
import type { SettingsCategory } from './settings-categories';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { connectorsEnabled } from '../shared/connectors';
import { approvalRuleLabel } from '../shared/approval-rules';
import { BookOpen, ChevronRight, Loader2, Plug, Puzzle, Route, Search, X } from 'lucide-react';
import type { Api, Notice } from './Workspace';
import type { AppState, Conversation, ConversationRouting } from '../shared/types';
import type { ExtensionView, SkillExtension } from '../shared/extensions';
import { fallbackSkillSummary, skillCategories, type SkillCategory } from '../shared/skill-summaries';
import { ExecutorChecklist } from './ExecutorChecklist';
import { executorCards, validateAutomaticExecutors } from '../shared/automatic-executors';
import { RoutingRulesEditor, RoutingCandidateEditor } from './RoutingRulesEditor';
import { WritingPreferences } from './TasteTest';
import { ConnectorPicker } from './Connectors';
import { maxActiveChildAgents, upgradeRouting, type RoutingCard } from '../shared/conversation-routing';

export type PanelTab = 'routing' | 'skills' | 'connectors' | 'memory';
type Notify = (notice: Notice) => void;
type Draft = Omit<ConversationRouting, 'updatedAt'>;

const tabs: Array<{ id: PanelTab; label: string; icon: ReactNode }> = [
  { id: 'routing', label: '路由规则', icon: <Route size={14} /> },
  { id: 'skills', label: 'Skills', icon: <Puzzle size={14} /> },
  ...(connectorsEnabled ? [{ id: 'connectors' as const, label: '连接器', icon: <Plug size={14} /> }] : []),
  { id: 'memory', label: '记忆', icon: <BookOpen size={14} /> },
];
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function routingCardsOf(state: AppState): RoutingCard[] {
  return executorCards(state.targets)
    .filter((target) => target.provider !== 'pi' || target.gateway === 'api')
    .filter((target) =>
      state.runtimes.some(
        (runtime) =>
          runtime.id === target.id &&
          runtime.installed &&
          !['missing', 'auth-required', 'error'].includes(runtime.status),
      ),
    )
    .map((target) => {
      const models = state.runtimes.find((runtime) => runtime.id === target.id)?.models;
      return {
        id: target.id,
        label: target.label,
        provider: target.provider,
        ...(models?.length ? { models: models.map(({ id, label, efforts }) => ({ id, label, efforts })) } : {}),
      };
    });
}

/** The right-hand panel of a conversation: its routing rules, the skills it may use, and project memory. */
export function ConversationPanel({
  tab,
  onTab,
  onClose,
  conversation,
  state,
  api,
  notify,
  memory,
  onManageConnectors,
  onOpenSettings,
}: {
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  onClose: () => void;
  conversation: Conversation;
  state: AppState;
  api: Api;
  notify: Notify;
  /** The project memory editor; absent when the conversation has no project. */
  memory?: ReactNode;
  onManageConnectors?: () => void;
  onOpenSettings?: (category: SettingsCategory, focusId?: string) => void;
}) {
  return (
    <aside className="conversation-panel" aria-label="对话设置">
      <header className="conversation-panel-head">
        <div role="tablist" aria-label="对话设置">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={tab === item.id ? 'active' : ''}
              onClick={() => onTab(item.id)}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
        <button type="button" className="icon-button" aria-label="关闭对话设置" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <div className="conversation-panel-body" role="tabpanel">
        {tab === 'routing' ? (
          <RoutingTab key={conversation.id} conversation={conversation} state={state} api={api} notify={notify} />
        ) : tab === 'skills' ? (
          <SkillsTab
            key={conversation.id}
            conversation={conversation}
            api={api}
            notify={notify}
            onOpenSettings={onOpenSettings}
          />
        ) : tab === 'connectors' && connectorsEnabled ? (
          <ConversationConnectors
            key={conversation.id}
            conversation={conversation}
            api={api}
            notify={notify}
            onManage={onManageConnectors}
          />
        ) : (
          <>
            <MemorySwitch key={conversation.id} conversation={conversation} api={api} notify={notify} />
            {conversation.memory !== 'off' &&
              !conversation.incognito &&
              (memory ?? <p className="panel-intro">这条对话不在项目里，没有项目记忆。</p>)}
          </>
        )}
        <ApprovalRules key={`approvals:${conversation.id}`} conversation={conversation} api={api} notify={notify} />
      </div>
    </aside>
  );
}

export function ApprovalRules({ conversation, api, notify }: { conversation: Conversation; api: Api; notify: Notify }) {
  const [pending, setPending] = useState<string>();
  async function remove(id: string) {
    setPending(id);
    try {
      await api(
        `/api/conversations/${encodeURIComponent(conversation.id)}/approval-rules/${encodeURIComponent(id)}`,
        undefined,
        'DELETE',
      );
    } catch (error) {
      notify({ tone: 'error', message: errorText(error) });
    } finally {
      setPending(undefined);
    }
  }
  if (!conversation.approvalRules?.length) return null;
  return (
    <section className="conversation-approval-rules" aria-label="已允许的操作">
      <h3 className="panel-subhead">已允许的操作</h3>
      <ul>
        {conversation.approvalRules.map((rule) => (
          <li key={rule.id}>
            <span>
              <small translate="no">{rule.tool}</small>
              {approvalRuleLabel(rule)}
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label="移除规则"
              title="移除规则"
              disabled={pending !== undefined}
              onClick={() => void remove(rule.id)}
            >
              {pending === rule.id ? <Loader2 size={14} className="spinning" /> : <X size={14} />}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ConversationConnectors({
  conversation,
  api,
  notify,
  onManage,
}: {
  conversation: Conversation;
  api: Api;
  notify: Notify;
  onManage?: () => void;
}) {
  const [value, setValue] = useState<string[]>(conversation.connectorIds ?? []);
  const [saving, setSaving] = useState(false);
  const savedIds = JSON.stringify(conversation.connectorIds ?? []);
  useEffect(() => {
    setValue(JSON.parse(savedIds));
  }, [savedIds]);
  const save = async (connectorIds: string[]) => {
    setSaving(true);
    try {
      await api(`/api/conversations/${encodeURIComponent(conversation.id)}/connectors`, { connectorIds }, 'PATCH');
      setValue(connectorIds);
      notify({ tone: 'success', message: '此对话的连接器已更新，从下一次任务开始生效。' });
    } catch (error) {
      notify({ tone: 'error', message: errorText(error) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="conversation-connectors">
      <p className="panel-intro">给这条对话选择邮箱和云文档账号。其他对话的选择互不影响，新对话默认不共享任何账号。</p>
      <ConnectorPicker
        inline
        api={api}
        value={value}
        onChange={(ids) => void save(ids)}
        disabled={saving}
        onManage={onManage}
      />
      <details className="connector-executor-support">
        <summary>执行器支持</summary>
        <p>Codex、Claude CLI、Grok、Cursor 可以在只读模式读取已授权内容。</p>
        <p>创建草稿或修改内容需要将对话文件权限设为“可写入”，并逐次确认；连接器仍受这里选定的账号和权限限制。</p>
        <p>Pi / API 通道暂未接入连接器工具。</p>
      </details>
      {saving && (
        <p className="panel-note" role="status">
          正在保存…
        </p>
      )}
    </div>
  );
}

export function RoutingTab({
  conversation,
  state,
  api,
  notify,
}: {
  conversation: Conversation;
  state: AppState;
  api: Api;
  notify: Notify;
}) {
  const saved = useMemo(
    () => (conversation.routing ? upgradeRouting(conversation.routing) : undefined),
    [conversation.routing],
  );
  const cards = useMemo(() => routingCardsOf(state), [state]);
  const draftOf = (value?: ConversationRouting): Draft | undefined => {
    if (!value) return;
    const { updatedAt: _updatedAt, ...draft } = value;
    return draft;
  };
  const [draft, setDraft] = useState<Draft | undefined>(() => draftOf(saved));
  const [saving, setSaving] = useState(false);
  const [editorRevision, setEditorRevision] = useState(0);
  useEffect(() => {
    setDraft(draftOf(saved));
    setEditorRevision((revision) => revision + 1);
  }, [saved]);
  const changed = JSON.stringify(draft) !== JSON.stringify(draftOf(saved));
  async function save(routing: Draft | null, undo = false) {
    setSaving(true);
    try {
      if (!undo) validateAutomaticExecutors(routing?.automaticExecutors, state.targets);
      const value = await api<Conversation>(
        `/api/conversations/${conversation.id}/routing`,
        undo ? { undo: true } : { routing },
        'PATCH',
      );
      setDraft(draftOf(value.routing ? upgradeRouting(value.routing) : undefined));
      setEditorRevision((revision) => revision + 1);
      notify({
        tone: 'success',
        message: undo
          ? '已撤销上一次路由修改。'
          : routing
            ? '路由规则已启用，从下一条消息开始生效。'
            : '已清除这条对话的路由规则。',
      });
    } catch (error) {
      notify({ tone: 'error', message: errorText(error) });
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="routing-tab">
      <section aria-label="自动执行器">
        <label className="routing-option">
          <input
            type="checkbox"
            checked={draft?.automaticExecutors === undefined}
            disabled={saving}
            onChange={(event) =>
              setDraft((current) => ({
                ...(current ?? { version: 2, text: '', rules: [], unparsed: [], chapterAgents: false, mask: false }),
                automaticExecutors: event.target.checked
                  ? undefined
                  : state.targets
                      .filter((target) => !state.settings?.excludedExecutors?.includes(target.id))
                      .map((target) => target.id),
              }))
            }
          />
          使用全局设置
        </label>
        {draft?.automaticExecutors === undefined ? (
          <p className="panel-note">{`跟随全局 · ${executorCards(state.targets).length} 个里 ${executorCards(state.targets).filter((card) => !state.settings?.excludedExecutors?.includes(card.id)).length} 个可自动选择`}</p>
        ) : (
          <ExecutorChecklist
            state={state}
            value={
              draft?.automaticExecutors ??
              state.targets
                .filter((target) => !state.settings?.excludedExecutors?.includes(target.id))
                .map((target) => target.id)
            }
            disabled={saving}
            onChange={(ids) =>
              setDraft((current) => ({
                ...(current ?? { version: 2, text: '', rules: [], unparsed: [], chapterAgents: false, mask: false }),
                automaticExecutors: ids,
              }))
            }
          />
        )}
      </section>
      <section aria-label="内容规则">
        <h3 className="panel-subhead">内容规则</h3>
        <RoutingRulesEditor
          key={`${conversation.id}:${editorRevision}`}
          value={draft}
          cards={cards}
          api={api}
          saved={!!saved}
          saving={saving}
          changed={changed}
          canUndo={!!conversation.routingHistory?.length}
          onUndo={() => void save(null, true)}
          onError={(message) => notify({ tone: 'error', message })}
          onChange={(value) =>
            setDraft({ ...draft, chapterAgents: draft?.chapterAgents ?? false, mask: draft?.mask ?? false, ...value })
          }
          onParsed={(value) => setDraft((current) => ({ ...value, automaticExecutors: current?.automaticExecutors }))}
          onSave={(value) => void save({ ...draft!, ...value })}
          onClear={() => void save(null)}
        />
      </section>
      {draft && (
        <details className="routing-options">
          <summary>写作分工</summary>
          <label className="routing-option">
            <input
              type="checkbox"
              checked={draft.chapterAgents}
              onChange={(event) => setDraft({ ...draft, chapterAgents: event.target.checked })}
            />
            <span>
              每一章交给一个独立的子智能体
              <small>
                每章用新的上下文写，长篇后段不掉质量；同时最多 {maxActiveChildAgents}{' '}
                个，其余排队。共享一份故事笔记（人物、时间线、伏笔）。
              </small>
            </span>
          </label>
          <label className="routing-option">
            <input
              type="checkbox"
              checked={draft.mask}
              onChange={(event) => setDraft({ ...draft, mask: event.target.checked })}
            />
            <span>
              成人段落先打码再交给其他执行器
              <small>露骨段落换成【场景1】这样的占位符，单独交给成人内容执行器写，合并时填回。</small>
            </span>
          </label>
          {(['coordinator', 'merger'] as const).map((role) => {
            const label = role === 'coordinator' ? '拆分与理解' : '合并统稿';
            return (
              <div className="routing-rule" key={role}>
                <label>
                  <input
                    type="checkbox"
                    checked={!!draft.roles?.[role]}
                    onChange={(event) => {
                      const roles = { ...draft.roles };
                      if (event.target.checked) roles[role] = {};
                      else delete roles[role];
                      setDraft({ ...draft, roles });
                    }}
                  />
                  {label}
                </label>
                {draft.roles?.[role] && (
                  <RoutingCandidateEditor
                    label={label}
                    value={draft.roles[role]}
                    cards={cards}
                    onChange={(value) => setDraft({ ...draft, roles: { ...draft.roles, [role]: value } })}
                  />
                )}
              </div>
            );
          })}
        </details>
      )}
      {saved && (
        <p className="panel-note">已启用 · 更新于 {new Date(saved.updatedAt).toLocaleString(currentLocale())}</p>
      )}
      <WritingPreferences conversation={conversation} state={state} api={api} notify={notify} />
    </div>
  );
}

const skillCategoryLabels: Record<SkillCategory, string> = {
  writing: '写作',
  coding: '编程',
  review: '审查与测试',
  research: '研究',
  data: '数据与文件',
  design: '设计与媒体',
  cloud: '云与基础设施',
  productivity: '效率工具',
  other: '其他',
};

function skillsCollapseKey() {
  try {
    const windowKey = 'pugport.skills.window';
    let id = sessionStorage.getItem(windowKey);
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(windowKey, id);
    }
    return `pugport.skills.collapsed.${id}`;
  } catch {
    return undefined;
  }
}

export function SkillsTab({
  conversation,
  api,
  notify,
  onOpenSettings,
}: {
  conversation: Conversation;
  api: Api;
  notify: Notify;
  onOpenSettings?: (category: SettingsCategory, focusId?: string) => void;
}) {
  const [skills, setSkills] = useState<SkillExtension[]>();
  const [loadError, setLoadError] = useState('');
  const [retry, setRetry] = useState(0);
  const [chosen, setChosen] = useState(() => new Set(conversation.appliedSkills ?? []));
  const [saving, setSaving] = useState<string>();
  const [query, setQuery] = useState('');
  const [collapseKey] = useState(skillsCollapseKey);
  const [collapsed, setCollapsed] = useState<Set<SkillCategory>>(() => {
    try {
      const saved: unknown = JSON.parse((collapseKey && localStorage.getItem(collapseKey)) || '[]');
      return new Set(Array.isArray(saved) ? saved.filter((key) => skillCategories.includes(key)) : []);
    } catch {
      return new Set();
    }
  });
  const [language, setLanguage] = useState(currentLocale);
  useEffect(() => {
    const changed = () => setLanguage(currentLocale());
    window.addEventListener?.('pugport-locale-changed', changed);
    return () => window.removeEventListener?.('pugport-locale-changed', changed);
  }, []);
  const pending = useRef(false);
  const mounted = useRef(false);
  const latestConversation = useRef(conversation);
  latestConversation.current = conversation;
  useEffect(() => {
    mounted.current = true;
    let active = true;
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const data = await api<{ items?: ExtensionView[] }>(`/api/extensions?language=${language}`, undefined, 'GET');
        if (active) {
          setSkills((data.items ?? []).filter((item) => item.kind === 'skill'));
          setLoadError('');
        }
      } catch {
        if (active) setLoadError('技能列表暂时读不到');
      } finally {
        loading = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5_000);
    return () => {
      active = false;
      mounted.current = false;
      clearInterval(timer);
    };
  }, [api, language, retry]);
  useEffect(() => {
    try {
      if (collapseKey) localStorage.setItem(collapseKey, JSON.stringify([...collapsed]));
    } catch {
      // Storage can be unavailable; the current panel still remembers its state.
    }
  }, [collapseKey, collapsed]);
  useEffect(() => {
    if (!pending.current) setChosen(new Set(conversation.appliedSkills ?? []));
  }, [conversation.appliedSkills]);
  async function toggle(name: string, applied: boolean) {
    if (pending.current) return;
    pending.current = true;
    const previous = chosen;
    const observed = JSON.stringify(conversation.appliedSkills ?? []);
    const incomingChanged = () => JSON.stringify(latestConversation.current.appliedSkills ?? []) !== observed;
    const next = new Set([...chosen].filter((name) => skills?.some((skill) => skill.name === name)));
    if (applied) next.add(name);
    else next.delete(name);
    setChosen(next);
    setSaving(name);
    try {
      const saved = await api<Conversation>(
        `/api/conversations/${encodeURIComponent(conversation.id)}/skills`,
        { appliedSkills: [...next] },
        'PATCH',
      );
      if (mounted.current) {
        const latest = latestConversation.current;
        const newerIncoming =
          incomingChanged() && (!saved.updatedAt || !latest.updatedAt || latest.updatedAt > saved.updatedAt);
        setChosen(new Set((newerIncoming ? latest.appliedSkills : saved.appliedSkills) ?? []));
      }
    } catch (error) {
      if (mounted.current) {
        setChosen(incomingChanged() ? new Set(latestConversation.current.appliedSkills ?? []) : previous);
        notify({ tone: 'error', message: errorText(error) });
      }
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(undefined);
    }
  }
  if (loadError && !skills)
    return (
      <div className="inline-error" role="status">
        <p>{loadError}</p>
        <button
          type="button"
          className="button secondary tiny"
          onClick={() => {
            setLoadError('');
            setRetry((value) => value + 1);
          }}
        >
          重试
        </button>
      </div>
    );
  if (!skills)
    return (
      <div className="dialog-loading">
        <Loader2 className="spinning" size={16} />
        读取 Skills…
      </div>
    );
  const enabledSkills = skills.filter((skill) => skill.enabled && !skill.sync?.removedAt);
  if (!enabledSkills.length)
    return (
      <p className="panel-intro">
        还没有启用的 Skills。
        {onOpenSettings ? (
          <button
            type="button"
            className="button secondary tiny"
            onClick={() => window.dispatchEvent(new CustomEvent('pugport:open-extensions', { detail: 'skills' }))}
          >
            安装 Skills
          </button>
        ) : (
          '安装后即可按需调用。'
        )}
      </p>
    );
  const needle = query.trim().toLocaleLowerCase(language);
  const rows = enabledSkills
    .map((skill) => {
      const metadata = skill.kind === 'skill' ? skill.summaries?.[language] : undefined;
      const summary = metadata?.summary ?? fallbackSkillSummary(skill.description, language);
      const category = metadata?.category ?? 'other';
      return { skill, summary, category };
    })
    .filter(
      ({ skill, summary, category }) =>
        !needle ||
        `${skill.name}\n${summary}\n${translateInterfaceText(skillCategoryLabels[category])}`
          .toLocaleLowerCase(language)
          .includes(needle),
    );
  const groups = skillCategories
    .map((category) => ({ category, rows: rows.filter((row) => row.category === category) }))
    .filter((group) => group.rows.length);
  const allCollapsed = groups.length > 0 && groups.every(({ category }) => collapsed.has(category));
  return (
    <div className="skills-tab">
      <p className="panel-intro">勾选后，这条对话每轮都会检查这个 Skill 是否适用，适用就调用。未勾选的仍可按需调用。</p>
      <div className="skill-search">
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          aria-label="搜索 Skills"
          placeholder="搜索 Skills"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="skill-group-actions">
        <button
          type="button"
          disabled={!groups.length}
          onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(skillCategories))}
        >
          {allCollapsed ? '全部展开' : '全部折叠'}
        </button>
      </div>
      {!groups.length && <p className="panel-note">没有匹配的 Skills。</p>}
      {groups.map(({ category, rows: groupRows }) => (
        <section className="skill-group" key={category}>
          <h3>
            <button
              type="button"
              aria-expanded={!collapsed.has(category)}
              onClick={() =>
                setCollapsed((previous) => {
                  const next = new Set(previous);
                  if (next.has(category)) next.delete(category);
                  else next.add(category);
                  return next;
                })
              }
            >
              <ChevronRight size={13} aria-hidden="true" />
              <span>{skillCategoryLabels[category]}</span>
              <small>{groupRows.length}</small>
            </button>
          </h3>
          {!collapsed.has(category) && (
            <ul className="skill-choices">
              {groupRows.map(({ skill, summary }) => {
                const restricted = !!conversation.skills && !conversation.skills.includes(skill.name);
                return (
                  <li key={skill.id} className={restricted ? 'muted' : ''}>
                    <label title={skill.description} translate="no">
                      <input
                        type="checkbox"
                        disabled={!!saving || (restricted && !chosen.has(skill.name))}
                        checked={chosen.has(skill.name)}
                        onChange={(event) => void toggle(skill.name, event.target.checked)}
                      />
                      <span>{skill.name}</span>
                    </label>
                    {saving === skill.name && <Loader2 className="spinning" size={12} aria-label="正在保存" />}
                    <small title={skill.description} translate="no">
                      {summary}
                    </small>
                    {restricted && <small className="skill-restriction">此对话限制了这个 Skill</small>}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ))}
      <p className="panel-note" role="status">
        {saving ? '正在保存…' : '仅影响这条对话，勾选后自动保存。'}
      </p>
    </div>
  );
}

function MemorySwitch({ conversation, api, notify }: { conversation: Conversation; api: Api; notify: Notify }) {
  const [off, setOff] = useState(conversation.memory === 'off' || !!conversation.incognito);
  const [saving, setSaving] = useState(false);
  useEffect(
    () => setOff(conversation.memory === 'off' || !!conversation.incognito),
    [conversation.memory, conversation.incognito],
  );
  return (
    <section>
      <label className="routing-option">
        <input
          type="checkbox"
          checked={!off}
          disabled={saving || conversation.incognito}
          onChange={async () => {
            setSaving(true);
            try {
              const saved = await api<Conversation>(
                '/api/conversations/' + conversation.id + '/memory',
                { off: !off },
                'PATCH',
              );
              setOff(saved.memory === 'off');
            } catch (error) {
              notify({ tone: 'error', message: errorText(error) });
            } finally {
              setSaving(false);
            }
          }}
        />
        对话记忆
      </label>
      <p className="panel-note">关闭后不读取或写入记忆；重新开启后，整条对话都会重新计入记忆。</p>
    </section>
  );
}
