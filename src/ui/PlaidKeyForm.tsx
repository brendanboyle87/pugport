import { useEffect, useRef, useState } from 'react';
import type { PlaidSettingsView } from '../shared/mod-data';
import type { Api } from './Workspace';
import { confirmDialog } from './confirm-dialog';
import { SettingsGroup, SettingsRow } from './SettingsRow';
import { useUiUpdateBlocker } from './ui-update-guard';

/** Host-only fields: neither drafts nor saved keys are sent to a Mod. */
export function PlaidKeyForm({
  api,
  onSaved,
  onChange,
  onBusy,
  refreshKey,
}: {
  api: Api;
  onSaved?: () => Promise<void>;
  onChange?: () => void;
  onBusy?: (busy: boolean) => void;
  refreshKey?: number;
}) {
  const [plaid, setPlaid] = useState<PlaidSettingsView>();
  const [clientId, setClientId] = useState('');
  const [sandboxSecret, setSandboxSecret] = useState('');
  const [productionSecret, setProductionSecret] = useState('');
  const [environment, setEnvironment] = useState<PlaidSettingsView['environment']>('sandbox');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const environmentEdited = useRef(false);
  useUiUpdateBlocker(() => !!(clientId || sandboxSecret || productionSecret || busy), 'bank-settings');
  useEffect(() => {
    let stopped = false;
    void api<PlaidSettingsView>('/api/bank/settings', undefined, 'GET')
      .then((value) => {
        if (stopped) return;
        setPlaid(value);
        if (!environmentEdited.current) setEnvironment(value.clientIdEnding ? value.environment : 'sandbox');
      })
      .catch((reason) => {
        if (!stopped) setError(String(reason));
      });
    return () => {
      stopped = true;
    };
  }, [api, refreshKey]);
  const run = async (action: () => Promise<unknown>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    onBusy?.(true);
    setError('');
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      pending.current = false;
      setBusy(false);
      onBusy?.(false);
    }
  };
  const saveKeys = () =>
    run(async () => {
      const saved = await api<PlaidSettingsView>(
        '/api/bank/settings',
        {
          environment,
          ...(clientId.trim() ? { clientId: clientId.trim() } : {}),
          ...(sandboxSecret.trim() ? { sandboxSecret: sandboxSecret.trim() } : {}),
          ...(productionSecret.trim() ? { productionSecret: productionSecret.trim() } : {}),
        },
        'PUT',
      );
      setPlaid(saved);
      setClientId('');
      setSandboxSecret('');
      setProductionSecret('');
      onChange?.();
      await onSaved?.();
    });
  const clearKeys = async () => {
    if (
      await confirmDialog({
        title: '清除 Plaid 密钥？',
        summary: '这会影响所有使用银行的 Mod。已连接的银行会停止同步，已同步的数据保留。之后重新填写密钥即可恢复。',
        action: '清除密钥',
        tone: 'danger',
      })
    )
      await run(async () => {
        setPlaid(await api<PlaidSettingsView>('/api/bank/settings', undefined, 'DELETE'));
        onChange?.();
      });
  };
  return (
    <>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <SettingsGroup
        title="Plaid 密钥"
        itemId="plaid-keys"
        description="PugPort 通过 Plaid 读取银行数据。密钥只保存在这台电脑，不会交给 Mod、不会同步到云端。"
      >
        <ol className="plaid-setup-steps">
          <li>
            <a href="https://dashboard.plaid.com" target="_blank" rel="noopener noreferrer">
              打开 Plaid Dashboard
            </a>
            <span>，注册或登录你的 Plaid 账号。</span>
          </li>
          <li>打开 Developers › Keys，复制 Client ID 和对应环境的 secret。</li>
          <li>先用 Sandbox 测试数据。连接真实银行时，再填写 Production secret 并切换到 Production。</li>
        </ol>
        {plaid?.clientIdEnding && (
          <SettingsRow
            title="状态"
            status={
              <span>
                <span translate="no">Client ID …{plaid.clientIdEnding} · Sandbox </span>
                <span>{plaid.sandboxSecret ? '已保存' : '未填'}</span>
                <span translate="no"> · Production </span>
                <span>{plaid.productionSecret ? '已保存' : '未填'}</span>
              </span>
            }
            control={
              <button type="button" className="button secondary" disabled={busy} onClick={() => void clearKeys()}>
                清除密钥
              </button>
            }
          />
        )}
        <SettingsRow
          title="新连接使用"
          description="Sandbox 使用测试数据；Production 连接真实银行。"
          control={
            <select
              aria-label="新连接使用"
              value={environment}
              disabled={busy}
              onChange={(event) => {
                environmentEdited.current = true;
                setEnvironment(event.target.value as PlaidSettingsView['environment']);
              }}
            >
              <option value="sandbox">Sandbox</option>
              <option value="production">Production</option>
            </select>
          }
        />
        <div className="settings-row bank-key-fields">
          <label>
            Client ID
            <input
              aria-label="Client ID"
              value={clientId}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              placeholder={plaid?.clientIdEnding ? `已保存 …${plaid.clientIdEnding}，留空不变` : ''}
              onChange={(event) => setClientId(event.target.value)}
            />
          </label>
          <label>
            Sandbox secret
            <input
              aria-label="Sandbox secret"
              type="password"
              value={sandboxSecret}
              disabled={busy}
              autoComplete="off"
              placeholder={plaid?.sandboxSecret ? '已保存，留空不变' : ''}
              onChange={(event) => setSandboxSecret(event.target.value)}
            />
          </label>
          <label>
            Production secret
            <input
              aria-label="Production secret"
              type="password"
              value={productionSecret}
              disabled={busy}
              autoComplete="off"
              placeholder={plaid?.productionSecret ? '已保存，留空不变' : ''}
              onChange={(event) => setProductionSecret(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="button primary"
            disabled={
              !plaid ||
              busy ||
              (!plaid.clientIdEnding && !clientId.trim()) ||
              (environment === 'sandbox'
                ? !plaid.sandboxSecret && !sandboxSecret.trim()
                : !plaid.productionSecret && !productionSecret.trim())
            }
            onClick={() => void saveKeys()}
          >
            {onSaved ? '保存并继续' : '保存'}
          </button>
        </div>
      </SettingsGroup>
    </>
  );
}
