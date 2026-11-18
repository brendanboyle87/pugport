import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canAttachMod,
  conversationModeManifestSchema,
  modeBindingRequestSchema,
  type ConversationModeManifest,
} from '../src/shared/conversation-modes.ts';
import { composeModePrompt, type ModManifestV2 } from '../src/shared/mods-manifest.ts';
import { catalogResponse } from '../src/ui/conversation-mode-session.ts';
import { ConversationModes, ModeConflict } from '../src/server/conversation-modes.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import type { Conversation, Project, Workflow } from '../src/shared/types.ts';

const manifest = (version = '1.0.0'): ConversationModeManifest => ({
  schemaVersion: 1,
  id: 'example.notes',
  version,
  title: 'Notes',
  description: 'A local fixture',
  view: {
    markdown: '# Notes',
    fields: [{ id: 'topic', label: 'Topic', type: 'text', initialValue: 'initial' }],
    actions: [
      { id: 'save', label: 'Save', type: 'save' },
      { id: 'compose', label: 'Compose', type: 'compose', prompt: 'Explain the topic' },
    ],
  },
});
function fixture(path = ':memory:') {
  const db = new DatabaseSync(path);
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  store.save('project', 'project', 'project', {
    id: 'project',
    name: 'Fixture',
    path: '/synthetic/project',
    createdAt: '',
    updatedAt: '',
  } satisfies Project);
  let barrier: string | undefined;
  let notifications = 0;
  const host = {
    store,
    requireConversation(id: string) {
      const value = store.get<Conversation>('conversation', id);
      if (!value || value.deletedAt) throw new Error('Conversation unavailable');
      return value;
    },
    modeSwitchBarrier: () => barrier,
    notify: () => {
      notifications++;
    },
  };
  const modes = new ConversationModes(host);
  const add = (id: string) =>
    store.save('conversation', id, 'project', {
      id,
      projectId: 'project',
      title: id,
      createdAt: '2026-10-23T00:00:00Z',
      updatedAt: '2026-10-23T00:00:00Z',
    } satisfies Conversation);
  add('one');
  add('two');
  return {
    db,
    store,
    modes,
    setBarrier: (id?: string) => {
      barrier = id;
    },
    notifications: () => notifications,
  };
}

test('reattachment records its time without changing saved instance revisions; visibility checks the binding', () => {
  const f = fixture();
  try {
    f.modes.import(manifest());
    f.modes.install('example.notes', '1.0.0');
    const original = f.modes.bind('one', { modeId: 'example.notes' });
    assert.ok(original.binding?.attachedAt);
    f.modes.bind('one', { modeId: null });
    const restored = f.modes.bind('one', { modeId: 'example.notes' });
    assert.deepEqual(restored.instance, original.instance);
    assert.ok(restored.binding!.attachedAt! >= original.binding!.attachedAt!);
    const expectedInstanceId = restored.instance!.id;
    f.modes.setHidden('one', { hidden: true, expectedInstanceId });
    f.modes.import(manifest('2.0.0'));
    f.modes.install('example.notes', '2.0.0');
    assert.equal(f.modes.view('one').binding?.attachedAt, restored.binding?.attachedAt);
    assert.throws(() => f.modes.setHidden('one', { hidden: false, expectedInstanceId }), /selected Mod changed/);
    assert.equal(f.store.get<Conversation>('conversation', 'one')?.modeHidden, true);
    assert.equal(f.modes.setHidden('one', { hidden: false }).modeHidden, undefined, 'legacy visibility request works');
  } finally {
    f.db.close();
  }
});

test('Mods attach to ordinary live chats and exclude side, lane, swarm, deleted and closed chats', () => {
  assert.equal(canAttachMod({}), true);
  assert.equal(canAttachMod(undefined), false);
  const excluded: Partial<Conversation>[] = [
    {
      sideChat: {
        parentConversationId: 'parent',
        context: '',
        selection: { provider: 'codex', model: 'fixture', executionPolicy: 'cli-only' },
      },
    },
    { lane: { parentConversationId: 'parent', sourceWorkflowId: 'workflow' } },
    { swarm: true },
    { deletedAt: 'deleted' },
    { closedAt: 'closed' },
  ];
  for (const extra of excluded) {
    assert.equal(canAttachMod(extra), false);
    const f = fixture();
    try {
      f.modes.import(manifest());
      f.modes.install('example.notes', '1.0.0');
      const chat = f.store.get<Conversation>('conversation', 'one')!;
      f.store.save('conversation', chat.id, chat.projectId, { ...chat, ...extra });
      assert.throws(
        () => f.modes.bind('one', { modeId: 'example.notes' }),
        extra.deletedAt
          ? /Conversation unavailable/
          : extra.closedAt
            ? /closing/
            : (error: unknown) =>
                error instanceof ModeConflict && error.status === 409 && error.message === '这类对话不能添加 Mod。',
      );
      assert.equal(f.store.list('mode-instance', 'one').length, 0);
    } finally {
      f.db.close();
    }
  }
});

test('ordinary chats attach, save and capture Mods', () => {
  const f = fixture();
  try {
    const project = f.store.get<Project>('project', 'project')!;
    f.store.save('project', project.id, project.id, { ...project, scope: 'chat' });
    f.modes.import(manifest());
    f.modes.install('example.notes', '1.0.0');
    const bound = f.modes.bind('one', { modeId: 'example.notes' });
    const saved = f.modes.action('one', {
      instanceId: bound.instance!.id,
      expectedRevision: 0,
      action: { type: 'save', values: { topic: 'retained' } },
    });
    assert.equal(saved.instance?.state.topic, 'retained');
    assert.deepEqual(f.modes.capture('one'), { binding: bound.binding, revision: 1 });
  } finally {
    f.db.close();
  }
});

test('recovery drops a queued Mod when its chat enters swarm mode', () => {
  const f = fixture();
  try {
    f.modes.import(manifest());
    f.modes.install('example.notes', '1.0.0');
    f.setBarrier('running');
    assert.ok(f.modes.bind('one', { modeId: 'example.notes' }).pending?.binding);
    const chat = f.store.get<Conversation>('conversation', 'one')!;
    f.store.save('conversation', chat.id, chat.projectId, { ...chat, swarm: true });
    f.setBarrier();
    f.modes.recover();
    assert.equal(f.modes.view('one').binding, null);
    assert.equal(f.modes.view('one').pending, null);
    assert.equal(f.modes.capture('one'), undefined);
  } finally {
    f.db.close();
  }
});

test('optional catalog category is bounded and legacy manifests remain valid', () => {
  assert.equal(conversationModeManifestSchema.parse(manifest()).category, undefined);
  assert.equal(conversationModeManifestSchema.parse({ ...manifest(), category: ' Notes ' }).category, 'Notes');
  for (const category of ['', ' ', 'x'.repeat(41), ['Notes']])
    assert.equal(conversationModeManifestSchema.safeParse({ ...manifest(), category }).success, false);
});

