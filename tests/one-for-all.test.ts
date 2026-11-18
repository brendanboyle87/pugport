import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { desktopPermissionChange } from '../src/server/permission-change.ts';
import { Workspace } from '../src/server/workspace.ts';
import {
  applyTaskJudgment,
  inspectActionIntent,
  resolveOneForAllInput,
  globalReadOnlyTrigger,
} from '../src/server/one-for-all-policy.ts';
import { requestsFileChanges } from '../src/server/task-file-outcome.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { claudeAdapter } from '../src/server/adapters/claude.ts';
import { piAdapter } from '../src/server/adapters/pi.ts';
import { RouteUnavailableError } from '../src/server/routing.ts';
import type {
  ExecuteContext,
  MessageInput,
  Project,
  RuntimeSnapshot,
  RuntimeTarget,
  Workflow,
} from '../src/shared/types.ts';

const input: MessageInput = {
  content: '解释这个概念',
  mode: 'auto',
  permissionMode: 'workspace-write',
  executionPolicy: 'cli-first',
  autoEscalate: true,
};
function fixture(t: TestContext, mode: 'auto' | 'confirm' = 'auto') {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'one-for-all-test-')));
  const controller = new Controller(directory, join(directory, 'data'));
  clearInterval(controller.timer);
  controller.settings.decisionMode = mode;
  controller.settings.architectureProvider = 'codex';
  controller.targets = (['codex', 'claude'] as const).map((provider) => ({
    id: provider,
    provider,
    label: provider,
    command: 'unused',
    environment: 'native',
    enabled: true,
  }));
  const snapshot = (target: RuntimeTarget): RuntimeSnapshot => ({
    ...target,
    installed: true,
    status: 'ready',
    models: [{ id: 'test-model', label: 'Test model', efforts: ['low', 'medium', 'high'] }],
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
  });
  controller.snapshots = controller.targets.map(snapshot);
  t.mock.method(controller, 'refresh', async () => {});
  const calls: ExecuteContext[] = [];
  const execute = async (ctx: ExecuteContext) => {
    calls.push(ctx);
    if (ctx.input.requiresFileChanges) {
      const path = join(ctx.input.projectPath, 'synthetic-result.txt');
      writeFileSync(path, 'Synthetic implementation');
      ctx.emit({
        at: new Date().toISOString(),
        type: 'tool',
        data: {
          kind: 'fileChange',
          itemId: `fixture-write-${calls.length}`,
          status: 'completed',
          input: { changes: [{ path, kind: { type: 'add' } }] },
        },
      });
    }
    return { output: 'fixture response', nativeSessionId: 'fixture-session' };
  };
  t.mock.method(codexAdapter, 'execute', execute);
  t.mock.method(claudeAdapter, 'execute', execute);
  t.mock.method(piAdapter, 'execute', execute);
  const workspace = new Workspace(controller, { autoTick: false });
  t.after(async () => {
    await workspace.close();
    await controller.close();
    const absolute = resolve(directory);
    assert.ok(
      absolute.startsWith(realpathSync.native(tmpdir()) + sep) && basename(absolute).startsWith('one-for-all-test-'),
    );
    rmSync(absolute, { recursive: true, force: true });
  });
  return { workspace, controller, directory, calls };
}
async function finish(workspace: Workspace, id: string) {
  for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
    await workspace.tickQueue();
    const workflow = workspace.store.get<Workflow>('workflow', id)!;
    if (['completed', 'blocked', 'cancelled', 'failed'].includes(workflow.status)) return workflow;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  const pending = workspace.store.get<Workflow>('workflow', id)!;
  throw new Error(`fixture workflow did not finish: ${pending.status}/${pending.phase}; ${pending.error ?? ''}`);
}
function confirm(workspace: Workspace, id: string) {
  return workspace.confirm(id, workspace.store.get<Workflow>('workflow', id)!.routingReview?.id ?? 'missing-proposal');
}

