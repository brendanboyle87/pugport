import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, Loader2, X } from 'lucide-react';
import { slackAppManifest, type SlackGatewayView, type SlackPairingCode } from '../shared/slack-gateway';
import type { DevicesView } from '../shared/devices';
import type { Api, Notice } from './Workspace';
import { confirmDialog } from './confirm-dialog';
import { SettingsRow } from './SettingsRow';
import { ChannelAdmissionSettings, slackAdmissionScopes } from './ChannelAdmissionSettings';
import { SideSheet } from './SideSheet';
import { currentLocale, translateInterfaceText, withNames } from './i18n';

type Notify = (notice: Notice) => void;
const failure = (error: unknown) => (error instanceof Error ? error.message : 'Slack 设置没有保存，请重试。');

/** Already in the interface language, with the device and workspace names as written: show it with translate="no". */
export function slackStatusText(view: SlackGatewayView): string {
  if (view.hostedBy) return withNames('由「{0}」运行，这台电脑不连接 Slack。可在下面更改。', [view.hostedBy]);
  if (!view.enabled) return translateInterfaceText('未连接');
  if (view.status === 'connected')
    return view.workspace ? withNames('已连接（{0}）', [view.workspace]) : translateInterfaceText('已连接');
  if (view.status === 'error') return translateInterfaceText(`出错：${view.error ?? '未知原因'}`);
  return translateInterfaceText('连接中…');
}