test('optional icons accept only host icons, preserve legacy packages and reach the local catalog', () => {
  assert.equal(conversationModeManifestSchema.parse(manifest()).icon, undefined);
  for (const icon of ['puzzle', 'notebook-pen', 'book-open', 'code-xml', 'languages', 'list-checks', 'sparkles'])
    assert.equal(conversationModeManifestSchema.parse({ ...manifest(), icon }).icon, icon);
  for (const icon of [
    'https://example.invalid/icon.svg',
    'data:image/svg+xml,<svg/>',
    '<script/>',
    'constructor',
    '',
    {},
  ])
    assert.equal(conversationModeManifestSchema.safeParse({ ...manifest(), icon }).success, false);
  const f = fixture();
  try {
    assert.equal(f.modes.import({ ...manifest(), icon: 'notebook-pen' }).catalog[0]!.icon, 'notebook-pen');
  } finally {
    f.db.close();
  }
});

test('empty catalog imports without installing, pins versions and never replaces existing contents', () => {
  const f = fixture();
  try {
    assert.deepEqual(f.modes.catalog(), { catalog: [], installed: [] });
    assert.equal(f.modes.import(manifest()).installed.length, 0);
    assert.throws(() => f.modes.bind('one', { modeId: 'example.notes' }), ModeConflict);
    f.modes.install('example.notes', '1.0.0');
    const first = f.modes.bind('one', { modeId: 'example.notes' });
    f.modes.import(manifest('2.0.0'));
    f.modes.install('example.notes', '2.0.0');
    // Loading a newer version moves the chat; its old instance stays for Undo.
    assert.equal(f.modes.view('one').binding?.version, '2.0.0');
    assert.equal(f.modes.view('one').installed, true);
    assert.equal(first.manifest?.version, '1.0.0');
    assert.ok(f.store.get('mode-instance', first.instance!.id));
    assert.throws(() => f.modes.import({ ...manifest(), title: 'replaced' }), ModeConflict);
    assert.equal(f.modes.catalog().catalog.length, 2);
  } finally {
    f.db.close();
  }
});

test('state is per conversation, revision protected, bounded and only declared fields are writable', () => {
  const f = fixture();
  try {
    f.modes.import(manifest());
    f.modes.install('example.notes', '1.0.0');
    const one = f.modes.bind('one', { modeId: 'example.notes' });
    const two = f.modes.bind('two', { modeId: 'example.notes' });
    assert.notEqual(one.instance?.id, two.instance?.id);
    f.modes.action('one', {
      instanceId: f.modes.view('one').instance!.id,
      expectedRevision: 0,
      action: { type: 'save', values: { topic: 'saved' } },
    });
    assert.equal(f.modes.view('one').instance?.revision, 1);
    assert.equal(f.modes.view('two').instance?.state.topic, 'initial');
    assert.throws(
      () =>
        f.modes.action('one', {
          instanceId: f.modes.view('one').instance!.id,
          expectedRevision: 0,
          action: { type: 'save', values: { topic: 'stale' } },
        }),
      ModeConflict,
    );
    assert.throws(() =>
      f.modes.action('one', {
        instanceId: f.modes.view('one').instance!.id,
        expectedRevision: 1,
        action: { type: 'save', values: { command: 'bad' } },
      }),
    );
    assert.throws(() =>
      f.modes.action('one', {
        instanceId: f.modes.view('one').instance!.id,
        expectedRevision: 1,
        action: { type: 'save', values: { topic: 'x'.repeat(8001) } },
      }),
    );
    assert.throws(() =>
      f.modes.action('one', {
        instanceId: f.modes.view('one').instance!.id,
        expectedRevision: 1,
        action: { type: 'compose', values: { topic: 'bad' } },
      }),
    );
    const conversation = f.store.get<Conversation>('conversation', 'two')!;
    conversation.modeBinding = one.binding!;
    f.store.save('conversation', 'two', 'project', conversation);
    assert.throws(() => f.modes.view('two'), /belong/);
  } finally {
    f.db.close();
  }
});

test('uninstall keeps readable state and manifest, rejects writes, reinstall reuses the instance', () => {
  const f = fixture();
  try {
    f.modes.import(manifest());
    f.modes.install('example.notes', '1.0.0');
    const old = f.modes.bind('one', { modeId: 'example.notes' });
    f.modes.action('one', {
      instanceId: f.modes.view('one').instance!.id,
      expectedRevision: 0,
      action: { type: 'save', values: { topic: 'keep' } },
    });
    f.modes.install('example.notes', null);
    const read = f.modes.view('one');
    assert.equal(read.manifest?.title, 'Notes');
    assert.equal(read.instance?.state.topic, 'keep');
    assert.equal(read.installed, false);
    assert.throws(
      () =>
        f.modes.action('one', {
          instanceId: f.modes.view('one').instance!.id,
          expectedRevision: 1,
          action: { type: 'save', values: {} },
        }),
      ModeConflict,
    );
    f.modes.bind('one', { modeId: null });
    f.modes.install('example.notes', '1.0.0');
    assert.equal(f.modes.bind('one', { modeId: 'example.notes' }).instance?.id, old.instance?.id);
  } finally {
    f.db.close();
  }
});

test('binding changes defer across QueueDeferred and preserve the immutable workflow snapshot', () => {
  const f = fixture();
  try {
    f.modes.import(manifest());
    f.modes.install('example.notes', '1.0.0');
    f.modes.bind('one', { modeId: 'example.notes' });
    const snapshot = f.modes.capture('one')!;
    f.setBarrier('work');
    const pending = f.modes.bind('one', { modeId: null });
    assert.equal(pending.binding?.modeId, 'example.notes');
    assert.equal(pending.pending?.afterWorkflowId, 'work');
    const workflow = {
      id: 'work',
      conversationId: 'one',
      status: 'waiting-resource',
      modeSnapshot: snapshot,
    } as Workflow;
    f.setBarrier();
    f.modes.settled(workflow);
    assert.ok(f.modes.view('one').pending);
    f.modes.action('one', {
      instanceId: f.modes.view('one').instance!.id,
      expectedRevision: 0,
      action: { type: 'save', values: { topic: 'changed while running' } },
    });
    assert.equal(snapshot.revision, 0);
    workflow.status = 'completed';
    f.modes.settled(workflow);
    assert.equal(f.modes.view('one').binding, null);
    assert.equal(f.modes.view('one').pending, null);
    assert.equal(snapshot.binding.modeId, 'example.notes');
    assert.equal(f.modes.capture('two'), undefined);
  } finally {
    f.db.close();
  }
});

