import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { Loader2 } from 'lucide-react';
import type { LinkSessionView } from '../shared/mod-data';
import type { Api } from './Workspace';
import { PlaidKeyForm } from './PlaidKeyForm';

type Request = {
  id: number;
  session?: LinkSessionView;
  setup?: { api: Api; start: () => Promise<LinkSessionView> };
  /** Who asked, shown as written: a Mod title. */
  requester?: string;
  poll: (id: string) => Promise<LinkSessionView>;
  cancel: (id: string) => Promise<unknown>;
  finish: (result: LinkSessionView) => void;
};
let current: Request | undefined;
let sequence = 0;
const listeners = new Set<() => void>();
const cancelledMods = new Map<string, number>();
const changed = () => listeners.forEach((listener) => listener());
const store = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
  snapshot: () => current,
};

export const bankLinkOpen = () => !!current;
export const bankLinkAvailable = () => typeof document !== 'undefined' && listeners.size > 0;

/** The server checks the binding and permission before reporting missing keys. */
export async function requestBankLink(input: {
  api: Api;
  start: () => Promise<LinkSessionView>;
  requester?: string;
  modId?: string;
  canShow?: () => boolean;
}) {
  for (const [id, until] of cancelledMods) if (Date.now() >= until) cancelledMods.delete(id);
  const check = () => {
    if (!bankLinkAvailable() || input.canShow?.() === false)
      throw Object.assign(new Error('Bank dialog is unavailable.'), { code: 'E_UNAVAILABLE' });
    if (input.modId && (cancelledMods.get(input.modId) ?? 0) > Date.now())
      throw Object.assign(new Error('Please wait before requesting another bank dialog.'), { code: 'E_LIMIT' });
    if (bankLinkOpen()) throw Object.assign(new Error('A bank dialog is already open.'), { code: 'E_LIMIT' });
  };
  check();
  let session: LinkSessionView | undefined;
  try {
    session = await input.start();
  } catch (error) {
    if ((error as { code?: string })?.code !== 'E_NOT_CONFIGURED') throw error;
  }
  try {
    check();
  } catch (error) {
    if (session) await input.api(`/api/bank/link/${encodeURIComponent(session.id)}`, undefined, 'DELETE');
    throw error;
  }
  return {
    result: showBankLink({
      session,
      setup: session ? undefined : { api: input.api, start: input.start },
      requester: input.requester,
      poll: (id) => input.api<LinkSessionView>(`/api/bank/link/${encodeURIComponent(id)}`, undefined, 'GET'),
      cancel: (id) => input.api(`/api/bank/link/${encodeURIComponent(id)}`, undefined, 'DELETE'),
    }).then((result) => {
      if (input.modId && result.status === 'cancelled') cancelledMods.set(input.modId, Date.now() + 60000);
      return result;
    }),
  };
}
/** Only an https page on plaid.com may be opened from here. */
export function plaidLinkUrl(raw?: string) {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && /(^|\.)plaid\.com$/.test(url.hostname) && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Shows the Plaid Link step: the user opens Plaid's own page in the browser and signs in to the bank there.
 * Resolves with the finished session, or the cancelled one if the user closes this dialog first.
 */
export function showBankLink(input: Omit<Request, 'id' | 'finish'>): Promise<LinkSessionView> {
  current?.finish({ id: '', ...current.session, status: 'cancelled' });
  return new Promise((finish) => {
    const id = ++sequence;
    current = {
      ...input,
      id,
      finish: (result) => {
        if (current?.id === id) current = undefined;
        changed();
        finish(result);
      },
    };
    changed();
  });
}

export function BankLinkDialog() {
  const request = useSyncExternalStore(store.subscribe, store.snapshot, () => undefined);
  return request ? <LinkDialog key={request.id} request={request} /> : null;
}

function LinkDialog({ request }: { request: Request }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [session, setSession] = useState(request.session);
  const [saving, setSaving] = useState(false);
  const url = plaidLinkUrl(session?.url);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  useEffect(() => {
    if (!session) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stopped) return;
      try {
        const next = await request.poll(session.id);
        if (next.status !== 'waiting') return request.finish(next);
      } catch {
        // A short outage is retried; the session itself expires after 30 minutes.
      }
      timer = setTimeout(() => void tick(), 2000);
    };
    timer = setTimeout(() => void tick(), 2000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [request, session]);
  const cancel = () => {
    if (saving) return;
    if (session) void request.cancel(session.id).catch(() => undefined);
    request.finish({ id: '', ...session, status: 'cancelled' });
  };
  return (
    <dialog
      ref={ref}
      className="modal confirm-dialog bank-link-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        cancel();
      }}
    >
      <h2 id={titleId}>{session ? '连接银行' : '设置 Plaid'}</h2>
      {request.requester && (
        <p className="confirm-description">
          <span translate="no">{request.requester}</span> 想读取你授权的银行账户、余额和交易。
        </p>
      )}
      {!session && request.setup ? (
        <PlaidKeyForm
          api={request.setup.api}
          onBusy={setSaving}
          onSaved={async () => setSession(await request.setup!.start())}
        />
      ) : (
        <div className="confirm-description">
          <p>
            点「打开 Plaid」，在浏览器里选择你的银行并登录。银行密码只在 Plaid 和银行的页面输入，PugPort
            看不到也不保存。
          </p>
          <p className="bank-link-waiting" role="status">
            <Loader2 className="spinning" size={15} /> 正在等你在 Plaid 页面完成…
          </p>
        </div>
      )}
      <div className="modal-actions">
        <button type="button" className="button secondary" disabled={saving} onClick={cancel}>
          取消
        </button>
        {url ? (
          <a className="button primary" href={url} target="_blank" rel="noopener noreferrer">
            打开 Plaid
          </a>
        ) : session ? (
          <span role="alert">Plaid 没有返回可打开的页面，请重试。</span>
        ) : null}
      </div>
    </dialog>
  );
}
