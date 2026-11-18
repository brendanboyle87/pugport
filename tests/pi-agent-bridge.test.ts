import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { AgentBridge } from '../src/server/agent-bridge.ts';
import { piAdapter } from '../src/server/adapters/pi.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { apiBudgetPolicy } from '../src/server/api-budget.ts';
import type { ExecuteContext, RuntimeTarget, RuntimeSnapshot, Workflow } from '../src/shared/types.ts';

function fixture(t: TestContext, paceCredit = false) {
  const now = Date.now();
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-pi-agent-test-')));
  const controller = new Controller(directory, join(directory, 'data'));
  clearInterval(controller.timer);
  controller.settings.decisionMode = 'auto';
  controller.settings.maxConcurrentRuns = 0;
  controller.settings.architectureProvider = 'codex';
  controller.settings.routineProvider = 'codex';
  controller.agentBridgeUrl = 'http://127.0.0.1:0/mcp';
  const target = (id: string, provider: RuntimeTarget['provider'], label: string): RuntimeTarget => ({
    id,
    provider,
    label,
    command: 'not-executed',
    environment: 'native',
    enabled: true,
    ...(provider === 'pi'
      ? {
          gateway: 'api',
          apiProvider: 'openai',
          accountingMode: 'usage',
          agentDir: join(directory, id),
          apiBudget: apiBudgetPolicy(
            {
              limitUsd: 10,
              perRunUsd: 1,
              maxConcurrentRuns: 3,
              burstConcurrentRuns: 4,
              preferExpiring: paceCredit,
              ...(paceCredit ? { expiresAt: new Date(now + 10 * 86_400_000).toISOString() } : {}),
            },
            undefined,
            new Date(now - (paceCredit ? 10 * 86_400_000 : 0)).toISOString(),
          ),
        }
      : {}),
  });
  controller.targets = [
    target('pi-a', 'pi', 'API Pi A'),
    target('pi-b', 'pi', 'API Pi B'),
    target('codex-b', 'codex', 'Codex B'),
  ];
  controller.snapshots = controller.targets.map((profile): RuntimeSnapshot => ({
    ...profile,
    installed: true,
    status: 'ready',
    models: [
      {
        id: profile.provider === 'pi' ? 'openai/test-model' : 'test-model',
        label: 'Fixture',
        efforts: ['low', 'medium', 'high'],
        price: { input: 1, output: 2 },
      },
    ],
    quota: {
      status: 'known',
      source: 'fixture',
      observedAt: new Date().toISOString(),
      windows: [
        { id: 'week', label: 'week', usedPercent: 10, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
      ],
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: new Date().toISOString(),
  }));
  t.mock.method(controller, 'refresh', async () => {});
  const workspace = new Workspace(controller, { autoTick: false });
  const bridge = new AgentBridge(workspace, controller);
  t.after(async () => {
    await workspace.close();
    await controller.close();
    const absolute = resolve(directory);
    assert.ok(
      absolute.startsWith(realpathSync.native(tmpdir()) + sep) &&
        basename(absolute).startsWith('pugport-pi-agent-test-'),
    );
    rmSync(absolute, { recursive: true, force: true });
  });
  return { directory, controller, workspace, bridge };
}
const request = (name: string, args = {}) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name, arguments: args },
});
const text = (reply: { body?: unknown }) =>
  (reply.body as { result: { content: { text: string }[] } }).result.content.map((part) => part.text).join('\n');
