import { storedRuns } from './helpers/stored-runs.ts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { workflowNeedsUser } from '../src/shared/conversation-activity.ts';
import type { Conversation, ConversationMessage, Project, RunRecord, Workflow } from '../src/shared/types.ts';

const createdAt = '2026-09-26T12:00:00.000Z';

test('conversation child count uses durable records, deduplicates continuations and removes deleted or closed history', (t) => {
  const f = fixture(t);
  const chat = conversation();
  f.workspace.save('conversation', chat.id, chat.projectId, chat);
  const root = workflow('root', 'completed');
  const child = workflow('child', 'completed');
  child.delegation = { parentId: root.id, requestId: 'request-one', role: 'scout' };
  const continued = { ...child, id: 'child-v2', parentWorkflowId: child.id };
  for (const item of [root, child, continued]) f.workspace.save('workflow', item.id, chat.id, item);
  for (let i = 0; i < 210; i++)
    f.workspace.save(
      'workflow',
      `unrelated-${i}`,
      'elsewhere',
      workflow(`unrelated-${i}`, 'completed', chat.projectId, 'elsewhere'),
    );
  assert.equal(f.workspace.conversations()[0]!.delegationCount, 1);
  assert.equal(f.reopen().conversations()[0]!.delegationCount, 1);
  for (const item of [child, continued])
    f.workspace.save('workflow', item.id, chat.id, { ...item, archivedAt: createdAt });
  assert.equal(f.workspace.conversations()[0]!.delegationCount ?? 0, 0);
  assert.equal(f.workspace.conversations()[0]!.archivedDelegationCount, 1);
  assert.equal(f.reopen().conversations()[0]!.archivedDelegationCount, 1);
  for (const item of [child, continued]) f.workspace.save('workflow', item.id, chat.id, item);
  assert.equal(f.workspace.conversations()[0]!.delegationCount, 1);
  assert.equal(f.workspace.conversations()[0]!.archivedDelegationCount ?? 0, 0);
  for (const item of [child, continued])
    f.workspace.save('workflow', item.id, chat.id, { ...item, deletedAt: createdAt });
  assert.equal(f.workspace.conversations()[0]!.delegationCount ?? 0, 0);
  assert.equal(f.workspace.conversations()[0]!.archivedDelegationCount ?? 0, 0);
  f.workspace.save('conversation', chat.id, chat.projectId, { ...chat, incognito: true, closedAt: createdAt });
  assert.equal(f.workspace.conversations().length, 0);
});

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-studio-workspace-store-'));
  let store: Store | undefined = new Store(directory);
  let workspace = new WorkspaceStore(store.db);
  t.after(() => {
    store?.close();
    for (const name of ['studio.sqlite', 'studio.sqlite-wal', 'studio.sqlite-shm']) {
      const path = join(directory, name);
      if (existsSync(path)) unlinkSync(path);
    }
    rmdirSync(directory);
  });
  return {
    get store() {
      return store!;
    },
    get workspace() {
      return workspace;
    },
    reopen() {
      store?.close();
      store = undefined;
      store = new Store(directory);
      workspace = new WorkspaceStore(store.db);
      return workspace;
    },
  };
}

function project(id = 'project-one'): Project {
  return { id, name: `项目 ${id}`, path: `C:/projects/中文 space/${id}`, createdAt, updatedAt: createdAt };
}

function conversation(id = 'conversation-one', projectId = 'project-one'): Conversation {
  return { id, projectId, title: `对话 ${id}`, createdAt, updatedAt: createdAt };
}

function workflow(
  id: string,
  status: Workflow['status'],
  projectId = 'project-one',
  conversationId = 'conversation-one',
): Workflow {
  return {
    id,
    projectId,
    conversationId,
    userMessageId: `message-${id}`,
    input: {
      content: '继续创建项目，保留已有文件',
      mode: 'build',
      permissionMode: 'workspace-write',
      executionPolicy: 'cli-first',
      autoEscalate: true,
    },
    status,
    phase: status === 'planning' ? 'plan' : 'execute',
    plan: [
      {
        id: 'step-one',
        title: '检查项目',
        instruction: 'Read the existing project',
        kind: 'general',
        transport: 'auto',
        dependsOn: [],
        status: 'completed',
        runIds: ['run-finished'],
      },
      {
        id: 'step-two',
        title: '实现改动',
        instruction: 'Continue the approved changes',
        kind: 'architecture',
        transport: 'cli',
        dependsOn: ['step-one'],
        status: 'running',
        runIds: [`run-${id}`],
        acceptance: 'Existing tests pass',
      },
    ],
    activeStepId: 'step-two',
    runIds: ['run-finished', `run-${id}`],
    memoryRevision: 2,
    memoryExcerpt: '保持现有路径与主题设置。\nUse TypeScript.',
    createdAt,
    updatedAt: createdAt,
    parentWorkflowId: 'previous-workflow',
  };
}

test('the once-a-second idle checks ask the index, and agree with the visible tasks', (t) => {
  const f = fixture(t);
  const chat = conversation();
  f.workspace.save('conversation', chat.id, chat.projectId, chat);
  const plan = (sql: string) =>
    (f.workspace.db.prepare('EXPLAIN QUERY PLAN ' + sql).all() as { detail: string }[])
      .map((row) => row.detail)
      .join(' | ');
  // Each terminal state, and more finished history than the visible window holds.
  for (const status of ['completed', 'blocked', 'failed', 'cancelled', 'interrupted'] as const)
    f.workspace.save('workflow', status, chat.id, workflow(status, status));
  for (let i = 0; i < 210; i++) f.workspace.save('workflow', `old-${i}`, chat.id, workflow(`old-${i}`, 'completed'));
  assert.equal(f.workspace.hasUnfinishedWorkflow(), false);
  for (const status of [
    'queued',
    'waiting-resource',
    'planning',
    'running',
    'waiting-approval',
    'waiting-confirmation',
  ] as const) {
    f.workspace.save('workflow', 'live', chat.id, workflow('live', status));
    assert.equal(f.workspace.hasUnfinishedWorkflow(), true, status);
    // The check it replaces: any visible task that has not reached a terminal state.
    assert.equal(
      f.workspace
        .visibleWorkflows()
        .some((item) => !['completed', 'blocked', 'failed', 'cancelled', 'interrupted'].includes(item.status)),
      true,
      status,
    );
    // A deleted task is not waiting for anything.
    f.workspace.save('workflow', 'live', chat.id, { ...workflow('live', status), deletedAt: createdAt });
    assert.equal(f.workspace.hasUnfinishedWorkflow(), false, status);
  }
  assert.equal(f.reopen().hasUnfinishedWorkflow(), false);
  assert.match(
    plan(
      "SELECT 1 FROM workspace_records WHERE kind='workflow' AND json_extract(value,'$.status') IN ('queued','running') AND json_extract(value,'$.deletedAt') IS NULL LIMIT 1",
    ),
    /USING INDEX workspace_status/,
  );
  // The queue's fact-check question is answered from its own index instead of reading every task.
  assert.match(
    plan(`SELECT value FROM workspace_records WHERE kind='workflow'
      AND json_extract(value,'$.review.status')='reviewing'
      AND json_extract(value,'$.review.factCheck') IS NOT NULL`),
    /USING INDEX workspace_fact_check/,
  );
});

