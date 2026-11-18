import { cursorFixture } from './helpers/cursor-fixture.ts';
import { saveAttachment } from './helpers/attachments.ts';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { claudeAdapter } from '../src/server/adapters/claude.ts';
import { grokAdapter } from '../src/server/adapters/grok.ts';
import type { ExecuteContext, MessageInput, RuntimeSnapshot, Workflow, WorkflowStep } from '../src/shared/types.ts';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR2UAAAAASUVORK5CYII=';
const base: MessageInput = {
  content: 'Explain the supplied image and specification.',
  mode: 'chat',
  permissionMode: 'read-only',
  executionPolicy: 'cli-first',
  autoEscalate: true,
};
type FixtureProvider = 'codex' | 'claude' | 'grok';
function snapshot(provider: FixtureProvider): RuntimeSnapshot {
  return {
    id: `fixture-${provider}`,
    provider,
    label: `Fixture ${provider}`,
    environment: 'native',
    installed: true,
    status: 'ready',
    models: [{ id: 'fixture-model', label: 'Fixture model', efforts: ['low', 'medium', 'high'] }],
    quota: {
      status: 'known',
      source: 'Fixture subscription',
      observedAt: new Date().toISOString(),
      windows: [
        { id: 'week', label: 'week', usedPercent: 10, resetsAt: new Date(Date.now() + 3600_000).toISOString() },
      ],
    },
    accounting: { mode: 'subscription', source: 'Fixture subscription' },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: new Date().toISOString(),
  };
}
async function fixture(t: TestContext, secondary: boolean | readonly FixtureProvider[] = false) {
  const directory = mkdtempSync(join(tmpdir(), 'comborunner-attachments-workflow-'));
  const controller = new Controller(directory, join(directory, 'data'), {
    readAccountIdentity: (target) => target.accountFingerprint,
  });
  clearInterval(controller.timer);
  controller.settings.taskJudgment = 'local';
  controller.settings.toolApprovalMode = 'auto';
  controller.settings.routePreferencesEnabled = true;
  controller.settings.designProvider = 'codex';
  controller.settings.architectureProvider = 'codex';
  controller.settings.routineProvider = 'codex';
  const providers: readonly FixtureProvider[] =
    typeof secondary === 'boolean' ? (secondary ? ['codex', 'claude'] : ['codex']) : secondary;
  controller.targets = providers.map((provider) => ({
    id: `fixture-${provider}`,
    provider,
    label: `Fixture ${provider}`,
    command: 'never-spawned',
    environment: 'native',
    enabled: true,
  }));
  controller.snapshots = providers.map(snapshot);
  t.mock.method(codexAdapter, 'discover', async () => snapshot('codex'));
  t.mock.method(claudeAdapter, 'discover', async () => snapshot('claude'));
  t.mock.method(grokAdapter, 'discover', async () => snapshot('grok'));
  for (const adapter of [codexAdapter, claudeAdapter, grokAdapter])
    t.mock.method(adapter, 'execute', async () => {
      throw new Error('Every dispatched attachment fixture must install its own adapter mock.');
    });
  const workspace = new Workspace(controller, { autoTick: false, retryMs: 20 });
  const project = await workspace.createProject(directory);
  const conversation = workspace.createConversation(project.id);
  t.after(async () => {
    await workspace.close();
    await controller.close();
    assert.ok(
      resolve(directory).startsWith(resolve(tmpdir()) + sep) &&
        basename(directory).startsWith('comborunner-attachments-workflow-'),
    );
    rmSync(directory, { recursive: true, force: true });
  });
  const image = await saveAttachment(workspace.attachments, conversation.id, {
    name: 'screenshot.png',
    mimeType: 'image/png',
    dataBase64: png,
  });
  const document = await saveAttachment(workspace.attachments, conversation.id, {
    name: 'requirements.md',
    mimeType: 'text/markdown',
    dataBase64: Buffer.from('Required accent color: lime.').toString('base64'),
  });
  return {
    directory,
    controller,
    workspace,
    project,
    conversation,
    image,
    document,
    attachmentIds: [image.id, document.id],
  };
}
async function finish(workspace: Workspace, id: string) {
  await workspace.tickQueue();
  for (let index = 0; index < 250; index++) {
    const current = workspace.store.get<Workflow>('workflow', id)!;
    if (['completed', 'failed', 'blocked', 'cancelled', 'waiting-confirmation'].includes(current.status))
      return current;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error('Attachment workflow did not settle.');
}
function assertDelivered(ctx: ExecuteContext) {
  assert.equal(ctx.approvalMode, 'auto');
  assert.equal(ctx.input.permissionMode, 'read-only');
  assert.deepEqual(
    ctx.input.attachments?.map((file) => file.kind),
    ['image', 'file'],
  );
  const [image, document] = ctx.input.attachments!;
  assert.equal(readFileSync(image!.path).toString('base64'), png);
  assert.equal(document!.text, 'Required accent color: lime.');
  assert.ok(ctx.input.prompt.includes('Required accent color: lime.'));
  assert.ok(ctx.input.prompt.includes(JSON.stringify(document!.path)));
}

const visualFacts = 'VISUAL_FACTS_FIXTURE: The image contains a lime pixel.';
function assertVisualHelper(ctx: ExecuteContext, imageId: string) {
  assert.equal(ctx.input.visualAssistant, true);
  assert.equal(ctx.input.permissionMode, 'read-only');
  assert.notEqual(ctx.input.agentCalls, true);
  assert.notEqual(ctx.input.agentChild, true);
  assert.equal(
    ctx.agentBridge,
    undefined,
    'Visual observation must not expose the PugPort operation/delegation bridge.',
  );
  assert.notEqual(ctx.route.effort, 'high', 'A small visual helper must not inherit the main high effort.');
  const image = ctx.input.attachments?.find((file) => file.id === imageId && file.kind === 'image');
  assert.ok(image, 'The visual helper must receive the original image.');
  assert.equal(readFileSync(image.path).toString('base64'), png);
}
function assertVisualReportDelivered(ctx: ExecuteContext, documentId?: string) {
  assert.ok(!ctx.input.attachments?.some((file) => file.kind === 'image'));
  assert.ok(ctx.input.prompt.includes(visualFacts));
  assert.ok(ctx.input.visualContext?.fromRunId, 'The visual report must link to its recorded helper run.');
  if (documentId) {
    const document = ctx.input.attachments?.find((file) => file.id === documentId && file.kind === 'file');
    assert.ok(document, 'Only handled image pixels may be removed; the original document remains.');
    assert.equal(document.text, 'Required accent color: lime.');
  }
}

test('workspace sends image bytes and text context to the adapter while retaining project and runtime usage attribution', async (t) => {
  const { controller, workspace, project, conversation, attachmentIds } = await fixture(t);
  let calls = 0;
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls++;
    assertDelivered(ctx);
    ctx.emit({
      at: new Date().toISOString(),
      type: 'usage',
      data: {
        source: 'Attachment fixture',
        scope: 'run-cumulative',
        eventId: 'final',
        inputTokens: 17,
        outputTokens: 3,
        totalTokens: 20,
      },
    });
    return { output: 'The picture and specification agree.', nativeSessionId: 'fixture-session' };
  });
  const first = await workspace.send(conversation.id, { ...base, attachmentIds });
  assert.equal((await finish(workspace, first.workflow.id)).status, 'completed');
  assert.equal(calls, 1);
  const message = workspace.conversation(conversation.id).messages.find((value) => value.id === first.message.id)!;
  assert.equal(message.attachments?.length, 2);
  assert.ok(message.attachments?.every((file) => !('path' in file)));
  const usage = controller.usage.report();
  assert.equal(usage.totals.totalTokens, 20);
  assert.equal(usage.totals.runs, 1);
  assert.equal(usage.perRun[0]?.projectPath, project.path);
  assert.equal(usage.perRun[0]?.runtimeId, 'fixture-codex');
  assert.equal(usage.perRun[0]?.workflowId, first.workflow.id);
  assert.equal(usage.perRun[0]?.accountingMode, 'subscription');
  assert.ok(!JSON.stringify(usage).includes('Required accent color'));
});

