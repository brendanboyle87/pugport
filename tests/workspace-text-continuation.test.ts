import assert from 'node:assert/strict';
import { replyLanguage } from '../src/server/workspace.ts';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { test, type TestContext } from 'node:test';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { resolveAgentPreset } from '../src/shared/agent-presets.ts';
import { canContinueWorkflow, workflowDisplayStatus } from '../src/ui/queue-utils.ts';
import type { ExecuteContext, MessageInput, RuntimeSnapshot, Workflow, WorkflowStep } from '../src/shared/types.ts';

const input: MessageInput = {
  content: 'Update the synthetic first report, then update the synthetic second report.',
  mode: 'build',
  permissionMode: 'workspace-write',
  executionPolicy: 'cli-only',
  runtimeId: 'mock',
  model: 'fixture-model',
  effort: 'high',
  autoEscalate: false,
};
function fixture(t: TestContext) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-text-continuation-')));
  const previousMemory = process.env.COMBORUNNER_MEMORY_DIR;
  process.env.COMBORUNNER_MEMORY_DIR = join(directory, 'memory');
  const controller = new Controller(directory, join(directory, 'data'));
  clearInterval(controller.timer);
  controller.settings.decisionMode = 'auto';
  controller.settings.taskJudgment = 'local';
  controller.targets = [
    { id: 'mock', provider: 'codex', label: 'Synthetic', command: 'unused', environment: 'native', enabled: true },
  ];
  const snapshot: RuntimeSnapshot = {
    ...controller.targets[0]!,
    installed: true,
    status: 'ready',
    accountFingerprint: 'fixture-account',
    models: [{ id: 'fixture-model', label: 'Fixture', efforts: ['low', 'medium', 'high'] }],
    quota: {
      status: 'known',
      source: 'fixture',
      observedAt: new Date().toISOString(),
      windows: [
        { id: 'week', label: 'Week', usedPercent: 10, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
      ],
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: new Date().toISOString(),
  };
  controller.snapshots = [snapshot];
  t.mock.method(controller, 'refresh', async () => {});
  t.mock.method(codexAdapter, 'discover', async () => snapshot);
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    if (ctx.input.permissionMode === 'workspace-write') {
      const path = join(directory, 'synthetic-report.txt');
      writeFileSync(path, 'Synthetic report');
      ctx.emit({
        at: new Date().toISOString(),
        type: 'tool',
        data: {
          kind: 'fileChange',
          itemId: `write-${calls.length}`,
          status: 'completed',
          input: { changes: [{ path, kind: { type: 'update' } }] },
        },
      });
    }
    return { output: 'Synthetic step completed.\nCOMBORUNNER_TASK_RESULT: {"status":"completed","summary":"Done"}' };
  });
  const workspace = new Workspace(controller, { autoTick: false, memoryDebounceMs: 100000 });
  t.after(async () => {
    await workspace.close();
    await controller.close();
    assert.ok(
      directory.startsWith(realpathSync.native(tmpdir()) + sep) &&
        basename(directory).startsWith('pugport-text-continuation-'),
    );
    rmSync(directory, { recursive: true, force: true });
    if (previousMemory === undefined) delete process.env.COMBORUNNER_MEMORY_DIR;
    else process.env.COMBORUNNER_MEMORY_DIR = previousMemory;
  });
  return { workspace, controller, calls, directory };
}
function step(id: string, status: WorkflowStep['status'], dependsOn: string[] = []): WorkflowStep {
  return {
    id,
    title: `Synthetic ${id}`,
    instruction: `Complete synthetic ${id} only.`,
    kind: 'routine',
    transport: 'auto',
    dependsOn,
    status,
    runIds: [],
    acceptance: `The synthetic ${id} is complete.`,
  };
}
async function stopped(
  f: ReturnType<typeof fixture>,
  plan = [step('first', 'failed'), step('second', 'pending', ['first'])],
) {
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const sent = await f.workspace.send(conversation.id, input);
  sent.workflow.status = 'blocked';
  sent.workflow.phase = 'execute';
  sent.workflow.error = 'Synthetic interruption';
  sent.workflow.plan = plan;
  f.workspace.store.save('workflow', sent.workflow.id, conversation.id, sent.workflow);
  return { conversation, original: sent.workflow };
}
async function finish(f: ReturnType<typeof fixture>, id: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await f.workspace.tickQueue();
    const saved = f.workspace.store.get<Workflow>('workflow', id)!;
    if (['completed', 'blocked', 'cancelled', 'failed'].includes(saved.status)) return saved;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw Error('Synthetic text continuation did not finish');
}

