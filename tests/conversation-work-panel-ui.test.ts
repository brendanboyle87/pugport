import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Conversation, Project } from '../src/shared/types.ts';
import { ConversationWorkPanel } from '../src/ui/ConversationWorkPanel.tsx';

const stamp = '2026-10-28T12:00:00Z';
const conversation: Conversation = {
  id: 'fixture-chat',
  projectId: 'fixture-project',
  title: 'Fixture chat',
  createdAt: stamp,
  updatedAt: stamp,
};

function render(scope: Project['scope']) {
  return renderToStaticMarkup(
    createElement(ConversationWorkPanel, {
      conversation,
      project: {
        id: conversation.projectId,
        name: 'Fixture project',
        path: 'C:/Fixture',
        scope,
        createdAt: stamp,
        updatedAt: stamp,
      },
      api: async () => {
        throw new Error('Static rendering must not issue a request');
      },
      reload: async () => {},
      notify() {},
      onConversation() {},
      onClose() {},
    }),
  );
}

test('plain chats explain everyday actions before collaboration and keep sections closed', () => {
  const html = render('chat');
  assert.deepEqual(
    [...html.matchAll(/<summary><span>(.*?)<\/span>/g)].map((match) => match[1]),
    ['安排提醒或循环工作', '给其他对话发消息', '子代理与工作线'],
  );
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.equal([...html.matchAll(/<summary>.*?class="quiet-text"/g)].length, 3);
  assert.match(html, /让 PugPort 在后台替你做事/);
  assert.match(html, /普通对话也启用子代理/);
  assert.match(html, />新建子代理<\/button>/);
  assert.doesNotMatch(html, /项目上下文|迁入 Claude|PR 监控|value="ci"/);
  assert.ok(html.indexOf('conversation-collaboration-opt-in') < html.indexOf('>新建子代理</button>'));
  assert.match(html, /界面创建的后台工作默认为只读。/);
});

test('project chats retain collaboration and PR scheduling with context under closed Advanced', () => {
  const html = render('project');
  assert.deepEqual(
    [...html.matchAll(/<summary><span>(.*?)<\/span>/g)].map((match) => match[1]),
    ['安排提醒或循环工作', '给其他对话发消息', '子代理与工作线', '高级'],
  );
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.match(html, />新建子代理<\/button>/);
  assert.match(html, /<option value="ci">PR 检查变化时提醒<\/option>/);
  assert.match(html, /<details><summary>项目上下文与固定远程查询<\/summary>/);
  assert.doesNotMatch(html, /迁入 Claude|选择 Claude 导出文件/);
});