test('project memory searches never import another side chat, but a side chat retains its own records', (t) => {
  const f = fixture(t);
  const main = conversation();
  const side: Conversation = {
    ...conversation('side-one'),
    sideChat: { parentConversationId: main.id, context: '', selection: { executionPolicy: 'cli-only' } },
  };
  const sibling: Conversation = { ...side, id: 'side-two' };
  for (const value of [main, side, sibling]) f.workspace.save('conversation', value.id, value.projectId, value);
  const privateOne = f.workspace.addMessage(side.id, 'assistant', 'SIDE_EVIDENCE_ONE D:\\side-one');
  const privateTwo = f.workspace.addMessage(sibling.id, 'assistant', 'SIDE_EVIDENCE_TWO D:\\side-two');
  const firstAnchor = f.workspace.addMessage(main.id, 'user', 'Evidence');
  assert.equal(f.workspace.hasMemorySources(main.projectId, main.id, firstAnchor.id), false);
  assert.deepEqual(f.workspace.searchMemory(main.projectId, main.id, firstAnchor.id, ['SIDE_EVIDENCE']), []);
  assert.deepEqual(f.workspace.memoryPathSources(main.projectId, main.id, firstAnchor.id), []);
  const publicRecord = f.workspace.addMessage(main.id, 'assistant', 'MAIN_EVIDENCE D:\\main');
  const sideAnchor = f.workspace.addMessage(side.id, 'user', 'Evidence');
  const hits = f.workspace.searchMemory(main.projectId, side.id, sideAnchor.id, ['EVIDENCE']);
  assert.ok(hits.some((hit) => hit.messageId === privateOne.id));
  assert.ok(hits.some((hit) => hit.messageId === publicRecord.id));
  assert.ok(!hits.some((hit) => hit.messageId === privateTwo.id));
  const paths = f.workspace.memoryPathSources(main.projectId, side.id, sideAnchor.id);
  assert.ok(paths.some((hit) => hit.messageId === privateOne.id));
  assert.ok(paths.some((hit) => hit.messageId === publicRecord.id));
  assert.ok(!paths.some((hit) => hit.messageId === privateTwo.id));
  assert.equal(f.workspace.allMessages(side.id)[0]?.id, privateOne.id, 'isolation must preserve side history');
});

test('project worklog filters old side-chat rows and never adds new side-chat summaries', (t) => {
  const f = fixture(t);
  const main = conversation();
  const side: Conversation = {
    ...conversation('side-one'),
    sideChat: { parentConversationId: main.id, context: '', selection: { executionPolicy: 'cli-only' } },
  };
  for (const value of [main, side]) f.workspace.save('conversation', value.id, value.projectId, value);
  const mainWork = workflow('main-work', 'completed');
  const sideWork = workflow('side-work', 'completed', main.projectId, side.id);
  for (const value of [mainWork, sideWork]) f.workspace.save('workflow', value.id, value.conversationId, value);
  f.workspace.addWorklog(mainWork, 'MAIN_VISIBLE');
  f.workspace.save('worklog', sideWork.id, main.projectId, {
    workflowId: sideWork.id,
    summary: 'OLD_SIDE_PRIVATE',
    at: createdAt,
  });
  assert.deepEqual(
    f.workspace.worklog(main.projectId).map((row) => row.summary),
    ['MAIN_VISIBLE'],
  );
  f.workspace.addWorklog(sideWork, 'NEW_SIDE_PRIVATE');
  assert.equal(f.workspace.get<{ summary: string }>('worklog', sideWork.id)?.summary, 'OLD_SIDE_PRIVATE');
  assert.deepEqual(
    f.workspace.worklog(main.projectId).map((row) => row.summary),
    ['MAIN_VISIBLE'],
  );
});

test('deleted conversation worklogs leave new and queued memory, and return on restore', (t) => {
  const f = fixture(t);
  const source = conversation();
  const reader = conversation('reader');
  for (const value of [source, reader]) f.workspace.save('conversation', value.id, value.projectId, value);
  const finished = workflow('source-work', 'completed');
  f.workspace.save('workflow', finished.id, source.id, finished);
  f.workspace.addWorklog(finished, 'SYNTHETIC_DELETED_WORKLOG_SECRET');
  const logs = f.workspace.worklog(source.projectId);
  assert.equal(logs.length, 1);
  const queued = {
    ...workflow('queued-before-delete', 'queued', source.projectId, reader.id),
    memoryExcerpt:
      'SAFE_PROJECT_RULES\n\n此前工作的可见记录（可能包含未核验的模型陈述，只作参考）：\n' +
      logs.map((log) => `[${log.at}] ${log.summary}`).join('\n\n'),
  };
  assert.match(f.workspace.trustedMemoryExcerpt(queued), /SYNTHETIC_DELETED_WORKLOG_SECRET/);
  f.workspace.deleteConversation(source.id);
  assert.ok(f.workspace.get<Conversation>('conversation', source.id)?.deletedAt);
  assert.deepEqual(
    f.workspace.conversations(source.projectId).map((value) => value.id),
    [reader.id],
  );
  assert.deepEqual(f.workspace.worklog(reader.projectId), []);
  assert.equal(f.workspace.trustedMemoryExcerpt(queued), 'SAFE_PROJECT_RULES');
  assert.ok(f.workspace.get('worklog', finished.id), 'Keep the summary for restoration');
  f.workspace.restoreConversation(source.id);
  assert.deepEqual(f.workspace.worklog(reader.projectId), logs);
  assert.equal(f.workspace.trustedMemoryExcerpt(queued), queued.memoryExcerpt);
});

