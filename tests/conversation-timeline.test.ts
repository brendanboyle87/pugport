import { ConversationTurn } from '../src/ui/ConversationTurn.tsx';
import { reasoningPreview } from '../src/shared/reasoning-preview.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DOMParser } from '@xmldom/xmldom';
import type { AppState, ConversationMessage, RunRecord, Workflow } from '../src/shared/types.ts';
import { conversationTimeline } from '../src/ui/conversation-timeline.ts';
import { ConversationHistory, WorkflowTrace } from '../src/ui/Workspace.tsx';
import { DelegationProgress, delegationProgress } from '../src/ui/DelegationProgress.tsx';
import { failureNotice, systemNoticeText } from '../src/shared/system-notices.ts';
import { findNode, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const stamp = '2026-10-01T12:00:00.000Z';
const message = (id: string, workflowId?: string, role: 'user' | 'assistant' = 'user'): ConversationMessage => ({
  id,
  conversationId: 'conversation',
  workflowId,
  role,
  content: `Fixture ${id}`,
  createdAt: stamp,
});
const workflow = (id: string, patch: Partial<Workflow> = {}): Workflow => ({
  id,
  conversationId: 'conversation',
  projectId: 'project',
  userMessageId: `user-${id}`,
  input: { content: `Fixture ${id}`, mode: 'build', permissionMode: 'read-only', executionPolicy: 'cli-first' },
  status: 'running',
  phase: 'execute',
  plan: [],
  runIds: [],
  memoryRevision: 0,
  memoryExcerpt: '',
  createdAt: stamp,
  updatedAt: stamp,
  ...patch,
});
const ids = (messages: ConversationMessage[], workflows: Workflow[]) =>
  conversationTimeline(messages, workflows).map((row) =>
    row.kind === 'message'
      ? row.message.id
      : row.kind === 'workflow'
        ? `trace-${row.workflow.id}`
        : row.kind === 'steering-stage'
          ? row.stage.id
          : `group-${row.id}`,
  );

const at = (second: number) => new Date(Date.parse(stamp) + second * 1_000).toISOString();
const timedMessage = (id: string, task: string, second: number, role: 'user' | 'assistant' = 'user') => ({
  ...message(id, task, role),
  createdAt: at(second),
});
const run = (id: string, workflowId: string, patch: Partial<RunRecord> = {}): RunRecord => ({
  id,
  workflowId,
  prompt: 'Synthetic request',
  projectPath: '',
  kind: 'routine',
  status: 'running',
  route: { runtimeId: 'grok', model: 'grok-4.7', effort: 'high', kind: 'routine', reasons: [], warnings: [] },
  startedAt: stamp,
  output: '',
  events: [],
  ...patch,
});
const labels = (rows: ReturnType<typeof conversationTimeline>) =>
  rows.map((row) =>
    row.kind === 'message'
      ? row.message.id
      : row.kind === 'workflow'
        ? `trace-${row.workflow.id}`
        : row.kind === 'steering-stage'
          ? row.stage.id
          : `group-${row.id}`,
  );

test('a confirmed correction anchors later child activity while preserving saved main messages and assignment numbers', () => {
  const parent = workflow('parent', { runIds: ['run-parent'] });
  const alpha = workflow('alpha', {
    createdAt: at(1),
    runIds: ['run-alpha'],
    delegation: { parentId: 'parent', role: 'scout', requestId: 'alpha' },
  });
  const beta = workflow('beta', {
    createdAt: at(2),
    status: 'completed',
    delegation: { parentId: 'parent', role: 'reviewer', requestId: 'beta' },
  });
  const messages = [
    timedMessage('user-parent', 'parent', 0),
    timedMessage('user-alpha', 'alpha', 1),
    timedMessage('user-beta', 'beta', 2),
    timedMessage('reply-beta', 'beta', 3, 'assistant'),
    {
      ...timedMessage('correction', 'parent', 4),
      steering: { runId: 'run-parent', status: 'accepted' as const, acceptedAt: at(5) },
    },
  ];
  const first = conversationTimeline(messages, [beta, parent, alpha]);
  assert.deepEqual(labels(first), [
    'user-parent',
    'group-conversation:parent:stage:0',
    'correction',
    'steer:correction',
    'group-conversation:parent:stage:1',
    'trace-parent',
  ]);
  const historical = first.find((row) => row.kind === 'delegation-group' && row.id.endsWith(':0'))!;
  assert.equal(historical.kind, 'delegation-group');
  if (historical.kind !== 'delegation-group') throw new Error('Missing earlier child activity');
  assert.deepEqual(
    historical.children.map((child) => [child.workflow.id, child.sequence, child.historical]),
    [
      ['alpha', 1, true],
      ['beta', 2, false],
    ],
  );
  alpha.status = 'completed';
  messages.push(timedMessage('reply-alpha', 'alpha', 6, 'assistant'));
  const completed = conversationTimeline(messages, [alpha, beta, parent]);
  assert.deepEqual(labels(completed), labels(first), 'late completion stays in the same stage');
  const current = completed.find((row) => row.kind === 'delegation-group' && row.id.endsWith(':1'))!;
  if (current.kind !== 'delegation-group') throw new Error('Missing latest child stage');
  assert.deepEqual(
    current.children.map((child) => [child.sequence, child.messages.map((entry) => entry.id)]),
    [[1, ['reply-alpha']]],
  );
  assert.deepEqual(
    completed.filter((row) => row.kind === 'message').map((row) => row.message.id),
    ['user-parent', 'correction'],
  );
});

test('queued steering anchors at its accepted receipt time and resolves its actual run, never its cancelled queue owner', () => {
  const parent = workflow('parent', { runIds: ['run-parent'] });
  const queued = workflow('queued', { status: 'cancelled', phase: 'queue', userMessageId: 'queued-message' });
  const messages = [
    timedMessage('user-parent', 'parent', 0),
    {
      ...timedMessage('queued-message', 'queued', 1),
      steering: { runId: 'run-parent', status: 'accepted' as const, acceptedAt: at(4) },
    },
    timedMessage('interim-reply', 'parent', 2, 'assistant'),
    timedMessage('another-user-message', 'next', 3),
  ];
  const rows = conversationTimeline(messages, [queued, parent], [run('run-parent', 'parent')]);
  assert.deepEqual(
    rows.filter((row) => row.kind === 'message').map((row) => row.message.id),
    messages.map((entry) => entry.id),
  );
  assert.ok(labels(rows).indexOf('steer:queued-message') > labels(rows).indexOf('another-user-message'));
  assert.ok(labels(rows).indexOf('steer:queued-message') < labels(rows).indexOf('trace-parent'));
  const stage = rows.find((row) => row.kind === 'steering-stage');
  assert.equal(stage?.stage.workflowId, 'parent');
  assert.equal(stage?.stage.at, at(4));
});

test('successive receipts keep stage numbering and each late child result behind its matching receipt', () => {
  const parent = workflow('parent', { runIds: ['run-parent'] });
  const child = workflow('child', {
    status: 'completed',
    updatedAt: at(7),
    delegation: { parentId: 'parent', role: 'worker', requestId: 'child' },
  });
  const correction = (id: string, second: number) => ({
    ...timedMessage(id, 'parent', second),
    steering: { runId: 'run-parent', status: 'accepted' as const },
  });
  const messages = [
    timedMessage('user-parent', 'parent', 0),
    timedMessage('user-child', 'child', 1),
    correction('first', 2),
    timedMessage('child-update', 'child', 3, 'assistant'),
    correction('second', 4),
    timedMessage('child-final', 'child', 6, 'assistant'),
  ];
  const rows = conversationTimeline(messages, [parent, child]);
  assert.deepEqual(labels(rows), [
    'user-parent',
    'group-conversation:parent:stage:0',
    'first',
    'steer:first',
    'group-conversation:parent:stage:1',
    'second',
    'steer:second',
    'group-conversation:parent:stage:2',
    'trace-parent',
  ]);
  assert.deepEqual(
    rows.filter((row) => row.kind === 'steering-stage').map((row) => row.stage.number),
    [2, 3],
  );
  assert.deepEqual(
    rows.filter((row) => row.kind === 'delegation-group').map((row) => row.children[0]!.sequence),
    [1, 1, 1],
  );
});

test('late child results stay after an already visible parent reply and cannot swallow a newer user request', () => {
  const parent = workflow('parent', { status: 'completed', finalMessageId: 'reply-parent' });
  const child = workflow('child', {
    status: 'completed',
    delegation: { parentId: 'parent', role: 'scout', requestId: 'child' },
  });
  const messages = [
    timedMessage('user-parent', 'parent', 0),
    timedMessage('user-child', 'child', 1),
    timedMessage('reply-parent', 'parent', 2, 'assistant'),
    timedMessage('user-next', 'next', 3),
    timedMessage('reply-child', 'child', 4, 'assistant'),
  ];
  const rows = conversationTimeline(messages, [child, parent]);
  assert.deepEqual(labels(rows), [
    'user-parent',
    'trace-parent',
    'reply-parent',
    'user-next',
    'group-conversation:parent:stage:0',
  ]);
});

test('pending, failed, foreign and unowned steering never create a confirmed execution stage', () => {
  const parent = workflow('parent', { runIds: ['run-parent'] });
  for (const status of ['pending', 'failed'] as const) {
    const messages = [
      message('user-parent', 'parent'),
      { ...message('steer', 'parent'), steering: { runId: 'run-parent', status } },
    ];
    assert.equal(
      conversationTimeline(messages, [parent]).some((row) => row.kind === 'steering-stage'),
      false,
    );
  }
  const confirmed = { ...message('steer', 'parent'), steering: { runId: 'run-parent', status: 'accepted' as const } };
  assert.equal(
    conversationTimeline([confirmed], [parent], [run('run-parent', 'other')]).some(
      (row) => row.kind === 'steering-stage',
    ),
    false,
  );
  assert.equal(
    conversationTimeline([{ ...confirmed, conversationId: 'other' }], [parent]).some(
      (row) => row.kind === 'steering-stage',
    ),
    false,
  );
  assert.equal(
    conversationTimeline([confirmed], [{ ...parent, runIds: [] }]).some((row) => row.kind === 'steering-stage'),
    false,
  );
});

test('child summaries use actual run order, account and effective model, public progress, and safe tool metadata', () => {
  const child = workflow('child', {
    runIds: ['old-run', 'new-run', 'foreign-run'],
    delegation: {
      parentId: 'parent',
      role: 'worker',
      requestId: 'child',
      checkpoints: [{ at: at(4), progress: '已检查 3 个目录', next: '核对剩余目录' }],
    },
  });
  const old = run('old-run', 'child', { account: { id: 'grok', label: 'Grok B', provider: 'grok' } });
  const latest = run('new-run', 'child', {
    account: { id: 'codex', label: 'Codex B', provider: 'codex' },
    route: { runtimeId: 'codex', model: 'requested-model', effort: 'high', kind: 'routine', reasons: [], warnings: [] },
    effectiveModel: { model: 'confirmed-model', effort: 'medium', source: 'native' },
    relay: { fromRunId: old.id, fromRuntimeId: 'grok', reason: 'quota' },
    reasoning: 'PRIVATE_THINKING_MUST_NOT_BE_SUMMARIZED',
    taskOutcome: { status: 'partial', source: 'executor-report', summary: '目前确认 3 处重复，尚未执行移动' },
    events: [
      { at: at(4), type: 'reasoning', text: 'PRIVATE_EVENT' },
      { at: at(4), type: 'tool', data: { tool: 'find_duplicates', arguments: { secret: 'DO_NOT_PRINT_ARGUMENTS' } } },
    ],
  });
  const foreign = run('foreign-run', 'other', { output: 'OTHER_WORKFLOW' });
  const progress = delegationProgress(child, [latest, foreign, old]);
  assert.equal(progress.latest, latest);
  assert.equal(progress.tools, 1);
  assert.deepEqual(progress.ownRuns, [old, latest]);
  const html = renderToStaticMarkup(
    createElement(DelegationProgress, {
      workflow: child,
      sequence: 2,
      messages: [],
      state: { runs: [latest, foreign, old], targets: [], runtimes: [] } as unknown as AppState,
    }),
  );
  assert.match(html, /子任务 2/);
  assert.match(html, /Codex B/);
  assert.match(html, /confirmed-model/);
  assert.match(html, /medium/);
  assert.match(html, /已检查 3 个目录/);
  assert.match(html, /find_duplicates/);
  assert.match(html, /原账号额度受限/);
  assert.doesNotMatch(html, /PRIVATE_|DO_NOT_PRINT|OTHER_WORKFLOW|requested-model/);
  const afterReceipt = delegationProgress(child, [{ ...latest, endedAt: at(4), error: 'Earlier blocker' }, old], at(5));
  assert.equal(
    afterReceipt.judgment,
    undefined,
    'an earlier completed report cannot appear as a new response to a correction',
  );
  assert.equal(afterReceipt.blocker, undefined);
});

test('confirmed steering shows only newly streamed public output in the new stage', () => {
  const parent = workflow('parent', { runIds: ['run-parent'] });
  const current = run('run-parent', 'parent', {
    output: 'EARLIER_OUTPUTAFTER_CORRECTION',
    reasoning: 'PRIVATE_OLD_REASONING',
    events: [
      { type: 'text', at: at(1), text: 'EARLIER_OUTPUT' },
      { type: 'text', at: at(5), text: 'AFTER_CORRECTION' },
    ],
  });
  const messages = [
    timedMessage('user-parent', 'parent', 0),
    {
      ...timedMessage('correction', 'parent', 3),
      steering: { runId: current.id, status: 'accepted' as const, acceptedAt: at(4) },
    },
  ];
  const html = renderToStaticMarkup(
    createElement(ConversationHistory, {
      messages,
      workflows: [parent],
      state: { targets: [], runtimes: [], runs: [current], workflows: [parent], settings: {} } as unknown as AppState,
      api: async <T>() => ({}) as T,
      notify() {},
      onInspect() {},
    }),
  );
  assert.match(html, /阶段 2/);
  assert.match(html, /AFTER_CORRECTION/);
  assert.doesNotMatch(html, /EARLIER_OUTPUT|PRIVATE_OLD_REASONING/);
});

test('promoted queue task follows the previous final reply instead of its early submission', () => {
  const first = workflow('first', { status: 'completed', finalMessageId: 'reply-first' });
  const second = workflow('second');
  const messages = [
    message('user-first', 'first'),
    message('user-second', 'second'),
    message('reply-first', 'first', 'assistant'),
  ];
  assert.deepEqual(ids(messages, [second, first]), [
    'user-first',
    'user-second',
    'trace-first',
    'reply-first',
    'trace-second',
  ]);
  const html = renderToStaticMarkup(
    createElement(ConversationHistory, {
      messages,
      workflows: [first, second],
      state: { targets: [], runtimes: [], runs: [], workflows: [first, second], settings: {} } as unknown as AppState,
      api: async <T>() => ({}) as T,
      notify() {},
      onInspect() {},
    }),
  );
  assert.ok(html.indexOf('id="workflow-first"') < html.indexOf('data-message-id="reply-first"'));
  assert.ok(html.indexOf('data-message-id="reply-first"') < html.indexOf('id="workflow-second"'));
  assert.equal((html.match(/id="workflow-second"/g) ?? []).length, 1);
  assert.deepEqual(
    messages.map((item) => item.id),
    ['user-first', 'user-second', 'reply-first'],
  );
});

test('finished build tasks stay directly before their own replies, including legacy missing final pointers', () => {
  const messages = [
    message('user-first', 'first'),
    message('user-second', 'second'),
    message('reply-first', 'first', 'assistant'),
    message('reply-second', 'second', 'assistant'),
  ];
  assert.deepEqual(
    ids(messages, [workflow('second', { status: 'completed' }), workflow('first', { status: 'completed' })]),
    ['user-first', 'user-second', 'trace-first', 'reply-first', 'trace-second', 'reply-second'],
  );
});

test('completed chats with runs retain records; pure notices without runs have none', () => {
  const completed = workflow('finished', {
    status: 'completed',
    finalMessageId: 'reply-finished',
    runIds: ['finished-run'],
    input: { ...workflow('finished').input, mode: 'chat' },
  });
  const messages = [message('user-finished', 'finished'), message('reply-finished', 'finished', 'assistant')];
  assert.deepEqual(ids(messages, [completed]), ['user-finished', 'trace-finished', 'reply-finished']);
  assert.deepEqual(ids(messages.slice(1), [completed]), ['trace-finished', 'reply-finished']);
  assert.deepEqual(ids(messages, [{ ...completed, runIds: [] }]), ['user-finished', 'reply-finished']);
  for (const retained of [
    { ...completed, input: { ...completed.input, mode: 'build' as const } },
    { ...completed, review: { round: 1, status: 'passed' as const, claims: [] } },
  ]) {
    assert.deepEqual(ids(messages, [retained]), ['user-finished', 'trace-finished', 'reply-finished']);
  }
  for (const taskOutcome of [
    { status: 'completed' as const, source: 'executor-report' as const, claims: [{ claim: 'Synthetic evidence' }] },
    {
      status: 'completed' as const,
      source: 'file-receipts' as const,
      verificationLimited: true,
      limitedChecks: [{ id: 'check', command: 'synthetic check', reason: 'Synthetic environment restriction' }],
    },
  ]) {
    const evidenceRun = run('finished-run', 'finished', { status: 'completed', taskOutcome });
    assert.deepEqual(labels(conversationTimeline(messages, [completed], [evidenceRun])), [
      'user-finished',
      'trace-finished',
      'reply-finished',
    ]);
    assert.deepEqual(labels(conversationTimeline(messages, [completed], [{ ...evidenceRun, workflowId: 'foreign' }])), [
      'user-finished',
      'trace-finished',
      'reply-finished',
    ]);
  }
});

test('steering messages sharing a workflow never duplicate its card or lose delivery status', () => {
  const steer = { ...message('correction', 'first'), steering: { runId: 'run', status: 'accepted' as const } };
  const messages = [message('user-first', 'first'), steer, message('reply-first', 'first', 'assistant')];
  assert.deepEqual(ids(messages, [workflow('first', { status: 'completed' })]), [
    'user-first',
    'correction',
    'trace-first',
    'reply-first',
  ]);
  const converted = workflow('converted', { userMessageId: steer.id, status: 'cancelled' });
  assert.deepEqual(ids(messages, [workflow('first'), converted]), [
    'user-first',
    'correction',
    'reply-first',
    'trace-first',
  ]);
  assert.equal(steer.steering.status, 'accepted');
  const html = renderToStaticMarkup(
    createElement(ConversationHistory, {
      messages,
      workflows: [],
      state: { targets: [], runtimes: [], runs: [], workflows: [], settings: {} } as unknown as AppState,
      api: async <T>() => ({}) as T,
      notify() {},
      onInspect() {},
    }),
  );
  assert.match(html, /执行器已接收补充（steer）/);
  assert.doesNotMatch(html, /已开始处理补充|已补充到当前任务/);
});

test('delegated work stays with its parent and deleting task cards retains the child messages', () => {
  const child = workflow('child', {
    status: 'completed',
    delegation: { parentId: 'first', role: 'scout', requestId: 'fixture' },
  });
  const messages = [
    message('user-first', 'first'),
    message('user-child', 'child'),
    message('reply-child', 'child', 'assistant'),
  ];
  assert.deepEqual(ids(messages, [workflow('first'), child]), [
    'user-first',
    'group-conversation:first',
    'trace-first',
  ]);
  assert.deepEqual(ids(messages, [workflow('first', { deletedAt: stamp }), { ...child, deletedAt: stamp }]), [
    'user-first',
    'group-conversation:first',
  ]);
  const deleted = conversationTimeline(messages, [
    workflow('first', { deletedAt: stamp }),
    { ...child, deletedAt: stamp },
  ]);
  const group = deleted.find((row) => row.kind === 'delegation-group')!;
  assert.deepEqual(
    group.children[0]!.messages.map((item) => item.id),
    ['user-child', 'reply-child'],
  );
});

test('canonical and final references cannot attach to another conversation or workflow', () => {
  const messages = [
    message('user-first', 'first'),
    { ...message('foreign-final', 'first', 'assistant'), conversationId: 'other' },
    message('wrong-final', 'second', 'assistant'),
    message('reply-first', 'first', 'assistant'),
  ];
  for (const finalMessageId of ['foreign-final', 'wrong-final', 'missing']) {
    assert.deepEqual(ids(messages, [workflow('first', { status: 'completed', finalMessageId })]), [
      'user-first',
      'foreign-final',
      'wrong-final',
      'trace-first',
      'reply-first',
    ]);
  }
  const foreign = workflow('first', { conversationId: 'other', userMessageId: 'user-first' });
  assert.deepEqual(
    ids(messages, [foreign]),
    messages.map((item) => item.id),
  );
});

test('unstarted cancellation stays near its origin and imported messages keep their source order', () => {
  const messages = [
    message('imported-earlier'),
    message('user-cancelled', 'cancelled'),
    message('imported-later', undefined, 'assistant'),
  ];
  assert.deepEqual(ids(messages, [workflow('cancelled', { status: 'cancelled' })]), [
    'imported-earlier',
    'user-cancelled',
    'trace-cancelled',
    'imported-later',
  ]);
  assert.deepEqual(
    ids(messages, []),
    messages.map((item) => item.id),
  );
});

test('live card appears before waiting cards and legacy origin fallback is same-conversation only', () => {
  const messages = [message('legacy-user', 'waiting'), message('user-running', 'running')];
  const waiting = workflow('waiting', { status: 'queued' });
  waiting.input.schedule = { deadlineAt: at(60) };
  assert.deepEqual(ids(messages, [waiting, workflow('running')]), [
    'legacy-user',
    'user-running',
    'trace-running',
    'trace-waiting',
  ]);
});

test('plain queued messages have no card until they start; scheduled waiting tasks keep theirs', () => {
  const messages = [message('user-waiting', 'waiting')];
  for (const status of ['queued', 'waiting-resource'] as const) {
    const waiting = workflow('waiting', { status });
    assert.deepEqual(ids(messages, [waiting]), ['user-waiting']);
    assert.deepEqual(ids(messages, [{ ...waiting, startedAt: stamp }]), ['user-waiting', 'trace-waiting']);
    assert.deepEqual(ids(messages, [{ ...waiting, status: 'running' }]), ['user-waiting', 'trace-waiting']);
    waiting.input.schedule = { deadlineAt: at(60) };
    assert.deepEqual(ids(messages, [waiting]), ['user-waiting', 'trace-waiting']);
  }
});

test('legacy pending and quiet waiting heads keep one timeline status card', () => {
  const messages = [message('user-waiting', 'waiting')];
  const waiting = workflow('waiting', { status: 'waiting-resource', machineLoadChoice: 'pending' });
  assert.deepEqual(ids(messages, [waiting]), ['user-waiting', 'trace-waiting']);
  assert.deepEqual(ids(messages, [{ ...waiting, machineLoadChoice: 'wait' }]), ['user-waiting', 'trace-waiting']);
});

test('parallel child results group by parent without moving queued user messages or steering', () => {
  const child = (id: string) =>
    workflow(id, {
      status: 'completed',
      finalMessageId: `reply-${id}`,
      delegation: { parentId: 'parent', role: 'scout', requestId: id },
    });
  const children = [child('alpha'), child('beta')];
  const parent = workflow('parent', { status: 'completed', finalMessageId: 'reply-parent' });
  const messages = [
    message('user-parent', 'parent'),
    message('user-alpha', 'alpha'),
    message('user-queued', 'queued'),
    message('user-beta', 'beta'),
    { ...message('steer-parent', 'parent'), steering: { runId: 'parent-run', status: 'accepted' as const } },
    message('reply-beta', 'beta', 'assistant'),
    { ...message('steer-alpha', 'alpha'), steering: { runId: 'child-run', status: 'pending' as const } },
    message('reply-alpha', 'alpha', 'assistant'),
    message('reply-parent', 'parent', 'assistant'),
  ];
  const unchanged = structuredClone(messages);
  const rows = conversationTimeline(messages, [
    children[1]!,
    workflow('queued', { status: 'queued' }),
    parent,
    children[0]!,
  ]);
  assert.deepEqual(
    rows.map((row) =>
      row.kind === 'message' ? row.message.id : row.kind === 'workflow' ? `trace-${row.workflow.id}` : 'children',
    ),
    ['user-parent', 'user-queued', 'steer-parent', 'steer-alpha', 'children', 'trace-parent', 'reply-parent'],
  );
  const group = rows.find((row) => row.kind === 'delegation-group')!;
  assert.equal(group.parent, parent);
  assert.equal(group.live, undefined);
  assert.deepEqual(
    group.children.map(({ workflow, messages }) => [workflow.id, messages.map((item) => item.id)]),
    [
      ['alpha', ['user-alpha', 'reply-alpha']],
      ['beta', ['user-beta', 'reply-beta']],
    ],
  );
  assert.deepEqual(messages, unchanged, 'building the timeline never reorders or changes saved messages');
});

test('loaded child replies survive a missing parent origin, missing parent metadata, and deleted parents', () => {
  const child = workflow('child', {
    status: 'completed',
    finalMessageId: 'reply-child',
    delegation: { parentId: 'parent', role: 'reviewer', requestId: 'review' },
  });
  const messages = [message('reply-child', 'child', 'assistant'), message('user-next', 'next')];
  for (const parent of [
    undefined,
    workflow('parent', { status: 'completed' }),
    workflow('parent', { deletedAt: stamp }),
  ]) {
    const rows = conversationTimeline(messages, parent ? [parent, child] : [child]);
    assert.equal(rows[0]!.kind, 'delegation-group');
    const group = rows[0]!;
    if (group.kind !== 'delegation-group') throw new Error('Expected the loaded child reply');
    assert.equal(group.parent, parent);
    assert.deepEqual(group.children[0]!.messages, [messages[0]]);
    assert.deepEqual(
      rows.filter((row) => row.kind === 'message').map((row) => row.message.id),
      ['user-next'],
    );
  }
});

test('active orphan children remain live, while legacy message pointers never absorb foreign messages', () => {
  const child = workflow('child', {
    finalMessageId: 'reply-child',
    delegation: { parentId: 'missing-parent', role: 'scout', requestId: 'child' },
  });
  const messages = [
    message('user-child'),
    { ...message('foreign', 'child', 'assistant'), conversationId: 'other' },
    message('steer', 'child'),
    message('reply-child', undefined, 'assistant'),
  ];
  messages[2]!.steering = { runId: 'run', status: 'failed', error: 'Fixture delivery failure' };
  const rows = conversationTimeline(messages, [child]);
  assert.deepEqual(
    rows.filter((row) => row.kind === 'message').map((row) => row.message.id),
    ['foreign', 'steer'],
  );
  const group = rows.at(-1)!;
  assert.equal(group.kind, 'delegation-group');
  if (group.kind !== 'delegation-group') throw new Error('Expected live child group');
  assert.equal(group.live, true);
  assert.equal(group.parent, undefined);
  assert.deepEqual(
    group.children[0]!.messages.map((item) => item.id),
    ['user-child', 'reply-child'],
  );
  assert.equal(messages[2]!.steering.status, 'failed');
});

test('nested children group by explicit ancestor IDs and never by matching content', () => {
  const child = workflow('child', {
    status: 'completed',
    delegation: { parentId: 'middle', role: 'scout', requestId: 'child' },
  });
  const middle = workflow('middle', {
    status: 'completed',
    delegation: { parentId: 'root', role: 'worker', requestId: 'middle' },
  });
  const messages = [message('user-root', 'root'), message('reply-child', 'child', 'assistant'), message('unrelated')];
  messages[2]!.content = messages[1]!.content;
  const rows = conversationTimeline(messages, [workflow('root'), middle, child]);
  const group = rows.find((row) => row.kind === 'delegation-group')!;
  assert.equal(group.id, 'conversation:root');
  assert.deepEqual(group.children.find((item) => item.workflow.id === 'child')!.messages, [messages[1]]);
  assert.ok(rows.some((row) => row.kind === 'message' && row.message.id === 'unrelated'));
});

test('a message still being sent sits where it will land, above running tasks, and sub-tasks fold with who asked whom', () => {
  const parent = workflow('parent', { runIds: ['parent-run'] });
  const child = workflow('child', {
    status: 'completed',
    finalMessageId: 'reply-child',
    delegation: {
      parentId: 'parent',
      role: 'reviewer',
      requestId: 'review',
      agent: { label: 'Codex · 本机', provider: 'codex', runtimeId: 'codex-native', caller: 'Grok B' },
    },
  });
  const messages = [
    message('user-parent', 'parent'),
    { ...message('user-child', 'child'), content: 'Grok B 请你完成以下子任务：\nCheck chapter one.' },
    {
      ...message('reply-child', 'child', 'assistant'),
      content: '子任务 · 审查 · Codex · 本机 · 已完成（父任务 parent）\n\nIt reads well.',
    },
  ];
  const html = renderToStaticMarkup(
    createElement(ConversationHistory, {
      messages,
      workflows: [parent, child],
      state: { targets: [], runtimes: [], runs: [], workflows: [parent, child], settings: {} } as unknown as AppState,
      api: async <T>() => ({}) as T,
      notify() {},
      onInspect() {},
      pendingMessages: [
        {
          id: 'pending',
          scope: 'conversation:conversation',
          conversationId: 'conversation',
          content: 'Sending',
          images: [],
          quotes: [],
          sentAt: new Date().toISOString(),
          snapshot: { content: 'Sending', attachments: [] },
        },
      ],
    }),
  );
  // The running task stays at the bottom, below the message being sent.
  assert.ok(html.indexOf('pending-send') < html.lastIndexOf('workflow-trace'), html);
  assert.ok(html.indexOf('pending-send') < html.indexOf('class="conversation-exchange delegation-group"'), html);
  // Names are shown as written; the turn count stays interface text.
  assert.match(html, /<span translate="no">Grok B ↔ Codex · 本机<\/span> · 2 轮/);
  assert.doesNotMatch(html, /<details class="conversation-exchange delegation-group"[^>]* open/);
  assert.match(
    html,
    /<article class="delegated-message participant-card task"[\s\S]*?<strong translate="no">Grok B<\/strong>[\s\S]*?→ Codex · 本机[\s\S]*?子任务 · 审查[\s\S]*?Check chapter one\./,
  );
  assert.match(
    html,
    /<article class="delegated-message participant-card result"[\s\S]*?<strong translate="no">Codex · 本机<\/strong>[\s\S]*?→ Grok B[\s\S]*?It reads well\./,
  );
});

const traceProps = (task: Workflow, ownRuns: RunRecord[] = []) => ({
  workflow: task,
  state: { targets: [], runtimes: [], runs: ownRuns, workflows: [task], settings: {} } as unknown as AppState,
  api: async <T>() => ({}) as T,
  notify() {},
  onInspect() {},
});

test('live task details stay folded while the reasoning preview remains outside the fold', () => {
  const task = workflow('live', {
    runIds: ['live-run'],
    plan: [
      {
        id: 'step',
        title: 'Synthetic plan',
        instruction: '',
        kind: 'routine',
        transport: 'auto',
        dependsOn: [],
        status: 'running',
        runIds: ['live-run'],
      },
    ],
  });
  const liveRun = run('live-run', task.id, {
    reasoning: 'Private reasoning fixture\nHidden body',
    output: 'Public output fixture',
    events: [{ type: 'tool', at: stamp, text: 'find_files' }],
  });
  const html = renderToStaticMarkup(createElement(WorkflowTrace, traceProps(task, [liveRun])));
  assert.match(html, /<details><summary>[\s\S]*?class="workflow-status"[\s\S]*?<div class="trace-body">/);
  assert.match(html, /<\/details><div class="turn-tail"/);
  assert.doesNotMatch(html, /<details[^>]*open=/);
  assert.ok(html.indexOf('class="stream-preview"') < html.indexOf('class="turn-tail"'));
  assert.match(visibleMarkupText(html), /Private reasoning fixture/);
  assert.match(html, /Public output fixture/);
  assert.doesNotMatch(html, /Hidden body/);
  const summary = html.slice(html.indexOf('<summary>'), html.indexOf('</summary>'));
  assert.doesNotMatch(summary, /正在找文件|grok-4\.7|Private reasoning|Public output/);
});

function visibleMarkupText(html: string): string {
  const root = new DOMParser().parseFromString(`<html><body>${html}</body></html>`, 'text/html');
  const text = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent ?? '';
    const element = node as Element;
    const children = Array.from(node.childNodes ?? []);
    if (element.tagName?.toLowerCase() === 'details' && !element.hasAttribute('open'))
      return children
        .filter((child) => (child as Element).tagName?.toLowerCase() === 'summary')
        .map(text)
        .join('');
    return children.map(text).join('');
  };
  return text(root as unknown as Node);
}

