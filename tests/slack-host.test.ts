import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SlackGateway, type SlackSocket } from '../src/server/slack-gateway.ts';
import { migrateNodeSlackConfig, nodeSlackHost, slackConfigStoreFor } from '../src/server/node/slack-host.ts';
import { Devices } from '../src/server/devices/service.ts';
import { SlackConnectionLock } from '../src/server/slack-connection-lock.ts';

// Synthetic tokens only; all Slack calls and sockets stay in this process.
const APP = 'xapp-1-A0SYNTH-0000000000-syntheticappsecretAAAA';
// Built at run time so secret scanners do not mistake the fixture for a real token.
const BOT = ['xoxb', '0000000000', '0000000000', 'syntheticbotsecretBBBB'].join('-');
const users = [{ id: 'UOWNER', name: 'Owner', pairedAt: '2026-10-01T00:00:00Z' }];
const setup = { appToken: APP, botToken: BOT, users, enabled: true };
const desktopName = '桌面版 PugPort';

class FakeSocket implements SlackSocket {
  closed = false;
  private closedListeners: ((event: unknown) => void)[] = [];
  addEventListener(type: string, listener: (event: any) => void) {
    if (type === 'close') this.closedListeners.push(listener);
  }
  send() {}
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closedListeners) listener({ code: 1000 });
  }
}

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'pugport-slack-host-'));
  const previous = process.env.COMBORUNNER_SECRETS_DIR;
  process.env.COMBORUNNER_SECRETS_DIR = dir;
  const desktop = slackConfigStoreFor('desktop');
  const node = slackConfigStoreFor('node');
  const flagFile = join(dir, 'slack-host.json');
  const sockets: FakeSocket[] = [];
  const gateway = new SlackGateway({
    store: node,
    fetch: (async (url) => {
      if (String(url).endsWith('/auth.test'))
        return Response.json({ ok: true, user_id: 'UBOT', team: 'Synthetic Team' });
      assert.ok(String(url).endsWith('/apps.connections.open'));
      return Response.json({ ok: true, url: 'wss://example.invalid/socket' });
    }) as typeof fetch,
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  t.after(async () => {
    await gateway.close();
    if (previous === undefined) delete process.env.COMBORUNNER_SECRETS_DIR;
    else process.env.COMBORUNNER_SECRETS_DIR = previous;
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  return { dir, desktop, node, gateway, sockets, flagFile };
}

test('node handover and release leave the desktop config byte-identical', async (t) => {
  const f = await fixture(t);
  await f.desktop.update((config) => Object.assign(config, setup));
  const desktopFile = join(f.dir, 'slack-gateway.json');
  const before = await readFile(desktopFile);
  const host = nodeSlackHost({ store: f.node, gateway: f.gateway, flagFile: f.flagFile, desktopName });
  assert.equal(host.hostsSlack(), false);
  assert.deepEqual(await host.host({ host: true, ...setup }), { slackHost: true });
  assert.equal(host.hostsSlack(), true);
  assert.deepEqual(await readFile(desktopFile), before);
  assert.deepEqual(await host.host({ host: false }), { slackHost: false });
  assert.equal(host.hostsSlack(), false);
  assert.deepEqual(await readFile(desktopFile), before);
  assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'slack-gateway-node.json'), 'utf8')), {
    version: 1,
    ...setup,
    enabled: false,
  });
  assert.equal(await readFile(f.flagFile, 'utf8'), '{"host":false}\n');
  assert.equal((await f.gateway.view()).hostedBy, desktopName);
});

test('hosting opens exactly one node socket and releasing closes it', async (t) => {
  const f = await fixture(t);
  const host = nodeSlackHost({ store: f.node, gateway: f.gateway, flagFile: f.flagFile, desktopName });
  await host.host({ host: true, ...setup });
  await f.gateway.start();
  // Drain the fake auth/open responses, including their response bodies.
  for (let i = 0; i < 500 && f.sockets.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.sockets.length, 1);
  assert.equal(f.sockets[0]!.closed, false);
  await host.host({ host: false });
  assert.equal(f.sockets[0]!.closed, true);
});

test('migration copies the old shared setup once and never changes the shared bytes', async (t) => {
  const f = await fixture(t);
  await f.desktop.update((config) => Object.assign(config, setup));
  const sharedBefore = await readFile(join(f.dir, 'slack-gateway.json'));
  assert.equal(await migrateNodeSlackConfig(f.desktop, f.node, true), true);
  assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'slack-gateway-node.json'), 'utf8')), {
    version: 1,
    ...setup,
  });
  assert.deepEqual(await readFile(join(f.dir, 'slack-gateway.json')), sharedBefore);
  const before = await readFile(join(f.dir, 'slack-gateway-node.json'));
  assert.equal(await migrateNodeSlackConfig(f.desktop, f.node, true), false);
  assert.deepEqual(await readFile(join(f.dir, 'slack-gateway-node.json')), before);
});