async function finish(workspace: Workspace, id: string) {
  for (let index = 0; index < 600; index++) {
    await workspace.tickQueue();
    const current = workspace.store.get<Workflow>('workflow', id)!;
    if (['completed', 'failed', 'blocked', 'cancelled'].includes(current.status)) return current;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('synthetic Pi workflow did not finish');
}

for (const childLabel of ['Codex B', 'API Pi B', 'API Pi A'])
  test(`API Pi delegates to ${childLabel} through host scope and records the whole task`, async (t) => {
    const f = fixture(t, childLabel !== 'Codex B');
    const project = await f.workspace.createProject(f.directory);
    const conversation = f.workspace.createConversation(project.id);
    const contexts: ExecuteContext[] = [];
    const execute = async (ctx: ExecuteContext) => {
      contexts.push(ctx);
      assert.ok(ctx.agentBridge, 'Both API parent and child must have their own run-scoped host bridge.');
      const authorization = `Bearer ${ctx.agentBridge.token}`;
      const listed = await f.bridge.handle(authorization, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const tools = (listed.body as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name);
      assert.ok(!tools.includes('organize_files') && !tools.includes('recycle_files'));
      if (ctx.target.id === 'pi-a' && !ctx.input.agentChild) {
        assert.ok(tools.includes('delegate'));
        assert.equal(ctx.route.model, 'openai/test-model');
        assert.equal(ctx.route.effort, 'high');
        assert.equal(f.controller.agentBridgeCaller(ctx.agentBridge.token)?.write, false);
        assert.match(
          text(await f.bridge.handle(authorization, request('organize_files', { action: 'move', operations: [] }))),
          /不能修改文件|只读|权限/,
        );
        const result = await f.bridge.handle(
          authorization,
          request('delegate', {
            agent: childLabel,
            task: 'Read only: locate a synthetic fixture and return its name.',
            wait_seconds: 30,
          }),
        );
        assert.match(text(result), /child fixture found/);
        ctx.emit({ at: new Date().toISOString(), type: 'usage', data: { source: 'fixture', costUsd: 0.01 } });
        return { output: 'Main final result with the returned fixture name.' };
      }
      assert.equal(ctx.input.permissionMode, 'read-only');
      assert.equal(ctx.nativeSessionId, undefined, 'A helper must use its own native session.');
      assert.equal(ctx.input.continuationRunId, undefined);
      assert.equal(ctx.input.resumeRunId, undefined);
      assert.notEqual(ctx.route.effort, 'high', 'Subtask effort must not inherit the main high pin.');
      assert.ok(tools.includes('message_parent') && tools.includes('report_progress'));
      assert.ok(tools.includes('delegate'), 'Ordinary children can delegate within their managed family limits.');
      assert.equal(f.controller.agentBridgeCaller(ctx.agentBridge.token)?.write, false);
      assert.notEqual(ctx.agentBridge.token, contexts[0]!.agentBridge!.token, 'A helper has its own bridge scope.');
      await f.bridge.handle(
        authorization,
        request('report_progress', { progress: 'Synthetic fixture found.', next: 'Return result.' }),
      );
      if (ctx.target.provider === 'pi')
        ctx.emit({ at: new Date().toISOString(), type: 'usage', data: { source: 'fixture', costUsd: 0.01 } });
      return { output: 'child fixture found' };
    };
    t.mock.method(piAdapter, 'execute', execute);
    t.mock.method(codexAdapter, 'execute', execute);
    const sent = await f.workspace.send(conversation.id, {
      content: 'Check a synthetic fixture with one read-only helper.',
      mode: 'chat',
      permissionMode: 'read-only',
      executionPolicy: 'cli-first',
      runtimeId: 'pi-a',
      provider: 'pi',
      model: 'openai/test-model',
      effort: 'high',
      autoEscalate: false,
    });
    const done = await finish(f.workspace, sent.workflow.id);
    assert.equal(done.status, 'completed', done.error ?? '');
    assert.equal(contexts.filter((ctx) => ctx.target.id === 'pi-a' && !ctx.input.agentChild).length, 1);
    assert.equal(contexts.filter((ctx) => ctx.target.label === childLabel && ctx.input.agentChild).length, 1);
    const records = f.workspace.executionRecord(done.id);
    assert.equal(records.runs.length, 1);
    assert.equal(records.relatedRuns.length, 1);
    assert.equal(records.relatedWorkflows.length, 1);
    const parent = records.runs[0]!;
    const child = records.relatedRuns[0]!;
    assert.equal(parent.output, 'Main final result with the returned fixture name.');
    assert.equal(child.output, 'child fixture found');
    assert.equal(records.relatedWorkflows[0]!.delegation?.checkpoints?.[0]?.progress, 'Synthetic fixture found.');
    assert.equal(records.relatedWorkflows[0]!.delegation?.parentId, done.id);
    assert.ok(
      parent.events.some(
        (event) => event.type === 'tool' && event.data?.tool === 'delegate' && event.data.status === 'completed',
      ),
    );
    assert.ok(
      parent.events.some(
        (event) =>
          event.data?.kind === 'routing' &&
          (event.data.detail as { toWorkflowId?: string })?.toWorkflowId === child.workflowId,
      ),
    );
    assert.equal(f.controller.agentBridgeCaller(contexts[0]!.agentBridge!.token), undefined);
  });

test('delegate naming an unpinned pay-per-use API card does not run it', async (t) => {
  const f = fixture(t);
  const paid = f.controller.targets.find((target) => target.id === 'pi-b')!;
  assert.equal(paid.gateway, 'api');
  assert.equal(paid.apiBudget?.expiresAt, undefined);
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const ran: string[] = [];
  const execute = async (ctx: ExecuteContext) => {
    ran.push(ctx.target.id);
    assert.equal(ctx.input.agentChild, undefined);
    const authorization = `Bearer ${ctx.agentBridge!.token}`;
    const result = await f.bridge.handle(
      authorization,
      request('delegate', {
        agent: 'API Pi B',
        task: 'Read only: locate a synthetic fixture and return its name.',
        wait_seconds: 30,
      }),
    );
    assert.match(text(result), /按次计费的 API 卡默认不参与自动选择/);
    return { output: 'Did not run the unpinned API card.' };
  };
  t.mock.method(piAdapter, 'execute', execute);
  t.mock.method(codexAdapter, 'execute', execute);
  const sent = await f.workspace.send(conversation.id, {
    content: 'Check a synthetic fixture with one read-only helper.',
    mode: 'chat',
    permissionMode: 'read-only',
    executionPolicy: 'cli-first',
    runtimeId: 'pi-a',
    provider: 'pi',
    model: 'openai/test-model',
    effort: 'high',
    autoEscalate: false,
  });
  assert.notEqual(
    sent.workflow.input.participants?.some((item) => item.kind === 'executor' && item.id === paid.id),
    true,
  );
  const done = await finish(f.workspace, sent.workflow.id);
  assert.equal(done.status, 'completed', done.error ?? '');
  assert.deepEqual(ran, ['pi-a']);
  const records = f.workspace.executionRecord(done.id);
  const child = records.relatedWorkflows.find((item) => item.delegation?.agent?.runtimeId === paid.id);
  assert.ok(child, 'the named card still gets a subtask record');
  assert.equal(child.status, 'blocked');
  assert.match(child.error ?? '', /按次计费的 API 卡默认不参与自动选择/);
  assert.equal(records.relatedRuns.length, 0);
});
