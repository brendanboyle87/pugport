import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { localApiGuard, ownerApiGuard } from '../src/server/local-api-guard.ts';
import { listenForFetch } from './helpers/fetch-port.ts';

test('file token writes are restricted to the exact allowlist', async (t) => {
  const app = express();
  const hosts = new Set<string>();
  app.use(localApiGuard('token', hosts, new Set()));
  app.use(ownerApiGuard('owner'));
  app.use((_req, res) => res.sendStatus(200));
  const server = await listenForFetch(app);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  hosts.add(new URL(base).host);
  const request = (path: string, method = 'POST', owner?: string) =>
    fetch(base + path, {
      method,
      headers: { 'x-agent-token': 'token', ...(owner ? { 'x-pugport-owner': owner } : {}) },
    });
  for (const path of [
    '/api/settings',
    '/API/settings',
    '/api/settings/',
    '/api/zzz-new',
    '/api/conversations/a/messages/b/edit-and-resend',
    '/api/conversations/a/messages/b/resend',
    '/api/conversations/a/messages/b/search-answer',
    '/api/conversations/a/fork',
    '/api/conversations/a/side-chat',
    '/api/workflows/a/swarm-message',
    '/api/conversations/a/executor-selection',
    '/api/workflows/a/machine-load',
    ...[
      'continue',
      'rerun-write',
      'rerun-ask',
      'delivery',
      'delegate',
      'confirm',
      'approve-plan',
      'steer',
      'input',
      'schedule',
      'queue/wake',
    ].map((part) => `/api/workflows/a/${part}`),
    '/api/queue/wake',
    '/api/external/connections/tool',
    '/api/devices/a/files',
    '/api/devices/a/check',
    '/api/runs',
    '/api/targets/a/test',
    '/api/handoff/a',
    '/api/scheduled-tasks',
    '/api/scheduled-tasks/a/run',
    '/api/approvals/a',
    '/api/extensions/install',
    '/api/tools/a/install',
    '/api/accounts',
    '/api/api-providers',
    '/api/connectors/connect',
    '/api/slack/pairing',
    '/api/devices',
    '/api/github',
    '/api/remote-servers/enrollments',
  ]) {
    const response = await request(path);
    assert.equal(response.status, 403, path);
    assert.doesNotMatch(await response.text(), /session token/i);
    assert.equal((await request(path, 'POST', 'owner')).status, 200);
    assert.equal((await request(path, 'POST', 'wrong')).status, 403);
    assert.equal((await request(path, 'POST', 'x')).status, 403);
    assert.equal((await request(path, 'GET')).status, 200);
  }
  for (const [method, path] of [
    ['DELETE', '/api/external/connections/tool'],
    ['PATCH', '/api/conversations/a/connectors'],
    ['PATCH', '/api/settings'],
    ['PATCH', '/api/workflows/a/input'],
    ['PATCH', '/api/workflows/a/schedule'],
    ['PATCH', '/api/conversations/a/routing'],
    ['PATCH', '/api/projects/a/rules'],
    ['DELETE', '/api/conversations/a/approval-rules/b'],
    ['PUT', '/api/routing-profiles/a'],
    ['DELETE', '/api/routing-profiles/a'],
    ['PATCH', '/api/conversations/a/routing-profile'],
    ['PATCH', '/api/projects/a/routing-profile'],
    ['PUT', '/api/external-agents/grok-bot/routine'],
    ['POST', '/api/external-agents/messages/a/retry'],
    ['POST', '/api/external-agents/messages/a/stop-following'],
    ['POST', '/api/external-agents/messages/a/handoff'],
    ['POST', '/api/scheduled-tasks'],
    ['PUT', '/api/scheduled-tasks/a'],
    ['PATCH', '/api/scheduled-tasks/a'],
    ['DELETE', '/api/scheduled-tasks/a'],
    ['POST', '/api/scheduled-tasks/a/run'],
    ['PUT', '/api/slack/tokens'],
    ['PUT', '/api/web-search'],
    ['PUT', '/api/connectors/providers/a'],
    ['PATCH', '/api/connectors/a'],
    ['DELETE', '/api/connectors/a'],
    ['PATCH', '/api/slack'],
    ['DELETE', '/api/slack/users/a'],
    ['DELETE', '/api/devices/a'],
    ['PUT', '/api/devices/slack-host'],
    ['POST', '/api/remote-servers/disconnect'],
  ]) {
    assert.equal((await request(path!, method)).status, 403, `${method} ${path}`);
    assert.equal((await request(path!, method, 'owner')).status, 200, `${method} ${path}`);
  }
  for (const [method, path] of [
    ['POST', '/api/external/tasks'],
    ['POST', '/api/external/tasks/a/cancel'],
    ['POST', '/api/external/conversations/a/messages'],
    ['POST', '/api/projects'],
    ['POST', '/api/conversations'],
    ['POST', '/api/conversations/a/messages'],
    ['POST', '/api/workflows/a/cancel'],
    ['POST', '/api/workspace/refresh'],
    ['POST', '/api/node/pairing'],
    ['DELETE', '/api/node/peers'],
    ['DELETE', '/api/node/peers/a'],
    ['POST', '/api/conversations/a/work/messages'],
    ['POST', '/api/conversations/a/work/jobs'],
    ['POST', '/api/conversations/a/work/lanes'],
    ['PATCH', '/api/conversations/a/work/settings'],
    ['PATCH', '/api/conversations/a/work/jobs/b'],
    ['DELETE', '/api/conversations/a/work/jobs/b'],
    ['DELETE', '/api/conversations/a'],
    ['DELETE', '/api/projects/a'],
  ])
    assert.equal((await request(path!, method)).status, 200, path);
});

test('without a shell owner, owner writes fail but allowlisted writes pass', async (t) => {
  const app = express();
  const hosts = new Set<string>();
  app.use(localApiGuard('token', hosts, new Set()));
  app.use(ownerApiGuard(undefined));
  app.use((_req, res) => res.sendStatus(200));
  const server = await listenForFetch(app);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  hosts.add(new URL(base).host);
  const headers = { 'x-agent-token': 'token', 'x-pugport-owner': 'owner' };
  assert.equal((await fetch(base + '/api/settings', { method: 'PATCH', headers })).status, 403);
  assert.equal((await fetch(base + '/api/projects', { method: 'POST', headers })).status, 200);
});