test('migration never replaces an existing partial or empty node file', async (t) => {
  const f = await fixture(t);
  await f.desktop.update((config) => Object.assign(config, setup));
  const file = join(f.dir, 'slack-gateway-node.json');
  for (const contents of [JSON.stringify({ version: 1, enabled: false, users: [], botToken: BOT }), '', '{']) {
    await writeFile(file, contents);
    assert.equal(await migrateNodeSlackConfig(f.desktop, f.node, true), false);
    assert.equal(await readFile(file, 'utf8'), contents);
  }
});

test(
  'migrated node file is owner-only on POSIX',
  { skip: process.platform === 'win32' ? 'Windows uses ACLs, not POSIX mode bits' : false },
  async (t) => {
    const f = await fixture(t);
    await f.desktop.update((config) => Object.assign(config, setup));
    await migrateNodeSlackConfig(f.desktop, f.node, true);
    assert.equal((await stat(join(f.dir, 'slack-gateway-node.json'))).mode & 0o777, 0o600);
  },
);

test('migration without the host flag leaves both files untouched', async (t) => {
  const f = await fixture(t);
  await f.desktop.update((config) => Object.assign(config, setup));
  const before = await readFile(join(f.dir, 'slack-gateway.json'));
  assert.equal(await migrateNodeSlackConfig(f.desktop, f.node, false), false);
  assert.deepEqual(await readFile(join(f.dir, 'slack-gateway.json')), before);
  await assert.rejects(readFile(join(f.dir, 'slack-gateway-node.json')), { code: 'ENOENT' });
});

test('invalid tokens change neither config nor the host flag', async (t) => {
  const f = await fixture(t);
  const host = nodeSlackHost({ store: f.node, gateway: f.gateway, flagFile: f.flagFile, desktopName });
  await assert.rejects(host.host({ host: true, ...setup, botToken: 'invalid' }), /Bot Token/);
  assert.deepEqual(await f.node.read(), { version: 1, enabled: false, users: [] });
  await assert.rejects(readFile(f.flagFile), { code: 'ENOENT' });
  await writeFile(f.flagFile, 'invalid json');
  assert.equal(host.hostsSlack(), false);
});

test('migration preserves the shared setup when the node write fails', async (t) => {
  const f = await fixture(t);
  await f.desktop.update((config) => Object.assign(config, setup));
  const before = await readFile(join(f.dir, 'slack-gateway.json'));
  t.mock.method(f.node, 'copyIfAbsent', async () => {
    throw new Error('synthetic write failure');
  });
  await assert.rejects(migrateNodeSlackConfig(f.desktop, f.node, true), /synthetic write failure/);
  assert.deepEqual(await readFile(join(f.dir, 'slack-gateway.json')), before);
});

test('migration keeps an existing node setup and requires both shared tokens', async (t) => {
  const f = await fixture(t);
  await f.desktop.update((config) => Object.assign(config, setup));
  await f.node.update((config) => Object.assign(config, { ...setup, enabled: false, users: [] }));
  const sharedBefore = await readFile(join(f.dir, 'slack-gateway.json'));
  const nodeBefore = await readFile(join(f.dir, 'slack-gateway-node.json'));
  assert.equal(await migrateNodeSlackConfig(f.desktop, f.node, true), false);
  assert.deepEqual(await readFile(join(f.dir, 'slack-gateway.json')), sharedBefore);
  assert.deepEqual(await readFile(join(f.dir, 'slack-gateway-node.json')), nodeBefore);
  await f.node.update((config) => {
    delete config.appToken;
  });
  await f.desktop.update((config) => {
    delete config.botToken;
  });
  assert.equal(await migrateNodeSlackConfig(f.desktop, f.node, true), false);
  assert.deepEqual(await f.node.read(), { version: 1, enabled: false, users: [], botToken: BOT });
});

