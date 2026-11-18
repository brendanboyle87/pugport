import { useEffect, useRef, useState } from 'react';
import { defaultHindsightSettings, type HindsightRuntimeStatus, type HindsightSettings } from '../shared/hindsight';
import type { AppState } from '../shared/types';
import type { Api } from './Workspace';
import { SettingsGroup, SettingsRow } from './SettingsRow';

export function HindsightSettingsPanel({
  state,
  settings,
  disabled,
  api,
  onChange,
}: {
  state: AppState;
  settings?: HindsightSettings;
  disabled?: boolean;
  api: Api;
  onChange(value: HindsightSettings): void;
}) {
  const saved = settings ?? defaultHindsightSettings;
  const signature = JSON.stringify(saved);
  const [draft, setDraft] = useState(saved);
  const [status, setStatus] = useState<HindsightRuntimeStatus>();
  const [loading, setLoading] = useState(false);
  const [forgetProjectId, setForgetProjectId] = useState('');
  const [forgetting, setForgetting] = useState(false);
  const [forgetNotice, setForgetNotice] = useState('');
  const forgetPending = useRef(false);
  const sequence = useRef(0);
  const load = async () => {
    const current = ++sequence.current;
    setLoading(true);
    try {
      const value = await api<HindsightRuntimeStatus>('/api/hindsight/status', undefined, 'GET');
      if (current === sequence.current) setStatus(value);
    } catch {
      if (current === sequence.current)
        setStatus({ state: 'unavailable', detail: '无法读取服务状态；继续使用本地记忆。' });
    } finally {
      if (current === sequence.current) setLoading(false);
    }
  };
  useEffect(() => {
    setDraft(saved);
    void load();
    return () => {
      sequence.current++;
    };
  }, [signature, api]);
  const eligible = state.targets.filter(
    (target) =>
      target.gateway === 'api' &&
      target.enabled &&
      !target.executionDisabledByUser &&
      target.apiProvider &&
      Number.isFinite(target.apiBudget?.perRunUsd) &&
      target.apiBudget!.perRunUsd > 0,
  );
  const selected = eligible.find((target) => target.id === draft.runtimeId);
  const budget = state.apiProviders?.find((provider) => provider.targetId === draft.runtimeId)?.budget;
  const projects = state.projects ?? [];
  const unavailableProjects = draft.projectIds.filter((id) => !projects.some((project) => project.id === id));
  const complete = !!(
    draft.pythonExecutable.trim() &&
    selected &&
    draft.projectIds.length &&
    !unavailableProjects.length
  );
  const numbersValid =
    Number.isInteger(draft.dailyModelCalls) &&
    draft.dailyModelCalls >= 1 &&
    draft.dailyModelCalls <= 100 &&
    Number.isInteger(draft.recallTimeoutMs) &&
    draft.recallTimeoutMs >= 200 &&
    draft.recallTimeoutMs <= 3000;
  const changed = JSON.stringify(draft) !== signature;
  const statusLabel = !saved.enabled
    ? '默认关闭'
    : loading
      ? '读取状态中…'
      : status?.state === 'ready'
        ? '已就绪'
        : status?.state === 'starting'
          ? '正在启动…'
          : '暂不可用';
  const save = () => onChange({ ...draft, pythonExecutable: draft.pythonExecutable.trim() });
  const forget = async () => {
    if (forgetPending.current || !projects.some((project) => project.id === forgetProjectId)) return;
    forgetPending.current = true;
    setForgetting(true);
    setForgetNotice('');
    try {
      const result = await api<{ revoked: boolean; serviceDeleted: boolean }>(
        '/api/hindsight/forget',
        { projectId: forgetProjectId },
        'POST',
      );
      if (result.revoked !== true) throw new Error('unconfirmed');
      setForgetNotice(
        result.serviceDeleted === true
          ? '已撤销本地引用，并已删除此项目的 Hindsight 副本。原始对话保留。'
          : '已撤销本地引用；服务中的副本是否删除尚未确认，旧副本不会再被使用。原始对话保留。',
      );
    } catch {
      setForgetNotice('无法确认清除结果。可再次清除此项目的 Hindsight 副本；原始对话不会删除。');
    } finally {
      forgetPending.current = false;
      setForgetting(false);
    }
  };
  return (
    <SettingsGroup id="settings-hindsight" title="可选记忆服务">
      <SettingsRow
        title="Hindsight 项目记忆（试用）"
        description="为选定项目保存和检索记忆。不可用或超时后继续使用本地记忆。"
        status={statusLabel}
        tone={saved.enabled ? (status?.state === 'ready' ? 'live' : 'warning') : undefined}
        control={
          <label className="switch">
            <input
              type="checkbox"
              aria-label="启用 Hindsight 项目记忆"
              checked={saved.enabled}
              disabled={disabled || (!saved.enabled && (!complete || changed || !numbersValid))}
              onChange={(event) => onChange({ ...saved, enabled: event.target.checked })}
            />
            <span />
          </label>
        }
      >
        <p className="quiet-text">
          记忆内容会发送给所选 API，使用该账号的预算和到期限制；每日模型调用另设上限。服务故障不会阻止对话。
        </p>
        <p className="quiet-text">试用不批量导入历史，也不自动下载外部模型。</p>
        <fieldset className="settings-fields" disabled={disabled}>
          <label className="field">
            <span>Python 可执行文件</span>
            <input
              aria-label="Hindsight Python 可执行文件"
              value={draft.pythonExecutable}
              placeholder="C:/tools/hindsight/.venv/Scripts/python.exe"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setDraft({ ...draft, pythonExecutable: event.target.value })}
            />
            <small>需要安装 Hindsight 1.1.0 的独立 Python 环境。这里只保存程序路径，不保存 API 密钥。</small>
          </label>
          <label className="field">
            <span>记忆使用的 API 账号</span>
            <select
              aria-label="Hindsight API 账号"
              value={draft.runtimeId}
              onChange={(event) => setDraft({ ...draft, runtimeId: event.target.value })}
            >
              <option value="">选择已配置预算的 API 账号</option>
              {draft.runtimeId && !selected && <option value={draft.runtimeId}>已保存账号不可用</option>}
              {eligible.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.label}
                </option>
              ))}
            </select>
            {!eligible.length && <small>先在执行器中添加 API 账号并设置预算。</small>}
          </label>
          {selected && (
            <p className="quiet-text" role="status">
              {budget?.phase === 'expired'
                ? '所选 API 已过期，记忆服务暂停。'
                : budget?.phase === 'exhausted'
                  ? '所选 API 预算已用完，记忆服务暂停。'
                  : budget?.remainingUsd !== undefined
                    ? `本地预算估算剩余 USD ${budget.remainingUsd.toFixed(2)}`
                    : budget
                      ? '按每次预留预算执行；未设置总预算。'
                      : 'API 预算状态尚未读取；每次调用仍会检查预算。'}
              {selected.apiBudget?.expiresAt && (
                <>
                  <br />
                  <small>到期：{selected.apiBudget.expiresAt}</small>
                </>
              )}
            </p>
          )}
          <fieldset className="settings-fields">
            <legend>使用 Hindsight 的项目</legend>
            {!projects.length && <p className="quiet-text">创建项目后可在这里选择。</p>}
            {projects.map((project) => (
              <label key={project.id} className="setting-row">
                <span className="setting-label">{project.name}</span>
                <input
                  type="checkbox"
                  aria-label={project.name}
                  checked={draft.projectIds.includes(project.id)}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      projectIds: event.target.checked
                        ? [...draft.projectIds, project.id]
                        : draft.projectIds.filter((id) => id !== project.id),
                    })
                  }
                />
              </label>
            ))}
            {!!unavailableProjects.length && (
              <p className="quiet-text">
                部分已选项目不可用。
                <button
                  type="button"
                  className="button tiny quiet"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      projectIds: draft.projectIds.filter((id) => !unavailableProjects.includes(id)),
                    })
                  }
                >
                  清除不可用项目
                </button>
              </p>
            )}
          </fieldset>
          <div className="fields-grid">
            <label className="field">
              <span>每日模型调用上限</span>
              <input
                type="number"
                aria-label="Hindsight 每日模型调用上限"
                min={1}
                max={100}
                step={1}
                value={draft.dailyModelCalls}
                onChange={(event) => setDraft({ ...draft, dailyModelCalls: Number(event.target.value) })}
              />
            </label>
            <label className="field">
              <span>检索等待上限（毫秒）</span>
              <input
                type="number"
                aria-label="Hindsight 检索等待上限"
                min={200}
                max={3000}
                step={100}
                value={draft.recallTimeoutMs}
                onChange={(event) => setDraft({ ...draft, recallTimeoutMs: Number(event.target.value) })}
              />
            </label>
          </div>
          {!numbersValid && <p role="alert">每日调用须为 1–100 的整数，检索等待须为 200–3000 毫秒的整数。</p>}
          <button
            type="button"
            className="button secondary tiny"
            disabled={!changed || !numbersValid || (draft.enabled && !complete)}
            onClick={save}
          >
            保存配置
          </button>
        </fieldset>
        <fieldset className="settings-fields" disabled={disabled || forgetting}>
          <label className="field">
            <span>清除项目的 Hindsight 副本</span>
            <select
              aria-label="要清除 Hindsight 副本的项目"
              value={forgetProjectId}
              onChange={(event) => {
                setForgetProjectId(event.target.value);
                setForgetNotice('');
              }}
            >
              <option value="">选择要清除的项目</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <small>先撤销已有记忆的本地引用，再尝试删除服务副本；不会删除原始对话。停用项目可阻止后续记忆写入。</small>
          </label>
          <button
            type="button"
            className="button quiet tiny"
            disabled={!projects.some((project) => project.id === forgetProjectId)}
            onClick={() => void forget()}
          >
            清除此项目的 Hindsight 副本
          </button>
        </fieldset>
        {forgetNotice && <p role="status">{forgetNotice}</p>}
        {status?.detail && (
          <p className="quiet-text" role="status">
            {status.detail}
          </p>
        )}
        <button type="button" className="button quiet tiny" disabled={loading} onClick={() => void load()}>
          刷新服务状态
        </button>
      </SettingsRow>
    </SettingsGroup>
  );
}
