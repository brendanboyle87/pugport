import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Workspace } from '../src/server/workspace.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { pinnedMessageStatus } from '../src/shared/pinned-messages.ts';
import type { BackgroundTask, Conversation, ConversationMessage, Workflow } from '../src/shared/types.ts';

const at = '2026-10-07T00:00:00.000Z';
const conversation = (id = 'c'): Conversation => ({ id, projectId: 'p', title: id, createdAt: at, updatedAt: at });
const message = (id = 'm', conversationId = 'c', workflowId?: string): ConversationMessage => ({
  id,
  conversationId,
  ...(workflowId ? { workflowId } : {}),
  role: 'user',
  content: 'Synthetic message to follow up',
  createdAt: at,
});
const workflow = (id = 'w', status: Workflow['status'] = 'running', conversationId = 'c'): Workflow => ({
  id,
  conversationId,
  projectId: 'p',
  userMessageId: 'm',
  status,
  phase: 'execute',
  input: { content: 'Synthetic work', mode: 'chat', permissionMode: 'read-only', executionPolicy: 'cli-only' },
  plan: [],
  runIds: [],
  memoryRevision: 0,
  memoryExcerpt: '',
  createdAt: at,
  updatedAt: at,
});
function fixture() {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-message-pin-')));
  const file = join(directory, 'isolated.sqlite');
  let db = new DatabaseSync(file);
  let broadcasts = 0;
  const instance = () => {
    const store = new WorkspaceStore(db, { recoverInterrupted: false });
    // Exercise real Workspace methods and broadcasts without constructing account, memory or agent services.
    const workspace = Object.create(Workspace.prototype) as Workspace;
    Object.assign(workspace, {
      store,
      clock: () => Date.parse(at) + 1000,
      tastes: { list: () => [] },
      folderAvailability: new Map(),
      controller: { broadcast: () => broadcasts++ },
    });
    return workspace;
  };
  let workspace = instance();
  workspace.store.save('project', 'p', 'p', {
    id: 'p',
    name: 'Synthetic',
    path: directory,
    createdAt: at,
    updatedAt: at,
  });
  workspace.store.save('conversation', 'c', 'p', conversation());
  return {
    get workspace() {
      return workspace;
    },
    get broadcasts() {
      return broadcasts;
    },
    restart() {
      db.close();
      db = new DatabaseSync(file);
      workspace = instance();
    },
    close() {
      db.close();
      assert.ok(directory.startsWith(realpathSync.native(tmpdir()) + sep));
      assert.ok(basename(directory).startsWith('pugport-message-pin-'));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('message pins and human follow-up status persist independently of sidebar pins, project and activity', () => {
  const f = fixture();
  try {
    f.workspace.store.save('message', 'm', 'c', message());
    f.workspace.pinConversation('c', true);
    const pinned = f.workspace.pinMessage('c', 'm', { pinned: true });
    assert.equal(pinned.pinnedMessages!.length, 1);
    assert.equal(pinned.pinnedMessages![0]!.followUpStatus, 'todo');
    assert.equal(pinned.pinnedMessagesRevision, 1);
    const pinnedAt = pinned.pinnedMessages![0]!.pinnedAt;
    const sidebarAt = pinned.pinnedAt;
    const broadcasts = f.broadcasts;
    assert.equal(f.workspace.pinMessage('c', 'm', { pinned: true }).pinnedMessages![0]!.pinnedAt, pinnedAt);
    assert.equal(f.broadcasts, broadcasts, 'repeated pinning does not create updates or reorder the item');
    f.workspace.pinMessage('c', 'm', { followUpStatus: 'waiting' });
    assert.equal(f.workspace.store.get<Conversation>('conversation', 'c')!.pinnedMessagesRevision, 2);
    const afterWaiting = f.broadcasts;
    assert.equal(
      f.workspace.pinMessage('c', 'm', { followUpStatus: 'waiting', tracking: 'follow-up' }).pinnedMessagesRevision,
      2,
    );
    assert.equal(f.broadcasts, afterWaiting, 'identical explicit status/mode is also idempotent');
    f.restart();
    const saved = f.workspace.store.get<Conversation>('conversation', 'c')!;
    assert.equal(saved.pinnedAt, sidebarAt);
    assert.equal(saved.pinnedMessages![0]!.pinnedAt, pinnedAt);
    assert.equal(saved.pinnedMessages![0]!.followUpStatus, 'waiting');
    assert.equal(saved.pinnedMessagesRevision, 2);
    assert.equal(saved.projectId, 'p');
    assert.equal(saved.updatedAt, at, 'pinning is not new chat activity');
    assert.deepEqual(f.workspace.store.allMessages('c'), [message()], 'pinning does not alter the transcript');
    assert.deepEqual(f.workspace.store.conversationWorkflows('c'), [], 'pinning creates no agent work');
    f.workspace.pinMessage('c', 'm', { followUpStatus: 'done' });
    assert.equal(f.workspace.store.get<Conversation>('conversation', 'c')!.pinnedMessages![0]!.followUpStatus, 'done');
    const unpinned = f.workspace.pinMessage('c', 'm', { pinned: false });
    assert.equal(unpinned.pinnedMessages, undefined);
    assert.equal(unpinned.pinnedMessagesRevision, 4);
    assert.equal(f.workspace.pinMessage('c', 'm', { pinned: false }).pinnedMessagesRevision, 4);
    assert.equal(unpinned.pinnedAt, sidebarAt);
    assert.deepEqual(f.workspace.store.allMessages('c'), [message()]);
  } finally {
    f.close();
  }
});

test('pinning rejects cross-conversation and deleted-chat references, while missing old pins can be removed', () => {
  const f = fixture();
  try {
    f.workspace.store.save('conversation', 'other', 'p', conversation('other'));
    f.workspace.store.save('message', 'foreign', 'other', message('foreign', 'other'));
    assert.throws(() => f.workspace.pinMessage('c', 'foreign', { pinned: true }), /不属于/);
    assert.throws(() => f.workspace.pinMessage('c', 'missing', { pinned: true }), /不属于/);
    f.workspace.store.save('conversation', 'c', 'p', {
      ...conversation(),
      pinnedMessages: [{ messageId: 'missing', pinnedAt: at }],
    });
    assert.equal(f.workspace.pinMessage('c', 'missing', { pinned: false }).pinnedMessages, undefined);
    f.workspace.store.save('conversation', 'c', 'p', { ...conversation(), deletedAt: at });
    assert.throws(() => f.workspace.pinMessage('c', 'foreign', { pinned: false }), /已删除/);
    assert.equal(f.workspace.store.get<Conversation>('conversation', 'other')!.pinnedMessages, undefined);
  } finally {
    f.close();
  }
});

test('removed projects hide pinned conversations and refuse pin edits until restored', () => {
  const f = fixture();
  try {
    f.workspace.store.save('message', 'm', 'c', message());
    const pinned = f.workspace.pinMessage('c', 'm', { pinned: true });
    const project = f.workspace.store.projects()[0]!;
    f.workspace.store.removeProject(project.id);
    assert.throws(() => f.workspace.pinMessage('c', 'm', { followUpStatus: 'done' }), /已删除/);
    assert.ok(!f.workspace.state().conversations!.some((value) => value.id === 'c'));
    assert.deepEqual(f.workspace.store.get<Conversation>('conversation', 'c')!.pinnedMessages, pinned.pinnedMessages);
    f.workspace.store.restoreProject(project.id);
    assert.equal(
      f.workspace.pinMessage('c', 'm', { followUpStatus: 'waiting' }).pinnedMessages![0]!.followUpStatus,
      'waiting',
    );
  } finally {
    f.close();
  }
});

test('actual workflow status cannot be manually overwritten, including legacy canonical message pointers', () => {
  const f = fixture();
  try {
    f.workspace.store.save('message', 'm', 'c', message());
    f.workspace.store.save('workflow', 'w', 'c', workflow('w', 'waiting-confirmation'));
    const saved = f.workspace.pinMessage('c', 'm', { pinned: true });
    assert.equal(saved.pinnedMessages![0]!.followUpStatus, undefined);
    assert.throws(() => f.workspace.pinMessage('c', 'm', { followUpStatus: 'done' }), /不能手动覆盖/);
    assert.equal(f.workspace.store.get<Workflow>('workflow', 'w')!.status, 'waiting-confirmation');
    assert.equal(
      pinnedMessageStatus(saved.pinnedMessages![0]!, message(), [workflow('w', 'running')]).status,
      'running',
    );
    f.workspace.store.save('message', 'linked', 'c', message('linked', 'c', 'w'));
    f.workspace.pinMessage('c', 'linked', { pinned: true });
    assert.throws(() => f.workspace.pinMessage('c', 'linked', { followUpStatus: 'waiting' }), /不能手动覆盖/);
    assert.equal(f.workspace.store.conversationWorkflows('c').length, 1);
  } finally {
    f.close();
  }
});

test('explicit follow-up mode survives restart and switches back to real task tracking without changing execution', () => {
  const f = fixture();
  try {
    const original = workflow('w', 'completed');
    f.workspace.store.save('message', 'm', 'c', message('m', 'c', 'w'));
    f.workspace.store.save('workflow', 'w', 'c', original);
    const saved = f.workspace.pinMessage('c', 'm', { pinned: true });
    assert.equal(saved.pinnedMessages![0]!.tracking, 'task');
    const changed = f.workspace.pinMessage('c', 'm', { tracking: 'follow-up', followUpStatus: 'waiting' });
    assert.equal(changed.pinnedMessages![0]!.tracking, 'follow-up');
    assert.equal(changed.pinnedMessages![0]!.followUpStatus, 'waiting');
    assert.deepEqual(f.workspace.store.get<Workflow>('workflow', 'w'), original);
    f.restart();
    const pin = f.workspace.store.get<Conversation>('conversation', 'c')!.pinnedMessages![0]!;
    assert.equal(pin.tracking, 'follow-up');
    const manual = pinnedMessageStatus(pin, message('m', 'c', 'w'), [original]);
    assert.equal(manual.source, 'manual');
    assert.equal(manual.status, 'waiting');
    assert.equal(manual.workflowId, 'w', 'real task remains inspectable while this separate follow-up waits');
    const tracked = f.workspace.pinMessage('c', 'm', { tracking: 'task' }).pinnedMessages![0]!;
    assert.equal(tracked.followUpStatus, undefined);
    assert.equal(pinnedMessageStatus(tracked, message('m', 'c', 'w'), [original]).status, 'done');
    assert.throws(() => f.workspace.pinMessage('c', 'm', { followUpStatus: 'waiting' }), /不能手动覆盖/);
    assert.deepEqual(f.workspace.store.get<Workflow>('workflow', 'w'), original);
  } finally {
    f.close();
  }
});

test('manual follow-up choices never complete or pause an associated running execution task', () => {
  const f = fixture();
  try {
    const original = workflow('w', 'running');
    f.workspace.store.save('message', 'm', 'c', message('m', 'c', 'w'));
    f.workspace.store.save('workflow', 'w', 'c', original);
    f.workspace.pinMessage('c', 'm', { pinned: true, tracking: 'follow-up', followUpStatus: 'done' });
    const saved = f.workspace.store.get<Conversation>('conversation', 'c')!.pinnedMessages![0]!;
    assert.equal(pinnedMessageStatus(saved, message('m', 'c', 'w'), [original]).status, 'done');
    assert.deepEqual(f.workspace.store.get<Workflow>('workflow', 'w'), original);
    const tracked = f.workspace.pinMessage('c', 'm', { tracking: 'task' }).pinnedMessages![0]!;
    const live = pinnedMessageStatus(tracked, message('m', 'c', 'w'), [original]);
    assert.equal(live.source, 'auto');
    assert.equal(live.status, 'running');
    assert.deepEqual(f.workspace.store.get<Workflow>('workflow', 'w'), original);
    assert.equal(f.workspace.store.conversationWorkflows('c').length, 1, 'no agent is submitted by either mode');
  } finally {
    f.close();
  }
});

test('old pinned workflows and their explicit continuations remain in local state outside the live history window', () => {
  const f = fixture();
  try {
    const first = {
      ...workflow('old', 'interrupted'),
      followUp: { workflowId: 'continued', kind: 'continue' as const, at },
    };
    const next = { ...workflow('continued', 'interrupted'), userMessageId: 'later-message' };
    f.workspace.store.save('message', 'm', 'c', message('m', 'c', 'old'));
    f.workspace.store.save('workflow', 'old', 'c', first);
    f.workspace.store.save('workflow', 'continued', 'c', next);
    f.workspace.pinMessage('c', 'm', { pinned: true });
    for (let index = 0; index < 205; index++) {
      const value = { ...workflow(`recent-${index}`, 'completed'), userMessageId: `recent-message-${index}` };
      f.workspace.store.save('workflow', value.id, 'c', value);
    }
    f.workspace.store.db.exec(
      "UPDATE workspace_records SET updated_at='2000-01-01' WHERE kind='workflow' AND id IN ('old','continued')",
    );
    assert.ok(!f.workspace.store.visibleWorkflows().some((value) => value.id === 'old'));
    const state = f.workspace.state();
    assert.ok(state.workflows!.some((value) => value.id === 'old'));
    assert.ok(state.workflows!.some((value) => value.id === 'continued'));
    assert.equal(
      pinnedMessageStatus(
        conversation().pinnedMessages?.[0] ?? { messageId: 'm', pinnedAt: at },
        message('m', 'c', 'old'),
        state.workflows!,
      ).workflowId,
      'continued',
    );
    f.workspace.pinMessage('c', 'm', { pinned: false });
    assert.ok(!f.workspace.state().workflows!.some((value) => value.id === 'old'));
  } finally {
    f.close();
  }
});

test('pin limits and invalid edits preserve existing pins and do not submit work', () => {
  const f = fixture();
  try {
    for (let index = 0; index < 21; index++) {
      const value = message(`m${index}`);
      f.workspace.store.save('message', value.id, 'c', value);
      if (index < 20) f.workspace.pinMessage('c', value.id, { pinned: true });
    }
    assert.throws(() => f.workspace.pinMessage('c', 'm20', { pinned: true }), /20 条/);
    assert.throws(() => f.workspace.pinMessage('c', 'm20', { followUpStatus: 'done' }), /请先置顶/);
    assert.throws(() => f.workspace.pinMessage('c', 'm0', { pinned: false, followUpStatus: 'done' }), /无需设置/);
    assert.throws(() => f.workspace.pinMessage('c', 'm0', {}), /请指定/);
    assert.equal(f.workspace.store.get<Conversation>('conversation', 'c')!.pinnedMessages!.length, 20);
    assert.deepEqual(f.workspace.store.conversationWorkflows('c'), []);
  } finally {
    f.close();
  }
});

test('ordinary message follow-up statuses remain manual and missing messages are not declared completed', () => {
  for (const [status, label] of [
    ['todo', '待跟进'],
    ['waiting', '等待确认'],
    ['done', '已完成'],
  ] as const) {
    const value = pinnedMessageStatus({ messageId: 'm', pinnedAt: at, followUpStatus: status }, message(), []);
    assert.equal(value.source, 'manual');
    assert.equal(value.status, status);
    assert.equal(value.label, label);
  }
  assert.equal(
    pinnedMessageStatus({ messageId: 'missing', pinnedAt: at, followUpStatus: 'done' }, undefined, []).source,
    'unknown',
  );
  assert.equal(
    pinnedMessageStatus({ messageId: 'm', pinnedAt: at, followUpStatus: 'done' }, message('m', 'c', 'missing'), [])
      .status,
    'unknown',
  );
});

test('live real-workflow records take precedence over a stale human marker and preserve waiting states', () => {
  const pin = { messageId: 'm', pinnedAt: at, followUpStatus: 'done' as const };
  const source = message('m', 'c', 'w');
  const cases: Array<[Workflow['status'], string, string]> = [
    ['queued', 'todo', '等待执行'],
    ['planning', 'running', '处理中'],
    ['running', 'running', '处理中'],
    ['waiting-confirmation', 'waiting', '等待确认'],
    ['waiting-approval', 'waiting', '等待确认'],
    ['waiting-resource', 'waiting', '等待资源'],
    ['interrupted', 'paused', '已暂停'],
    ['completed', 'done', '已完成'],
    ['failed', 'failed', '失败'],
    ['cancelled', 'cancelled', '已取消'],
  ];
  for (const [real, expected, label] of cases) {
    const value = pinnedMessageStatus(pin, source, [workflow('w', real)]);
    assert.equal(value.source, 'auto');
    assert.equal(value.status, expected);
    assert.equal(value.label, label);
    assert.equal(value.workflowId, 'w');
  }
  assert.equal(pinnedMessageStatus(pin, source, [{ ...workflow('w', 'blocked'), stopped: true }]).status, 'paused');
  assert.equal(pinnedMessageStatus(pin, source, [{ ...workflow('w', 'completed'), deletedAt: at }]).status, 'unknown');
  assert.equal(pinnedMessageStatus(pin, source, [workflow('w', 'running', 'foreign')]).source, 'unknown');
});

test('waiting local tasks expose current background progress without confusing disappearance with completion', () => {
  const pin = { messageId: 'm', pinnedAt: at };
  const source = message('m', 'c', 'w');
  const parent = {
    ...workflow('w', 'blocked'),
    waitingOn: { kind: 'media-analysis' as const, jobId: 'local', done: 2, total: 10 },
  };
  const task: BackgroundTask = {
    id: 'local',
    kind: 'media-analysis',
    conversationId: 'c',
    title: 'Local fixture',
    detail: '',
    done: 5,
    total: 10,
    startedAt: at,
    state: 'running',
    steps: [{ label: 'Fine verification', state: 'running', done: 5, total: 10 }],
  };
  const running = pinnedMessageStatus(pin, source, [parent], [task]);
  assert.equal(running.source, 'auto');
  assert.equal(running.status, 'running');
  assert.equal(running.detail, 'Fine verification');
  assert.equal(running.backgroundTask!.done, 5);
  assert.equal(pinnedMessageStatus(pin, source, [parent], [{ ...task, state: 'paused' }]).status, 'paused');
  assert.equal(pinnedMessageStatus(pin, source, [parent], []).source, 'unknown');
  assert.equal(pinnedMessageStatus(pin, source, [parent], [{ ...task, conversationId: 'foreign' }]).status, 'unknown');
  assert.equal(pinnedMessageStatus(pin, source, [{ ...parent, status: 'completed' }], [task]).status, 'done');
});

test('only explicit same-conversation continuation chains are followed and cycles remain unknown', () => {
  const pin = { messageId: 'm', pinnedAt: at };
  const source = message('m', 'c', 'w');
  const old = { ...workflow('w', 'blocked'), followUp: { workflowId: 'next', kind: 'continue' as const, at } };
  const next = workflow('next', 'running');
  assert.equal(pinnedMessageStatus(pin, source, [old, next]).workflowId, 'next');
  assert.equal(
    pinnedMessageStatus(pin, source, [{ ...old, followUp: { ...old.followUp, kind: 'message' } }, next]).workflowId,
    'w',
  );
  assert.equal(pinnedMessageStatus(pin, source, [old, { ...next, conversationId: 'foreign' }]).source, 'unknown');
  assert.equal(pinnedMessageStatus(pin, source, [old]).source, 'unknown');
  const cycle = { ...next, followUp: { workflowId: 'w', kind: 'continue' as const, at } };
  assert.equal(pinnedMessageStatus(pin, source, [old, cycle]).source, 'unknown');
});