test('restart backfills only assistant replies of explicitly untrusted workflows and filters their old worklogs', (t) => {
  const f = fixture(t);
  f.workspace.db
    .prepare("DELETE FROM workspace_records WHERE kind='migration' AND id='third-party-reply-provenance-v1'")
    .run();
  const main = conversation();
  f.workspace.save('conversation', main.id, main.projectId, main);
  const tainted = workflow('quoted-work', 'completed');
  tainted.input.untrustedContent = true;
  tainted.input.untrustedQuotesOnly = true;
  const trusted = workflow('coordinated-work', 'completed');
  trusted.plan.push({ ...trusted.plan[0]!, id: 'combine-web-replies', runIds: ['combined-run'] });
  for (const item of [tainted, trusted]) f.workspace.save('workflow', item.id, main.id, item);
  const legacy = (role: ConversationMessage['role'], work: Workflow, content: string) => {
    const message = f.workspace.addMessage(main.id, role, content, work.id);
    delete message.untrustedContent;
    f.workspace.save('message', message.id, main.id, message);
    return message;
  };
  const user = legacy('user', tainted, 'SAFE_TYPED_QUESTION');
  const reply = legacy('assistant', tainted, 'LEGACY_DERIVED_REPLY');
  const failure = legacy('assistant', tainted, 'LEGACY_DERIVED_ERROR');
  const coordinator = legacy('assistant', trusted, 'SAFE_COORDINATOR_REPLY');
  const oldSides = ['explicit', 'legacy'].map((kind) => {
    const side: Conversation = {
      ...conversation(`old-side-${kind}`),
      sideChat: {
        parentConversationId: main.id,
        anchorMessageId: reply.id,
        ...(kind === 'explicit' ? { quote: reply.content } : {}),
        context: `用户选中的引用（参考内容）：\n<quoted_text>\n${reply.content}\n</quoted_text>`,
        selection: { executionPolicy: 'cli-first' },
      },
    };
    f.workspace.save('conversation', side.id, main.projectId, side);
    const sideWork = workflow(`work-${side.id}`, 'queued', main.projectId, side.id);
    f.workspace.save('workflow', sideWork.id, side.id, sideWork);
    const answer = f.workspace.addMessage(side.id, 'assistant', 'OLD_SIDE_DERIVED_REPLY', sideWork.id);
    delete answer.untrustedContent;
    f.workspace.save('message', answer.id, side.id, answer);
    return { side, sideWork, answer };
  });
  f.workspace.save('worklog', tainted.id, main.projectId, {
    workflowId: tainted.id,
    summary: 'LEGACY_DERIVED_REPLY',
    at: createdAt,
  });
  const queued = workflow('queued-before-backfill', 'queued');
  queued.memoryExcerpt = `SAFE_PROJECT_RULES\n\n此前工作的可见记录（可能包含未核验的模型陈述，只作参考）：\n[${createdAt}] LEGACY_DERIVED_REPLY`;
  f.workspace.save('workflow', queued.id, main.id, queued);
  f.workspace.addWorklog(trusted, 'SAFE_COORDINATOR_REPLY');
  const reopened = f.reopen();
  for (const message of [reply, failure]) {
    const saved = reopened.get<ConversationMessage>('message', message.id)!;
    assert.equal(saved.untrustedContent, true);
    assert.equal(saved.content, message.content);
  }
  for (const message of [user, coordinator])
    assert.equal(reopened.get<ConversationMessage>('message', message.id)!.untrustedContent, undefined);
  assert.equal(reopened.get<Conversation>('conversation', main.id)!.untrustedContent, undefined);
  assert.deepEqual(
    reopened.worklog(main.projectId).map((entry) => entry.summary),
    ['SAFE_COORDINATOR_REPLY'],
  );
  assert.equal(reopened.get<{ summary: string }>('worklog', tainted.id)!.summary, 'LEGACY_DERIVED_REPLY');
  assert.equal(reopened.trustedMemoryExcerpt(queued), 'SAFE_PROJECT_RULES');
  assert.equal(reopened.trustedMemoryExcerpt(trusted), trusted.memoryExcerpt);
  const safeWorklog = { ...queued, memoryExcerpt: queued.memoryExcerpt.replace('LEGACY_DERIVED_REPLY', 'SAFE_REPLY') };
  assert.equal(reopened.trustedMemoryExcerpt(safeWorklog), safeWorklog.memoryExcerpt);
  assert.equal(
    reopened.trustedMemoryExcerpt({ ...queued, memoryExcerpt: queued.memoryExcerpt.slice(0, -8) }),
    'SAFE_PROJECT_RULES',
  );
  assert.equal(
    reopened.trustedMemoryExcerpt({
      ...queued,
      memoryExcerpt: queued.memoryExcerpt.slice('SAFE_PROJECT_RULES\n\n'.length),
    }),
    '',
  );
  for (const { side, sideWork, answer } of oldSides) {
    assert.equal(reopened.get<Conversation>('conversation', side.id)!.untrustedContent, true);
    assert.equal(reopened.untrustedWorkflow(sideWork), true);
    assert.equal(reopened.get<ConversationMessage>('message', answer.id)!.untrustedContent, true);
  }
  reopened.addWorklog(tainted, 'NEW_DERIVED_REPLY');
  assert.equal(reopened.get<{ summary: string }>('worklog', tainted.id)!.summary, 'LEGACY_DERIVED_REPLY');
  const anchor = reopened.addMessage(main.id, 'user', '再问');
  assert.ok(!reopened.contextMessages(main.id, anchor.id).some((message) => message.id === reply.id));
  assert.deepEqual(reopened.searchMemory(main.projectId, main.id, anchor.id, ['LEGACY_DERIVED']), []);
  const before = reopened.get<ConversationMessage>('message', reply.id);
  assert.deepEqual(f.reopen().get<ConversationMessage>('message', reply.id), before, 'backfill is idempotent');
});

test('restart marks messages typed in PugPort before human-message records existed, and only once', (t) => {
  const f = fixture(t);
  f.workspace.db
    .prepare("DELETE FROM workspace_records WHERE kind='migration' AND id='human-message-backfill-v1'")
    .run();
  const main = conversation();
  f.workspace.save('conversation', main.id, main.projectId, main);
  const typed = workflow('typed-work', 'completed');
  const dispatched = workflow('dispatched-work', 'completed');
  dispatched.input.permissionOrigin = { mode: 'read-only', source: 'external' };
  for (const item of [typed, dispatched]) f.workspace.save('workflow', item.id, main.id, item);
  const own = f.workspace.addMessage(main.id, 'user', 'SYNTHETIC_OWNER_WORDS', typed.id);
  f.workspace.addMessage(main.id, 'user', 'SYNTHETIC_AGENT_TASK', dispatched.id);
  f.workspace.addMessage(main.id, 'assistant', 'SYNTHETIC_REPLY', typed.id);
  const ids = (store: WorkspaceStore) => store.list<{ id: string }>('human-message', main.id).map((item) => item.id);
  const reopened = f.reopen();
  assert.deepEqual(ids(reopened), [own.id]);
  reopened.addMessage(main.id, 'user', 'SYNTHETIC_LATER_WORDS', typed.id);
  assert.deepEqual(ids(f.reopen()), [own.id], 'the completed backfill does not run again');
});