test('automatic intent distinguishes instructions from questions and retains explicit read-only permission', () => {
  for (const content of [
    '帮我创建一个网页',
    '请修复这个按钮',
    '把标题改成你好',
    'Write a README.md',
    'Could you fix the typo in README.md?',
    '整理文档',
    '那你处理啊！',
    '那就执行吧',
    '帮我移动报告到归档目录',
    '把文件搬走',
    'Move the report into the archive folder.',
    'Please rename the report.',
  ]) {
    const result = resolveOneForAllInput({ ...input, content });
    assert.equal(result.mode, 'build', content);
    assert.equal(result.permissionMode, 'workspace-write');
  }
  for (const content of [
    '怎么创建一个网页？',
    '解释如何修改配置',
    '修改这个字段有什么影响？',
    '删除文件会怎样',
    '只讨论方案，不要修改文件',
    'How do I update the database?',
    'Do not edit anything.',
    '先不处理，只看看',
    '怎么处理文件？',
    '处理器性能怎么样？',
  ]) {
    const result = resolveOneForAllInput({ ...input, content, verificationCommand: 'unsafe-if-run' });
    assert.equal(result.mode, 'chat', content);
    // Only a message that forbids changes narrows the permission the user chose.
    assert.equal(result.permissionMode, 'workspace-write', content);
    assert.equal(result.verificationCommand, undefined);
  }
  assert.equal(
    resolveOneForAllInput({ ...input, content: 'Fix README.md', permissionMode: 'read-only' }).permissionMode,
    'read-only',
  );
  assert.equal(
    resolveOneForAllInput({ ...input, mode: 'chat', verificationCommand: 'do-not-run' }).verificationCommand,
    undefined,
  );
});

test('scope restrictions and embedded general change bans preserve the permission cap', () => {
  for (const verb of ['delete', 'move', 'rename', 'archive']) {
    const content = `Implement the feature. Do NOT ${verb} files.`;
    const resolved = resolveOneForAllInput({ ...input, content });
    assert.equal(resolved.permissionMode, 'workspace-write', content);
    assert.equal(resolved.readOnlyTrigger, undefined, content);
  }
  for (const verb of ['删除', '移动', '搬走', '搬移', '迁移', '重命名', '归档']) {
    const content = `实现功能。不要${verb}文件。`;
    const resolved = resolveOneForAllInput({ ...input, content });
    assert.equal(resolved.permissionMode, 'workspace-write', content);
    assert.equal(resolved.readOnlyTrigger, undefined, content);
  }
  for (const prohibition of [
    ...['edit', 'change', 'modify', 'write', 'touch', 'alter', 'create', 'implement'].map(
      (verb) => `Do not ${verb} anything`,
    ),
    ...['修改', '改动', '编辑', '写入', '改', '动', '碰'].map((verb) => `不要${verb}文件`),
    'No changes',
    'Keep it read-only',
    '只读',
    '不改',
    'Do not delete or edit files',
    'Do not edit or delete files',
  ]) {
    const content = `Implement the feature; ${prohibition}.`;
    const resolved = resolveOneForAllInput({ ...input, content });
    assert.equal(resolved.permissionMode, 'workspace-write', content);
    assert.ok(resolved.scopeNote?.includes(prohibition), content);
    assert.equal(resolved.readOnlyTrigger, undefined, content);
  }
});

test('automatic resolution uses only whole-message stops and keeps embedded restrictions as scope notes', () => {
  for (const [content, phrase] of [
    ['检查代码，不要改任何文件', '不要改任何文件'],
    ['Fix the typo, but do not edit any files yet.', 'do not edit any files yet'],
    ['本次只读，检查代码', '本次只读'],
    ['只给出方案', '只给出方案'],
    ['Create an implementation plan for this project.', 'Create an implementation plan for this project'],
  ]) {
    const resolved = resolveOneForAllInput({ ...input, content });
    assert.equal(resolved.permissionMode, content === '只给出方案' ? 'read-only' : 'workspace-write', content);
    assert.ok((resolved.scopeNote ?? resolved.readOnlyTrigger)?.includes(phrase), content);
  }
  assert.equal(
    resolveOneForAllInput({ ...input, content: 'Fix the typo, but do not edit README.md.' }).readOnlyTrigger,
    undefined,
  );
  assert.equal(resolveOneForAllInput({ ...input, content: '别改用 Claude，修复按钮' }).readOnlyTrigger, undefined);
  assert.equal(
    resolveOneForAllInput({ ...input, content: '修复按钮', intentText: '修复按钮', readOnlyTrigger: '旧提示' })
      .readOnlyTrigger,
    undefined,
  );
});