const mainReplyFixture = () => {
  const liveRun = run('reply-run', 'chat', {
    stepId: 'reply',
    output: 'Visible answer fragment',
    reasoning: 'Folded reasoning fragment\nHidden body',
    events: [{ type: 'tool', at: stamp, text: 'find_files', data: { tool: 'find_files' } }],
  });
  const task = workflow('chat', {
    input: { ...workflow('chat').input, mode: 'auto' },
    runIds: [liveRun.id],
    activeStepId: 'reply',
    plan: [
      {
        id: 'reply',
        title: '回答问题',
        instruction: '',
        kind: 'routine',
        transport: 'auto',
        dependsOn: [],
        status: 'running',
        runIds: [liveRun.id],
      },
    ],
  });
  return { task, liveRun };
};

test('main reply and reasoning tail stay visible outside collapsed task details', () => {
  const { task, liveRun } = mainReplyFixture();
  const html = renderToStaticMarkup(createElement(WorkflowTrace, traceProps(task, [liveRun])));
  const visible = visibleMarkupText(html);
  assert.match(visible, /Visible answer fragment/);
  assert.match(visible, /Folded reasoning fragment/);
  assert.match(html, /<\/details><div class="turn-tail"/);
  assert.equal(html.split('Visible answer fragment').length - 1, 1);
  assert.doesNotMatch(html, /<details[^>]*open=/);
});