test('workspace rejects another conversation attachment before enqueueing or calling an adapter', async (t) => {
  const { controller, workspace, project, attachmentIds } = await fixture(t);
  const other = workspace.createConversation(project.id);
  let calls = 0;
  t.mock.method(codexAdapter, 'execute', async () => {
    calls++;
    return { output: 'Must not run.' };
  });
  await assert.rejects(workspace.send(other.id, { ...base, attachmentIds }), /当前对话/);
  assert.equal(workspace.conversation(other.id).messages.length, 0);
  assert.equal(workspace.conversation(other.id).workflows.length, 0);
  assert.equal(controller.usage.report().totals.runs, 0);
  assert.equal(calls, 0);
});

test('workspace revalidates queued attachments before any model or usage charge', async (t) => {
  const { controller, workspace, conversation, image, attachmentIds } = await fixture(t);
  let calls = 0;
  t.mock.method(codexAdapter, 'execute', async () => {
    calls++;
    return { output: 'Must not run.' };
  });
  const first = await workspace.send(conversation.id, { ...base, attachmentIds });
  writeFileSync(workspace.attachments.get(conversation.id, image.id).path, 'Modified after enqueue.');
  const finished = await finish(workspace, first.workflow.id);
  assert.ok(['failed', 'blocked'].includes(finished.status));
  assert.match(finished.error ?? '', /附件已变化/);
  assert.equal(calls, 0);
  assert.equal(controller.usage.report().totals.runs, 0);
});

test('workspace preserves text context and image references on automatic cross-runtime retry', async (t) => {
  const { workspace, conversation, attachmentIds } = await fixture(t, true);
  let calls = 0;
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls++;
    assertDelivered(ctx);
    throw new Error('quota-or-rate-limit');
  });
  t.mock.method(claudeAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls++;
    assertDelivered(ctx);
    return { output: 'Retried with the same attachments.' };
  });
  const first = await workspace.send(conversation.id, { ...base, attachmentIds });
  const finished = await finish(workspace, first.workflow.id);
  assert.equal(finished.status, 'completed', finished.error ?? 'attachment retry should complete');
  assert.equal(calls, 2);
  assert.equal(finished.runIds.length, 2);
});

test('route confirmation and explicit workflow continuation retain the selected attachments', async (t) => {
  const { controller, workspace, conversation, attachmentIds } = await fixture(t);
  let calls = 0;
  controller.settings.decisionMode = 'confirm';
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls++;
    assertDelivered(ctx);
    return { output: 'Attachments received.' };
  });
  const first = await workspace.send(conversation.id, { ...base, attachmentIds });
  const proposed = await finish(workspace, first.workflow.id);
  assert.equal(proposed.status, 'waiting-confirmation');
  assert.equal(calls, 0);
  workspace.confirm(proposed.id, proposed.routingReview!.id);
  assert.equal((await finish(workspace, first.workflow.id)).status, 'completed');
  controller.settings.decisionMode = 'auto';
  const next = await workspace.continue(first.workflow.id, 'Continue reviewing these same attachments.');
  assert.equal((await finish(workspace, next.workflow.id)).status, 'completed');
  assert.equal(calls, 2);
});

test('normal follow-up questions retain recent visual context without crossing into another conversation', async (t) => {
  const { workspace, project, conversation, attachmentIds } = await fixture(t);
  let calls = 0;
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls++;
    if (calls <= 2) assertDelivered(ctx);
    else {
      assert.equal(ctx.input.attachments, undefined);
      assert.ok(!ctx.input.prompt.includes('用户附件（'));
    }
    return { output: 'Fixture response.' };
  });
  const first = await workspace.send(conversation.id, { ...base, attachmentIds });
  assert.equal((await finish(workspace, first.workflow.id)).status, 'completed');
  const second = await workspace.send(conversation.id, { ...base, content: 'What about the previous image?' });
  assert.equal((await finish(workspace, second.workflow.id)).status, 'completed');
  const separate = workspace.createConversation(project.id);
  const third = await workspace.send(separate.id, { ...base, content: 'Explain this new topic.' });
  assert.equal((await finish(workspace, third.workflow.id)).status, 'completed');
  assert.equal(calls, 3);
});

test('a missing historical image is disclosed instead of being passed as visible data', async (t) => {
  const { workspace, conversation, image, document, attachmentIds } = await fixture(t);
  let calls = 0;
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls++;
    if (calls === 1) assertDelivered(ctx);
    else {
      assert.deepEqual(
        ctx.input.attachments?.map((file) => file.id),
        [document.id],
      );
      assert.match(ctx.input.prompt, /此前附件 "screenshot\.png" 已不可读取/);
      assert.match(ctx.input.prompt, /不要假装看到其内容/);
    }
    return { output: 'Fixture response.' };
  });
  const first = await workspace.send(conversation.id, { ...base, attachmentIds });
  assert.equal((await finish(workspace, first.workflow.id)).status, 'completed');
  unlinkSync(workspace.attachments.get(conversation.id, image.id).path);
  const second = await workspace.send(conversation.id, { ...base, content: 'What was in the previous image?' });
  assert.equal((await finish(workspace, second.workflow.id)).status, 'completed');
  assert.equal(calls, 2);
});

test('current attachments take priority over historical files within the eight-file context limit', async (t) => {
  const { workspace, conversation, attachmentIds } = await fixture(t);
  let calls = 0;
  const current = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      saveAttachment(workspace.attachments, conversation.id, {
        name: `current-${index}.txt`,
        mimeType: 'text/plain',
        dataBase64: Buffer.from(`Current document ${index}`).toString('base64'),
      }),
    ),
  );
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls++;
    if (calls === 1) assertDelivered(ctx);
    else {
      assert.deepEqual(
        ctx.input.attachments?.map((file) => file.id),
        current.map((file) => file.id),
      );
      assert.equal(ctx.input.attachments?.length, 8);
    }
    return { output: 'Fixture response.' };
  });
  const first = await workspace.send(conversation.id, { ...base, attachmentIds });
  assert.equal((await finish(workspace, first.workflow.id)).status, 'completed');
  const second = await workspace.send(conversation.id, {
    ...base,
    content: 'Review these new files.',
    attachmentIds: current.map((file) => file.id),
  });
  assert.equal((await finish(workspace, second.workflow.id)).status, 'completed');
  assert.equal(calls, 2);
});