test('a writable chip and bare 继续 retain permission and pass scope constraints to the executor', async (t) => {
  const f = fixture(t);
  const { original, conversation } = await stopped(f, [step('single', 'failed')]);
  original.input.intentText = 'Update the synthetic report. Do not delete files.';
  original.input.scopeNote = 'Do not delete files';
  f.workspace.store.save('workflow', original.id, conversation.id, original);
  const next = await f.workspace.send(conversation.id, {
    ...input,
    mode: 'auto',
    content: '继续',
    explicitWrite: true,
  });
  assert.equal(next.workflow.input.permissionMode, 'workspace-write');
  assert.equal(next.workflow.input.explicitWrite, true);
  assert.ok(next.workflow.input.scopeNote?.includes('Do not delete files'));
  assert.equal((await finish(f, next.workflow.id)).status, 'completed');
  assert.ok(f.calls.every((call) => call.input.permissionMode === 'workspace-write'));
  assert.match(f.calls.at(-1)!.input.prompt, /范围限制（来自你的消息）：.*Do not delete files/);
});

test('UI language reaches executor prompts and explicit requests still override it', async (t) => {
  const f = fixture(t);
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  for (const [content, uiLocale, expected] of [
    ['Check the synthetic report.', 'zh-CN', '简体中文'],
    ['检查合成报告。', 'en', '英语'],
    ['Check the report. 用英文回答', 'zh-CN', '英语'],
    ['检查报告，answer in Chinese', 'en', '简体中文'],
  ] as const) {
    const sent = await f.workspace.send(conversation.id, { ...input, mode: 'chat', content, uiLocale });
    assert.equal((await finish(f, sent.workflow.id)).status, 'completed');
    assert.equal(sent.workflow.input.uiLocale, uiLocale);
    assert.ok(f.calls.at(-1)!.input.prompt.includes(`必须用${expected}写`));
    assert.ok(f.calls.at(-1)!.input.prompt.includes(replyLanguage(content, uiLocale)));
  }
});

test('a read-only failure stores a short notice and raw details, and explicit writable rerun retains the request', async (t) => {
  const f = fixture(t);
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const raw =
    'Read-only filesystem prevents implementation and test additions; test execution failed with spawn EPERM.';
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    f.calls.push(ctx);
    if (f.calls.length === 1) {
      ctx.emit({
        at: new Date().toISOString(),
        type: 'error',
        text: raw,
        data: { executionBlocked: true, reason: 'permission', detail: raw },
      });
      throw new Error('runtime-permission-or-sandbox-error');
    }
    return {
      nativeSessionId: 'readonly-session',
      output: `Stopped.\nCOMBORUNNER_TASK_RESULT: ${JSON.stringify({ status: 'blocked', summary: raw })}`,
    };
  });
  const sent = await f.workspace.send(conversation.id, {
    ...input,
    content: '不要改任何文件',
    mode: 'auto',
    explicitWrite: false,
    uiLocale: 'en',
  });
  const old = await finish(f, sent.workflow.id);
  assert.equal(old.status, 'blocked');
  assert.equal(old.input.readOnlyTrigger, '不要改任何文件');
  assert.equal(f.calls[0]!.input.permissionMode, 'read-only');
  const notice = f.workspace.store.allMessages(conversation.id).find((message) => message.id === old.finalMessageId)!;
  assert.match(notice.content, /只读|权限|失败/);
  assert.doesNotMatch(notice.content, /Read-only filesystem/);
  assert.ok(notice.systemNotice?.details?.includes(raw), JSON.stringify(notice.systemNotice));
  const continued = await f.workspace.rerunWrite(old.id, 'zh-CN');
  assert.equal(continued.message.content, '');
  assert.equal(continued.message.resumed, true);
  assert.equal(continued.message.systemNotice?.text, '已授权写入，正在重跑同一请求。');
  assert.equal(continued.workflow.input.permissionMode, 'workspace-write');
  assert.equal(continued.workflow.input.readOnlyTrigger, undefined);
  assert.equal(continued.workflow.parentWorkflowId, old.id);
  assert.ok(continued.workflow.input.content.includes('不要改任何文件'));
  assert.match(continued.workflow.input.content, /明确允许写入/);
  assert.match(continued.workflow.input.content, /其他范围限制仍有效/);
  assert.match(continued.workflow.input.content, /已完成及未确认的操作都不得直接重放/);
  await finish(f, continued.workflow.id);
  assert.equal(f.calls[1]!.input.permissionMode, 'workspace-write');
  assert.equal(f.calls[1]!.nativeSessionId, undefined, 'the read-only native session must not be reused with writes');
  assert.match(f.calls[1]!.input.prompt, /面向用户的解释、分析和提问必须用简体中文写/);
  assert.match(f.calls[1]!.input.prompt, /英文邮件或截图应给出英文草稿/);
  assert.equal(f.workspace.store.get<Workflow>('workflow', old.id)!.input.permissionMode, 'read-only');
});