test('delegated cards keep reasoning outside their task fold; a steered stage shows none of the earlier reasoning', () => {
  for (const staged of [false, true]) {
    const { task, liveRun } = mainReplyFixture();
    task.delegation = { parentId: 'parent', role: 'worker', requestId: 'synthetic' };
    const html = renderToStaticMarkup(
      createElement(WorkflowTrace, {
        ...traceProps(task, [liveRun]),
        ...(staged
          ? { stage: { id: 'stage', workflowId: task.id, number: 1, at: at(5), messageId: 'follow-up' } }
          : {}),
      }),
    );
    if (staged) {
      assert.doesNotMatch(html, /thinking-ticker/);
      assert.doesNotMatch(visibleMarkupText(html), /Folded reasoning fragment/);
    } else {
      assert.match(html, /<\/details><div class="turn-tail"/);
      assert.match(visibleMarkupText(html), /Folded reasoning fragment/);
      assert.doesNotMatch(html, /class="stream-waiting"/);
    }
  }
});

test('a saved final reply takes over the live answer only after its actual message arrives', () => {
  const { task, liveRun } = mainReplyFixture();
  task.status = 'completed';
  task.phase = 'summarize';
  task.finalMessageId = 'final-reply';
  liveRun.status = 'completed';
  const props = { ...traceProps(task, [liveRun]), messages: [message('user-chat', task.id)], workflows: [task] };
  const waiting = renderToStaticMarkup(createElement(ConversationHistory, props));
  assert.match(visibleMarkupText(waiting), /Visible answer fragment/);
  const notice = {
    ...timedMessage('notice', task.id, 2, 'assistant'),
    content: 'Quota relay notice',
    systemNotice: { text: 'Quota relay notice' },
  };
  const notified = renderToStaticMarkup(
    createElement(ConversationHistory, { ...props, messages: [...props.messages, notice] }),
  );
  assert.match(notified, /live-main-reply/);
  assert.match(visibleMarkupText(notified), /Visible answer fragment/);
  const foreign = {
    ...timedMessage('final-reply', 'not-loaded-foreign-workflow', 2, 'assistant'),
    content: 'Other answer',
  };
  const unrelated = renderToStaticMarkup(
    createElement(ConversationHistory, { ...props, messages: [...props.messages, foreign] }),
  );
  assert.match(unrelated, /live-main-reply/);
  const saved = { ...timedMessage('final-reply', task.id, 2, 'assistant'), content: liveRun.output };
  const complete = renderToStaticMarkup(
    createElement(ConversationHistory, { ...props, messages: [...props.messages, saved] }),
  );
  assert.equal(complete.split('Visible answer fragment').length - 1, 1);
  assert.doesNotMatch(complete, /live-main-reply/);
  const finalNotice = {
    ...saved,
    systemNotice: { text: 'Synthetic final stop notice', details: 'Terminal raw refusal' },
  };
  const stopped = renderToStaticMarkup(
    createElement(ConversationHistory, { ...props, messages: [...props.messages, finalNotice] }),
  );
  assert.doesNotMatch(stopped, /live-main-reply/);
  assert.match(visibleMarkupText(stopped), /Synthetic final stop notice/);
  assert.match(visibleMarkupText(stopped), /Visible answer fragment/);
  assert.doesNotMatch(visibleMarkupText(stopped), /Terminal raw refusal/);
});

