import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { listenForFetch } from './helpers/fetch-port.ts';
import { ConversationModes, ModeApprovalRequired } from '../src/server/conversation-modes.ts';
import { registerConversationModeRoutes } from '../src/server/conversation-mode-routes.ts';
import { ModRunError, ModRuns } from '../src/server/mod-runs.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { modPermissionsToApprove, type ModManifestV2, type ModPermission } from '../src/shared/mods-manifest.ts';
import type { Conversation, ConversationMessage, MessageInput, Project, Workflow } from '../src/shared/types.ts';

// Synthetic Mods and a fake task runner only: nothing here reaches a model, an account or the network.
const mod = (version = '1.0.0', permissions: ModPermission[] = ['model:run']): ModManifestV2 => ({
  schemaVersion: 2,
  id: 'example.coach',
  version,
  title: 'Coach',
  description: 'Synthetic speaking coach.',
  permissions,
  state: { keys: [{ id: 'notes' }, { id: 'feedback' }] },
});

function fixture() {
  const db = new DatabaseSync(':memory:');
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  store.save('project', 'project', 'project', {
    id: 'project',
    name: 'Fixture',
    path: '/synthetic/project',
    createdAt: '',
    updatedAt: '',
  } satisfies Project);
  const add = (id: string, extra: Partial<Conversation> = {}) =>
    store.save('conversation', id, 'project', {
      id,
      projectId: 'project',
      title: id,
      createdAt: '2026-10-30T00:00:00Z',
      updatedAt: '2026-10-30T00:00:00Z',
      ...extra,
    } satisfies Conversation);
  add('one', { routing: { automaticExecutors: ['codex'] } as Conversation['routing'] });
  add('two');
  add('private', { incognito: true, memory: 'off' });
  const requireConversation = (id: string) => {
    const value = store.get<Conversation>('conversation', id);
    if (!value || value.deletedAt) throw new Error('Conversation unavailable');
    return value;
  };
  let barrier: string | undefined;
  const modes = new ConversationModes({
    store,
    requireConversation,
    modeSwitchBarrier: () => barrier,
    notify() {},
  });
  const sent: { conversationId: string; input: MessageInput; workflow: Workflow }[] = [];
  const cancelled: string[] = [];
  const discarded: string[] = [];
  let helpers = 0;
  let workflows = 0;
  const runs = new ModRuns({
    store,
    modes,
    requireConversation,
    async createHelper(title, incognito) {
      const id = `helper-${++helpers}`;
      add(id, { title, ...(incognito ? { incognito: true } : {}), memory: 'off' });
      return requireConversation(id);
    },
    async send(conversationId, input) {
      const workflow = {
        id: `workflow-${++workflows}`,
        conversationId,
        status: 'running',
      } as Workflow;
      store.save('workflow', workflow.id, conversationId, workflow);
      sent.push({ conversationId, input, workflow });
      return { workflow };
    },
    cancel: (id) => cancelled.push(id),
    discardHelper: (id) => discarded.push(id),
    notify() {},
  });
  /** Finishes a fake task the way the workspace does: final assistant message, then the settle hook. */
  const finish = (workflowId: string, text: string, status: Workflow['status'] = 'completed') => {
    const entry = sent.find((item) => item.workflow.id === workflowId)!;
    const message = {
      id: `message-${workflowId}`,
      conversationId: entry.conversationId,
      role: 'assistant',
      content: text,
      createdAt: '2026-10-30T00:00:01Z',
    } as ConversationMessage;
    store.save('message', message.id, entry.conversationId, message);
    const workflow = { ...entry.workflow, status, finalMessageId: message.id } as Workflow;
    store.save('workflow', workflow.id, entry.conversationId, workflow);
    runs.settled(workflow);
  };
  return {
    db,
    store,
    modes,
    runs,
    sent,
    cancelled,
    discarded,
    finish,
    setBarrier: (value?: string) => (barrier = value),
  };
}
const instance = (f: ReturnType<typeof fixture>, id = 'one') => f.modes.view(id).instance!;

test('loading asks for approval permissions once; declared-only permissions never reach the model', async () => {
  const f = fixture();
  try {
    f.modes.import(mod());
    assert.deepEqual(modPermissionsToApprove(['chat:read', 'model:run']), ['model:run']);
    assert.throws(
      () => f.modes.install('example.coach', '1.0.0'),
      (error) => error instanceof ModeApprovalRequired && error.permissions.join() === 'model:run',
    );
    f.modes.install('example.coach', '1.0.0', ['model:run']);
    f.modes.bind('one', { modeId: 'example.coach' });
    assert.deepEqual(f.modes.view('one').granted, ['model:run']);

    // A Mod without the permission is refused before any task exists.
    f.modes.import(mod('0.9.0', []));
    f.modes.install('example.coach', '0.9.0');
    f.modes.bind('two', { modeId: 'example.coach', version: '0.9.0' });
    await assert.rejects(
      f.runs.start('two', { instanceId: instance(f, 'two').id, prompt: 'Hi' }),
      (error) => error instanceof ModRunError && error.code === 'E_PERMISSION',
    );
    assert.equal(f.sent.length, 0);
  } finally {
    f.db.close();
  }
});