test('explicit write grants preserve permission and keep stops as scope notes', () => {
  for (const content of ['Do NOT delete files.', '不要删除文件', "don't change anything", '只看不改', '只读']) {
    for (const grant of [{ explicitWrite: true }, { permissionReauthorized: true }, { mode: 'build' as const }]) {
      const resolved = resolveOneForAllInput({ ...input, content, ...grant });
      const mode = 'workspace-write';
      assert.ok(resolved.scopeNote, content);
      assert.equal(resolved.permissionMode, mode, content);
      assert.equal(resolveOneForAllInput(resolved).permissionMode, mode);
    }
  }
});

test('explicit grants preserve file-change evidence next to scope restrictions', () => {
  for (const content of [
    'Implement the feature. Do not edit any files.',
    'Update README.md; do not change anything.',
    '实现功能。不要修改任何文件。',
  ]) {
    assert.equal(requestsFileChanges(content, true), true, content);
  }
  for (const content of ['Do not edit any files.', '只给方案', 'Review README.md. Do not change anything.']) {
    assert.equal(requestsFileChanges(content, true), false, content);
  }
});

test('automatic mode narrows only six whole-message stop forms', () => {
  for (const content of [
    '只看不改',
    '只给方案',
    '只读',
    '不要改任何文件',
    "don't change anything",
    'read-only please',
  ]) {
    const resolved = resolveOneForAllInput({ ...input, content });
    assert.equal(resolved.permissionMode, 'read-only', content);
    assert.equal(resolved.readOnlyTrigger, content);
    assert.equal(resolveOneForAllInput(resolved).readOnlyTrigger, content);
    assert.equal(resolved.scopeNote, undefined);
    assert.equal(resolved.verificationCommand, undefined);
    const embedded = resolveOneForAllInput({ ...input, content: `Implement X; ${content}.` });
    assert.equal(embedded.permissionMode, 'workspace-write', content);
    assert.ok(embedded.scopeNote, content);
  }
});

test('general conversations use distinct managed directories and do not touch the default project or share project memory', async (t) => {
  const { workspace, controller, directory, calls } = fixture(t);
  controller.settings.defaultProjectPath = directory;
  const first = await workspace.createGeneralConversation(),
    second = await workspace.createGeneralConversation();
  const firstProject = workspace.store.get<Project>('project', first.projectId)!;
  const secondProject = workspace.store.get<Project>('project', second.projectId)!;
  assert.equal(firstProject.scope, 'chat');
  assert.notEqual(firstProject.path, secondProject.path);
  assert.ok(firstProject.path.startsWith(join(directory, 'data', 'workspaces') + sep));
  assert.notEqual(firstProject.path, controller.settings.defaultProjectPath);
  workspace.updateMemory(first.projectId, 'FIRST_CHAT_ONLY', 0);
  const submission = await workspace.send(second.id, input);
  assert.equal((await finish(workspace, submission.workflow.id)).status, 'completed');
  assert.equal(calls[0]!.input.projectPath, secondProject.path);
  assert.equal(calls[0]!.input.permissionMode, 'workspace-write');
  assert.doesNotMatch(calls[0]!.input.prompt, /FIRST_CHAT_ONLY/);
});

