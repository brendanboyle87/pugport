import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { claudeAdapter } from '../src/server/adapters/claude.ts';
import { grokAdapter } from '../src/server/adapters/grok.ts';
import { markupCrops } from '../src/server/markup-crops.ts';
import type { ExecuteContext, MessageInput, RuntimeSnapshot, Workflow } from '../src/shared/types.ts';
import type { MessageMarkup } from '../src/shared/markup.ts';

const base: MessageInput = {
  content: '按标注修改',
  mode: 'chat',
  permissionMode: 'read-only',
  executionPolicy: 'cli-first',
  autoEscalate: true,
};
const snapshot: RuntimeSnapshot = {
  id: 'fixture-codex',
  provider: 'codex',
  label: 'Fixture',
  environment: 'native',
  installed: true,
  status: 'ready',
  models: [{ id: 'fixture-model', label: 'Fixture model', efforts: ['low', 'medium', 'high'] }],
  quota: {
    status: 'known',
    source: 'Fixture',
    observedAt: new Date().toISOString(),
    windows: [{ id: 'week', label: 'week', usedPercent: 10, resetsAt: new Date(Date.now() + 3600000).toISOString() }],
  },
  accounting: { mode: 'subscription', source: 'Fixture' },
  capabilities: { execute: true, resume: true, cancel: true, approvals: true },
  refreshedAt: new Date().toISOString(),
};
const markup = (): MessageMarkup => ({
  version: 1,
  source: { kind: 'image', name: 'photo.jpg', width: 1920, height: 1080 },
  attachment: 'photo-标注.png',
  marks: [
    {
      n: 1,
      kind: 'ellipse',
      color: '#e5322d',
      box: { x0: 0.2802, y0: 0.2102, x1: 0.4099, y1: 0.3796 },
      note: '把这个按钮改成蓝色',
    },
    {
      n: 2,
      kind: 'arrow',
      color: '#3b82f6',
      box: { x0: 0.05, y0: 0.65, x1: 0.21, y1: 0.83 },
      line: { from: { x: 0.05, y: 0.83 }, to: { x: 0.21, y: 0.65 } },
    },
  ],
  crops: [{ n: 1, attachmentId: 'forged', name: 'forged.jpg' }],
});
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'pugport-markup-workflow-'));
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
  controller.targets = [
    {
      id: snapshot.id,
      provider: 'codex',
      label: 'Fixture',
      command: 'never-spawned',
      environment: 'native',
      enabled: true,
    },
  ];
  controller.snapshots = [snapshot];
  for (const adapter of [codexAdapter, claudeAdapter, grokAdapter]) {
    t.mock.method(adapter, 'discover', async () => snapshot);
    t.mock.method(adapter, 'execute', async () => {
      throw Error('Unexpected fixture execution');
    });
  }
  const workspace = new Workspace(controller, { autoTick: false, retryMs: 20 });
  const project = await workspace.createProject(directory),
    conversation = workspace.createConversation(project.id);
  t.after(async () => {
    await workspace.close();
    await controller.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  });
  const buffer = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#e5eef8' } })
    .png()
    .toBuffer();
  const image = await workspace.attachments.saveStream(
    conversation.id,
    { name: 'photo-标注.png', mimeType: 'image/png' },
    Readable.from([buffer]),
  );
  return { workspace, conversation, image, buffer };
}
async function finish(workspace: Workspace, id: string) {
  await workspace.tickQueue();
  for (let i = 0; i < 400; i++) {
    const value = workspace.store.get<Workflow>('workflow', id)!;
    if (['completed', 'failed', 'blocked', 'cancelled', 'waiting-confirmation'].includes(value.status)) return value;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw Error('Markup fixture did not settle');
}
test('send stores canonical markup and delivers annotated PNG plus JPEG crops to the real executor input', async (t) => {
  const { workspace, conversation, image } = await fixture(t);
  const delivered: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    delivered.push(ctx);
    return { output: 'Synthetic result', nativeSessionId: 'fixture-session' };
  });
  const sent = await workspace.send(conversation.id, {
    ...base,
    attachmentIds: [image.id],
    quotes: [{ text: 'client text', note: 'client note', markup: markup() }],
  });
  assert.equal((await finish(workspace, sent.workflow.id)).status, 'completed');
  const ctx = delivered[0]!;
  assert.ok(ctx);
  assert.match(ctx.input.prompt, /\[引用 1\]/);
  assert.match(ctx.input.prompt, /标记 1（圆圈，红色）圈的是图中 \(0.28, 0.21\)–\(0.41, 0.38\)/);
  assert.match(ctx.input.prompt, /对引用 1 的要求：标记 1：把这个按钮改成蓝色/);
  assert.match(ctx.input.prompt, /标记 2（箭头，蓝色）从 \(0.05, 0.83\) 指向 \(0.21, 0.65\)/);
  assert.doesNotMatch(ctx.input.prompt, /client text|client note|forged/);
  assert.deepEqual(
    ctx.input.attachments?.map((file) => file.kind),
    ['image', 'image', 'image'],
  );
  assert.deepEqual(
    ctx.input.attachments?.map((file) => file.name),
    ['photo-标注.png', 'photo-标注-1.jpg', 'photo-标注-2.jpg'],
  );
  const dimensions = await sharp(ctx.input.attachments![1]!.path).metadata();
  assert.equal(dimensions.format, 'jpeg');
  assert.equal(dimensions.width, 349);
  assert.equal(dimensions.height, 283);
  for (const crop of ctx.input.attachments!.slice(1)) {
    const meta = await sharp(crop.path).metadata();
    assert.ok(meta.width! <= 1024 && meta.height! <= 1024);
    assert.ok(ctx.input.prompt.includes(JSON.stringify(crop.name)));
  }
  const stored = workspace.conversation(conversation.id).messages.find((m) => m.id === sent.message.id)!;
  assert.equal(stored.attachments!.length, 1);
  assert.equal(stored.quotes![0]!.markup!.crops!.length, 2);
  for (const crop of stored.quotes![0]!.markup!.crops!) {
    assert.notEqual(crop.attachmentId, 'forged');
    const row = workspace.store.get<{ fileName: string }>('attachment', crop.attachmentId)!;
    assert.ok(workspace.attachments.cleanupFiles(conversation.id).includes(row.fileName));
  }
  const missing = await workspace.send(conversation.id, {
    ...base,
    attachmentIds: [image.id],
    quotes: [{ text: 'client text', markup: { ...markup(), attachment: 'missing.png' } }],
  });
  assert.deepEqual(missing.message.quotes![0]!.markup!.crops, []);
  assert.doesNotMatch(missing.message.quotes![0]!.text, /局部放大图/);
  // A device run only receives attachmentIds: no crops are made, forged ones are dropped, the text names none.
  const files = workspace.attachments.cleanupFiles(conversation.id).length;
  const device = await workspace.send(conversation.id, {
    ...base,
    deviceId: randomUUID(),
    attachmentIds: [image.id],
    quotes: [
      { text: 'client text', markup: { ...markup(), crops: [{ n: 1, attachmentId: 'forged', name: 'x.jpg' }] } },
    ],
  });
  assert.deepEqual(device.message.quotes![0]!.markup!.crops, []);
  assert.match(device.message.quotes![0]!.text, /^图片标注：/);
  assert.doesNotMatch(device.message.quotes![0]!.text, /局部放大图/);
  assert.equal(workspace.attachments.cleanupFiles(conversation.id).length, files);
});
test('12 crops share the message budget; duplicates and invalid sources retain text without forged crops', async (t) => {
  const { workspace, conversation, image, buffer } = await fixture(t);
  const ten = { ...markup(), marks: Array.from({ length: 10 }, (_, i) => ({ ...markup().marks[0]!, n: i + 1 })) };
  const started = performance.now();
  const quotes = await markupCrops(
    workspace.attachments,
    conversation.id,
    Array.from({ length: 3 }, () => ({ text: '', markup: ten })),
    [image.id],
  );
  const elapsed = performance.now() - started;
  t.diagnostic(`12 crops: ${elapsed.toFixed(1)} ms (1920x1080 PNG, JPEG quality 85)`);
  assert.equal(
    quotes.reduce((count, q) => count + q.markup!.crops!.length, 0),
    12,
  );
  const duplicate = await workspace.attachments.saveStream(
    conversation.id,
    { name: image.name, mimeType: 'image/png' },
    Readable.from([buffer]),
  );
  const skip = await markupCrops(
    workspace.attachments,
    conversation.id,
    [{ text: '', markup: markup() }],
    [image.id, duplicate.id],
  );
  assert.deepEqual(skip[0]!.markup!.crops, []);
  const bad = await markupCrops(workspace.attachments, conversation.id, [{ text: '', markup: markup() }], ['missing']);
  assert.deepEqual(bad[0]!.markup!.crops, []);
});