test('dispatch backfill marks named callers and first external messages while preserving owner and Slack conversations', (t) => {
  const f = fixture(t);
  f.workspace.db
    .prepare(
      "DELETE FROM workspace_records WHERE kind='migration' AND id IN ('dispatch-mark-backfill-v1','human-message-backfill-v1')",
    )
    .run();
  const cases: {
    id: string;
    caller?: string;
    source?: NonNullable<Workflow['input']['permissionOrigin']>['source'];
    humanFirst?: boolean;
    explicitHuman?: boolean;
    expected: boolean;
  }[] = [
    { id: 'named', caller: 'Codex', expected: true },
    { id: 'external', source: 'external', expected: true },
    { id: 'caller', caller: '', source: 'caller', expected: true },
    { id: 'device', source: 'device', expected: true },
    { id: 'human-first', source: 'external', humanFirst: true, expected: false },
    { id: 'human-marked', source: 'external', explicitHuman: true, expected: false },
    { id: 'slack', caller: 'slack:synthetic-channel', source: 'external', expected: false },
    { id: 'ordinary', expected: false },
    { id: 'owner-origin', source: 'user', expected: false },
  ];
  for (const item of cases) {
    const chat = conversation(item.id);
    chat.title = `外部 AI · ${item.id}`;
    f.workspace.save('conversation', chat.id, chat.projectId, chat);
    f.workspace.save('external-conversation', chat.id, chat.id, { conversationId: chat.id, caller: item.caller });
    if (item.humanFirst) {
      const own = workflow(`${item.id}-own`, 'completed', chat.projectId, chat.id);
      f.workspace.save('workflow', own.id, chat.id, own);
      f.workspace.addMessage(chat.id, 'user', 'SYNTHETIC_OWNER_FIRST', own.id);
    }
    const task = workflow(`${item.id}-task`, 'completed', chat.projectId, chat.id);
    if (item.source) task.input.permissionOrigin = { mode: 'read-only', source: item.source };
    f.workspace.save('workflow', task.id, chat.id, task);
    const message = f.workspace.addMessage(chat.id, 'user', 'SYNTHETIC_TASK', task.id);
    if (item.explicitHuman) f.workspace.save('human-message', message.id, chat.id, { id: message.id });
    // Migration uses insertion order, not a user-controlled message timestamp.
    message.createdAt = '2020-01-01T00:00:00.000Z';
    f.workspace.save('message', message.id, chat.id, message);
  }
  const reopened = f.reopen();
  for (const item of cases)
    assert.equal(
      reopened.get<{ dispatched?: true }>('external-conversation', item.id)?.dispatched === true,
      item.expected,
      item.id,
    );
});

test('dispatch backfill does not mark an owner-created empty conversation followed by an external caller', (t) => {
  const f = fixture(t);
  f.workspace.db
    .prepare("DELETE FROM workspace_records WHERE kind='migration' AND id='dispatch-mark-backfill-v1'")
    .run();
  const chat = conversation('owner-empty');
  f.workspace.save('conversation', chat.id, chat.projectId, chat);
  f.workspace.save('external-conversation', chat.id, chat.id, { conversationId: chat.id });
  const task = workflow('external-follow', 'completed', chat.projectId, chat.id);
  task.input.permissionOrigin = { mode: 'read-only', source: 'external' };
  f.workspace.save('workflow', task.id, chat.id, task);
  f.workspace.addMessage(chat.id, 'user', 'SYNTHETIC_EXTERNAL_FOLLOW', task.id);
  assert.equal(f.reopen().get<{ dispatched?: true }>('external-conversation', chat.id)?.dispatched, undefined);
});

test('dispatch backfill completes once and preserves existing collection metadata', (t) => {
  const f = fixture(t);
  const migrationId = 'dispatch-mark-backfill-v1';
  f.workspace.db.prepare("DELETE FROM workspace_records WHERE kind='migration' AND id=?").run(migrationId);
  const record = { conversationId: 'legacy', caller: 'Terminal', collectedTaskId: 'task', collectedAt: createdAt };
  f.workspace.save('external-conversation', 'legacy', 'legacy', record);
  const reopened = f.reopen();
  assert.deepEqual(reopened.get('external-conversation', 'legacy'), { ...record, dispatched: true });
  assert.deepEqual(reopened.get('migration', migrationId), { completed: true });
  reopened.save('external-conversation', 'later', 'later', { conversationId: 'later', caller: 'Codex' });
  const again = f.reopen();
  assert.equal(again.get<{ dispatched?: true }>('external-conversation', 'later')?.dispatched, undefined);
  assert.deepEqual(again.get('external-conversation', 'legacy'), { ...record, dispatched: true });
});