test('confirmation is durable and starts no planner or model until approved, then pins the displayed selection', async (t) => {
  const { workspace, controller, calls } = fixture(t, 'confirm');
  controller.settings.routePreferencesEnabled = true;
  const conversation = await workspace.createGeneralConversation();
  const submitted = await workspace.send(conversation.id, { ...input, content: '实现一个包含前端和后端的新系统' });
  await workspace.tickQueue();
  const proposed = workspace.store.get<Workflow>('workflow', submitted.workflow.id)!;
  assert.equal(proposed.status, 'waiting-confirmation');
  assert.equal(calls.length, 0);
  assert.equal(controller.active.size, 0);
  assert.equal(proposed.startedAt, undefined);
  assert.equal(proposed.runIds.length, 0);
  assert.throws(() => workspace.updateSchedule(proposed.id, {}), /只能修改/);
  const reviewed = structuredClone(proposed.routingReview!.proposal);
  confirm(workspace, proposed.id);
  controller.settings.architectureProvider = 'claude';
  const completed = await finish(workspace, proposed.id);
  assert.equal(completed.status, 'completed');
  assert.ok(calls.length >= 2, 'complex build includes a planner only after confirmation');
  for (const call of calls) {
    assert.equal(call.route.runtimeId, reviewed.runtimeId);
    assert.equal(call.route.model, reviewed.model);
    assert.equal(call.route.effort, reviewed.effort);
  }
});

test('a changed quota proposes another route and requires another explicit confirmation', async (t) => {
  const { workspace, controller, calls } = fixture(t, 'confirm');
  const conversation = await workspace.createGeneralConversation();
  const submitted = await workspace.send(conversation.id, input);
  await workspace.tickQueue();
  const first = workspace.store.get<Workflow>('workflow', submitted.workflow.id)!.routingReview!.proposal;
  const oldProposalId = workspace.store.get<Workflow>('workflow', submitted.workflow.id)!.routingReview!.id;
  controller.snapshots.find((snapshot) => snapshot.id === first.runtimeId)!.quota.windows[0]!.usedPercent = 100;
  const changed = confirm(workspace, submitted.workflow.id);
  assert.equal(changed.status, 'waiting-confirmation');
  assert.notEqual(changed.routingReview!.proposal.runtimeId, first.runtimeId);
  assert.equal(calls.length, 0);
  assert.throws(() => workspace.confirm(changed.id, oldProposalId), /已更新/);
  await workspace.tickQueue();
  assert.equal(calls.length, 0);
  confirm(workspace, changed.id);
  assert.equal((await finish(workspace, changed.id)).status, 'completed');
  assert.equal(calls[0]!.route.runtimeId, changed.routingReview!.proposal.runtimeId);
});

test('a resource change at the actual start boundary cannot bypass the confirmation gate', async (t) => {
  const { workspace, controller, calls } = fixture(t, 'confirm');
  const conversation = await workspace.createGeneralConversation();
  const submitted = await workspace.send(conversation.id, input);
  await workspace.tickQueue();
  confirm(workspace, submitted.workflow.id);
  const start = controller.start.bind(controller);
  let first = true;
  t.mock.method(controller, 'start', async (...args: Parameters<Controller['start']>) => {
    if (first) {
      first = false;
      controller.snapshots[0]!.quota.windows[0]!.usedPercent = 100;
      throw new RouteUnavailableError('quota', ['quota changed']);
    }
    return start(...args);
  });
  await workspace.tickQueue();
  await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  const changed = workspace.store.get<Workflow>('workflow', submitted.workflow.id)!;
  assert.equal(changed.status, 'waiting-confirmation');
  assert.equal(calls.length, 0);
  assert.equal(changed.startedAt, undefined);
  confirm(workspace, changed.id);
  assert.equal((await finish(workspace, changed.id)).status, 'completed');
});

test('pending approval survives workspace restart and cancelling or continuing cannot start it', async (t) => {
  const { workspace, controller, calls } = fixture(t, 'confirm');
  const conversation = await workspace.createGeneralConversation();
  const submitted = await workspace.send(conversation.id, input);
  await workspace.tickQueue();
  await workspace.close();
  const reopened = new Workspace(controller, { autoTick: false });
  t.after(() => reopened.close());
  await reopened.tickQueue();
  assert.equal(calls.length, 0);
  assert.equal(reopened.store.get<Workflow>('workflow', submitted.workflow.id)!.status, 'waiting-confirmation');
  await assert.rejects(reopened.continue(submitted.workflow.id), /取消排队/);
  reopened.cancel(submitted.workflow.id);
  assert.throws(() => confirm(reopened, submitted.workflow.id), /没有待确认/);
  assert.equal(calls.length, 0);
});

