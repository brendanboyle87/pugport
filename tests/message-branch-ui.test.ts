import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConversationHistory } from '../src/ui/Workspace.tsx';
import { SentMessageEditor } from '../src/ui/MessageBranchActions.tsx';
import type { AppState, ConversationMessage, Workflow } from '../src/shared/types.ts';

const messages: ConversationMessage[] = ['user', 'assistant', 'user'].map((role, index) => ({
  id: `message-${index}`,
  conversationId: 'conversation',
  role: role as 'user' | 'assistant',
  content: `Fixture ${index}`,
  createdAt: `2026-10-13T12:00:0${index}.000Z`,
}));
const api = async <T>() => ({}) as T;
const notify = () => {};
const onConversation = () => {};
function render(workflows: Workflow[] = []) {
  return renderToStaticMarkup(
    createElement(ConversationHistory, {
      messages,
      workflows,
      state: { workflows, runs: [], targets: [], settings: {} } as unknown as AppState,
      api,
      notify,
      onConversation,
      onInspect() {},
    }),
  );
}

test('history forks from answers, copies every message, edits users and resends only the latest user', () => {
  const html = render();
  assert.equal((html.match(/aria-label="从这里分叉"/g) ?? []).length, 1);
  assert.equal((html.match(/aria-label="复制消息"/g) ?? []).length, 2);
  assert.equal((html.match(/aria-label="复制回复"/g) ?? []).length, 1);
  assert.equal((html.match(/aria-label="编辑"/g) ?? []).length, 2);
  assert.equal((html.match(/aria-label="重新发送"/g) ?? []).length, 1);
  assert.match(html, /title="重新发送" aria-label="重新发送"/);
});

test('user and assistant actions follow the entire message body in DOM and keyboard order', () => {
  const articles = [...render().matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/g)];
  assert.equal(articles.length, messages.length);
  for (const [index, article] of articles.entries()) {
    const html = article[1]!;
    assert.ok(html.indexOf('class="message-actions"') > html.indexOf(`Fixture ${index}`));
    assert.match(html, /class="message-actions">[\s\S]*<\/div>$/);
    assert.doesNotMatch(html.split('class="message-text')[0]!, /class="message-actions"/);
  }
});

test('resend has a short disabled reason while a task is running', () => {
  const html = render([
    {
      id: 'workflow',
      conversationId: 'conversation',
      userMessageId: 'message-2',
      status: 'running',
      phase: 'execute',
      input: { content: 'Fixture' },
      runIds: [],
      plan: [],
    } as unknown as Workflow,
  ]);
  assert.match(html, /title="任务正在运行，请结束后重新发送。" aria-label="重新发送" disabled=""/);
});

test('inline editor renders existing text, cancel, send and branch explanation', () => {
  const html = renderToStaticMarkup(
    createElement(SentMessageEditor, { message: messages[0], api, notify, onConversation, onCancel() {} }),
  );
  assert.match(html, /<textarea[^>]+aria-label="编辑已发送的消息"[^>]*>Fixture 0<\/textarea>/);
  assert.match(html, /发送后将在新分支中继续/);
  assert.match(html, /type="button"[^>]*>取消/);
  assert.match(html, /type="submit"[^>]*>发送/);
});

test('external user requests have fork actions but no edit or resend actions', () => {
  messages[2].externalRequest = { agentId: 'muse' };
  try {
    const html = render();
    assert.equal((html.match(/aria-label="编辑"/g) ?? []).length, 1);
    assert.equal((html.match(/aria-label="重新发送"/g) ?? []).length, 0);
  } finally {
    delete messages[2].externalRequest;
  }
});
