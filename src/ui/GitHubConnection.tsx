import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitHubStatus } from '../server/github';
import type { Api, Notice } from './Workspace';
import { SettingsGroup, SettingsRow } from './SettingsRow';

import type { DevicesView } from '../shared/devices';
import type { GitHubStatus as MaintainerGitHubStatus } from '../server/node/peer-protocol';
import { ChannelAdmissionSettings, githubAdmissionScopes } from './ChannelAdmissionSettings';
import { Loader2 } from 'lucide-react';

type MaintainerStatus = {
  configured: boolean;
  host?: MaintainerGitHubStatus;
  desk: { lastSyncAt?: string; link: 'local' | 'peer' | 'none'; problem?: string };
};

export function maintainerStatusText(status: MaintainerStatus): string {
  const host = status.host;
  if (!host) return status.desk?.problem ?? '尚未选择 GitHub 维护设备';
  return [
    host.mode === 'shadow' ? '影子模式' : host.mode === 'live' ? '正式模式' : '已停止',
    host.lastPollAt
      ? `${Math.max(0, Math.floor((Date.now() - Date.parse(host.lastPollAt)) / 60_000))} 分钟前轮询`
      : '尚未轮询',
    host.ready.app ? 'App 已配置' : 'App 未配置',
    `已判 ${host.score.judged} 个 PR`,
    `误放过 ${host.score.falsePasses}`,
    host.ready.problem,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function GitHubConnection({ api, notify }: { api: Api; notify: (notice: Notice) => void }) {
  const [status, setStatus] = useState<GitHubStatus>({ enabled: false, state: 'off' });
  const [busy, setBusy] = useState(true);
  const [configured, setConfigured] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    let active = true;
    void api<GitHubStatus>('/api/github', undefined, 'GET')
      .then((value) => {
        if (active) {
          setStatus(value);
          if (value.state === 'connected') setConfigured(true);
        }
      })
      .catch(() => {
        if (active) setStatus({ enabled: false, state: 'error' });
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [api]);
  const labels = { 'gh-missing': '未安装 gh', 'not-signed-in': '未登录', error: '连接失败' };
  const state = status.state;
  const login = typeof status.login === 'string' ? status.login.trim() : '';
  const needsLogin = state === 'gh-missing' || state === 'not-signed-in';
  const ready = configured || state === 'connected';
  const toggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      const next = await api<GitHubStatus>('/api/github', { enabled });
      setStatus(next);
      if (next.state === 'connected') setConfigured(true);
      else if (enabled) setExpanded(true);
    } catch (error) {
      notify({ tone: 'error', message: error instanceof Error ? error.message : '连接失败' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsRow
      footer={
        state === 'connected' && status.enabled ? (
          <ChannelAdmissionSettings
            api={api}
            notify={notify}
            source="github"
            endpoint="/api/github/admission"
            scopes={githubAdmissionScopes}
            showDigest={false}
            senderLabels={{ owner: '我', trusted: '协作者', other: '其他人', bot: '机器人' }}
          />
        ) : (
          <p className="slack-note channel-admission" aria-disabled="true">
            连接 GitHub 后可设置谁能让 PugPort 做事
          </p>
        )
      }
      title="GitHub"
      description="读取 GitHub 内容，按任务权限执行写入。"
      itemId="github"
      expanded={expanded}
      onExpandedChange={setExpanded}
      status={
        needsLogin || state === 'error' ? (
          labels[state as keyof typeof labels]
        ) : login ? (
          <span translate="no">{login}</span>
        ) : undefined
      }
      tone={needsLogin ? 'warning' : state === 'error' ? 'danger' : undefined}
      control={
        <>
          {ready && (
            <label className="switch">
              <input
                type="checkbox"
                aria-label="GitHub"
                checked={status.enabled === true}
                disabled={busy}
                onChange={(event) => void toggle(event.target.checked)}
              />
              <span />
            </label>
          )}
          <button
            type="button"
            className="button quiet tiny"
            disabled={busy}
            onClick={() => (ready ? setExpanded((value) => !value) : void toggle(true))}
          >
            {ready ? '管理' : '连接'}
          </button>
        </>
      }
    >
      <>
        <span>
          每个执行器都能读取 GitHub 的 issue、PR、提交、文件和 Actions 日志。写入任务还能创建分支、提交文件、打开 PR
          和评论。合并、写入默认分支和删除等高风险操作会先征求你的确认。
        </span>
        {needsLogin && (
          <div>
            在终端运行 <code translate="no">gh auth login</code> 然后重新开启。
          </div>
        )}
        {!ready && status.enabled && (
          <button type="button" className="button quiet tiny" disabled={busy} onClick={() => void toggle(false)}>
            断开
          </button>
        )}
        {expanded && <GitHubMaintenance api={api} notify={notify} />}
      </>
    </SettingsRow>
  );
}

export function GitHubMaintenance({ api, notify }: { api: Api; notify: (notice: Notice) => void }) {
  const [view, setView] = useState<DevicesView>();
  const [maintainer, setMaintainer] = useState<MaintainerStatus>();
  const [maintainerError, setMaintainerError] = useState('');
  const [devicesError, setDevicesError] = useState('');
  const [busy, setBusy] = useState('');
  const sequence = useRef(0);
  const failure = (error: unknown) => (error instanceof Error ? error.message : '操作没有完成，请重试。');
  const refreshMaintainer = useCallback(async () => {
    const current = sequence.current;
    try {
      const value = await api<MaintainerStatus>('/api/maintainer/status', undefined, 'GET');
      if (current === sequence.current) {
        setMaintainer(value);
        setMaintainerError('');
      }
    } catch (error) {
      if (current === sequence.current) setMaintainerError(failure(error));
    }
  }, [api]);
  const refreshDevices = useCallback(async () => {
    const current = sequence.current;
    try {
      const next = await api<DevicesView>('/api/devices', undefined, 'GET');
      if (current === sequence.current) {
        setView(next);
        setDevicesError('');
      }
    } catch (error) {
      if (current === sequence.current) setDevicesError(failure(error));
    }
  }, [api]);
  useEffect(() => {
    void refreshDevices();
    void refreshMaintainer();
    const timer = setInterval(() => {
      void refreshDevices();
      void refreshMaintainer();
    }, 30_000);
    return () => {
      sequence.current++;
      clearInterval(timer);
    };
  }, [refreshDevices, refreshMaintainer]);
  const run = async (key: string, work: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    try {
      await work();
    } catch (error) {
      notify({ tone: 'error', message: failure(error) });
    } finally {
      setBusy('');
    }
  };
  const chooseGitHub = (deviceId: string | null) =>
    run('github', async () => {
      const next = await api<DevicesView & { note?: string }>('/api/devices/github-host', { deviceId }, 'PUT');
      sequence.current++;
      setView(next);
      setDevicesError('');
      if (next.note) notify({ tone: 'info', message: next.note });
      // Not awaited: a slow status request must never keep the selector (and its Off option) locked.
      void refreshMaintainer();
    });
  const computers = view?.devices?.filter((device) => !device.tunnel) ?? [];
  return (
    <SettingsGroup title="GitHub">
      <SettingsRow
        title="GitHub 维护由哪台运行"
        control={
          <label className="field">
            <select
              aria-label="GitHub 维护由哪台运行"
              value={view ? (view.githubHost ?? '') : 'loading'}
              disabled={!view || !!busy || (!maintainer?.configured && !view.githubHost)}
              onChange={(event) => void chooseGitHub(event.target.value || null)}
            >
              {!view && <option value="loading">正在加载…</option>}
              <option value="">不运行</option>
              <option value="self">这台电脑</option>
              {computers.map((device) => (
                <option key={device.id} value={device.id} translate="no">
                  {device.name}
                </option>
              ))}
            </select>
            {busy === 'github' && <Loader2 size={12} className="spinning" />}
          </label>
        }
        description={
          <>
            {devicesError && (
              <p className="inline-error" role="alert">
                {devicesError}
                <button
                  type="button"
                  className="button secondary tiny"
                  disabled={!!busy}
                  onClick={() => void run('devices', refreshDevices)}
                >
                  重试
                </button>
              </p>
            )}
            {maintainer?.configured === false && <p>先配置 maintainer.json，参见 docs/maintainer-bot.md。</p>}
            <p role="status">
              {maintainerError || (maintainer ? maintainerStatusText(maintainer) : '正在加载…')}
              {maintainer?.host?.judgingPaused && (
                <button
                  type="button"
                  className="button secondary tiny"
                  disabled={!!busy}
                  onClick={() =>
                    void run('resume-judge', async () => {
                      await api('/api/maintainer/judge/resume', {});
                      setMaintainer(await api<MaintainerStatus>('/api/maintainer/status', undefined, 'GET'));
                      setMaintainerError('');
                    })
                  }
                >
                  恢复判官
                </button>
              )}
            </p>
            {!!maintainer?.host?.recent.length && (
              <details>
                <summary>最近活动</summary>
                <ul>
                  {maintainer.host.recent.slice(0, 20).map((item, index) => (
                    <li key={`${item.at}:${index}`} translate="no">
                      {item.at} · {item.event} {item.number ? `#${item.number}` : ''} · {item.action} · {item.result}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        }
      />
    </SettingsGroup>
  );
}