test('a second live workflow holds pending binding and closed private conversations reject changes', () => {
  const f = fixture();
  try {
    f.modes.import(manifest());
    f.modes.install('example.notes', '1.0.0');
    f.modes.bind('one', { modeId: 'example.notes' });
    f.setBarrier('first');
    f.modes.bind('one', { modeId: null });
    f.setBarrier('second');
    f.modes.settled({ id: 'first', conversationId: 'one', status: 'completed' } as Workflow);
    assert.equal(f.modes.view('one').pending?.afterWorkflowId, 'second');
    const conversation = f.store.get<Conversation>('conversation', 'one')!;
    conversation.incognito = true;
    conversation.closedAt = new Date().toISOString();
    f.store.save('conversation', 'one', 'project', conversation);
    assert.throws(() => f.modes.bind('one', { modeId: null }), ModeConflict);
    assert.throws(
      () =>
        f.modes.action('one', {
          instanceId: f.modes.view('one').instance!.id,
          expectedRevision: 0,
          action: { type: 'save', values: {} },
        }),
      ModeConflict,
    );
    f.setBarrier();
    f.modes.settled({ id: 'second', conversationId: 'one', status: 'completed' } as Workflow);
    assert.ok(f.modes.view('one').pending);
    const count = f.store.db
      .prepare("SELECT count(*) AS n FROM workspace_records WHERE kind='mode-instance' AND owner='one'")
      .get() as { n: number };
    assert.equal(count.n, 1);
  } finally {
    f.db.close();
  }
});

test('persistence reopens state and reconciles terminal pending bindings without replaying work', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-modes-'));
  const path = join(dir, 'test.db');
  const f = fixture(path);
  f.modes.import(manifest());
  f.modes.install('example.notes', '1.0.0');
  const before = f.modes.bind('one', { modeId: 'example.notes' });
  f.modes.action('one', {
    instanceId: f.modes.view('one').instance!.id,
    expectedRevision: 0,
    action: { type: 'save', values: { topic: 'persisted' } },
  });
  f.modes.setHidden('one', { hidden: true });
  f.setBarrier('interrupted');
  f.modes.bind('one', { modeId: null });
  f.db.close();
  const db = new DatabaseSync(path);
  try {
    const store = new WorkspaceStore(db, { recoverInterrupted: false });
    const modes = new ConversationModes({
      store,
      requireConversation: (id) => store.get<Conversation>('conversation', id)!,
      modeSwitchBarrier: () => undefined,
      notify() {},
    });
    assert.equal(modes.view('one').instance?.state.topic, 'persisted');
    assert.equal(store.get<Conversation>('conversation', 'one')?.modeHidden, true);
    modes.recover();
    assert.equal(modes.view('one').binding, null);
    assert.equal(modes.bind('one', { modeId: 'example.notes' }).instance?.id, before.instance?.id);
    assert.equal(modes.view('one').instance?.state.topic, 'persisted');
    assert.equal(store.get<Conversation>('conversation', 'one')?.modeHidden, undefined);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manifest rejects executable fields, unsafe IDs, unknown actions and oversized schemas', () => {
  for (const candidate of [
    { ...manifest(), script: 'alert(1)' },
    { ...manifest(), ipc: 'anything' },
    { ...manifest(), schemaVersion: 2 },
    { ...manifest(), id: '../escape' },
    { ...manifest(), version: 'latest' },
    { ...manifest(), view: { ...manifest().view, component: 'CustomReact' } },
    { ...manifest(), view: { ...manifest().view, fields: [{ id: 'constructor', label: 'bad', type: 'text' }] } },
    { ...manifest(), view: { ...manifest().view, fields: [manifest().view.fields[0], manifest().view.fields[0]] } },
    {
      ...manifest(),
      view: { ...manifest().view, actions: [{ id: 'run', label: 'Run', type: 'execute', command: 'x' }] },
    },
    { ...manifest(), view: { ...manifest().view, markdown: 'x'.repeat(20001) } },
  ])
    assert.equal(conversationModeManifestSchema.safeParse(candidate).success, false);
  assert.equal(conversationModeManifestSchema.safeParse(manifest()).success, true);
});

test('compose is literal text with declared fields and cannot run expressions or mutate state', () => {
  const value = manifest();
  value.view.actions[1] = {
    id: 'compose',
    label: 'Compose',
    type: 'compose',
    prompt: 'Keep ${process.env.KEY} literal',
  };
  const state = { topic: '{{run()}}' };
  assert.equal(composeModePrompt(value.view, 'compose', state), 'Keep ${process.env.KEY} literal\n\nTopic:\n{{run()}}');
  assert.deepEqual(state, { topic: '{{run()}}' });
  assert.throws(() => composeModePrompt(value.view, 'save', state));
  assert.throws(() => composeModePrompt(value.view, 'compose', { unknown: 'x' }));
});

test('a stale form cannot write another instance with the same revision and field names', () => {
  const f = fixture();
  try {
    f.modes.import(manifest());
    f.modes.install('example.notes', '1.0.0');
    const old = f.modes.bind('one', { modeId: 'example.notes' });
    const other = { ...manifest(), id: 'example.other' };
    f.modes.import(other);
    f.modes.install(other.id, other.version);
    const current = f.modes.bind('one', { modeId: other.id });
    assert.throws(
      () =>
        f.modes.action('one', {
          instanceId: old.instance!.id,
          expectedRevision: 0,
          action: { type: 'save', values: { topic: 'stale form' } },
        }),
      ModeConflict,
    );
    assert.notEqual(current.instance?.id, old.instance?.id);
    assert.equal(f.modes.view('one').instance?.state.topic, 'initial');
  } finally {
    f.db.close();
  }
});

test('manifest initial values include state serialization overhead in the same bounded limit', () => {
  const value = manifest();
  value.view.fields = Array.from({ length: 16 }, (_, index) => ({
    id: `field${index}`,
    label: 'Field',
    type: 'textarea',
    initialValue: 'x'.repeat(4000),
  }));
  assert.equal(conversationModeManifestSchema.safeParse(value).success, false);
});