test('an unverified Grok image entry blocks without replacing the user-selected executor', async (t) => {
  const { controller, workspace, conversation, image, document, attachmentIds } = await fixture(t, [
    'codex',
    'claude',
    'grok',
  ]);
  let grokCalls = 0;
  t.mock.method(grokAdapter, 'execute', async (ctx: ExecuteContext) => {
    grokCalls++;
    assert.equal(ctx.target.provider, 'grok');
    assert.deepEqual(
      ctx.input.attachments?.map((file) => file.id),
      [document.id],
    );
    assert.ok(!ctx.input.attachments?.some((file) => file.kind === 'image'));
    assert.ok(!ctx.input.prompt.includes(png));
    assert.match(ctx.input.prompt, /此前图片 "screenshot\.png" 的像素未提供给本次执行器/);
    assert.match(ctx.input.prompt, /不要假装看过其图片内容/);
    // The saved original's path still comes along, so local tools (such as picture search) can use it.
    assert.match(ctx.input.prompt, /原件路径："[^"]+.png"/);
    return { output: 'Text request completed without image input.' };
  });
  for (const adapter of [codexAdapter, claudeAdapter])
    t.mock.method(adapter, 'execute', async () => {
      assert.fail("A pinned Grok must not spend another executor's quota or hand it the final response.");
    });

  const pinned = { ...base, provider: 'grok' as const, runtimeId: 'fixture-grok', allowExecutorFallback: false };
  const uploaded = await workspace.send(conversation.id, { ...pinned, attachmentIds });
  const blocked = await finish(workspace, uploaded.workflow.id);
  assert.equal(blocked.status, 'blocked');
  assert.equal(grokCalls, 0);
  assert.equal(blocked.input.runtimeId, 'fixture-grok');
  assert.match(blocked.error ?? '', /图片|视觉|看图/);
  assert.equal(controller.usage.report().totals.runs, 0);

  const text = await workspace.send(conversation.id, { ...pinned, content: 'Explain this new text topic.' });
  assert.equal((await finish(workspace, text.workflow.id)).status, 'completed');
  assert.equal(grokCalls, 1);
  assert.equal(readFileSync(workspace.attachments.get(conversation.id, image.id).path!).toString('base64'), png);
  assert.ok(
    workspace
      .conversation(conversation.id)
      .messages.find((message) => message.id === uploaded.message.id)
      ?.attachments?.some((attachment) => attachment.id === image.id),
  );

  const usageBeforeRetry = controller.usage.report().totals.runs;
  const explicitAgain = await workspace.send(conversation.id, { ...pinned, attachmentIds: [image.id] });
  assert.equal((await finish(workspace, explicitAgain.workflow.id)).status, 'blocked');
  assert.equal(grokCalls, 1, 'newly supplied image pixels are never silently removed to dispatch Grok');
  assert.equal(controller.usage.report().totals.runs, usageBeforeRetry);
  assert.equal(readFileSync(workspace.attachments.get(conversation.id, image.id).path!).toString('base64'), png);
});

test('a fixed text-only Grok receives Codex visual facts and finishes on its original model and effort', async (t) => {
  const { controller, workspace, conversation, image, document, attachmentIds } = await fixture(t, ['grok', 'codex']);
  const providers: string[] = [];
  let dispatchFailure: unknown;
  t.mock.method(grokAdapter, 'execute', async (context: ExecuteContext) => {
    providers.push(context.target.provider);
    try {
      assertVisualReportDelivered(context, document.id);
      assert.equal(context.input.permissionMode, 'read-only');
      assert.equal(context.route.model, 'fixture-model');
      assert.equal(context.route.effort, 'high');
    } catch (error) {
      dispatchFailure = error;
      throw error;
    }
    return { output: 'Grok completed the original request using visual facts.' };
  });
  t.mock.method(codexAdapter, 'execute', async (context: ExecuteContext) => {
    providers.push(context.target.provider);
    assertVisualHelper(context, image.id);
    assert.equal(context.target.provider, 'codex');
    return { output: visualFacts };
  });
  const sent = await workspace.send(conversation.id, {
    ...base,
    provider: 'grok',
    runtimeId: 'fixture-grok',
    model: 'fixture-model',
    effort: 'high',
    attachmentIds,
  });
  const done = await finish(workspace, sent.workflow.id);
  assert.equal(done.status, 'completed', `${done.error ?? ''}\n${String(dispatchFailure ?? '')}`);
  assert.deepEqual(providers, ['codex', 'grok']);
  assert.equal(readFileSync(workspace.attachments.get(conversation.id, image.id).path).toString('base64'), png);
  assert.equal(controller.usage.report().totals.runs, 2);
  const final = workspace.conversation(conversation.id).messages.find((item) => item.id === done.finalMessageId)!;
  assert.equal(final.content, 'Grok completed the original request using visual facts.');
  assert.ok(!final.content.includes(visualFacts));
  assert.equal(done.visualRunIds?.length, 1);
  const helper = controller.store.run(done.visualRunIds![0]!)!;
  const main = controller.store.run(done.runIds.at(-1)!)!;
  assert.equal(helper.visualAssistant, true);
  assert.equal(helper.workflowId, done.id);
  assert.equal(helper.stepId, main.stepId);
  assert.ok(main.events.some((event) => event.data?.visualBridgeRestored === true));
  assert.ok(!final.replyIdentity?.runs.some((run) => run.runId === helper.id));
});

function enableGrokImages(t: TestContext, controller: Controller) {
  const visual = snapshot('grok');
  visual.capabilities.imageInput = true;
  visual.accountFingerprint = 'fixture-grok-identity';
  controller.snapshots = controller.snapshots.map((item) => (item.provider === 'grok' ? visual : item));
  const target = controller.targets.find((item) => item.provider === 'grok')!;
  target.accountFingerprint = visual.accountFingerprint;
  t.mock.method(grokAdapter, 'discover', async () => visual);
}

test('a dropped native Grok image stops the workflow with a clear reason and never retries through another CLI', async (t) => {
  const { controller, workspace, conversation, attachmentIds } = await fixture(t, ['codex', 'claude', 'grok']);
  enableGrokImages(t, controller);
  let grokCalls = 0;
  let otherCalls = 0;
  t.mock.method(grokAdapter, 'execute', async (ctx: ExecuteContext) => {
    grokCalls++;
    assertDelivered(ctx);
    ctx.emit({
      at: new Date().toISOString(),
      type: 'error',
      text: 'runtime-image-dropped',
      data: { reason: 'image-dropped' },
    });
    throw new Error('runtime-image-dropped');
  });
  for (const adapter of [codexAdapter, claudeAdapter]) {
    t.mock.method(adapter, 'execute', async () => {
      otherCalls++;
      return { output: 'Must never replace the pinned Grok after a dropped image.' };
    });
  }
  const sent = await workspace.send(conversation.id, {
    ...base,
    provider: 'grok',
    runtimeId: 'fixture-grok',
    attachmentIds,
    allowExecutorFallback: false,
  });
  const stopped = await finish(workspace, sent.workflow.id);
  assert.equal(stopped.status, 'blocked');
  assert.match(stopped.error ?? '', /未能接收完整图片/);
  const finalMessage = workspace
    .conversation(conversation.id)
    .messages.find((item) => item.id === stopped.finalMessageId);
  assert.equal(finalMessage?.content, '执行器未能读取本次图片，请检查图片或更换执行器。');
  assert.equal(finalMessage.systemNotice?.text, finalMessage.content);
  assert.match(finalMessage.systemNotice?.details ?? '', /runtime-image-dropped|未能接收完整图片/);
  assert.equal(stopped.input.runtimeId, 'fixture-grok');
  assert.equal(stopped.runIds.length, 1);
  assert.equal(grokCalls, 1);
  assert.equal(otherCalls, 0);
  assert.equal(controller.usage.report().totals.runs, 1);
});

