import { useEffect, useRef, useState, type FormEvent } from 'react';
import { RefreshCw } from 'lucide-react';
import { modeSourceConfigSchema, modeSourceViewSchema, type ModeSourceView } from '../shared/mode-source';
import type { Api } from './Workspace';
import { friendlyModError } from './mod-errors';

/** Source requests are optional Store work; they never delay ordinary chat or the local catalog. */
export function ModeSourcePanel({
  api,
  onSource,
  onBusyChange,
}: {
  api: Api;
  onSource: (value: ModeSourceView) => void;
  onBusyChange: (value: boolean) => void;
}) {
  const [view, setView] = useState<ModeSourceView>();
  const [repository, setRepository] = useState('');
  const [ref, setRef] = useState('main');
  const [enabled, setEnabled] = useState(true);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<'load' | 'refresh' | 'save'>();
  const [error, setError] = useState('');
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!editing) return;
    const closeOutside = (event: PointerEvent) => {
      if (panel.current && !panel.current.contains(event.target as Node)) setEditing(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [editing]);
  const mounted = useRef(false);
  const ticket = useRef(0);
  const active = useRef<{ ticket: number; kind: typeof busy; abort: AbortController } | undefined>(undefined);
  const dirty = useRef(false);
  const handlers = useRef({ onSource, onBusyChange });
  handlers.current = { onSource, onBusyChange };
  const current = (id: number) => mounted.current && ticket.current === id;
  const publish = (value: ModeSourceView, id: number, restore = false) => {
    if (!current(id)) return;
    setView(value);
    setError('');
    handlers.current.onSource(value);
    if (restore && !dirty.current) {
      setRepository(value.config?.repository ?? '');
      setRef(value.config?.ref ?? 'main');
      setEnabled(value.config?.enabled ?? true);
    }
  };
  async function request(path: string, body: unknown, method: string, operation: NonNullable<typeof active.current>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        api<unknown>(path, body, method, operation.abort.signal),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            operation.abort.abort();
            reject(new Error('Source request timeout'));
          }, 20000);
        }),
      ]);
      const result = modeSourceViewSchema.safeParse(value);
      if (!result.success) throw new Error('Invalid source response');
      return result.data;
    } finally {
      clearTimeout(timer);
    }
  }
  const start = (kind: NonNullable<typeof busy>) => {
    active.current?.abort.abort();
    const operation = { ticket: ++ticket.current, kind, abort: new AbortController() };
    active.current = operation;
    setBusy(kind);
    setError('');
    handlers.current.onBusyChange(true);
    return operation;
  };
  const finish = (operation: NonNullable<typeof active.current>) => {
    if (!current(operation.ticket)) return;
    active.current = undefined;
    setBusy(undefined);
    handlers.current.onBusyChange(false);
  };
  const fail = (operation: NonNullable<typeof active.current>, failure: unknown) => {
    if (current(operation.ticket)) setError(friendlyModError(failure, 'source').text);
  };
  async function refresh() {
    if (active.current) return;
    const operation = start('refresh');
    try {
      publish(await request('/api/modes/source/refresh', { force: true }, 'POST', operation), operation.ticket);
    } catch (failure) {
      fail(operation, failure);
    } finally {
      finish(operation);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (active.current?.kind === 'save') return;
    const parsed = modeSourceConfigSchema.safeParse({
      enabled,
      repository: repository.trim(),
      ref: ref.trim() || 'main',
      catalogPath: 'catalog.json',
    });
    if (!parsed.success) {
      setError('请填写有效的 GitHub 仓库（owner/repository）和分支或标签。');
      return;
    }
    const operation = start('save');
    try {
      const saved = await request('/api/modes/source', parsed.data, 'PUT', operation);
      publish(saved, operation.ticket);
      if (!current(operation.ticket)) return;
      dirty.current = false;
      if (saved.config?.enabled)
        publish(await request('/api/modes/source/refresh', { force: true }, 'POST', operation), operation.ticket);
      if (current(operation.ticket)) setEditing(false);
    } catch (failure) {
      fail(operation, failure);
    } finally {
      finish(operation);
    }
  }
  useEffect(() => {
    mounted.current = true;
    const operation = start('load');
    void (async () => {
      try {
        const cached = await request('/api/modes/source', undefined, 'GET', operation);
        publish(cached, operation.ticket, true);
        if (!current(operation.ticket) || !cached.config?.enabled) return;
        setBusy('refresh');
        publish(await request('/api/modes/source/refresh', {}, 'POST', operation), operation.ticket);
      } catch (failure) {
        fail(operation, failure);
      } finally {
        finish(operation);
      }
    })();
    return () => {
      mounted.current = false;
      ticket.current++;
      active.current?.abort.abort();
      active.current = undefined;
    };
  }, [api]);
  const message = error || (view?.error && friendlyModError(view.error, 'source').text);
  const status = busy
    ? '正在更新…'
    : !view?.config
      ? '未连接'
      : !view.config.enabled
        ? '已停用'
        : view.status === 'error'
          ? '暂时无法更新'
          : `${view.catalog.length} 个 Mods`;
  return (
    <section
      ref={panel}
      className="store-source"
      aria-label="Mods 来源"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setEditing(false);
          panel.current?.querySelector<HTMLButtonElement>('[aria-expanded]')?.focus();
        }
      }}
    >
      <div className="store-source-heading">
        <button
          type="button"
          className="store-source-toggle"
          onClick={() => setEditing((value) => !value)}
          aria-expanded={editing}
          aria-label="设置来源"
        >
          <span role="status">来源：GitHub · {status}</span>
        </button>
      </div>
      {message && (
        <p className="store-source-error" role="status">
          {message}
        </p>
      )}
      {editing && (
        <div className="store-source-popover" role="dialog" aria-label="设置来源">
          <form className="store-source-form" onSubmit={(event) => void save(event)}>
            <label>
              <span>GitHub 仓库</span>
              <input
                required
                value={repository}
                placeholder="owner/repository"
                maxLength={200}
                onChange={(event) => {
                  dirty.current = true;
                  setRepository(event.target.value);
                }}
              />
            </label>
            <label>
              <span>分支或标签</span>
              <input
                required
                value={ref}
                placeholder="main"
                maxLength={200}
                onChange={(event) => {
                  dirty.current = true;
                  setRef(event.target.value);
                }}
              />
            </label>
            <label className="store-source-enabled">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) => {
                  dirty.current = true;
                  setEnabled(event.target.checked);
                }}
              />
              <span>启用此来源</span>
            </label>
            <button type="submit" className="button secondary" disabled={busy === 'save'}>
              保存并刷新
            </button>
            <button
              type="button"
              className="button quiet"
              disabled={!!busy || !view?.config?.enabled}
              onClick={() => void refresh()}
            >
              <RefreshCw size={14} aria-hidden="true" />
              刷新来源
            </button>
            <p>
              使用这台电脑现有的 GitHub 登录。私有仓库需要该账号的读取权限；此处不填写 Token，也不会上传对话或 API Key。
            </p>
          </form>
        </div>
      )}
    </section>
  );
}