test('planning, internal steps, children, failures and unloaded relay runs never become main live replies', () => {
  for (const kind of [
    'planning',
    'build-reply',
    'step',
    'other-active-step',
    'foreign-run',
    'child',
    'failed',
    'cancelled',
    'relay-gap',
  ] as const) {
    const { task, liveRun } = mainReplyFixture();
    if (kind === 'planning') {
      task.phase = 'plan';
      liveRun.stepId = undefined;
    }
    if (kind === 'step') {
      liveRun.stepId = 'step1';
      task.plan[0]!.id = 'step1';
      task.activeStepId = 'step1';
    }
    if (kind === 'child') task.delegation = { parentId: 'parent', role: 'worker', requestId: 'synthetic' };
    if (kind === 'build-reply') task.input.mode = 'build';
    if (kind === 'foreign-run') liveRun.workflowId = 'foreign';
    if (kind === 'other-active-step') task.activeStepId = 'internal-step';
    if (kind === 'failed') liveRun.status = 'failed';
    if (kind === 'cancelled') task.status = 'cancelled';
    if (kind === 'relay-gap') task.runIds.push('not-loaded-yet');
    const html = renderToStaticMarkup(createElement(WorkflowTrace, traceProps(task, [liveRun])));
    assert.doesNotMatch(html, /live-main-reply/, kind);
    assert.doesNotMatch(visibleMarkupText(html), /Visible answer fragment/, kind);
  }
});

