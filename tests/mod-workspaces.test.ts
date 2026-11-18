import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { ConversationActions } from '../src/server/conversation-actions.ts';
import { modSpec } from '../src/server/mod-workspaces.ts';
import { packModDirectory } from '../src/server/mod-pack.ts';
import type { Conversation, ExecuteContext, MessageInput } from '../src/shared/types.ts';
import { runNetworkAllowed } from '../src/shared/permission-reason.ts';
import { fixture, finished, input, result } from './helpers/session-workspace.ts';

function setup(t: Parameters<typeof fixture>[0]) {
  const f = fixture(t, false);
  f.controller.targets = f.controller.targets.slice(0, 1);
  f.controller.snapshots = f.controller.snapshots.slice(0, 1);
  return { ...f, actions: new ConversationActions(f.workspace) };
}

test('the first use creates a seeded folder under <dataDir>/mods-workspace and records it on the chat', async (t) => {
  const f = setup(t);
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  f.actions.setWorkMode(conversation.id, 'mods-author');
  const record = f.workspace.modWorkspaces.ensure(conversation.id);
  assert.match(record.id, /^[0-9a-f]{10}$/);
  assert.equal(record.path, join(f.controller.dataDir, 'mods-workspace', record.id));
  assert.equal(record.conversationId, conversation.id);
  assert.equal(f.workspace.store.get<Conversation>('conversation', conversation.id)!.modWorkspaceId, record.id);
  assert.equal(f.workspace.modWorkspaces.ensure(conversation.id).id, record.id, 'one folder per chat');
  const spec = readFileSync(join(record.path, '.pugport', 'MOD-SPEC.md'), 'utf8');
  assert.match(spec, /^## 1\. What a Mod is/m);
  assert.match(spec, /^## 9\. Isolation/m);
  assert.doesNotMatch(spec, /^## 7\./m);
  for (const file of ['pugport-mod.d.ts', 'example/manifest.json', 'example/ui/main.js', 'workspace.json'])
    assert.ok(existsSync(join(record.path, '.pugport', file)), file);
  assert.ok(existsSync(join(record.path, 'ui')));
  assert.equal(existsSync(join(record.path, 'manifest.json')), false, 'the author writes the Mod, not the host');
});

test('a chosen folder may not sit in a project or in PugPort data outside mods-workspace', async (t) => {
  const f = setup(t);
  const folder = join(f.directory, 'project');
  mkdirSync(folder);
  await f.workspace.createProject(folder);
  const workspaces = f.workspace.modWorkspaces;
  assert.throws(() => workspaces.checkPath(join(folder, 'my-mod')), /已添加的项目/);
  assert.throws(() => workspaces.checkPath(join(f.controller.dataDir, 'workspaces', 'x')), /数据文件夹/);
  assert.throws(() => workspaces.checkPath('relative/mod'), /绝对路径/);
  assert.equal(
    workspaces.checkPath(join(f.controller.dataDir, 'mods-workspace', 'mine')),
    join(f.controller.dataDir, 'mods-workspace', 'mine'),
  );
  assert.equal(workspaces.checkPath(join(f.directory, 'elsewhere')), join(f.directory, 'elsewhere'));
});

test('modSpec keeps sections 1–6 and 9 only', () => {
  const markdown = ['# Mods', ...[1, 2, 6, 7, 8, 9, 10].map((n) => `## ${n}. Part ${n}\nbody ${n}`)].join('\n');
  const spec = modSpec(markdown);
  for (const n of [1, 2, 6, 9]) assert.match(spec, new RegExp(`## ${n}\\. Part ${n}\\nbody ${n}`));
  for (const n of [7, 8, 10]) assert.doesNotMatch(spec, new RegExp(`## ${n}\\.`));
});

for (const scope of ['project', 'chats'] as const)
  test(`a ${scope} Mods author turn runs in the Mod folder with write access to it`, async (t) => {
    const f = setup(t);
    const calls: ExecuteContext[] = [];
    t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
      calls.push(ctx);
      return result('completed', 'Synthetic reply.');
    });
    const conversation =
      scope === 'project'
        ? f.workspace.createConversation((await f.workspace.createProject(f.directory)).id)
        : await f.workspace.createGeneralConversation('Pomodoro');
    f.actions.setWorkMode(conversation.id, 'mods-author');
    // A chat message would be read-only in Normal; the mode grants writing in its own folder only.
    const sent = await f.workspace.send(conversation.id, {
      ...input,
      mode: 'build',
      permissionMode: 'workspace-write',
      runtimeId: 'mock',
    });
    const flow = await finished(f.workspace, sent.workflow.id);
    assert.equal(flow.status, 'completed', flow.error ?? 'Synthetic workflow should complete');
    const record = f.workspace.modWorkspaces.forConversation(conversation.id)!;
    assert.ok(record, 'the folder is created by the first message');
    const run = calls.at(-1)!;
    assert.equal(run.input.projectPath, record.path);
    assert.equal(run.input.permissionMode, 'workspace-write');
    assert.deepEqual(flow.input.permissionOrigin, { mode: 'workspace-write', source: 'mode' });
    assert.ok(run.input.prompt.includes(`在项目 ${record.path} 中完成当前步骤`));
    // Identity stays: the chat keeps its project; only the execution root moved.
    assert.equal(
      f.workspace.store.get<Conversation>('conversation', conversation.id)!.projectId,
      conversation.projectId,
    );
  });

for (const [name, extra] of [
  ['user selection', { permissionMode: 'read-only' }],
  ['Chinese stop', { content: '只读，不要改任何文件。' }],
  ['English stop', { content: 'Read only. Do not modify any files.' }],
  ['role', { agentPresetId: 'investigation' }],
  ['parent', { permissionMode: 'read-only', permissionOrigin: { mode: 'read-only', source: 'parent' } }],
] satisfies [string, Partial<MessageInput>][]) {
  test(`Mods author preserves ${name} read-only through Continue`, async (t) => {
    const f = setup(t);
    const calls: ExecuteContext[] = [];
    t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
      calls.push(ctx);
      return result('blocked', 'Synthetic pause.');
    });
    const conversation = f.workspace.createConversation((await f.workspace.createProject(f.directory)).id);
    f.actions.setWorkMode(conversation.id, 'mods-author');
    const sent = await f.workspace.send(conversation.id, { ...input, mode: 'chat', runtimeId: 'mock', ...extra });
    const first = await finished(f.workspace, sent.workflow.id);
    assert.equal(first.input.permissionMode, 'read-only');
    const next = await f.workspace.continue(first.id);
    const continued = await finished(f.workspace, next.workflow.id);
    assert.equal(continued.input.workMode, 'mods-author');
    assert.equal(continued.input.permissionMode, 'read-only');
    assert.ok(calls.length >= 2);
    for (const call of calls) {
      assert.equal(call.input.permissionMode, 'read-only');
      assert.equal(runNetworkAllowed(call.input), false);
    }
  });
}