const RETIRED = 'studyhub.workbench';
const retiredBinding = { instanceId: 'sh-1', modeId: RETIRED, version: '1.0.0' };
const notesBinding = { instanceId: 'notes-1', modeId: 'example.notes', version: '1.0.0' };
type Fixture = ReturnType<typeof fixture>;
function put(f: Fixture, id: string, patch: Partial<Conversation>) {
  f.store.save('conversation', id, 'project', {
    id,
    projectId: 'project',
    title: id,
    createdAt: '2026-10-23T00:00:00Z',
    updatedAt: '2026-10-23T00:00:00Z',
    ...f.store.get<Conversation>('conversation', id),
    ...patch,
  } satisfies Conversation);
}
const later = (afterWorkflowId: string, binding: typeof notesBinding | null) => ({
  binding,
  afterWorkflowId,
  requestedAt: '2026-10-23T00:00:00Z',
});
function seedLegacy(f: Fixture) {
  put(f, 'one', { modeBinding: retiredBinding });
  put(f, 'two', { modeBinding: notesBinding, pendingModeBinding: later('w-1', retiredBinding) });
  put(f, 'three', { pendingModeBinding: later('w-2', retiredBinding) });
  put(f, 'four', { modeBinding: retiredBinding, pendingModeBinding: later('w-3', retiredBinding) });
  put(f, 'five', { modeBinding: retiredBinding, pendingModeBinding: later('w-4', notesBinding) });
  put(f, 'six', { modeBinding: notesBinding, deletedAt: '2026-10-24T00:00:00Z' });
  const instance = (id: string, conversationId: string, modeId: string) =>
    f.store.save('mode-instance', id, conversationId, {
      id,
      conversationId,
      modeId,
      version: '1.0.0',
      schemaVersion: 1,
      revision: 3,
      state: { topic: 'kept' },
      createdAt: '',
      updatedAt: '',
    });
  instance('sh-1', 'one', RETIRED);
  instance('notes-1', 'two', 'example.notes');
  f.store.save('mode-manifest', `${RETIRED}@1.0.0`, 'conversation-modes', { ...manifest(), id: RETIRED });
  f.store.save('mode-manifest', `${RETIRED}@1.1.0`, 'conversation-modes', { ...manifest('1.1.0'), id: RETIRED });
  f.store.save('mode-installation', RETIRED, 'conversation-modes', {
    modeId: RETIRED,
    version: '1.0.0',
    installedAt: '',
  });
  f.modes.import(manifest());
  f.modes.install('example.notes', '1.0.0');
  f.store.save('message', 'm-1', 'one', { id: 'm-1', conversationId: 'one', role: 'user', content: 'synthetic hello' });
}
const conv = (f: Fixture, id: string) => f.store.get<Conversation>('conversation', id)!;

test('retireBuiltIns clears only the binding field that points at StudyHub and keeps data', () => {
  const f = fixture();
  try {
    seedLegacy(f);
    f.modes.retireBuiltIns();
    assert.equal(conv(f, 'one').modeBinding, undefined);
    // Another mod in the other field stays; only the field pointing at StudyHub goes.
    assert.deepEqual(conv(f, 'two').modeBinding, notesBinding);
    assert.equal(conv(f, 'two').pendingModeBinding, undefined);
    assert.equal(conv(f, 'three').pendingModeBinding, undefined);
    assert.equal(conv(f, 'four').modeBinding, undefined);
    assert.equal(conv(f, 'four').pendingModeBinding, undefined);
    assert.equal(conv(f, 'five').modeBinding, undefined);
    assert.equal(conv(f, 'five').pendingModeBinding?.binding?.modeId, 'example.notes');
    assert.deepEqual(conv(f, 'six').modeBinding, notesBinding);
    assert.equal(f.store.get('mode-installation', RETIRED), undefined);
    assert.equal(f.store.get('mode-manifest', `${RETIRED}@1.0.0`), undefined);
    assert.equal(f.store.get('mode-manifest', `${RETIRED}@1.1.0`), undefined);
    const cat = f.modes.catalog();
    assert.deepEqual(
      cat.catalog.map((m) => m.id),
      ['example.notes'],
    );
    assert.deepEqual(
      cat.installed.map((m) => m.modeId),
      ['example.notes'],
    );
    // Mode instances and messages are never deleted.
    assert.deepEqual(f.store.get<{ state: object }>('mode-instance', 'sh-1')?.state, { topic: 'kept' });
    assert.ok(f.store.get('mode-instance', 'notes-1'));
    assert.equal(f.store.get<{ content: string }>('message', 'm-1')?.content, 'synthetic hello');
    assert.equal(f.modes.view('one').binding, null);
  } finally {
    f.db.close();
  }
});

test('retireBuiltIns is idempotent and the marker stops a second sweep', () => {
  const f = fixture();
  try {
    seedLegacy(f);
    f.modes.retireBuiltIns();
    assert.deepEqual(f.store.get('migration', 'mods-studyhub-retire-v1'), { completed: true });
    const snapshot = JSON.stringify(f.store.list('conversation', undefined, 100));
    f.modes.retireBuiltIns();
    assert.equal(JSON.stringify(f.store.list('conversation', undefined, 100)), snapshot);
    // A user may later import their own package with this id; the marker prevents another sweep.
    f.store.save('mode-installation', RETIRED, 'conversation-modes', {
      modeId: RETIRED,
      version: '2.0.0',
      installedAt: '',
    });
    f.modes.retireBuiltIns();
    assert.ok(f.store.get('mode-installation', RETIRED));
  } finally {
    f.db.close();
  }
});

test('retireBuiltIns rolls back every change if the transaction fails', () => {
  const f = fixture();
  try {
    seedLegacy(f);
    const save = f.store.save.bind(f.store);
    f.store.save = ((kind: string, ...rest: unknown[]) => {
      if (kind === 'migration') throw new Error('synthetic failure');
      return (save as (...a: unknown[]) => void)(kind, ...rest);
    }) as typeof f.store.save;
    assert.throws(() => f.modes.retireBuiltIns(), /synthetic failure/);
    f.store.save = save;
    assert.deepEqual(conv(f, 'one').modeBinding, retiredBinding);
    assert.ok(f.store.get('mode-installation', RETIRED));
    assert.ok(f.store.get('mode-manifest', `${RETIRED}@1.0.0`));
    assert.equal(f.store.get('migration', 'mods-studyhub-retire-v1'), undefined);
    f.modes.retireBuiltIns();
    assert.equal(conv(f, 'one').modeBinding, undefined);
  } finally {
    f.db.close();
  }
});

test('the v1 schema accepts only the form layout', () => {
  const view = (layout: string) => ({ ...manifest(), view: { ...manifest().view, layout } });
  assert.equal(conversationModeManifestSchema.safeParse(view('form')).success, true);
  assert.equal(conversationModeManifestSchema.safeParse(view('studyhub')).success, false);
});

test('visibility persists only on the conversation and preserves saved data and pending removal', () => {
  const f = fixture();
  try {
    f.modes.import(manifest());
    f.modes.install('example.notes', '1.0.0');
    const original = f.modes.bind('one', { modeId: 'example.notes' });
    f.store.save('message', 'synthetic-message', 'one', { id: 'synthetic-message', content: 'Keep this message' });
    f.setBarrier('running');
    f.modes.bind('one', { modeId: null });
    const before = f.modes.view('one');
    const count = f.notifications();
    const hidden = f.modes.setHidden('one', { hidden: true });
    assert.equal(hidden.modeHidden, true);
    assert.equal(f.store.get<Conversation>('conversation', 'one')?.modeHidden, true);
    assert.deepEqual(f.modes.view('one'), before);
    assert.equal(f.notifications(), count + 1);
    assert.equal(f.store.get<Conversation>('conversation', 'two')?.modeHidden, undefined);
    const shown = f.modes.setHidden('one', { hidden: false });
    assert.equal(Object.hasOwn(shown, 'modeHidden'), false);
    assert.equal(Object.hasOwn(f.store.get<Conversation>('conversation', 'one')!, 'modeHidden'), false);
    assert.deepEqual(f.modes.view('one').binding, original.binding);
    assert.deepEqual(f.modes.view('one').pending, before.pending);
    assert.deepEqual(f.modes.view('one').instance, original.instance);
    assert.equal(f.store.get<{ content: string }>('message', 'synthetic-message')?.content, 'Keep this message');
    f.modes.install('example.notes', null);
    assert.equal(
      f.modes.setHidden('one', { hidden: true }).modeHidden,
      true,
      'unloaded attached content stays toggleable',
    );
  } finally {
    f.db.close();
  }
});

