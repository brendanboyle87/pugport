import assert from 'node:assert/strict';
import test from 'node:test';
import type { Workflow } from '../src/shared/types.ts';
import type { Confirmation } from '../src/shared/confirmation.ts';
import { leaveSwarm, runningSwarmMembers } from '../src/ui/swarm-switch.ts';

const at = '2026-10-10T12:00:00Z';
const task = (id: string, status: Workflow['status'], extra: Partial<Workflow> = {}): Workflow =>
  ({
    id,
    conversationId: 'chat',
    projectId: 'p',
    userMessageId: `${id}-m`,
    input: { content: id, mode: 'chat', permissionMode: 'read-only', executionPolicy: 'cli-first', swarm: true },
    status,
    phase: 'execute',
    plan: [],
    runIds: [],
    memoryRevision: 0,
    memoryExcerpt: '',
    createdAt: at,
    updatedAt: at,
    ...extra,
  }) as Workflow;
const workflows = [
  task('root', 'running'),
  task('member', 'running', { delegation: { parentId: 'root', requestId: 'a', role: 'worker' } }),
  task('done', 'completed'),
  task('normal', 'running', {
    input: { content: 'n', mode: 'chat', permissionMode: 'read-only', executionPolicy: 'cli-first' },
  }),
  task('elsewhere', 'running', { conversationId: 'other' }),
];

test('only swarm tasks still at work in this conversation count as running members', () => {
  assert.deepEqual(
    runningSwarmMembers(workflows, 'chat').map((item) => item.id),
    ['root', 'member'],
  );
});

test('leaving swarm mode asks once; stopping cancels the top task, which takes its members with it', async () => {
  const calls: string[] = [];
  const api = async <T>(path: string, body?: unknown, method = 'POST') => {
    calls.push(`${method} ${path} ${JSON.stringify(body)}`);
    return {} as T;
  };
  const asked: Confirmation[] = [];
  const stop = await leaveSwarm(api, 'chat', workflows, async (options) => {
    asked.push(options);
    return true;
  });
  assert.equal(asked.length, 1);
  assert.match(asked[0]!.summary!, /还有 2 个蜂群成员在跑/);
  assert.equal(asked[0]!.action, '停止成员并关闭');
  assert.match(asked[0]!.points![1]!, /仍会使用额度/);
  assert.deepEqual(calls, ['POST /api/workflows/root/cancel {}', 'PATCH /api/conversations/chat {"swarm":false}']);
  assert.match(stop, /2 个成员已停下/);

  calls.length = 0;
  const keep = await leaveSwarm(api, 'chat', workflows, () => false);
  assert.deepEqual(calls, ['PATCH /api/conversations/chat {"swarm":false}'], 'members keep working when kept');
  assert.match(keep, /还在跑的 2 个成员会继续做完/);

  calls.length = 0;
  let prompted = false;
  const quiet = await leaveSwarm(api, 'other-chat', workflows, () => (prompted = true));
  assert.equal(prompted, false, 'nothing running, nothing to ask');
  assert.equal(quiet, '已关闭蜂群模式。');
});
