import type { WebAgentRequest, WebAgentResult } from '../../shared/web-bridge.ts';

/*
 * The backend's side of the web bridge: the desktop app owns the browser windows (src/electron/web-bridge.ts) and
 * answers over the IPC channel it forked this process with. Without the desktop app (a plain dev server, tests)
 * there is no browser, and web agents show as unavailable.
 */

export type WebBridge = {
  available(): boolean;
  request(request: WebAgentRequest, timeoutMs: number): Promise<WebAgentResult>;
};

const pending = new Map<number, { resolve: (result: WebAgentResult) => void; timer: NodeJS.Timeout }>();
let sequence = 0;

/** Called by main.ts for every message from the desktop app; true when it was a web agent result. */
export function handleWebAgentReply(message: unknown): boolean {
  const reply = message as { type?: string; requestId?: number; result?: WebAgentResult };
  if (reply?.type !== 'web-agent-result' || typeof reply.requestId !== 'number') return false;
  const waiting = pending.get(reply.requestId);
  if (!waiting) return true;
  pending.delete(reply.requestId);
  clearTimeout(waiting.timer);
  waiting.resolve(
    reply.result && typeof reply.result.ok === 'boolean'
      ? reply.result
      : { ok: false, code: 'error', message: '桌面版没有给出结果。' },
  );
  return true;
}

export const desktopWebBridge: WebBridge = {
  // The desktop app says so when it forks the backend with a web bridge attached.
  available: () => process.env.PUGPORT_WEB_BRIDGE === '1' && typeof process.send === 'function' && process.connected,
  request(request, timeoutMs) {
    if (!desktopWebBridge.available())
      return Promise.resolve({ ok: false, code: 'unavailable', message: '网页智能体只能在 PugPort 桌面版里使用。' });
    const requestId = ++sequence;
    return new Promise<WebAgentResult>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        if (request.action === 'send' && desktopWebBridge.available()) {
          try {
            process.send!({
              type: 'web-agent',
              requestId: ++sequence,
              request: { action: 'cancel', agentId: request.agentId, name: request.name, url: request.url },
            });
          } catch {
            /* Ignore if the desktop bridge already closed. */
          }
        }
        resolve({ ok: false, code: 'timeout', message: '桌面版没有及时回应，请稍后重试。' });
      }, timeoutMs);
      pending.set(requestId, { resolve, timer });
      try {
        process.send!({ type: 'web-agent', requestId, request });
      } catch {
        pending.delete(requestId);
        clearTimeout(timer);
        resolve({ ok: false, code: 'unavailable', message: '无法联系桌面版，请重启 PugPort 后再试。' });
      }
    });
  },
};
