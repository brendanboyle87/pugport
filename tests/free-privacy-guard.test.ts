import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freeTextOnlyPrompt } from '../src/server/workspace.ts';
import { AgentBridge } from '../src/server/agent-bridge.ts';
import { ConversationAutomation } from '../src/server/conversation-automation.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { piAdapter, createPiAdapter } from '../src/server/adapters/pi.ts';
import type { ExecuteContext, RunInput, RunRecord, Workflow, WorkflowStep } from '../src/shared/types.ts';
import { freeStage2Fixture } from './free-stage2-fixture.ts';

const message = {
  content: 'Say hello',
  mode: 'chat' as const,
  permissionMode: 'read-only' as const,
  executionPolicy: 'cli-first' as const,
};

test('old message saveMoney is accepted, dropped and does not override balanced routing', async (t) => {
  const f = await freeStage2Fixture(t);
  f.controller.settings.routeGoal = 'balanced';
  const seen: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    seen.push(ctx);
    return { output: 'Normal answer' };
  });
  t.mock.method(piAdapter, 'execute', async () => {
    throw Error('legacy saveMoney must not select a free source');
  });
  const legacy = { ...message, saveMoney: true };
  const workflow = await f.finish((await f.workspace.send(f.conversation.id, legacy)).workflow.id);
  assert.equal(workflow.status, 'completed');
  assert.equal('saveMoney' in workflow.input, false);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.target.id, 'codex');
  assert.equal('saveMoney' in seen[0]!.input, false);
  assert.equal(legacy.saveMoney, true, 'dropping a retired field does not mutate caller data');
});

test('text-only prompt retains at most twelve text turns and explicit quotes, capped at 20000', () => {
  const messages = Array.from({ length: 20 }, (_, i) => ({
    role: 'user' as const,
    content: `visible-turn-${i}-end`,
    attachments: [{ text: 'PRIVATE_ATTACHMENT' }],
    memory: 'PRIVATE_MEMORY',
  }));
  const prompt = freeTextOnlyPrompt(messages, 'CURRENT_USER', [{ text: 'QUOTED_PASSAGE', note: 'QUOTE_NOTE' }]);
  assert.doesNotMatch(prompt, /visible-turn-7-end|PRIVATE_/);
  assert.match(prompt, /visible-turn-8-end/);
  assert.match(prompt, /CURRENT_USER/);
  assert.match(prompt, /QUOTED_PASSAGE/);
  assert.match(prompt, /QUOTE_NOTE/);
  assert.match(prompt, /没有任何工具/);
  assert.equal(freeTextOnlyPrompt(messages, 'x'.repeat(40000)).length, 20000);
});

test('workspace builds an independent prompt; hosted start swaps it and records text-only permissions', async (t) => {
  const f = await freeStage2Fixture(t);
  f.controller.settings.globalInstructions = 'PRIVATE_PERSONAL_INSTRUCTIONS';
  f.controller.targets = f.controller.targets.filter((target) => target.id !== 'api-ollama');
  f.controller.snapshots = f.controller.snapshots.filter((target) => target.id !== 'api-ollama');
  const seen: ExecuteContext[] = [];
  t.mock.method(piAdapter, 'execute', async (ctx: ExecuteContext) => {
    seen.push(ctx);
    return { output: 'Hello' };
  });
  f.workspace.store.addMessage(f.conversation.id, 'user', 'VISIBLE_HISTORY');
  const workflow = await f.finish(
    (await f.workspace.send(f.conversation.id, { ...message, quotes: [{ text: 'VISIBLE_QUOTE' }] })).workflow.id,
  );
  assert.equal(workflow.status, 'completed');
  assert.equal(seen.length, 1);
  const ctx = seen[0]!;
  assert.equal(ctx.target.id, 'hosted');
  assert.equal(ctx.input.textOnly, true);
  assert.equal(ctx.input.permissionMode, 'read-only');
  assert.deepEqual(workflow.input.permissionOrigin, { mode: 'read-only', source: 'privacy' });
  assert.equal(ctx.input.prompt, ctx.input.textOnlyPrompt);
  assert.equal(ctx.input.continuationPrompt, ctx.input.textOnlyPrompt);
  assert.equal(ctx.input.attachments, undefined);
  assert.equal(ctx.agentBridge, undefined);
  assert.match(ctx.input.prompt, /VISIBLE_HISTORY/);
  assert.match(ctx.input.prompt, /VISIBLE_QUOTE/);
  assert.doesNotMatch(ctx.input.prompt, /PRIVATE_|项目上下文|当前状态/);
  assert.equal(f.controller.run(workflow.runIds.at(-1)!)!.textOnly, true);
});