test('third-party backfill retries an interrupted migration and skips its scans after the first completion', (t) => {
  const f = fixture(t);
  const db = f.workspace.db;
  const migrationId = 'third-party-reply-provenance-v1';
  db.prepare("DELETE FROM workspace_records WHERE kind='migration' AND id=?").run(migrationId);
  const main = conversation();
  f.workspace.save('conversation', main.id, main.projectId, main);
  const tainted = workflow('legacy-quoted-work', 'completed');
  tainted.input.untrustedContent = true;
  f.workspace.save('workflow', tainted.id, main.id, tainted);
  const reply = f.workspace.addMessage(main.id, 'assistant', 'LEGACY_DERIVED_REPLY', tainted.id);
  delete reply.untrustedContent;
  f.workspace.save('message', reply.id, main.id, reply);
  const before = db
    .prepare("SELECT value,updated_at FROM workspace_records WHERE kind='message' AND id=?")
    .get(reply.id);
  const prepare = db.prepare.bind(db);
  const failure = t.mock.method(db, 'prepare', (sql: string) => {
    if (sql.startsWith("SELECT value FROM workspace_records WHERE kind='conversation'"))
      throw new Error('synthetic migration interruption');
    return prepare(sql);
  });
  assert.throws(() => new WorkspaceStore(db, { recoverInterrupted: false }), /synthetic migration interruption/);
  failure.mock.restore();
  assert.equal(f.workspace.get('migration', migrationId), undefined);
  assert.deepEqual(
    db.prepare("SELECT value,updated_at FROM workspace_records WHERE kind='message' AND id=?").get(reply.id),
    before,
  );

  const first = new WorkspaceStore(db, { recoverInterrupted: false });
  assert.equal(first.get<ConversationMessage>('message', reply.id)!.untrustedContent, true);
  assert.deepEqual(first.get('migration', migrationId), { completed: true });
  const after = db
    .prepare("SELECT value,updated_at FROM workspace_records WHERE kind='message' AND id=?")
    .get(reply.id);
  const later = t.mock.method(db, 'prepare', (sql: string) => prepare(sql));
  new WorkspaceStore(db, { recoverInterrupted: false });
  assert.ok(
    !later.mock.calls.some(
      ({ arguments: [sql] }) =>
        (sql.startsWith('UPDATE workspace_records') && sql.includes('$.untrustedContent')) ||
        sql.startsWith("SELECT value FROM workspace_records WHERE kind='conversation'"),
    ),
  );
  assert.deepEqual(
    db.prepare("SELECT value,updated_at FROM workspace_records WHERE kind='message' AND id=?").get(reply.id),
    after,
  );
});

test('projects, conversations, messages, memory and worklogs survive a complete database reopen', (t) => {
  const f = fixture(t);
  const projects = [project(), project('project-two')];
  const conversations = [conversation(), conversation('conversation-two', 'project-two')];
  for (const value of projects) f.workspace.save('project', value.id, value.id, value);
  for (const value of conversations) f.workspace.save('conversation', value.id, value.projectId, value);
  const userMessage = f.workspace.addMessage('conversation-one', 'user', '请创建一个黑白主题界面 🌗', 'completed-one');
  const assistantMessage = f.workspace.addMessage(
    'conversation-one',
    'assistant',
    '已创建文件。\n测试通过。',
    'completed-one',
  );
  assistantMessage.createdAt = '2026-09-26T12:01:00.000Z';
  userMessage.createdAt = createdAt;
  f.workspace.save('message', userMessage.id, userMessage.conversationId, userMessage);
  f.workspace.save('message', assistantMessage.id, assistantMessage.conversationId, assistantMessage);
  const otherMessage = f.workspace.addMessage('conversation-two', 'user', '另一个项目的内容');
  const firstMemory = f.workspace.setMemory('project-one', 'TypeScript + Electron', 0);
  const memory = f.workspace.setMemory('project-one', 'TypeScript + Electron\n主题跟随系统。', firstMemory.revision);
  const completed = workflow('completed-one', 'completed');
  f.workspace.save('workflow', completed.id, completed.conversationId, completed);
  f.workspace.addWorklog(completed, '实现黑白主题，保留用户选择。');
  const worklog = f.workspace.worklog('project-one');

  f.reopen();
  for (const value of projects) assert.deepEqual(f.workspace.get<Project>('project', value.id), value);
  assert.deepEqual(f.workspace.conversations('project-one'), [conversations[0]]);
  assert.deepEqual(f.workspace.conversations('project-two'), [conversations[1]]);
  assert.deepEqual(f.workspace.messages('conversation-one'), [userMessage, assistantMessage]);
  assert.deepEqual(f.workspace.messages('conversation-two'), [JSON.parse(JSON.stringify(otherMessage))]);
  assert.deepEqual(f.workspace.memory('project-one'), memory);
  assert.deepEqual(f.workspace.worklog('project-one'), worklog);
  assert.deepEqual(f.workspace.worklog('project-two'), []);
  assert.deepEqual(f.workspace.get<Workflow>('workflow', completed.id), completed);
  assert.equal(f.workspace.get('project', 'missing'), undefined);
});

test('restart pauses every active workflow and preserves plan, run links and context without replay', (t) => {
  const f = fixture(t);
  const active = (['planning', 'running', 'waiting-approval'] as const).map((status) =>
    workflow(`active-${status}`, status),
  );
  for (const value of active) f.workspace.save('workflow', value.id, value.conversationId, value);
  const run: RunRecord = {
    id: 'run-finished',
    prompt: 'Read the project',
    projectPath: project().path,
    kind: 'general',
    status: 'completed',
    route: { runtimeId: 'codex-native', model: 'test-model', kind: 'general', reasons: [], warnings: [] },
    startedAt: createdAt,
    endedAt: '2026-09-26T12:01:00.000Z',
    output: 'Existing files inspected.',
    events: [],
    nativeSessionId: 'existing-native-session',
  };
  f.store.saveRun(run);
  f.workspace.addMessage('conversation-one', 'user', '用户已有消息', active[0]!.id);
  const messagesBefore = f.workspace.messages('conversation-one');
  const rowCount = () =>
    f.store.db.prepare('SELECT count(*) AS total FROM workspace_records').get() as { total: number };
  const countBefore = rowCount();

  f.reopen();
  for (const original of active) {
    const saved = f.workspace.get<Workflow>('workflow', original.id)!;
    assert.equal(saved.status, 'interrupted');
    assert.match(saved.error!, /不自动重放/);
    assert.ok(Number.isFinite(Date.parse(saved.updatedAt)));
    const superseded = original !== active.at(-1);
    assert.equal(!!saved.supersededAt, superseded);
    assert.deepEqual(saved, {
      ...original,
      status: 'interrupted',
      error: saved.error,
      updatedAt: saved.updatedAt,
      ...(superseded ? { supersededAt: saved.supersededAt } : {}),
    });
  }
  assert.deepEqual(storedRuns(f.store), [run]);
  assert.deepEqual(f.workspace.messages('conversation-one'), messagesBefore);
  assert.deepEqual(rowCount(), countBefore);
  const recovered = active.map((value) => f.workspace.get<Workflow>('workflow', value.id));

  // Opening once more must not regenerate tasks/messages or change recovery timestamps.
  f.reopen();
  assert.deepEqual(
    active.map((value) => f.workspace.get<Workflow>('workflow', value.id)),
    recovered,
  );
  assert.deepEqual(storedRuns(f.store), [run]);
  assert.deepEqual(f.workspace.messages('conversation-one'), messagesBefore);
  assert.deepEqual(rowCount(), countBefore);
});

