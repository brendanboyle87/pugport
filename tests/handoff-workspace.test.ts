import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { claudeAdapter } from '../src/server/adapters/claude.ts';
import { handoffNoteIn } from '../src/shared/handoff-note.ts';
import type { ExecuteContext, MessageInput, RuntimeSnapshot, Workflow } from '../src/shared/types.ts';

const input: MessageInput = {
  content: 'Finish the synthetic parser and keep its public API.',
  mode: 'build',
  permissionMode: 'workspace-write',
  executionPolicy: 'cli-first',
  autoEscalate: true,
};
function fixture(t: TestContext, resume = true) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-handoff-workspace-')));
  const oldMemory = process.env.COMBORUNNER_MEMORY_DIR;
  process.env.COMBORUNNER_MEMORY_DIR = join(directory, 'memory');
  const controller = new Controller(directory, join(directory, 'data'));
  clearInterval(controller.timer);
  controller.settings.taskJudgment = 'local';
  controller.settings.routineProvider = 'codex';
  controller.targets = [
    { id: 'mock', provider: 'codex', label: 'Synthetic', command: 'unused', environment: 'native', enabled: true },
    { id: 'other', provider: 'claude', label: 'Other', command: 'unused', environment: 'native', enabled: false },
  ];
  const snapshot = (id: string, provider: 'codex' | 'claude'): RuntimeSnapshot => ({
    id,
    provider,
    label: id,
    environment: 'native',
    installed: true,
    status: 'ready',
    authMode: 'chatgpt',
    accountFingerprint: `synthetic-${id}`,
    models: [{ id: 'mock-model', label: 'Mock', efforts: ['medium', 'high'] }],
    quota: {
      status: 'known',
      source: 'fixture',
      observedAt: new Date().toISOString(),
      windows: [{ id: 'week', label: 'Week', usedPercent: 10, resetsAt: new Date(Date.now() + 3600000).toISOString() }],
    },
    capabilities: { execute: true, resume, cancel: true, approvals: true },
    refreshedAt: new Date().toISOString(),
  });
  controller.snapshots = [snapshot('mock', 'codex'), snapshot('other', 'claude')];
  t.mock.method(controller, 'refresh', async () => {});
  const workspace = new Workspace(controller, { memoryDebounceMs: 100000 });
  t.after(async () => {
    await workspace.close();
    await controller.close();
    if (oldMemory === undefined) delete process.env.COMBORUNNER_MEMORY_DIR;
    else process.env.COMBORUNNER_MEMORY_DIR = oldMemory;
    assert.ok(
      directory.startsWith(realpathSync.native(tmpdir()) + sep) &&
        basename(directory).startsWith('pugport-handoff-workspace-'),
    );
    rmSync(directory, { recursive: true, force: true });
  });
  return { controller, workspace, directory };
}
async function finished(workspace: Workspace, id: string) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const flow = workspace.store.get<Workflow>('workflow', id)!;
    if (['completed', 'blocked', 'cancelled', 'failed'].includes(flow.status)) return flow;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error('Synthetic workflow did not finish');
}
const plan = {
  output: JSON.stringify({
    steps: [
      {
        id: 'parser',
        title: 'Synthetic parser',
        instruction: 'Finish the parser',
        kind: 'general',
        transport: 'auto',
        dependsOn: [],
      },
    ],
  }),
};
function work(ctx: ExecuteContext, directory: string) {
  ctx.emit({
    at: new Date().toISOString(),
    type: 'tool',
    data: {
      itemId: 'call_WS_RAW_EDIT',
      kind: 'fileChange',
      status: 'completed',
      input: { changes: [{ path: join(directory, 'src', 'parse.ts'), kind: 'update' }] },
    },
  });
  ctx.emit({
    at: new Date().toISOString(),
    type: 'tool',
    data: {
      itemId: 'call_WS_RAW_TEST',
      kind: 'commandExecution',
      status: 'completed',
      exitCode: 0,
      command: 'npm test',
    },
  });
}
function result(status: 'completed' | 'blocked', summary: string) {
  return {
    nativeSessionId: 'synthetic-session',
    output: `${summary}\nCOMBORUNNER_TASK_RESULT: ${JSON.stringify({ status, summary })}`,
  };
}

