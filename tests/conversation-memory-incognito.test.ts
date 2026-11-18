import { saveAttachment } from './helpers/attachments.ts';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, input, result } from './helpers/session-workspace.ts';
import { fixtureSignal, settledWorkflow, workflowState } from './helpers/workflow-state.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { ProjectMemoryIndex } from '../src/server/memory-index.ts';
import { exportConversationMemory, exportProjectMemory, memoryConversationPaths } from '../src/server/local-memory.ts';
import { sideChatParentContext } from '../src/server/side-chat-context.ts';
import { searchConversations } from '../src/server/search-routes.ts';
import { ExternalTasks } from '../src/server/external-tasks.ts';
import { ConversationActions } from '../src/server/conversation-actions.ts';
import { incognitoDirectory, purgeIncognito } from '../src/server/incognito.ts';
import { inspectQuitWork } from '../src/server/quit-inspection.ts';
import { needsQuitConfirmation, quitDescription } from '../src/electron/lifecycle.ts';
import { distillationInput } from '../src/server/memory-distillation.ts';
import { Workspace } from '../src/server/workspace.ts';
import { saveMemberResult } from '../src/server/member-results.ts';
import { survivingMemoryVectors } from '../src/server/vector-cache.ts';
import { ProjectVectors, pruneMemoryVectors } from '../src/server/memory-vectors.ts';
import type { Conversation, Workflow, RunRecord, ExecuteContext } from '../src/shared/types.ts';

async function setup(t: TestContext) {
  const f = fixture(t);
  const path = join(f.directory, 'project');
  mkdirSync(path);
  const vectors = process.env.COMBORUNNER_MEMORY_VECTORS_DIR;
  process.env.COMBORUNNER_MEMORY_VECTORS_DIR = join(f.directory, 'vectors');
  t.after(() => {
    if (vectors === undefined) delete process.env.COMBORUNNER_MEMORY_VECTORS_DIR;
    else process.env.COMBORUNNER_MEMORY_VECTORS_DIR = vectors;
  });
  return { ...f, project: await f.workspace.createProject(path) };
}

test('memory toggle retracts warm index, exports, worklog and distillation; enabling reindexes all history', async (t) => {
  const { workspace: w, project, controller } = await setup(t);
  const source = w.createConversation(project.id);
  const reader = w.createConversation(project.id);
  const message = w.store.addMessage(source.id, 'assistant', 'SYNTHETIC_SECRET D:/synthetic/source');
  const anchor = w.store.addMessage(reader.id, 'user', 'Find SYNTHETIC_SECRET');
  const scope = { conversationId: reader.id, userMessageId: anchor.id };
  const index = new ProjectMemoryIndex(w.store, project.id);
  assert.ok(index.search(scope, ['synthetic_secret']).length);
  exportConversationMemory(w.store, project, source.id, controller.dataDir);
  const paths = memoryConversationPaths(controller.dataDir, project.id, source.id);
  assert.match(readFileSync(paths.historyPath, 'utf8'), /SYNTHETIC_SECRET/);
  const flow = {
    id: randomUUID(),
    projectId: project.id,
    conversationId: source.id,
    userMessageId: message.id,
    input: { ...input, content: 'SYNTHETIC_SECRET' },
    runIds: [],
    plan: [],
    phase: 'execute',
    status: 'completed',
    memoryRevision: 0,
    memoryExcerpt: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as Workflow;
  w.store.save('workflow', flow.id, source.id, flow);
  w.store.addWorklog(flow, 'SYNTHETIC_SECRET');
  const auto = w.store.setMemoryAuto(project.id, {
    content: 'OTHER_CONVERSATION_AUTO_MEMORY',
    runId: 'auto-run',
    sourceRuntimeId: 'mock',
  });
  assert.match(distillationInput(project, { store: w.store, run: () => undefined }), /SYNTHETIC_SECRET/);
  await w.setConversationMemory(source.id, true);
  assert.deepEqual(w.store.memoryAuto(project.id), auto);
  assert.equal(
    w.store.memoryIndexMembership(project.id).some((row) => row.messageId === message.id),
    false,
  );
  assert.equal(index.search(scope, ['synthetic_secret']).length, 0);
  assert.deepEqual(w.store.searchMemory(project.id, reader.id, anchor.id, ['SYNTHETIC_SECRET']), []);
  assert.deepEqual(w.store.memoryPathSources(project.id, reader.id, anchor.id), []);
  assert.equal(w.store.worklog(project.id).length, 0);
  assert.doesNotMatch(distillationInput(project, { store: w.store, run: () => undefined }), /SYNTHETIC_SECRET/);
  exportProjectMemory(w.store, project, controller.dataDir);
  assert.equal(readFileSync(paths.historyPath, 'utf8'), '');
  assert.doesNotMatch(readFileSync(paths.indexPath, 'utf8'), new RegExp(source.id));
  await w.setConversationMemory(source.id, false);
  assert.ok(index.search(scope, ['synthetic_secret']).some((row) => row.messageId === message.id));
  assert.match(readFileSync(paths.historyPath, 'utf8'), /SYNTHETIC_SECRET/);
});

test('disabled and incognito sources leave the BGE index membership and cached vectors', async (t) => {
  const { workspace: w, project, directory } = await setup(t);
  t.mock.property(process, 'env', { ...process.env, COMBORUNNER_MEMORY_VECTORS_DIR: join(directory, 'test-vectors') });
  const source = w.createConversation(project.id);
  const secret = w.createConversation(project.id, undefined, true);
  const visible = w.store.addMessage(source.id, 'assistant', 'PUBLIC_SYNTHETIC_VECTOR');
  const hidden = w.store.addMessage(secret.id, 'assistant', 'PRIVATE_SYNTHETIC_VECTOR');
  assert.deepEqual(
    [...w.store.iterateMemoryIndexRows(project.id)].map((row) => row.messageId),
    [visible.id],
  );
  const vectors = await ProjectVectors.open(project.id);
  vectors.replace(
    [visible, hidden].map((row) => ({ messageId: row.id, offset: 0, hash: 'synthetic' })),
    [new Int8Array(1024), new Int8Array(1024)],
  );
  await vectors.save();
  await pruneMemoryVectors(w.store, project.id);
  assert.deepEqual(
    (await ProjectVectors.open(project.id)).items.map((row) => row.messageId),
    [visible.id],
  );
  await w.setConversationMemory(source.id, true);
  await pruneMemoryVectors(w.store, project.id);
  assert.deepEqual((await ProjectVectors.open(project.id)).items, []);
});

test('memory-off prompt retains own messages and rules but excludes memory, history paths and other conversations', async (t) => {
  const { workspace: w, controller, project } = await setup(t);
  w.setProjectRules(project.id, ['SYNTHETIC_PROJECT_RULE']);
  controller.settings.globalInstructions = 'SYNTHETIC_GLOBAL_INSTRUCTION';
  w.store.setMemory(project.id, 'SYNTHETIC_PROJECT_MEMORY');
  const conversation = w.createConversation(project.id);
  w.store.addMessage(conversation.id, 'user', 'SYNTHETIC_OWN_CONTEXT');
  const other = w.createConversation(project.id);
  w.store.addMessage(other.id, 'assistant', 'SYNTHETIC_OTHER_CONTEXT');
  await w.setConversationMemory(conversation.id, true);
  let prompt = '';
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    prompt = ctx.input.prompt;
    return result('completed', 'Done');
  });
  const sent = await w.send(conversation.id, { ...input, runtimeId: 'mock' });
  const finished = await settledWorkflow(w, sent.workflow!.id);
  assert.equal(finished.status, 'completed', finished.error ?? '');
  assert.match(prompt, /SYNTHETIC_OWN_CONTEXT/);
  assert.match(prompt, /SYNTHETIC_PROJECT_RULE/);
  assert.match(prompt, /SYNTHETIC_GLOBAL_INSTRUCTION/);
  assert.doesNotMatch(prompt, /SYNTHETIC_PROJECT_MEMORY|SYNTHETIC_OTHER_CONTEXT|history\.jsonl|handoff\.md/);
  assert.equal(w.store.hasMemorySources(project.id, conversation.id, sent.message.id), false);
  assert.equal(w.store.worklog(project.id).length, 0);
  const paths = memoryConversationPaths(controller.dataDir, project.id, conversation.id);
  assert.ok(!existsSync(paths.historyPath) || !readFileSync(paths.historyPath, 'utf8'));
});