test('workspace input excludes assembled context and child parent reports', async (t) => {
  const f = await freeStage2Fixture(t);
  f.controller.settings.globalInstructions = 'PRIVATE_PERSONAL_INSTRUCTIONS';
  const user = f.workspace.store.addMessage(f.conversation.id, 'user', 'USER_TEXT');
  const workflow = {
    id: 'workflow',
    projectId: f.project.id,
    conversationId: f.conversation.id,
    userMessageId: user.id,
    input: message,
    runIds: [],
    steps: [],
  } as unknown as Workflow;
  const build = (
    f.workspace as unknown as {
      input: (w: Workflow, p: typeof f.project, prompt: string, step?: WorkflowStep) => RunInput;
    }
  ).input.bind(f.workspace);
  const input = build(
    workflow,
    f.project,
    'PRIVATE_RULES PRIVATE_MEMORY PRIVATE_AUTO_MEMORY PRIVATE_WORKLOG PRIVATE_EXCERPTS PRIVATE_HANDOFF PRIVATE_ATTACHMENT',
  );
  assert.match(input.textOnlyPrompt!, /USER_TEXT/);
  assert.doesNotMatch(input.textOnlyPrompt!, /PRIVATE_/);
  const child = build(
    {
      ...workflow,
      input: { ...message, content: 'PRIVATE_PARENT_REPORT', intentText: 'CHILD_TASK' },
      delegation: { parentId: 'parent', role: 'scout', requestId: 'request' },
    },
    f.project,
    'PRIVATE_HANDOFF',
  );
  assert.match(child.textOnlyPrompt!, /CHILD_TASK/);
  assert.doesNotMatch(child.textOnlyPrompt!, /PRIVATE_|USER_TEXT/);
});

test('controller rejects bypassed privacy input before adapter execution; session scopes must match', async (t) => {
  const f = await freeStage2Fixture(t);
  let calls = 0;
  t.mock.method(piAdapter, 'execute', async () => {
    calls++;
    return { output: '' };
  });
  const target = f.controller.targets.find((t) => t.id === 'hosted')!;
  const input: RunInput = {
    prompt: 'PRIVATE_CONTEXT',
    projectPath: f.project.path,
    kind: 'routine',
    permissionMode: 'read-only',
  };
  const run: RunRecord = {
    id: 'guard-run',
    projectPath: f.project.path,
    prompt: input.prompt,
    kind: 'routine',
    status: 'running',
    route: { runtimeId: target.id, model: 'fixture', kind: 'routine', reasons: [], warnings: [] },
    startedAt: new Date().toISOString(),
    output: '',
    events: [],
    permissionMode: 'read-only',
    toolApprovalMode: 'auto',
  };
  await f.controller.execute(run, input, target, new AbortController());
  assert.equal(calls, 0);
  assert.equal(run.errorCode, 'privacy-text-only');
  const same = (
    f.controller as unknown as { sameNativePermissions: (r: RunRecord, i: RunInput) => boolean }
  ).sameNativePermissions.bind(f.controller);
  assert.equal(same(run, input), true);
  assert.equal(same(run, { ...input, textOnly: true }), false);
  assert.equal(same({ ...run, textOnly: true }, { ...input, textOnly: true }), true);
  assert.equal(same({ ...run, textOnly: true }, input), false);
});

test('Pi refuses an unguarded may-log request without spawning', async () => {
  let spawned = false;
  const adapter = createPiAdapter({
    spawn: async () => {
      spawned = true;
      throw Error('unexpected spawn');
    },
  });
  await assert.rejects(
    adapter.execute({
      target: { id: 'hosted', provider: 'pi', gateway: 'api', apiProvider: 'groq-free' },
      input: { prompt: 'PRIVATE_CONTEXT', projectPath: 'fixture', kind: 'routine', permissionMode: 'read-only' },
      signal: new AbortController().signal,
    } as ExecuteContext),
    /privacy-text-only/,
  );
  assert.equal(spawned, false);
});

