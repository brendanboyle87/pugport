import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { Devices } from '../src/server/devices/service.ts';
import { LocalDeviceAccess, hasSshAlias } from '../src/server/devices/local-access.ts';
import type { StoredDevice } from '../src/server/devices/store.ts';
import { RemoteServerMonitor } from '../src/server/remote-servers.ts';
import { PeerRegistry } from '../src/server/node/peer-auth.ts';
import { temporaryFolder } from './helpers/fake-peer.ts';
import { findMentions } from '../src/shared/mentions.ts';

const record = (name: string): StoredDevice => ({
  id: randomUUID(),
  name,
  address: '100.64.0.2',
  token: 'A'.repeat(43),
  peerId: randomUUID(),
  pairedAt: '2026-11-02T00:00:00.000Z',
});

test('synced self is retained in secrets but absent from views, suggestions and dispatch', async (t) => {
  const dir = temporaryFolder(t, 'sync-self-');
  const self = { ...record('self'), tunnel: { ssh: 'self-server', remotePort: 4318 } };
  const other = { ...record('other'), token: 'B'.repeat(43) };
  const peers = join(dir, 'peers.json');
  writeFileSync(
    peers,
    JSON.stringify({
      version: 1,
      peers: [{ id: self.peerId, tokenHash: createHash('sha256').update(self.token).digest('hex') }],
    }),
  );
  const access = new LocalDeviceAccess(peers, join(dir, 'missing-config'));
  let requests = 0;
  const devices = new Devices({
    file: join(dir, 'devices.json'),
    selfName: 'B',
    isSelf: (device) => access.isSelf(device),
    fetch: async () => {
      requests++;
      return new Response('{}');
    },
    github: { config: async () => undefined, standby: async () => {} },
    slack: { config: async () => ({ users: [] }), standby: async () => {} },
  });
  await devices.store.update((data) => {
    data.devices = [self, other];
  });
  assert.equal(devices.store.current().devices.length, 2);
  assert.deepEqual(
    (await devices.view()).devices.map((d) => d.name),
    ['other'],
  );
  assert.deepEqual(
    devices.directory().map((d) => d.name),
    ['other'],
  );
  assert.equal(devices.find('self'), undefined);
  await assert.rejects(devices.request(self.id, { path: '/peer/v1/info', schema: z.object({}) }));
  await assert.rejects(devices.setGitHubHost(self.id));
  await assert.rejects(devices.setSlackHost(self.id));
  await assert.rejects(devices.remove(self.id));
  assert.equal(requests, 0);
  assert.equal(JSON.stringify(await devices.view()).includes(self.token), false);
  const file = join(dir, 'remote-servers.json');
  writeFileSync(
    file,
    JSON.stringify({
      servers: [
        { name: 'self-server', ssh: 'self-server' },
        { name: 'other-server', ssh: 'missing' },
      ],
    }),
  );
  const monitor = new RemoteServerMonitor(
    file,
    async () => {
      throw Error('must not invoke SSH');
    },
    undefined,
    undefined,
    undefined,
    { isSelfServer: (alias) => devices.isSelfServer(alias), sshAvailable: () => false },
  );
  const view = await monitor.view(true);
  assert.deepEqual(
    view.servers.map((s) => s.name),
    ['other-server'],
  );
  assert.equal(view.servers[0].missingSsh, 'missing');
});