test('steering shows only post-receipt text and an earlier saved reply cannot hide the new stage', () => {
  const { task, liveRun } = mainReplyFixture();
  liveRun.output = 'Old answer fragmentNew stage answer';
  liveRun.events = [
    { type: 'text', at: at(1), text: 'Old answer fragment' },
    { type: 'text', at: at(4), text: 'New stage answer' },
  ];
  const messages = [
    timedMessage('user-chat', task.id, 0),
    { ...timedMessage('old-reply', task.id, 1, 'assistant'), content: 'Saved earlier answer' },
    {
      ...timedMessage('correction', task.id, 2),
      steering: { runId: liveRun.id, status: 'accepted' as const, acceptedAt: at(3) },
    },
  ];
  const html = renderToStaticMarkup(
    createElement(ConversationHistory, { ...traceProps(task, [liveRun]), messages, workflows: [task] }),
  );
  const visible = visibleMarkupText(html);
  assert.match(visible, /Saved earlier answer/);
  assert.match(visible, /New stage answer/);
  assert.doesNotMatch(visible, /Old answer fragment/);
  assert.equal(html.split('New stage answer').length - 1, 1);
});

test('a failed system reply is one short notice with raw details folded and no duplicate error block', () => {
  const failedRun = run('failed-run', 'failed', {
    status: 'failed',
    errorCode: 'runtime-network-error',
    error: 'Raw socket error\nSynthetic stack',
  });
  const task = workflow('failed', {
    status: 'failed',
    runIds: [failedRun.id],
    error: failedRun.error,
    finalMessageId: 'reply-failed',
  });
  const notice = failureNotice(task, [failedRun]);
  const reply = { ...message('reply-failed', task.id, 'assistant'), content: notice.text, systemNotice: notice };
  const html = renderToStaticMarkup(
    createElement(ConversationHistory, {
      ...traceProps(task, [failedRun]),
      messages: [message('user-failed', task.id), reply],
      workflows: [task],
    }),
  );
  assert.equal(html.split(systemNoticeText.network).length - 1, 1);
  assert.equal(html.split('Raw socket error').length - 1, 1);
  assert.match(html, /<details class="system-notice-details"><summary>详情<\/summary><pre translate="no">/);
  assert.doesNotMatch(html, /class="workflow-error"|system-notice-details" open=/);
});

test('stopped replies render the notice above the full answer without repeating notice-only bodies', () => {
  for (const status of ['blocked', 'cancelled', 'interrupted', 'failed'] as const) {
    const stoppedRun = run('stopped-run', 'stopped', {
      status: 'failed',
      output: 'Synthetic B200 answer with caveats.',
      taskOutcome: { status: 'partial', source: 'executor-report', summary: 'Some prices are unverified.' },
    });
    const task = workflow('stopped', { status, runIds: [stoppedRun.id], finalMessageId: 'reply-stopped' });
    const notice = failureNotice(task, [stoppedRun]);
    for (const delegated of [false, true]) {
      const owner = delegated
        ? { ...task, delegation: { parentId: 'parent', role: 'worker' as const, requestId: 'request' } }
        : task;
      const reply = {
        ...message('reply-stopped', task.id, 'assistant'),
        content: stoppedRun.output,
        systemNotice: notice,
        replyIdentity: { kind: 'system' as const, automatic: false, runs: [] },
      };
      const html = renderToStaticMarkup(
        createElement(ConversationHistory, {
          ...traceProps(owner, [stoppedRun]),
          messages: [reply],
          workflows: [workflow('parent'), owner],
        }),
      );
      assert.equal(html.split(stoppedRun.output).length - 1, 1);
      assert.ok(html.indexOf(notice.text) < html.indexOf(stoppedRun.output));
    }
  }
});

test('read-only notices quote the exact trigger and write rerun is offered only for eligible stopped tasks', () => {
  const task = workflow('read-only', {
    status: 'completed',
    input: {
      content: '请不要改文件，先分析。',
      mode: 'auto',
      permissionMode: 'read-only',
      executionPolicy: 'cli-first',
      readOnlyTrigger: '不要改文件',
    },
  });
  const html = renderToStaticMarkup(createElement(WorkflowTrace, traceProps(task)));
  assert.match(html, /只读 · 你的消息要求只读：不要改文件/);
  assert.match(html, /按可写入重新执行/);
  for (const restricted of [
    { ...task, status: 'running' as const },
    { ...task, input: { ...task.input, untrustedContent: true } },
    { ...task, input: { ...task.input, untrustedQuotesOnly: true } },
    {
      ...task,
      input: { ...task.input, deviceId: 'device' },
      delegation: {
        parentId: 'parent',
        role: 'scout',
        requestId: 'r',
        agent: { label: '设备「box」', deviceId: 'device' },
      },
    } as Workflow,
    { ...task, agentPreset: { id: 'readonly', name: 'Readonly', permissionMode: 'read-only' } } as Workflow,
    { ...task, delegation: { parentId: 'parent', role: 'reviewer', requestId: 'review' } } as Workflow,
  ]) {
    assert.doesNotMatch(renderToStaticMarkup(createElement(WorkflowTrace, traceProps(restricted))), /按可写入重新执行/);
  }
});

test('a stopped top-level read-only device task offers write rerun with its device name', () => {
  const task = workflow('device-read', {
    status: 'completed',
    finalMessageId: 'device-reply',
    input: {
      content: 'Synthetic request',
      mode: 'chat',
      permissionMode: 'read-only',
      executionPolicy: 'cli-only',
      deviceId: 'device',
      permissionOrigin: { mode: 'read-only', source: 'device' },
    },
  });
  const props = traceProps(task);
  const state = {
    ...props.state,
    conversationMessages: [{ ...message('device-reply', task.id, 'assistant'), device: { id: 'device', name: 'box' } }],
  };
  const html = renderToStaticMarkup(createElement(WorkflowTrace, { ...props, state }));
  assert.match(html, /按可写入重新执行/);
  assert.match(html, /将在设备「box」上以可写入重跑（可运行命令、改文件）/);
  for (const restricted of [
    { ...task, status: 'running' as const },
    { ...task, status: 'queued' as const },
    { ...task, input: { ...task.input, untrustedContent: true } },
    { ...task, input: { ...task.input, untrustedQuotesOnly: true } },
  ])
    assert.doesNotMatch(
      renderToStaticMarkup(createElement(WorkflowTrace, traceProps(restricted))),
      /按可写入重新执行|将在设备/,
    );
});

test('old final system failures use one display notice and preserve their full original text in details', () => {
  const task = workflow('old-failure', { status: 'failed', finalMessageId: 'old-reply', error: 'Raw old failure' });
  const reply = {
    ...message('old-reply', task.id, 'assistant'),
    content: 'Old failure heading\n\nRaw old failure\nFull original text',
    replyIdentity: { kind: 'system' as const, automatic: true, runs: [] },
  };
  const html = renderToStaticMarkup(
    createElement(ConversationHistory, {
      ...traceProps(task),
      messages: [message('user-old-failure', task.id), reply],
      workflows: [task],
    }),
  );
  assert.equal(html.split('Raw old failure').length - 1, 1);
  assert.match(html, /system-notice-details[\s\S]*?Old failure heading\n\nRaw old failure\nFull original text/);
  assert.match(html, /本轮执行失败，请查看详情后重试。/);
  assert.equal((reply as ConversationMessage).systemNotice, undefined);
});

test('the rerun button grants write permission once and carries the current UI language', async () => {
  const task = workflow('read-only', {
    status: 'completed',
    input: {
      content: 'Synthetic request',
      mode: 'auto',
      permissionMode: 'read-only',
      executionPolicy: 'cli-first',
      readOnlyTrigger: '先分析',
    },
  });
  const calls: Array<{ path: string; body: any }> = [];
  let release!: () => void;
  const result = new Promise<void>((resolve) => {
    release = resolve;
  });
  const harness = uiHarness(await uiBundle('src/ui/Workspace.tsx'), {
    localStorage: { getItem: () => 'en' },
  });
  const tree = harness.render('WorkflowTrace', {
    ...traceProps(task),
    api: async (path: string, body: unknown) => {
      calls.push({ path, body });
      await result;
      return task;
    },
  });
  const button = findNode(tree, (node) => node.type === 'button' && node.props.children?.includes('按可写入重新执行'))!;
  assert.ok(button);
  button.props.onClick();
  button.props.onClick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.path, '/api/workflows/read-only/rerun-write');
  assert.equal(calls[0]!.body.permissionMode, 'workspace-write');
  assert.equal(calls[0]!.body.permissionReauthorized, true);
  assert.equal(calls[0]!.body.uiLocale, 'en');
  release();
  await result;
  harness.unmount();
});