test('failed approved work does not silently increase effort and its continuation asks again', async (t) => {
  const { workspace, controller, calls } = fixture(t, 'confirm');
  let callsAtVerification = 0;
  const verify = t.mock.method(controller, 'verify', async () => {
    callsAtVerification = calls.length;
    return { command: 'test', status: 'failed' as const, exitCode: 1, output: 'fixture failure' };
  });
  const conversation = await workspace.createGeneralConversation();
  const change = { kind: 'verification', projectId: conversation.projectId, command: 'test' };
  await desktopPermissionChange(workspace, change, true, await desktopPermissionChange(workspace, change, false));
  const submitted = await workspace.send(conversation.id, {
    ...input,
    content: 'Fix the typo in README.md',
    verificationCommand: 'test',
  });
  await workspace.tickQueue();
  confirm(workspace, submitted.workflow.id);
  const failed = await finish(workspace, submitted.workflow.id);
  assert.equal(failed.status, 'blocked');
  const reviewed = failed.routingReview!.proposal;
  assert.equal(verify.mock.callCount(), 1);
  assert.ok(callsAtVerification > 0);
  assert.equal(calls.length, callsAtVerification, 'failed verification must not start an unapproved retry');
  for (const call of calls) {
    assert.equal(call.route.runtimeId, reviewed.runtimeId);
    assert.equal(call.route.model, reviewed.model);
    assert.equal(call.route.effort, reviewed.effort);
  }
  const callsBeforeContinue = calls.length;
  const continued = await workspace.continue(failed.id);
  await workspace.tickQueue();
  assert.equal(workspace.store.get<Workflow>('workflow', continued.workflow.id)!.status, 'waiting-confirmation');
  assert.equal(calls.length, callsBeforeContinue);
});

test('retired Magpie routes cannot be approved or silently replaced', async (t) => {
  const { workspace, controller, calls } = fixture(t, 'confirm');
  controller.targets = [
    {
      id: 'pi-magpie',
      provider: 'pi',
      gateway: 'magpie',
      label: 'Magpie',
      command: 'unused',
      enabled: true,
      environment: 'native',
    },
  ];
  controller.snapshots = [
    {
      ...controller.snapshots[0]!,
      id: 'pi-magpie',
      provider: 'pi',
      models: [{ id: 'magpie/group/auto', label: 'Dynamic group', efforts: ['low'] }],
    },
  ];
  const conversation = await workspace.createGeneralConversation();
  const submitted = await workspace.send(conversation.id, {
    ...input,
    runtimeId: 'pi-magpie',
    model: 'magpie/group/auto',
  });
  await workspace.tickQueue();
  const blocked = workspace.store.get<Workflow>('workflow', submitted.workflow.id)!;
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.error!, /Magpie 网关已移除/);
  assert.equal(calls.length, 0);
});

