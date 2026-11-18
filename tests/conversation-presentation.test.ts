import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activityArgument,
  activityCategory,
  activitySummary,
  presentationPreview,
} from '../src/shared/activity-vocabulary.ts';
import {
  buildConversationPresentation,
  ConversationPresentationCache,
} from '../src/server/conversation-presentation.ts';
import { Store } from '../src/server/store.ts';
import type { RunEvent, RunRecord, Workflow } from '../src/shared/types.ts';

const at = (n: number) => new Date(1700000000000 + n * 1000).toISOString();
const run = (events: RunEvent[], patch: Partial<RunRecord> = {}): RunRecord => ({
  id: 'r',
  prompt: 'Synthetic task',
  projectPath: 'C:/fixture',
  kind: 'general',
  status: 'running',
  route: { runtimeId: 'executor-a', model: 'model', kind: 'general', reasons: [], warnings: [] },
  startedAt: at(0),
  output: '',
  events,
  ...patch,
});
const workflow = (patch: Partial<Workflow> = {}): Workflow => ({
  id: 'w',
  conversationId: 'c',
  projectId: 'p',
  userMessageId: 'm',
  input: { content: 'Synthetic task', mode: 'chat', permissionMode: 'read-only', executionPolicy: 'cli-first' },
  status: 'running',
  phase: 'execute',
  plan: [],
  runIds: ['r'],
  memoryRevision: 0,
  memoryExcerpt: '',
  createdAt: at(0),
  updatedAt: at(0),
  ...patch,
});
const tool = (id: string, name: string, n: number, data: Record<string, unknown> = {}): RunEvent => ({
  type: 'tool',
  seq: n,
  at: at(n),
  data: { toolCallId: id, tool: name, status: 'running', ...data },
});
const text = (value: string, n: number): RunEvent => ({ type: 'text', seq: n, at: at(n), text: value });

