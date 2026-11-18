import { useEffect, useRef, useState } from 'react';
import type { AppState } from '../shared/types';
import type { RoutingProfile } from '../shared/routing-profiles';
import { routingRuleDraft } from '../shared/routing-profiles';
import { routingCardsOf } from './ConversationPanel';
import { confirmDialog } from './confirm-dialog';
import { RoutingRulesEditor, type RulesDraft } from './RoutingRulesEditor';
import type { Api, Notice } from './Workspace';
import { useUiUpdateBlocker } from './ui-update-guard';

type ProfileDraft = { id: string; name: string; rules?: RulesDraft };
const failureText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function RoutingProfilesSettings({
  state,
  api,
  reload,
  notify,
}: {
  state: AppState;
  api: Api;
  reload: () => Promise<void>;
  notify: (notice: Notice) => void;
}) {
  const [profiles, setProfiles] = useState(state.settings.routingProfiles ?? []);
  const [draft, setDraft] = useState<ProfileDraft>();
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useUiUpdateBlocker(() => draft !== undefined || saving || pending.current, 'routing-profile');
  useEffect(() => setProfiles(state.settings.routingProfiles ?? []), [state.settings.routingProfiles]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const cards = routingCardsOf(state);
  const startEdit = (profile: RoutingProfile) => {
    const { updatedAt: _at, ...rules } = profile.rules;
    setDraft({ id: profile.id, name: profile.name, rules });
  };
  async function mutate(profile: ProfileDraft, rules?: RulesDraft) {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    let committed = false;
    try {
      if (
        !rules &&
        !(await confirmDialog({
          title: '删除这个路由方案？',
          summary: '使用此方案的项目需先更改默认路由，对话需先切回自动路由。原有自动路由设置和聊天内容会保留。',
          action: '删除方案',
          tone: 'danger',
        }))
      )
        return;
      if (!mounted.current) return;
      const value = await api<{ profiles: RoutingProfile[] }>(
        `/api/routing-profiles/${encodeURIComponent(profile.id)}`,
        rules
          ? { name: profile.name.trim(), rules: { ...routingRuleDraft(rules), updatedAt: new Date().toISOString() } }
          : undefined,
        rules ? 'PUT' : 'DELETE',
      );
      committed = true;
      if (!mounted.current) return;
      setProfiles(value.profiles);
      setDraft((current) => (current?.id === profile.id ? undefined : current));
      await reload();
      if (mounted.current)
        notify({ tone: 'success', message: rules ? '路由方案已保存，可在聊天底部选择。' : '路由方案已删除。' });
    } catch (error) {
      if (mounted.current)
        notify({
          tone: 'error',
          message: committed
            ? rules
              ? `路由方案已保存，但列表刷新失败：${failureText(error)}`
              : `路由方案已删除，但列表刷新失败：${failureText(error)}`
            : failureText(error),
        });
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  return (
    <section
      className={profiles.length || draft ? 'panel settings-section' : 'routing-profiles-settings'}
      aria-label="自定义路由方案"
    >
      <div className="section-title" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 200, flex: 1 }}>
          <h2>自定义路由方案</h2>
          {(profiles.length > 0 || draft) && <p>选好开始、执行和核验方式，再保存方案。</p>}
        </div>
        <button
          type="button"
          className="button secondary"
          disabled={saving || !!draft}
          onClick={() => setDraft({ id: crypto.randomUUID(), name: '' })}
        >
          新建路由方案
        </button>
      </div>
      {!profiles.length && !draft && <p className="quiet-text">还没有自定义方案，当前使用自动路由。</p>}
      {profiles.map((profile) => (
        <div className="setting-row" style={{ gridTemplateColumns: 'minmax(0, 1fr) auto' }} key={profile.id}>
          <span className="setting-label">
            {profile.name}
            <small
              style={{ display: 'block', margin: '4px 0 0' }}
            >{`${profile.rules.rules.filter((rule) => rule.enabled).length} 条启用规则`}</small>
          </span>
          <div className="setting-control">
            <button
              type="button"
              className="button quiet"
              disabled={saving || !!draft}
              onClick={() => startEdit(profile)}
            >
              编辑
            </button>
            <button
              type="button"
              className="button quiet"
              disabled={saving}
              aria-label={`删除路由方案 ${profile.name}`}
              onClick={() => void mutate(profile)}
            >
              删除
            </button>
          </div>
        </div>
      ))}
      {draft && (
        <div className="routing-tab" aria-label="编辑路由方案">
          <label className="field">
            <span>方案名称</span>
            <input
              aria-label="路由方案名称"
              value={draft.name}
              maxLength={60}
              disabled={saving}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="例如：日常快答、代码审查"
            />
          </label>
          <fieldset className="settings-fields" disabled={saving}>
            <RoutingRulesEditor
              key={draft.id}
              value={draft.rules}
              cards={cards}
              api={api}
              saving={saving}
              canSave={!!draft.name.trim()}
              saved={profiles.some((profile) => profile.id === draft.id)}
              onChange={(rules) => setDraft((current) => (current?.id === draft.id ? { ...current, rules } : current))}
              onSave={(rules) => void mutate(draft, rules)}
              onError={(message) => notify({ tone: 'error', message })}
            />
          </fieldset>
          <button type="button" className="button quiet" disabled={saving} onClick={() => setDraft(undefined)}>
            取消编辑
          </button>
        </div>
      )}
    </section>
  );
}
