import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ServerEnrollments } from '../src/server/server-enrollments.ts';
import { fakeHost } from './helpers/fake-host.ts';
import { Devices } from '../src/server/devices/service.ts';
import { removeAccessLines } from '../src/server/devices/managed-access.ts';

const device = {
  id: 'e0cf18d0-f8fa-49ff-9713-8057e642166e',
  name: 'box',
  address: '127.0.0.1',
  pairedAt: '',
  tunnel: { ssh: 'fake-box', remotePort: 4318 },
  executors: [],
};
function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'pugport-enroll-test-'));
  const file = join(folder, 'remote-servers.json');
  const original = JSON.stringify({ servers: [{ name: 'box', ssh: 'fake-box' }, { name: 'no-ssh' }] });
  writeFileSync(file, original);
  const calls: string[] = [];
  const devices = {
    view: async () => ({ devices: [device], slackHost: null }),
    enrolledServerDevice: async () => device.id,
    markEnrolledServer: async (id: string, name: string) => {
      calls.push('mark:' + id + ':' + name);
    },
    addEnrolled: async () => ({ deviceId: device.id, view: { devices: [device], slackHost: null } }),
    remove: async (id: string) => {
      calls.push('remove:' + id);
      return { devices: [], slackHost: null };
    },
  } as unknown as Devices;
  const host = fakeHost('win32', {
    run: async (command, args, options) => {
      calls.push(JSON.stringify({ command, args, input: options?.input }));
      return { stdout: '', stderr: '' };
    },
  });
  return { file, original, calls, devices, host };
}
// The access key line is dropped before the uninstall; a failure there never blocks it.
const uninstallScript = (purge: boolean) =>
  [
    'set -eu',
    '(',
    'set -eu',
    ...removeAccessLines(),
    ") || echo 'PugPort access key line could not be removed from authorized_keys.' >&2",
    '~/pugport/bin/pugport node uninstall',
    ...(purge ? ['rm -rf ~/pugport ~/.local/share/pugport'] : []),
  ].join('\n');
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('enrollment progress, duplicate exclusion, command and failure use fake runners', async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const jobs = new ServerEnrollments(f.file, f.devices, '/fake', f.host, async (_alias, progress, log) => {
    progress('bundle');
    log('synthetic log');
    await gate;
    progress('done');
    return 0;
  });
  await assert.rejects(jobs.start('unknown'), /未知服务器/);
  await assert.rejects(jobs.start('no-ssh'), /SSH/);
  const job = await jobs.start('box');
  assert.equal(jobs.progress(job.id)?.stage, 'bundle');
  assert.equal((await jobs.start('box')).id, job.id);
  await assert.rejects(jobs.disconnect('box', false), /正在进行/);
  release();
  await tick();
  assert.equal(jobs.progress(job.id)?.status, 'completed');
  assert.equal(jobs.progress(job.id)?.device?.id, device.id);
  for (const [log, expected] of [
    ['Run on the server: sudo apt install build-essential python3 && loginctl enable-linger $USER', 'needs-command'],
    ['fake failure', 'failed'],
  ] as const) {
    const failed = new ServerEnrollments(f.file, f.devices, '/fake', f.host, async (_a, progress, write) => {
      progress('preflight');
      write(log);
      return 1;
    });
    const started = await failed.start('box');
    await tick();
    assert.equal(failed.progress(started.id)?.status, expected);
    assert.equal(failed.progress(started.id)?.stage, 'preflight');
    assert.match(failed.progress(started.id)!.log, /server|failure/);
  }
  assert.equal(readFileSync(f.file, 'utf8'), f.original);
});

test('disconnect removes first then uses fixed uninstall and optional purge paths', async () => {
  for (const purge of [false, true]) {
    const f = fixture();
    const jobs = new ServerEnrollments(f.file, f.devices, '/fake', f.host);
    await jobs.disconnect('box', purge);
    assert.equal(f.calls[0], 'remove:' + device.id);
    const call = JSON.parse(f.calls[1]);
    assert.equal(call.command, 'ssh');
    assert.equal(call.args.at(-2), 'fake-box');
    assert.equal(call.input, uninstallScript(purge));
    assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).servers[0].enrollmentDisabled, true);
  }
});

test('server display name may contain spaces while its SSH alias names the paired device', async () => {
  const f = fixture();
  writeFileSync(
    f.file,
    JSON.stringify({
      servers: [
        { name: 'CI Runner', ssh: 'ci-runner' },
        { name: 'Long alias', ssh: 'a'.repeat(25) },
      ],
    }),
  );
  const paired = { ...device, name: 'ci-runner', tunnel: { ssh: 'ci-runner', remotePort: 4318 } };
  f.devices.view = async () => ({ devices: [paired], slackHost: null });
  const args: string[] = [];
  const jobs = new ServerEnrollments(f.file, f.devices, '/fake', f.host, async (alias) => {
    args.push(alias);
    return 0;
  });
  const job = await jobs.start('CI Runner');
  await tick();
  assert.deepEqual(args, ['ci-runner']);
  assert.equal(jobs.progress(job.id)?.status, 'completed');
  assert.equal(jobs.progress(job.id)?.server, 'CI Runner');
  assert.equal(jobs.progress(job.id)?.device?.name, 'ci-runner');
  await assert.rejects(jobs.start('Long alias'));
  assert.equal(args.length, 1);
});