test('writable rerun cannot cross tool-less, role or unconfirmed tool boundaries', async (t) => {
  const f = fixture(t);
  const { original } = await stopped(f);
  original.input.permissionMode = 'read-only';
  original.input.readOnlyTrigger = '不要改任何文件';
  original.input.untrustedContent = true;
  f.workspace.store.save('workflow', original.id, original.conversationId, original);
  await assert.rejects(f.workspace.rerunWrite(original.id), /安全边界/);
  delete original.input.untrustedContent;
  original.delegation = { parentId: 'parent', requestId: 'request', role: 'reviewer' };
  f.workspace.store.save('workflow', original.id, original.conversationId, original);
  await assert.rejects(f.workspace.rerunWrite(original.id), /安全边界/);
  delete original.delegation;
  original.runIds = ['uncertain'];
  f.controller.store.saveRun({
    id: 'uncertain',
    workflowId: original.id,
    projectPath: f.directory,
    prompt: 'Synthetic',
    kind: 'general',
    status: 'failed',
    startedAt: '',
    output: '',
    events: [],
    route: { runtimeId: 'mock', model: 'fixture-model', kind: 'general', reasons: [], warnings: [] },
    handoffCheckpoint: {
      version: 1,
      source: 'native-tool-results',
      observedAt: '',
      safe: false,
      completedToolIds: [],
      unconfirmedTools: [{ id: 'pending-write', status: 'running' }],
    },
  });
  f.workspace.store.save('workflow', original.id, original.conversationId, original);
  await assert.rejects(f.workspace.rerunWrite(original.id), /未确认/);
  assert.equal(f.calls.length, 0);
  original.runIds = [];
  original.delegation = { parentId: 'readonly-parent', requestId: 'worker-request', role: 'worker' };
  f.workspace.store.save('workflow', 'readonly-parent', original.conversationId, {
    ...original,
    id: 'readonly-parent',
    delegation: undefined,
  });
  f.workspace.store.save('workflow', original.id, original.conversationId, original);
  await assert.rejects(f.workspace.rerunWrite(original.id), /安全边界/);
  f.workspace.store.save('workflow', 'middle', original.conversationId, {
    ...original,
    id: 'middle',
    input: { ...original.input, permissionMode: 'workspace-write' },
    delegation: { parentId: 'readonly-parent', role: 'worker', requestId: 'middle' },
  });
  original.delegation = { parentId: 'middle', role: 'worker', requestId: 'nested' };
  f.workspace.store.save('workflow', original.id, original.conversationId, original);
  await assert.rejects(f.workspace.rerunWrite(original.id), /安全边界/);
  delete original.delegation;
  original.parentWorkflowId = 'uncertain-parent';
  f.workspace.store.save('workflow', 'uncertain-parent', original.conversationId, {
    ...original,
    id: 'uncertain-parent',
    parentWorkflowId: undefined,
    runIds: ['uncertain'],
  });
  f.workspace.store.save('workflow', original.id, original.conversationId, original);
  await assert.rejects(f.workspace.rerunWrite(original.id), /未确认/);
  assert.equal(f.calls.length, 0);
});

test('a writable rerun of a stored legacy chat restriction grants writes and keeps an explicit reply language', async (t) => {
  const f = fixture(t);
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const sent = await f.workspace.send(conversation.id, {
    ...input,
    mode: 'chat',
    uiLocale: 'zh-CN',
    content: 'Inspect the synthetic report. Do not edit any files. Reply in English.',
  });
  const old = await finish(f, sent.workflow.id);
  // Stored pre-B1 data keeps its readOnlyTrigger and remains eligible for the existing rerun action.
  old.input.readOnlyTrigger = 'Do not edit any files';
  old.input.scopeNote = undefined;
  f.workspace.store.save('workflow', old.id, conversation.id, old);
  const next = await f.workspace.rerunWrite(old.id, 'zh-CN');
  assert.equal(next.message.content, '');
  assert.equal(next.message.resumed, true);
  assert.equal(next.workflow.input.mode, 'build');
  assert.equal(next.workflow.input.permissionMode, 'workspace-write');
  assert.equal((await finish(f, next.workflow.id)).status, 'completed');
  assert.equal(f.calls[1]!.input.permissionMode, 'workspace-write');
  assert.match(f.calls[1]!.input.prompt, /必须用英语写/);
  const changed = await f.workspace.continue(next.workflow.id, '用中文回复');
  await finish(f, changed.workflow.id);
  assert.match(f.calls.at(-1)!.input.prompt, /必须用简体中文写/);
});

test('a bare continuation message keeps the zero-completed two-step plan and exact user message', async (t) => {
  const f = fixture(t);
  const { conversation, original } = await stopped(f);
  const clientMessageId = randomUUID();
  const continued = await f.workspace.send(conversation.id, { ...input, content: '  继续  ', clientMessageId });
  assert.equal(continued.workflow.parentWorkflowId, original.id);
  assert.equal(continued.workflow.planning?.strategy, 'resume');
  assert.deepEqual(
    continued.workflow.plan.map((item) => [item.id, item.status, item.dependsOn]),
    [
      ['first', 'pending', []],
      ['second', 'pending', ['first']],
    ],
  );
  assert.equal(continued.message.content, '继续');
  assert.equal(continued.message.resumed, true);
  assert.equal(continued.message.clientMessageId, clientMessageId);
  assert.ok(continued.workflow.input.content.includes(input.content));
  assert.equal(continued.workflow.input.effort, 'high');
  const done = await finish(f, continued.workflow.id);
  assert.equal(done.status, 'completed', done.error ?? 'Synthetic continuation must complete.');
  assert.equal(f.calls.length, 2, 'only the retained steps execute; no planner call');
  assert.deepEqual(
    f.calls.map((ctx) => ctx.input.stepId),
    ['first', 'second'],
  );
  assert.ok(f.calls.every((ctx) => ctx.input.prompt.includes(input.content)));
  assert.equal(f.workspace.store.get<Workflow>('workflow', original.id)?.followUp?.kind, 'continue');
  assert.equal(f.workspace.store.get<Workflow>('workflow', original.id)?.supersededAt, continued.workflow.createdAt);
});

