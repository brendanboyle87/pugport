import type { ConversationMessage } from '../../shared/types.ts';
import { resumedMessage } from '../../shared/task-request.ts';
import { grokBotHandoffNote } from '../../shared/external-agents.ts';

/** History is background only; never change the saved request or include execution evidence. */
export function packExternalContext(messages: ConversationMessage[], currentId: string, request: string): string {
  const end = messages.findIndex((message) => message.id === currentId);
  if (end < 0) return request;
  const earlier = messages.slice(0, end);
  // The send record is an assistant bubble immediately after the current user request.
  if (earlier.at(-1)?.role === 'user') earlier.pop();
  const turns = earlier.flatMap((raw) => {
    const message = resumedMessage(raw);
    if (message.replacedBy || message.systemNotice || ('deletedAt' in message && message.deletedAt)) return [];
    if (message.externalAgent && message.externalAgent.status !== 'done') return [];
    const text = message.content.trim();
    if (
      !text ||
      text === grokBotHandoffNote ||
      /^(?:排队中…|正在等 .*回复…|.*这次没有回复。|已交给 .*排队中…)$/.test(text)
    )
      return [];
    const clipped = text.length > 1500 ? text.slice(0, 1493) + '…（已截断）' : text;
    return [`${message.role === 'user' ? '用户' : message.externalAgent?.name || '助手'}：${clipped}`];
  });
  const kept: string[] = [];
  let size = 0;
  for (const turn of [...turns].reverse()) {
    if (size + turn.length + 1 > 7900) break;
    kept.unshift(turn);
    size += turn.length + 1;
  }
  if (!kept.length) return request;
  return `下面是这段对话前面的内容，只作背景：\n${kept.length < turns.length ? '（更早的内容已省略）\n' : ''}${kept.join('\n')}\n\n这次的消息：\n${request}`;
}