test('side context retains its own parent and selected quote with memory off', async (t) => {
  const { workspace: w, project } = await setup(t);
  const parent = w.createConversation(project.id);
  const side = w.createConversation(project.id);
  side.sideChat = {
    parentConversationId: parent.id,
    context: 'STALE_SECRET',
    quote: 'SELECTED_QUOTE',
    selection: { executionPolicy: 'cli-only' },
  };
  w.store.save('conversation', side.id, project.id, side);
  w.store.addMessage(parent.id, 'assistant', 'PARENT_SECRET');
  assert.match(sideChatParentContext(w.store, side.id), /PARENT_SECRET/);
  await w.setConversationMemory(side.id, true);
  assert.match(sideChatParentContext(w.store, side.id), /PARENT_SECRET/);
  assert.match(sideChatParentContext(w.store, side.id), /SELECTED_QUOTE/);
  await w.setConversationMemory(side.id, false);
  await w.setConversationMemory(parent.id, true);
  assert.match(sideChatParentContext(w.store, side.id), /PARENT_SECRET/);
  assert.match(sideChatParentContext(w.store, side.id), /SELECTED_QUOTE/);
});

test('incognito has a fixed title and is refused by search, MCP, forks, side chat, archive and taste tests', async (t) => {
  const { workspace: w, project, controller } = await setup(t);
  const secret = w.createConversation(project.id, 'PRIVATE_TITLE', true);
  const ordinary = w.createConversation(project.id, 'ordinary needle');
  assert.equal(secret.title, '隐身对话');
  assert.equal(secret.memory, 'off');
  assert.equal(w.renameConversation(secret.id, 'LEAK_TITLE').title, '隐身对话');
  const message = w.store.addMessage(secret.id, 'user', 'needle secret');
  assert.deepEqual(
    searchConversations(w.store, 'needle').map((row) => row.conversationId),
    [ordinary.id],
  );
  const external = new ExternalTasks(w);
  const flowId = randomUUID();
  w.store.save('workflow', flowId, secret.id, {
    id: flowId,
    conversationId: secret.id,
    status: 'completed',
    input,
    runIds: [],
    plan: [],
  });
  assert.equal(external.status(flowId), undefined);
  assert.equal(await external.result(flowId), undefined);
  assert.equal(external.list().total, 0);
  assert.equal(external.read(secret.id), undefined);
  assert.equal(await external.follow(secret.id, { message: 'leak' }), undefined);
  assert.ok(external.conversations().conversations.every((row) => row.conversationId !== secret.id));
  assert.throws(() => w.forkConversation(secret.id, message.id), /隐身/);
  assert.throws(
    () =>
      new ConversationActions(w).sideChat(secret.id, {
        requestId: randomUUID(),
        selection: { executionPolicy: 'cli-only' },
      }),
    /隐身/,
  );
  assert.throws(() => w.archiveConversation(secret.id, true), /隐身/);
  assert.throws(() => w.tastes.start(secret, 'secret', 'fiction' as never), /隐身/);
  await assert.rejects(w.setConversationMemory(secret.id, false), /隐身/);
  exportProjectMemory(w.store, project, controller.dataDir);
  assert.equal(existsSync(memoryConversationPaths(controller.dataDir, project.id, secret.id).historyPath), false);
});