test('the existing Continue button also retains a single unfinished step', async (t) => {
  const f = fixture(t);
  const { original } = await stopped(f, [step('single', 'failed')]);
  const continued = await f.workspace.continue(original.id);
  assert.equal(continued.workflow.planning?.strategy, 'resume');
  assert.equal(f.workspace.store.get<Workflow>('workflow', original.id)?.supersededAt, continued.workflow.createdAt);
  assert.deepEqual(
    continued.workflow.plan.map((item) => item.id),
    ['single'],
  );
  assert.equal((await finish(f, continued.workflow.id)).status, 'completed');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.input.stepId, 'single');
});

test('Continue retains an explicit write grant and plan for both scoped and general bans', async (t) => {
  for (const global of [false, true]) {
    await t.test(global ? 'global' : 'scoped', async (t) => {
      const f = fixture(t);
      const { original } = await stopped(f, [step('single', 'failed')]);
      const content = global
        ? '继续修复登录页，但先别改任何文件，给我方案。'
        : '继续修复登录页，但别动 config 文件。Do not edit en.json. Do not commit or build.';
      const continued = await f.workspace.continue(original.id, content);
      assert.equal(continued.workflow.input.permissionMode, 'workspace-write');
      assert.ok(continued.workflow.input.scopeNote);
      {
        assert.equal(continued.workflow.planning?.strategy, 'resume');
        assert.deepEqual(
          continued.workflow.plan.map((item) => item.id),
          ['single'],
        );
      }
      assert.equal((await finish(f, continued.workflow.id)).status, 'completed');
      assert.ok(f.calls.length > 0);
      assert.ok(f.calls.every((ctx) => ctx.input.permissionMode === 'workspace-write'));
    });
  }
});

test('text continuation skips completed steps and keeps their completed result context', async (t) => {
  const f = fixture(t);
  const { conversation, original } = await stopped(f, [
    step('first', 'completed'),
    step('second', 'failed', ['first']),
  ]);
  const continued = await f.workspace.send(conversation.id, { ...input, content: '请继续！' });
  assert.equal(continued.workflow.parentWorkflowId, original.id);
  assert.deepEqual(
    continued.workflow.plan.map((item) => [item.id, item.dependsOn]),
    [['second', []]],
  );
  assert.equal((await finish(f, continued.workflow.id)).status, 'completed');
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0]!.input.prompt, /Synthetic first（已在中断前完成）/);
});

test('repeated text requests with the same client identity reuse one continuation', async (t) => {
  const f = fixture(t);
  const { conversation, original } = await stopped(f);
  const command = { ...input, content: '继续', clientMessageId: randomUUID() };
  const results = await Promise.all(Array.from({ length: 8 }, () => f.workspace.send(conversation.id, command)));
  assert.ok(results.every((result) => result.workflow.id === results[0]!.workflow.id));
  assert.equal(f.workspace.store.childWorkflows(original.id).length, 1);
  assert.equal(f.workspace.store.allMessages(conversation.id).filter((message) => message.role === 'user').length, 2);
  assert.equal((await finish(f, results[0]!.workflow.id)).status, 'completed');
  assert.equal((await f.workspace.send(conversation.id, command)).workflow.id, results[0]!.workflow.id);
  assert.equal(f.calls.length, 2);
});

test('ordinary follow-up messages do not impersonate a true continuation or lock its original plan', async (t) => {
  const f = fixture(t);
  const { conversation, original } = await stopped(f);
  const later = await f.workspace.send(conversation.id, { ...input, mode: 'chat', content: '核对一下现在进展。' });
  assert.equal(later.workflow.parentWorkflowId, undefined);
  assert.equal(f.workspace.store.get<Workflow>('workflow', original.id)?.followUp?.kind, 'message');
  const [continued, repeated] = await Promise.all([
    f.workspace.continue(original.id),
    f.workspace.continue(original.id),
  ]);
  assert.notEqual(continued.workflow.id, later.workflow.id);
  assert.equal(continued.workflow.parentWorkflowId, original.id);
  assert.equal(repeated.workflow.id, continued.workflow.id);
  assert.equal(continued.workflow.planning?.strategy, 'resume');
  assert.equal(f.workspace.store.get<Workflow>('workflow', original.id)?.followUp?.workflowId, continued.workflow.id);
});