test('a run is an ordinary tool-less task in a hidden helper chat and its result is saved to the named key', async () => {
  const f = fixture();
  try {
    f.modes.import(mod());
    f.modes.install('example.coach', '1.0.0', ['model:run']);
    f.modes.bind('one', { modeId: 'example.coach' });
    f.modes.action('one', {
      instanceId: instance(f).id,
      expectedRevision: 0,
      action: { type: 'save', values: { notes: 'mine' } },
    });
    const { runId } = await f.runs.start('one', {
      instanceId: instance(f).id,
      prompt: 'Correct: I goed home.',
      saveTo: 'feedback',
      format: 'json',
    });
    const [first] = f.sent;
    assert.equal(first!.conversationId, 'helper-1');
    assert.equal(first!.input.untrustedContent, true);
    assert.equal(first!.input.permissionMode, 'read-only');
    assert.equal(first!.input.executionPolicy, 'cli-first');
    assert.deepEqual(first!.input.automaticExecutors, ['codex']);
    assert.match(first!.input.content, /Mod "Coach"/);
    assert.match(first!.input.content, /I goed home/);
    assert.equal(f.modes.view('one').runs?.[0]?.status, 'running');

    f.finish(runId, '```json\n{"fix":"I went home."}\n```');
    const view = f.modes.view('one');
    assert.deepEqual(view.instance?.state, { notes: 'mine', feedback: '{"fix":"I went home."}' });
    assert.equal(view.instance?.revision, 2);
    assert.equal(view.runs?.[0]?.status, 'completed');
    assert.ok(f.store.get<Conversation>('conversation', 'one')?.modeRunsAt);

    // Follow-up runs share the helper; fresh starts another one.
    await f.runs.start('one', { instanceId: instance(f).id, prompt: 'Next' });
    await f.runs.start('one', { instanceId: instance(f).id, prompt: 'New topic', fresh: true });
    assert.equal(f.sent[1]!.conversationId, 'helper-1');
    assert.equal(f.sent[2]?.conversationId, 'helper-2');
  } finally {
    f.db.close();
  }
});

test('bad JSON, oversized results, limits and cancel leave saved state alone', async () => {
  const f = fixture();
  try {
    f.modes.import(mod());
    f.modes.install('example.coach', '1.0.0', ['model:run']);
    f.modes.bind('one', { modeId: 'example.coach' });
    const id = instance(f).id;
    const json = await f.runs.start('one', { instanceId: id, prompt: 'x', saveTo: 'feedback', format: 'json' });
    f.finish(json.runId, 'Sure! Here is the JSON you wanted.');
    assert.equal(f.modes.view('one').runs?.[0]?.error, 'E_FORMAT');
    assert.equal(instance(f).revision, 0);

    await assert.rejects(f.runs.start('one', { instanceId: id, prompt: 'x', saveTo: 'other' }), { code: 'E_INVALID' });
    await assert.rejects(f.runs.start('one', { instanceId: 'b4b7a9b8-5d8e-4c39-8a43-5a3a8c1f0000', prompt: 'x' }), {
      code: 'E_UNAVAILABLE',
    });
    const a = await f.runs.start('one', { instanceId: id, prompt: 'a' });
    await f.runs.start('one', { instanceId: id, prompt: 'b' });
    await assert.rejects(f.runs.start('one', { instanceId: id, prompt: 'c' }), { code: 'E_LIMIT' });
    f.runs.cancel('one', a.runId);
    assert.deepEqual(f.cancelled, [a.runId]);
    assert.equal(f.modes.view('one').runs?.find((run) => run.id === a.runId)?.status, 'cancelled');
    // A late completion of a cancelled run changes nothing.
    f.finish(a.runId, 'late');
    assert.equal(f.modes.view('one').runs?.find((run) => run.id === a.runId)?.status, 'cancelled');
    assert.throws(() => f.runs.cancel('two', a.runId), { code: 'E_INVALID' });
  } finally {
    f.db.close();
  }
});

