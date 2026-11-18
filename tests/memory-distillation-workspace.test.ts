import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { fixture, input, finished, result } from './helpers/session-workspace.ts';
import type { ExecuteContext, RunRecord, Workflow } from '../src/shared/types.ts';

test('auto note follows owner memory in the stable prefix and is isolated from chat scope and untrusted tasks', async (t) => {
  const f = fixture(t, false);
  f.controller.snapshots[0]!.capabilities.toolless = true;
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    return result('completed', 'Synthetic reply.');
  });
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const owner = f.workspace.store.setMemory(project.id, 'OWNER_MEMORY\r\nKeep exact bytes.');
  f.workspace.store.setMemoryAuto(project.id, {
    content: 'facts:\nAUTO_NOTE\ndecisions:\nKeep API\npitfalls:\nCheck inputs',
    sourceRuntimeId: 'mock',
    runId: 'seed',
  });
  for (const content of ['First prompt', 'Second prompt']) {
    const sent = await f.workspace.send(conversation.id, {
      ...input,
      mode: 'chat',
      permissionMode: 'read-only',
      content,
      runtimeId: 'mock',
    });
    assert.equal((await finished(f.workspace, sent.workflow.id)).status, 'completed');
    assert.ok(sent.workflow.memoryExcerpt.indexOf('OWNER_MEMORY') < sent.workflow.memoryExcerpt.indexOf('AUTO_NOTE'));
  }
  const [a, b] = calls.map((ctx) => ctx.input.prompt);
  assert.match(a!, /自动整理的项目笔记（机器生成，仅供参考，手写记忆优先）/);
  assert.ok(a!.indexOf('OWNER_MEMORY') < a!.indexOf('AUTO_NOTE'));
  const prefix = a!.slice(0, a!.indexOf('AUTO_NOTE') + 'AUTO_NOTE'.length);
  assert.ok(b!.startsWith(prefix));
  assert.deepEqual(f.workspace.store.memory(project.id), owner);
  for (const untrusted of [true, false]) {
    if (!untrusted) f.workspace.store.save('project', project.id, project.id, { ...project, scope: 'chat' });
    const fresh = f.workspace.createConversation(project.id);
    const sent = await f.workspace.send(fresh.id, {
      ...input,
      mode: 'chat',
      permissionMode: 'read-only',
      runtimeId: 'mock',
      untrustedContent: untrusted,
      content: 'Explain this text',
    });
    await finished(f.workspace, sent.workflow.id);
    assert.doesNotMatch(sent.workflow.memoryExcerpt, /AUTO_NOTE/);
    assert.doesNotMatch(calls.at(-1)!.input.prompt, /AUTO_NOTE/);
  }
});

test('distillation uses the normal controller run and usage ledger without creating conversation messages', async (t) => {
  const f = fixture(t);
  f.controller.settings.memoryDistillation = { enabled: true };
  f.controller.snapshots[0]!.quota.windows[0]!.durationMinutes = 10080;
  f.controller.snapshots[0]!.capabilities.toolless = true;
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const at = new Date(Date.now() - 1000).toISOString();
  for (let n = 0; n < 5; n++) {
    const id = 'seed-' + n,
      rid = 'run-' + n;
    f.workspace.store.save('workflow', id, conversation.id, {
      id,
      projectId: project.id,
      conversationId: conversation.id,
      userMessageId: 'msg-' + n,
      input: { content: 'Synthetic completed progress '.repeat(180) },
      createdAt: at,
      updatedAt: at,
      status: 'completed',
      plan: [],
      runIds: [rid],
    } as unknown as Workflow);
    f.controller.store.saveRun({
      id: rid,
      workflowId: id,
      projectPath: project.path,
      prompt: 'Synthetic',
      output: '',
      route: { runtimeId: 'mock', provider: 'codex', model: 'mock-model', kind: 'routine', reason: 'fixture' },
      kind: 'routine',
      startedAt: at,
      endedAt: at,
      status: 'completed',
      events: [{ at, type: 'tool', data: { tool: 'Edit', status: 'completed' } }],
    } as unknown as RunRecord);
  }
  let call: ExecuteContext | undefined;
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    call = ctx;
    return {
      output:
        'add facts verified 有测试。 | seed-0\nadd decisions inferred 保留接口。 | seed-1\nadd pitfalls verified 核对边界。 | seed-2',
    };
  });
  const original = f.workspace.store.messages(conversation.id);
  for (const status of ['queued', 'waiting-resource', 'waiting-confirmation', 'waiting-approval', 'running'] as const) {
    const flow = f.workspace.store.get<Workflow>('workflow', 'seed-0')!;
    f.workspace.store.save('workflow', flow.id, conversation.id, { ...flow, status });
    assert.equal(f.workspace.memoryAuto(project.id).eligible, false, status);
    await assert.rejects(f.workspace.redistillMemory(project.id));
    f.workspace.store.save('workflow', flow.id, conversation.id, { ...flow, status: 'completed' });
  }
  f.controller.foregroundStarts++;
  assert.equal(f.workspace.memoryAuto(project.id).eligible, false);
  f.controller.foregroundStarts--;
  assert.equal(
    f.workspace.memoryAuto(project.id).eligible,
    true,
    f.workspace.memoryAuto(project.id).reason ?? 'eligible',
  );
  await f.workspace.redistillMemory(project.id);
  const note = f.workspace.store.memoryAuto(project.id);
  assert.ok(note);
  assert.equal(
    note.content,
    'facts:\n- [verified] 有测试。 (seed-0)\ndecisions:\n- [inferred] 保留接口。 (seed-1)\npitfalls:\n- [verified] 核对边界。 (seed-2)',
  );
  const run = f.controller.store.run(note.runId)!;
  assert.equal(run.status, 'completed');
  assert.equal(run.userInput, '整理项目记忆');
  assert.equal(run.toolless, true);
  assert.equal(run.permissionMode, 'read-only');
  assert.equal(run.workflowId, undefined);
  assert.equal(call!.input.agentCalls, false);
  assert.equal(call!.input.allowExecutorFallback, false);
  assert.ok(f.controller.store.db.prepare('SELECT id FROM usage_runs WHERE id=?').get(run.id));
  assert.deepEqual(f.workspace.store.messages(conversation.id), original);
  await assert.rejects(f.workspace.redistillMemory(project.id));
});