test('an unmarked pairing with the same SSH alias is not enrolled, but 断开 on the card removes it', async () => {
  const f = fixture();
  f.devices.enrolledServerDevice = async () => undefined;
  const jobs = new ServerEnrollments(f.file, f.devices, '/fake', f.host, async () => {
    throw new Error('must not run');
  });
  await assert.rejects(jobs.start('box'), /personal device/);
  assert.equal(
    f.calls.some((call) => call.startsWith('remove:') || call.startsWith('mark:')),
    false,
  );
  // The card shows a pairing on this alias as the server's node (servers enrolled before the marker), so 断开 removes it.
  await jobs.disconnect('box', false);
  assert.ok(f.calls.includes('remove:' + device.id));
  assert.equal(
    f.calls.some((call) => call.startsWith('mark:')),
    false,
  );
});

test('successful new enrollment marks the exact new node, failed enrollment never marks', async () => {
  for (const code of [0, 1]) {
    const f = fixture();
    let paired = false;
    f.devices.view = async () => ({ devices: paired ? [device] : [], slackHost: null });
    f.devices.enrolledServerDevice = async () => undefined;
    const jobs = new ServerEnrollments(f.file, f.devices, '/fake', f.host, async (_alias, _progress, _log, client) => {
      paired = true;
      await client.post('/api/devices', {});
      return code;
    });
    const job = await jobs.start('box');
    await tick();
    assert.equal(jobs.progress(job.id)?.status, code === 0 ? 'completed' : 'failed');
    assert.deepEqual(f.calls, code === 0 ? ['mark:' + device.id + ':box'] : []);
  }
});

test('enrollment source is persisted privately and plain paired records remain unmarked', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pugport-enrollment-marker-'));
  const file = join(folder, 'devices.json');
  const personal = { ...device, id: 'e0cf18d0-f8fa-49ff-9713-8057e642166f', name: 'personal' };
  const stored = [device, personal].map(({ executors: _executors, ...item }) => ({
    ...item,
    token: 'a'.repeat(43),
    peerId: 'synthetic',
  }));
  writeFileSync(file, JSON.stringify({ version: 1, devices: stored }));
  const devices = new Devices({ file, selfName: 'synthetic' });
  assert.equal(await devices.enrolledServerDevice('box'), undefined);
  await devices.markEnrolledServer(
    device.id,
    'box',
    createHash('sha256')
      .update(JSON.stringify(['a'.repeat(43), 'synthetic', '']))
      .digest('hex'),
  );
  const reloaded = new Devices({ file, selfName: 'synthetic' });
  assert.equal(await reloaded.enrolledServerDevice('box'), device.id);
  const records = (await reloaded.store.read()).devices;
  assert.equal(records.find((item) => item.id === personal.id)?.enrolledServer, undefined);
  await assert.rejects(reloaded.markEnrolledServer(device.id, 'other'), /another remote server/);
  await assert.rejects(reloaded.markEnrolledServer('missing', 'box'), /no longer exists/);
});

test('personal pairing created while enrollment runs is never adopted from its SSH alias', async () => {
  const f = fixture();
  let paired = false;
  f.devices.view = async () => ({ devices: paired ? [device] : [], slackHost: null });
  f.devices.enrolledServerDevice = async () => undefined;
  const jobs = new ServerEnrollments(f.file, f.devices, '/fake', f.host, async () => {
    paired = true;
    return 0;
  });
  const job = await jobs.start('box');
  await tick();
  assert.equal(jobs.progress(job.id)?.status, 'failed');
  assert.deepEqual(f.calls, []);
});

test('enrollment pairing cannot overwrite an existing personal node identity', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pugport-enrollment-identity-'));
  const file = join(folder, 'devices.json');
  const original = {
    id: device.id,
    nodeId: device.id,
    name: 'personal',
    address: '100.64.0.1',
    token: 'a'.repeat(43),
    peerId: 'old-peer',
    pairedAt: '',
  };
  writeFileSync(file, JSON.stringify({ version: 1, devices: [original] }));
  const devices = new Devices({
    file,
    selfName: 'synthetic',
    fetch: async () =>
      Response.json({
        peerId: 'new-peer',
        token: 'b'.repeat(43),
        node: {
          nodeId: device.id,
          name: 'server',
          version: '1',
          role: 'node',
          hostname: 'fake',
          platform: 'linux',
          arch: 'x64',
          capabilities: {},
          slackHost: false,
        },
      }),
  });
  await assert.rejects(
    devices.addEnrolled({ address: '100.64.0.2', code: '123456', name: 'server' }),
    /cannot replace/,
  );
  assert.deepEqual((await devices.store.read()).devices, [original]);
});

test('pairing replacement during enrollment probe cannot acquire the enrollment marker', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pugport-enrollment-replaced-'));
  const file = join(folder, 'devices.json');
  const devices = new Devices({
    file,
    selfName: 'synthetic',
    fetch: async () =>
      Response.json({
        peerId: 'enrollment-peer',
        token: 'b'.repeat(43),
        node: {
          nodeId: device.id,
          name: 'server',
          version: '1',
          role: 'node',
          hostname: 'fake',
          platform: 'linux',
          arch: 'x64',
          capabilities: {},
          slackHost: false,
        },
      }),
  });
  (devices as unknown as { probe(id: string): Promise<void> }).probe = async () => {
    await devices.store.update((data) => {
      data.devices[0] = { ...data.devices[0], token: 'c'.repeat(43), peerId: 'personal-peer', name: 'personal' };
    });
  };
  devices.view = async () => ({ devices: [], slackHost: null });
  const paired = await devices.addEnrolled({ address: '100.64.0.2', code: '123456', name: 'server' });
  await assert.rejects(devices.markEnrolledServer(paired.deviceId, 'box', paired.pairingProof), /Pairing changed/);
  await assert.rejects(devices.markEnrolledServer(paired.deviceId, 'box'), /Pairing changed/);
  const current = (await devices.store.read()).devices[0];
  assert.equal(current.enrolledServer, undefined);
  assert.equal(current.token, 'c'.repeat(43));
  assert.equal(current.name, 'personal');
});