test('visibility rejects malformed requests, missing bindings and ineligible conversations', () => {
  const f = fixture();
  try {
    f.modes.import(manifest());
    f.modes.install('example.notes', '1.0.0');
    f.modes.bind('one', { modeId: 'example.notes' });
    const before = f.store.get<Conversation>('conversation', 'one')!;
    const count = f.notifications();
    for (const request of [undefined, null, {}, [], { hidden: 'true' }, { hidden: 1 }, { hidden: true, extra: true }])
      assert.throws(() => f.modes.setHidden('one', request));
    assert.throws(() => f.modes.setHidden('two', { hidden: true }), /No Mod is attached/);
    assert.throws(() => f.modes.setHidden('missing', { hidden: true }), /Conversation unavailable/);
    assert.deepEqual(f.store.get('conversation', 'one'), before);
    assert.equal(f.notifications(), count);
    f.store.save('conversation', before.id, before.projectId, { ...before, swarm: true });
    assert.throws(() => f.modes.setHidden('one', { hidden: true }), /这类对话不能添加 Mod/);
    f.store.save('conversation', before.id, before.projectId, { ...before, closedAt: 'closed' });
    assert.throws(() => f.modes.setHidden('one', { hidden: true }), /closing/);
    f.store.save('conversation', before.id, before.projectId, { ...before, deletedAt: 'deleted' });
    assert.throws(() => f.modes.setHidden('one', { hidden: true }), /Conversation unavailable/);
  } finally {
    f.db.close();
  }
});

test('Undo restores the exact saved instance of an unloaded Mod without installing or deleting data', () => {
  const f = fixture();
  try {
    f.modes.import(manifest());
    f.modes.install('example.notes', '1.0.0');
    const original = f.modes.bind('one', { modeId: 'example.notes' });
    const instanceId = original.instance!.id;
    const saved = f.modes.action('one', {
      instanceId,
      expectedRevision: 0,
      action: { type: 'save', values: { topic: 'retained content' } },
    });
    f.store.save('message', 'retained-message', 'one', { content: 'Retained synthetic message' });
    f.modes.install('example.notes', null);
    const removed = f.modes.bind('one', { modeId: null });
    assert.equal(removed.binding, null);
    assert.deepEqual(f.store.get('mode-instance', instanceId), saved.instance);
    const restore = { modeId: 'example.notes', version: '1.0.0', restoreInstanceId: instanceId };
    assert.throws(() => f.modes.bind('one', { modeId: restore.modeId, version: restore.version }), /Install/);
    const restored = f.modes.bind('one', restore);
    assert.deepEqual(restored.instance, saved.instance);
    assert.equal(restored.installed, false);
    assert.equal(f.modes.catalog().installed.length, 0);
    assert.equal(f.store.list('mode-instance', 'one').length, 1);
    assert.deepEqual(f.store.get('message', 'retained-message'), { content: 'Retained synthetic message' });
    f.setBarrier('running');
    assert.equal(f.modes.bind('one', { modeId: null }).pending?.binding, null);
    assert.equal(f.modes.bind('one', restore).pending, null, 'Undo cancels queued removal');
    f.setBarrier();
    f.modes.bind('one', { modeId: null });
    f.setBarrier('running');
    assert.equal(f.modes.bind('one', restore).pending?.binding?.instanceId, instanceId);
    assert.equal(f.modes.view('one').binding, null);
    f.setBarrier();
    f.modes.settled({ id: 'running', conversationId: 'one', status: 'completed' } as Workflow);
    assert.deepEqual(f.modes.view('one').instance, saved.instance);
    assert.equal(f.modes.view('one').installed, false);
  } finally {
    f.db.close();
  }
});

test('Undo cannot create an instance or restore another conversation, package or version', () => {
  const f = fixture();
  try {
    f.modes.import(manifest());
    f.modes.install('example.notes', '1.0.0');
    const original = f.modes.bind('one', { modeId: 'example.notes' });
    f.modes.import(manifest('2.0.0'));
    f.modes.import({ ...manifest(), id: 'example.other' });
    f.modes.install('example.notes', null);
    f.modes.bind('one', { modeId: null });
    const restore = { modeId: 'example.notes', version: '1.0.0', restoreInstanceId: original.instance!.id };
    for (const request of [
      { restoreInstanceId: restore.restoreInstanceId, modeId: null },
      { restoreInstanceId: restore.restoreInstanceId, modeId: restore.modeId },
      { ...restore, restoreInstanceId: 'not-a-uuid' },
      { modeId: restore.modeId, version: restore.version, restoreFromInstanceId: null },
      { ...restore, restoreFromInstanceId: 'not-a-uuid' },
      { ...restore, extra: true },
      { ...restore, restoreInstanceId: '00000000-0000-4000-8000-000000000000' },
      { ...restore, version: '2.0.0' },
      { ...restore, modeId: 'example.other' },
    ])
      assert.throws(() => f.modes.bind('one', request));
    assert.throws(() => f.modes.bind('two', restore), /belong/);
    assert.equal(f.store.list('mode-instance').length, 1);
    assert.equal(f.modes.view('one').binding, null);
    assert.equal(f.modes.view('two').binding, null);
    assert.equal(f.modes.catalog().installed.length, 0);
  } finally {
    f.db.close();
  }
});
test('Undo restores a cancelled pending-only attachment with its original saved instance', () => {
  const f = fixture();
  try {
    f.modes.import(manifest());
    f.modes.install('example.notes', '1.0.0');
    f.setBarrier('running');
    const pending = f.modes.bind('one', { modeId: 'example.notes' });
    assert.equal(pending.binding, null);
    const binding = pending.pending!.binding!;
    assert.ok(f.store.get('mode-instance', binding.instanceId));
    assert.equal(f.modes.bind('one', { modeId: null }).pending, null);
    f.modes.install('example.notes', null);
    const restore = {
      modeId: binding.modeId,
      version: binding.version,
      restoreInstanceId: binding.instanceId,
    };
    const queued = f.modes.bind('one', restore);
    assert.equal(queued.binding, null);
    const restoredBinding = queued.pending!.binding!;
    assert.ok(restoredBinding.attachedAt! >= binding.attachedAt!);
    assert.deepEqual(restoredBinding, { ...binding, attachedAt: restoredBinding.attachedAt });
    assert.equal(f.store.list('mode-instance', 'one').length, 1);
    f.setBarrier();
    f.modes.recover();
    assert.deepEqual(f.modes.view('one').binding, restoredBinding);
    assert.equal(f.modes.view('one').installed, false);
    assert.equal(f.modes.catalog().installed.length, 0);
  } finally {
    f.db.close();
  }
});