test('a bare continue resumes unfinished work across a completed progress question', async (t) => {
  const f = fixture(t);
  const { conversation, original } = await stopped(f);
  const latest = await f.workspace.send(conversation.id, { ...input, mode: 'chat', content: '现在进展如何？' });
  assert.equal((await finish(f, latest.workflow.id)).status, 'completed');
  const next = await f.workspace.send(conversation.id, { ...input, content: '继续' });
  assert.equal(next.workflow.parentWorkflowId, original.id);
  assert.equal(f.workspace.store.childWorkflows(original.id).length, 1);
});

test('continuation chooses the latest main user task rather than timestamp updates or delegated work', async (t) => {
  const f = fixture(t);
  const { conversation, original } = await stopped(f);
  const latest = await f.workspace.send(conversation.id, { ...input, content: 'Update the new synthetic report.' });
  latest.workflow.status = 'failed';
  latest.workflow.plan = [step('latest', 'failed')];
  f.workspace.store.save('workflow', latest.workflow.id, conversation.id, latest.workflow);
  original.updatedAt = '2099-01-01T00:00:00.000Z';
  f.workspace.store.save('workflow', original.id, conversation.id, original);
  const child = await f.workspace.send(
    conversation.id,
    { ...input, mode: 'chat', content: 'Synthetic delegated review.' },
    undefined,
    {
      parentId: latest.workflow.id,
      role: 'scout',
      requestId: randomUUID(),
    },
  );
  child.workflow.status = 'blocked';
  f.workspace.store.save('workflow', child.workflow.id, conversation.id, child.workflow);
  assert.equal(f.workspace.store.get<Workflow>('workflow', latest.workflow.id)?.supersededAt, undefined);
  const next = await f.workspace.send(conversation.id, { ...input, content: 'continue' });
  assert.equal(next.workflow.parentWorkflowId, latest.workflow.id);
  assert.equal(f.workspace.store.get<Workflow>('workflow', latest.workflow.id)?.supersededAt, next.workflow.createdAt);
  assert.equal(f.workspace.store.get<Workflow>('workflow', child.workflow.id)?.supersededAt, undefined);
  assert.deepEqual(
    next.workflow.plan.map((item) => item.id),
    ['latest'],
  );
});

test('a queued later task keeps Continue in the ordinary queue path', async (t) => {
  const f = fixture(t);
  const { conversation, original } = await stopped(f);
  await f.workspace.send(conversation.id, { ...input, content: 'A queued independent synthetic task.' });
  const next = await f.workspace.send(conversation.id, { ...input, content: '继续' });
  assert.equal(next.workflow.parentWorkflowId, undefined);
  assert.equal(f.workspace.store.childWorkflows(original.id).length, 0);
});

test('an expanded continuation request is a new message, never a bare resume command', async (t) => {
  for (const content of [
    '继续写另一个故事',
    '请继续，并删除其他文件。',
    '继续吗？',
    'continue with a different task',
  ]) {
    await t.test(content, async (t) => {
      const f = fixture(t);
      const { conversation, original } = await stopped(f);
      const next = await f.workspace.send(conversation.id, { ...input, content });
      assert.equal(next.workflow.parentWorkflowId, undefined);
      assert.equal(f.workspace.store.childWorkflows(original.id).length, 0);
    });
  }
});

test('the current composer grant resumes text-narrowed tasks without a chip toggle', async (t) => {
  for (const content of ['继续', '我同意', 'go on']) {
    for (const boundary of ['writable', 'readonly-chip', 'named-role', 'new-named-role', 'untrusted', 'auto-role']) {
      await t.test(`${content}: ${boundary}`, async (t) => {
        const f = fixture(t);
        f.controller.snapshots[0]!.capabilities.toolless = true;
        const { conversation, original } = await stopped(f, [step('single', 'failed')]);
        original.input.permissionMode = 'read-only';
        original.input.explicitWrite = false;
        original.input.readOnlyTrigger = '只看' + '不改';
        original.input.permissionOrigin = { mode: 'read-only', source: 'text', note: original.input.readOnlyTrigger };
        if (boundary === 'named-role' || boundary === 'auto-role') {
          original.input.agentPresetId = boundary === 'named-role' ? 'code-review' : 'auto';
          original.agentPreset = resolveAgentPreset('code-review', 'Review synthetic code');
        }
        if (boundary === 'untrusted') original.input.untrustedContent = true;
        f.workspace.store.save('workflow', original.id, conversation.id, original);
        const next = await f.workspace.send(conversation.id, {
          ...input,
          content,
          mode: 'auto',
          explicitWrite: boundary !== 'readonly-chip',
          permissionReauthorized: false,
          permissionMode: boundary === 'readonly-chip' ? 'read-only' : 'workspace-write',
          ...(boundary === 'new-named-role' ? { agentPresetId: 'code-review' } : {}),
        });
        const expected = ['writable', 'auto-role'].includes(boundary) ? 'workspace-write' : 'read-only';
        assert.equal(next.workflow.parentWorkflowId, original.id);
        assert.equal(next.workflow.input.permissionMode, expected);
        assert.ok(next.workflow.input.content.includes(input.content));
        if (boundary === 'auto-role') assert.equal(next.workflow.agentPreset?.permissionMode, 'workspace-write');
        await finish(f, next.workflow.id);
        assert.equal(f.calls.at(-1)!.input.permissionMode, expected);
        assert.equal(f.workspace.store.get<Workflow>('workflow', original.id)!.input.permissionMode, 'read-only');
      });
    }
  }
});

