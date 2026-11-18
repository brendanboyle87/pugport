import { listenForFetch } from './helpers/fetch-port.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import express from 'express';
import { registerRoutingProfileRoutes } from '../src/server/routing-profile-routes.ts';
import { RoutingProfiles } from '../src/server/routing-profiles.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import type { Settings } from '../src/shared/types.ts';

test('profile HTTP uses bounded rules, preserves authentication and only changes the requested chat', async (t) => {
  const db = new DatabaseSync(':memory:');
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  let settings = {} as Settings;
  const profiles = new RoutingProfiles({
    store,
    settings: () => settings,
    save: (patch) => {
      settings = { ...settings, ...patch };
    },
  });
  const changed: { id: string; profileId: string | null }[] = [];
  const inherited: string[] = [];
  const projects: { id: string; profileId: string | null }[] = [];
  const compilations: string[] = [];
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => (req.headers['x-agent-token'] === 'synthetic' ? next() : void res.sendStatus(401)));
  registerRoutingProfileRoutes(
    app,
    profiles,
    {
      inheritRoutingProfile: (id) => {
        inherited.push(id);
        return { id } as never;
      },
      setProjectRoutingProfile: (id, profileId) => {
        projects.push({ id, profileId });
        return { id } as never;
      },
      setRoutingProfile: (id, profileId) => {
        changed.push({ id, profileId });
        return { id, routingProfileId: profileId ?? undefined } as never;
      },
    },
    async ({ text }) => {
      compilations.push(text);
      return {
        draft: { version: 2, text, rules: [], unparsed: [], chapterAgents: false, mask: false },
        fallback: false,
      };
    },
  );
  app.use(
    (error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
      res.status(error.status ?? 400).json({ error: error.message }),
  );
  const server = await listenForFetch(createServer(app));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
  const port = (server.address() as { port: number }).port;
  const request = (path: string, body?: unknown, method = 'GET', authenticated = true) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(authenticated ? { 'x-agent-token': 'synthetic' } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const id = randomUUID();
  assert.equal(
    (await request('/api/routing-profiles/compile', { text: 'Plan with Claude' }, 'POST', false)).status,
    401,
  );
  assert.equal((await request('/api/routing-profiles/compile', { text: 'x'.repeat(4001) }, 'POST')).status, 400);
  assert.equal((await request('/api/routing-profiles/compile', { text: 'Plan', cards: [] }, 'POST')).status, 400);
  assert.equal(
    (
      await request(
        '/api/routing-profiles/compile',
        { text: 'Plan', categories: [{ id: 'invalid', label: 'x' }] },
        'POST',
      )
    ).status,
    400,
  );
  const compiled = await request('/api/routing-profiles/compile', { text: 'Plan with Claude' }, 'POST');
  assert.equal(compiled.status, 200);
  assert.equal((await compiled.json()).draft.text, 'Plan with Claude');
  assert.deepEqual(compilations, ['Plan with Claude']);
  assert.deepEqual(profiles.list(), []);
  const value = {
    name: 'Everyday',
    rules: { version: 2, text: 'Use connected accounts', rules: [], unparsed: [], updatedAt: new Date().toISOString() },
  };
  assert.equal((await request('/api/routing-profiles', undefined, 'GET', false)).status, 401);
  assert.equal((await request(`/api/routing-profiles/${id}`, value, 'PUT')).status, 200);
  assert.equal((await (await request('/api/routing-profiles')).json()).profiles[0].name, 'Everyday');
  assert.equal((await request(`/api/routing-profiles/${id}`, { ...value, unexpected: true }, 'PUT')).status, 400);
  assert.equal((await request('/api/conversations/one/routing-profile', { profileId: id }, 'PATCH')).status, 200);
  assert.equal(
    (await request('/api/conversations/two/routing-profile', { profileId: 'not-a-profile' }, 'PATCH')).status,
    400,
  );
  assert.equal((await request('/api/conversations/one/routing-profile', { profileId: null }, 'PATCH')).status, 200);
  assert.deepEqual(changed, [
    { id: 'one', profileId: id },
    { id: 'one', profileId: null },
  ]);
  assert.equal(
    (await request('/api/conversations/one/routing-profile', { inheritProject: true }, 'PATCH')).status,
    200,
  );
  assert.equal(
    (await request('/api/conversations/one/routing-profile', { inheritProject: true, profileId: null }, 'PATCH'))
      .status,
    400,
  );
  assert.equal(
    (await request('/api/conversations/one/routing-profile', { inheritProject: false }, 'PATCH')).status,
    400,
  );
  assert.deepEqual(inherited, ['one']);
  assert.equal((await request('/api/projects/project/routing-profile', { profileId: id }, 'PATCH', false)).status, 401);
  assert.equal((await request('/api/projects/project/routing-profile', { profileId: id }, 'PATCH')).status, 200);
  assert.equal((await request('/api/projects/project/routing-profile', { profileId: 'invalid' }, 'PATCH')).status, 400);
  assert.equal((await request('/api/projects/project/routing-profile', { profileId: null }, 'PATCH')).status, 200);
  assert.deepEqual(projects, [
    { id: 'project', profileId: id },
    { id: 'project', profileId: null },
  ]);
  assert.equal((await request(`/api/routing-profiles/${id}`, undefined, 'DELETE')).status, 200);
  assert.deepEqual((await (await request('/api/routing-profiles')).json()).profiles, []);
});