test('close hard-deletes owned records, judgments and run audit; preserves shared attachments and usage', async (t) => {
  const { workspace: w, controller, project } = await setup(t);
  const secret = w.createConversation(project.id, undefined, true);
  const ordinary = w.createConversation(project.id);
  const flowId = randomUUID();
  w.store.save('workflow', flowId, secret.id, {
    id: flowId,
    conversationId: secret.id,
    projectId: project.id,
    status: 'completed',
    input,
    runIds: [],
    plan: [],
  });
  w.store.addMessage(secret.id, 'user', 'SECRET_MESSAGE', flowId);
  w.store.save('synthetic-conversation-data', randomUUID(), secret.id, { text: 'secret' });
  w.store.save('synthetic-workflow-data', randomUUID(), flowId, { text: 'secret' });
  const ordinaryFlow = {
    id: randomUUID(),
    projectId: project.id,
    conversationId: ordinary.id,
    userMessageId: '',
    input,
    runIds: ['ordinary-run'],
    plan: [],
    phase: 'execute',
    status: 'completed',
    memoryRevision: 0,
    memoryExcerpt: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as Workflow;
  const ordinaryMessage = w.store.addMessage(ordinary.id, 'user', 'ORDINARY_MESSAGE', ordinaryFlow.id);
  ordinaryFlow.userMessageId = ordinaryMessage.id;
  w.store.save('workflow', ordinaryFlow.id, ordinary.id, ordinaryFlow);
  w.store.addWorklog(ordinaryFlow, 'ORDINARY_WORKLOG');
  const ordinaryWorklog = w.store.get('worklog', ordinaryFlow.id);
  const ordinaryAttachment = await saveAttachment(w.attachments, ordinary.id, {
    name: 'ordinary.txt',
    mimeType: 'text/plain',
    dataBase64: Buffer.from('ordinary').toString('base64'),
  });
  const ordinaryPath = w.attachments.get(ordinary.id, ordinaryAttachment.id).path;
  const ordinaryRun = {
    id: 'ordinary-run',
    workflowId: ordinaryFlow.id,
    projectPath: project.path,
    kind: 'routine',
    prompt: 'ORDINARY_PROMPT',
    output: 'ORDINARY_OUTPUT',
    events: [],
    status: 'completed',
    startedAt: new Date().toISOString(),
    route: { runtimeId: 'mock', model: 'mock-model', kind: 'routine', reasons: [], warnings: [] },
  } as RunRecord;
  controller.store.saveRun(ordinaryRun);
  const ordinaryAudit = { at: ordinaryRun.startedAt, type: 'output', seq: 1, text: 'ORDINARY_AUDIT' };
  controller.store.db
    .prepare('INSERT INTO run_audit_events(run_id,seq,value) VALUES(?,?,?)')
    .run(ordinaryRun.id, 1, JSON.stringify(ordinaryAudit));
  controller.store.db
    .prepare('INSERT INTO task_judgments(workflow_id,project_id,value) VALUES(?,?,?)')
    .run(ordinaryFlow.id, project.id, JSON.stringify({ summary: 'ORDINARY_JUDGMENT', usage: {} }));
  const shared = await saveAttachment(w.attachments, secret.id, {
    name: 'shared.txt',
    mimeType: 'text/plain',
    dataBase64: Buffer.from('shared').toString('base64'),
  });
  const unique = await saveAttachment(w.attachments, secret.id, {
    name: 'unique.txt',
    mimeType: 'text/plain',
    dataBase64: Buffer.from('unique').toString('base64'),
  });
  const sharedPath = w.attachments.get(secret.id, shared.id).path;
  const uniquePath = w.attachments.get(secret.id, unique.id).path;
  const copy = w.attachments.copyReference(secret.id, shared.id, ordinary.id);
  const db = w.store.db;
  controller.store.saveRun({
    ...ordinaryRun,
    id: 'secret-run',
    workflowId: flowId,
    prompt: 'SECRET_PROMPT',
    output: 'SECRET_OUTPUT',
  });
  assert.ok(controller.recentState().runs.some((run) => run.id === 'secret-run'));
  const memberFile = saveMemberResult(controller.dataDir, secret.id, randomUUID(), 'SECRET_SUBTASK'.repeat(200))!;
  const ordinaryMemberFile = saveMemberResult(controller.dataDir, ordinary.id, randomUUID(), 'ORDINARY_SUBTASK')!;
  assert.ok(existsSync(memberFile));
  const broadcasts: string[][] = [];
  const broadcast = controller.broadcast.bind(controller);
  t.mock.method(controller, 'broadcast', () => {
    broadcast();
    broadcasts.push(controller.recentState().runs.map((run) => run.id));
  });
  db.prepare('INSERT INTO run_audit_events(run_id,seq,value) VALUES(?,?,?)').run('secret-run', 1, '{"text":"SECRET"}');
  db.prepare('INSERT INTO task_judgments(workflow_id,project_id,value) VALUES(?,?,?)').run(
    flowId,
    project.id,
    '{"usage":{}}',
  );
  const usageRun = {
    id: 'secret-run',
    workflowId: flowId,
    projectPath: project.path,
    status: 'completed',
    startedAt: new Date().toISOString(),
    route: { runtimeId: 'mock', model: 'mock-model' },
  } as RunRecord;
  controller.usage.record(usageRun, controller.targets[0]!, {
    at: usageRun.startedAt,
    type: 'usage',
    data: { inputTokens: 37, outputTokens: 11 },
  });
  const ledgerBefore = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('usage_runs','usage_events','usage_sessions')",
    )
    .all();
  const ledger = ledgerBefore.map(
    (row) => [String(row.name), db.prepare('SELECT * FROM "' + row.name + '"').all()] as const,
  );
  assert.deepEqual(await w.closeIncognito(secret.id), { deleted: true });
  assert.equal(w.store.get('conversation', secret.id), undefined);
  assert.equal(db.prepare('SELECT 1 FROM workspace_records WHERE owner IN (?,?)').get(secret.id, flowId), undefined);
  assert.equal(controller.store.storedRun('secret-run'), undefined);
  assert.equal(db.prepare('SELECT 1 FROM run_summaries WHERE id=?').get('secret-run'), undefined);
  assert.equal(db.prepare('SELECT 1 FROM run_audit_events WHERE run_id=?').get('secret-run'), undefined);
  assert.equal(db.prepare('SELECT 1 FROM task_judgments WHERE workflow_id=?').get(flowId), undefined);
  assert.ok(broadcasts.length && !broadcasts.at(-1)!.includes('secret-run'));
  assert.ok(broadcasts.at(-1)!.includes(ordinaryRun.id));
  assert.deepEqual(w.store.get('conversation', ordinary.id), ordinary);
  assert.deepEqual(w.store.get('message', ordinaryMessage.id), ordinaryMessage);
  assert.deepEqual(w.store.get('workflow', ordinaryFlow.id), ordinaryFlow);
  assert.deepEqual(controller.store.storedRun(ordinaryRun.id), ordinaryRun);
  assert.deepEqual(controller.store.run(ordinaryRun.id)?.events, [ordinaryAudit]);
  assert.deepEqual(
    JSON.parse(String(db.prepare('SELECT value FROM task_judgments WHERE workflow_id=?').get(ordinaryFlow.id)!.value)),
    { summary: 'ORDINARY_JUDGMENT', usage: {} },
  );
  assert.deepEqual(w.store.worklog(project.id), [ordinaryWorklog]);
  assert.equal(readFileSync(ordinaryPath, 'utf8'), 'ordinary');
  assert.equal(w.attachments.get(ordinary.id, ordinaryAttachment.id).path, ordinaryPath);
  assert.equal(existsSync(memberFile), false);
  assert.equal(readFileSync(ordinaryMemberFile, 'utf8'), 'ORDINARY_SUBTASK');
  assert.equal(existsSync(uniquePath), false);
  assert.equal(existsSync(sharedPath), true);
  assert.equal(w.attachments.get(ordinary.id, copy.id).path, sharedPath);
  for (const [table, rows] of ledger) assert.deepEqual(db.prepare('SELECT * FROM "' + table + '"').all(), rows);
  assert.equal(w.store.deletedConversations().length, 0);
  assert.ok(w.store.get('conversation', ordinary.id));
  assert.deepEqual(await w.closeIncognito(secret.id), { deleted: true });
});

