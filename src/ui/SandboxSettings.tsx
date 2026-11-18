import { currentLocale } from './i18n';
import { useState } from 'react';
import { desktopBridge } from './desktop';
import { Shield } from 'lucide-react';
import type { Settings } from '../shared/types.ts';
import {
  learningProviders,
  type LearningResult,
  type LearningProvider,
  type SandboxStatus,
  type SandboxMode,
} from '../shared/sandbox.ts';
import type { Api } from './Workspace';
import {
  captureDenialsStreamingSupported,
  captureDenialsStreamingUnavailableReason,
} from '../shared/sandbox-capabilities.ts';

const labels = { codex: 'Codex', claude: 'Claude', grok: 'Grok', cursor: 'Cursor', gemini: 'Gemini', pi: 'Pi' };

export function SandboxSettings({
  status,
  settings,
  change,
  api,
  reload,
  notify,
}: {
  status?: SandboxStatus;
  settings: Settings;
  change: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  api: Api;
  reload: () => Promise<void>;
  notify: (notice: { tone: 'error'; message: string }) => void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [results, setResults] = useState<LearningResult[] | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const learningAvailable = status?.available && captureDenialsStreamingSupported(status.sdkVersion);
  async function loadResults() {
    setBusy(true);
    try {
      setResults(await api<LearningResult[]>('/api/sandbox/learning'));
      setSelected({});
      setNotice('');
    } catch {
      notify({ tone: 'error', message: '无法读取学习记录，请重试。' });
    } finally {
      setBusy(false);
    }
  }
  async function adopt(provider: LearningProvider) {
    setBusy(true);
    try {
      const ids =
        results
          ?.find((r) => r.provider === provider)
          ?.entries.filter((e) => selected[`${provider}:${e.id}`])
          .map((e) => e.id) ?? [];
      const change = desktopBridge()?.changePermission;
      if (change) {
        if (!(await change({ kind: 'sandbox-adopt', provider, ids }))) return;
      } else await api('/api/sandbox/learning', { provider, ids });
      setNotice('已采用所选访问；强制模式开放后可用于策略。');
    } catch (error) {
      notify({ tone: 'error', message: error instanceof Error ? error.message : '采用失败，请刷新记录后重试。' });
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    setRefreshing(true);
    try {
      await api('/api/sandbox/refresh', {});
      await reload();
    } catch {
      notify({ tone: 'error', message: '沙箱检测失败，请重试。' });
    } finally {
      setRefreshing(false);
    }
  }
  if (!status?.available) {
    return (
      <section id="settings-sandbox" className="panel settings-section">
        <details className="routing-options">
          <summary>
            <span role="status">沙箱：{status?.message ?? '正在检测'}</span>
          </summary>
          {status?.diagnostic && <p className="quiet-text">{status.diagnostic}</p>}
          <button type="button" className="button secondary" disabled={refreshing} onClick={() => void refresh()}>
            {refreshing ? '正在检测沙箱' : '重新检测'}
          </button>
        </details>
      </section>
    );
  }
  const learningMode = learningProviders.every((provider) => settings.sandbox?.[provider] === 'learn')
    ? 'learn'
    : learningProviders.every((provider) => !settings.sandbox?.[provider] || settings.sandbox[provider] === 'off')
      ? 'off'
      : 'custom';
  return (
    <section id="settings-sandbox" className="panel settings-section">
      <div className="section-title">
        <Shield size={18} />
        <div>
          <h2>沙箱</h2>
          <p role="status">
            {status?.message ?? '正在检测沙箱'}
            {status?.diagnostic && `（${status.diagnostic}）`}
          </p>
        </div>
      </div>
      <p id="sandbox-hint" className="quiet-text">
        {learningAvailable
          ? '学习模式只记录访问，不拦截，网络保持开放。'
          : (status.learningUnavailableReason ?? captureDenialsStreamingUnavailableReason(status.sdkVersion))}
      </p>
      {status?.build && (
        <p className="quiet-text">
          系统版本：{status.build} · 需要版本：{status.requiredBuild ?? '—'} · 组件版本：{status.sdkVersion ?? '—'}
        </p>
      )}
      <label className="setting-row">
        <span className="setting-label">学习模式</span>
        <select
          aria-label="学习模式"
          aria-describedby="sandbox-hint"
          disabled={!learningAvailable || refreshing}
          value={learningMode}
          onChange={(event) => {
            const mode = event.target.value as 'off' | 'learn';
            const sandbox = { ...settings.sandbox };
            for (const provider of learningProviders) sandbox[provider] = mode;
            change('sandbox', sandbox);
          }}
        >
          {learningMode === 'custom' && (
            <option value="custom" disabled>
              按执行器设置
            </option>
          )}
          <option value="off">不启用</option>
          <option value="learn">学习模式</option>
        </select>
      </label>
      <details className="routing-options">
        <summary>按执行器设置</summary>
        <div className="fields-grid two">
          {learningProviders.map((provider) => (
            <label className="field" key={provider}>
              <span>{labels[provider]}</span>
              <select
                aria-label={labels[provider]}
                aria-describedby={
                  status?.learningFailures?.[provider] ? `sandbox-hint sandbox-failure-${provider}` : 'sandbox-hint'
                }
                disabled={!learningAvailable || refreshing}
                value={settings.sandbox?.[provider] === 'learn' ? 'learn' : 'off'}
                onChange={(event) =>
                  change('sandbox', { ...settings.sandbox, [provider]: event.target.value as SandboxMode })
                }
              >
                <option value="off">不启用</option>
                <option value="learn">学习模式</option>
              </select>
              {status?.learningFailures?.[provider] && (
                <span id={`sandbox-failure-${provider}`} role="status" className="quiet-text">
                  沙箱学习暂不可用：{status.learningFailures[provider].reason}
                  {status.learningFailures[provider].code && `（${status.learningFailures[provider].code}）`}
                  {status.learningFailures[provider].autoDisabled &&
                    '；连续 3 次启动失败，已自动关闭。可重新启用学习模式。'}
                </span>
              )}
            </label>
          ))}
        </div>
      </details>
      <button type="button" className="button" disabled={refreshing} onClick={() => void refresh()}>
        {refreshing ? '正在检测沙箱' : '重新检测'}
      </button>
      <details
        className="routing-options"
        onToggle={(event) => {
          if (event.currentTarget.open && results === null && !busy) void loadResults();
        }}
      >
        <summary>查看学习记录</summary>
        <button type="button" className="button secondary" disabled={busy} onClick={() => void loadResults()}>
          刷新记录
        </button>
        {notice && <p role="status">{notice}</p>}
        {results?.length === 0 && <p className="quiet-text">暂无学习记录。启用学习后完成一次任务即可查看。</p>}
        {results?.map((result) => (
          <div className="sandbox-learning" key={result.provider}>
            <div className="section-title">
              <h3>{labels[result.provider]}</h3>
              <span className="quiet-text">{new Date(result.observedAt).toLocaleString(currentLocale())}</span>
            </div>
            <p className="quiet-text">文件按顶层目录汇总；网络按地址和端口列出。仅采用你认可的访问。</p>
            {result.truncated && <p role="status">记录已达到上限，仅显示前一万项。</p>}
            {result.groups.map((group) => (
              <details key={`${group.entries[0]?.resourceType}:${group.label}`}>
                <summary>
                  {group.label}{' '}
                  {group.entries[0]?.resourceType === 'file' && (
                    <span className="quiet-text">
                      （读 {group.read} · 写 {group.write} · 执行 {group.execute}）
                    </span>
                  )}
                </summary>
                {group.entries.map((entry) => (
                  <label className="check-row" key={entry.id}>
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={!!selected[`${result.provider}:${entry.id}`]}
                      onChange={(event) =>
                        setSelected({ ...selected, [`${result.provider}:${entry.id}`]: event.target.checked })
                      }
                    />
                    <span>{entry.resource}</span>
                    <span className="quiet-text">
                      {entry.resourceType === 'network'
                        ? '网络访问'
                        : /write|append|delete|create/i.test(entry.accessType)
                          ? '写入'
                          : /execute/i.test(entry.accessType)
                            ? '执行'
                            : /read|list|enumerate/i.test(entry.accessType)
                              ? '读取'
                              : '其他访问'}
                    </span>
                  </label>
                ))}
              </details>
            ))}
            <button
              type="button"
              className="button"
              disabled={busy || !result.entries.some((e) => selected[`${result.provider}:${e.id}`])}
              onClick={() => void adopt(result.provider)}
            >
              采用
            </button>
          </div>
        ))}
      </details>
    </section>
  );
}