test('an automatic continuation without a new grant cannot increase its old ceiling', async (t) => {
  for (const previousPermission of ['read-only', 'workspace-write'] as const) {
    for (const currentPermission of ['read-only', 'workspace-write'] as const) {
      await t.test(`${previousPermission} to ${currentPermission}`, async (t) => {
        const f = fixture(t);
        const { conversation, original } = await stopped(f);
        original.input.permissionMode = previousPermission;
        original.input.verificationCommand = 'do-not-run';
        // A stale original permission is not permission to undo a later revocation.
        original.originalIntent = { mode: 'build', permissionMode: 'workspace-write' };
        f.workspace.store.save('workflow', original.id, conversation.id, original);
        const next = await f.workspace.send(conversation.id, {
          ...input,
          content: '继续',
          mode: 'auto',
          explicitWrite: false,
          permissionMode: currentPermission,
        });
        assert.equal(next.workflow.parentWorkflowId, original.id);
        assert.equal(
          next.workflow.input.permissionMode,
          previousPermission === 'read-only' || currentPermission === 'read-only' ? 'read-only' : 'workspace-write',
        );
        if (next.workflow.input.permissionMode === 'read-only')
          assert.equal(next.workflow.input.verificationCommand, undefined);
      });
    }
  }
});

test('a stopped running task can be text-resumed but a cancelled unstarted task cannot', async (t) => {
  for (const stoppedAfterStart of [true, false]) {
    await t.test(stoppedAfterStart ? 'user stopped execution' : 'user cancelled queue', async (t) => {
      const f = fixture(t);
      const { conversation, original } = await stopped(f);
      original.status = 'cancelled';
      original.stopped = stoppedAfterStart;
      f.workspace.store.save('workflow', original.id, conversation.id, original);
      const next = await f.workspace.send(conversation.id, { ...input, content: '继续吧' });
      assert.equal(next.workflow.parentWorkflowId, stoppedAfterStart ? original.id : undefined);
    });
  }
});

test('composer file heuristics without receipts complete with a soft note; analysis still completes', async (t) => {
  for (const content of [
    'Move the synthetic files into folders.',
    'Analyze the synthetic files.',
    'Modify synthetic-report.txt.',
  ]) {
    await t.test(content, async (t) => {
      const f = fixture(t);
      t.mock.method(codexAdapter, 'execute', async () => ({
        output: content.startsWith('Modify')
          ? 'Done.\nCOMBORUNNER_TASK_RESULT: {"status":"completed","summary":"Everything done"}'
          : 'Synthetic answer without completion report.',
      }));
      const project = await f.workspace.createProject(f.directory);
      const conversation = f.workspace.createConversation(project.id);
      const sent = await f.workspace.send(conversation.id, { ...input, content });
      const done = await finish(f, sent.workflow.id);
      const fileTask = !content.startsWith('Analyze');
      assert.equal(done.status, 'completed', done.error ?? 'Expected completion');
      const message = f.workspace.store.get<{ content: string; systemNotice?: { text: string } }>(
        'message',
        done.finalMessageId!,
      )!;
      assert.ok(message.content);
      assert.equal(!!message.systemNotice, fileTask);
    });
  }
});

test('three continuations keep one original request, scope corrections and the explicit grant', async (t) => {
  const f = fixture(t);
  const { original } = await stopped(f, [step('single', 'failed')]);
  let current = original;
  for (const update of ['只处理第一组，别碰 config。', '先不要改文件，只给我方案。', '改为检查第二组。']) {
    const next = await f.workspace.continue(current.id, update);
    assert.equal(next.workflow.continuation?.originalRequest, input.content);
    assert.equal(next.workflow.input.content.split(input.content).length - 1, 1);
    assert.equal(next.workflow.input.content.split('保留的原始需求：').length - 1, 1);
    current = next.workflow;
    current.status = 'blocked';
    f.workspace.store.save('workflow', current.id, current.conversationId, current);
  }
  assert.equal(current.input.permissionMode, 'workspace-write');
  assert.match(current.input.scopeNote!, /先不要改文件/);
  assert.deepEqual(current.continuation?.supplements, [
    '只处理第一组，别碰 config。',
    '先不要改文件，只给我方案。',
    '改为检查第二组。',
  ]);
});

test('an inspection-only legacy plan completes an original heuristic file request with a soft note', async (t) => {
  const f = fixture(t);
  t.mock.method(codexAdapter, 'execute', async () => ({
    output: 'Inspection done.\nCOMBORUNNER_TASK_RESULT: {"status":"completed","summary":"Inspection done"}',
  }));
  const inspection = step('inspection', 'failed');
  inspection.instruction = 'Analyze the synthetic files and report findings.';
  const { original } = await stopped(f, [inspection]);
  const next = await f.workspace.continue(original.id);
  const done = await finish(f, next.workflow.id);
  assert.equal(done.status, 'completed');
  const message = f.workspace.store.get<{ systemNotice?: { text: string } }>('message', done.finalMessageId!)!;
  assert.match(message.systemNotice!.text, /没有检测到文件改动/);
});