test('active incognito closes after the last workflow finishes and cannot be reopened', async (t) => {
  const { workspace: w, project } = await setup(t);
  const secret = w.createConversation(project.id, undefined, true);
  const started = fixtureSignal(),
    release = fixtureSignal();
  t.mock.method(codexAdapter, 'execute', async () => {
    started.resolve();
    await release.promise;
    return result('completed', 'Done');
  });
  await w.send(secret.id, { ...input, runtimeId: 'mock' });
  await started.promise;
  assert.deepEqual(await w.closeIncognito(secret.id), { deleted: false });
  assert.ok(w.store.get<Conversation>('conversation', secret.id)?.closedAt);
  const deleted = workflowState(w, () => !w.store.get('conversation', secret.id));
  release.resolve();
  await deleted;
  assert.deepEqual(w.store.conversationWorkflows(secret.id), []);
});

test('restart purges only closed incognito; first desktop launch purges all and ordinary chats survive', async (t) => {
  const { workspace: w, project } = await setup(t);
  const open = w.createConversation(project.id, undefined, true);
  const closed = w.createConversation(project.id, undefined, true);
  const ordinary = w.createConversation(project.id);
  w.store.save('conversation', closed.id, project.id, { ...closed, closedAt: new Date().toISOString() });
  await purgeIncognito(w.store, w.attachments, false);
  assert.ok(w.store.get('conversation', open.id));
  assert.equal(w.store.get('conversation', closed.id), undefined);
  await purgeIncognito(w.store, w.attachments, true);
  assert.equal(w.store.get('conversation', open.id), undefined);
  assert.ok(w.store.get('conversation', ordinary.id));
  const final = w.createConversation(project.id, undefined, true);
  assert.deepEqual(await w.deleteConversation(final.id), { deleted: true });
  assert.deepEqual(w.store.deletedConversations(), []);
});