test('stopping an active Mods author revokes writing and Continue cannot restore it', async (t) => {
  const f = setup(t);
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    if (calls.length === 1) {
      began();
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) resolve();
        else ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    }
    return result('blocked', 'Synthetic pause.');
  });
  const conversation = f.workspace.createConversation((await f.workspace.createProject(f.directory)).id);
  f.actions.setWorkMode(conversation.id, 'mods-author');
  const sent = await f.workspace.send(conversation.id, {
    ...input,
    mode: 'chat',
    runtimeId: 'mock',
    explicitWrite: true,
  });
  await started;
  assert.equal(calls[0]!.input.permissionMode, 'workspace-write');
  const stop = await f.workspace.send(conversation.id, { ...input, content: '停止', mode: 'chat', runtimeId: 'mock' });
  const stopped = await finished(f.workspace, sent.workflow.id);
  await finished(f.workspace, stop.workflow.id);
  assert.equal(stopped.input.permissionMode, 'read-only');
  assert.equal(stopped.input.permissionReauthorized, false);
  const next = await f.workspace.continue(stopped.id);
  const resumed = await finished(f.workspace, next.workflow.id);
  assert.equal(resumed.input.workMode, 'mods-author');
  assert.equal(resumed.input.permissionMode, 'read-only');
  for (const call of calls.slice(1)) assert.equal(call.input.permissionMode, 'read-only');
});

