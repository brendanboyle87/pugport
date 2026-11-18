import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Devices } from '../src/server/devices/service.ts';
import { PeerRefused } from '../src/server/devices/peer-client.ts';
import { Inbox } from '../src/server/inbox.ts';
import { MaintainerDesk, memoryHostLink, peerHostLink } from '../src/server/maintainer/desktop.ts';
import { StoreOutbox } from '../src/server/maintainer/outbox.ts';
import type { GitHubHostApi } from '../src/server/node/peer-routes.ts';
import type { GitHubHostRequest, GitHubStatus } from '../src/server/node/peer-protocol.ts';
import { card, fakeGh, memoryStore, stamp } from './helpers/maintainer.ts';
import { startPeer, temporaryFolder } from './helpers/fake-peer.ts';

function fakeGitHub() {
  const outbox = new StoreOutbox(memoryStore(), () => Date.parse(stamp));
  const requests: GitHubHostRequest[] = [];
  const status: GitHubStatus = {
    githubHost: false,
    mode: 'off',
    ready: { gh: true, app: false, toolless: true },
    counts: { prs: 1, issues: 2, judges: 3, writes: 0 },
    score: { judged: 3, falsePasses: 0, falseFails: 1, pending: 0 },
    recent: [{ at: stamp, event: 'pr', number: 7, action: 'judge', result: 'pass' }],
  };
  const api: GitHubHostApi = {
    async set(request) {
      requests.push(request);
      status.githubHost = request.host;
      status.mode = request.host ? 'shadow' : 'off';
      return { githubHost: request.host };
    },
    status: async () => status,
    outbox: () => outbox.open(),
    resolve: memoryHostLink(outbox).resolve,
    resumeJudge: () => {
      status.judgingPaused = false;
    },
  };
  return { api, status, outbox, requests };
}
async function paired(t: TestContext, github?: GitHubHostApi) {
  const peer = await startPeer(t, { github });
  const { code } = peer.registry.createCode();
  const result = await peer.registry.pair(code, 'Synthetic desk');
  assert.equal(typeof result, 'object');
  if (typeof result !== 'object') throw new Error('Fake pairing failed');
  const request = (path: string, method = 'GET', body?: unknown) =>
    fetch(peer.url + '/peer/v1/github' + path, {
      method,
      headers: { authorization: `Bearer ${result.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { peer, request };
}

test('GitHub peer hosting, status, outbox and resolution delegate to the host', async (t) => {
  const f = fakeGitHub();
  const { peer, request } = await paired(t, f.api);
  const denied = await fetch(peer.url + '/peer/v1/github/judge/resume', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(denied.status, 401);
  const body = {
    host: true,
    repository: 'o/r',
    stage: 1,
    gates: { version: 1 },
    requiredChecks: ['ci'],
    suiteConfigured: true,
    hostedBy: 'Synthetic desk',
    leaseMinutes: 360,
  };
  assert.deepEqual(await (await request('', 'PUT', body)).json(), { githubHost: true });
  assert.deepEqual(f.requests, [body]);
  assert.deepEqual(await (await request('/status')).json(), f.status);
  f.status.judgingPaused = true;
  assert.equal((await request('/judge/resume', 'POST', { extra: true })).status, 400);
  assert.equal(f.status.judgingPaused, true);
  assert.deepEqual(await (await request('/judge/resume', 'POST', {})).json(), { ok: true });
  assert.equal(f.status.judgingPaused, false);
  const item = f.outbox.raise(card());
  assert.deepEqual(await (await request('/outbox')).json(), { items: [item] });
  assert.deepEqual(await (await request(`/outbox/${item.id}/resolve`, 'POST', { outcome: 'declined' })).json(), {
    ok: true,
  });
  assert.equal((await request(`/outbox/${item.id}/resolve`, 'POST', { outcome: 'declined' })).status, 404);
  assert.equal((await request('/outbox/card-20261028-deadbeef/resolve', 'POST', { outcome: 'declined' })).status, 404);
  assert.deepEqual(await (await request('/outbox')).json(), { items: [] });
  assert.deepEqual(await (await request('', 'PUT', { host: false })).json(), { githubHost: false });
  assert.equal(f.status.mode, 'off');
  assert.deepEqual(f.requests.at(-1), { host: false });
});

test('GitHub peer rejects malformed gates and unsupported hosting', async (t) => {
  const f = fakeGitHub();
  const { request } = await paired(t, f.api);
  for (const gates of [false, { sizeLimit: 'unbounded' }, { unknown: true }]) {
    assert.equal((await request('', 'PUT', { host: true, repository: 'o/r', hostedBy: 'desk', gates })).status, 400);
  }
  assert.equal(f.requests.length, 0);
  const absent = await paired(t);
  for (const [path, method, body] of [
    ['', 'PUT', { host: false }],
    ['/status', 'GET', undefined],
    ['/judge/resume', 'POST', {}],
    ['/outbox', 'GET', undefined],
    ['/outbox/card-20261028-deadbeef/resolve', 'POST', { outcome: 'declined' }],
  ] as const)
    assert.equal((await absent.request(path, method, body)).status, 400);
});

test('peer HostLink validates responses and desk mirrors cards, host status and offline errors', async (t) => {
  const f = fakeGitHub();
  const peer = await startPeer(t, { github: f.api });
  let invalidStatus = false;
  const devices = new Devices({
    file: join(temporaryFolder(t, 'maintainer-peer-'), 'devices.json'),
    selfName: 'Synthetic desk',
    helperTimeoutMs: 15000,
    fetch: async (...args) => (invalidStatus ? new Response('{}') : fetch(...args)),
  });
  t.after(() => devices.close());
  const { code } = peer.registry.createCode();
  const view = await devices.add({ address: peer.address, code });
  const link = peerHostLink(devices, view.devices[0]!.id);
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const inbox = new Inbox(
    db,
    () => {},
    () => Date.parse(stamp),
  );
  const desk = new MaintainerDesk({
    inbox,
    store: memoryStore(),
    config: async () => ({ repository: 'o/r' }),
    link: () => link,
    gh: fakeGh(() => {
      throw new Error('unexpected gh call');
    }).gh,
    audit: () => {},
    // The same clock as the host outbox: a card raised at the fixture time expires 14 days later.
    now: () => Date.parse(stamp),
  });
  const item = f.outbox.raise(card());
  await desk.sync();
  await desk.sync();
  assert.equal(inbox.list().length, 1);
  assert.equal(inbox.list()[0].count, 1);
  assert.equal((await desk.status()).configured, true);
  assert.equal((await desk.status()).desk.link, 'peer');
  assert.deepEqual((await desk.status()).host, f.status);
  f.status.judgingPaused = true;
  assert.deepEqual(await desk.resumeJudge(), { status: 'resumed' });
  assert.equal(f.status.judgingPaused, false);
  assert.deepEqual(await memoryHostLink(f.outbox, f.api.status).status!(), f.status);
  invalidStatus = true;
  await assert.rejects(link.status!(), (error: unknown) => error instanceof PeerRefused && error.status === 502);
  invalidStatus = false;
  inbox.dismiss(inbox.list()[0].id);
  await desk.sync();
  assert.equal(f.outbox.open().length, 0);
  assert.equal(await link.resolve(item.id, { outcome: 'declined' }), false);
  f.outbox.raise(card());
  await desk.sync();
  const before = inbox.list({ all: true });
  await peer.listener.close();
  await assert.rejects(desk.resumeJudge());
  await desk.sync();
  assert.deepEqual(inbox.list({ all: true }), before);
  assert.equal((await desk.status()).desk.link, 'peer');
  assert.ok((await desk.status()).desk.problem);
});
