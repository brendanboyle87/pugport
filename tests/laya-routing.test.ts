import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import type { LayaChoices, LayaInference } from '../src/shared/laya.ts';
import type { ExecuteContext, MessageInput, Project, Workflow, WorkflowStep } from '../src/shared/types.ts';
import { resolveOneForAllInput } from '../src/server/one-for-all-policy.ts';
import { localTaskJudgment } from '../src/server/task-judgment.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { claudeAdapter } from '../src/server/adapters/claude.ts';
import { saveApiKey } from '../src/server/api-providers.ts';
import { fixture, finished, result } from './helpers/session-workspace.ts';

const choices: LayaChoices = {
  task_type: 'conversation',
  difficulty: 'complex',
  web_search: 'no',
  input_modality: 'text',
  document_read: 'no',
  media_output: 'none',
  project_access: 'none',
  run_commands: 'no',
  browser_use: 'no',
  executor_intent: 'none',
};
const prediction: LayaInference = {
  status: 'ok',
  reason: 'accepted',
  modelVersion: 'pugport-laya-v4',
  latencyMs: 750,
  choices,
};
const input: MessageInput = {
  content: '目标：理解 KV 缓存。要点：整理缓存减少重复计算的过程，比较内存占用和速度。',
  mode: 'auto',
  permissionMode: 'workspace-write',
  explicitWrite: true,
  executionPolicy: 'cli-first',
};

test('send has no model or usage call; mocked Laya changes the auto KV task into one reply before execution', async (t) => {
  const f = fixture(t);
  const previousSecrets = process.env.COMBORUNNER_SECRETS_DIR;
  process.env.COMBORUNNER_SECRETS_DIR = join(f.directory, 'synthetic-secrets');
  t.after(() => {
    if (previousSecrets === undefined) delete process.env.COMBORUNNER_SECRETS_DIR;
    else process.env.COMBORUNNER_SECRETS_DIR = previousSecrets;
  });
  await saveApiKey('api-synthetic-deepseek', 'synthetic-key-not-a-credential');
  f.controller.targets.push({
    ...f.controller.targets[0]!,
    id: 'api-synthetic-deepseek',
    provider: 'pi',
    gateway: 'api',
    apiProvider: 'deepseek',
    // Available to the old routing judge, but never an executor in this synthetic test.
    executionDisabledByUser: true,
  });
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected provider call');
  });
  const usage = t.mock.method(f.controller, 'recordApiExtraUsage', () => {});
  let release!: (value: LayaInference) => void;
  const waiting = new Promise<LayaInference>((resolve) => {
    release = resolve;
  });
  const predict = t.mock.method(f.controller.laya, 'predict', () => waiting);
  const calls: ExecuteContext[] = [];
  const execute = async (ctx: ExecuteContext) => {
    calls.push(ctx);
    return result('completed', 'Synthetic reply');
  };
  t.mock.method(codexAdapter, 'execute', execute);
  t.mock.method(claudeAdapter, 'execute', execute);
  const conversation = await f.workspace.createGeneralConversation();
  const sent = await f.workspace.send(conversation.id, input);
  assert.equal(calls.length, 0);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(usage.mock.callCount(), 0);
  release(structuredClone(prediction));
  const flow = await finished(f.workspace, sent.workflow.id);
  assert.equal(flow.status, 'completed', flow.error ?? '');
  assert.equal(flow.input.mode, 'chat');
  assert.equal(flow.input.permissionMode, 'workspace-write');
  assert.equal(flow.planning, undefined);
  assert.equal(flow.handlingSource, 'laya');
  assert.equal(predict.mock.callCount(), 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.input.checkFileChanges, false);
  assert.equal(calls[0]!.input.requiresFileChanges, false);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(usage.mock.callCount(), 0);
  // A resend is judged like the first send: it used to fall back to the rules, which made this a planned task.
  const resent = await f.workspace.resendMessage(conversation.id, flow.userMessageId);
  const again = await finished(f.workspace, resent.workflow.id);
  assert.equal(again.status, 'completed', again.error ?? '');
  assert.equal(again.handlingSource, 'laya');
  assert.equal(again.input.mode, 'chat');
  assert.equal(again.planning, undefined);
  assert.equal(predict.mock.callCount(), 2);
  assert.equal(calls.length, 2);
});

