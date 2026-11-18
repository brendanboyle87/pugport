import { useEffect, useRef, useState } from 'react';
import type { WebSearchUpdate, WebSearchView } from '../shared/web-search';
import { SettingsGroup, SettingsRow } from './SettingsRow';
import { SideSheet } from './SideSheet';
import { withNames } from './i18n';
import type { Api, Notice } from './Workspace';

export function WebSearchSettings({ api, notify }: { api: Api; notify: (notice: Notice) => void }) {
  const [view, setView] = useState<WebSearchView>();
  const [key, setKey] = useState('');
  const [limit, setLimit] = useState('5');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const fail = (failure: unknown) => {
    const message =
      failure && typeof failure === 'object' && 'message' in failure && typeof failure.message === 'string'
        ? failure.message
        : '联网搜索设置保存失败';
    setError(message);
    notify({ tone: 'error', message });
  };
  useEffect(() => {
    let active = true;
    void api<WebSearchView>('/api/web-search', undefined, 'GET').then(
      (value) => {
        if (!active) return;
        setView(value);
        setLimit(String(value.monthlyLimitCny));
      },
      (failure) => {
        if (active) fail(failure);
      },
    );
    return () => {
      active = false;
    };
  }, [api]);
  async function save(update: WebSearchUpdate) {
    setBusy(true);
    setError('');
    try {
      const value = await api<WebSearchView>('/api/web-search', update, 'PUT');
      setView(value);
      setLimit(String(value.monthlyLimitCny));
      if (update.key !== undefined || update.clearKey) setKey('');
      notify({ tone: 'success', message: '联网搜索设置已保存' });
    } catch (failure) {
      fail(failure);
    } finally {
      setBusy(false);
    }
  }
  const monthlyLimit = Number(limit);
  return (
    <>
      <SettingsRow
        title="联网搜索"
        itemId="web-search"
        description={
          error &&
          !open && (
            <div className="inline-error" role="alert">
              {error}
            </div>
          )
        }
        status={
          view?.configured ? (
            <span translate="no">
              {withNames(view.usage.requests === 1 ? '本月 1 次请求' : '本月 {0} 次请求', [
                String(view.usage.requests),
              ])}
            </span>
          ) : undefined
        }
        control={
          <>
            {view?.configured && (
              <label className="switch">
                <input
                  type="checkbox"
                  aria-label="启用联网搜索"
                  checked={view?.enabled ?? false}
                  disabled={!view?.configured || busy}
                  onChange={(event) => void save({ enabled: event.target.checked })}
                />
                <span />
              </label>
            )}
            <button ref={opener} type="button" className="button quiet tiny" onClick={() => setOpen(true)}>
              {view?.configured ? '管理' : '开始设置'}
            </button>
          </>
        }
      />
      {open && (
        <SideSheet
          title="联网搜索"
          label="联网搜索"
          onClose={() => {
            setOpen(false);
            opener.current?.focus();
          }}
        >
          <SettingsGroup description="独立使用 DeepSeek 搜索 Key。输入 /搜索 关键词，或由 agent 按需调用。保存不会发起收费请求。">
            {error && (
              <p className="inline-error" role="alert">
                {error}
              </p>
            )}
            <SettingsRow
              title="DeepSeek 搜索 Key"
              description={view?.keyHint}
              control={
                <div className="setting-control" style={{ width: 340, maxWidth: '100%' }}>
                  <input
                    type="password"
                    aria-label="DeepSeek 搜索 Key"
                    autoComplete="off"
                    value={key}
                    placeholder={view?.configured ? '输入新 Key 以替换' : '粘贴 DeepSeek 搜索 Key'}
                    onChange={(event) => setKey(event.target.value)}
                  />
                  <button
                    type="button"
                    className="button secondary"
                    disabled={!view || busy || !key.trim()}
                    onClick={() => void save({ key: key.trim() })}
                  >
                    保存
                  </button>
                  {view?.configured && (
                    <button
                      type="button"
                      className="button quiet"
                      disabled={busy}
                      onClick={() => void save({ clearKey: true })}
                    >
                      清除
                    </button>
                  )}
                </div>
              }
            />
            <SettingsRow
              title="每月搜索预算（人民币）"
              description="每次计费成功的搜索或网页读取估算 ¥0.005。未确认请求的费用可能仍需结算。"
              control={
                <div className="setting-control">
                  <input
                    type="number"
                    aria-label="每月搜索预算（人民币）"
                    min="0"
                    step="0.01"
                    value={limit}
                    onChange={(event) => setLimit(event.target.value)}
                  />
                  <button
                    type="button"
                    className="button secondary"
                    disabled={!view || busy || !limit.trim() || !Number.isFinite(monthlyLimit) || monthlyLimit < 0}
                    onClick={() => void save({ monthlyLimitCny: monthlyLimit })}
                  >
                    保存预算
                  </button>
                </div>
              }
            />
            {view && (
              <SettingsRow
                title="本月搜索用量"
                description={`${view.month} · ${view.usage.requests} 次请求 · ${view.usage.billableRequests} 次计费成功 · ${view.usage.uncertainRequests} 次未确认 · 估算 ¥${view.usage.estimatedCostCny.toFixed(3)} · 预留 ¥${view.usage.reservedCny.toFixed(3)}`}
              />
            )}
          </SettingsGroup>
        </SideSheet>
      )}
    </>
  );
}