test('common short continuation phrases resume the latest unfinished task', async (t) => {
  for (const content of ['继续啊', '继续吧', '接着做', '接着来', '继续做完', 'go on', 'keep going']) {
    await t.test(content, async (t) => {
      const f = fixture(t);
      const { conversation, original } = await stopped(f, [step('single', 'failed')]);
      const next = await f.workspace.send(conversation.id, { ...input, content });
      assert.equal(next.workflow.parentWorkflowId, original.id);
    });
  }
});

test('an old nested record resumes with its innermost original request and all supplements', async (t) => {
  const f = fixture(t);
  const { original } = await stopped(f, [step('single', 'failed')]);
  delete original.continuation;
  original.input.content = `继续同一任务。保留的原始需求：\n继续原任务：继续原任务：${input.content}\n已有步骤状态：\nsingle: failed\n先检查已有产物，接着完成未完成的工作，避免重复外部操作。\n已有步骤状态：\nsingle: failed\n先检查已有产物，接着完成未完成的工作，避免重复外部操作。\n\n当前补充（收窄范围、撤销操作或只读要求优先于原始需求；不得恢复已撤销的授权）：\n别碰 config。\n\n已有步骤状态：\nsingle: failed\n先核对已有产物。`;
  f.workspace.store.save('workflow', original.id, original.conversationId, original);
  const next = await f.workspace.continue(original.id, '检查第二组。');
  assert.equal(next.workflow.continuation?.originalRequest, input.content);
  assert.deepEqual(next.workflow.continuation?.supplements, ['别碰 config。', '检查第二组。']);
  assert.equal((await finish(f, next.workflow.id)).status, 'completed');
});

test('new explicit authorization starts a writable session; an empty continue never restores revoked permission', async (t) => {
  for (const grant of ['none', 'composer', 'endpoint'] as const) {
    await t.test(grant, async (t) => {
      const f = fixture(t);
      const project = await f.workspace.createProject(f.directory);
      const conversation = f.workspace.createConversation(project.id);
      let calls = 0;
      const contexts: ExecuteContext[] = [];
      t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
        contexts.push(ctx);
        calls++;
        if (calls === 1)
          return {
            nativeSessionId: 'read-only-session',
            output: 'Stopped.\nCOMBORUNNER_TASK_RESULT: {"status":"blocked","summary":"Await authorization"}',
          };
        if (ctx.input.permissionMode === 'workspace-write') {
          const path = join(f.directory, 'synthetic-report.txt');
          writeFileSync(path, 'synthetic');
          ctx.emit({
            at: '',
            type: 'tool',
            data: {
              kind: 'fileChange',
              itemId: 'write',
              status: 'completed',
              input: { changes: [{ path, kind: { type: 'add' } }] },
            },
          });
        }
        return { output: 'Checked.\nCOMBORUNNER_TASK_RESULT: {"status":"completed","summary":"Checked"}' };
      });
      const sent = await f.workspace.send(conversation.id, {
        ...input,
        content: 'Update the synthetic report file.',
        permissionMode: 'read-only',
      });
      await finish(f, sent.workflow.id);
      const next =
        grant === 'composer'
          ? await f.workspace.send(conversation.id, { ...input, content: '继续啊', permissionReauthorized: true })
          : await f.workspace.continue(
              sent.workflow.id,
              undefined,
              grant === 'endpoint' ? { permissionMode: 'workspace-write' } : {},
            );
      await finish(f, next.workflow.id);
      assert.equal(contexts[1]!.input.permissionMode, grant === 'none' ? 'read-only' : 'workspace-write');
      assert.equal(contexts[1]!.nativeSessionId, grant === 'none' ? 'read-only-session' : undefined);
    });
  }
});

test('reauthorization preserves successful and unconfirmed host receipts from the previous permission scope', async (t) => {
  const f = fixture(t);
  const { original } = await stopped(f, [step('single', 'failed')]);
  const saved = {
    id: 'previous-file-run',
    workflowId: original.id,
    stepId: 'single',
    projectPath: f.directory,
    prompt: 'Synthetic organize',
    kind: 'routine' as const,
    status: 'failed' as const,
    startedAt: '',
    route: { runtimeId: 'mock', model: 'fixture-model', kind: 'routine' as const, reasons: [], warnings: [] },
    output: 'Partial',
    permissionMode: 'workspace-write' as const,
    events: [
      {
        at: '',
        type: 'tool' as const,
        data: {
          hostAudit: true,
          source: 'pugport',
          kind: 'pugportToolCall',
          tool: 'organize_files',
          toolCallId: 'previous-batch',
          status: 'partial',
          result: {
            structuredContent: {
              status: 'partial',
              operationIds: ['saved-operation'],
              requested: 2,
              succeeded: 1,
              failed: 1,
              skipped: 0,
              moves: [{ from: 'synthetic-source', to: 'synthetic-target' }],
              recycled: [],
            },
          },
        },
      },
    ],
  };
  f.controller.store.saveRun(saved);
  original.input.permissionMode = 'read-only';
  original.runIds = [saved.id];
  f.workspace.store.save('workflow', original.id, original.conversationId, original);
  const next = await f.workspace.continue(original.id, undefined, { permissionMode: 'workspace-write' });
  assert.equal(next.workflow.input.permissionMode, 'workspace-write');
  assert.match(next.workflow.input.content, /saved-operation/);
  assert.match(next.workflow.input.content, /synthetic-target/);
  assert.match(next.workflow.input.content, /已完成和未确认的操作不得直接重放/);
});

