import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ServerEnrollments } from '../src/server/server-enrollments.ts';
import type { InstaboxSsh } from '../src/server/instabox-ssh.ts';
import type { Devices } from '../src/server/devices/service.ts';
import type { DeviceView } from '../src/shared/devices.ts';
import { fakeHost } from './helpers/fake-host.ts';

function fixture(names = ['one', 'two', 'three']) {
  const file = join(mkdtempSync(join(tmpdir(), 'auto-enroll-')), 'servers.json');
  writeFileSync(
    file,
    JSON.stringify({ servers: [...names.map((name) => ({ name, ssh: name })), { name: 'no-alias' }] }),
  );
  let devices: DeviceView[] = [];
  const markers = new Map<string, string>();
  const removed: string[] = [];
  const access = {
    view: async () => ({ devices, slackHost: null }),
    removeLegacyServer: async (alias: string) => {
      for (const device of [...devices])
        if (device.tunnel?.ssh === alias && ![...markers.values()].includes(device.id)) await access.remove(device.id);
    },
    enrolledServerDevice: async (name: string) => markers.get(name),
    addEnrolled: async (value: { name: string }) => {
      const device = {
        id: value.name,
        name: value.name,
        address: '100.64.0.1',
        pairedAt: '',
        tunnel: { ssh: value.name, remotePort: 4318 },
      };
      devices.push(device);
      return { deviceId: device.id, view: { devices, slackHost: null } };
    },
    markEnrolledServer: async (id: string, name: string) => {
      markers.set(name, id);
    },
    remove: async (id: string) => {
      removed.push(id);
      devices = devices.filter((d) => d.id !== id);
      for (const [name, value] of markers) if (value === id) markers.delete(name);
      return { devices, slackHost: null };
    },
  } as unknown as Devices;
  return {
    file,
    access,
    markers,
    removed,
    legacy: () => {
      devices.push({
        id: 'legacy',
        name: 'one',
        address: '127.0.0.1',
        pairedAt: '',
        tunnel: { ssh: 'one', remotePort: 4318 },
      });
    },
  };
}
const host = fakeHost('win32', { run: async () => ({ stdout: '', stderr: '' }) });
const options = { sshAvailable: () => true, delay: async () => {} };

test('three servers enroll serially; a computer with synced markers skips all; legacy is replaced', async () => {
  const f = fixture();
  f.legacy();
  let active = 0,
    peak = 0;
  const calls: string[] = [];
  const jobs = new ServerEnrollments(
    f.file,
    f.access,
    '/fake',
    host,
    async (alias, _p, _l, client) => {
      active++;
      peak = Math.max(peak, active);
      calls.push(alias);
      await client.post('/api/devices', { name: alias });
      active--;
      return 0;
    },
    undefined,
    options,
  );
  await jobs.runAutomatic();
  assert.deepEqual(calls, ['one', 'two', 'three']);
  assert.equal(peak, 1);
  assert.deepEqual(f.removed, ['legacy']);
  assert.equal(f.markers.size, 3);
  const other = new ServerEnrollments(
    f.file,
    f.access,
    '/fake',
    host,
    async () => {
      throw Error('must skip synced nodes');
    },
    undefined,
    options,
  );
  await other.runAutomatic();
  assert.equal(other.list().length, 0);
});

test('failure backs off without looping, then succeeds; disconnect persists and manual enrollment clears opt-out', async () => {
  const f = fixture(['one']);
  let now = 0,
    calls = 0;
  const jobs = new ServerEnrollments(
    f.file,
    f.access,
    '/fake',
    host,
    async (alias, _p, _l, client) => {
      if (++calls === 1) return 1;
      await client.post('/api/devices', { name: alias });
      return 0;
    },
    undefined,
    { ...options, now: () => now },
  );
  await jobs.runAutomatic();
  await jobs.runAutomatic();
  assert.equal(calls, 1);
  now = 599999;
  await jobs.runAutomatic();
  assert.equal(calls, 1);
  now = 600000;
  await jobs.runAutomatic();
  assert.equal(calls, 2);
  await jobs.disconnect('one', false);
  assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).servers[0].enrollmentDisabled, true);
  await jobs.runAutomatic();
  assert.equal(calls, 2);
  const job = await jobs.start('one');
  await jobs.close();
  assert.equal(jobs.progress(job.id)?.status, 'completed');
  assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).servers[0].enrollmentDisabled, false);
});

test('sync during jitter suppresses enrollment; no local SSH and stopped schedulers do no work', async () => {
  for (const mode of ['opt-out', 'marker', 'no-ssh', 'closed']) {
    const f = fixture(['one']);
    let calls = 0;
    const jobs = new ServerEnrollments(
      f.file,
      f.access,
      '/fake',
      host,
      async () => {
        calls++;
        return 1;
      },
      undefined,
      {
        sshAvailable: () => mode !== 'no-ssh',
        delay: async () => {},
        refresh: async () => {
          if (mode === 'marker') f.markers.set('one', 'synced');
          if (mode === 'opt-out')
            writeFileSync(f.file, JSON.stringify({ servers: [{ name: 'one', ssh: 'one', enrollmentDisabled: true }] }));
          return true;
        },
      },
    );
    if (mode === 'closed') await jobs.close();
    await jobs.runAutomatic();
    assert.equal(calls, 0, mode);
  }
});

test('paused instabox is skipped until running; a normal m_ server is still enrolled', async () => {
  const f = fixture(['m_regular']);
  let running = false;
  const calls: string[] = [];
  const boxes = {
    monitor: {
      fresh: async () => ({
        machines: [{ machineId: 'm_box', name: 'box', state: running ? 'running' : 'paused', ssh: 'box' }],
      }),
    },
    decorate: async (value: unknown) => value,
    server: async () => ({ name: 'm_box', ssh: 'box' }),
    assertReachable: async () => {},
  } as unknown as InstaboxSsh;
  const jobs = new ServerEnrollments(
    f.file,
    f.access,
    '/fake',
    host,
    async (alias, _p, _l, client) => {
      calls.push(alias);
      await client.post('/api/devices', { name: alias });
      return 0;
    },
    boxes,
    options,
  );
  await jobs.runAutomatic();
  assert.deepEqual(calls, ['m_regular']);
  running = true;
  await jobs.runAutomatic();
  assert.deepEqual(calls, ['m_regular', 'box']);
  await jobs.disconnect('m_box', false, 'm_box');
  assert.equal(
    JSON.parse(readFileSync(f.file, 'utf8')).servers.find((s: { name: string }) => s.name === 'm_box')
      .enrollmentDisabled,
    true,
  );
  await jobs.runAutomatic();
  assert.equal(calls.length, 2);
});

test('an opt-out received while enrollment runs discards the new pairing', async () => {
  const f = fixture(['one']);
  const jobs = new ServerEnrollments(
    f.file,
    f.access,
    '/fake',
    host,
    async (alias, _p, _l, client) => {
      await client.post('/api/devices', { name: alias });
      writeFileSync(f.file, JSON.stringify({ servers: [{ name: 'one', ssh: 'one', enrollmentDisabled: true }] }));
      return 0;
    },
    undefined,
    options,
  );
  await jobs.runAutomatic();
  assert.equal(f.markers.size, 0);
  assert.deepEqual(f.removed, ['one']);
  assert.equal(jobs.list()[0].status, 'failed');
});