test('stale Undo cannot replace a newer active Mod', () => {
  const f = fixture();
  try {
    const other = { ...manifest(), id: 'example.other' };
    f.modes.import(manifest());
    f.modes.import(other);
    f.modes.install('example.notes', '1.0.0');
    f.modes.install(other.id, other.version);
    const original = f.modes.bind('one', { modeId: 'example.notes' });
    f.modes.bind('one', { modeId: null });
    const newer = f.modes.bind('one', { modeId: other.id });
    const before = f.store.get('conversation', 'one');
    const notifications = f.notifications();
    assert.throws(
      () =>
        f.modes.bind('one', {
          modeId: original.binding!.modeId,
          version: original.binding!.version,
          restoreInstanceId: original.binding!.instanceId,
        }),
      /selected Mod changed/,
    );
    assert.deepEqual(f.store.get('conversation', 'one'), before);
    assert.deepEqual(f.modes.view('one'), newer);
    assert.equal(f.notifications(), notifications);
    assert.equal(f.store.list('mode-instance', 'one').length, 2);
  } finally {
    f.db.close();
  }
});

test('stale Undo cannot replace a newer queued Mod', () => {
  const f = fixture();
  try {
    const other = { ...manifest(), id: 'example.other' };
    f.modes.import(manifest());
    f.modes.import(other);
    f.modes.install('example.notes', '1.0.0');
    f.modes.install(other.id, other.version);
    const original = f.modes.bind('one', { modeId: 'example.notes' });
    f.setBarrier('running');
    f.modes.bind('one', { modeId: null });
    const queued = f.modes.bind('one', { modeId: other.id });
    assert.deepEqual(queued.binding, original.binding);
    assert.equal(queued.pending?.binding?.modeId, other.id);
    const before = f.store.get('conversation', 'one');
    const notifications = f.notifications();
    assert.throws(
      () =>
        f.modes.bind('one', {
          modeId: original.binding!.modeId,
          version: original.binding!.version,
          restoreInstanceId: original.binding!.instanceId,
        }),
      /selected Mod changed/,
    );
    assert.deepEqual(f.store.get('conversation', 'one'), before);
    assert.deepEqual(f.modes.view('one'), queued);
    assert.equal(f.notifications(), notifications);
    f.setBarrier();
    f.modes.recover();
    assert.equal(f.modes.view('one').binding?.modeId, other.id);
  } finally {
    f.db.close();
  }
});

test('Undo preserves an existing active Mod while restoring the previously queued different Mod', () => {
  const f = fixture();
  try {
    const other = { ...manifest(), id: 'example.other' };
    f.modes.import(manifest());
    f.modes.import(other);
    f.modes.install('example.notes', '1.0.0');
    f.modes.install(other.id, other.version);
    const active = f.modes.bind('one', { modeId: 'example.notes' });
    f.setBarrier('running');
    const before = f.modes.bind('one', { modeId: other.id });
    const target = before.pending!.binding!;
    const removed = f.modes.bind('one', { modeId: null });
    assert.deepEqual(removed.binding, active.binding);
    assert.equal(removed.pending?.binding, null);
    f.modes.install(other.id, null);
    const restore = {
      modeId: target.modeId,
      version: target.version,
      restoreInstanceId: target.instanceId,
      restoreFromInstanceId: removed.binding?.instanceId ?? null,
    };
    const restored = f.modes.bind('one', restore);
    assert.deepEqual(restored.binding, active.binding);
    const restoredBinding = restored.pending!.binding!;
    assert.ok(restoredBinding.attachedAt! >= target.attachedAt!);
    assert.deepEqual(restoredBinding, { ...target, attachedAt: restoredBinding.attachedAt });
    assert.equal(restored.pending?.afterWorkflowId, 'running');
    assert.equal(f.store.list('mode-instance', 'one').length, 2);
    f.setBarrier();
    f.modes.recover();
    assert.deepEqual(f.modes.view('one').binding, restoredBinding);
    assert.equal(f.modes.view('one').installed, false);
    assert.deepEqual(
      f.modes.bind('one', restore).binding,
      restoredBinding,
      'restoration stays idempotent after settlement',
    );
  } finally {
    f.db.close();
  }
});

test('Undo with an active binding snapshot cannot overwrite a newer active or pending third Mod', () => {
  for (const queued of [false, true]) {
    const f = fixture();
    try {
      for (const id of ['example.notes', 'example.other', 'example.newer']) {
        f.modes.import({ ...manifest(), id });
        f.modes.install(id, '1.0.0');
      }
      f.modes.bind('one', { modeId: 'example.notes' });
      f.setBarrier('running');
      const before = f.modes.bind('one', { modeId: 'example.other' });
      const target = before.pending!.binding!;
      const removed = f.modes.bind('one', { modeId: null });
      if (!queued) f.setBarrier();
      const newer = f.modes.bind('one', { modeId: 'example.newer' });
      const snapshot = f.store.get('conversation', 'one');
      assert.throws(
        () =>
          f.modes.bind('one', {
            modeId: target.modeId,
            version: target.version,
            restoreInstanceId: target.instanceId,
            restoreFromInstanceId: removed.binding?.instanceId ?? null,
          }),
        /selected Mod changed/,
      );
      assert.deepEqual(f.store.get('conversation', 'one'), snapshot);
      assert.deepEqual(f.modes.view('one'), newer);
    } finally {
      f.db.close();
    }
  }
});

test('removing a hidden Mod clears visibility so re-adding shows the saved instance', () => {
  const f = fixture();
  try {
    f.modes.import(manifest());
    f.modes.install('example.notes', '1.0.0');
    const attached = f.modes.bind('one', { modeId: 'example.notes' });
    f.modes.action('one', {
      instanceId: attached.instance!.id,
      expectedRevision: 0,
      action: { type: 'save', values: { topic: 'retained draft' } },
    });
    f.modes.setHidden('one', { hidden: true });
    f.modes.bind('one', { modeId: null });
    assert.equal(Object.hasOwn(f.store.get<Conversation>('conversation', 'one')!, 'modeHidden'), false);
    const readded = f.modes.bind('one', { modeId: 'example.notes' });
    assert.equal(readded.instance!.id, attached.instance!.id);
    assert.equal(readded.instance!.state.topic, 'retained draft');
    assert.equal(f.store.get<Conversation>('conversation', 'one')!.modeHidden, undefined);
  } finally {
    f.db.close();
  }
});