test('restart preserves terminal workflow data except for superseded attention flags', (t) => {
  const f = fixture(t);
  const records = (['completed', 'failed', 'cancelled', 'blocked', 'interrupted'] as const).map((status) => ({
    ...workflow(`terminal-${status}`, status),
    phase: 'summarize' as const,
    error: `Preserved ${status} detail`,
    finalMessageId: `final-${status}`,
  }));
  for (const value of records) f.workspace.save('workflow', value.id, value.conversationId, value);
  f.reopen();
  for (const original of records) {
    const saved = f.workspace.get<Workflow>('workflow', original.id)!;
    const superseded = original.status === 'failed' || original.status === 'blocked';
    assert.equal(!!saved.supersededAt, superseded);
    assert.deepEqual(saved, { ...original, ...(superseded ? { supersededAt: saved.supersededAt } : {}) });
  }
});

test('restart recovers active workflows older than the latest 200 records', (t) => {
  const f = fixture(t);
  const old = (['planning', 'running', 'waiting-approval'] as const).map((status) => workflow(`old-${status}`, status));
  for (const value of old) f.workspace.save('workflow', value.id, value.conversationId, value);
  // Stable persisted ordering makes the pagination boundary independent of clock granularity.
  f.store.db.prepare("UPDATE workspace_records SET updated_at=? WHERE kind='workflow'").run('2026-01-01T00:00:00.000Z');
  for (let index = 0; index < 205; index++) {
    const value = workflow(`recent-${index}`, 'completed');
    f.workspace.save('workflow', value.id, value.conversationId, value);
  }
  assert.equal(f.workspace.workflows().length, 200);
  assert.ok(f.workspace.workflows().every((value) => value.status === 'completed'));

  f.reopen();
  for (const original of old) {
    const saved = f.workspace.get<Workflow>('workflow', original.id)!;
    assert.equal(saved.status, 'interrupted', `${original.id} must be recovered outside the history page`);
    assert.deepEqual(saved.plan, original.plan);
    assert.deepEqual(saved.runIds, original.runIds);
  }
  assert.equal(f.workspace.list<Workflow>('workflow', undefined, 1000).length, 208);
  assert.equal(
    f.workspace.list<Workflow>('workflow', undefined, 1000).filter((value) => value.status === 'completed').length,
    205,
  );
  assert.deepEqual(storedRuns(f.store), []);
  assert.deepEqual(f.workspace.messages(), []);
});

test('memory revision protection and idempotent worklog updates remain effective after restart', (t) => {
  const f = fixture(t);
  assert.equal(f.workspace.memory('project-one').revision, 0);
  const first = f.workspace.setMemory('project-one', '原始记忆', 0);
  f.reopen();
  assert.throws(() => f.workspace.setMemory('project-one', '过期写入', 0), /已被更新/);
  assert.deepEqual(f.workspace.memory('project-one'), first);
  const second = f.workspace.setMemory('project-one', '新记忆', first.revision);
  assert.equal(second.revision, 2);
  const value = workflow('one-worklog', 'completed');
  const ordinary = conversation();
  f.workspace.save('conversation', ordinary.id, ordinary.projectId, ordinary);
  f.workspace.addWorklog(value, '首次摘要');
  f.workspace.addWorklog(value, '更新后的摘要');
  const worklog = f.workspace.worklog('project-one');
  assert.equal(worklog.length, 1);
  assert.equal(worklog[0]!.summary, '更新后的摘要');
  f.reopen();
  assert.deepEqual(f.workspace.memory('project-one'), second);
  assert.deepEqual(f.workspace.worklog('project-one'), worklog);
});

test('restart keeps only provably unstarted queue entries eligible for automatic admission', (t) => {
  const f = fixture(t);
  const makeQueued = (id: string, status: Workflow['status'] = 'queued'): Workflow => ({
    ...workflow(id, status),
    phase: 'queue',
    plan: [],
    runIds: [],
    activeStepId: undefined,
  });
  const safe = [makeQueued('safe-queued'), makeQueued('safe-waiting', 'waiting-resource')];
  const started = makeQueued('started-before-run', 'waiting-resource');
  started.startedAt = createdAt;
  const linked = makeQueued('started-with-run', 'waiting-resource');
  linked.runIds = ['existing-child'];
  const crashGap = makeQueued('persisted-child-before-link', 'waiting-resource');
  for (const value of [...safe, started, linked, crashGap])
    f.workspace.save('workflow', value.id, value.conversationId, value);
  f.store.saveRun({
    id: 'unlinked-child',
    workflowId: crashGap.id,
    prompt: 'approved work',
    projectPath: project().path,
    kind: 'general',
    status: 'completed',
    route: { runtimeId: 'mock', model: 'test', kind: 'general', reasons: [], warnings: [] },
    startedAt: createdAt,
    output: 'work happened',
    events: [],
  });
  f.reopen();
  assert.deepEqual(
    f.workspace.queuedWorkflows().map((value) => value.id),
    safe.map((value) => value.id),
  );
  for (const value of safe)
    assert.deepEqual(f.workspace.get<Workflow>('workflow', value.id), JSON.parse(JSON.stringify(value)));
  for (const value of [started, linked, crashGap])
    assert.equal(f.workspace.get<Workflow>('workflow', value.id)?.status, 'interrupted');
});

test('queue lookup includes old pending entries beyond the history limit', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 230; i++) {
    const value: Workflow = { ...workflow(`queued-${i}`, 'queued'), phase: 'queue', plan: [], runIds: [] };
    f.workspace.save('workflow', value.id, value.conversationId, value);
  }
  assert.equal(f.workspace.workflows().length, 200);
  assert.equal(f.workspace.queuedWorkflows().length, 230);
  assert.equal(f.workspace.visibleWorkflows().length, 230);
  assert.equal(f.workspace.visibleWorkflows('conversation-one').length, 230);
  assert.deepEqual(f.workspace.visibleWorkflows('other-conversation'), []);
  assert.equal(f.workspace.queuedWorkflows()[0]?.id, 'queued-0');
  f.reopen();
  assert.equal(f.workspace.queuedWorkflows().length, 230);
});

test('visible workflows keep old active work alongside bounded recent history', (t) => {
  const f = fixture(t),
    old = workflow('old-running', 'running');
  f.workspace.save('workflow', old.id, old.conversationId, old);
  f.store.db.prepare("UPDATE workspace_records SET updated_at=? WHERE kind='workflow'").run('2020-01-01T00:00:00.000Z');
  for (let i = 0; i < 220; i++) {
    const value = workflow(`history-${i}`, 'completed');
    f.workspace.save('workflow', value.id, value.conversationId, value);
  }
  assert.equal(f.workspace.visibleWorkflows().length, 201);
  assert.ok(f.workspace.visibleWorkflows().some((value) => value.id === old.id));
  assert.equal(f.workspace.visibleWorkflows().filter((value) => value.status === 'completed').length, 200);
});

