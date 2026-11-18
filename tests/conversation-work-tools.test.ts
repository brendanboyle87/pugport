import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { ConversationAutomation, type ConversationActor } from '../src/server/conversation-automation.ts';
import { callConversationWork } from '../src/server/conversation-work-tools.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import type { Workspace } from '../src/server/workspace.ts';

function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  const projectId = randomUUID(),
    conversationId = randomUUID();
  const at = '2026-10-28T12:00:00.000Z';
  store.save('project', projectId, projectId, { id: projectId, path: '.', createdAt: at, updatedAt: at });
  store.save('conversation', conversationId, projectId, {
    id: conversationId,
    projectId,
    createdAt: at,
    updatedAt: at,
  });
  const work = new ConversationAutomation({ store, controller: { broadcast() {} } } as unknown as Workspace, {
    now: () => Date.parse(at),
  });
  t.after(async () => {
    await work.close();
    db.close();
  });
  const actor: ConversationActor = { conversationId, source: 'human', write: false };
  return { work, store, actor, projectId, at };
}

test('work tools expose repository observations through the current conversation boundary', async (t) => {
  const f = fixture(t);
  const watch = await callConversationWork(f.work, f.actor, 'watch_pull_request', {
    requestId: randomUUID(),
    name: 'Synthetic PR',
    prompt: 'Read status',
    repository: 'synthetic/repo',
    number: 1,
  });
  assert.equal((watch as { write: boolean }).write, false);
  f.store.save('github-repo', 'synthetic/repo', 'github', {
    v: 1,
    repository: 'synthetic/repo',
    holds: [],
    writers: {},
    nextAt: f.at,
    failures: 0,
    quiet: 0,
    branches: {
      develop: { verdict: 'red', sha: 'abc', run: { id: 1, name: 'CI', url: 'https://example.test/run/1' } },
    },
  });
  const listed = (await callConversationWork(f.work, f.actor, 'list_conversation_work', {})) as ReturnType<
    ConversationAutomation['list']
  >;
  assert.equal(listed.repositories[0].branches.develop, 'red');
  assert.equal(listed.jobs.length, 1);
  const other = randomUUID();
  f.store.save('conversation', other, f.projectId, {
    id: other,
    projectId: f.projectId,
    createdAt: f.at,
    updatedAt: f.at,
  });
  const unrelated = (await callConversationWork(
    f.work,
    { ...f.actor, conversationId: other },
    'list_conversation_work',
    {},
  )) as ReturnType<ConversationAutomation['list']>;
  assert.deepEqual(unrelated.repositories, []);
});

test('listing work rechecks conversation availability before exposing repository state', async (t) => {
  const f = fixture(t);
  f.store.save('conversation', f.actor.conversationId, f.projectId, {
    id: f.actor.conversationId,
    projectId: f.projectId,
    closedAt: f.at,
  });
  await assert.rejects(callConversationWork(f.work, f.actor, 'list_conversation_work', {}), /已关闭/);
});

test('a background GitHub observation cannot create recursive PR monitoring', async (t) => {
  const f = fixture(t),
    workflowId = randomUUID();
  f.store.save('workflow', workflowId, f.actor.conversationId, {
    id: workflowId,
    conversationId: f.actor.conversationId,
    projectId: f.projectId,
    status: 'running',
    input: { permissionMode: 'read-only', backgroundTrigger: { kind: 'schedule', id: 'github:synthetic' } },
  });
  await assert.rejects(
    callConversationWork(f.work, { ...f.actor, source: 'agent', workflowId }, 'watch_pull_request', {
      requestId: randomUUID(),
      name: 'Synthetic PR',
      prompt: 'Read status',
      repository: 'synthetic/repo',
      number: 1,
    }),
    /后台/,
  );
  assert.equal(f.store.list('conversation-job').length, 0);
});