test('app quit confirms even idle incognito and closeOnce removes it while preserving ordinary chats', async (t) => {
  const { workspace: w, project } = await setup(t);
  const secret = w.createConversation(project.id, undefined, true);
  const ordinary = w.createConversation(project.id);
  const state = inspectQuitWork(w.store.db);
  assert.deepEqual(state.incognito, [secret.id]);
  assert.equal(needsQuitConfirmation(state), true);
  assert.match(quitDescription(state), /离开后这个隐身对话会被永久删除/);
  await w.close();
  assert.equal(w.store.get('conversation', secret.id), undefined);
  assert.ok(w.store.get('conversation', ordinary.id));
});

test('incognito refuses device inputs, including delegated and coordinated device tasks, before saving messages', async (t) => {
  const { workspace: w, project } = await setup(t);
  const secret = w.createConversation(project.id, undefined, true);
  await assert.rejects(w.send(secret.id, { ...input, deviceId: randomUUID() }), /隐身.*设备/);
  const parent: Workflow = {
    id: randomUUID(),
    projectId: project.id,
    conversationId: secret.id,
    userMessageId: randomUUID(),
    input,
    runIds: [],
    plan: [],
    phase: 'execute',
    status: 'completed',
    memoryRevision: 0,
    memoryExcerpt: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  w.store.save('workflow', parent.id, secret.id, parent);
  await assert.rejects(
    w.send(secret.id, { ...input, deviceId: randomUUID() }, undefined, {
      parentId: parent.id,
      role: 'scout',
      requestId: randomUUID(),
    }),
    /隐身.*设备/,
  );
  await assert.rejects(
    w.send(secret.id, {
      ...input,
      participants: [{ kind: 'device', id: randomUUID(), name: 'Synthetic node', agent: 'Synthetic node' }],
    }),
    /隐身.*设备/,
  );
  assert.deepEqual(w.store.messages(secret.id), []);
  assert.deepEqual(w.store.conversationWorkflows(secret.id), [parent]);
});

test('leaving cancels queued and waiting work but lets an executing incognito workflow finish', async (t) => {
  const { workspace: w, project } = await setup(t);
  const secret = w.createConversation(project.id, undefined, true);
  const started = fixtureSignal(),
    release = fixtureSignal();
  t.mock.method(codexAdapter, 'execute', async () => {
    started.resolve();
    await release.promise;
    return result('completed', 'Done');
  });
  const running = await w.send(secret.id, { ...input, runtimeId: 'mock' });
  await started.promise;
  const pending = ['queued', 'waiting-resource', 'waiting-approval', 'waiting-confirmation'].map((status) => {
    const flow = { ...running.workflow!, id: randomUUID(), status, phase: 'queue', runIds: [], plan: [] } as Workflow;
    w.store.save('workflow', flow.id, secret.id, flow);
    return flow;
  });
  const cancelled = t.mock.method(w, 'cancel');
  assert.deepEqual(await w.closeIncognito(secret.id), { deleted: false });
  assert.deepEqual(cancelled.mock.calls.map((call) => call.arguments[0]).sort(), pending.map((flow) => flow.id).sort());
  for (const flow of pending) assert.equal(w.store.get<Workflow>('workflow', flow.id)?.status, 'cancelled');
  assert.equal(w.store.get<Workflow>('workflow', running.workflow!.id)?.status, 'running');
  const deleted = workflowState(w, () => !w.store.get('conversation', secret.id));
  release.resolve();
  await deleted;
});

test('leaving cancels a native approval wait instead of waiting for the user', async (t) => {
  const { workspace: w, project, controller } = await setup(t);
  controller.settings.toolApprovalMode = 'ask';
  const secret = w.createConversation(project.id, undefined, true);
  const started = fixtureSignal();
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    const approval = ctx.approve('synthetic_tool', 'Synthetic approval');
    started.resolve();
    await approval;
    return result('completed', 'Cancelled');
  });
  const sent = await w.send(secret.id, { ...input, runtimeId: 'mock' });
  await started.promise;
  await workflowState(w, () => w.store.get<Workflow>('workflow', sent.workflow!.id)?.status === 'waiting-approval');
  await w.closeIncognito(secret.id);
  await workflowState(w, () => !w.store.get('conversation', secret.id));
});

test('incognito continues only its own native CLI session', async (t) => {
  const { workspace: w, project } = await setup(t);
  const secret = w.createConversation(project.id, undefined, true);
  const ordinary = w.createConversation(project.id);
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    return result(
      'completed',
      'Done',
      ctx.input.workflowId === calls[0]?.input.workflowId ? 'ordinary-session' : 'incognito-session',
    );
  });
  const first = await w.send(ordinary.id, { ...input, runtimeId: 'mock' });
  await settledWorkflow(w, first.workflow!.id);
  const second = await w.send(secret.id, { ...input, runtimeId: 'mock' });
  await settledWorkflow(w, second.workflow!.id);
  const third = await w.send(secret.id, { ...input, runtimeId: 'mock', content: 'Continue our synthetic task' });
  await settledWorkflow(w, third.workflow!.id);
  assert.equal(calls[1]?.nativeSessionId, undefined);
  assert.equal(calls[2]?.nativeSessionId, 'incognito-session');
});

