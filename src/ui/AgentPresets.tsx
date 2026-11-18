import { useEffect, useId, useRef, useState } from 'react';
import { activeProviders } from '../shared/provider-registry';
import { builtinAgentPresets, type AgentPreset, type AgentPresetDraft } from '../shared/agent-presets';
import type { Provider } from '../shared/types';
import type { Api, Notice } from './Workspace';

const providers: Provider[] = activeProviders;
const emptyDraft = (): AgentPresetDraft => ({
  name: '',
  description: '',
  instructions: '',
  mode: 'auto',
  permissionMode: 'workspace-write',
});
const builtin = (id: string) => builtinAgentPresets.some((preset) => preset.id === id);

/** Keep the editable payload independent of timestamps and built-in identifiers. */
export function agentPresetPayload(draft: AgentPresetDraft, skillsText: string): AgentPresetDraft {
  const name = draft.name.trim(),
    description = draft.description.trim(),
    instructions = draft.instructions.trim();
  if (!name || name.length > 60) throw new Error('角色名称需要 1–60 个字符。');
  if (description.length > 3000) throw new Error('角色描述最多 3000 个字符。');
  if (instructions.length > 8000) throw new Error('角色指令最多 8000 个字符。');
  const skills = [
    ...new Set(
      skillsText
        .split(/[,，\n]/)
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ];
  return {
    name,
    description,
    instructions,
    mode: draft.mode,
    permissionMode: draft.permissionMode,
    ...(draft.preferredProvider ? { preferredProvider: draft.preferredProvider } : {}),
    ...(draft.preferredModel?.trim() ? { preferredModel: draft.preferredModel.trim() } : {}),
    ...(draft.preferredEffort?.trim() ? { preferredEffort: draft.preferredEffort.trim() } : {}),
    ...(skills.length ? { skills } : {}),
  };
}

export async function saveAgentPreset(api: Api, preset: AgentPresetDraft, id?: string): Promise<AgentPreset> {
  if (id && builtin(id)) throw new Error('内置角色只能复制为自定义角色。');
  const result = await api<{ preset: AgentPreset }>(
    id ? `/api/agent-presets/${encodeURIComponent(id)}` : '/api/agent-presets',
    preset,
    id ? 'PUT' : 'POST',
  );
  return result.preset;
}

export function AgentPresetDialog({
  presets,
  api,
  notify,
  onClose,
  onSaved,
}: {
  presets: readonly AgentPreset[];
  api: Api;
  notify: (notice: Notice) => void;
  onClose: () => void;
  onSaved?: (preset?: AgentPreset) => void;
}) {
  const [items, setItems] = useState([...presets]);
  const [selected, setSelected] = useState<string>();
  const [draft, setDraft] = useState<AgentPresetDraft>(emptyDraft);
  const [skills, setSkills] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState<'draft' | 'save' | 'delete'>();
  const [error, setError] = useState('');
  const [deletePending, setDeletePending] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  const alive = useRef(true);
  const busyRef = useRef(false);
  const titleId = useId();
  const readonly = !!selected && builtin(selected);
  const customCount = items.filter((preset) => !builtin(preset.id)).length;
  const close = () => {
    alive.current = false;
    request.current++;
    onClose();
  };
  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => {
      alive.current = false;
      request.current++;
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    // Parent settings refresh can add roles without overwriting unsaved editor text.
    setItems([...presets]);
  }, [presets]);
  const choose = (preset?: AgentPreset) => {
    request.current++;
    setSelected(preset?.id);
    setDraft(preset ? { ...preset } : emptyDraft());
    setSkills(preset?.skills?.join('\n') ?? '');
    setError('');
    setDeletePending(false);
  };
  const operation = async (kind: 'draft' | 'save' | 'delete', action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(kind);
    setError('');
    try {
      await action();
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : '操作失败，请重试。');
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(undefined);
    }
  };
  const generate = () =>
    operation('draft', async () => {
      if (!description.trim()) throw new Error('请先描述你希望角色怎样工作。');
      const token = ++request.current;
      const result = await api<{ draft: AgentPresetDraft }>(
        '/api/agent-presets/draft',
        { description: description.trim() },
        'POST',
      );
      if (!alive.current || request.current !== token) return;
      setSelected(undefined);
      setDraft(result.draft);
      setSkills(result.draft.skills?.join('\n') ?? '');
      setDeletePending(false);
    });
  const save = () =>
    operation('save', async () => {
      if (readonly) throw new Error('先复制内置角色，再保存你的修改。');
      if (!selected && customCount >= 50) throw new Error('自定义角色已达 50 个，请先删除不需要的角色。');
      const payload = agentPresetPayload(draft, skills);
      const token = ++request.current;
      const saved = await saveAgentPreset(api, payload, selected);
      if (!alive.current || token !== request.current) return;
      setItems((current) => [...current.filter((item) => item.id !== saved.id), saved]);
      setSelected(saved.id);
      setDraft(saved);
      setSkills(saved.skills?.join('\n') ?? '');
      notify({ tone: 'success', message: '角色“{0}”已保存，将用于新任务。', names: [saved.name] });
      onSaved?.(saved);
    });
  const remove = () =>
    operation('delete', async () => {
      if (!selected || readonly) return;
      const token = ++request.current,
        id = selected;
      await api(`/api/agent-presets/${encodeURIComponent(id)}`, undefined, 'DELETE');
      if (!alive.current || token !== request.current) return;
      setItems((current) => current.filter((item) => item.id !== id));
      choose();
      notify({ tone: 'success', message: '自定义角色已删除。' });
      onSaved?.();
    });
  return (
    <div className="modal-backdrop agent-presets-backdrop">
      <div
        ref={dialog}
        className="modal agent-presets-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            close();
          }
          if (event.key === 'Tab') {
            const elements = [
              ...event.currentTarget.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
              ),
            ].filter((element) => element.offsetParent !== null);
            const first = elements[0],
              last = elements.at(-1);
            if (!first) {
              event.preventDefault();
              return;
            }
            if (
              event.shiftKey &&
              (document.activeElement === first || document.activeElement === event.currentTarget)
            ) {
              event.preventDefault();
              last?.focus();
            } else if (
              !event.shiftKey &&
              (document.activeElement === last || document.activeElement === event.currentTarget)
            ) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <div className="modal-heading">
          <h2 id={titleId}>任务角色</h2>
          <button type="button" className="agent-preset-manage" onClick={close} aria-label="关闭角色管理">
            关闭
          </button>
        </div>
        <p>角色只用于新任务。角色指令、模型和技能是工作偏好；权限仍受任务设置和审批限制。当前运行不会改变。</p>
        <div className="agent-presets-layout">
          <nav className="agent-presets-list" aria-label="已有任务角色">
            <button
              type="button"
              disabled={!!busy || customCount >= 50}
              aria-pressed={!selected}
              onClick={() => choose()}
            >
              ＋ 新建角色
            </button>
            {items.map((preset) => (
              <button
                type="button"
                disabled={!!busy}
                key={preset.id}
                aria-pressed={selected === preset.id}
                onClick={() => choose(preset)}
              >
                <strong>{preset.name}</strong>
                <small>{builtin(preset.id) ? '内置 · 可复制' : '自定义'}</small>
                <span>{preset.description}</span>
              </button>
            ))}
            <small>{customCount}/50 个自定义角色</small>
          </nav>
          <div className="agent-presets-editor">
            <section className="agent-presets-generate" aria-label="用自然语言创建角色">
              <label>
                用一句话描述角色
                <textarea
                  value={description}
                  maxLength={3000}
                  disabled={!!busy}
                  placeholder="例如：先检查代码和测试，解释问题，再给出最小修改建议。"
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
              <button
                type="button"
                disabled={!!busy || !description.trim() || customCount >= 50}
                onClick={() => void generate()}
              >
                {busy === 'draft' ? '正在生成…' : '生成本地草稿'}
              </button>
              <small>在本地整理描述，不调用模型。草稿可编辑，点击保存后才成为角色。</small>
            </section>
            {readonly ? (
              <div className="agent-presets-readonly">
                <span>内置角色 · 只读</span>
                <button
                  type="button"
                  disabled={!!busy || customCount >= 50}
                  onClick={() => {
                    setSelected(undefined);
                    setDraft((current) => ({ ...current, name: `${current.name} 副本`.slice(0, 60) }));
                    setDeletePending(false);
                  }}
                >
                  复制为自定义角色
                </button>
              </div>
            ) : null}
            <fieldset disabled={readonly || !!busy}>
              <legend>{selected ? '角色设置' : '新角色预览'}</legend>
              <label>
                名称
                <input
                  value={draft.name}
                  maxLength={60}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </label>
              <label>
                描述
                <textarea
                  value={draft.description}
                  maxLength={3000}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                />
              </label>
              <label>
                角色指令
                <textarea
                  className="agent-presets-instructions"
                  value={draft.instructions}
                  maxLength={8000}
                  onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
                />
              </label>
              <div className="agent-presets-fields">
                <label>
                  工作模式
                  <select
                    value={draft.mode}
                    onChange={(event) => setDraft({ ...draft, mode: event.target.value as AgentPreset['mode'] })}
                  >
                    <option value="auto">自动</option>
                    <option value="chat">讨论</option>
                    <option value="build">执行</option>
                  </select>
                </label>
                <label>
                  权限偏好
                  <select
                    value={draft.permissionMode}
                    onChange={(event) =>
                      setDraft({ ...draft, permissionMode: event.target.value as AgentPreset['permissionMode'] })
                    }
                  >
                    <option value="read-only">只读</option>
                    <option value="workspace-write">工作区写入上限</option>
                  </select>
                </label>
                <label>
                  模型提供方
                  <select
                    value={draft.preferredProvider ?? ''}
                    onChange={(event) =>
                      setDraft({ ...draft, preferredProvider: (event.target.value as Provider) || undefined })
                    }
                  >
                    <option value="">自动</option>
                    {providers.map((provider) => (
                      <option key={provider} value={provider}>
                        {provider}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  模型偏好
                  <input
                    value={draft.preferredModel ?? ''}
                    maxLength={120}
                    placeholder="自动"
                    onChange={(event) => setDraft({ ...draft, preferredModel: event.target.value })}
                  />
                </label>
                <label>
                  推理力度偏好
                  <select
                    value={draft.preferredEffort ?? ''}
                    onChange={(event) => setDraft({ ...draft, preferredEffort: event.target.value || undefined })}
                  >
                    <option value="">自动</option>
                    {['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((effort) => (
                      <option key={effort} value={effort}>
                        {effort}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <small>手动选择的模型优先。留空使用自动选择。</small>
              <label>
                技能名称（逗号或换行分隔）
                <textarea
                  value={skills}
                  maxLength={3000}
                  placeholder="留空使用任务默认技能"
                  onChange={(event) => setSkills(event.target.value)}
                />
              </label>
              <small>只使用已安装且可用的技能；填写名称不会安装技能。</small>
            </fieldset>
            {error ? (
              <p className="agent-presets-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="agent-presets-actions">
              {selected && !readonly ? (
                <button type="button" disabled={!!busy} onClick={() => setDeletePending(!deletePending)}>
                  删除角色
                </button>
              ) : null}
              {deletePending ? (
                <>
                  <span>删除此自定义角色？</span>
                  <button type="button" disabled={!!busy} onClick={() => void remove()}>
                    确认删除
                  </button>
                </>
              ) : null}
              <button
                type="button"
                className="primary"
                disabled={readonly || !!busy || !draft.name.trim() || (!selected && customCount >= 50)}
                onClick={() => void save()}
              >
                {busy === 'save' ? '正在保存…' : selected ? '保存角色' : '创建角色'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