test('native aliases, namespaced bridge tools and ACP kinds map deterministically', () => {
  for (const [name, category] of [
    ['Read', 'read'],
    ['Grep', 'search'],
    ['Glob', 'search'],
    ['Write', 'write'],
    ['Edit', 'edit'],
    ['Bash', 'command'],
    ['TodoWrite', 'plan'],
    ['AskUserQuestion', 'question'],
    ['Agent', 'member'],
    ['read', 'read'],
    ['find', 'search'],
    ['ls', 'search'],
    ['powershell', 'command'],
    ['commandExecution', 'command'],
    ['fileChange', 'edit'],
    ['webSearch', 'webSearch'],
    ['imageView', 'image'],
    ['collabAgentToolCall', 'member'],
    ['update_plan', 'plan'],
  ])
    assert.equal(activityCategory(name), category, name);
  assert.equal(activityCategory('functions.exec_command'), 'command');
  assert.equal(activityCategory('mcp__pugport__ask_user'), 'question');
  assert.equal(activityCategory('mcp__pugport__memory_lookup'), 'pugport');
  assert.equal(activityCategory('Read source', 'read'), 'read');
  assert.equal(activityCategory('commandExecution: started', 'commandExecution'), 'command');
  assert.equal(activityCategory('unknown', 'unknown'), 'other');
});
test('summaries dedupe identities, sort by count then appearance, and join two/three/more categories', () => {
  const a = { key: '1', category: 'read' as const },
    b = { key: '2', category: 'search' as const };
  assert.equal(activitySummary([a, b, a]), '已读取文件并搜索代码');
  assert.equal(activitySummary([a, b, { ...b, key: '3' }]), '已搜索代码并读取文件');
  const three = [a, b, { key: '3', category: 'edit' as const }];
  assert.equal(activitySummary(three), '已读取文件，已搜索代码，修改了文件');
  assert.equal(activitySummary([...three, { key: '4', category: 'write' }]), '已读取文件，已搜索代码，修改了文件等');
  assert.equal(activitySummary([a, b], 'en'), 'Read files and Searched code');
  assert.equal(
    activitySummary([...three, { key: '4', category: 'write' }], 'en'),
    'Read files, Searched code, Edited files, and more',
  );
  assert.equal(activitySummary([]), '已完成分析');
});
test('live detail prioritizes useful fields, normalizes whitespace, redacts and caps whole graphemes', () => {
  assert.equal(activityArgument({ title: '  Useful\n title ', command: 'ignored' }), 'Useful title');
  assert.equal(activityArgument({ title: ' ', description: 'description', objective: 'objective' }), 'description');
  assert.equal(activityArgument({ objective: 'objective', command: 'cmd' }), 'objective');
  assert.equal(activityArgument({ command: 'cmd', query: 'query', path: 'path' }), 'cmd');
  assert.equal(activityArgument({ query: 'query', path: 'path' }), 'query');
  assert.equal(activityArgument({ path: 'file' }), 'file');
  const family = '👨‍👩‍👧‍👦';
  assert.equal(presentationPreview(family.repeat(170)), family.repeat(160));
  assert.equal(presentationPreview('e\u0301'.repeat(170)), 'e\u0301'.repeat(160));
  assert.ok(!activityArgument({ command: 'password=secret-value' }).includes('secret-value'));
});
test('projection interleaves narration, reasoning and reconciled tool groups; detail is lazy', () => {
  const record = run(
    [
      text('First', 1),
      tool('same', 'Read', 2),
      tool('bridge', 'Read', 3, { source: 'pugport', nativeToolCallId: 'same', arguments: { path: 'source.ts' } }),
      tool('same', 'Read', 4, { source: 'pugport' }),
      { type: 'reasoning', seq: 5, at: at(5), text: '**Reason**\nSecond line' },
      tool('edit', 'Edit', 6),
      text('Answer', 7),
    ],
    { status: 'completed' },
  );
  const compact = buildConversationPresentation(workflow({ status: 'completed' }), [record]);
  assert.deepEqual(
    compact.items.map((item) => item.kind),
    ['narration', 'activity-group', 'reasoning', 'activity-group', 'final-answer'],
  );
  assert.equal(compact.items[1].calls?.length, 2);
  assert.equal(compact.items[2].preview, 'Reason');
  assert.ok(
    compact.items.every(
      (item) => !item.tools && (item.kind === 'narration' || item.kind === 'final-answer' || !item.text),
    ),
  );
  const detailed = buildConversationPresentation(workflow({ status: 'completed' }), [record], [], true);
  assert.equal(detailed.items[1].tools?.length, 2);
  assert.equal(detailed.items.at(-1)?.text, 'Answer');
});
test('latest running call wins, settled calls do not win, and live changes hold 150ms', () => {
  const cache = new ConversationPresentationCache();
  const a = run([tool('a', 'Read', 1, { arguments: { path: 'a' } })]);
  const b = run([
    ...a.events,
    tool('b', 'Edit', 2, { arguments: { path: 'b' } }),
    tool('c', 'Write', 3, { status: 'completed' }),
  ]);
  assert.equal(cache.get(workflow(), 'a', () => [a], [], 1000).items[0].live?.detail, 'a');
  assert.equal(cache.get(workflow(), 'b', () => [b], [], 1100).items[0].live?.detail, 'a');
  assert.equal(cache.get(workflow(), 'b', () => [b], [], 1150).items[0].live?.detail, 'b');
  cache.get(workflow(), 'b', () => [b], [], 1400);
  cache.get(
    workflow(),
    'b',
    () => {
      throw new Error('cache miss');
    },
    [],
    1500,
  );
});
test('handoffs, actual member states, ask_user and blocked outcomes survive projection', () => {
  const record = run([], {
    relay: { fromRunId: 'old', fromRuntimeId: 'executor-old', reason: 'quota' },
    taskOutcome: { status: 'blocked', source: 'executor-tool', question: { text: 'Choose?', options: ['A', 'B'] } },
  });
  const child = workflow({ id: 'child', parentWorkflowId: 'w', status: 'failed' });
  const items = buildConversationPresentation(workflow(), [record], [child]).items;
  assert.equal(items[0].kind, 'handoff');
  assert.equal(items[0].reason, 'quota');
  assert.equal(items[1].kind, 'question');
  assert.deepEqual(items[1].options, ['A', 'B']);
  assert.equal(items[2].status, 'failed');
  assert.equal(items[2].target, 'child');
  const questions = buildConversationPresentation(
    workflow({ userQuestion: { text: 'Current?', options: [], askedAt: at(1) } }),
    [record],
  ).items.filter((item) => item.kind === 'question');
  assert.equal(questions.length, 1);
  assert.equal(questions[0].status, 'waiting');
});
test('stored audit rebuilds the same projection after restart, including calls outside the retained window', () => {
  const directory = mkdtempSync(join(tmpdir(), 'presentation-'));
  let store = new Store(directory);
  const record = run([text('Answer', 3)], { status: 'completed' });
  store.appendRunAuditEvent('r', tool('old', 'Read', 1, { status: 'completed' }));
  store.saveRun(record);
  const before = buildConversationPresentation(workflow(), [store.run('r')!]);
  store.close();
  store = new Store(directory);
  try {
    assert.deepEqual(buildConversationPresentation(workflow(), [store.run('r')!]), before);
    assert.equal(before.items[0].calls?.length, 1);
  } finally {
    store.close();
  }
});

