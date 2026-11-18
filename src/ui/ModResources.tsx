import { useCallback, useEffect, useRef, useState } from 'react';
import type { BankConnectionView, LinkSessionView, PlaidSettingsView } from '../shared/mod-data';
import { requestBankLink } from './BankLinkDialog';
import { PlaidKeyForm } from './PlaidKeyForm';
import { confirmDialog } from './confirm-dialog';
import { SettingsGroup, SettingsRow } from './SettingsRow';
import { currentLocale, withNames } from './i18n';
import type { Api, Notice } from './Workspace';
import type { ConversationModesView } from '../shared/conversation-modes';
import { friendlyModError } from './mod-errors';

type Connection = BankConnectionView & { modIds: string[] };
type ModData = { modId: string; items: number; bytes: number };
const failure = (error: unknown) =>
  (error as { code?: string })?.code === 'E_LIMIT'
    ? '请先完成或关闭已打开的银行窗口，再重试。'
    : friendlyModError(error).text;
const size = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const statusText: Record<BankConnectionView['status'], string> = {
  connected: '已连接',
  syncing: '正在同步',
  reauth_required: '需要重新登录',
  error: '同步失败，稍后自动重试',
  disconnected: '已断开',
};
const when = (at?: string) => (at ? new Date(at).toLocaleString(currentLocale()) : '');

export function savedModResources(
  modes: ConversationModesView,
  plaid: PlaidSettingsView,
  connections: Connection[],
  usage: ModData[],
) {
  const loaded = modes.catalog.filter((mod) =>
    modes.installed.some((item) => item.modeId === mod.id && item.version === mod.version),
  );
  const bankMods = loaded.filter((mod) => mod.permissions?.includes('connections:read'));
  const mods = usage.filter(
    (item) =>
      (item.items > 0 || item.bytes > 0) &&
      !loaded.some((mod) => mod.id === item.modId && mod.permissions?.includes('data:store')),
  );
  const banks =
    connections.some((connection) => !bankMods.some((mod) => connection.modIds.includes(mod.id))) ||
    (!bankMods.length && !!(plaid.configured || plaid.clientIdEnding || plaid.sandboxSecret || plaid.productionSecret));
  return { banks, mods };
}

export function SavedModResources({
  api,
  notify,
  modes,
}: {
  api: Api;
  notify: (notice: Notice) => void;
  modes: ConversationModesView;
}) {
  const [saved, setSaved] = useState<ReturnType<typeof savedModResources>>();
  const [manage, setManage] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const [plaid, connections, usage] = await Promise.all([
          api<PlaidSettingsView>('/api/bank/settings', undefined, 'GET'),
          api<{ connections: Connection[] }>('/api/bank/connections', undefined, 'GET'),
          api<{ mods: ModData[] }>('/api/mod-data', undefined, 'GET'),
        ]);
        if (active) setSaved(savedModResources(modes, plaid, connections.connections, usage.mods));
      } catch {
        /* Keep this optional entry quiet when resource metadata is unavailable. */
      }
    };
    void load();
    const timer = setInterval(() => void load(), 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api, modes, revision]);
  if (!saved || (!manage && !saved.banks && !saved.mods.length)) return null;
  return (
    <>
      <p className="store-context saved-mod-resources">
        <span>已保存的银行和 Mod 数据</span> ·{' '}
        <button type="button" className="store-detail-button" onClick={() => setManage(true)}>
          管理
        </button>
      </p>
      {manage && (
        <ModResources
          api={api}
          notify={notify}
          modId=""
          title=""
          permissions={saved.banks ? ['connections:read'] : []}
          savedMods={saved.mods}
          onClose={() => {
            setManage(false);
            setRevision((value) => value + 1);
          }}
        />
      )}
    </>
  );
}