test('delegated reviewer uses the native queue, is idempotent, read-only and returns to the same conversation', async (t) => {
  const { workspace, calls, directory } = fixture(t);
  const project = await workspace.createProject(directory);
  const conversation = workspace.createConversation(project.id);
  const parent = await workspace.send(conversation.id, {
    ...input,
    mode: 'chat',
    content: 'Explain the module',
    executionPolicy: 'cli-first',
  });
  await finish(workspace, parent.workflow.id);
  const [first, duplicate] = await Promise.all([
    workspace.delegate(parent.workflow.id, 'reviewer', 'Review correctness', 'same-request'),
    workspace.delegate(parent.workflow.id, 'reviewer', 'Review correctness', 'same-request'),
  ]);
  assert.equal(first.workflow.id, duplicate.workflow.id);
  assert.equal(duplicate.reused, true);
  assert.equal(first.workflow.input.permissionMode, 'read-only');
  assert.equal(first.workflow.input.executionPolicy, 'cli-only');
  assert.equal(first.workflow.parentWorkflowId, undefined);
  assert.equal(first.workflow.delegation?.parentId, parent.workflow.id);
  // Cross-review: the reviewer is routed away from the provider that produced the parent result.
  const parentProvider = calls[0]!.target.provider;
  assert.deepEqual(first.workflow.delegation?.crossCheck, { of: parentProvider });
  assert.deepEqual(first.workflow.input.excludeProviders, [parentProvider]);
  const done = await finish(workspace, first.workflow.id);
  assert.equal(done.status, 'completed');
  assert.equal(calls.at(-1)?.input.permissionMode, 'read-only');
  assert.notEqual(calls.at(-1)?.target.provider, parentProvider);
  assert.match(workspace.store.get<{ content: string }>('message', done.finalMessageId!)!.content, /^子任务 · 审查/);
  assert.equal(done.conversationId, conversation.id);
  const nested = await workspace.delegate(done.id, 'worker', 'Spawn recursively', 'recursive');
  assert.equal(nested.workflow.delegation?.parentId, done.id);
  assert.equal(nested.workflow.input.permissionMode, 'read-only');
  workspace.cancel(nested.workflow.id);
  const continued = await workspace.continue(done.id);
  assert.deepEqual(continued.workflow.delegation, done.delegation);
});

test('delegation cannot elevate read-only permissions, has a durable limit and honors confirmation mode', async (t) => {
  const { workspace, controller, calls, directory } = fixture(t, 'confirm');
  const project = await workspace.createProject(directory);
  const conversation = workspace.createConversation(project.id);
  const parent = await workspace.send(conversation.id, {
    ...input,
    mode: 'chat',
    permissionMode: 'read-only',
    content: 'Explain code',
  });
  for (let i = 0; i < 12; i++) {
    const child = await workspace.delegate(parent.workflow.id, 'worker', 'Write a file', 'request-' + i);
    assert.equal(child.workflow.input.permissionMode, 'read-only');
    assert.equal(child.workflow.requiresConfirmation, true);
  }
  await assert.rejects(workspace.delegate(parent.workflow.id, 'scout', 'Inspect files', 'request-extra'), /最多/);
  assert.equal(calls.length, 0);
  assert.equal(controller.active.size, 0);
  workspace.cancel(parent.workflow.id);
  assert.ok(workspace.store.workflows(conversation.id).every((flow) => flow.status === 'cancelled'));
});

test('cross-review falls back to the same provider, and says so, when no other provider is ready', async (t) => {
  const { workspace, controller, calls, directory } = fixture(t);
  const project = await workspace.createProject(directory);
  const conversation = workspace.createConversation(project.id);
  const parent = await workspace.send(conversation.id, { ...input, mode: 'chat', content: 'Explain the module' });
  await finish(workspace, parent.workflow.id);
  const parentProvider = calls[0]!.target.provider;
  controller.snapshots = controller.snapshots.map((snapshot) =>
    snapshot.provider === parentProvider ? snapshot : { ...snapshot, status: 'missing' as const },
  );
  const review = await workspace.delegate(parent.workflow.id, 'reviewer', 'Review it', 'fallback-request');
  assert.deepEqual(review.workflow.delegation?.crossCheck, { of: parentProvider, sameProvider: true });
  assert.equal(review.workflow.input.excludeProviders, undefined);
  assert.match(review.workflow.input.content, /没有其他可用执行器/);
});

test('a reviewer of adult fiction stays on Grok, since other platforms refuse it', async (t) => {
  const { workspace, calls, directory } = fixture(t);
  const project = await workspace.createProject(directory);
  const conversation = workspace.createConversation(project.id);
  const parent = await workspace.send(conversation.id, { ...input, mode: 'chat', content: 'Explain the module' });
  await finish(workspace, parent.workflow.id);
  const parentProvider = calls[0]!.target.provider;
  const saved = workspace.store.get<Workflow>('workflow', parent.workflow.id)!;
  saved.input = {
    ...saved.input,
    content: '续写第三章，保留原来的情色描写',
    intentText: '续写第三章，保留原来的情色描写',
  };
  workspace.store.save('workflow', saved.id, saved.conversationId, saved);
  const review = await workspace.delegate(parent.workflow.id, 'reviewer', 'Review it', 'adult-review');
  assert.equal(review.workflow.input.provider, 'grok');
  assert.equal(review.workflow.input.excludeProviders, undefined);
  assert.deepEqual(review.workflow.delegation?.crossCheck, { of: parentProvider });
  assert.match(review.workflow.input.content, /只交给 Grok 审核/);
});