test('missing tunnel alias keeps directly reachable device callable without SSH', async (t) => {
  const dir = temporaryFolder(t, 'sync-direct-');
  const device = { ...record('direct'), tunnel: { ssh: 'missing', remotePort: 4318 } };
  let requested = '';
  const devices = new Devices({
    file: join(dir, 'devices.json'),
    selfName: 'B',
    sshAvailable: () => false,
    beforeSsh: async () => {
      throw Error('must not invoke SSH');
    },
    fetch: async (url) => {
      requested = String(url);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });
  await devices.store.update((data) => {
    data.devices = [device];
  });
  assert.equal((await devices.view()).devices[0].missingSsh, 'missing');
  assert.deepEqual(await devices.request(device.id, { path: '/peer/v1/info', schema: z.object({ ok: z.boolean() }) }), {
    ok: true,
  });
  assert.match(requested, /100\.64\.0\.2/);
  await devices.store.update((data) => {
    data.devices[0].address = '127.0.0.1';
  });
  await assert.rejects(devices.request(device.id, { path: '/peer/v1/info', schema: z.object({}) }), /SSH/);
});

test('SSH alias discovery reads includes and negations without running Match exec', (t) => {
  const dir = temporaryFolder(t, 'sync-ssh-');
  mkdirSync(join(dir, 'parts'));
  writeFileSync(
    join(dir, 'config'),
    'Include parts/*.conf\nHost *\n  ServerAliveInterval 60\nMatch exec "must-not-run"\n',
  );
  writeFileSync(join(dir, 'parts', 'hosts.conf'), 'Host box-* !box-denied\n  HostName 100.64.0.2\n');
  assert.equal(hasSshAlias(join(dir, 'config'), 'box-one'), true);
  assert.equal(hasSshAlias(join(dir, 'config'), 'box-denied'), false);
  assert.equal(hasSshAlias(join(dir, 'config'), 'unknown'), false);
});

test('synced server names and existing device aliases route to the same token without SSH', async (t) => {
  const dir = temporaryFolder(t, 'sync-server-names-');
  const records = ['one', 'two', 'three'].map((name) => ({
    ...record(`ssh-${name}`),
    enrolledServer: `server-${name}`,
    tunnel: { ssh: `ssh-${name}`, remotePort: 4318 },
  }));
  let calls = 0;
  const devices = new Devices({
    file: join(dir, 'devices.json'),
    selfName: 'B',
    sshAvailable: () => false,
    beforeSsh: async () => {
      throw Error('must not invoke SSH');
    },
    fetch: async () => {
      calls++;
      return new Response(JSON.stringify({ ok: true }));
    },
  });
  await devices.store.update((data) => {
    data.devices = records;
  });
  for (const record of records) {
    const mentions = findMentions(
      `@@@${record.enrolledServer} run`,
      devices.directory().map((item) => ({ ...item, minTier: 3 as const })),
    );
    assert.equal(mentions.length, 1);
    assert.equal(mentions[0].item.id, record.id);
    assert.equal(devices.find(record.enrolledServer)?.id, record.id);
    assert.equal(devices.find(record.name)?.id, record.id);
    assert.deepEqual(
      await devices.request(mentions[0].item.id, { path: '/peer/v1/info', schema: z.object({ ok: z.boolean() }) }),
      { ok: true },
    );
  }
  assert.equal(calls, 3);
});

test('marking a new pairing removes only older records for the same server', async (t) => {
  const dir = temporaryFolder(t, 'sync-server-race-');
  const old = { ...record('old'), enrolledServer: 'server' };
  const latest = { ...record('new'), pairedAt: '2026-11-03T00:00:00.000Z' };
  const personal = record('personal');
  const other = { ...record('other'), enrolledServer: 'other-server' };
  const devices = new Devices({ file: join(dir, 'devices.json'), selfName: 'A' });
  await devices.store.update((data) => {
    data.devices = [old, latest, personal, other];
  });
  const proof = (device: StoredDevice) =>
    createHash('sha256')
      .update(JSON.stringify([device.token, device.peerId, device.pairedAt]))
      .digest('hex');
  await assert.rejects(devices.markEnrolledServer(latest.id, 'server', 'invalid'), /Pairing changed/);
  assert.equal(devices.store.current().devices.length, 4);
  await devices.markEnrolledServer(latest.id, 'server', proof(latest));
  assert.deepEqual(
    devices.store.current().devices.map((item) => item.id),
    [latest.id, personal.id, other.id],
  );
  await devices.store.update((data) => {
    data.devices.push({ ...old, enrolledServer: undefined });
  });
  await assert.rejects(devices.markEnrolledServer(old.id, 'server', proof(old)), /newer pairing/);
  assert.equal(await devices.enrolledServerDevice('server'), latest.id);
});

test('node identity persists across restart and re-pairing; legacy token proof remains accepted', async (t) => {
  const dir = temporaryFolder(t, 'sync-node-id-');
  const file = join(dir, 'peers.json');
  const registry = new PeerRegistry(file);
  await registry.load();
  await registry.pair(registry.createCode().code, 'A');
  assert.ok(registry.nodeId);
  const restarted = new PeerRegistry(file);
  await restarted.load();
  await restarted.pair(restarted.createCode().code, 'B');
  assert.equal(restarted.nodeId, registry.nodeId);
  const access = new LocalDeviceAccess(file, join(dir, 'config'));
  assert.equal(access.isSelf({ ...record('same'), nodeId: registry.nodeId }), true);
  assert.equal(access.isSelf({ ...record('same'), nodeId: randomUUID() }), false);
});
