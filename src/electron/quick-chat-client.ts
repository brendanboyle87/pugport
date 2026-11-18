import { randomUUID } from 'node:crypto';
import { backendRequest, heldSessionToken } from './session-header.ts';

/** Uses the same authenticated conversation and message endpoints as the normal composer. */
export function createQuickChatClient(origin: string, request: typeof fetch = (...args) => fetch(...args)) {
  const api = async <T>(path: string, body: unknown): Promise<T> => {
    // Without a token the backend is starting or recovering; its 403 text would point at the wrong fix.
    if (!heldSessionToken()) throw new Error('本地后台不可用，请稍后重试。');
    const response = await backendRequest(
      origin + path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      },
      request,
    );
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '发送失败，输入已保留，请重试。');
    return result as T;
  };
  // Preserve the destination and key on retry; the server deduplicates sends for five minutes.
  let created: string | undefined;
  let retry: { id: string; text: string; clientMessageId: string } | undefined;
  const conversation = async (id?: string) =>
    id ?? (created ??= (await api<{ id: string }>('/api/conversations', {})).id);
  return {
    conversation,
    async send(text: string, id?: string) {
      const destination = await conversation(id);
      if (!retry || retry.id !== destination || retry.text !== text)
        retry = { id: destination, text, clientMessageId: randomUUID() };
      const result = await api<{ notice?: string; message?: { steering?: { status: string; error?: string } } }>(
        `/api/conversations/${encodeURIComponent(destination)}/messages`,
        { content: text, mode: 'chat', clientMessageId: retry.clientMessageId },
      );
      if (result.message?.steering?.status === 'failed')
        throw new Error(result.message.steering.error || '发送失败，输入已保留，请重试。');
      created = undefined;
      retry = undefined;
      return destination;
    },
  };
}