test('a dropped Grok image channel uses a fresh visual helper and then restores the fixed Grok', async (t) => {
  const { controller, workspace, conversation, image, document, attachmentIds } = await fixture(t, ['grok', 'codex']);
  enableGrokImages(t, controller);
  const providers: string[] = [];
  t.mock.method(grokAdapter, 'execute', async (context: ExecuteContext) => {
    providers.push(context.target.provider);
    if (providers.length > 1) {
      assertVisualReportDelivered(context, document.id);
      assert.equal(context.nativeSessionId, undefined);
      return { output: 'Grok recovered the visual request after the helper.' };
    }
    assertDelivered(context);
    context.emit({
      at: new Date().toISOString(),
      type: 'error',
      text: 'runtime-image-dropped',
      data: { reason: 'image-dropped' },
    });
    throw new Error('runtime-image-dropped');
  });
  t.mock.method(codexAdapter, 'execute', async (context: ExecuteContext) => {
    providers.push(context.target.provider);
    assertVisualHelper(context, image.id);
    assert.equal(context.nativeSessionId, undefined);
    return { output: visualFacts };
  });
  const sent = await workspace.send(conversation.id, {
    ...base,
    provider: 'grok',
    runtimeId: 'fixture-grok',
    attachmentIds,
    allowExecutorFallback: true,
  });
  const done = await finish(workspace, sent.workflow.id);
  assert.equal(done.status, 'completed', done.error ?? '');
  assert.deepEqual(providers, ['grok', 'codex', 'grok']);
  assert.equal(done.runIds.length, 3);
  assert.equal(readFileSync(workspace.attachments.get(conversation.id, image.id).path).toString('base64'), png);
  assert.equal(controller.store.run(done.runIds[0]!)?.errorCode, 'runtime-image-dropped');
  const failedChannel = controller.store.run(done.runIds[0]!)!;
  assert.match(failedChannel.error ?? '', /未能接收完整图片/);
  assert.doesNotMatch(failedChannel.error ?? '', /已停止本次任务|没有切换执行器|重新添加图片/);
  assert.match(
    workspace.conversation(conversation.id).messages.find((item) => item.id === done.finalMessageId)?.content ?? '',
    /Grok recovered the visual request after the helper/,
  );
});

test('a verified Grok image entry retains the selected account, model, effort and native conversation', async (t) => {
  const { controller, workspace, project, conversation, attachmentIds } = await fixture(t, ['codex', 'claude', 'grok']);
  enableGrokImages(t, controller);
  let calls = 0;
  t.mock.method(grokAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls++;
    assertDelivered(ctx);
    assert.equal(ctx.target.id, 'fixture-grok');
    assert.equal(ctx.route.accountFingerprint, 'fixture-grok-identity');
    assert.equal(ctx.route.model, 'fixture-model');
    assert.equal(ctx.route.effort, 'high');
    assert.equal(ctx.input.projectPath, project.path);
    assert.ok(!ctx.input.prompt.includes('的像素未提供给本次执行器'));
    assert.equal(ctx.nativeSessionId, calls === 1 ? undefined : 'grok-visual-native-session');
    return { output: `Grok image answer ${calls}.`, nativeSessionId: 'grok-visual-native-session' };
  });
  const pinned = {
    ...base,
    provider: 'grok' as const,
    runtimeId: 'fixture-grok',
    model: 'fixture-model',
    effort: 'high',
  };
  const first = await workspace.send(conversation.id, { ...pinned, attachmentIds });
  const firstDone = await finish(workspace, first.workflow.id);
  assert.equal(firstDone.status, 'completed', firstDone.error ?? 'Native image task should complete.');
  assert.equal(firstDone.runIds.length, 1, 'native vision needs no helper inference');
  assert.equal(firstDone.input.runtimeId, pinned.runtimeId);
  const followUp = await workspace.send(conversation.id, { ...pinned, content: 'Describe the same image again.' });
  const followUpDone = await finish(workspace, followUp.workflow.id);
  assert.equal(followUpDone.status, 'completed', followUpDone.error ?? 'Native visual continuation should complete.');
  assert.equal(calls, 2);
  assert.equal(controller.usage.report().totals.runs, 2);
  assert.equal(
    workspace.conversation(conversation.id).messages.find((item) => item.id === followUpDone.finalMessageId)?.content,
    'Grok image answer 2.',
  );
});

test('a provider-selected verified Grok sees explicitly quoted old images without seeing another conversation', async (t) => {
  const { controller, workspace, project, conversation, image, attachmentIds } = await fixture(t, ['codex', 'grok']);
  enableGrokImages(t, controller);
  let calls = 0;
  t.mock.method(grokAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls++;
    if (calls < 3) {
      assert.ok(ctx.input.attachments?.some((item) => item.id === image.id && item.kind === 'image'));
    } else {
      assert.equal(ctx.input.attachments, undefined);
    }
    return { output: "Grok received only this conversation's attachments." };
  });
  const selected = { ...base, provider: 'grok' as const };
  const first = await workspace.send(conversation.id, { ...selected, attachmentIds });
  assert.equal((await finish(workspace, first.workflow.id)).status, 'completed');
  for (let index = 0; index < 30; index++)
    workspace.store.addMessage(conversation.id, 'user', `Unrelated history ${index}.`);
  const quoted = await workspace.send(conversation.id, {
    ...selected,
    content: 'Describe the attached image in this quoted message.',
    quotes: [{ messageId: first.message.id, text: first.message.content }],
  });
  assert.equal((await finish(workspace, quoted.workflow.id)).status, 'completed');
  const other = workspace.createConversation(project.id);
  const separate = await workspace.send(other.id, { ...selected, content: 'Explain this unrelated text topic.' });
  assert.equal((await finish(workspace, separate.workflow.id)).status, 'completed');
  assert.equal(calls, 3);
});

test('new image attachments are queued behind a running Grok instead of disappearing into text-only steering', async (t) => {
  const { controller, workspace, conversation, attachmentIds } = await fixture(t, ['grok']);
  enableGrokImages(t, controller);
  let calls = 0;
  let steered = 0;
  let release!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((done) => {
    markStarted = done;
  });
  t.mock.method(grokAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls++;
    if (calls === 1) {
      ctx.registerSteer?.(async () => {
        steered++;
      });
      markStarted();
      await new Promise<void>((done) => {
        release = done;
        ctx.signal.addEventListener('abort', () => done(), { once: true });
      });
    } else assertDelivered(ctx);
    return { output: 'Grok task complete.' };
  });
  const pinned = { ...base, provider: 'grok' as const, runtimeId: 'fixture-grok' };
  const first = await workspace.send(conversation.id, { ...pinned, content: 'Explain a text topic.' });
  await workspace.tickQueue();
  await started;
  const imageMessage = await workspace.send(conversation.id, { ...pinned, attachmentIds });
  assert.notEqual(imageMessage.workflow.id, first.workflow.id);
  assert.equal(imageMessage.message.steering, undefined);
  assert.equal(imageMessage.workflow.pendingSteer, undefined);
  assert.equal(calls, 1);
  assert.equal(steered, 0);
  release();
  assert.equal((await finish(workspace, first.workflow.id)).status, 'completed');
  assert.equal((await finish(workspace, imageMessage.workflow.id)).status, 'completed');
  assert.equal(calls, 2);
});

test('an unpinned mixed provider pool omits optional history pixels without forcing the next text route', async (t) => {
  const { controller, workspace, conversation, image, document, attachmentIds } = await fixture(t, ['codex', 'grok']);
  let codexCalls = 0,
    grokCalls = 0;
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    codexCalls++;
    assertDelivered(ctx);
    return { output: 'Initial explicitly supplied image received.' };
  });
  t.mock.method(grokAdapter, 'execute', async (ctx: ExecuteContext) => {
    grokCalls++;
    assert.equal(ctx.input.provider, undefined);
    assert.equal(ctx.input.runtimeId, undefined);
    assert.deepEqual(
      ctx.input.attachments?.map((file) => file.id),
      [document.id],
    );
    assert.ok(!ctx.input.attachments?.some((file) => file.kind === 'image'));
    assert.ok(!ctx.input.prompt.includes(png));
    assert.match(ctx.input.prompt, /此前图片 "screenshot\.png" 的像素未提供给本次执行器/);
    assert.match(ctx.input.prompt, /原件仍保留在对话历史附件中/);
    assert.match(ctx.input.prompt, /不要假装看过其图片内容/);
    return { output: 'Automatic text route used Grok without historical image pixels.' };
  });
  const first = await workspace.send(conversation.id, { ...base, provider: 'codex', attachmentIds });
  assert.equal((await finish(workspace, first.workflow.id)).status, 'completed');
  controller.settings.architectureProvider = 'grok';
  controller.settings.routineProvider = 'grok';
  controller.settings.designProvider = 'grok';
  const next = await workspace.send(conversation.id, {
    ...base,
    content: 'Explain this unrelated text topic.',
    schedule: { preferExpiringQuota: false },
  });
  const completed = await finish(workspace, next.workflow.id);
  assert.equal(completed.status, 'completed');
  assert.equal(controller.store.run(completed.runIds[0]!)?.route.runtimeId, 'fixture-grok');
  assert.equal(codexCalls, 1);
  assert.equal(grokCalls, 1);
  assert.equal(readFileSync(workspace.attachments.get(conversation.id, image.id).path).toString('base64'), png);
});