test('host switches stop first, retain the old choice on failed release, and serialize competing requests', async (t) => {
  const f = await fixture(t);
  const events: string[] = [];
  let live = 'desktop';
  let failRelease = false;
  const id = '11111111-1111-4111-8111-111111111111';
  const devices = new Devices({
    file: join(f.dir, 'devices.json'),
    selfName: 'desktop',
    slack: {
      config: async () => setup,
      standby: async (host) => {
        events.push(host ? 'desktop:stop' : 'desktop:start');
        if (host) {
          if (failRelease) throw new Error('synthetic local close failure');
          live = '';
        } else {
          assert.equal(live, '', 'node socket must be gone');
          live = 'desktop';
        }
      },
    },
    fetch: (async (_url, init) => {
      const request = JSON.parse(String(init!.body));
      events.push(request.host ? 'node:start' : 'node:stop');
      if (request.host) {
        assert.equal(live, '', 'desktop socket must be gone');
        live = 'node';
      } else {
        if (failRelease) return Response.json({ slackHost: true });
        live = '';
      }
      return Response.json({ slackHost: request.host });
    }) as typeof fetch,
  });
  t.after(() => devices.close());
  await devices.store.update((data) => {
    data.devices.push({
      id,
      name: 'box',
      address: '127.0.0.1:4318',
      token: 'a'.repeat(43),
      peerId: 'peer',
      pairedAt: '2026-10-01T00:00:00Z',
    });
  });
  failRelease = true;
  await assert.rejects(devices.setSlackHost(id), /synthetic local close failure/);
  assert.deepEqual(events, ['desktop:stop']);
  failRelease = false;
  events.length = 0;
  await devices.setSlackHost(id);
  assert.deepEqual(events, ['desktop:stop', 'node:start']);
  failRelease = true;
  events.length = 0;
  const blocked = await devices.setSlackHost(null);
  assert.match(blocked.note!, /not confirmed release/);
  assert.equal(blocked.slackHost, id);
  assert.equal(live, 'node');
  assert.deepEqual(events, ['node:stop']);
  const removal = await devices.remove(id);
  assert.equal(removal.devices.length, 1, 'failed release must also prevent unpairing and local restart');
  failRelease = false;
  events.length = 0;
  await Promise.all([devices.setSlackHost(null), devices.setSlackHost(id), devices.setSlackHost(null)]);
  assert.deepEqual(events, ['node:stop', 'desktop:start', 'desktop:stop', 'node:start', 'node:stop', 'desktop:start']);
  assert.equal(live, 'desktop');
});

test('heartbeat refreshes the lease; losing owners cannot update or release the successor', async (t) => {
  const f = await fixture(t);
  let now = Date.now();
  const opts = { directory: f.dir, role: 'node' as const, now: () => now, isAlive: () => true };
  const first = new SlackConnectionLock({ ...opts, pid: 101 });
  const second = new SlackConnectionLock({ ...opts, pid: 102 });
  t.after(() => {
    first.release();
    second.release();
  });
  assert.equal(await first.acquire('A0SYNTH', () => {}), true);
  now += 60_000;
  assert.equal(first.heartbeat(), true);
  now += 60_000;
  assert.equal(await second.acquire('A0SYNTH', () => {}), false);
  now += 31_000;
  assert.equal(await second.acquire('A0SYNTH', () => {}), false, 'a live stale holder must confirm socket close');
  assert.equal(first.heartbeat(), false);
  first.release();
  assert.equal(await second.acquire('A0SYNTH', () => {}), true);
  first.release();
  assert.equal(second.owns(), true);
});

test('node release waits for an earlier handover even when its caller already timed out', async (t) => {
  const f = await fixture(t);
  let finishSave!: () => void;
  let startedSave!: () => void;
  const saved = new Promise<void>((resolve) => (finishSave = resolve));
  const started = new Promise<void>((resolve) => (startedSave = resolve));
  t.after(() => finishSave());
  const events: string[] = [];
  const host = nodeSlackHost({
    store: f.node,
    flagFile: f.flagFile,
    desktopName,
    gateway: {
      saveTokens: async () => {
        startedSave();
        await saved;
        return f.gateway.view();
      },
      setStandby: async (name) => {
        events.push(name ? 'stop' : 'start');
      },
      setEnabled: async () => f.gateway.view(),
    },
  });
  const handover = host.host({ host: true, ...setup });
  await started;
  let released = false;
  const release = host.host({ host: false }).then(() => {
    released = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(released, false);
  assert.deepEqual(events, []);
  finishSave();
  await Promise.all([handover, release]);
  assert.deepEqual(events, ['start', 'stop']);
  assert.equal(host.hostsSlack(), false);
});

test('a confirmed close can be reclaimed even if the retiring directory rename failed', async (t) => {
  const f = await fixture(t);
  const first = new SlackConnectionLock({ directory: f.dir, role: 'desktop', pid: 101, isAlive: () => true });
  const second = new SlackConnectionLock({ directory: f.dir, role: 'node', pid: 102, isAlive: () => true });
  t.after(() => {
    first.release();
    second.release();
  });
  assert.equal(await first.acquire('A0SYNTH', () => {}), true);
  t.mock.method(first as unknown as { retire(): boolean }, 'retire', () => false);
  first.release();
  assert.equal(await second.acquire('A0SYNTH', () => {}), true);
  assert.equal(second.owns(), true);
});