test('fallback output follows tools and idle reasoning uses its latest paragraph', () => {
  const completed = run([tool('a', 'Read', 1, { status: 'completed' })], {
    status: 'completed',
    output: 'Final output',
  });
  const items = buildConversationPresentation(workflow({ status: 'completed' }), [completed]).items;
  assert.deepEqual(
    items.map((item) => item.kind),
    ['activity-group', 'final-answer'],
  );
  const reasoning = buildConversationPresentation(workflow(), [
    run([], { reasoning: 'First paragraph\n\nLatest paragraph\nBody' }),
  ]);
  assert.equal(reasoning.items[0].live?.category, 'thinking');
  assert.equal(reasoning.items[0].live?.detail, 'Latest paragraph');
});

test('string arguments and split streamed secrets use sanitized detail', () => {
  const record = run([
    tool('a', 'exec_command', 1, { arguments: JSON.stringify({ description: 'Useful title', command: 'ignored' }) }),
    text('password=', 2),
    text('private-value', 3),
  ]);
  const projection = buildConversationPresentation(workflow(), [record], [], true);
  assert.equal(projection.items[0].live?.detail, 'Useful title');
  assert.ok(!JSON.stringify(projection).includes('private-value'));
});

test('linked extension calls retain their bridge category and shared call identity', () => {
  const record = run([
    tool('native', 'memory_lookup', 1),
    tool('bridge', 'memory_lookup', 2, { source: 'pugport', nativeToolCallId: 'native' }),
  ]);
  const calls = buildConversationPresentation(workflow(), [record]).items[0].calls;
  assert.equal(calls?.length, 1);
  assert.equal(calls?.[0].category, 'pugport');
});

test('large retained output produces a bounded projection without stalling redaction', () => {
  const record = run([], {
    status: 'completed',
    output: 'FILE: /synthetic/result.txt\n' + 'x'.repeat(1_100_000) + '\npassword=hidden-value',
  });
  const projection = buildConversationPresentation(workflow({ status: 'completed' }), [record]);
  assert.ok(projection.items[0].preview!.length <= 160);
  assert.ok(!JSON.stringify(projection).includes('hidden-value'));
  assert.ok(
    buildConversationPresentation(workflow(), [run([], { output: 'token.'.repeat(200_000) })]).items[0].preview!
      .length <= 160,
  );
  const longKey = run([], { output: 'prefix.'.repeat(500) + 'password=long-key-secret' });
  assert.ok(
    !JSON.stringify(buildConversationPresentation(workflow(), [longKey], [], true)).includes('long-key-secret'),
  );
});

test('task snapshots use the latest native report and preserve an explicit empty list', () => {
  const events: RunEvent[] = [
    { at: at(1), type: 'status', data: { taskList: [{ step: 'Read', status: 'in_progress' }] } },
    { at: at(2), type: 'status', data: { taskList: [{ content: 'Verify', status: 'completed' }] } },
  ];
  assert.deepEqual(buildConversationPresentation(workflow(), [run(events)]).tasks, [
    { title: 'Verify', status: 'completed' },
  ]);
  events.push({ at: at(3), type: 'status', data: { taskList: [] } });
  assert.deepEqual(buildConversationPresentation(workflow(), [run(events)]).tasks, []);
  assert.equal(buildConversationPresentation(workflow(), [run([])]).tasks, undefined);
});

test('compact narration preserves full Markdown and output-only replies', () => {
  const body = '## 内容概要\n\n- Shopify uses agents.\n- Keep the whole reply.\n\n'.repeat(120);
  for (const record of [run([text(body, 1)]), run([], { output: body })]) {
    const compact = buildConversationPresentation(workflow(), [record]);
    assert.equal(compact.items[0].text, body);
    assert.equal(compact.items[0].text, buildConversationPresentation(workflow(), [record], [], true).items[0].text);
  }
  const compact = buildConversationPresentation(workflow(), [
    run([{ type: 'reasoning', at: at(1), text: '**Thinking**\nHidden details' }]),
  ]);
  assert.equal(compact.items[0].text, undefined);
  assert.equal(compact.items[0].preview, 'Thinking');
});