test('a quoted old image leaves a text-only executor preference with its original pixels intact', async (t) => {
  const { controller, workspace, conversation, image, attachmentIds } = await fixture(t, ['codex', 'grok']);
  let codexCalls = 0,
    grokCalls = 0;
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    codexCalls++;
    assert.ok(ctx.input.attachments?.some((file) => file.id === image.id && file.kind === 'image'));
    assert.equal(
      readFileSync(ctx.input.attachments!.find((file) => file.id === image.id)!.path).toString('base64'),
      png,
    );
    return { output: 'The original image reached the visual executor.' };
  });
  t.mock.method(grokAdapter, 'execute', async (ctx: ExecuteContext) => {
    grokCalls++;
    assert.ok(!ctx.input.attachments?.some((file) => file.kind === 'image'));
    assert.equal(ctx.route.runtimeId, 'fixture-grok');
    assert.equal(ctx.route.model, 'fixture-model');
    assert.equal(ctx.route.effort, 'low');
    return { output: 'The original fixed executor handled the next text request.' };
  });
  const first = await workspace.send(conversation.id, { ...base, provider: 'codex', attachmentIds });
  assert.equal((await finish(workspace, first.workflow.id)).status, 'completed');
  for (let index = 0; index < 30; index++)
    workspace.store.addMessage(conversation.id, 'user', `Unrelated history ${index}.`);
  const selected = {
    ...base,
    provider: 'grok' as const,
    runtimeId: 'fixture-grok',
    model: 'fixture-model',
    effort: 'low',
  };
  const next = await workspace.send(conversation.id, {
    ...selected,
    content: 'Continue checking the quoted message.',
    quotes: [{ messageId: first.message.id, text: first.message.content }],
  });
  const completed = await finish(workspace, next.workflow.id);
  assert.equal(completed.status, 'completed', completed.error ?? '');
  assert.equal(codexCalls, 2);
  assert.equal(grokCalls, 1);
  for (const key of ['provider', 'runtimeId', 'model', 'effort'] as const)
    assert.equal(completed.input[key], selected[key], `Visual failover must retain the original ${key} preference.`);
  const later = await workspace.send(conversation.id, { ...selected, content: 'Explain this unrelated text topic.' });
  const textDone = await finish(workspace, later.workflow.id);
  assert.equal(textDone.status, 'completed', textDone.error ?? '');
  assert.equal(controller.store.run(textDone.runIds[0]!)?.route.runtimeId, 'fixture-grok');
  assert.equal(codexCalls, 2);
  assert.equal(grokCalls, 2);
});

test('an explicit reference to the previous image reaches a text-only target through a description', async (t) => {
  const { controller, workspace, conversation, image, attachmentIds } = await fixture(t, ['codex', 'grok']);
  let calls = 0;
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls++;
    assert.ok(ctx.input.attachments?.some((file) => file.id === image.id && file.kind === 'image'));
    assert.equal(
      readFileSync(ctx.input.attachments!.find((file) => file.id === image.id)!.path).toString('base64'),
      png,
    );
    return { output: calls === 1 ? 'The same original image is available.' : visualFacts };
  });
  // The text-only target does not lose the image: it gets the describer's report instead of the pixels.
  t.mock.method(grokAdapter, 'execute', async (ctx: ExecuteContext) => {
    assertVisualReportDelivered(ctx);
    return { output: 'Grok answered from the description.' };
  });
  const first = await workspace.send(conversation.id, { ...base, provider: 'codex', attachmentIds });
  assert.equal((await finish(workspace, first.workflow.id)).status, 'completed');
  controller.settings.architectureProvider = 'grok';
  controller.settings.routineProvider = 'grok';
  controller.settings.designProvider = 'grok';
  const next = await workspace.send(conversation.id, {
    ...base,
    content: 'Describe the same image again.',
    schedule: { preferExpiringQuota: false },
  });
  const completed = await finish(workspace, next.workflow.id);
  assert.equal(completed.status, 'completed', completed.error ?? '');
  assert.equal(calls, 2);
});

test('an unavailable native image channel returns visual facts to the original fixed executor', async (t) => {
  const { controller, workspace, conversation, image, document, attachmentIds } = await fixture(t, ['grok', 'codex']);
  enableGrokImages(t, controller);
  const calls: string[] = [];
  t.mock.method(grokAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push('grok');
    if (calls.length === 1) {
      assertDelivered(ctx);
      throw new Error('runtime-image-input-unavailable');
    }
    assertVisualReportDelivered(ctx, document.id);
    assert.equal(ctx.route.model, 'fixture-model');
    assert.equal(ctx.route.effort, 'high');
    return { output: 'Original Grok completed after the visual handoff.' };
  });
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push('codex');
    assertVisualHelper(ctx, image.id);
    return { output: visualFacts };
  });
  const sent = await workspace.send(conversation.id, {
    ...base,
    provider: 'grok',
    runtimeId: 'fixture-grok',
    model: 'fixture-model',
    effort: 'high',
    attachmentIds,
  });
  const done = await finish(workspace, sent.workflow.id);
  assert.equal(done.status, 'completed', done.error ?? '');
  assert.deepEqual(calls, ['grok', 'codex', 'grok']);
  assert.equal(done.visualRunIds?.length, 1);
  assert.equal(controller.store.run(done.runIds[0]!)?.errorCode, 'runtime-image-input-unavailable');
});

test('a fixed multi-step workflow reads the image once and reuses facts on every original executor step', async (t) => {
  const { controller, workspace, conversation, image, document, attachmentIds } = await fixture(t, ['grok', 'codex']);
  const steps: WorkflowStep[] = [
    {
      id: 'inspect-image',
      title: 'Inspect image',
      instruction: 'Report the image contents.',
      kind: 'general',
      transport: 'auto',
      dependsOn: [],
      status: 'pending',
      runIds: [],
    },
    {
      id: 'compare-document',
      title: 'Compare document',
      instruction: 'Compare the prior image facts to the specification.',
      kind: 'routine',
      transport: 'auto',
      dependsOn: ['inspect-image'],
      status: 'pending',
      runIds: [],
    },
  ];
  let helpers = 0;
  const executed: string[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    helpers++;
    assertVisualHelper(ctx, image.id);
    return { output: visualFacts };
  });
  t.mock.method(grokAdapter, 'execute', async (ctx: ExecuteContext) => {
    assertVisualReportDelivered(ctx, document.id);
    assert.equal(ctx.input.permissionMode, 'workspace-write');
    assert.equal(ctx.route.model, 'fixture-model');
    assert.equal(ctx.route.effort, 'high');
    executed.push(ctx.input.stepId!);
    return {
      output: `Main step ${ctx.input.stepId} completed.\nCOMBORUNNER_TASK_RESULT: {"status":"completed","summary":"Current requested step complete."}`,
    };
  });
  const sent = await workspace.send(
    conversation.id,
    {
      ...base,
      mode: 'build',
      permissionMode: 'workspace-write',
      provider: 'grok',
      runtimeId: 'fixture-grok',
      model: 'fixture-model',
      effort: 'high',
      attachmentIds,
    },
    undefined,
    undefined,
    { resumePlan: steps },
  );
  const done = await finish(workspace, sent.workflow.id);
  assert.equal(done.status, 'completed', done.error ?? '');
  assert.equal(helpers, 1);
  assert.deepEqual(
    executed,
    steps.map((step) => step.id),
  );
  assert.equal(done.visualRunIds?.length, 1);
  assert.ok(done.plan.every((step) => step.status === 'completed'));
  const final = workspace.conversation(conversation.id).messages.find((item) => item.id === done.finalMessageId)!;
  assert.equal(final.content, 'Main step compare-document completed.');
  assert.ok(done.runIds.some((id) => controller.run(id)?.output === 'Main step inspect-image completed.'));
  assert.ok(!final.content.includes(visualFacts));
});