test('start resumes only a text-only session even with automatic reset checks enabled', async (t) => {
  const f = await freeStage2Fixture(t);
  f.controller.settings.autoUseResetCards = true;
  const seen: ExecuteContext[] = [];
  t.mock.method(piAdapter, 'execute', async (ctx: ExecuteContext) => {
    seen.push(ctx);
    return { output: 'Hello' };
  });
  const previous: RunRecord = {
    id: 'previous-text-session',
    prompt: 'safe',
    projectPath: f.project.path,
    kind: 'routine',
    status: 'completed',
    startedAt: new Date().toISOString(),
    output: '',
    events: [],
    nativeSessionId: 'synthetic-session',
    route: { runtimeId: 'hosted', model: 'pugport-ollama/qwen', kind: 'routine', reasons: [], warnings: [] },
    permissionMode: 'read-only',
    toolApprovalMode: 'auto',
    textOnly: false,
  };
  const input: RunInput = {
    prompt: 'PRIVATE_ASSEMBLED',
    textOnlyPrompt: 'safe current message',
    projectPath: f.project.path,
    kind: 'routine',
    permissionMode: 'read-only',
    resumeRunId: previous.id,
  };
  f.controller.store.saveRun(previous);
  await assert.rejects(f.controller.start(input));
  assert.equal(seen.length, 0);
  f.controller.store.saveRun({ ...previous, textOnly: true });
  const next = await f.controller.start(input);
  assert.equal(next.textOnly, true);
  assert.equal(next.parentRunId, previous.id);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.nativeSessionId, previous.nativeSessionId);
  assert.equal(seen[0]!.input.prompt, input.textOnlyPrompt);
});

for (const source of ['external', 'caller', 'device', 'user'] as const) {
  test(`privacy fallback preserves ${source} workflow provenance and subsequent tool restrictions`, async (t) => {
    const f = await freeStage2Fixture(t);
    f.controller.targets = f.controller.targets.filter((target) => target.id !== 'api-ollama');
    f.controller.snapshots = f.controller.snapshots.filter((target) => target.id !== 'api-ollama');
    f.controller.agentBridgeUrl = 'http://127.0.0.1:5555/synthetic-bridge';
    const work = new ConversationAutomation(f.workspace);
    f.workspace.conversationAutomation = work;
    const bridge = new AgentBridge(f.workspace, f.controller);
    t.after(async () => {
      work.close();
      await bridge.close();
    });
    const origin = {
      mode: 'read-only' as const,
      source,
      note: 'synthetic origin',
      scope: f.project.path,
      unrestricted: false,
    };
    const calls: ExecuteContext[] = [];
    let names: string[] = [];
    t.mock.method(piAdapter, 'execute', async (ctx: ExecuteContext) => {
      calls.push(ctx);
      throw Error('quota-or-rate-limit');
    });
    t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
      calls.push(ctx);
      assert.ok(ctx.agentBridge);
      const listed = await bridge.handle(`Bearer ${ctx.agentBridge.token}`, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      });
      const result = listed.body as { result?: { tools: Array<{ name: string }> } };
      assert.ok(result.result, JSON.stringify(listed.body));
      names = result.result.tools.map((tool) => tool.name);
      return { output: 'Normal answer' };
    });
    const workflow = await f.finish(
      (await f.workspace.send(f.conversation.id, { ...message, permissionOrigin: origin })).workflow.id,
    );
    assert.equal(workflow.status, 'completed');
    assert.deepEqual(
      calls.map((ctx) => ctx.target.id),
      ['hosted', 'codex'],
    );
    assert.equal(calls[0]!.input.textOnly, true);
    assert.deepEqual(calls[0]!.input.permissionOrigin, { mode: 'read-only', source: 'privacy' });
    assert.equal(calls[0]!.agentBridge, undefined);
    assert.equal(origin.source, source, 'controller privacy input does not mutate the caller origin');
    const expected = source === 'user' ? { mode: 'read-only', source: 'privacy' } : origin;
    assert.equal(workflow.input.permissionMode, 'read-only');
    assert.deepEqual(workflow.input.permissionOrigin, expected);
    assert.equal(calls[1]!.input.textOnly, undefined);
    assert.deepEqual(calls[1]!.input.permissionOrigin, source === 'user' ? { mode: 'read-only', source } : origin);
    for (const name of ['create_lane', 'schedule_work', 'watch_pull_request', 'pause_scheduled_work'])
      assert.equal(names.includes(name), source === 'user', name);
    const actor = {
      conversationId: workflow.conversationId,
      workflowId: workflow.id,
      source: 'agent' as const,
      write: false,
    };
    if (source === 'user') assert.doesNotThrow(() => work.assertForeground(actor));
    else assert.throws(() => work.assertForeground(actor), /外部派来的任务不能创建或恢复/);
  });
}
