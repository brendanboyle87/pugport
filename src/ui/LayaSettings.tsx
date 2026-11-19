import { useCallback, useEffect, useRef, useState } from 'react';
import type { LayaSettings as LayaConfiguration, LayaStatus } from '../shared/laya';
import { layaSharesTraining } from '../shared/laya';
import { SettingsGroup, SettingsRow } from './SettingsRow';
import { useUiUpdateBlocker } from './ui-update-guard';
import { saveSettings } from './settings-permissions';
import type { Api, Notice } from './Workspace';

type LayaView = {
  settings: LayaConfiguration;
  status: LayaStatus;
  training: { directory: string; recording: boolean; error?: string };
};
const failureText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function LayaSettings({
  api,
  reload,
  notify,
  section = 'advanced',
}: {
  api: Api;
  reload: () => Promise<void>;
  notify: (notice: Notice) => void;
  section?: 'advanced' | 'sharing';
}) {
  const [view, setView] = useState<LayaView>();
  const [pythonPath, setPythonPath] = useState('');
  const [checkpointPath, setCheckpointPath] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [jevConfigured, setJevConfigured] = useState<boolean>();
  const [deletedCount, setDeletedCount] = useState<number>();
  const pending = useRef(false);
  const mounted = useRef(true);
  const pathsChanged =
    !!view &&
    (pythonPath !== (view.settings.pythonPath ?? '') || checkpointPath !== (view.settings.checkpointPath ?? ''));
  useUiUpdateBlocker(() => pathsChanged || !!apiKey || pending.current, 'laya-settings');
  const readStatus = useCallback(
    async (initial = false) => {
      const value = await api<LayaView>('/api/laya/status', undefined, 'GET');
      if (mounted.current) {
        setView(value);
        if (initial) {
          setPythonPath(value.settings.pythonPath ?? '');
          setCheckpointPath(value.settings.checkpointPath ?? '');
        }
      }
    },
    [api],
  );
  const refresh = useCallback(
    async (initial = false) => {
      setLoading(true);
      setError('');
      try {
        await readStatus(initial);
      } catch (failure) {
        if (mounted.current) setError(`获取 Task Router 状态失败：${failureText(failure)}`);
      } finally {
        if (mounted.current) setLoading(false);
      }
    },
    [readStatus],
  );
  useEffect(() => {
    mounted.current = true;
    void refresh(true);
    return () => {
      mounted.current = false;
    };
  }, [refresh]);
  useEffect(() => {
    if (view?.status.state !== 'starting' || saving) return;
    const timer = setTimeout(() => void refresh(), 2000);
    return () => clearTimeout(timer);
  }, [view, saving, refresh]);
  const mode = view?.settings.mode ?? 'cloud';
  useEffect(() => {
    if (section !== 'advanced' || mode !== 'jev') return;
    let current = true;
    void api<{ configured: boolean }>('/api/jev/status', undefined, 'GET')
      .then((value) => {
        if (current) setJevConfigured(value.configured);
      })
      .catch((failure) => {
        if (current) setError(`获取 Jev 密钥状态失败：${failureText(failure)}`);
      });
    return () => {
      current = false;
    };
  }, [api, mode, section]);

  async function saveJevKey() {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setError('');
    try {
      await api('/api/jev/config', { apiKey: apiKey.trim() }, 'PUT');
      if (mounted.current) {
        setJevConfigured(!!apiKey.trim());
        setApiKey('');
        notify({ tone: 'success', message: 'Jev 密钥已保存。' });
      }
    } catch (failure) {
      if (mounted.current) setError(`Jev 密钥保存失败：${failureText(failure)}`);
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  async function deleteTraining() {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setError('');
    setDeletedCount(undefined);
    try {
      const result = await api<{ deletedCount: number }>('/api/laya/training/delete', {}, 'POST');
      if (mounted.current) setDeletedCount(result.deletedCount);
    } catch (failure) {
      if (mounted.current) setError(`删除贡献数据失败：${failureText(failure)}`);
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  async function save(update: LayaConfiguration) {
    if (pending.current || !view) return;
    pending.current = true;
    setSaving(true);
    setError('');
    let committed = false;
    try {
      if (!(await saveSettings(api, { laya: view.settings }, { laya: update }))) return;
      committed = true;
      if (!mounted.current) return;
      setView((current) =>
        current
          ? {
              ...current,
              settings: { ...current.settings, ...update },
              training: { ...current.training, recording: update.recordTraining ?? current.training.recording },
            }
          : current,
      );
      if (update.pythonPath !== undefined) setPythonPath(update.pythonPath);
      if (update.checkpointPath !== undefined) setCheckpointPath(update.checkpointPath);
      await readStatus();
      await reload();
      if (mounted.current) notify({ tone: 'success', message: 'Task Router 设置已保存。' });
    } catch (failure) {
      const message = committed
        ? `Task Router 设置已保存，但状态刷新失败：${failureText(failure)}`
        : `Task Router 设置保存失败：${failureText(failure)}`;
      if (mounted.current) {
        setError(message);
        notify({ tone: 'error', message });
      }
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  const status = !view
    ? loading
      ? '读取状态…'
      : '状态读取失败'
    : { disabled: '已关闭', starting: '启动中…', ready: '就绪', error: '出错，已回退' }[view.status.state];
  return (
    <SettingsGroup
      title={section === 'sharing' ? undefined : '路由判断'}
      description={
        section === 'advanced' ? '选择如何分析问题，为自动路由提供建议；服务不可用时使用本地规则。' : undefined
      }
      id={section === 'sharing' ? 'settings-laya-sharing' : 'settings-laya'}
    >
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {section === 'sharing' ? (
        <>
          <SettingsRow
            title="帮助改进路由"
            description="发送已清除密钥的提问、近期上下文、附件名称和类型，以及路由与完成结果，保存 2 年；不发送附件内容、项目文件或文件路径。"
            control={
              <label className="switch">
                <input
                  type="checkbox"
                  aria-label="帮助改进路由"
                  checked={
                    !!view &&
                    view.settings.recordTraining !== false &&
                    layaSharesTraining(view.settings, view.status.region)
                  }
                  disabled={!view || saving || mode !== 'cloud'}
                  aria-busy={saving}
                  onChange={(event) =>
                    void save(
                      event.target.checked ? { shareTraining: true, recordTraining: true } : { shareTraining: false },
                    )
                  }
                />
                <span />
              </label>
            }
          />
          <SettingsRow
            title="贡献的数据"
            description={
              mode !== 'cloud'
                ? '仅在使用 PugPort 云端时共享；当前模式不会向 PugPort 上传消息。'
                : view?.status.region === 'eu'
                  ? '欧盟地区默认关闭，只有你开启后才共享数据。'
                  : '关闭后仍会发送消息以获取路由建议，但不会保留用于训练。'
            }
            status={deletedCount === undefined ? undefined : `已删除 ${deletedCount} 条记录。`}
            control={
              <button
                type="button"
                className="button secondary"
                disabled={!view || saving}
                onClick={() => void deleteTraining()}
              >
                删除我贡献的数据
              </button>
            }
          />
        </>
      ) : (
        <SettingsRow
          title="路由判断"
          control={
            <select
              aria-label="路由判断"
              value={mode}
              disabled={!view || saving}
              aria-busy={saving}
              onChange={(event) => void save({ mode: event.target.value as LayaConfiguration['mode'] })}
            >
              <option value="cloud">PugPort 云端（默认）</option>
              <option value="local">本机 Task Router</option>
              <option value="jev">Jev</option>
              <option value="rules">只用本地规则</option>
            </select>
          }
        />
      )}
      {(section === 'advanced' || !view) && (
        <SettingsRow
          title="模型状态"
          status={status}
          tone={view?.status.state === 'ready' ? 'live' : view?.status.state === 'error' ? 'warning' : undefined}
          description={
            view?.status.state === 'error' ? (
              <>
                服务暂不可用；任务会继续使用本地规则。
                {view.status.reason && <div translate="no">{view.status.reason}</div>}
              </>
            ) : undefined
          }
          control={
            <button
              type="button"
              className="button secondary"
              disabled={loading || saving}
              onClick={() => void refresh(!view)}
            >
              刷新状态
            </button>
          }
        />
      )}
      {section === 'advanced' && mode === 'jev' && (
        <SettingsRow
          title="Jev 密钥"
          description="消息会发送给 Jev 的服务。使用你自己的 Jev 密钥；这里只显示是否已配置。"
          defaultExpanded
        >
          <label className="field">
            <span>Jev API 密钥</span>
            <input
              type="password"
              aria-label="Jev API 密钥"
              autoComplete="new-password"
              spellCheck={false}
              value={apiKey}
              disabled={saving}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <small>
              {jevConfigured === undefined
                ? '读取状态…'
                : jevConfigured
                  ? '已配置密钥；留空保存可清除。'
                  : '尚未配置密钥。'}
            </small>
          </label>
          <button
            type="button"
            className="button secondary"
            disabled={saving || (!apiKey.trim() && !jevConfigured)}
            onClick={() => void saveJevKey()}
          >
            保存 Jev 密钥
          </button>
        </SettingsRow>
      )}
      {section === 'advanced' && mode === 'local' && (
        <>
          <p className="quiet-text">本机 Task Router 需要 Python 和模型文件；不会向 PugPort 或 Jev 发送消息。</p>
          <SettingsRow
            title="保存本机路由记录，供后续复审和模型训练"
            description={
              <>
                问题、上下文和路由结果按日期保存在本机，不会自动上传或启动训练。关闭后只停止新增记录，已有记录会保留。
                {view?.training.error && (
                  <div className="inline-error" role="alert" translate="no">
                    {view.training.error}
                  </div>
                )}
              </>
            }
            status={
              view
                ? view.training.error
                  ? '保存失败'
                  : view.training.recording
                    ? '正在记录'
                    : '已停止新增'
                : undefined
            }
            tone={view?.training.error ? 'warning' : undefined}
            control={
              <label className="switch">
                <input
                  type="checkbox"
                  aria-label="保存本机路由记录，供后续复审和模型训练"
                  checked={view?.settings.recordTraining !== false}
                  disabled={!view || saving}
                  aria-busy={saving}
                  onChange={(event) => void save({ recordTraining: event.target.checked })}
                />
                <span />
              </label>
            }
          />
          <SettingsRow
            title="记录目录"
            description={
              <code className="setting-path" style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
                {view?.training.directory ?? '…'}
              </code>
            }
            control={
              <button
                type="button"
                className="button secondary"
                disabled={!view?.training.directory}
                onClick={() =>
                  void api('/api/open-folder', { kind: 'routing-training' }).catch((failure) =>
                    notify({ tone: 'error', message: `打开记录目录失败：${failureText(failure)}` }),
                  )
                }
              >
                打开文件夹
              </button>
            }
          />
          <SettingsRow title="模型路径设置" description="填写本机 Python 可执行文件和模型文件夹；保存后在后台加载。">
            <div className="fields-grid two">
              <label className="field">
                <span>Python 可执行文件</span>
                <input
                  aria-label="Python 可执行文件"
                  value={pythonPath}
                  spellCheck={false}
                  disabled={!view || saving}
                  onChange={(event) => setPythonPath(event.target.value)}
                />
              </label>
              <label className="field">
                <span>Task Router v4 模型文件夹</span>
                <input
                  aria-label="Task Router v4 模型文件夹"
                  value={checkpointPath}
                  spellCheck={false}
                  disabled={!view || saving}
                  onChange={(event) => setCheckpointPath(event.target.value)}
                />
              </label>
            </div>
            <button
              type="button"
              className="button secondary"
              disabled={!view || saving || !pathsChanged}
              onClick={() => void save({ pythonPath: pythonPath.trim(), checkpointPath: checkpointPath.trim() })}
            >
              保存模型配置
            </button>
          </SettingsRow>
        </>
      )}
    </SettingsGroup>
  );
}