export function ModResources({
  api,
  notify,
  modId,
  title,
  permissions,
  savedMods,
  onClose,
}: {
  api: Api;
  notify: (notice: Notice) => void;
  modId: string;
  title: string;
  permissions: readonly string[];
  savedMods?: ModData[];
  onClose?: () => void;
}) {
  const banks = permissions.includes('connections:read');
  const data = permissions.includes('data:store');
  const [plaid, setPlaid] = useState<PlaidSettingsView>();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [usage, setUsage] = useState<ModData>();
  const [manage, setManage] = useState(!!onClose);
  const close = () => {
    setManage(false);
    onClose?.();
  };
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const operation = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyRevision, setKeyRevision] = useState(0);
  const load = useCallback(async () => {
    const [settings, list, stored] = await Promise.all([
      banks ? api<PlaidSettingsView>('/api/bank/settings', undefined, 'GET') : undefined,
      banks ? api<{ connections: Connection[] }>('/api/bank/connections', undefined, 'GET') : undefined,
      data ? api<{ mods: ModData[] }>('/api/mod-data', undefined, 'GET') : undefined,
    ]);
    if (!mounted.current) return;
    setPlaid(settings);
    setConnections(list?.connections ?? []);
    setUsage(stored?.mods.find((item) => item.modId === modId) ?? { modId, items: 0, bytes: 0 });
  }, [api, banks, data, modId]);
  useEffect(() => {
    mounted.current = true;
    void load().catch((reason) => setError(failure(reason)));
    const timer = setInterval(() => void load().catch(() => undefined), 15000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [load]);
  useEffect(() => {
    if (manage) dialog.current?.showModal();
  }, [manage]);
  const run = async (id: string, action: () => Promise<unknown>) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(id);
    setError('');
    try {
      await action();
      await load();
    } catch (reason) {
      if (mounted.current) setError(failure(reason));
    } finally {
      operation.current = false;
      if (mounted.current) setBusy('');
    }
  };
  const link = (reconnect?: string) =>
    run(reconnect ?? 'link', async () => {
      const { result } = await requestBankLink({
        api,
        requester: title,
        start: () => api<LinkSessionView>('/api/bank/connections/link', reconnect ? { reconnect } : {}),
      });
      const linked = await result;
      setKeyRevision((value) => value + 1);
      if (linked.status === 'connected') {
        if (!reconnect && linked.connectionId)
          await api(
            `/api/bank/connections/${encodeURIComponent(linked.connectionId)}/mods/${encodeURIComponent(modId)}`,
            { shared: true },
            'PUT',
          );
        notify({ tone: 'success', message: '银行已连接，正在同步。' });
      } else if (linked.status !== 'cancelled') throw new Error(linked.error ?? 'Plaid 没有完成连接，请重试。');
    });
  const remove = async (connection: Connection) => {
    if (
      await confirmDialog({
        title: '删除这个银行连接？',
        summary:
          '会通知 Plaid 删除这个连接（之后不再为它计费），并删除本机缓存的账户和交易。Mod 自己保存的账本不受影响。',
        action: '删除连接',
        tone: 'danger',
      })
    )
      await run(connection.id, () =>
        api(`/api/bank/connections/${encodeURIComponent(connection.id)}`, undefined, 'DELETE'),
      );
  };
  const backup = (modId: string) =>
    run(`backup:${modId}`, async () => {
      const data = await api<unknown>(`/api/mod-data/${encodeURIComponent(modId)}/backup`, {});
      const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
      try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `${modId}-data.json`;
        anchor.click();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    });
  const restore = async (file: File, modId: string) => {
    if (
      !(await confirmDialog({
        title: '用备份替换这个 Mod 的数据？',
        summary: '现有数据会被备份里的内容完整替换。建议先备份一次当前数据。',
        action: '恢复',
        tone: 'danger',
      }))
    )
      return;
    await run(`restore:${modId}`, async () => {
      let data: unknown;
      try {
        data = JSON.parse(await file.text());
      } catch {
        throw new Error('这个文件不是 PugPort 的 Mod 数据备份。');
      }
      const { restored } = await api<{ restored: number }>(`/api/mod-data/${encodeURIComponent(modId)}/restore`, data);
      notify({ tone: 'success', message: `已恢复 ${restored} 条数据。` });
    });
  };
  const clear = async (modId: string) => {
    if (
      await confirmDialog({
        title: '删除「{0}」保存的全部数据？',
        names: [title],
        summary: '账本、导入记录等都会被删除，无法撤销。删除前可以先备份。对话和 Mod 本身不受影响。',
        action: '删除数据',
        tone: 'danger',
      })
    )
      await run(`clear:${modId}`, () =>
        api(`/api/mod-data/${encodeURIComponent(modId)}`, { confirm: modId }, 'DELETE'),
      );
  };
  const shared = connections.filter((connection) => connection.modIds.includes(modId));
  const needsLogin = shared.some((connection) => connection.status === 'reauth_required');
  return (
    <section className="mod-resources" aria-label="Mod 数据与连接">
      {!manage && error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {banks && !onClose && (
        <SettingsRow
          title="银行连接"
          itemId="mod-bank-row"
          status={
            needsLogin ? (
              '需要重新登录'
            ) : !plaid ? (
              '正在加载…'
            ) : !plaid.configured ? (
              '尚未设置'
            ) : (
              <>
                <span translate="no">{plaid.environment === 'sandbox' ? 'Sandbox' : 'Production'} · </span>
                <span>{shared.length === 1 ? '1 家银行已连接' : `${shared.length} 家银行已连接`}</span>
              </>
            )
          }
          tone={needsLogin ? 'warning' : undefined}
          control={
            <button type="button" className="button secondary" onClick={() => setManage(true)}>
              管理
            </button>
          }
        />
      )}
      {data && (
        <SettingsRow
          title="Mod 数据"
          itemId="mod-data-row"
          description={usage ? `${usage.items} 条 · ${size(usage.bytes)}` : '正在加载…'}
          control={
            <span className="bank-connection-actions">
              <button
                type="button"
                className="button secondary"
                disabled={!!busy || !usage}
                onClick={() => void backup(modId)}
              >
                备份
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={!!busy || !usage}
                onClick={() => fileInput.current?.click()}
              >
                恢复
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={!!busy || !usage}
                onClick={() => void clear(modId)}
              >
                删除全部数据
              </button>
            </span>
          }
        />
      )}
      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void restore(file, modId);
        }}
      />
      {manage && (
        <dialog
          ref={dialog}
          className="modal mod-bank-dialog"
          aria-label={onClose ? '已保存的银行和 Mod 数据' : '银行连接'}
          onCancel={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!keyBusy) close();
          }}
        >
          <div className="mod-bank-heading">
            <h2>{onClose ? '已保存的银行和 Mod 数据' : '银行连接'}</h2>
            <button type="button" className="button secondary" disabled={keyBusy} onClick={close}>
              关闭
            </button>
          </div>
          <p className="mod-bank-requester" translate="no">
            {title}
          </p>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          {banks && (
            <PlaidKeyForm
              api={api}
              refreshKey={keyRevision}
              onBusy={setKeyBusy}
              onChange={() => void load().catch((reason) => setError(failure(reason)))}
            />
          )}
          {banks && (
            <SettingsGroup
              title="银行连接"
              itemId="bank-connections"
              description="PugPort 打开时大约每 6 小时同步一次；关闭期间不同步，下次打开后补上。同步失败时保留上次的数据和时间。"
            >
              {connections.map((connection) => (
                <SettingsRow
                  key={connection.id}
                  defaultExpanded
                  title={<span translate="no">{connection.institution?.name ?? 'Plaid'}</span>}
                  description={
                    <>
                      {connection.environment === 'sandbox' && <span>Sandbox 测试数据 · </span>}
                      <span>
                        {connection.lastSyncedAt ? `上次同步 ${when(connection.lastSyncedAt)}` : '还没有同步成功'}
                      </span>
                      <span> · </span>
                      {connection.modIds.length ? (
                        <span translate="no">
                          {withNames('共享给：{0}', [
                            connection.modIds.map((id) => (id === modId ? title : id)).join('、'),
                          ])}
                        </span>
                      ) : (
                        <span>没有共享给任何 Mod</span>
                      )}
                    </>
                  }
                  status={statusText[connection.status]}
                  tone={connection.status === 'reauth_required' || connection.status === 'error' ? 'warning' : 'live'}
                  control={
                    <span className="bank-connection-actions">
                      {connection.status === 'reauth_required' ? (
                        <button
                          type="button"
                          className="button primary"
                          disabled={!!busy || keyBusy}
                          onClick={() => void link(connection.id)}
                        >
                          重新连接
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="button secondary"
                          disabled={!!busy || connection.status === 'syncing'}
                          onClick={() =>
                            void run(connection.id, () =>
                              api(`/api/bank/connections/${encodeURIComponent(connection.id)}/sync`, {}),
                            )
                          }
                        >
                          立即同步
                        </button>
                      )}
                      <button
                        type="button"
                        className="button secondary"
                        disabled={!!busy}
                        onClick={() => void remove(connection)}
                      >
                        删除
                      </button>
                    </span>
                  }
                >
                  {modId && (
                    <label className="bank-share">
                      <input
                        type="checkbox"
                        checked={connection.modIds.includes(modId)}
                        disabled={!!busy}
                        onChange={(event) =>
                          void run(connection.id, () =>
                            api(
                              `/api/bank/connections/${encodeURIComponent(connection.id)}/mods/${encodeURIComponent(modId)}`,
                              { shared: event.target.checked },
                              'PUT',
                            ),
                          )
                        }
                      />
                      <span>共享给这个 Mod</span>
                    </label>
                  )}
                  {connection.error && <p className="inline-error">{friendlyModError(connection.error).text}</p>}
                </SettingsRow>
              ))}
              {modId && (
                <SettingsRow
                  title="连接银行"
                  control={
                    <button
                      type="button"
                      className="button primary"
                      disabled={!!busy || keyBusy}
                      onClick={() => void link()}
                    >
                      连接银行
                    </button>
                  }
                />
              )}
            </SettingsGroup>
          )}
          {savedMods?.map((mod) => (
            <div key={mod.modId}>
              <p translate="no">{mod.modId}</p>
              <ModResources
                api={api}
                notify={notify}
                modId={mod.modId}
                title={mod.modId}
                permissions={['data:store']}
              />
            </div>
          ))}
        </dialog>
      )}
    </section>
  );
}
