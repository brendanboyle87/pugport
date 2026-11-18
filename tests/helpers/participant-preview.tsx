// Synthetic browser review only. No API calls, credentials or application data.
import { createRoot } from 'react-dom/client';
import { ConversationHistory } from '../../src/ui/Workspace';
import { grokBotHandoffNote } from '../../src/shared/external-agents';
import type { AppState, ConversationMessage } from '../../src/shared/types';

const stamp = '2026-10-13T04:05:00Z';
const message = (
  id: string,
  content: string,
  externalAgent?: ConversationMessage['externalAgent'],
): ConversationMessage => ({
  id,
  content,
  conversationId: 'preview',
  role: 'assistant',
  createdAt: stamp,
  externalAgent,
});
const external = (agentId: 'muse' | 'grok-bot', name: string): NonNullable<ConversationMessage['externalAgent']> => ({
  agentId,
  name,
  status: 'done',
  request: 'Synthetic question',
  updatedAt: stamp,
});
const messages: ConversationMessage[] = [
  { ...message('user', '@@Muse 最近还有什么消息吗'), role: 'user' },
  message(
    'muse',
    '## 今天的进展\n\n已整理好本地示例。\n\n- 捕获主对话中的新回复\n- 保留列表、代码和表格\n- 等待你确认下一步',
    { ...external('muse', 'Muse'), untrusted: true },
  ),
  message('handoff', grokBotHandoffNote, external('grok-bot', 'Grok Bot')),
  message(
    'long',
    Array.from({ length: 18 }, (_, i) => `${i + 1}. 这是第 ${i + 1} 条合成内容，用于验证长回复可以展开和收起。`).join(
      '\n',
    ),
    { ...external('muse', 'Muse'), untrusted: true },
  ),
];
createRoot(document.getElementById('root')!).render(
  <ConversationHistory
    messages={messages}
    workflows={[]}
    state={{ runs: [], targets: [], settings: {} } as unknown as AppState}
    api={async <T,>() => ({}) as T}
    notify={() => {}}
    onInspect={() => {}}
    onQuoteMessage={() => {}}
    peerLines={Array.from({ length: 4 }, (_, i) => ({
      id: `turn-${i}`,
      at: stamp,
      from: i % 2 ? 'Muse' : 'Grok Bot',
      to: i % 2 ? 'Grok Bot' : 'Muse',
      text: i === 3 ? '已检查完毕，可以继续。' : `这是第 ${i + 1} 轮合成对话。`,
    }))}
  />,
);