test('a visual helper content refusal neither caches a report nor rotates to another executor', async (t) => {
  const { controller, workspace, conversation, attachmentIds } = await fixture(t, ['grok', 'codex', 'claude']);
  let helpers = 0,
    mainCalls = 0,
    alternativeCalls = 0;
  t.mock.method(codexAdapter, 'execute', async () => {
    helpers++;
    return { output: 'I cannot help with this request because of our content policy.' };
  });
  t.mock.method(grokAdapter, 'execute', async () => {
    mainCalls++;
    return { output: 'The main executor must never run using a refusal as image facts.' };
  });
  t.mock.method(claudeAdapter, 'execute', async () => {
    alternativeCalls++;
    return { output: 'A content refusal must not rotate providers.' };
  });
  const sent = await workspace.send(conversation.id, {
    ...base,
    provider: 'grok',
    runtimeId: 'fixture-grok',
    attachmentIds,
  });
  const done = await finish(workspace, sent.workflow.id);
  assert.equal(done.status, 'blocked');
  assert.equal(helpers, 1);
  assert.equal(mainCalls, 0);
  assert.equal(alternativeCalls, 0);
  assert.equal(done.visualAnalysis, undefined);
  assert.equal(controller.usage.report().totals.runs, 1);
});

test('policy words quoted from screenshot text remain observations rather than a helper refusal', async (t) => {
  const { workspace, conversation, image, document, attachmentIds } = await fixture(t, ['grok', 'codex']);
  const observation = `${visualFacts}\n画面是一张错误提示截屏。可辨认文字：「I cannot assist because of privacy policy」；下方有一个重试按钮。`;
  let mainCalls = 0;
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    assertVisualHelper(ctx, image.id);
    return { output: observation };
  });
  t.mock.method(grokAdapter, 'execute', async (ctx: ExecuteContext) => {
    mainCalls++;
    assertVisualReportDelivered(ctx, document.id);
    assert.ok(ctx.input.prompt.includes(observation));
    return { output: 'The main executor can diagnose the screenshot containing policy text.' };
  });
  const sent = await workspace.send(conversation.id, {
    ...base,
    provider: 'grok',
    runtimeId: 'fixture-grok',
    attachmentIds,
  });
  const done = await finish(workspace, sent.workflow.id);
  assert.equal(done.status, 'completed', done.error ?? '');
  assert.equal(mainCalls, 1);
  assert.equal(done.visualAnalysis?.report, observation);
});

test('a native permission denial cannot become cached image facts or rotate to another helper', async (t) => {
  const { workspace, conversation, attachmentIds } = await fixture(t, ['grok', 'codex', 'claude']);
  let mainCalls = 0,
    alternateHelpers = 0;
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    ctx.emit({
      at: new Date().toISOString(),
      type: 'status',
      text: 'Cursor 操作被权限规则拒绝',
      data: { decision: 'deny', kind: 'read_image' },
    });
    return { output: visualFacts };
  });
  t.mock.method(grokAdapter, 'execute', async () => {
    mainCalls++;
    return { output: 'A denied operation must not supply observations.' };
  });
  t.mock.method(claudeAdapter, 'execute', async () => {
    alternateHelpers++;
    return { output: visualFacts };
  });
  const sent = await workspace.send(conversation.id, {
    ...base,
    provider: 'grok',
    runtimeId: 'fixture-grok',
    attachmentIds,
  });
  const done = await finish(workspace, sent.workflow.id);
  assert.equal(done.status, 'blocked');
  assert.equal(mainCalls, 0);
  assert.equal(alternateHelpers, 0);
  assert.equal(done.visualAnalysis, undefined);
});

test('a native image executor content refusal does not trigger a visual helper or another model', async (t) => {
  const { workspace, controller, conversation, attachmentIds } = await fixture(t, ['grok', 'codex', 'claude']);
  enableGrokImages(t, controller);
  let mainCalls = 0,
    helpers = 0;
  t.mock.method(grokAdapter, 'execute', async () => {
    mainCalls++;
    return { output: 'I cannot help with this request because of our content policy.' };
  });
  for (const adapter of [codexAdapter, claudeAdapter])
    t.mock.method(adapter, 'execute', async () => {
      helpers++;
      return { output: visualFacts };
    });
  const sent = await workspace.send(conversation.id, {
    ...base,
    provider: 'grok',
    runtimeId: 'fixture-grok',
    attachmentIds,
  });
  const done = await finish(workspace, sent.workflow.id);
  assert.equal(mainCalls, 1);
  assert.equal(helpers, 0);
  assert.equal(done.visualAnalysis, undefined);
  assert.match(
    workspace.conversation(conversation.id).messages.find((item) => item.id === done.finalMessageId)?.content ??
      done.error ??
      '',
    /content policy/,
  );
});

test('a technically unavailable visual helper yields to the next working image channel and then restores Grok', async (t) => {
  const { workspace, conversation, image, document, attachmentIds } = await fixture(t, ['grok', 'codex', 'claude']);
  const calls: string[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push('codex');
    assertVisualHelper(ctx, image.id);
    throw new Error('runtime-image-input-unavailable');
  });
  t.mock.method(claudeAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push('claude');
    assertVisualHelper(ctx, image.id);
    return { output: visualFacts };
  });
  t.mock.method(grokAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push('grok');
    assertVisualReportDelivered(ctx, document.id);
    return { output: 'Grok finished after the working visual channel reported facts.' };
  });
  const sent = await workspace.send(conversation.id, {
    ...base,
    provider: 'grok',
    runtimeId: 'fixture-grok',
    attachmentIds,
  });
  const done = await finish(workspace, sent.workflow.id);
  assert.equal(done.status, 'completed', done.error ?? '');
  assert.deepEqual(calls, ['codex', 'claude', 'grok']);
  assert.equal(done.visualRunIds?.length, 2);
});

test('cancelling a helper preserves the provider-only main preference when the task is continued', async (t) => {
  const { workspace, conversation, image, document, attachmentIds } = await fixture(t, ['grok', 'codex']);
  let started!: () => void;
  const helperStarted = new Promise<void>((resolveStarted) => {
    started = resolveStarted;
  });
  let mainCalls = 0,
    helperCalls = 0;
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    helperCalls++;
    assertVisualHelper(ctx, image.id);
    if (helperCalls > 1) return { output: visualFacts };
    started();
    await new Promise<void>((_, reject) => {
      const cancel = () => reject(new Error('operation-cancelled'));
      if (ctx.signal.aborted) cancel();
      else ctx.signal.addEventListener('abort', cancel, { once: true });
    });
    return { output: visualFacts };
  });
  t.mock.method(grokAdapter, 'execute', async (ctx: ExecuteContext) => {
    mainCalls++;
    assertVisualReportDelivered(ctx, document.id);
    return { output: 'The resumed task finished on its original fixed provider.' };
  });
  const sent = await workspace.send(conversation.id, {
    ...base,
    provider: 'grok',
    attachmentIds,
  });
  await workspace.tickQueue();
  await helperStarted;
  workspace.cancel(sent.workflow.id);
  const done = await finish(workspace, sent.workflow.id);
  assert.equal(done.status, 'cancelled');
  assert.equal(mainCalls, 0);
  assert.equal(done.visualAnalysis, undefined);
  const resumed = await workspace.continue(done.id);
  assert.equal(resumed.workflow.input.provider, 'grok');
  assert.equal(resumed.workflow.input.runtimeId, undefined, 'A helper must not become the persisted main executor.');
  const resumedDone = await finish(workspace, resumed.workflow.id);
  assert.equal(resumedDone.status, 'completed', resumedDone.error ?? '');
  assert.equal(helperCalls, 2);
  assert.equal(mainCalls, 1);
});

