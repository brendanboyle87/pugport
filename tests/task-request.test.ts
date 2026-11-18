import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTaskRequest, resumedMessage } from '../src/shared/task-request.ts';
import { continuationPrompt } from '../src/server/task-request.ts';
import type { ConversationMessage } from '../src/shared/types.ts';

test('legacy nested task and swarm wrappers recover supplements in order, without executor instructions', () => {
  const inner = '继续原任务：Original\n\n当前补充（优先）：\n别动 config\n\n已有步骤状态：\nfailed\n不得直接重放。';
  const outer = continuationPrompt({ originalRequest: inner, supplements: ['再查一下 Mooncake'] }, 'step: failed');
  const swarm = `继续同一蜂群任务：\n${outer}\n\n先检查已完成的产物和操作记录，只在原授权范围内处理本 agent 邮箱中的新协作信息。`;
  assert.deepEqual(parseTaskRequest(swarm), {
    originalRequest: 'Original',
    supplements: ['别动 config', '再查一下 Mooncake'],
  });
  const message: ConversationMessage = {
    id: 'm',
    conversationId: 'c',
    role: 'user',
    content: swarm,
    createdAt: '2026-10-31',
  };
  assert.equal(resumedMessage(message).content, '别动 config\n\n再查一下 Mooncake');
  assert.equal(message.content, swarm, 'saved history is not mutated');
  const assistant = { ...message, role: 'assistant' as const };
  assert.equal(resumedMessage(assistant), assistant);
});

test('empty supplements and steering successor instructions are not user words', () => {
  assert.deepEqual(parseTaskRequest(continuationPrompt({ originalRequest: 'Original', supplements: [] }, 'failed')), {
    originalRequest: 'Original',
    supplements: [],
  });
  assert.deepEqual(
    parseTaskRequest(
      '继续同一任务。原始需求：\nOriginal\n\n当前补充（当前权限与撤销要求优先）：\nOnly this\n\n先核对已有产物和工具记录，只完成仍授权的剩余工作。',
    ),
    {
      originalRequest: 'Original',
      supplements: ['Only this'],
    },
  );
});

test('resumed user text does not expose old rerun notice details', () => {
  const message: ConversationMessage = {
    id: 'resume',
    conversationId: 'c',
    role: 'user',
    createdAt: '2026-10-31',
    resumed: true,
    content: 'Only the supplement',
    systemNotice: { text: '已授权写入，正在重跑同一请求。', details: '已有步骤状态：host instructions' },
  };
  const shown = resumedMessage(message);
  assert.equal(shown.content, 'Only the supplement');
  assert.equal(shown.systemNotice, undefined);
  assert.ok(message.systemNotice, 'persisted notice evidence stays intact');
});
