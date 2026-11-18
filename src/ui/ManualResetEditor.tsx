import { currentLocale } from './i18n';
import { useEffect, useState } from 'react';
import type { ManualResetNote } from '../shared/manual-reset';
const localInput = (value: string) => {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const blank = {
  kind: 'reset' as 'reset' | 'cloud-credit',
  remainingUsd: '',
  totalUsd: '',
  expiresAt: '',
  label: '额度重置权益',
  count: '',
  expiresOn: '',
  status: 'available' as ManualResetNote['status'],
  note: '',
};
export function ManualResetEditor({ runtimeId }: { runtimeId: string }) {
  const [rows, setRows] = useState<ManualResetNote[]>([]),
    [draft, setDraft] = useState({ ...blank }),
    [id, setId] = useState<string>(),
    [editing, setEditing] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const url = '/api/manual-resets/' + encodeURIComponent(runtimeId);
  async function request(method: string, body: unknown, path = url) {
    const { token } = await (await fetch('/api/session')).json();
    const r = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-agent-token': token },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw Error(data.error || '保存失败');
    return data as ManualResetNote[];
  }
  useEffect(() => {
    let active = true;
    setRows([]);
    setEditing(false);
    setError('');
    fetch(url)
      .then(async (r) => {
        if (!r.ok) throw Error('无法读取本地手动记录');
        return r.json();
      })
      .then((value) => {
        if (active) setRows(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [url]);
  async function save() {
    setBusy(true);
    setError('');
    try {
      setRows(
        await request('POST', {
          ...(id ? { id } : {}),
          ...draft,
          remainingUsd: draft.kind === 'cloud-credit' && draft.remainingUsd !== '' ? Number(draft.remainingUsd) : null,
          totalUsd: draft.kind === 'cloud-credit' && draft.totalUsd !== '' ? Number(draft.totalUsd) : null,
          expiresAt: draft.expiresAt ? new Date(draft.expiresAt).toISOString() : null,
          count: draft.kind === 'reset' && draft.count !== '' ? Number(draft.count) : null,
          expiresOn: draft.expiresOn || null,
        }),
      );
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }
  async function remove(value: string) {
    setBusy(true);
    setError('');
    try {
      setRows(await request('DELETE', {}, url + '/' + value));
      if (id === value) setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="本地手动权益记录" className={rows.length ? 'benefit-panel' : 'manual-benefits-empty'}>
      {rows.length > 0 && (
        <header className="benefit-header">
          <strong>手动权益</strong>
          <span className="benefit-badge">仅本机</span>
        </header>
      )}
      {rows.map((row) => (
        <article className="benefit-row" key={row.id}>
          <div className="benefit-row-main">
            <strong>{row.label}</strong>
            <span className="benefit-badge">
              {{ available: '可用 · 手动', used: '已使用', expired: '已过期', unknown: '待核对' }[row.status]}
            </span>
          </div>
          {row.kind === 'cloud-credit' ? (
            <>
              <div className="benefit-amount">
                USD {row.remainingUsd ?? '未知'} <small>/ {row.totalUsd ?? '未知'} 剩余</small>
              </div>
              {row.remainingUsd != null && row.totalUsd != null && row.totalUsd > 0 && (
                <progress
                  className="benefit-progress"
                  aria-label="手动记录的云额度余额"
                  value={row.remainingUsd}
                  max={row.totalUsd}
                />
              )}
              <p className="benefit-expiry">仅限云会话</p>
            </>
          ) : (
            row.count !== null && (
              <div className="benefit-amount">
                {row.count} <small>次剩余</small>
              </div>
            )
          )}
          <p className="benefit-expiry">
            {row.expiresAt
              ? new Date(row.expiresAt).toLocaleString(currentLocale(), { timeZoneName: 'short' })
              : (row.expiresOn ?? '日期未注明')}{' '}
            到期
          </p>
          <div className="benefit-actions">
            <button
              className="button secondary tiny"
              disabled={busy}
              onClick={() => {
                setId(row.id);
                setDraft({
                  kind: row.kind === 'cloud-credit' ? 'cloud-credit' : 'reset',
                  remainingUsd: row.remainingUsd == null ? '' : String(row.remainingUsd),
                  totalUsd: row.totalUsd == null ? '' : String(row.totalUsd),
                  expiresAt: row.expiresAt ? localInput(row.expiresAt) : '',
                  label: row.label,
                  count: row.count === null ? '' : String(row.count),
                  expiresOn: row.expiresOn ?? '',
                  status: row.status,
                  note: row.note,
                });
                setEditing(true);
              }}
            >
              编辑
            </button>
            <button className="button secondary tiny" disabled={busy} onClick={() => void remove(row.id)}>
              删除
            </button>
          </div>
          <details className="benefit-details">
            <summary>备注与来源</summary>
            <p>{row.note}</p>
            <p>
              记录时间：{new Date(row.updatedAt).toLocaleString(currentLocale())}
              <br />
              仅本机手动记录；使用后或换号后请更新。{!row.expiresAt ? '具体到期时刻未注明。' : ''}
              {row.kind === 'cloud-credit' ? '不是本地 CLI/API 余额。' : row.count === null ? '次数未注明。' : ''}
            </p>
          </details>
        </article>
      ))}
      {!editing ? (
        <button
          className="button secondary tiny"
          onClick={() => {
            setId(undefined);
            setDraft({ ...blank });
            setEditing(true);
          }}
        >
          添加手动权益
        </button>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="field">
            <span>权益类型</span>
            <select
              value={draft.kind}
              onChange={(e) => setDraft({ ...draft, kind: e.target.value as 'reset' | 'cloud-credit' })}
            >
              <option value="reset">额度重置卡</option>
              <option value="cloud-credit">云会话赠送额度</option>
            </select>
          </label>
          <label className="field">
            <span>名称</span>
            <input
              required
              maxLength={100}
              value={draft.label}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            />
          </label>
          {draft.kind === 'cloud-credit' ? (
            <>
              <label className="field">
                <span>剩余金额（USD）</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={draft.remainingUsd}
                  onChange={(e) => setDraft({ ...draft, remainingUsd: e.target.value })}
                />
              </label>
              <label className="field">
                <span>总金额（USD）</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={draft.totalUsd}
                  onChange={(e) => setDraft({ ...draft, totalUsd: e.target.value })}
                />
              </label>
            </>
          ) : (
            <label className="field">
              <span>剩余次数（不清楚则留空）</span>
              <input
                type="number"
                min="0"
                max="10000"
                step="1"
                value={draft.count}
                onChange={(e) => setDraft({ ...draft, count: e.target.value })}
              />
            </label>
          )}
          <label className="field">
            <span>到期日期（不清楚则留空）</span>
            <input
              type="date"
              value={draft.expiresOn}
              onChange={(e) => setDraft({ ...draft, expiresOn: e.target.value })}
            />
          </label>
          <label className="field">
            <span>精确到期时间（可选，按本机时区）</span>
            <input
              type="datetime-local"
              value={draft.expiresAt}
              onChange={(e) => setDraft({ ...draft, expiresAt: e.target.value })}
            />
          </label>
          <label className="field">
            <span>状态</span>
            <select
              value={draft.status}
              onChange={(e) => setDraft({ ...draft, status: e.target.value as ManualResetNote['status'] })}
            >
              <option value="available">标注可用</option>
              <option value="used">已使用</option>
              <option value="expired">已过期</option>
              <option value="unknown">待核对</option>
            </select>
          </label>
          <label className="field">
            <span>备注</span>
            <textarea
              maxLength={1000}
              value={draft.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            />
          </label>
          <button type="submit" className="button secondary tiny" disabled={busy}>
            保存到本机
          </button>{' '}
          <button type="button" className="button secondary tiny" disabled={busy} onClick={() => setEditing(false)}>
            取消
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="inline-warning">
          {error}
        </p>
      )}
    </section>
  );
}