for (const status of ['completed', 'running', 'failed', 'blocked', 'waiting-resource', 'waiting-approval'] as const) {
  for (const body of ['', 'Executor partial answer.']) {
    test(`continuation history ending ${status}, ${body ? 'with answer' : 'notice only'}`, () => {
      const first = workflow('first', {
        status: 'interrupted',
        finalMessageId: 'reply-first',
        followUp: { workflowId: 'next', kind: 'continue', at: stamp },
      });
      const next = workflow('next', { status, finalMessageId: 'reply-next' });
      const notice = failureNotice(first, []);
      const messages = [
        message('user-first', first.id),
        { ...message('reply-first', first.id, 'assistant'), content: body || notice.text, systemNotice: notice },
        { ...message('user-next', next.id), content: '', resumed: true as const },
        { ...message('reply-next', next.id, 'assistant'), content: 'Final answer.' },
      ];
      const before = JSON.stringify({ messages, first, next });
      const props = traceProps(first);
      const html = renderToStaticMarkup(
        createElement(ConversationHistory, {
          ...props,
          messages,
          workflows: [first, next],
          state: { ...props.state, workflows: [first, next] },
        }),
      );
      assert.match(html, /Final answer\./);
      if (body) assert.match(html, /Executor partial answer\./);
      // Once Continue creates the next task the earlier attempt leaves the chat at once, whatever the
      // next task's state; only the trace shows it.
      assert.doesNotMatch(html, /workflow-first|结果未确认|已创建续接任务|查看后续任务|system-notice|继续执行/);
      assert.ok(!html.includes(notice.text));
      assert.equal(html.includes('data-message-id="reply-first"'), !!body);
      // A queued next task shows in the task dock, not as a chat card.
      if (status !== 'waiting-resource') assert.match(html, /id="workflow-next"/);
      assert.equal(JSON.stringify({ messages, first, next }), before, 'display must not mutate storage objects');
    });
  }
}