/** Slack setup in 扩展 → 连接与服务: app manifest, two tokens, on/off, pairing and the paired people. */
export function SlackGateway({ api, notify }: { api: Api; notify: Notify }) {
  const [view, setView] = useState<SlackGatewayView>();
  const [loadError, setLoadError] = useState('');
  const [appToken, setAppToken] = useState('');
  const [botToken, setBotToken] = useState('');
  const [assistant, setAssistant] = useState(false);
  const [pairing, setPairing] = useState<SlackPairingCode>();
  const [busy, setBusy] = useState('');
  const [editingStep, setEditingStep] = useState<number>();
  const [showSteps, setShowSteps] = useState(false);
  const [open, setOpen] = useState(false);
  const [devicesView, setDevicesView] = useState<DevicesView>();
  const guideId = useId();
  const sequence = useRef(0);
  const opener = useRef<HTMLButtonElement>(null);
  const load = useCallback(async () => {
    const current = ++sequence.current;
    try {
      const next = await api<SlackGatewayView>('/api/slack', undefined, 'GET');
      if (current !== sequence.current) return;
      setView(next);
      setLoadError('');
    } catch (reason) {
      if (current === sequence.current) setLoadError(reason instanceof Error ? reason.message : '未知原因');
    }
  }, [api]);
  useEffect(() => {
    void load();
    // Connection state and new pairings change on their own; a local GET every few seconds is enough.
    const timer = setInterval(() => void load(), 4000);
    return () => {
      sequence.current++;
      clearInterval(timer);
    };
  }, [load]);
  useEffect(() => {
    // The code was used or ran out.
    if (view && !view.pairingExpiresAt) setPairing(undefined);
  }, [view?.pairingExpiresAt]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    void api<DevicesView>('/api/devices', undefined, 'GET').then(
      (next) => {
        if (active) setDevicesView(next);
      },
      (reason) => {
        if (active) notify({ tone: 'error', message: failure(reason) });
      },
    );
    return () => {
      active = false;
    };
  }, [api, open]);
  const run = async (key: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    try {
      await action();
    } catch (reason) {
      notify({ tone: 'error', message: failure(reason) });
    } finally {
      setBusy('');
    }
  };
  const saveTokens = () =>
    run('tokens', async () => {
      const body = {
        ...(appToken.trim() ? { appToken: appToken.trim() } : {}),
        ...(botToken.trim() ? { botToken: botToken.trim() } : {}),
      };
      setView(await api<SlackGatewayView>('/api/slack/tokens', body, 'PUT'));
      setAppToken('');
      setBotToken('');
      notify({ tone: 'success', message: 'Token 已保存在本机。' });
    });
  const toggle = (enabled: boolean) =>
    run('toggle', async () => {
      setView(await api<SlackGatewayView>('/api/slack', { enabled }, 'PATCH'));
    });
  const newCode = () =>
    run('pairing', async () => {
      setPairing(await api<SlackPairingCode>('/api/slack/pairing', {}, 'POST'));
      await load();
    });
  const chooseSlack = (deviceId: string | null) =>
    run('slack', async () => {
      const next = await api<DevicesView & { note?: string }>('/api/devices/slack-host', { deviceId }, 'PUT');
      setDevicesView(next);
      notify({
        tone: next.note ? 'info' : 'success',
        message: next.note ?? (deviceId ? 'Slack 已交给这台设备运行。' : 'Slack 已切回本机运行。'),
      });
      await load();
    });
  const remove = async (id: string) => {
    const name = view?.users.find((user) => user.id === id)?.name ?? id;
    if (!(await confirmDialog({ title: '移除「{0}」？', names: [name], action: '移除', tone: 'danger' }))) return;
    return run(`remove:${id}`, async () => {
      setView(await api<SlackGatewayView>(`/api/slack/users/${encodeURIComponent(id)}`, undefined, 'DELETE'));
    });
  };
  const manifest = JSON.stringify(slackAppManifest(assistant), null, 2);
  const ready = !!view?.appTokenHint && !!view?.botTokenHint;
  const status = view?.enabled ? view.status : 'off';
  const currentStep = [ready, !!view?.enabled, !!view?.users.length].findIndex((done) => !done);
  const allDone = currentStep === -1;
  useEffect(() => {
    setEditingStep(undefined);
    setShowSteps(false);
  }, [currentStep]);
  return (
    <>
      {loadError && (
        <div className="inline-error" role="alert">
          读不到 Slack 设置：{loadError}
          <button type="button" className="button secondary tiny" onClick={() => void load()}>
            重试
          </button>
        </div>
      )}
      {view && (
        <>
          <SettingsRow
            title="Slack"
            itemId="slack"
            description="在 Slack 里私信或 @PugPort 交代任务，答案回到同一个话题。"
            status={
              view.hostedBy
                ? '由其他设备运行'
                : status === 'error'
                  ? '连接失败'
                  : ready && view.enabled && status !== 'connected'
                    ? '连接中…'
                    : undefined
            }
            tone={status === 'error' && !view.hostedBy ? 'danger' : undefined}
            control={
              <>
                {(ready || view.hostedBy) && (
                  <label className="switch" title={view.enabled ? '断开 Slack' : '连接 Slack'}>
                    <input
                      type="checkbox"
                      aria-label="连接 Slack"
                      checked={view.enabled}
                      disabled={(!ready && !view.enabled) || !!busy}
                      onChange={(event) => void toggle(event.target.checked)}
                    />
                    <span />
                  </label>
                )}
                <button ref={opener} type="button" className="button quiet tiny" onClick={() => setOpen(true)}>
                  {ready || view.hostedBy ? '管理' : '开始设置'}
                </button>
              </>
            }
          />
          <ChannelAdmissionSettings
            api={api}
            notify={notify}
            source="slack"
            endpoint="/api/slack/admission"
            scopes={slackAdmissionScopes}
            users={view.users}
          />
        </>
      )}
      {view && open && (
        <SideSheet
          title="Slack"
          label="Slack"
          onClose={() => {
            setOpen(false);
            opener.current?.focus();
          }}
        >
          {ready || view.enabled || view.hostedBy ? (
            <p className="slack-note" translate="no">
              {slackStatusText(view)}
            </p>
          ) : (
            <p className="slack-note">填好下面两个 Token 后就能连接。</p>
          )}
          {!!devicesView?.devices.length && (
            <label className="field slack-host-selector">
              <span>Slack 由哪台运行</span>
              <select
                aria-label="Slack 由哪台运行"
                value={devicesView.slackHost ?? ''}
                disabled={!!busy}
                onChange={(event) => void chooseSlack(event.target.value || null)}
              >
                <option value="">这台电脑</option>
                {devicesView.devices.map((device) => (
                  <option key={device.id} value={device.id} translate="no">
                    {device.name}
                  </option>
                ))}
              </select>
              {busy === 'slack' && <Loader2 size={12} className="spinning" />}
            </label>
          )}
          {!view.hostedBy && (
            <div className="slack-guide">
              {allDone && !showSteps && (
                <p className="slack-guide-summary">
                  已设置好 ·{' '}
                  <button
                    type="button"
                    className="button secondary tiny"
                    onClick={() => {
                      setShowSteps(true);
                      setEditingStep(0);
                    }}
                  >
                    查看步骤
                  </button>
                </p>
              )}
              <div hidden={allDone && !showSteps}>
                <p className="slack-note slack-step-heading">
                  {allDone ? '3 步都已完成' : `第 ${currentStep + 1} 步，共 3 步`}
                  {allDone && (
                    <button
                      type="button"
                      className="button secondary tiny"
                      onClick={() => {
                        setShowSteps(false);
                        setEditingStep(undefined);
                      }}
                    >
                      收起
                    </button>
                  )}
                </p>
                <ol className="slack-steps" aria-label="Slack 设置步骤">
                  {[
                    {
                      title: '创建 Slack 应用并填入 Token',
                      done: ready,
                      content: (
                        <>
                          <ol>
                            <li>
                              打开{' '}
                              <a href="https://api.slack.com/apps?new_app=1" target="_blank" rel="noopener noreferrer">
                                api.slack.com/apps
                                <ExternalLink size={11} />
                              </a>
                              ，选 Create New App → From an app manifest，再选你的工作区。
                            </li>
                            <li>
                              把下面这段整段粘贴进去，点 Create，然后点 Install to Workspace。
                              <label className="slack-check">
                                <input
                                  type="checkbox"
                                  checked={assistant}
                                  onChange={(event) => setAssistant(event.target.checked)}
                                />
                                加上 Slack 侧边栏助手（Agents &amp; AI Apps，部分 Slack 方案才有）
                              </label>
                              <div className="slack-manifest">
                                <div className="slack-manifest-head">
                                  <span>Slack 应用 manifest</span>
                                  <button
                                    type="button"
                                    className="button secondary tiny"
                                    aria-label="复制 manifest"
                                    onClick={() =>
                                      void navigator.clipboard
                                        .writeText(manifest)
                                        .then(() => notify({ tone: 'success', message: 'Manifest 已复制。' }))
                                        .catch(() => notify({ tone: 'error', message: '无法复制，请手动选择并复制。' }))
                                    }
                                  >
                                    <Copy size={13} />
                                    复制
                                  </button>
                                </div>
                                <textarea
                                  readOnly
                                  value={manifest}
                                  aria-label="Slack 应用 manifest"
                                  rows={8}
                                  spellCheck={false}
                                />
                              </div>
                            </li>
                            <li>
                              在 Basic Information → App-Level Tokens 点 Generate Token and Scopes，加上
                              connections:write，复制 xapp- 开头的 Token。
                            </li>
                            <li>在 OAuth &amp; Permissions 复制 Bot User OAuth Token（xoxb- 开头）。</li>
                            <li>
                              想要图标的话，在 Basic Information → Display Information 上传一张 512～2000
                              像素的方形图片。
                            </li>
                          </ol>
                          <form
                            className="slack-tokens"
                            onSubmit={(event) => {
                              event.preventDefault();
                              void saveTokens();
                            }}
                          >
                            <label className="field">
                              <span>App-Level Token</span>
                              <input
                                type="password"
                                autoComplete="off"
                                spellCheck={false}
                                value={appToken}
                                placeholder={view?.appTokenHint ? `已保存 ${view.appTokenHint}，留空保留` : 'xapp-…'}
                                onChange={(event) => setAppToken(event.target.value)}
                              />
                            </label>
                            <label className="field">
                              <span>Bot Token</span>
                              <input
                                type="password"
                                autoComplete="off"
                                spellCheck={false}
                                value={botToken}
                                placeholder={view?.botTokenHint ? `已保存 ${view.botTokenHint}，留空保留` : 'xoxb-…'}
                                onChange={(event) => setBotToken(event.target.value)}
                              />
                            </label>
                            <button
                              type="submit"
                              className="button primary"
                              disabled={!!busy || (!appToken.trim() && !botToken.trim())}
                            >
                              {busy === 'tokens' && <Loader2 size={14} className="spinning" />}保存
                            </button>
                          </form>
                        </>
                      ),
                    },
                    {
                      title: '打开连接',
                      done: view.enabled,
                      content: (
                        <>
                          <p>保存 Token 后，打开连接就能让机器人上线。</p>
                          <button
                            type="button"
                            className="button primary"
                            disabled={!ready || !!busy}
                            onClick={() => void toggle(true)}
                          >
                            连接
                          </button>
                        </>
                      ),
                    },
                    {
                      title: '和机器人配对',
                      done: view.users.length > 0,
                      content: <p>点下面「谁可以用」里的「生成配对码」，再把显示的那一行私信给机器人。</p>,
                    },
                  ].map((step, index) => {
                    const later = currentStep >= 0 && index > currentStep;
                    const expanded = index === currentStep || (!later && step.done && editingStep === index);
                    const contentId = `${guideId}-${index}`;
                    return (
                      <li
                        key={step.title}
                        data-done={step.done}
                        data-later={later}
                        aria-current={index === currentStep ? 'step' : undefined}
                      >
                        <div className="slack-step-heading">
                          <h4>{step.title}</h4>
                          {step.done && !later && (
                            <>
                              <Check size={14} aria-hidden="true" />
                              <span className="sr-only">已完成</span>
                              <button
                                type="button"
                                className="button secondary tiny"
                                aria-label={`修改：${step.title}`}
                                aria-expanded={expanded}
                                aria-controls={contentId}
                                onClick={() => setEditingStep(expanded ? undefined : index)}
                              >
                                修改
                              </button>
                            </>
                          )}
                        </div>
                        <div id={contentId} hidden={!expanded}>
                          {step.content}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </div>
            </div>
          )}
          {view && (view.enabled || view.users.length > 0) && (
            <div className="slack-people">
              <div className="slack-people-heading">
                <h4>谁可以用</h4>
                {view.enabled && (
                  <button type="button" className="button" disabled={!!busy} onClick={() => void newCode()}>
                    {busy === 'pairing' && <Loader2 size={14} className="spinning" />}
                    {pairing ? '换一个配对码' : '生成配对码'}
                  </button>
                )}
              </div>
              {pairing && (
                <p className="slack-pairing">
                  <strong translate="no">{pairing.code}</strong>
                  <span>
                    在 Slack 里私信机器人：<code>pair {pairing.code}</code>（10 分钟内有效，只能用一次）
                  </span>
                </p>
              )}
              {view.users.length ? (
                <ul className="slack-users">
                  {view.users.map((user) => (
                    <li key={user.id}>
                      <span translate="no">{user.name ?? user.id}</span>
                      <small>{new Date(user.pairedAt).toLocaleDateString(currentLocale())} 配对</small>
                      <label className="slack-owner">
                        <input
                          type="checkbox"
                          aria-label={withNames('这是我：{0}', [user.name ?? user.id])}
                          data-names
                          checked={!!user.isOwner}
                          disabled={!!busy}
                          onChange={(event) =>
                            void run(`owner:${user.id}`, async () => {
                              setView(
                                await api<SlackGatewayView>(
                                  `/api/slack/users/${encodeURIComponent(user.id)}`,
                                  { isOwner: event.target.checked },
                                  'PATCH',
                                ),
                              );
                            })
                          }
                        />
                        这是我
                      </label>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={withNames('移除 {0}', [user.name ?? user.id])}
                        title={translateInterfaceText('移除')}
                        data-names
                        disabled={!!busy}
                        onClick={() => void remove(user.id)}
                      >
                        <X size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="slack-note">还没有人配对。只有配对过的人能让 PugPort 做事，其他人只会收到一句婉拒。</p>
              )}
            </div>
          )}
          <p className="slack-note">
            任务按上面的授权等级处理；其他人的任务保持只读。机器人只读得到它被拉进的频道。Token 只保存在本机。
          </p>
        </SideSheet>
      )}
    </>
  );
}
