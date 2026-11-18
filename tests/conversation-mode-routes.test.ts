import { listenForFetch } from './helpers/fetch-port.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { ConversationModes } from '../src/server/conversation-modes.ts';
import { registerConversationModeRoutes } from '../src/server/conversation-mode-routes.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import type { Conversation, Project } from '../src/shared/types.ts';

test('mode HTTP endpoints validate imports and revision conflicts without executing actions', async (t) => {
  const db = new DatabaseSync(':memory:');
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  const project: Project = { id: 'project', name: 'Fixture', path: '/synthetic/project', createdAt: '', updatedAt: '' };
  store.save('project', project.id, project.id, project);
  store.save('conversation', 'one', 'project', {
    id: 'one',
    projectId: 'project',
    title: 'one',
    createdAt: '',
    updatedAt: '',
  } satisfies Conversation);
  const modes = new ConversationModes({
    store,
    requireConversation: (id) => {
      const value = store.get<Conversation>('conversation', id);
      if (!value) throw new Error('missing');
      return value;
    },
    modeSwitchBarrier: () => undefined,
    notify() {},
  });
  const app = express();
  app.use((req, res, next) => {
    if (req.headers.authorization !== 'Bearer fixture') {
      res.sendStatus(403);
      return;
    }
    next();
  });
  app.use('/api/modes/import', express.json({ limit: '1100kb' }));
  app.use('/api/conversations/:id/mode-actions', express.json({ limit: '600kb' }));
  app.use(express.json({ limit: '256kb' }));
  registerConversationModeRoutes(app, modes, {
    start: async () => ({ runId: 'unused' }),
    cancel() {},
  });
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ error: 'invalid request' });
  });
  const server = createServer(app);
  await listenForFetch(server);
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, method = 'GET', value?: unknown) =>
    fetch(base + path, {
      method,
      headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
  assert.equal((await fetch(base + '/api/modes')).status, 403);
  assert.equal(
    (
      await fetch(base + '/api/conversations/one/mode/visibility', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hidden: true }),
      })
    ).status,
    403,
  );
  assert.equal((await request('/api/conversations/one/mode/visibility', 'PUT', { hidden: true })).status, 409);
  assert.equal((await request('/api/conversations/missing/mode/visibility', 'PUT', { hidden: true })).status, 400);
  assert.deepEqual(await (await request('/api/modes')).json(), { catalog: [], installed: [] });
  const manifest = {
    schemaVersion: 1,
    id: 'example.form',
    version: '1.0.0',
    title: 'Form',
    description: 'fixture',
    category: 'Notes',
    view: { fields: [{ id: 'topic', type: 'text', label: 'Topic' }], actions: [] },
  };
  assert.equal(
    (await request('/api/modes/import', 'POST', { manifest: { ...manifest, script: 'unsafe' } })).status,
    400,
  );
  assert.equal((await request('/api/modes/import', 'POST', { manifest })).status, 200);
  assert.equal((await (await request('/api/modes')).json()).catalog[0].category, 'Notes');
  assert.equal((await request('/api/conversations/one/mode', 'PUT', { modeId: manifest.id })).status, 409);
  assert.equal(
    (await request('/api/modes/example.form/install', 'POST', { version: '1.0.0', command: 'unsafe' })).status,
    400,
  );
  assert.equal((await request('/api/modes/example.form/install', 'POST', { version: '1.0.0' })).status, 200);
  assert.equal((await request('/api/conversations/one/mode', 'PUT', { modeId: manifest.id })).status, 200);
  for (const body of [{}, [], { hidden: 'true' }, { hidden: 1 }, { hidden: null }, { hidden: true, extra: true }])
    assert.equal((await request('/api/conversations/one/mode/visibility', 'PUT', body)).status, 400);
  const visibility = await request('/api/conversations/one/mode/visibility', 'PUT', { hidden: true });
  assert.equal(visibility.status, 200);
  const hidden = await visibility.json();
  assert.equal(hidden.id, 'one');
  assert.equal(hidden.modeHidden, true);
  assert.equal(store.get<Conversation>('conversation', 'one')?.modeHidden, true);
  assert.equal(Object.hasOwn(await (await request('/api/conversations/one/mode')).json(), 'hidden'), false);
  const visible = await request('/api/conversations/one/mode/visibility', 'PUT', { hidden: false });
  assert.equal(visible.status, 200);
  assert.equal(Object.hasOwn(await visible.json(), 'modeHidden'), false);
  assert.equal(store.get<Conversation>('conversation', 'one')?.modeHidden, undefined);
  assert.equal(
    (
      await request('/api/conversations/one/mode-actions', 'POST', {
        instanceId: modes.view('one').instance!.id,
        expectedRevision: 0,
        action: { type: 'save', values: { topic: 'saved' } },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request('/api/conversations/one/mode-actions', 'POST', {
        instanceId: modes.view('one').instance!.id,
        expectedRevision: 0,
        action: { type: 'save', values: { topic: 'stale' } },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request('/api/conversations/one/mode-actions', 'POST', {
        instanceId: modes.view('one').instance!.id,
        expectedRevision: 1,
        action: { type: 'execute', command: 'unsafe' },
      })
    ).status,
    400,
  );
  assert.equal((await request('/api/modes/example.form/install', 'DELETE')).status, 200);
  const state = await (await request('/api/conversations/one/mode')).json();
  assert.equal(state.instance.state.topic, 'saved');
  assert.equal(state.manifest.version, '1.0.0');
  assert.equal(state.installed, false);
  assert.equal((await request('/api/conversations/one/mode/visibility', 'PUT', { hidden: true })).status, 200);
  assert.equal((await request('/api/conversations/one/mode', 'PUT', { modeId: null })).status, 200);
  const restore = { modeId: manifest.id, version: manifest.version, restoreInstanceId: state.instance.id };
  for (const body of [
    { modeId: manifest.id, restoreInstanceId: state.instance.id },
    { ...restore, restoreInstanceId: 'bad' },
    { ...restore, extra: true },
  ])
    assert.equal((await request('/api/conversations/one/mode', 'PUT', body)).status, 400);
  const restored = await request('/api/conversations/one/mode', 'PUT', restore);
  assert.equal(restored.status, 200);
  assert.deepEqual((await restored.json()).instance, state.instance);
  assert.equal(modes.catalog().installed.length, 0);
  const exportUrl = '/api/modes/example.form/versions/1.0.0/export';
  assert.equal((await fetch(base + exportUrl)).status, 403);
  const download = await request(exportUrl);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-disposition'), 'attachment; filename="example.form-1.0.0.json"');
  assert.deepEqual(await download.json(), manifest);
  assert.equal((await request('/api/modes/example.form/versions/2.0.0/export')).status, 409);
  assert.equal((await request('/api/modes/example.form/versions/bad/export')).status, 400);
  const v2 = {
    schemaVersion: 2,
    id: 'example.web',
    version: '2.0.0',
    title: 'Web',
    description: 'fixture',
    license: 'MIT',
    permissions: ['chat:read'],
    state: { keys: [{ id: 'notes' }] },
    ui: { entries: { panel: { html: '<textarea></textarea>', js: ' '.repeat(256 * 1024) } } },
    contributions: { rightPanel: { kind: 'web', entry: 'panel' } },
  };
  assert.equal((await request('/api/modes/import', 'POST', { manifest: v2 })).status, 200);
  assert.deepEqual(await (await request('/api/modes/example.web/versions/2.0.0/export')).json(), v2);
  assert.equal((await request('/api/modes/example.web/install', 'POST', { version: '2.0.0' })).status, 200);
  const v2bound = await (await request('/api/conversations/one/mode', 'PUT', { modeId: v2.id })).json();
  assert.equal(
    (
      await request('/api/conversations/one/mode-actions', 'POST', {
        instanceId: v2bound.instance.id,
        expectedRevision: 0,
        action: { type: 'save', values: { notes: 'x'.repeat(300 * 1024) } },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request('/api/conversations/one/mode-actions', 'POST', {
        instanceId: v2bound.instance.id,
        expectedRevision: 1,
        action: { type: 'save', values: { unknown: 'x' } },
      })
    ).status,
    400,
  );
  await request('/api/conversations/one/mode', 'PUT', {
    modeId: manifest.id,
    version: manifest.version,
    restoreInstanceId: state.instance.id,
    restoreFromInstanceId: v2bound.instance.id,
  });
  assert.equal(store.list('workflow').length, 0);
  assert.equal(store.list('message').length, 0);
  store.save('conversation', 'one', project.id, { ...store.get<Conversation>('conversation', 'one')!, swarm: true });
  assert.equal((await request('/api/conversations/one/mode/visibility', 'PUT', { hidden: false })).status, 409);
  assert.equal((await request('/api/modes/example.form/install', 'POST', { version: '1.0.0' })).status, 200);
  assert.equal((await request('/api/conversations/one/mode', 'PUT', { modeId: manifest.id })).status, 409);
  assert.equal(
    (
      await request('/api/conversations/one/mode-actions', 'POST', {
        instanceId: state.instance.id,
        expectedRevision: state.instance.revision,
        action: { type: 'save', values: { topic: 'blocked' } },
      })
    ).status,
    409,
  );
  assert.equal((await (await request('/api/conversations/one/mode')).json()).instance.state.topic, 'saved');
  assert.equal((await request('/api/conversations/one/mode', 'PUT', { modeId: null })).status, 200);
});