test('queued removal clears visibility only when applied and cancelling it preserves hidden state', () => {
  const f = fixture();
  try {
    f.modes.import(manifest());
    f.modes.install('example.notes', '1.0.0');
    const attached = f.modes.bind('one', { modeId: 'example.notes' });
    f.modes.setHidden('one', { hidden: true });
    f.setBarrier('running');
    f.modes.bind('one', { modeId: null });
    assert.equal(f.store.get<Conversation>('conversation', 'one')!.modeHidden, true);
    const undo = f.modes.bind('one', {
      modeId: 'example.notes',
      version: '1.0.0',
      restoreInstanceId: attached.instance!.id,
    });
    assert.equal(undo.pending, null);
    assert.equal(f.store.get<Conversation>('conversation', 'one')!.modeHidden, true);
    f.modes.bind('one', { modeId: null });
    f.modes.recover();
    assert.equal(f.store.get<Conversation>('conversation', 'one')!.modeHidden, true);
    f.setBarrier();
    f.modes.settled({ id: 'running', conversationId: 'one', status: 'completed' } as Workflow);
    assert.equal(f.modes.view('one').binding, null);
    assert.equal(Object.hasOwn(f.store.get<Conversation>('conversation', 'one')!, 'modeHidden'), false);
    assert.equal(f.modes.bind('one', { modeId: 'example.notes' }).instance!.id, attached.instance!.id);
    assert.equal(f.store.get<Conversation>('conversation', 'one')!.modeHidden, undefined);
  } finally {
    f.db.close();
  }
});

test('guarded removal rejects another window changing the active or pending Mod', () => {
  for (const queued of [false, true]) {
    const f = fixture();
    try {
      for (const id of ['example.notes', 'example.other']) {
        f.modes.import({ ...manifest(), id });
        f.modes.install(id, '1.0.0');
      }
      const stale = f.modes.bind('one', { modeId: 'example.notes' }).binding!;
      if (queued) f.setBarrier('running');
      else f.modes.bind('one', { modeId: null });
      f.modes.bind('one', { modeId: 'example.other' });
      const snapshot = f.store.get('conversation', 'one');
      const instances = f.store.list('mode-instance', 'one');
      const notices = f.notifications();
      assert.throws(
        () => f.modes.bind('one', { modeId: null, expectedInstanceId: stale.instanceId }),
        (error: unknown) => error instanceof ModeConflict && error.status === 409,
      );
      assert.deepEqual(f.store.get('conversation', 'one'), snapshot);
      assert.deepEqual(f.store.list('mode-instance', 'one'), instances);
      assert.equal(f.notifications(), notices);
    } finally {
      f.db.close();
    }
  }
});

test('guarded removal accepts the effective binding and rejects an already queued removal', () => {
  for (const stage of ['immediate', 'queued-removal', 'pending-only']) {
    const f = fixture();
    try {
      f.modes.import(manifest());
      f.modes.install('example.notes', '1.0.0');
      if (stage === 'pending-only') f.setBarrier('running');
      const attached = f.modes.bind('one', { modeId: 'example.notes' });
      const binding = attached.pending?.binding ?? attached.binding!;
      if (stage === 'queued-removal') f.setBarrier('running');
      f.modes.bind('one', { modeId: null, expectedInstanceId: binding.instanceId });
      const snapshot = f.store.get('conversation', 'one');
      assert.throws(
        () => f.modes.bind('one', { modeId: null, expectedInstanceId: binding.instanceId }),
        (error: unknown) => error instanceof ModeConflict && error.status === 409,
      );
      assert.deepEqual(f.store.get('conversation', 'one'), snapshot);
      assert.equal(f.store.list('mode-instance', 'one').length, 1);
      assert.doesNotThrow(() => f.modes.bind('one', { modeId: null }), 'unguarded legacy requests stay compatible');
    } finally {
      f.db.close();
    }
  }
});

test('removal instance guard is a strict UUID and cannot be used for attachment or Undo', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  assert.equal(modeBindingRequestSchema.safeParse({ modeId: null, expectedInstanceId: id }).success, true);
  for (const expectedInstanceId of [null, '', 'not-a-uuid', 1])
    assert.equal(modeBindingRequestSchema.safeParse({ modeId: null, expectedInstanceId }).success, false);
  for (const body of [
    { modeId: 'example.notes', expectedInstanceId: id },
    { modeId: 'example.notes', version: '1.0.0', restoreInstanceId: id, expectedInstanceId: id },
    { modeId: null, expectedInstanceId: id, extra: true },
  ])
    assert.equal(modeBindingRequestSchema.safeParse(body).success, false);
});

const v2Manifest = (version = '1.0.0'): ModManifestV2 => ({
  schemaVersion: 2,
  id: 'example.notes',
  version,
  title: 'Notes',
  description: 'V2 fixture',
  state: { keys: [{ id: 'notes' }] },
});

test('v2 state enforces declared keys and UTF-8 byte budget and increments revision', () => {
  const f = fixture();
  try {
    const value = v2Manifest();
    value.state = { keys: Array.from({ length: 32 }, (_, i) => ({ id: 'key' + i })) };
    f.modes.import(value);
    f.modes.install(value.id, value.version);
    const bound = f.modes.bind('one', { modeId: value.id });
    assert.equal(bound.instance?.schemaVersion, 2);
    assert.deepEqual(bound.instance?.state, {});
    const save = (values: Record<string, string>, expectedRevision = 0) =>
      f.modes.action('one', { instanceId: bound.instance!.id, expectedRevision, action: { type: 'save', values } });
    assert.throws(() => save({ unknown: 'no' }));
    assert.throws(() => save(Object.fromEntries(Array.from({ length: 33 }, (_, i) => ['key' + i, 'value']))));
    assert.throws(() => save({ key0: '界'.repeat(180000) }));
    const values = Object.fromEntries(value.state.keys.map(({ id }) => [id, 'value']));
    values.key0 = 'x'.repeat(300 * 1024);
    const saved = save(values);
    assert.equal(saved.instance?.revision, 1);
    assert.deepEqual(saved.instance?.state, values);
    assert.equal(f.modes.capture('one')?.revision, 1);
  } finally {
    f.db.close();
  }
});