test('switching to automatic during image assistance completes the helper and resumes with automatic selection', async (t) => {
  const { workspace, controller, conversation, image, document, attachmentIds } = await fixture(t, ['grok', 'codex']);
  let started!: () => void, release!: () => void;
  const helperStarted = new Promise<void>((resolveStarted) => {
    started = resolveStarted;
  });
  const helperReleased = new Promise<void>((resolveReleased) => {
    release = resolveReleased;
  });
  let helperCalls = 0,
    mainCalls = 0;
  const completeAutomaticMain = async (ctx: ExecuteContext) => {
    mainCalls++;
    assertVisualReportDelivered(ctx, document.id);
    for (const key of ['runtimeId', 'provider', 'model', 'effort'] as const)
      assert.equal(ctx.input[key], undefined, `${key} must remain automatic after the explicit selection change.`);
    return { output: 'Automatic main executor finished with the visual facts.' };
  };
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    if (ctx.input.visualAssistant) {
      helperCalls++;
      assertVisualHelper(ctx, image.id);
      started();
      await Promise.race([
        helperReleased,
        new Promise<never>((_, reject) =>
          ctx.signal.addEventListener('abort', () => reject(new Error('operation-cancelled')), { once: true }),
        ),
      ]);
      assert.equal(ctx.signal.aborted, false);
      return { output: visualFacts };
    }
    return completeAutomaticMain(ctx);
  });
  t.mock.method(grokAdapter, 'execute', completeAutomaticMain);
  const sent = await workspace.send(conversation.id, {
    ...base,
    provider: 'grok',
    runtimeId: 'fixture-grok',
    model: 'fixture-model',
    effort: 'high',
    attachmentIds,
  });
  await workspace.tickQueue();
  await helperStarted;
  assert.equal(controller.active.get(controller.activeRunFor(sent.workflow.id)!)?.run.visualAssistant, true);
  workspace.selectExecutor(conversation.id, {});
  release();
  const done = await finish(workspace, sent.workflow.id);
  assert.equal(done.status, 'completed', done.error ?? '');
  assert.equal(helperCalls, 1);
  assert.equal(mainCalls, 1);
  assert.equal(done.replyRouting, 'auto');
});

test('a temporarily busy visual executor waits for capacity without losing the fixed main task', async (t) => {
  const { workspace, controller, project, conversation, image, document, attachmentIds } = await fixture(t, [
    'grok',
    'codex',
  ]);
  controller.settings.maxRunsPerAccount = 1;
  let started!: () => void, release!: () => void;
  const busyStarted = new Promise<void>((resolveStarted) => {
    started = resolveStarted;
  });
  const busyReleased = new Promise<void>((resolveReleased) => {
    release = resolveReleased;
  });
  let helpers = 0,
    mainCalls = 0;
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    if (!ctx.input.visualAssistant) {
      assert.equal(ctx.input.prompt, 'SYNTHETIC_BUSY_TASK');
      started();
      await Promise.race([
        busyReleased,
        new Promise<never>((_, reject) =>
          ctx.signal.addEventListener('abort', () => reject(new Error('operation-cancelled')), { once: true }),
        ),
      ]);
      return { output: 'Unrelated synthetic work finished.' };
    }
    helpers++;
    assertVisualHelper(ctx, image.id);
    return { output: visualFacts };
  });
  t.mock.method(grokAdapter, 'execute', async (ctx: ExecuteContext) => {
    mainCalls++;
    assertVisualReportDelivered(ctx, document.id);
    return { output: 'The fixed task completed after capacity returned.' };
  });
  await controller.start({
    prompt: 'SYNTHETIC_BUSY_TASK',
    projectPath: project.path,
    kind: 'general',
    runtimeId: 'fixture-codex',
    permissionMode: 'read-only',
  });
  await busyStarted;
  const sent = await workspace.send(conversation.id, {
    ...base,
    provider: 'grok',
    runtimeId: 'fixture-grok',
    attachmentIds,
  });
  await workspace.tickQueue();
  for (let index = 0; index < 100; index++) {
    if (workspace.store.get<Workflow>('workflow', sent.workflow.id)?.status === 'waiting-resource') break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  const waiting = workspace.store.get<Workflow>('workflow', sent.workflow.id)!;
  assert.equal(waiting.status, 'waiting-resource', waiting.error ?? 'Temporary capacity must wait instead of failing.');
  assert.equal(waiting.visualRunIds?.length ?? 0, 0);
  assert.equal(helpers, 0);
  assert.equal(mainCalls, 0);
  release();
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  const done = await finish(workspace, sent.workflow.id);
  assert.equal(done.status, 'completed', done.error ?? '');
  assert.equal(helpers, 1);
  assert.equal(mainCalls, 1);
  assert.equal(done.visualRunIds?.length, 1);
});

test('the next executor receives the imported Cursor transcript as file context', async (t) => {
  const { workspace, project, directory } = await fixture(t);
  const cursorRoot = join(directory, 'synthetic-cursor');
  cursorFixture(cursorRoot, directory);
  const imported = await workspace.importCursorChat(project.id, 'chat', cursorRoot);
  let calls = 0;
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls++;
    assert.equal(ctx.input.attachments?.length, 1);
    const file = ctx.input.attachments![0]!;
    assert.equal(file.name, 'Design notes.md');
    assert.match(file.text!, /Imported from Cursor/);
    assert.match(ctx.input.prompt, /Explain the synthetic design/);
    assert.match(readFileSync(file.path, 'utf8'), /### Cursor/);
    return { output: 'Imported transcript received.' };
  });
  const sent = await workspace.send(imported.id, { ...base, content: 'Continue from the imported design.' });
  assert.equal((await finish(workspace, sent.workflow.id)).status, 'completed');
  assert.equal(calls, 1);
});

test('only the step that looks at the picture needs image input, and a step that prefers API cards falls back', async (t) => {
  const { controller, workspace, conversation, image, document, attachmentIds } = await fixture(t);
  const steps: WorkflowStep[] = [
    {
      id: 'inspect',
      title: 'Identify the screenshot',
      instruction: 'Describe the feature shown.',
      kind: 'routine',
      transport: 'auto',
      dependsOn: [],
      status: 'pending',
      runIds: [],
    },
    {
      id: 'inventory',
      title: 'List the executors',
      instruction: 'Count the configured executors and routing profiles.',
      kind: 'general',
      transport: 'api',
      dependsOn: ['inspect'],
      status: 'pending',
      runIds: [],
    },
  ];
  const seen: Record<string, ExecuteContext> = {};
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    seen[ctx.input.stepId!] = ctx;
    return {
      output: `Step ${ctx.input.stepId} done.\nCOMBORUNNER_TASK_RESULT: {"status":"completed","summary":"Step complete."}`,
    };
  });
  const sent = await workspace.send(conversation.id, { ...base, mode: 'build', attachmentIds }, undefined, undefined, {
    resumePlan: steps,
  });
  const done = await finish(workspace, sent.workflow.id);
  assert.equal(done.status, 'completed', done.error ?? '');
  assert.ok(seen.inspect?.input.attachments?.some((file) => file.id === image.id && file.kind === 'image'));
  const later = seen.inventory!;
  assert.ok(!later.input.attachments?.some((file) => file.kind === 'image'));
  assert.ok(later.input.attachments?.some((file) => file.id === document.id));
  assert.match(later.input.prompt, /图片 "screenshot.png" 的像素没有发给这一步/);
  const run = done.runIds.map((id) => controller.run(id)).find((value) => value?.stepId === 'inventory')!;
  assert.match(run.route.reasons[0]!, /这一步首选API 卡，但API 卡都不能接，改用 Fixture codex/);
});