test('visible workflows retain unresolved attention beyond history, then release it after handling', (t) => {
  const f = fixture(t);
  const question = {
    ...workflow('question', 'completed'),
    userQuestion: { text: 'Which branch?', options: [], askedAt: createdAt },
  };
  const stopped = { ...workflow('stopped', 'failed'), updatedAt: new Date().toISOString() };
  const child = {
    ...workflow('child', 'failed'),
    delegation: { parentId: 'parent', role: 'scout' as const, requestId: 'request' },
  };
  const old = workflow('expired', 'failed');
  const superseded = { ...stopped, id: 'superseded', supersededAt: createdAt };
  for (const value of [question, stopped, child, old, superseded])
    f.workspace.save('workflow', value.id, value.conversationId, value);
  f.store.db.prepare("UPDATE workspace_records SET updated_at=? WHERE kind='workflow'").run('2020-01-01T00:00:00.000Z');
  for (let i = 0; i < 220; i++) {
    const value = workflow(`history-${i}`, 'completed');
    f.workspace.save('workflow', value.id, value.conversationId, value);
  }
  for (const scope of [undefined, question.conversationId]) {
    const visible = f.workspace.visibleWorkflows(scope);
    assert.equal(visible.length, 202);
    assert.ok(visible.some((value) => value.id === question.id));
    assert.ok(visible.some((value) => value.id === stopped.id));
    for (const hidden of [child, old, superseded]) assert.ok(!visible.some((value) => value.id === hidden.id));
  }
  f.workspace.save('workflow', question.id, question.conversationId, {
    ...question,
    userQuestion: { ...question.userQuestion, answeredMessageId: 'answer' },
  });
  f.workspace.save('workflow', stopped.id, stopped.conversationId, { ...stopped, attentionDismissedAt: createdAt });
  f.store.db
    .prepare("UPDATE workspace_records SET updated_at=? WHERE kind='workflow' AND id IN ('question','stopped')")
    .run('2020-01-01T00:00:00.000Z');
  assert.equal(f.workspace.visibleWorkflows().length, 200);
});

test('an old queued prompt cannot absorb later requests after its message leaves the history page', (t) => {
  const f = fixture(t);
  f.workspace.addMessage('conversation-one', 'user', 'earlier task', 'earlier-workflow');
  const anchor = f.workspace.addMessage('conversation-one', 'user', 'current queued task', 'current-workflow');
  for (let i = 0; i < 310; i++)
    f.workspace.addMessage('conversation-one', 'user', `later unrelated request ${i}`, `later-${i}`);
  f.workspace.addMessage(
    'conversation-one',
    'assistant',
    'earlier task completed after queue submission',
    'earlier-workflow',
  );
  f.workspace.addMessage('conversation-one', 'assistant', 'a future task completed', 'later-1');
  assert.ok(!f.workspace.messages('conversation-one').some((message) => message.id === anchor.id));
  assert.deepEqual(
    f.workspace.contextMessages('conversation-one', anchor.id).map((message) => message.content),
    ['earlier task', 'earlier task completed after queue submission'],
  );
});

test('continuation lookup finds old terminal successors outside the workflow history page', (t) => {
  const f = fixture(t),
    child = { ...workflow('old-successor', 'completed'), parentWorkflowId: 'old-parent' };
  f.workspace.save('workflow', child.id, child.conversationId, child);
  f.store.db.prepare("UPDATE workspace_records SET updated_at=? WHERE kind='workflow'").run('2020-01-01T00:00:00.000Z');
  for (let i = 0; i < 205; i++) {
    const value = workflow(`newer-${i}`, 'completed');
    f.workspace.save('workflow', value.id, value.conversationId, value);
  }
  assert.ok(!f.workspace.workflows().some((value) => value.id === child.id));
  assert.deepEqual(f.workspace.childWorkflows('old-parent'), [child]);
  f.reopen();
  assert.deepEqual(f.workspace.childWorkflows('old-parent'), [child]);
});

test('automatic memory is separate, durable, and leaves hand-written memory byte-identical', (t) => {
  const f = fixture(t);
  const content = 'Owner text\r\nKeep spaces.  \n';
  f.workspace.setMemory('project-one', content);
  const before = f.store.db
    .prepare("SELECT value FROM workspace_records WHERE kind='memory' AND id=?")
    .get('project-one');
  assert.equal(f.workspace.memoryAuto('project-one'), undefined);
  f.workspace.setMemoryAuto('project-one', {
    content: 'facts:\nSynthetic fact.\ndecisions:\nKeep it.\npitfalls:\nNone.',
    sourceRuntimeId: 'synthetic-runtime',
    runId: 'synthetic-run',
  });
  f.workspace.setMemoryAuto('project-one', {
    content: 'updated automatic note',
    sourceRuntimeId: 'synthetic-runtime-2',
    runId: 'synthetic-run-2',
  });
  f.reopen();
  assert.equal(f.workspace.memoryAuto('project-one')!.content, 'updated automatic note');
  assert.equal(f.workspace.memoryAuto('project-one')!.sourceRuntimeId, 'synthetic-runtime-2');
  assert.equal(f.workspace.memory('project-one').content, content);
  assert.deepEqual(
    f.store.db.prepare("SELECT value FROM workspace_records WHERE kind='memory' AND id=?").get('project-one'),
    before,
  );
  assert.equal(f.workspace.memoryAuto('other-project'), undefined);
});