test('native continuation and handoff queries seek the selected conversation through the workflow index', async (t) => {
  const f = fixture(t);
  const queries = new Set<string>();
  const prepare = f.workspace.store.db.prepare;
  t.mock.method(f.workspace.store.db, 'prepare', function (sql: string) {
    if (/SELECT run\.id FROM/.test(sql)) queries.add(sql);
    return prepare.call(f.workspace.store.db, sql);
  });
  t.mock.method(codexAdapter, 'execute', async () => result('completed', 'Synthetic reply.'));
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  for (let turn = 0; turn < 2; turn++) {
    const sent = await f.workspace.send(conversation.id, {
      ...input,
      content: 'Explain the synthetic example.',
      mode: 'chat',
      permissionMode: 'read-only',
      runtimeId: 'mock',
    });
    assert.equal((await finished(f.workspace, sent.workflow.id)).status, 'completed');
  }
  assert.equal(queries.size, 2);
  for (const sql of queries) {
    const plan = prepare
      .call(f.workspace.store.db, `EXPLAIN QUERY PLAN ${sql}`)
      .all(...Array(sql.match(/\?/g)!.length).fill('synthetic'))
      .map((row) => String(row.detail))
      .join('\n');
    assert.match(plan, /SEARCH origin USING INDEX workspace_owner/);
    assert.match(plan, /SEARCH run USING INDEX runs_workflow \(<expr>=\?\)/);
  }
});

test('a quota handoff in a task gives the next executor the note, which the run keeps for the 交接条 view', async (t) => {
  const f = fixture(t);
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    if (!ctx.input.stepId) return plan;
    calls.push(ctx);
    f.controller.targets[1]!.enabled = true;
    work(ctx, f.directory);
    ctx.emit({
      at: new Date().toISOString(),
      type: 'text',
      text: `WS_OUTPUT_HEAD\n${'Synthetic narrative.\n'.repeat(3000)}WS_OUTPUT_TAIL`,
    });
    throw new Error('quota-or-rate-limit');
  });
  t.mock.method(claudeAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    return result('completed', 'Synthetic remaining work complete.');
  });
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const sent = await f.workspace.send(conversation.id, input);
  const flow = await finished(f.workspace, sent.workflow.id);
  assert.equal(flow.status, 'completed', flow.error ?? 'the synthetic handoff must complete');
  assert.deepEqual(
    calls.map((ctx) => ctx.target.id),
    ['mock', 'other'],
  );
  const note = handoffNoteIn(calls[1]!.input.prompt);
  assert.ok(note, 'the relayed executor got a handoff note');
  assert.match(note, /目标：Finish the synthetic parser and keep its public API\./);
  assert.match(note, /- 改文件 src\/parse\.ts → 完成/);
  assert.match(note, /- 命令 `npm test` → 退出码 0/);
  assert.match(note, /项目文件夹不是 git 仓库/);
  assert.match(note, /交接原因：先前执行器 Synthetic \/ mock-model 因已确认的额度不足或限流结束/);
  assert.match(note, /〔r1 #1〕/);
  assert.match(calls[1]!.input.prompt, /〔r1 #1〕/);
  assert.doesNotMatch(calls[1]!.input.prompt, /call_WS_RAW_EDIT/);
  assert.ok(note.length <= 6000);
  assert.ok(calls[1]!.input.prompt.includes('WS_OUTPUT_TAIL'));
  assert.ok(!calls[1]!.input.prompt.includes('WS_OUTPUT_HEAD'), 'the earlier output is only a capped tail');
  // The saved run keeps exactly what was handed over; the task card shows it as 交接条.
  const relayed = f.controller.store.run(flow.runIds.at(-1)!)!;
  assert.equal(relayed.relay?.reason, 'quota');
  assert.equal(handoffNoteIn(relayed.prompt), note);
});

test('continuing on the same executor reuses its native session without a note; a fresh session gets one', async (t) => {
  for (const resume of [true, false])
    await t.test(resume ? 'same native session' : 'fresh session', async (t) => {
      const f = fixture(t, resume);
      const calls: ExecuteContext[] = [];
      t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
        if (!ctx.input.stepId) return plan;
        calls.push(ctx);
        if (calls.length > 1) return result('completed', 'Synthetic remaining work complete.');
        work(ctx, f.directory);
        return result('blocked', 'Synthetic parser stopped before the escapes.');
      });
      const project = await f.workspace.createProject(f.directory);
      const conversation = f.workspace.createConversation(project.id);
      const sent = await f.workspace.send(conversation.id, { ...input, runtimeId: 'mock' });
      const stopped = await finished(f.workspace, sent.workflow.id);
      assert.equal(stopped.status, 'blocked');
      const next = await f.workspace.continue(stopped.id);
      assert.equal((await finished(f.workspace, next.workflow.id)).status, 'completed');
      assert.equal(calls.length, 2);
      const note = handoffNoteIn(calls[1]!.input.prompt);
      if (resume) {
        assert.equal(calls[1]!.nativeSessionId, 'synthetic-session');
        assert.equal(note, undefined, 'the native session already has the context: its prompt is unchanged');
      } else {
        assert.equal(calls[1]!.nativeSessionId, undefined);
        assert.ok(note, 'a fresh session is told where the task stopped');
        assert.match(note, /- 改文件 src\/parse\.ts → 完成/);
        assert.match(note, /交接原因：原任务暂停/);
        assert.match(note, /Synthetic parser stopped before the escapes\./);
        assert.ok(!calls[1]!.input.prompt.includes('最近未完成任务的已保存输出'), 'the note replaces the raw excerpts');
      }
    });
});