test('completed continuation keeps recovered executor output and hides intermediate system notices', () => {
  for (const delegated of [false, true]) {
    const first = workflow('first', {
      status: 'failed',
      finalMessageId: 'reply-first',
      runIds: ['partial-run'],
      followUp: { workflowId: 'next', kind: 'continue', at: stamp },
      ...(delegated ? { delegation: { parentId: 'parent', role: 'worker' as const, requestId: 'request' } } : {}),
    });
    const next = workflow('next', { status: 'completed', finalMessageId: 'reply-next', parentWorkflowId: first.id });
    const record = run('partial-run', first.id, { status: 'failed', output: 'Recovered executor body.' });
    const notice = failureNotice(first, [record]);
    const props = traceProps(first, [record]);
    const html = renderToStaticMarkup(
      createElement(ConversationHistory, {
        ...props,
        workflows: [first, next],
        state: { ...props.state, workflows: [first, next] },
        messages: [
          message('user-first', first.id),
          {
            ...message('relay-notice', first.id, 'assistant'),
            content: 'Old intermediate failure',
            replyIdentity: { kind: 'system', automatic: true, runs: [] },
          },
          {
            ...message('reply-first', first.id, 'assistant'),
            content: notice.text,
            systemNotice: notice,
            replyIdentity: { kind: 'system', automatic: true, runs: [] },
          },
          { ...message('user-next', next.id), resumed: true, content: 'Please also check expiry.' },
          message('reply-next', next.id, 'assistant'),
        ],
      }),
    );
    assert.equal(html.split(record.output).length - 1, 1);
    assert.match(html, /Please also check expiry\./);
    assert.doesNotMatch(html, /workflow-first|Old intermediate failure|已创建续接任务|查看后续任务|system-notice/);
    assert.ok(html.indexOf(record.output) < html.indexOf('Fixture reply-next'));
  }
});

