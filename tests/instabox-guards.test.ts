import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Devices } from '../src/server/devices/service.ts';
import { SshTunnels } from '../src/server/devices/ssh-tunnel.ts';
import { z } from 'zod';
import { ServerEnrollments } from '../src/server/server-enrollments.ts';
import { fakeHost } from './helpers/fake-host.ts';

test('device pairing refuses a paused managed alias before opening a tunnel', async () => {
  const home = await mkdtemp(join(tmpdir(), 'instabox-guard-'));
  let launches = 0;
  const devices = new Devices({
    file: join(home, 'devices.json'),
    selfName: 'fixture',
    beforeSsh: async () => {
      throw new Error('Box is paused');
    },
    tunnels: {
      ensure: async () => {
        launches++;
        throw new Error('unexpected SSH');
      },
    } as unknown as SshTunnels,
  });
  await assert.rejects(
    devices.add({ address: '127.0.0.1', code: '123', tunnel: { ssh: 'pugport-instabox-1234567', remotePort: 4318 } }),
    /Box is paused/,
  );
  assert.equal(launches, 0);
});

test('forget clears only tunnel failure and permits immediate retry', async () => {
  let attempts = 0;
  const tunnels = new SshTunnels({
    port: async () => {
      attempts++;
      throw new Error('fixture');
    },
  });
  await assert.rejects(tunnels.ensure('fixture', 4318));
  await assert.rejects(tunnels.ensure('fixture', 4318));
  assert.equal(attempts, 1);
  tunnels.forget('fixture');
  await assert.rejects(tunnels.ensure('fixture', 4318));
  assert.equal(attempts, 2);
});

test('check, ensureReachable, polling and hosting refuse managed aliases before SSH', async () => {
  const home = await mkdtemp(join(tmpdir(), 'instabox-device-guard-'));
  const file = join(home, 'devices.json');
  const id = '00000000-0000-4000-8000-000000000001';
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      devices: [
        {
          id,
          name: 'Fixture',
          address: '127.0.0.1',
          token: 'a'.repeat(43),
          peerId: 'fixture',
          pairedAt: '',
          tunnel: { ssh: 'pugport-instabox-1234567', remotePort: 4318 },
        },
      ],
    }),
  );
  let launches = 0;
  const devices = new Devices({
    file,
    selfName: 'fixture',
    beforeSsh: async () => {
      throw new Error('Box is paused');
    },
    tunnels: {
      ensure: async () => {
        launches++;
        return 1;
      },
      isOpen: () => true,
    } as unknown as SshTunnels,
  });
  await devices.load();
  await assert.rejects(devices.check(id), /paused/);
  await assert.rejects(devices.ensureReachable(id), /paused/);
  await assert.rejects(devices.request(id, { path: '/peer/v1/info', schema: z.unknown() }), /paused/);
  await devices.view(true);
  assert.equal(launches, 0);
});

test('enrollment and disconnect guard managed aliases before preflight or uninstall', async () => {
  const home = await mkdtemp(join(tmpdir(), 'instabox-enroll-guard-'));
  let launches = 0;
  const guard = {
    server: async () => ({ name: 'm_fixture1', ssh: 'pugport-instabox-1234567' }),
    assertReachable: async () => {
      throw new Error('Box is paused');
    },
  };
  const devices = {
    view: async () => ({ devices: [], slackHost: null, githubHost: null }),
    add: async () => {
      throw new Error('unexpected');
    },
    remove: async () => {
      throw new Error('unexpected');
    },
  };
  const enrollment = new ServerEnrollments(
    join(home, 'missing.json'),
    devices as never,
    home,
    fakeHost('win32', {
      run: async () => {
        launches++;
        return { stdout: '', stderr: '' };
      },
    }),
    async () => {
      launches++;
      return 0;
    },
    guard as never,
  );
  await assert.rejects(enrollment.start('m_fixture1', 'm_fixture1'), /paused/);
  await assert.rejects(enrollment.disconnect('m_fixture1', false, 'm_fixture1'), /paused/);
  assert.equal(launches, 0);
});