for (const supplement of ['', '  再查一下 Mooncake  ']) {
  test(`Continue stores only typed words and keeps executor context: ${supplement || 'empty'}`, async (t) => {
    const f = fixture(t);
    const { original } = await stopped(f, [step('single', 'failed')]);
    const next = await f.workspace.continue(original.id, supplement);
    const saved = f.workspace.store.allMessages(original.conversationId).find((m) => m.id === next.message.id)!;
    assert.equal(saved.resumed, true);
    assert.equal(saved.content, supplement.trim());
    assert.match(next.workflow.input.content, /^继续同一任务。保留的原始需求：/);
    assert.ok(next.workflow.input.content.includes(input.content));
    assert.match(next.workflow.input.content, /已有步骤状态：/);
    await finish(f, next.workflow.id);
    assert.match(f.calls[0]!.input.prompt, /已有步骤状态：/);
    if (supplement) assert.ok(f.calls[0]!.input.prompt.includes(supplement.trim()));
  });
}

test('automatic continuation keeps host supplements in executor input only', async (t) => {
  const f = fixture(t);
  const { original } = await stopped(f, [step('single', 'failed')]);
  const next = await f.workspace.continue(original.id, 'Synthetic host review instructions', {}, { automatic: true });
  assert.equal(next.message.content, '');
  assert.equal(next.message.resumed, true);
  assert.match(next.workflow.input.content, /Synthetic host review instructions/);
});

test('resending a resumed supplement retains executor context and the original user bubble', async (t) => {
  const f = fixture(t);
  const { original } = await stopped(f, [step('single', 'failed')]);
  const continued = await f.workspace.continue(original.id, '再查一下 Mooncake');
  await finish(f, continued.workflow.id);
  const retried = await f.workspace.resendMessage(original.conversationId, continued.message.id);
  assert.equal(retried.message.id, continued.message.id);
  assert.equal(retried.message.content, '再查一下 Mooncake');
  assert.equal(retried.message.resumed, true);
  assert.equal(retried.workflow.input.content, continued.workflow.input.content);
});

test('continuation quotes cannot replace the typed supplement with host scaffolding', async (t) => {
  const f = fixture(t);
  const { original } = await stopped(f, [step('single', 'failed')]);
  const next = await f.workspace.continue(original.id, '  再查一下 Mooncake  ', {
    quotes: [{ text: 'Synthetic reference' }],
  });
  const saved = f.workspace.store.allMessages(original.conversationId).find((m) => m.id === next.message.id)!;
  assert.equal(saved.content, '再查一下 Mooncake');
  assert.equal(saved.resumed, true);
  assert.equal(saved.quotes?.[0]?.text, 'Synthetic reference');
  await finish(f, next.workflow.id);
  const retry = await f.workspace.resendMessage(original.conversationId, next.message.id);
  assert.equal(retry.workflow.input.content, next.workflow.input.content, 'resend must not append quotes twice');
  assert.match(next.workflow.input.content, /已有步骤状态/);
});

test('new main work supersedes stopped predecessors but delegated work and other conversations stay untouched', async (t) => {
  const f = fixture(t);
  const { conversation, original } = await stopped(f);
  const child = {
    ...original,
    id: 'stopped-child',
    delegation: { parentId: original.id, role: 'scout' as const, requestId: 'r' },
  };
  const other = { ...original, id: 'other', conversationId: 'other-conversation' };
  const waiting = {
    ...original,
    id: 'background-wait',
    waitingOn: { kind: 'media-analysis' as const, jobId: 'job', done: 0, total: 1 },
  };
  for (const item of [child, other, waiting]) f.workspace.store.save('workflow', item.id, item.conversationId, item);
  const next = await f.workspace.send(conversation.id, {
    ...input,
    mode: 'chat',
    content: 'Start an unrelated synthetic task.',
  });
  const saved = f.workspace.store.get<Workflow>('workflow', original.id)!;
  assert.equal(saved.supersededAt, next.workflow.createdAt);
  assert.equal(saved.updatedAt, original.updatedAt);
  assert.equal(saved.status, original.status);
  assert.equal(canContinueWorkflow(saved), true);
  for (const item of [child, other, waiting])
    assert.equal(f.workspace.store.get<Workflow>('workflow', item.id)?.supersededAt, undefined);
  assert.equal(f.workspace.store.get<Workflow>('workflow', next.workflow.id)?.supersededAt, undefined);
});
