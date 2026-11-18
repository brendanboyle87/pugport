import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { AdmissionRules } from '../src/server/external-admission.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import express, { type ErrorRequestHandler } from 'express';
import type { AddressInfo } from 'node:net';
import type { Controller } from '../src/server/controller.ts';
import { githubRoutes } from '../src/server/github-routes.ts';
import { listenForFetch } from './helpers/fetch-port.ts';

test('GitHub routes return public status and strictly validate settings updates', async (t) => {
  const updates: unknown[] = [],
    toggles: boolean[] = [];
  let enabled = false;
  const status = async () => ({
    enabled,
    state: enabled ? ('connected' as const) : ('off' as const),
    ...(enabled ? { login: 'octocat' } : {}),
  });
  const app = express();
  app.use(express.json());
  const store = new WorkspaceStore(new DatabaseSync(':memory:'), { recoverInterrupted: false });
  const rules = new AdmissionRules(store, 'github');
  githubRoutes(
    app,
    {
      updateSettings: async (value: unknown) => {
        updates.push(value);
      },
    } as Pick<Controller, 'updateSettings'>,
    {
      status,
      setEnabled: async (on) => {
        toggles.push(on);
        enabled = on;
        return status();
      },
    },
    rules,
  );
  app.use(((_err, _req, res, _next) => res.status(400).json({ error: 'Invalid request' })) as ErrorRequestHandler);
  const server = await listenForFetch(app);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/api/github';
  const admissionUrl = url + '/admission';
  assert.deepEqual(await (await fetch(admissionUrl)).json(), { version: 1, rules: [] });
  const putRules = (body: unknown) =>
    fetch(admissionUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const value = { version: 1, rules: [{ source: 'github', scope: 'issue', senderClass: 'trusted', level: 'L3' }] };
  assert.equal((await putRules(value)).status, 200);
  assert.deepEqual(rules.read(), value);
  assert.equal((await putRules({ version: 1, rules: [{ source: 'slack', scope: 'dm', level: 'L1' }] })).status, 400);
  assert.equal((await putRules({ version: 1, rules: [] })).status, 200);
  assert.deepEqual(rules.read().rules, []);
  const get = await fetch(url);
  assert.equal(get.status, 200);
  assert.deepEqual(await get.json(), { enabled: false, state: 'off' });
  const post = (body: unknown) =>
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const on = await post({ enabled: true });
  assert.equal(on.status, 200);
  const body = await on.json();
  assert.equal((body as any).login, 'octocat');
  assert.doesNotMatch(JSON.stringify(body), /token/i);
  assert.deepEqual(updates, [{ github: true }]);
  assert.deepEqual(toggles, [true]);
  for (const invalid of [{ enabled: 'yes' }, { enabled: true, token: 'SYNTHETIC' }, {}])
    assert.equal((await post(invalid)).status, 400);
  assert.equal(updates.length, 1);
});