test('workflow reapplication preserves safety gates, fallback and explicit handling on both judgment paths', async (t) => {
  const f = fixture(t);
  // Exercise the queued workflow's execution boundary without starting a provider or planner.
  t.mock.method(f.workspace, 'tickQueue', async () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected provider call');
  });
  let inference = prediction;
  const predict = t.mock.method(f.controller.laya, 'predict', async () => structuredClone(inference));
  const boundary = f.workspace as unknown as {
    judgeTaskImpl(flow: Workflow, project: Project, signal: AbortSignal): Promise<void>;
    input(flow: Workflow, project: Project, prompt: string, step?: WorkflowStep): ExecuteContext['input'];
  };
  const rows: Array<{
    name: string;
    patch?: Partial<MessageInput>;
    choices?: Partial<LayaChoices>;
    fallback?: string;
    prior?: boolean;
    rulesOnly?: boolean;
    incognito?: boolean;
    notRecorded?: boolean;
    mode?: 'chat' | 'build';
    permission?: 'read-only' | 'workspace-write';
    source?: 'laya' | 'rules';
  }> = [
    { name: 'existing judgment still applies Laya before mode', prior: true, mode: 'chat' },
    { name: 'timeout', fallback: 'timeout', source: 'rules' },
    { name: 'warming', fallback: 'warming', source: 'rules' },
    { name: 'ambiguous', choices: { project_access: 'unclear' }, source: 'rules' },
    {
      name: 'inherited advice is cleared',
      patch: { routeDecision: { handling: 'reply', writes: false, plan: false, web: true } },
      fallback: 'timeout',
      mode: 'build',
      source: 'rules',
    },
    { name: 'automatic role', patch: { content: 'Implement a cache', agentPresetId: 'auto' }, mode: 'build' },
    {
      name: 'automatic role fallback',
      patch: { content: 'Implement a cache', agentPresetId: 'auto' },
      fallback: 'timeout',
      mode: 'build',
      source: 'rules',
    },
    { name: 'simple command task', choices: { run_commands: 'yes', difficulty: 'simple' }, mode: 'build' },
    {
      name: 'read-only chip',
      patch: { permissionMode: 'read-only', explicitWrite: false },
      choices: { project_access: 'write' },
      mode: 'build',
      permission: 'read-only',
    },
    {
      name: 'whole-message stop',
      patch: { content: '不要改任何文件' },
      choices: { project_access: 'write' },
      mode: 'chat',
      permission: 'read-only',
      source: 'rules',
    },
    {
      name: 'whole-clause scope note with write grant',
      patch: { content: '不要改任何文件，检查这个项目' },
      choices: { project_access: 'write' },
      mode: 'build',
      permission: 'workspace-write',
    },
    {
      name: 'sentence scope note with write grant',
      patch: { content: '不要改任何文件。检查这个项目' },
      choices: { project_access: 'write' },
      mode: 'build',
      permission: 'workspace-write',
    },
    { name: 'scope note', patch: { content: '整理说明，不要删除 archive 文件夹' }, mode: 'chat' },
    {
      name: 'explicit chat',
      patch: { mode: 'chat' },
      choices: { project_access: 'write' },
      mode: 'chat',
      source: 'rules',
    },
    { name: 'explicit build', patch: { mode: 'build' }, mode: 'build', source: 'rules' },
    { name: 'slash', patch: { content: '/build Explain caching' }, source: 'rules' },
    { name: 'plan first', patch: { planFirst: true }, mode: 'build', source: 'rules' },
    { name: 'continuation/steering', rulesOnly: true, source: 'rules' },
    { name: 'incognito', incognito: true, source: 'rules' },
    { name: 'not recorded cloud', notRecorded: true, source: 'rules' },
    { name: 'web reply', choices: { task_type: 'research', web_search: 'yes' }, mode: 'chat' },
    {
      name: 'no web',
      patch: { content: 'Explain caching. Do not search the web.' },
      choices: { task_type: 'research', web_search: 'yes' },
      mode: 'chat',
    },
    {
      name: 'permission ceiling',
      patch: { permissionMode: 'read-only', permissionOrigin: { source: 'caller', mode: 'read-only' } },
      choices: { project_access: 'write' },
      mode: 'build',
      permission: 'read-only',
    },
  ];
  for (const row of rows) {
    inference = {
      ...prediction,
      choices: { ...choices, ...row.choices },
      ...(row.fallback ? { status: 'fallback', reason: row.fallback } : {}),
    };
    const conversation = await f.workspace.createGeneralConversation(row.name, row.incognito);
    if (row.notRecorded) {
      f.controller.settings.laya = { mode: 'cloud' };
      f.workspace.store.save('conversation', conversation.id, conversation.projectId, {
        ...conversation,
        memory: 'off',
      });
    } else f.controller.settings.laya = { mode: 'rules' };
    const sent = await f.workspace.send(
      conversation.id,
      { ...input, ...row.patch },
      undefined,
      undefined,
      row.rulesOnly ? { continuation: { originalRequest: input.content, supplements: [] } } : {},
    );
    const flow = sent.workflow;
    const previousCalls = predict.mock.callCount();
    const expectedMode = row.mode ?? flow.input.mode;
    if (row.prior) flow.taskJudgment = localTaskJudgment(input.content, 'disabled');
    const project = f.workspace.store.get<Project>('project', flow.projectId)!;
    await boundary.judgeTaskImpl(flow, project, new AbortController().signal);
    assert.equal(flow.input.mode, expectedMode, row.name);
    assert.equal(flow.input.permissionMode, row.permission ?? 'workspace-write', row.name);
    assert.equal(flow.handlingSource, row.source ?? 'laya', row.name);
    if (row.incognito || row.notRecorded) assert.equal(predict.mock.callCount(), previousCalls, row.name);
    if (expectedMode === 'chat') assert.equal(flow.planning, undefined, row.name);
    if (row.name === 'scope note') assert.match(flow.input.scopeNote!, /archive/);
    const run = boundary.input(flow, project, flow.input.content);
    if (row.name === 'web reply') assert.equal(run.webDriven, true);
    if (row.name === 'no web') assert.equal(run.webDriven, undefined);
    if (row.name === 'permission ceiling') assert.equal(flow.input.permissionOrigin?.source, 'caller');
    if (row.name === 'simple command task') assert.equal(flow.planning?.strategy, 'direct');
    if (flow.input.routeDecision) {
      const step: WorkflowStep = {
        id: 'test',
        title: 'test',
        instruction: 'Modify synthetic.txt',
        kind: 'auto',
        transport: 'auto',
        dependsOn: [],
        status: 'pending',
        runIds: [],
      };
      const soft = boundary.input(flow, project, flow.input.content, step);
      assert.equal(soft.checkFileChanges, flow.input.routeDecision.writes, row.name);
      assert.equal(soft.requiresFileChanges, false, row.name);
      // A declared write is a hard requirement per step only when the step is the whole plan.
      const hard = boundary.input({ ...flow, plan: [{ ...step, writes: true }] }, project, flow.input.content, {
        ...step,
        writes: true,
      });
      assert.equal(hard.requiresFileChanges, true, row.name);
      const noWrites = boundary.input(flow, project, flow.input.content, { ...step, writes: false });
      assert.equal(noWrites.checkFileChanges, false, row.name);
    }
    if (row.incognito)
      f.workspace.store.save('conversation', conversation.id, conversation.projectId, {
        ...conversation,
        incognito: false,
      });
    f.workspace.cancel(flow.id);
  }
  assert.equal(resolveOneForAllInput(input).mode, 'build', 'the KV case must actually regress the old rule');
});