test('version upgrades copy only known state keys and reset revision; v1 limits fall back to defaults', () => {
  const f = fixture();
  try {
    const old = v2Manifest();
    old.state!.keys.push({ id: 'removed' });
    f.modes.import(old);
    f.modes.install(old.id, old.version);
    let bound = f.modes.bind('one', { modeId: old.id });
    f.modes.action('one', {
      instanceId: bound.instance!.id,
      expectedRevision: 0,
      action: { type: 'save', values: { notes: 'kept', removed: 'discard' } },
    });
    const next = v2Manifest('1.1.0');
    next.contributions = {
      rightPanel: {
        kind: 'form',
        form: { fields: [{ id: 'notes', type: 'textarea', label: 'Notes', initialValue: 'new default' }], actions: [] },
      },
    };
    f.modes.import(next);
    f.modes.install(next.id, next.version);
    bound = f.modes.bind('one', { modeId: next.id });
    assert.deepEqual(bound.instance?.state, { notes: 'kept' });
    assert.equal(bound.instance?.revision, 0);
    f.modes.action('one', {
      instanceId: bound.instance!.id,
      expectedRevision: 0,
      action: { type: 'save', values: { notes: 'x'.repeat(8001) } },
    });
    // Make the latest row deterministic, even on systems with coarse wall-clock precision.
    f.db
      .prepare("UPDATE workspace_records SET updated_at='2099-01-01' WHERE kind='mode-instance' AND id=?")
      .run(bound.instance!.id);
    const legacy = manifest('1.2.0');
    legacy.view.fields = [{ id: 'notes', label: 'Notes', type: 'textarea', initialValue: 'fallback' }];
    f.modes.import(legacy);
    // The v1 form adds a compose action, so this update asks once for composer:draft.
    assert.throws(() => f.modes.install(legacy.id, legacy.version), /approval/);
    f.modes.install(legacy.id, legacy.version, ['composer:draft']);
    bound = f.modes.bind('one', { modeId: legacy.id });
    assert.deepEqual(bound.instance?.state, { notes: 'fallback' });
    assert.equal(bound.instance?.schemaVersion, 1);
    assert.equal(bound.instance?.revision, 0);
  } finally {
    f.db.close();
  }
});

test('catalog SQL returns complete metadata without reading manifest bodies and accepts wide v1 titles', () => {
  const f = fixture();
  try {
    const legacy = { ...manifest(), title: 'N'.repeat(100) };
    f.modes.import(legacy);
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWMwTptpnDYTAAeZAmUGcC4NAAAAAElFTkSuQmCC',
      'base64',
    );
    png.writeUInt32BE(64, 16);
    png.writeUInt32BE(64, 20);
    png[25] = 6;
    const logo = { src: 'data:image/png;base64,' + png.toString('base64'), alt: 'Notes' };
    const value: ModManifestV2 = {
      ...v2Manifest(),
      id: 'example.web',
      logo,
      permissions: ['chat:read', 'composer:draft'],
      readme: 'Not in catalog',
      ui: { entries: { panel: { html: '<p>notes</p>' } } },
      contributions: { rightPanel: { kind: 'web', entry: 'panel' } },
    };
    f.modes.import(value);
    const originalList = f.store.list.bind(f.store);
    f.store.list = ((kind: string, ...args: unknown[]) => {
      assert.notEqual(kind, 'mode-manifest');
      return originalList(kind, ...(args as [string?, number?]));
    }) as typeof f.store.list;
    const result = f.modes.catalog();
    assert.equal(catalogResponse.safeParse(result).success, true);
    const old = result.catalog.find((item) => item.id === legacy.id)!;
    assert.equal(old.title.length, 100);
    assert.equal(Object.hasOwn(old, 'author'), false);
    const item = result.catalog.find((entry) => entry.id === value.id)!;
    assert.deepEqual(item.logo, logo);
    assert.deepEqual(item.permissions, value.permissions);
    assert.equal(item.schemaVersion, 2);
    for (const key of ['readme', 'view', 'ui', 'state', 'contributions']) assert.equal(Object.hasOwn(item, key), false);
  } finally {
    f.db.close();
  }
});

test('import keeps an uninstalled removed instance version for Undo', () => {
  const f = fixture();
  try {
    const old = manifest('1.0.0');
    f.modes.import(old);
    f.modes.install(old.id, old.version);
    const attached = f.modes.bind('one', { modeId: old.id });
    f.modes.action('one', {
      instanceId: attached.instance!.id,
      expectedRevision: 0,
      action: { type: 'save', values: { topic: 'saved' } },
    });
    f.modes.install(old.id, null);
    f.modes.bind('one', { modeId: null, expectedInstanceId: attached.instance!.id });
    f.modes.import(manifest('1.1.0'));
    assert.deepEqual(f.modes.export(old.id, old.version), old);
    const restored = f.modes.bind('one', {
      modeId: old.id,
      version: old.version,
      restoreInstanceId: attached.instance!.id,
    });
    assert.equal(restored.binding?.instanceId, attached.instance!.id);
    assert.equal(restored.instance?.state.topic, 'saved');
    assert.equal(restored.installed, false);
  } finally {
    f.db.close();
  }
});

test('import prunes only older uninstalled versions without current or queued bindings', () => {
  const f = fixture();
  try {
    f.modes.import(manifest('1.0.0'));
    f.modes.install('example.notes', '1.0.0');
    f.modes.bind('one', { modeId: 'example.notes' });
    f.modes.import(manifest('1.1.0'));
    f.modes.install('example.notes', '1.1.0');
    f.setBarrier('busy');
    f.modes.bind('two', { modeId: 'example.notes' });
    f.modes.import(manifest('1.2.0'));
    f.modes.install('example.notes', '1.2.0');
    f.modes.import(manifest('1.3.0'));
    f.modes.import(manifest('1.4.0'));
    assert.deepEqual(
      f.modes
        .catalog()
        .catalog.map((entry) => entry.version)
        .sort(),
      ['1.0.0', '1.1.0', '1.2.0', '1.4.0'],
    );
    // Importing an older version never prunes a newer one.
    f.modes.import(manifest('1.3.0'));
    assert.ok(f.modes.export('example.notes', '1.4.0'));
    // Loads moved both chats; the busy one switches after its turn.
    assert.equal(f.modes.view('one').binding?.version, '1.1.0');
    assert.equal(f.modes.view('one').pending?.binding?.version, '1.2.0');
    assert.equal(f.modes.view('two').pending?.binding?.version, '1.2.0');
  } finally {
    f.db.close();
  }
});

test('catalog marks a Mod built in a Mods author workspace as a local build, with its chat', () => {
  const { store, modes } = fixture();
  modes.import(manifest('1.0.0'));
  modes.import({ ...manifest('1.0.0'), id: 'example.other' });
  const record = (conversationId: string, at: string) => ({
    id: 'a1b2c3d4e5',
    conversationId,
    path: '/synthetic/mods-workspace/a1b2c3d4e5',
    modId: 'example.notes',
    createdAt: at,
  });
  store.save('mod-workspace', 'a1b2c3d4e5', 'mods', record('one', '2026-11-04T00:00:00Z'));
  const entry = (id: string) => modes.catalog().catalog.find((item) => item.id === id)!;
  assert.deepEqual(entry('example.notes').localBuild, {
    workspaceId: 'a1b2c3d4e5',
    conversationId: 'one',
    conversationTitle: 'one',
  });
  assert.equal(entry('example.other').localBuild, undefined, 'imported Mods are not local builds');
  // A deleted chat keeps the build; the Store offers a new chat instead.
  const chat = store.get<Conversation>('conversation', 'one')!;
  store.save('conversation', 'one', 'project', { ...chat, deletedAt: '2026-11-04T01:00:00Z', incognito: true });
  assert.deepEqual(entry('example.notes').localBuild, {
    workspaceId: 'a1b2c3d4e5',
    conversationId: 'one',
    incognito: true,
  });
});
