import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { ConversationActions } from '../src/server/conversation-actions.ts';
import { packModDirectory } from '../src/server/mod-pack.ts';
import { selectStoreModes } from '../src/shared/store-modes.ts';
import type { Conversation, ExecuteContext, Workflow } from '../src/shared/types.ts';
import type { ModeInstallation } from '../src/shared/conversation-modes.ts';
import { fixture, finished, input, result } from './helpers/session-workspace.ts';
import { readBridge } from './helpers/read-bridge.ts';

const example = resolve('docs/examples/mods/reading-notes');

/** A finished Mods author turn, and a bridge caller standing in for its lead run in the Mod folder. */
async function authorChat(t: TestContext, kind: 'mods-author' | null = 'mods-author') {
  const f = fixture(t, false);
  f.controller.targets = f.controller.targets.slice(0, 1);
  f.controller.snapshots = f.controller.snapshots.slice(0, 1);
  t.mock.method(codexAdapter, 'execute', async (_ctx: ExecuteContext) => result('completed', 'Synthetic reply.'));
  const conversation = await f.workspace.createGeneralConversation('Reading notes');
  if (kind) new ConversationActions(f.workspace).setWorkMode(conversation.id, kind);
  const sent = await f.workspace.send(conversation.id, { ...input, runtimeId: 'mock' });
  const flow = await finished(f.workspace, sent.workflow.id);
  const record = kind ? f.workspace.modWorkspaces.forConversation(conversation.id)! : undefined;
  const bridge = readBridge(t, record?.path ?? f.directory, undefined, f.workspace);
  Object.assign(bridge.caller, { write: true });
  bridge.caller.run.workflowId = flow.id;
  const write = (mutate?: (manifest: Record<string, any>) => void) => {
    for (const name of ['README.md', 'manifest.json', 'ui'])
      cpSync(join(example, name), join(record!.path, name), { recursive: true });
    if (!mutate) return;
    const path = join(record!.path, 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    mutate(manifest);
    writeFileSync(path, JSON.stringify(manifest, null, 2));
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const reply = await bridge.call(name, args);
    const text = reply.content?.[0]?.text as string;
    return { error: !!reply.isError, text, json: () => JSON.parse(text) };
  };
  return { f, conversation, flow, record, bridge, write, call };
}

const names = async (bridge: ReturnType<typeof readBridge>) =>
  ((await bridge.list()).tools as { name: string }[]).map((tool) => tool.name);

test('mod tools are offered to the Mods author lead only', async (t) => {
  const chat = await authorChat(t);
  assert.ok((await names(chat.bridge)).includes('mod_load'));
  assert.ok((await names(chat.bridge)).includes('mod_debug'));
  // A delegated child of the same chat reports its changes; the lead loads them.
  const child = { ...chat.flow, id: 'synthetic-child', delegation: { parentId: chat.flow.id, role: 'worker' } };
  chat.f.workspace.store.save('workflow', child.id, child.conversationId, child as Workflow);
  chat.bridge.caller.run.workflowId = child.id;
  assert.equal((await names(chat.bridge)).includes('mod_load'), false);
  assert.match((await chat.call('mod_load')).text, /only available to the lead/);
  const normal = await authorChat(t, null);
  assert.equal((await names(normal.bridge)).includes('mod_load'), false);
});

test('mod_load packs, installs and binds the reading-notes Mod; the Store sees a Local build', async (t) => {
  const chat = await authorChat(t);
  assert.match((await chat.call('mod_debug')).text, /call mod_load first/);
  chat.write();
  const expected = await packModDirectory(chat.record!.path);
  const loaded = await chat.call('mod_load');
  assert.equal(loaded.error, false, loaded.text);
  const value = loaded.json();
  assert.equal(value.loaded, true);
  assert.equal(value.id, 'example.reading-notes');
  assert.equal(value.version, '3.0.0');
  assert.equal(value.sha256, expected.sha256);
  assert.deepEqual(value.permissions, ['chat:read', 'composer:draft']);
  const conversation = chat.f.workspace.store.get<Conversation>('conversation', chat.conversation.id)!;
  assert.deepEqual(
    { id: conversation.modeBinding?.modeId, version: conversation.modeBinding?.version },
    { id: 'example.reading-notes', version: '3.0.0' },
  );
  const catalog = chat.f.workspace.modes.catalog();
  const selection = selectStoreModes(catalog).get('example.reading-notes')!;
  assert.deepEqual(selection.localBuild, {
    workspaceId: chat.record!.id,
    conversationId: chat.conversation.id,
    conversationTitle: 'Reading notes',
  });
  assert.equal(selection.installation?.version, '3.0.0');
  const debug = (await chat.call('mod_debug')).json();
  assert.equal(debug.lastLoad.ok, true);
  assert.deepEqual(debug.bound, { id: 'example.reading-notes', version: '3.0.0' });
  assert.deepEqual(debug.state, {}, 'nothing saved yet; only key names and sizes are ever shown');
  // Loading again right away is refused; the folder is never rebuilt in a loop.
  assert.match((await chat.call('mod_load')).text, /at most once every 10 seconds/);
});

test('an undeclared state key returns its field path and installs nothing', async (t) => {
  const chat = await authorChat(t);
  chat.write((manifest) => {
    manifest.contributions.rightPanel = {
      kind: 'form',
      form: { fields: [{ id: 'mood', label: 'Mood', type: 'text' }], actions: [] },
    };
  });
  const value = (await chat.call('mod_load')).json();
  assert.equal(value.loaded, false);
  assert.deepEqual(value.issues, [
    'contributions.rightPanel.form.fields.0.id: Form field must be declared in state.keys',
  ]);
  assert.equal(chat.f.workspace.store.get<ModeInstallation>('mode-installation', 'example.reading-notes'), undefined);
  assert.equal(chat.f.workspace.modes.catalog().catalog.length, 0);
  assert.equal(chat.f.workspace.modWorkspaces.get(chat.record!.id)!.lastLoad?.ok, false);
});

test('mod_load refuses an installed id owned by another Mod without inheriting grants or upgrading chats', async (t) => {
  const chat = await authorChat(t);
  chat.write((manifest) => {
    manifest.permissions.push('model:run');
  });
  const original = (await packModDirectory(chat.record!.path)).manifest;
  chat.f.workspace.modes.import(original);
  chat.f.workspace.modes.install(original.id, original.version, ['model:run']);
  const other = await chat.f.workspace.createGeneralConversation('Installed Mod');
  chat.f.workspace.modes.bind(other.id, { modeId: original.id, version: original.version });
  const installation = chat.f.workspace.store.get<ModeInstallation>('mode-installation', original.id);
  const value = (await chat.call('mod_load', { bump: 'patch' })).json();
  assert.equal(value.loaded, false);
  assert.deepEqual(value.issues, ['id: already used by another Mod']);
  assert.deepEqual(chat.f.workspace.store.get('mode-installation', original.id), installation);
  assert.equal(chat.f.workspace.requireConversation(other.id).modeBinding?.version, original.version);
  assert.equal(chat.f.workspace.requireConversation(chat.conversation.id).modeBinding, undefined);
  assert.equal(JSON.parse(readFileSync(join(chat.record!.path, 'manifest.json'), 'utf8')).version, original.version);
  assert.throws(() => chat.f.workspace.modes.export(original.id, '3.0.1'));
});

test('mod_load refuses a workspace root replaced by a junction or symlink', async (t) => {
  const chat = await authorChat(t);
  chat.write();
  const root = chat.record!.path;
  const original = `${root}-original`;
  renameSync(root, original);
  symlinkSync(original, root, process.platform === 'win32' ? 'junction' : 'dir');
  const loaded = await chat.f.workspace.modWorkspaces.load(chat.conversation.id);
  assert.equal(loaded.loaded, false);
  assert.match(loaded.issues!.join('\n'), /root: must be a regular directory/);
  assert.equal(chat.f.workspace.modes.catalog().installed.length, 0);
});

test('a permission that needs approval is saved, not installed, until the user approves it', async (t) => {
  const chat = await authorChat(t);
  chat.write((manifest) => {
    manifest.permissions = ['chat:read', 'composer:draft', 'model:run'];
  });
  const value = (await chat.call('mod_load')).json();
  assert.equal(value.loaded, false);
  assert.deepEqual(value.needsApproval, ['model:run']);
  assert.equal(chat.f.workspace.store.get<ModeInstallation>('mode-installation', 'example.reading-notes'), undefined);
  const waiting = chat.f.workspace.store.get<Conversation>('conversation', chat.conversation.id)!;
  assert.deepEqual(waiting.modApproval?.permissions, ['model:run']);
  assert.equal(waiting.modeBinding, undefined);
  const approved = chat.f.workspace.modWorkspaces.approve(chat.conversation.id, {
    ...waiting.modApproval!,
    approved: true,
  });
  assert.equal(approved.modApproval, undefined);
  assert.deepEqual(
    chat.f.workspace.store.get<ModeInstallation>('mode-installation', 'example.reading-notes')?.approvedPermissions,
    ['model:run'],
  );
  assert.equal(
    chat.f.workspace.store.get<Conversation>('conversation', chat.conversation.id)!.modeBinding?.version,
    '3.0.0',
  );
});

test('mod tools refuse a run outside the chat folder, and a package.json build script is never run', async (t) => {
  const chat = await authorChat(t);
  chat.write();
  writeFileSync(
    join(chat.record!.path, 'package.json'),
    JSON.stringify({ scripts: { build: "node -e \"require('fs').writeFileSync('ran.txt', 'x')\"" } }),
  );
  const elsewhere = mkdtempSync(join(tmpdir(), 'pugport-mod-elsewhere-'));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  chat.bridge.caller.run.projectPath = elsewhere;
  assert.match((await chat.call('mod_load')).text, /only in this chat's Mod workspace folder/);
  chat.bridge.caller.run.projectPath = chat.record!.path;
  const value = (await chat.call('mod_load')).json();
  assert.equal(value.loaded, true);
  assert.match(value.notes.join('\n'), /runs nothing from the folder/);
  assert.equal(
    (() => {
      try {
        readFileSync(join(chat.record!.path, 'ran.txt'));
        return true;
      } catch {
        return false;
      }
    })(),
    false,
  );
});

test('mod_debug returns the frame errors and refused requests since the last load', async (t) => {
  const chat = await authorChat(t);
  chat.write();
  assert.equal((await chat.call('mod_load')).json().loaded, true);
  const at = Date.now() + 1;
  chat.f.workspace.modWorkspaces.addDiagnostics(chat.record!.id, [
    { level: 'error', source: 'frame', text: 'TypeError: notes is undefined (line 88:3)', at },
    { level: 'error', source: 'bridge', text: 'model.run refused: E_PERMISSION', at: at + 1 },
    { level: 'log', source: 'frame', text: 'saved 2 notes', at: at + 2 },
  ]);
  const debug = (await chat.call('mod_debug')).json();
  assert.equal(debug.errors, 2);
  assert.equal(debug.logs, 1);
  assert.match(debug.lines[0], /\[frame\] error  TypeError: notes is undefined \(line 88:3\)$/);
  assert.match(debug.lines[1], /\[host\] error  model\.run refused: E_PERMISSION$/);
  assert.match(debug.lines[2], /\[frame\] log    saved 2 notes$/);
  assert.match((await chat.call('mod_debug', { since: 'soon' })).text, /since must be/);
});