test('two-level continuation hides both predecessors, including legacy notice-only replies', () => {
  const tasks = [
    workflow('a', {
      status: 'interrupted',
      finalMessageId: 'reply-a',
      followUp: { workflowId: 'b', kind: 'continue', at: stamp },
    }),
    workflow('b', {
      status: 'failed',
      finalMessageId: 'reply-b',
      followUp: { workflowId: 'c', kind: 'continue', at: stamp },
    }),
    workflow('c', { status: 'completed', finalMessageId: 'reply-c' }),
  ];
  const messages = tasks.flatMap((task, index) => [
    {
      ...message(task.userMessageId, task.id),
      content: index ? '' : 'Question',
      resumed: index ? (true as const) : undefined,
    },
    {
      ...message(task.finalMessageId!, undefined, 'assistant'),
      content: index < 2 ? 'Old system failure' : 'Final answer',
      replyIdentity: index < 2 ? { kind: 'system' as const, automatic: true, runs: [] } : undefined,
    },
  ]);
  const props = traceProps(tasks[0]!);
  const render = (workflows: Workflow[]) =>
    renderToStaticMarkup(
      createElement(ConversationHistory, {
        ...props,
        messages,
        workflows,
        state: { ...props.state, workflows },
      }),
    );
  const html = render(tasks);
  assert.doesNotMatch(
    html,
    /workflow-a|workflow-b|reply-a|reply-b|Old system failure|结果未确认|已创建续接任务|查看后续任务|system-notice/,
  );
  assert.match(html, /Question/);
  assert.match(html, /Final answer/);
  // A cyclic chain cannot retire anything.
  for (const invalid of [
    [tasks[0]!, { ...tasks[1]!, followUp: { workflowId: 'a', kind: 'continue' as const, at: stamp } }, tasks[2]!],
  ])
    assert.match(render(invalid), /id="workflow-a"/);
  // Without the final task the latest existing attempt stays visible and only earlier ones are hidden.
  for (const partial of [
    tasks.slice(0, 2),
    [...tasks.slice(0, 2), { ...tasks[2]!, deletedAt: stamp }],
    [...tasks.slice(0, 2), { ...tasks[2]!, conversationId: 'foreign' }],
    [tasks[0]!, { ...tasks[1]!, followUp: { workflowId: 'c', kind: 'message' as const, at: stamp } }, tasks[2]!],
  ]) {
    const html = render(partial);
    assert.doesNotMatch(html, /id="workflow-a"/);
    assert.match(html, /id="workflow-b"/);
  }
});

for (const [label, patch, supplement] of [
  ['empty', { resumed: true, content: '' }, ''],
  ['typed', { resumed: true, content: '再查一下 Mooncake' }, '再查一下 Mooncake'],
  [
    'legacy',
    {
      content:
        '继续同一任务。保留的原始需求：\nOriginal\n\n用户补充（按时间先后）：\n无\n\n已有步骤状态：\nfailed\n不得直接重放。',
    },
    '',
  ],
  [
    'legacy typed',
    { content: '继续原任务：Original\n\n当前补充（优先）：\n再查一下 Mooncake\n\n已有步骤状态：\nfailed' },
    '再查一下 Mooncake',
  ],
  ['swarm', { content: '继续同一蜂群任务：\nOriginal\n\n先检查已完成的产物和操作记录，只在原授权范围内处理。' }, ''],
] as const) {
  test(`resumed history ${label}: no marker and only actual user words`, () => {
    const html = renderToStaticMarkup(
      createElement(ConversationHistory, {
        messages: [{ ...message('resume'), ...patch }],
        workflows: [],
        state: { targets: [], runtimes: [], runs: [], workflows: [], settings: {} } as unknown as AppState,
        api: async () => {
          throw new Error('Unexpected API request');
        },
        notify: () => {},
        onInspect: () => {},
      }),
    );
    assert.doesNotMatch(html, /resume-divider|从中断处继续/);
    assert.doesNotMatch(html, /已有步骤状态|Original|不得直接重放|继续同一任务|继续原任务|继续同一蜂群任务/);
    assert.equal(html.includes('class="conversation-message message-user'), !!supplement);
    if (supplement) assert.ok(html.includes(supplement));
    else assert.equal(html, '<div class="message-list"></div>');
  });
}

test('reasoning headlines advance only after a paragraph first line finishes', () => {
  assert.equal(reasoningPreview('Partial', true), '');
  assert.equal(reasoningPreview('\n  Partial', true), '');
  assert.equal(reasoningPreview('**First**\nBody\n\nPar', true), 'First');
  assert.equal(reasoningPreview('**First**\nBody\n\nParagraph\nMore body', true), 'Paragraph');
  assert.equal(reasoningPreview('**Final**', false), 'Final');
});

test('turn status resolves card names, deduplicates and falls back to runtime id', () => {
  const task = workflow('names', { status: 'completed' });
  const records = [run('a', task.id), run('b', task.id), run('c', task.id)];
  records[0].account = { label: 'Account card' } as RunRecord['account'];
  records[2].route = { ...records[2].route, runtimeId: 'unknown' };
  const props = {
    workflow: task,
    runs: records,
    targets: [{ id: 'grok', label: 'Target card' }],
    projection: { version: 1 as const, workflowId: task.id, needsDetail: false, items: [] },
    loadDetail: async () => ({ version: 1 as const, workflowId: task.id, needsDetail: false, items: [] }),
    inspect() {},
    renderText: (value: string) => value,
  };
  const html = renderToStaticMarkup(createElement(ConversationTurn, props));
  assert.match(html, /Account card.*Target card.*unknown/);
  assert.doesNotMatch(html, /grok(?!-4)/);
  const repeated = renderToStaticMarkup(
    createElement(ConversationTurn, { ...props, targets: [{ id: 'grok', label: 'Account card' }] }),
  );
  assert.equal(repeated.split('Account card').length - 1, 1);
});