function preferGrok(controller: Controller) {
  controller.settings.architectureProvider = 'grok';
  controller.settings.routineProvider = 'grok';
  controller.settings.designProvider = 'grok';
}

test('an automatic route to an executor that cannot see images gets a description from one that can', async (t) => {
  const { controller, workspace, conversation, image, document, attachmentIds } = await fixture(t, ['grok', 'codex']);
  preferGrok(controller);
  let helperPrompt = '';
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    assertVisualHelper(ctx, image.id);
    helperPrompt = ctx.input.prompt;
    return { output: visualFacts };
  });
  let main: ExecuteContext | undefined;
  t.mock.method(grokAdapter, 'execute', async (ctx: ExecuteContext) => {
    main = ctx;
    assertVisualReportDelivered(ctx, document.id);
    return { output: 'Grok answered from the description.' };
  });
  const quote = { text: '1 圆圈 左上：这个按钮为什么是灰的\n2 箭头 中央：这里', messageId: undefined };
  const sent = await workspace.send(conversation.id, {
    ...base,
    attachmentIds,
    quotes: [quote],
    schedule: { preferExpiringQuota: false },
  });
  const done = await finish(workspace, sent.workflow.id);
  assert.equal(done.status, 'completed', done.error ?? '');
  assert.equal(done.visualRunIds?.length, 1);
  assert.match(helperPrompt, /逐个编号说明这个标记圈住或指向的是什么/);
  assert.match(helperPrompt, /1 圆圈 左上：这个按钮为什么是灰的/);
  assert.match(helperPrompt, /图中文字：可辨认的文字按原样抄出/);
  assert.equal(main?.input.visualContext?.by, 'Fixture codex');
  const run = done.runIds.map((id) => controller.run(id)).find((value) => value && !value.visualAssistant)!;
  assert.equal(run.route.runtimeId, 'fixture-grok');
  assert.equal(run.route.reasons[0], 'Fixture grok 不能看图，先由 Fixture codex 转述');
});

test('an automatic route that can see images gets the pixels and no description', async (t) => {
  const { workspace, conversation, attachmentIds } = await fixture(t, ['grok', 'codex']);
  let calls = 0;
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls++;
    assert.notEqual(ctx.input.visualAssistant, true);
    assertDelivered(ctx);
    return { output: 'Codex saw the picture.' };
  });
  t.mock.method(grokAdapter, 'execute', async () => {
    throw new Error('Grok must not run when the automatic target reads images.');
  });
  const sent = await workspace.send(conversation.id, { ...base, attachmentIds });
  const done = await finish(workspace, sent.workflow.id);
  assert.equal(done.status, 'completed', done.error ?? '');
  assert.equal(calls, 1);
  assert.equal(done.visualRunIds, undefined);
});

test('a multi-step task describes its picture once and every later step reuses it', async (t) => {
  const { controller, workspace, conversation, image, attachmentIds } = await fixture(t, ['grok', 'codex']);
  preferGrok(controller);
  const step = (id: string, title: string, dependsOn: string[]): WorkflowStep => ({
    id,
    title,
    instruction: title,
    kind: 'routine',
    transport: 'auto',
    dependsOn,
    status: 'pending',
    runIds: [],
  });
  const steps = [
    step('inspect', 'Read the screenshot', []),
    step('compare', 'Compare the screenshot with the notes', ['inspect']),
    step('answer', 'Write the answer', ['compare']),
  ];
  let helpers = 0;
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    helpers++;
    assertVisualHelper(ctx, image.id);
    return { output: visualFacts };
  });
  const prompts: Record<string, string> = {};
  t.mock.method(grokAdapter, 'execute', async (ctx: ExecuteContext) => {
    assert.ok(!ctx.input.attachments?.some((file) => file.kind === 'image'));
    prompts[ctx.input.stepId!] = ctx.input.prompt;
    return {
      output: `Step ${ctx.input.stepId} done.\nCOMBORUNNER_TASK_RESULT: {"status":"completed","summary":"Step complete."}`,
    };
  });
  const sent = await workspace.send(
    conversation.id,
    { ...base, mode: 'build', attachmentIds, schedule: { preferExpiringQuota: false } },
    undefined,
    undefined,
    { resumePlan: steps },
  );
  const done = await finish(workspace, sent.workflow.id);
  assert.equal(done.status, 'completed', done.error ?? '');
  assert.equal(helpers, 1);
  for (const id of ['inspect', 'compare', 'answer']) assert.ok(prompts[id]?.includes(visualFacts), id);
  assert.match(prompts.answer!, /这些图片已由 Fixture codex 转述/);
});

test('a request changed while its picture is described gets a fresh description', async (t) => {
  const { controller, workspace, conversation, image, document, attachmentIds } = await fixture(t, ['grok', 'codex']);
  preferGrok(controller);
  const prompts: string[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    assertVisualHelper(ctx, image.id);
    prompts.push(ctx.input.prompt);
    if (prompts.length === 1) {
      const active = (workspace as unknown as { active: Map<string, { workflow: Workflow }> }).active;
      const running = [...active.values()][0]!.workflow;
      running.input = { ...running.input, content: 'Only explain the red button.' };
      return { output: 'STALE_FACTS_FIXTURE' };
    }
    return { output: visualFacts };
  });
  t.mock.method(grokAdapter, 'execute', async (ctx: ExecuteContext) => {
    assertVisualReportDelivered(ctx, document.id);
    assert.ok(!ctx.input.prompt.includes('STALE_FACTS_FIXTURE'));
    assert.match(ctx.input.prompt, /用户当前最新需求[\s\S]*Only explain the red button\./);
    return { output: 'Grok answered the latest request.' };
  });
  const sent = await workspace.send(conversation.id, {
    ...base,
    attachmentIds,
    schedule: { preferExpiringQuota: false },
  });
  const done = await finish(workspace, sent.workflow.id);
  assert.equal(done.status, 'completed', done.error ?? '');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, /用户当前需求（[^）]*）：\nOnly explain the red button\./);
});

test('a describer that fails for a non-technical reason is not replaced; the task reads the pixels itself', async (t) => {
  const { controller, workspace, conversation, attachmentIds } = await fixture(t, ['grok', 'codex', 'claude']);
  preferGrok(controller);
  let describers = 0;
  let main: ExecuteContext | undefined;
  for (const adapter of [codexAdapter, claudeAdapter])
    t.mock.method(adapter, 'execute', async (ctx: ExecuteContext) => {
      if (ctx.input.visualAssistant) {
        describers++;
        throw new Error('runtime-permission-or-sandbox-error');
      }
      main = ctx;
      return { output: 'Answered with the pixels.' };
    });
  t.mock.method(grokAdapter, 'execute', async () =>
    assert.fail('A text-only target must not run without a description.'),
  );
  const sent = await workspace.send(conversation.id, {
    ...base,
    attachmentIds,
    schedule: { preferExpiringQuota: false },
  });
  const done = await finish(workspace, sent.workflow.id);
  assert.equal(done.status, 'completed', done.error ?? '');
  assert.equal(describers, 1);
  assert.ok(main?.input.attachments?.some((file) => file.kind === 'image'));
});
