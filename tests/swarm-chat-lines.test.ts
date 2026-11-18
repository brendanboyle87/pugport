import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppState, ConversationMessage } from '../src/shared/types.ts';
import { ConversationHistory } from '../src/ui/Workspace.tsx';

const message = (
  id: string,
  role: ConversationMessage['role'],
  content: string,
  minute: number,
): ConversationMessage => ({
  id,
  conversationId: 'chat',
  role,
  content,
  createdAt: `2026-10-10T12:0${minute}:00.000Z`,
});
const state = { runs: [], workflows: [], targets: [], runtimes: [], settings: {} } as unknown as AppState;

test('member-to-member messages sit between the conversation messages in the order they happened', () => {
  const html = renderToStaticMarkup(
    createElement(ConversationHistory, {
      messages: [message('ask', 'user', 'FIRST_USER_MESSAGE', 1), message('reply', 'assistant', 'LAST_REPLY', 5)],
      workflows: [],
      state,
      api: async <T>() => ({}) as T,
      notify() {},
      onInspect() {},
      peerLines: [
        { id: 'late', at: '2026-10-10T12:04:00.000Z', from: '测试审查', to: '后端审查', text: 'SECOND_PEER' },
        { id: 'early', at: '2026-10-10T12:02:00.000Z', from: '后端审查', to: '测试审查', text: 'FIRST_PEER' },
      ],
    }),
  );
  // The collapsed thread previews its last turn; compare the expanded transcript, not that preview.
  const order = ['FIRST_USER_MESSAGE', 'FIRST_PEER', 'SECOND_PEER', 'LAST_REPLY'].map((text) => html.lastIndexOf(text));
  assert.ok(
    order.every((index) => index >= 0),
    order.join(),
  );
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
  );
  assert.equal((html.match(/class="exchange-turn"/g) ?? []).length, 2);
});

test('without a swarm the conversation renders exactly as before', () => {
  const html = renderToStaticMarkup(
    createElement(ConversationHistory, {
      messages: [message('ask', 'user', 'ONLY', 1)],
      workflows: [],
      state,
      api: async <T>() => ({}) as T,
      notify() {},
      onInspect() {},
    }),
  );
  assert.doesNotMatch(html, /swarm-chat-line/);
});