test('an incognito chat gets a new incognito helper for each run, discarded once the answer is in', async () => {
  const f = fixture();
  try {
    f.modes.import(mod());
    f.modes.install('example.coach', '1.0.0', ['model:run']);
    f.modes.bind('private', { modeId: 'example.coach' });
    const first = await f.runs.start('private', { instanceId: instance(f, 'private').id, prompt: 'one' });
    f.finish(first.runId, 'answer');
    await f.runs.start('private', { instanceId: instance(f, 'private').id, prompt: 'two' });
    assert.deepEqual(
      f.sent.map((item) => item.conversationId),
      ['helper-1', 'helper-2'],
    );
    assert.equal(f.store.get<Conversation>('conversation', 'helper-1')?.incognito, true);
    assert.deepEqual(f.discarded, ['helper-1']);
    assert.equal(f.store.list('mod-helper', 'private').length, 0);
  } finally {
    f.db.close();
  }
});

test('a newer version moves bound chats unless it needs new permissions, then asks once', async () => {
  const f = fixture();
  try {
    f.modes.import(mod('1.0.0', []));
    f.modes.install('example.coach', '1.0.0');
    f.modes.bind('one', { modeId: 'example.coach' });
    f.modes.action('one', {
      instanceId: instance(f).id,
      expectedRevision: 0,
      action: { type: 'save', values: { notes: 'kept' } },
    });
    f.setBarrier('busy');
    f.modes.bind('two', { modeId: 'example.coach' });
    f.setBarrier(undefined);

    // Same permissions: moved straight away, saved keys carried over.
    f.modes.import(mod('1.1.0', []));
    f.modes.install('example.coach', '1.1.0');
    assert.equal(f.modes.view('one').binding?.version, '1.1.0');
    assert.deepEqual(instance(f).state, { notes: 'kept' });
    // A switch queued behind a turn that has since ended now happens directly.
    assert.equal(f.modes.view('two').binding?.version, '1.1.0');
    assert.equal(f.modes.view('two').pending, null);

    // New permissions: nothing moves until the user approves, once for every chat.
    f.modes.import(mod('2.0.0', ['model:run']));
    assert.throws(() => f.modes.install('example.coach', '2.0.0'), ModeApprovalRequired);
    assert.equal(f.modes.view('one').binding?.version, '1.1.0');
    f.modes.install('example.coach', '2.0.0', ['model:run']);
    assert.equal(f.modes.view('one').binding?.version, '2.0.0');
    assert.deepEqual(f.modes.view('one').granted, ['model:run']);

    // An approved permission carries into the next update without asking again.
    f.modes.import(mod('2.1.0', ['model:run']));
    f.modes.install('example.coach', '2.1.0');
    assert.deepEqual(f.modes.view('one').granted, ['model:run']);

    // A result arriving after an update lands in the chat's new instance.
    const { runId } = await f.runs.start('one', { instanceId: instance(f).id, prompt: 'x', saveTo: 'feedback' });
    f.modes.import(mod('2.2.0', ['model:run']));
    f.modes.install('example.coach', '2.2.0');
    f.finish(runId, 'Well done.');
    assert.equal(instance(f).version, '2.2.0');
    assert.equal(instance(f).state.feedback, 'Well done.');

    // Loading an older version never moves chats backwards.
    f.modes.install('example.coach', '2.1.0');
    assert.equal(f.modes.view('one').binding?.version, '2.2.0');
  } finally {
    f.db.close();
  }
});

test('HTTP: runs and approvals return fixed public codes', async (t) => {
  const f = fixture();
  const app = express();
  app.use(express.json());
  registerConversationModeRoutes(app, f.modes, f.runs);
  const server = createServer(app);
  await listenForFetch(server);
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.db.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, method: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  f.modes.import(mod());
  const refused = await call('/api/modes/example.coach/install', 'POST', { version: '1.0.0' });
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body, {
    error: 'This Mod version needs your approval for new permissions',
    code: 'E_APPROVAL',
    permissions: ['model:run'],
  });
  const loaded = await call('/api/modes/example.coach/install', 'POST', {
    version: '1.0.0',
    approvedPermissions: ['model:run'],
  });
  assert.equal(loaded.status, 200);
  f.modes.bind('one', { modeId: 'example.coach' });
  const started = await call('/api/conversations/one/mode-runs', 'POST', {
    instanceId: instance(f).id,
    prompt: 'Hello',
  });
  assert.equal(started.status, 200);
  assert.equal(typeof started.body.runId, 'string');
  const invalid = await call('/api/conversations/one/mode-runs', 'POST', { instanceId: instance(f).id, prompt: '' });
  assert.deepEqual(invalid, { status: 400, body: { error: 'Invalid request.', code: 'E_INVALID' } });
  const cancelled = await call(`/api/conversations/one/mode-runs/${started.body.runId as string}`, 'DELETE');
  assert.equal(cancelled.status, 200);
});