test('a successor keeps the previous mode when its incoming input omits it', async (t) => {
  const f = setup(t);
  t.mock.method(codexAdapter, 'execute', async () => result('blocked', 'Synthetic pause.'));
  const conversation = f.workspace.createConversation((await f.workspace.createProject(f.directory)).id);
  f.actions.setWorkMode(conversation.id, 'mods-author');
  const sent = await f.workspace.send(conversation.id, { ...input, runtimeId: 'mock', mode: 'chat' });
  await finished(f.workspace, sent.workflow.id);
  f.actions.setWorkMode(conversation.id, 'navigator');
  const successor = await f.workspace.send(
    conversation.id,
    { ...input, runtimeId: 'mock', mode: 'chat' },
    sent.workflow.id,
  );
  assert.equal(successor.workflow.input.workMode, 'mods-author');
  await finished(f.workspace, successor.workflow.id);
});

test('Change… takes an empty folder or an author layout, keeps the same folder, and refuses anything else', async (t) => {
  const f = setup(t);
  const conversation = await f.workspace.createGeneralConversation('Owner mod');
  f.actions.setWorkMode(conversation.id, 'mods-author');
  const workspaces = f.workspace.modWorkspaces;
  const empty = join(f.directory, 'empty-mod');
  mkdirSync(empty);
  const first = workspaces.ensure(conversation.id, empty);
  assert.equal(first.path, empty);
  assert.ok(existsSync(join(empty, '.pugport', 'MOD-SPEC.md')), 'the reference files are added');
  assert.equal(workspaces.ensure(conversation.id, empty).id, first.id, 'the same folder is the same workspace');
  const authored = join(f.directory, 'english-speaking');
  mkdirSync(join(authored, 'ui'), { recursive: true });
  writeFileSync(join(authored, 'manifest.json'), '{}');
  writeFileSync(join(authored, 'package.json'), '{"scripts":{"build":"node build.mjs"}}');
  const second = workspaces.ensure(conversation.id, authored);
  assert.notEqual(second.id, first.id);
  assert.equal(f.workspace.store.get<Conversation>('conversation', conversation.id)!.modWorkspaceId, second.id);
  const notes = join(f.directory, 'notes');
  mkdirSync(notes);
  writeFileSync(join(notes, 'diary.txt'), 'synthetic');
  assert.throws(() => workspaces.ensure(conversation.id, notes), /不是 Mod 作者布局/);
});

test('Edit in chat for a JSON-imported Mod unpacks it into a new Mods author folder that becomes its Local build', async (t) => {
  const f = setup(t);
  const { manifest } = await packModDirectory(resolve('docs/examples/mods/reading-notes'));
  f.workspace.modes.import(manifest);
  const conversation = await f.workspace.createGeneralConversation('Reading notes');
  f.actions.setWorkMode(conversation.id, 'mods-author');
  const record = await f.workspace.modWorkspaces.fromManifest(conversation.id, manifest);
  assert.equal(record.modId, 'example.reading-notes');
  assert.ok(existsSync(join(record.path, 'ui', 'main.js')));
  assert.equal(readFileSync(join(record.path, 'README.md'), 'utf8'), manifest.readme);
  assert.equal((await packModDirectory(record.path)).manifest.version, manifest.version);
  const entry = f.workspace.modes.catalog().catalog.find((item) => item.id === manifest.id)!;
  assert.equal(entry.localBuild?.workspaceId, record.id);
  assert.equal(entry.localBuild?.conversationId, conversation.id);
});