test('failed attachment cleanup continues other items and startup chats, keeps failed records and retries', async (t) => {
  const { workspace: w, controller, project } = await setup(t);
  t.mock.method(console, 'warn', () => {});
  const secret = w.createConversation(project.id, undefined, true);
  const ordinary = w.createConversation(project.id);
  const blocked = await saveAttachment(w.attachments, secret.id, {
    name: 'blocked.txt',
    mimeType: 'text/plain',
    dataBase64: Buffer.from('blocked').toString('base64'),
  });
  const removable = await saveAttachment(w.attachments, secret.id, {
    name: 'removable.txt',
    mimeType: 'text/plain',
    dataBase64: Buffer.from('removable').toString('base64'),
  });
  const removablePath = w.attachments.get(secret.id, removable.id).path;
  const blockedRow = w.store.get<{ fileName: string }>('attachment', blocked.id)!;
  w.store.save('attachment', blocked.id, secret.id, { ...blockedRow, fileName: '../invalid' });
  assert.deepEqual(await w.closeIncognito(secret.id), { deleted: false });
  assert.ok(w.store.get('conversation', secret.id));
  assert.ok(w.store.get('attachment', blocked.id));
  assert.equal(existsSync(removablePath), false);
  const message = w.store.addMessage(secret.id, 'user', 'DO_NOT_REPLAY');
  const queued = {
    id: randomUUID(),
    projectId: project.id,
    conversationId: secret.id,
    userMessageId: message.id,
    input: { ...input, runtimeId: 'mock' },
    runIds: [],
    plan: [],
    phase: 'queue',
    status: 'queued',
    memoryRevision: 0,
    memoryExcerpt: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as Workflow;
  w.store.save('workflow', queued.id, secret.id, queued);
  await w.close();
  const other = { ...secret, id: randomUUID(), closedAt: new Date().toISOString() };
  w.store.save('conversation', other.id, project.id, other);
  const restarted = new Workspace(controller, { memoryDebounceMs: 100000, autoTick: false });
  await restarted.tickQueue();
  assert.equal(w.store.get<Workflow>('workflow', queued.id)?.status, 'queued');
  // close() waits for the startup purge and retries the failed item without failing the backend.
  await restarted.close();
  assert.equal(w.store.get('conversation', other.id), undefined);
  assert.ok(w.store.get('conversation', ordinary.id));
  assert.ok(w.store.get('conversation', secret.id));
  w.store.save('attachment', blocked.id, secret.id, blockedRow);
  await purgeIncognito(w.store, w.attachments, false);
  assert.equal(w.store.get('conversation', secret.id), undefined);
});

test('an empty everyday incognito project is recycled, while shared projects and outside paths survive', async (t) => {
  const { workspace: w, controller, directory } = await setup(t);
  const secret = await w.createGeneralConversation('Synthetic', true);
  const project = w.store.get<import('../src/shared/types.ts').Project>('project', secret.projectId)!;
  writeFileSync(join(project.path, 'ai-output.txt'), 'SYNTHETIC_AI_FILE');
  const recycle = t.mock.fn(async (_root: string, paths: unknown) => {
    const folder = (paths as string[])[0]!;
    renameSync(folder, join(directory, 'synthetic-trash'));
    return { moved: [folder], failed: [] };
  });
  const { deleteIncognito } = await import('../src/server/incognito.ts');
  await deleteIncognito(w.store, w.attachments, secret.id, recycle);
  assert.equal(recycle.mock.calls[0]?.arguments[0], join(controller.dataDir, 'workspaces'));
  assert.deepEqual(recycle.mock.calls[0]?.arguments[1], [project.path]);
  assert.equal(w.store.get('project', project.id), undefined);
  assert.equal(readFileSync(join(directory, 'synthetic-trash', 'ai-output.txt'), 'utf8'), 'SYNTHETIC_AI_FILE');
  const shared = await w.createGeneralConversation('Synthetic', true);
  const kept = w.createConversation(shared.projectId);
  await deleteIncognito(w.store, w.attachments, shared.id, recycle);
  assert.ok(w.store.get('project', kept.projectId));
  assert.equal(recycle.mock.callCount(), 1);
  const outside = await w.createGeneralConversation('Synthetic', true);
  const outsideProject = w.store.get<import('../src/shared/types.ts').Project>('project', outside.projectId)!;
  outsideProject.path = directory;
  w.store.save('project', outsideProject.id, outsideProject.id, outsideProject);
  // An unexpected project path keeps the folder and project, but never blocks deleting the conversation.
  await deleteIncognito(w.store, w.attachments, outside.id, recycle);
  assert.equal(w.store.get('conversation', outside.id), undefined);
  assert.ok(w.store.get('project', outsideProject.id));
  assert.ok(existsSync(directory));
  assert.equal(recycle.mock.callCount(), 1);
});

test('member-result cleanup refuses traversal and redirected directories', async (t) => {
  const { workspace: w, controller, directory, project } = await setup(t);
  const secret = w.createConversation(project.id, undefined, true);
  assert.throws(() => incognitoDirectory(controller.dataDir, 'member-results', '../outside'), /Invalid/);
  const root = join(controller.dataDir, 'member-results');
  symlinkSync(directory, root, 'junction');
  await assert.rejects(
    (await import('../src/server/incognito.ts')).deleteIncognito(w.store, w.attachments, secret.id),
    /inside/,
  );
  assert.ok(w.store.get('conversation', secret.id));
  assert.ok(existsSync(directory));
  // Remove only the test junction, never recurse through it.
  (await import('node:fs')).unlinkSync(root);
});

test('surviving vector helper keeps passage order and matching vectors, including empty membership', () => {
  const items = [{ messageId: 'old' }, { messageId: 'live' }, { messageId: 'live' }];
  assert.deepEqual(survivingMemoryVectors(items, [1, 2, 3], new Set(['live'])), {
    items: items.slice(1),
    vectors: [2, 3],
  });
  assert.deepEqual(survivingMemoryVectors(items, [1, 2, 3], new Set()), { items: [], vectors: [] });
  assert.equal(survivingMemoryVectors(items, [1, 2, 3], new Set(['old', 'live'])), undefined);
});

test('memory toggle returns while vector pruning is still pending', async (t) => {
  const { workspace: w, project } = await setup(t);
  const conversation = w.createConversation(project.id);
  const started = fixtureSignal(),
    release = fixtureSignal();
  const open = ProjectVectors.open;
  t.mock.method(ProjectVectors, 'open', async (...args: Parameters<typeof open>) => {
    started.resolve();
    await release.promise;
    return open(...args);
  });
  let returned = false;
  const toggling = w.setConversationMemory(conversation.id, true).then(() => {
    returned = true;
  });
  try {
    await started.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(returned, true);
  } finally {
    release.resolve();
    await toggling;
  }
});

test('startup and shutdown purges invalidate warm summaries and publish the removal', async (t) => {
  const { workspace: w, controller, project } = await setup(t);
  const ordinary = w.createConversation(project.id);
  await w.close();
  const secret = {
    ...ordinary,
    id: randomUUID(),
    incognito: true,
    memory: 'off',
    closedAt: new Date().toISOString(),
  } as Conversation;
  const flow = {
    id: randomUUID(),
    projectId: project.id,
    conversationId: secret.id,
    status: 'completed',
    input,
    runIds: [],
    plan: [],
  } as unknown as Workflow;
  w.store.save('conversation', secret.id, project.id, secret);
  w.store.save('workflow', flow.id, secret.id, flow);
  const run = {
    id: randomUUID(),
    workflowId: flow.id,
    projectPath: project.path,
    startedAt: new Date().toISOString(),
    status: 'completed',
    kind: 'routine',
    prompt: 'PURGE_SECRET_PROMPT',
    output: 'PURGE_SECRET_OUTPUT',
    events: [],
    route: { runtimeId: 'mock', model: 'mock-model', kind: 'routine', reasons: [], warnings: [] },
  } as RunRecord;
  controller.store.saveRun(run);
  controller.broadcast();
  assert.ok(controller.recentState().runs.some((item) => item.id === run.id));
  const published: string[][] = [];
  const broadcast = controller.broadcast.bind(controller);
  t.mock.method(controller, 'broadcast', () => {
    broadcast();
    published.push(controller.recentState().runs.map((item) => item.id));
  });
  const restarted = new Workspace(controller, { memoryDebounceMs: 100000 });
  await workflowState(restarted, () => !restarted.store.get('conversation', secret.id));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(!published.at(-1)!.includes(run.id));
  const open = restarted.createConversation(project.id, undefined, true);
  restarted.store.save('workflow', flow.id, open.id, { ...flow, conversationId: open.id });
  controller.store.saveRun(run);
  controller.broadcast();
  assert.ok(controller.recentState().runs.some((item) => item.id === run.id));
  await restarted.close();
  assert.ok(!published.at(-1)!.includes(run.id));
  assert.ok(restarted.store.get('conversation', ordinary.id));
});

for (const failure of ['refused', 'throws'])
  test(`recycle ${failure} keeps the folder and project but deletes the conversation and records`, async (t) => {
    const { workspace: w, controller } = await setup(t);
    t.mock.method(console, 'warn', () => {});
    await w.close();
    const started = fixtureSignal(),
      release = fixtureSignal();
    const recycle = t.mock.fn(async (_root: string, paths: unknown) => {
      started.resolve();
      await release.promise;
      const folder = (paths as string[])[0]!;
      if (failure === 'throws') throw Error('Synthetic recycle unavailable');
      return { moved: [], failed: [{ path: folder, reason: 'Synthetic EBUSY' }] };
    });
    const reopened = new Workspace(controller, { recycleIncognito: recycle, memoryDebounceMs: 100000 });
    const secret = await reopened.createGeneralConversation('Synthetic', true);
    const project = reopened.store.get<import('../src/shared/types.ts').Project>('project', secret.projectId)!;
    writeFileSync(join(project.path, 'keep.txt'), 'SYNTHETIC_KEEP');
    const flowId = randomUUID();
    const runId = randomUUID();
    reopened.store.save('workflow', flowId, secret.id, {
      id: flowId,
      conversationId: secret.id,
      projectId: project.id,
      status: 'completed',
      runIds: [runId],
    });
    reopened.store.addMessage(secret.id, 'user', 'SYNTHETIC_SECRET', flowId);
    controller.store.db
      .prepare('INSERT INTO runs(id,started_at,value) VALUES(?,?,?)')
      .run(runId, new Date().toISOString(), JSON.stringify({ id: runId, workflowId: flowId }));
    const closing = reopened.closeIncognito(secret.id);
    await started.promise;
    assert.throws(() => reopened.createConversation(project.id), /工作目录正在关闭/);
    release.resolve();
    assert.deepEqual(await closing, { deleted: true });
    assert.equal(reopened.store.get('conversation', secret.id), undefined);
    assert.equal(reopened.store.get('workflow', flowId), undefined);
    assert.deepEqual(reopened.store.messages(secret.id), []);
    assert.equal(controller.store.storedRun(runId), undefined);
    assert.deepEqual(reopened.store.get('project', project.id), project);
    assert.equal(readFileSync(join(project.path, 'keep.txt'), 'utf8'), 'SYNTHETIC_KEEP');
    await reopened.close();
    assert.deepEqual(reopened.store.get('project', project.id), project);
    assert.equal(readFileSync(join(project.path, 'keep.txt'), 'utf8'), 'SYNTHETIC_KEEP');
  });

test('one cancellation failure does not block leaving or cancelling other queued work', async (t) => {
  const { workspace: w, project } = await setup(t);
  const secret = w.createConversation(project.id, undefined, true);
  const ids = [randomUUID(), randomUUID()];
  for (const id of ids)
    w.store.save('workflow', id, secret.id, {
      id,
      conversationId: secret.id,
      projectId: project.id,
      status: 'queued',
      runIds: [],
    });
  const warnings = t.mock.method(console, 'warn', () => {});
  const cancelled = t.mock.method(w, 'cancel', (id: string) => {
    if (id === ids[0]) throw Error('Synthetic steer is being delivered');
  });
  assert.deepEqual(await w.closeIncognito(secret.id), { deleted: true });
  assert.deepEqual(cancelled.mock.calls.map((call) => call.arguments[0]).sort(), ids.sort());
  assert.equal(warnings.mock.callCount(), 1);
});

test('startup queue runs ordinary work while incognito recycling is pending', async (t) => {
  const { workspace: w, controller, project, directory } = await setup(t);
  const ordinary = w.createConversation(project.id);
  const secret = await w.createGeneralConversation('Synthetic');
  await w.close();
  w.store.save('conversation', secret.id, secret.projectId, { ...secret, incognito: true, memory: 'off' });
  const started = fixtureSignal(),
    release = fixtureSignal();
  const restarted = new Workspace(controller, {
    purgeAllIncognito: true,
    autoTick: false,
    memoryDebounceMs: 100000,
    recycleIncognito: async (_root, paths) => {
      started.resolve();
      await release.promise;
      const folder = (paths as string[])[0]!;
      renameSync(folder, join(directory, 'startup-trash'));
      return { moved: [folder], failed: [] };
    },
  });
  t.mock.method(codexAdapter, 'execute', async () => result('completed', 'Ordinary task finished'));
  try {
    await started.promise;
    assert.ok(restarted.store.get<Conversation>('conversation', secret.id)?.closedAt);
    const sent = await restarted.send(ordinary.id, { ...input, runtimeId: 'mock', queue: true });
    void restarted.tickQueue();
    assert.equal((await settledWorkflow(restarted, sent.workflow!.id)).status, 'completed');
    assert.ok(restarted.store.get('conversation', secret.id));
  } finally {
    let closed = false;
    const closing = restarted.close().then(() => {
      closed = true;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(closed, false, 'shutdown must await the pending recycle before the database can close');
    } finally {
      release.resolve();
      await closing;
    }
    assert.equal(restarted.store.get('conversation', secret.id), undefined);
    assert.ok(restarted.store.get('conversation', ordinary.id));
  }
});

test('a startup purge publish failure is logged and later queue passes still run', async (t) => {
  const { workspace: w, controller, project } = await setup(t);
  const ordinary = w.createConversation(project.id);
  await w.close();
  const secret = { ...ordinary, id: randomUUID(), incognito: true, closedAt: new Date().toISOString() };
  w.store.save('conversation', secret.id, project.id, secret);
  const warnings = t.mock.method(console, 'warn', () => {});
  const broadcast = controller.broadcast.bind(controller);
  let fail = true;
  t.mock.method(controller, 'broadcast', () => {
    if (fail) {
      fail = false;
      throw Error('Synthetic startup publish failure');
    }
    broadcast();
  });
  const restarted = new Workspace(controller, { autoTick: false, memoryDebounceMs: 100000 });
  t.mock.method(codexAdapter, 'execute', async () => result('completed', 'Ordinary task finished'));
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(warnings.mock.callCount(), 1);
    assert.match(String(warnings.mock.calls[0].arguments[0]), /startup cleanup failed/);
    for (let i = 0; i < 2; i++) {
      const sent = await restarted.send(ordinary.id, { ...input, runtimeId: 'mock', queue: true });
      await restarted.tickQueue();
      assert.equal((await settledWorkflow(restarted, sent.workflow!.id)).status, 'completed');
    }
  } finally {
    await restarted.close();
  }
});