test('delegated workers preserve the MCP caller origin and sandbox ceiling', async (t) => {
  const { workspace, directory } = fixture(t);
  const project = await workspace.createProject(directory);
  const conversation = workspace.createConversation(project.id);
  const origin = { mode: 'workspace-write' as const, source: 'caller' as const, unrestricted: false, note: 'Codex' };
  const parent = await workspace.send(conversation.id, {
    ...input,
    permissionOrigin: origin,
    content: 'Explain the project',
  });
  await finish(workspace, parent.workflow.id);
  const child = await workspace.delegate(parent.workflow.id, 'worker', 'Explain one part', 'caller-worker');
  assert.deepEqual(child.workflow.input.permissionOrigin, origin);
});

test('in a conversation whose rules send adult material to one platform, its work there is reviewed there', async (t) => {
  const { workspace, calls, directory } = fixture(t);
  const project = await workspace.createProject(directory);
  const conversation = workspace.createConversation(project.id);
  const parent = await workspace.send(conversation.id, { ...input, mode: 'chat', content: '按引用改掉不自然的句子' });
  await finish(workspace, parent.workflow.id);
  const parentProvider = calls[0]!.target.provider;
  const saved = workspace.store.get<import('../src/shared/types.ts').Conversation>('conversation', conversation.id)!;
  saved.routing = {
    text: '',
    rules: [{ topic: 'adult', target: { provider: parentProvider }, strict: true }],
    chapterAgents: false,
    mask: false,
    updatedAt: new Date().toISOString(),
  };
  workspace.store.save('conversation', saved.id, saved.projectId, saved);
  const review = await workspace.delegate(parent.workflow.id, 'reviewer', 'Review it', 'rule-review');
  assert.equal(review.workflow.input.provider, parentProvider);
  assert.equal(review.workflow.input.excludeProviders, undefined);
  assert.deepEqual(review.workflow.delegation?.crossCheck, { of: parentProvider, sameProvider: true });
});

test('a writable request for file changes never becomes a reply-only plan, however it is worded', async (t) => {
  const content = '在 src/ui/Tray.tsx 里把截图按钮改成圆角，可以吗？';
  const question = { status: 'accepted', intent: 'question' as const };
  assert.equal(resolveOneForAllInput({ ...input, content, explicitWrite: true }).mode, 'build');
  assert.equal(applyTaskJudgment({ ...input, content, explicitWrite: true }, question).mode, 'build');
  // Without the write grant, or without a file change in the words, a question stays a direct reply.
  assert.equal(resolveOneForAllInput({ ...input, content }).mode, 'chat');
  for (const words of ['处理器性能怎么样？', '怎么创建一个网页？', '解释这个概念']) {
    assert.equal(resolveOneForAllInput({ ...input, content: words, explicitWrite: true }).mode, 'chat', words);
    assert.equal(applyTaskJudgment({ ...input, content: words, explicitWrite: true }, question).mode, 'chat', words);
  }
  const { workspace, calls } = fixture(t);
  const conversation = await workspace.createGeneralConversation();
  const submitted = await workspace.send(conversation.id, { ...input, content, explicitWrite: true });
  const workflow = await finish(workspace, submitted.workflow.id);
  assert.equal(workflow.input.mode, 'build');
  assert.ok(workflow.plan.length && workflow.plan.every((step) => step.id !== 'reply'));
  assert.ok(calls.some((call) => call.input.checkFileChanges));
  assert.ok(calls.every((call) => !call.input.requiresFileChanges));
});