test('startup supersedes only stopped main work with a later main workflow and is idempotent', (t) => {
  const f = fixture(t);
  const earlier = workflow('earlier', 'failed');
  const child = {
    ...workflow('child', 'failed'),
    delegation: { parentId: 'earlier', role: 'scout' as const, requestId: 'r' },
  };
  const waiting = {
    ...workflow('waiting', 'blocked'),
    waitingOn: { kind: 'media-analysis' as const, jobId: 'job', done: 0, total: 1 },
  };
  const continued = {
    ...workflow('continued', 'failed'),
    followUp: { kind: 'continue' as const, workflowId: 'latest', at: createdAt },
  };
  const deleted = { ...workflow('deleted', 'failed'), deletedAt: createdAt };
  // A continuation successor is still top-level; a newer delegated child is not.
  const latest = { ...workflow('latest', 'interrupted'), parentWorkflowId: 'continued' };
  const lone = workflow('lone', 'failed', 'project-one', 'conversation-two');
  const loneChild = {
    ...child,
    id: 'lone-child',
    conversationId: lone.conversationId,
    delegation: { ...child.delegation, parentId: lone.id },
  };
  for (const value of [earlier, child, waiting, continued, deleted, latest, lone, loneChild])
    f.workspace.save('workflow', value.id, value.conversationId, value);
  const rows = () =>
    f.store.db
      .prepare('SELECT * FROM workspace_records ORDER BY rowid')
      .all()
      .map((row) => ({ ...row }));
  const before = rows();
  new WorkspaceStore(f.store.db, { recoverInterrupted: false });
  const saved = f.workspace.get<Workflow>('workflow', earlier.id)!;
  assert.ok(saved.supersededAt);
  assert.deepEqual(saved, { ...earlier, supersededAt: saved.supersededAt });
  const expected = before.map((row) =>
    row.kind === 'workflow' && row.id === earlier.id ? { ...row, value: JSON.stringify(saved) } : row,
  );
  assert.deepEqual(rows(), expected, 'only the display flag changes, including unchanged record timestamps');
  const revision = f.store.db.prepare('SELECT n FROM workspace_revision').get();
  new WorkspaceStore(f.store.db, { recoverInterrupted: false });
  assert.deepEqual(rows(), expected);
  assert.deepEqual(f.store.db.prepare('SELECT n FROM workspace_revision').get(), revision);
});

test('visible workflows match the single-query version for every status, window, question and tie', (t) => {
  const f = fixture(t);
  const db = f.store.db;
  // The previous implementation, kept here as the reference the indexed three-part read must reproduce.
  const legacy = (conversationId?: string) => {
    const active =
      "json_extract(value,'$.status') IN ('queued','waiting-resource','planning','running','waiting-approval','waiting-confirmation')";
    const now = Date.now();
    const candidates = `(${active} OR (json_extract(value,'$.delegation') IS NULL AND (
      (json_extract(value,'$.status') IN ('blocked','interrupted','failed')
        AND json_extract(value,'$.supersededAt') IS NULL AND json_extract(value,'$.attentionDismissedAt') IS NULL
        AND julianday(COALESCE(json_extract(value,'$.updatedAt'),json_extract(value,'$.createdAt'))) >= julianday(?) - 14)
      OR json_extract(value,'$.userQuestion') IS NOT NULL)))`;
    const rows = (
      conversationId === undefined
        ? db
            .prepare(`SELECT value, ${active} AS active FROM workspace_records WHERE kind='workflow' AND ${candidates}`)
            .all(new Date(now).toISOString())
        : db
            .prepare(
              `SELECT value, ${active} AS active FROM workspace_records WHERE kind='workflow' AND owner=? AND ${candidates}`,
            )
            .all(conversationId, new Date(now).toISOString())
    ) as { value: string; active: number }[];
    const values = new Map(f.workspace.workflows(conversationId).map((workflow) => [workflow.id, workflow]));
    for (const row of rows) {
      const workflow = JSON.parse(row.value) as Workflow;
      if (workflow.deletedAt || (!row.active && !workflowNeedsUser(workflow, now))) continue;
      values.set(workflow.id, workflow);
    }
    return [...values.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  };
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
  const now = Date.now();
  const day = 86_400_000;
  // Few distinct times, so many tasks tie on updatedAt; 30 s keeps the 14-day edge clear of test timing.
  const times = [now - 3600_000, now - 13 * day, now - 14 * day + 30_000, now - 14 * day - 30_000, now - 60 * day].map(
    (value) => new Date(value).toISOString(),
  );
  const statuses = [
    'queued',
    'waiting-resource',
    'planning',
    'running',
    'waiting-approval',
    'waiting-confirmation',
    'blocked',
    'interrupted',
    'failed',
    'completed',
    'cancelled',
    null,
  ] as const;
  f.workspace.transaction(() => {
    for (let i = 0; i < 700; i++) {
      const conversationId = pick(['conversation-one', 'conversation-two', 'conversation-three']);
      const value = workflow(`synthetic-${i}`, 'completed', 'project-one', conversationId) as Workflow &
        Record<string, unknown>;
      value.status = pick(statuses) as Workflow['status'];
      value.updatedAt = pick(times);
      value.createdAt = pick(times);
      if (random() < 0.2) value.delegation = { parentId: 'synthetic-parent', requestId: `r${i % 7}`, role: 'scout' };
      if (random() < 0.2) value.supersededAt = pick(times);
      if (random() < 0.1) value.attentionDismissedAt = pick(times);
      if (random() < 0.2)
        value.userQuestion = {
          text: 'Synthetic question?',
          options: [],
          askedAt: pick(times),
          ...(random() < 0.5 ? { answeredMessageId: 'synthetic-answer' } : {}),
        };
      if (random() < 0.1) value.deletedAt = pick(times);
      if (random() < 0.6) value.parentWorkflowId = pick(['synthetic-a', 'synthetic-b', 'synthetic-c']);
      if (random() < 0.1) value.input = { ...value.input, permissionOrigin: { source: 'external' } as never };
      if (random() < 0.05) value.followUp = { kind: 'continue', workflowId: 'synthetic-next' } as never;
      f.workspace.save('workflow', value.id, conversationId, value);
    }
  });
  const expected = legacy();
  assert.ok(expected.length > 200, 'the attention part reaches beyond the newest 200');
  assert.ok(new Set(expected.map((value) => value.updatedAt)).size < expected.length, 'ties are exercised');
  assert.equal(JSON.stringify(f.workspace.visibleWorkflows()), JSON.stringify(expected));
  for (const conversationId of ['conversation-one', 'conversation-two', 'conversation-three'])
    assert.equal(
      JSON.stringify(f.workspace.visibleWorkflows(conversationId)),
      JSON.stringify(legacy(conversationId)),
      conversationId,
    );
  const plan = db
    .prepare(
      `EXPLAIN QUERY PLAN SELECT value FROM workspace_records WHERE kind='workflow'
       AND json_extract(value,'$.userQuestion') IS NOT NULL AND json_extract(value,'$.delegation') IS NULL`,
    )
    .all()
    .map((row) => (row as { detail: string }).detail)
    .join(' ');
  assert.match(plan, /workspace_user_question/, 'questions are found through their index');
});
