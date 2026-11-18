import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConversationMessage, RunRecord, Workflow } from '../src/shared/types.ts';
import { conversationTimeline } from '../src/ui/conversation-timeline.ts';

const stamp = Date.parse('2026-10-23T12:00:00Z');
const at = (second: number) => new Date(stamp + second * 1_000).toISOString();
const workflow = (id: string, patch: Partial<Workflow> = {}): Workflow => ({
  id,
  conversationId: 'chat',
  projectId: 'project',
  userMessageId: `user-${id}`,
  input: { content: 'Synthetic task', mode: 'chat', permissionMode: 'read-only', executionPolicy: 'cli-first' },
  status: 'running',
  phase: 'execute',
  plan: [],
  runIds: [`run-${id}`],
  memoryRevision: 0,
  memoryExcerpt: '',
  createdAt: at(0),
  updatedAt: at(20),
  ...patch,
});
const message = (
  id: string,
  workflowId: string,
  second: number,
  role: 'user' | 'assistant' = 'user',
): ConversationMessage => ({
  id,
  workflowId,
  conversationId: 'chat',
  role,
  content: `Synthetic ${id}`,
  createdAt: at(second),
});
const steer = (id: string, second: number, accepted: number): ConversationMessage => ({
  ...message(id, 'root', second),
  steering: { runId: 'run-root', status: 'accepted', acceptedAt: at(accepted) },
});
const run = (id: string, workflowId: string, endedAt?: string): RunRecord => ({
  id,
  workflowId,
  prompt: '',
  projectPath: '',
  kind: 'routine',
  status: 'completed',
  route: { runtimeId: 'fixture', model: 'fixture-model', kind: 'routine', reasons: [], warnings: [] },
  startedAt: at(0),
  endedAt,
  output: '',
  events: [],
});
const labels = (rows: ReturnType<typeof conversationTimeline>) =>
  rows.map((row) =>
    row.kind === 'message'
      ? row.message.id
      : row.kind === 'workflow'
        ? `trace:${row.workflow.id}`
        : row.kind === 'steering-stage'
          ? row.stage.id
          : row.id,
  );

test('long timelines parse timestamps in proportion to source size, not once per accepted correction', (t) => {
  const messages = [message('user-root', 'root', 0), message('user-child', 'child', 1)];
  for (let i = 2; i < 1_000; i++)
    messages.push(
      i % 10 === 9
        ? steer(`steer-${i}`, i, i + 0.5)
        : message(`message-${i}`, i % 3 === 0 ? 'child' : 'root', i, 'assistant'),
    );
  const root = workflow('root', { status: 'completed', finalMessageId: 'message-986' });
  const child = workflow('child', {
    status: 'completed',
    delegation: { parentId: 'root', role: 'worker', requestId: 'child' },
  });
  const parse = Date.parse;
  const observed = t.mock.method(Date, 'parse', parse);
  const rows = conversationTimeline(
    messages,
    [root, child],
    [run('run-root', 'root'), run('run-child', 'child', at(999))],
  );
  assert.equal(rows.filter((row) => row.kind === 'steering-stage').length, 100);
  assert.deepEqual(
    rows.filter((row) => row.kind === 'message').map((row) => row.message.id),
    messages.filter((item) => item.workflowId !== 'child').map((item) => item.id),
  );
  assert.ok(
    observed.mock.callCount() <= 4 * messages.length,
    `${observed.mock.callCount()} timestamp parses for ${messages.length} messages`,
  );
});

test('receipt ordering uses time and saved-order ties while child phases retain assignment and final run order', () => {
  const root = workflow('root');
  const child = workflow('child', {
    status: 'failed',
    runIds: ['failed', 'retry', 'not-loaded'],
    delegation: { parentId: 'root', role: 'worker', requestId: 'child' },
  });
  const messages = [
    message('user-root', 'root', 0),
    message('user-child', 'child', 1),
    steer('later-receipt', 2, 5),
    message('before-tie', 'child', 4, 'assistant'),
    steer('first-tie', 3, 4),
    message('between-ties', 'child', 4, 'assistant'),
    steer('second-tie', 3, 4),
    message('after-ties', 'child', 4, 'assistant'),
    message('out-of-order-main', 'root', 2, 'assistant'),
  ];
  const unchanged = structuredClone({ messages, root, child });
  const rows = conversationTimeline(
    messages,
    [root, child],
    [run('retry', 'child', at(4)), run('failed', 'child', at(8))],
  );
  assert.deepEqual(
    rows.filter((row) => row.kind === 'steering-stage').map((row) => [row.stage.messageId, row.stage.number]),
    [
      ['first-tie', 2],
      ['second-tie', 3],
      ['later-receipt', 4],
    ],
  );
  const groups = rows.filter((row) => row.kind === 'delegation-group');
  assert.deepEqual(
    groups.map((row) => [
      row.stage?.number ?? 1,
      row.children[0]!.messages.map((item) => item.id),
      row.children[0]!.historical,
    ]),
    [
      [1, ['user-child', 'before-tie'], true],
      [2, ['between-ties'], true],
      [3, ['after-ties'], false],
    ],
  );
  assert.ok(groups.every((row) => row.children[0]!.sequence === 1));
  assert.deepEqual({ messages, root, child }, unchanged);
});

test('run indexes retain first-match ownership and never attach foreign or failed steering', () => {
  const root = workflow('root');
  const other = workflow('other', { runIds: ['run-root'] });
  const foreign = workflow('foreign', { conversationId: 'elsewhere', runIds: ['run-root'] });
  const messages = [
    message('user-root', 'root', 0),
    steer('accepted', 1, 2),
    { ...steer('failed', 2, 3), steering: { runId: 'run-root', status: 'failed' as const } },
  ];
  const rows = conversationTimeline(
    messages,
    [foreign, other, root],
    [run('run-root', 'root'), run('run-root', 'other')],
  );
  assert.deepEqual(
    rows.filter((row) => row.kind === 'steering-stage').map((row) => row.stage.workflowId),
    ['root'],
  );
  assert.ok(labels(rows).includes('failed'));
  assert.equal(
    conversationTimeline(messages, [root], [run('run-root', 'foreign')]).some((row) => row.kind === 'steering-stage'),
    false,
  );
});
