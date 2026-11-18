import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { MemorySyncRemote, PostgrestSyncRemote, joinSecrets, splitSecrets } from '../src/server/account-sync-remote.ts';
import {
  ManagedKeyFiles,
  authorizedKeyLine,
  encodeManagedAccess,
  generateAccessKey,
  installAccessScript,
  managedSshArgs,
  parseInstallOutput,
  parseSshConfig,
  readManagedAccess,
  removeAccessScript,
  type ManagedAccess,
} from '../src/server/devices/managed-access.ts';
import { SshTunnels, managedKeyRefused } from '../src/server/devices/ssh-tunnel.ts';
import { Devices } from '../src/server/devices/service.ts';
import type { StoredDevice } from '../src/server/devices/store.ts';
import { DeviceNode } from '../src/server/node/device-node.ts';
import { RemoteServerMonitor } from '../src/server/remote-servers.ts';
import { ServerEnrollments } from '../src/server/server-enrollments.ts';
import { fakeHost } from './helpers/fake-host.ts';
import { fakeRunner, fakeRuntimes, startPeer, temporaryFolder } from './helpers/fake-peer.ts';

// Synthetic identifiers, keys and documentation-range addresses only.
const NODE = 'a0000000-0000-4000-8000-0000000000a1';
const HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixtureHostKeyForTestsOnly';
const info = {
  name: 'PugPort',
  version: '0.0.0-test',
  role: 'node',
  hostname: 'fixture-box',
  platform: 'linux',
  arch: 'x64',
  capabilities: {},
  slackHost: false,
};

function fakeChild(refuse = false, message = 'root@203.0.113.7: Permission denied (publickey).') {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  }) as unknown as ChildProcessWithoutNullStreams;
  if (refuse)
    setImmediate(() => {
      (child.stderr as PassThrough).write(`${message}\n`);
      setImmediate(() => child.emit('close', 255));
    });
  return child;
}

function access(overrides: Partial<ManagedAccess> = {}): ManagedAccess {
  return {
    version: 1,
    host: '203.0.113.7',
    port: 22,
    user: 'root',
    hostKeys: [HOST_KEY],
    nodePort: 47820,
    key: generateAccessKey('pugport-access:test').privateKey,
    ...overrides,
  };
}

function storedDevice(extra: Partial<StoredDevice> = {}): StoredDevice {
  return {
    id: NODE,
    nodeId: NODE,
    enrolledServer: 'box',
    name: 'box',
    address: '127.0.0.1',
    token: 'T'.repeat(43),
    peerId: 'peer-1',
    pairedAt: '2026-11-16T00:00:00.000Z',
    tunnel: { ssh: 'box', remotePort: 47820 },
    ...extra,
  };
}

/** Devices with a fake ssh: managed launches can be refused; every launch is recorded. */
function devicesFixture(
  t: TestContext,
  options: {
    device?: StoredDevice;
    ownSsh?: boolean;
    refuseManaged?: boolean;
    failManaged?: boolean;
    upgrade?: { config(alias: string): Promise<string>; run(alias: string, script: string): Promise<string> };
  } = {},
) {
  const folder = temporaryFolder(t, 'server-access-');
  const file = join(folder, 'devices.json');
  writeFileSync(file, JSON.stringify({ version: 1, devices: [options.device ?? storedDevice()] }));
  const launches: string[][] = [];
  const requests: { url: string; authorization?: string }[] = [];
  const tunnels = new SshTunnels({
    launch: async (args) => {
      launches.push(args);
      return fakeChild(
        !!(options.refuseManaged || options.failManaged) && args.includes('-F'),
        options.failManaged ? 'ssh: connect to host 203.0.113.7 port 22: Operation timed out' : undefined,
      );
    },
    terminate: async () => {},
    port: async () => 47100 + launches.length,
    ready: async () => !((options.refuseManaged || options.failManaged) && launches.at(-1)!.includes('-F')),
    now: () => 0,
    pause: async () => new Promise((resolve) => setImmediate(resolve)),
  });
  const keys = join(folder, 'server-access');
  const devices = new Devices({
    file,
    selfName: 'desk',
    tunnels,
    sshAvailable: () => options.ownSsh ?? false,
    managedKeys: new ManagedKeyFiles(keys),
    ...(options.upgrade ? { ownSsh: options.upgrade } : {}),
    fetch: async (input, init) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization') ?? undefined,
      });
      const body = String(input).endsWith('/runtimes') ? { executors: [], running: 0 } : info;
      return new Response(JSON.stringify(body), { status: 200 });
    },
  });
  return { devices, launches, requests, file, keys };
}

test('a server node keeps both its pairing token and its access key out of the cloud body', async () => {
  const value = { id: NODE, name: 'box', enrolledServer: 'box', token: 'tok-1', access: '{"version":1}' };
  const { body, secrets } = splitSecrets('server-node', { owner: '', value, deleted: false });
  assert.deepEqual(secrets, { token: 'tok-1', access: '{"version":1}' });
  assert.equal('token' in body.value || 'access' in body.value, false);
  assert.deepEqual(joinSecrets('server-node', body, secrets).value, value);
  // An older computer's record carries only the token: the access key is simply absent, nothing else changes.
  assert.deepEqual(joinSecrets('server-node', body, { token: 'tok-1' }).value, { ...body.value, token: 'tok-1' });
  assert.equal(splitSecrets('server-node', { owner: '', value, deleted: true }).secrets, undefined);
  assert.deepEqual(splitSecrets('api-provider', { owner: '', value: { key: 'k', access: 'x' }, deleted: false }), {
    body: { owner: '', value: { access: 'x' }, deleted: false },
    secrets: { key: 'k' },
  });

  // The transport sends them beside the body, and the memory cloud never stores them in it.
  const sent: unknown[] = [];
  const jwt = `x.${Buffer.from(JSON.stringify({ sub: 'user' })).toString('base64url')}.y`;
  const remote = new PostgrestSyncRemote(
    { url: 'https://fixture.supabase.co', publishableKey: 'sb_publishable_fixture' },
    'user',
    () => jwt,
    async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify([{ kind: 'server-node', id: NODE, status: 'error', code: 'X' }]));
    },
  );
  const change = { kind: 'server-node', id: NODE, body: { owner: '', value, deleted: false }, deleted: false };
  await remote.push('gen', [{ ...change, device_id: 'desk', last_seq: 0 }]);
  const wire = (sent[0] as { changes: { body: { value: object }; secrets: object }[] }).changes[0]!;
  assert.deepEqual(wire.secrets, { token: 'tok-1', access: '{"version":1}' });
  assert.ok(!JSON.stringify(wire.body).includes('tok-1') && !JSON.stringify(wire.body).includes('version'));

  const memory = new MemorySyncRemote();
  const [result] = await memory.push(memory.generation, [{ ...change, device_id: 'desk', last_seq: 0 }]);
  assert.equal(result?.status, 'accepted');
  assert.ok(!JSON.stringify([...memory.records.values()]).includes('tok-1'));
  assert.deepEqual((await memory.pull(0))[0]?.body.value, value);
});

test('the managed tunnel uses only the account key and pinned host keys, never the user SSH config', async () => {
  let args: string[] = [];
  const tunnels = new SshTunnels({
    launch: async (value) => {
      args = value;
      return fakeChild();
    },
    terminate: async () => {},
    port: async () => 47101,
    ready: async () => true,
    now: () => 0,
    pause: async () => {},
  });
  const route = {
    name: `access:${NODE}`,
    label: 'box',
    host: '203.0.113.7',
    port: 2222,
    user: 'root',
    keyFile: '/data/secrets/server-access/key',
    knownHostsFile: '/data/Application Support/server-access/known_hosts',
  };
  assert.equal(await tunnels.ensure(route, 47820), 47101);
  const option = (name: string) => args[args.indexOf(name) + 1];
  assert.equal(option('-F'), 'none');
  assert.equal(option('-i'), route.keyFile);
  assert.equal(option('-p'), '2222');
  assert.equal(option('-l'), 'root');
  assert.deepEqual(args.slice(-2), ['--', '203.0.113.7']);
  for (const setting of [
    '127.0.0.1:47101:127.0.0.1:47820',
    'ExitOnForwardFailure=yes',
    'BatchMode=yes',
    'IdentitiesOnly=yes',
    'IdentityAgent=none',
    'StrictHostKeyChecking=yes',
    'UserKnownHostsFile="/data/Application Support/server-access/known_hosts"',
    'GlobalKnownHostsFile="/data/Application Support/server-access/known_hosts"',
    'HostKeyAlias=pugport-access',
  ])
    assert.ok(args.includes(setting), setting);
  assert.ok(!args.some((arg) => /StrictHostKeyChecking=(no|accept-new)/.test(arg)));
  assert.ok(tunnels.isOpen(route.name));
  await assert.rejects(tunnels.ensure({ ...route, name: 'access:../../x' }, 47820), /Invalid SSH tunnel target/);
  assert.ok(
    managedSshArgs({ ...route, knownHostsFile: 'C:\\Users\\A B\\known_hosts' }).includes(
      'UserKnownHostsFile="C:/Users/A B/known_hosts"',
    ),
  );
  assert.throws(() => managedSshArgs({ ...route, knownHostsFile: '/x/%d/known_hosts' }), /cannot be passed/);
  assert.throws(() => managedSshArgs({ ...route, user: '-oProxyCommand=x' }));
  assert.equal(managedKeyRefused(Object.assign(new Error(), { sshOutput: 'Permission denied (publickey).' })), true);
  assert.equal(managedKeyRefused(Object.assign(new Error(), { sshOutput: 'Host key verification failed.' })), true);
  assert.equal(managedKeyRefused(Object.assign(new Error(), { sshOutput: 'Connection timed out' })), false);

  assert.deepEqual(parseSshConfig('user root\nhostname 203.0.113.7\nport 2222\nproxycommand none\n'), {
    host: '203.0.113.7',
    port: 2222,
    proxied: false,
  });
  assert.equal(parseSshConfig('hostname 203.0.113.7\nport 22\nproxyjump bastion\n')?.proxied, true);
  assert.deepEqual(parseInstallOutput(`user root\nhostkey ${HOST_KEY} root@box\nhostkey bogus\n`), {
    user: 'root',
    hostKeys: [HOST_KEY],
  });
  assert.equal(readManagedAccess('{"version":2}'), undefined);
  assert.equal(readManagedAccess(encodeManagedAccess(access()))?.host, '203.0.113.7');
});

test('the access line only forwards to the node port; adding is idempotent and removal keeps other keys', async (t) => {
  const key = generateAccessKey('pugport-access:test');
  const line = authorizedKeyLine(key.publicKey, 47820, NODE);
  assert.equal(
    line,
    `restrict,port-forwarding,permitopen="127.0.0.1:47820",permitlisten="127.0.0.1:47820",command="false" ${key.publicKey} pugport-access:${NODE}`,
  );
  assert.throws(() => authorizedKeyLine(key.publicKey, 0, NODE));
  assert.throws(() => authorizedKeyLine('ssh-rsa AAAA', 47820, NODE));
  assert.throws(() => authorizedKeyLine(key.publicKey, 47820, 'not-a-node'));
  assert.throws(() => installAccessScript("x' ; rm -rf ~ ; ' pugport-access:x"));
  if (process.platform === 'win32') {
    t.skip('the scripts run on the Linux server: needs a POSIX shell');
    return;
  }
  // The scripts run over SSH on the Linux server; here a POSIX sh runs them against a temporary HOME only.
  const home = temporaryFolder(t, 'server-access-home-');
  const sh = async (script: string) => ({
    stdout: execFileSync('/bin/sh', ['-s'], { input: script, env: { HOME: home, PATH: process.env.PATH } }).toString(),
  });
  const file = join(home, '.ssh', 'authorized_keys');

  // A missing file is created owner-only.
  const first = parseInstallOutput((await sh(installAccessScript(line))).stdout);
  assert.equal(first.user, userInfo().username);
  assert.equal(readFileSync(file, 'utf8'), `${line}\n`);
  assert.equal(statSync(file).mode & 0o777, 0o600);

  // The owner's last line without a newline is ended first; running twice adds nothing.
  writeFileSync(file, 'ssh-ed25519 AAAAowner owner@desk');
  await sh(installAccessScript(line));
  await sh(installAccessScript(line));
  assert.equal(readFileSync(file, 'utf8'), `ssh-ed25519 AAAAowner owner@desk\n${line}\n`);

  const other = authorizedKeyLine(generateAccessKey('x').publicKey, 47820, NODE);
  await sh(installAccessScript(other));
  await sh(removeAccessScript(line));
  assert.equal(readFileSync(file, 'utf8'), `ssh-ed25519 AAAAowner owner@desk\n${other}\n`);
  await sh(removeAccessScript());
  assert.equal(readFileSync(file, 'utf8'), 'ssh-ed25519 AAAAowner owner@desk\n');
  await sh(removeAccessScript());
  assert.equal(readFileSync(file, 'utf8'), 'ssh-ed25519 AAAAowner owner@desk\n');

  // The private key is a real OpenSSH key for the public half in the line.
  const keyFile = join(home, 'key');
  writeFileSync(keyFile, key.privateKey, { mode: 0o600 });
  let derived: string | undefined;
  try {
    derived = execFileSync('ssh-keygen', ['-y', '-f', keyFile], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch {
    t.diagnostic('ssh-keygen is not available: the key format was not cross-checked');
  }
  if (derived) assert.equal(derived.trim(), `${key.publicKey} pugport-access:test`);
});

test('a tunnelled server uses the account key first, its own SSH alias second, and says when it has neither', async (t) => {
  const managed = storedDevice({ access: encodeManagedAccess(access()) });
  for (const [ownSsh, device, route] of [
    [true, managed, 'account'],
    [false, managed, 'account'],
    [true, storedDevice(), 'ssh'],
    // A key for another node port (the node moved) is not used.
    [true, storedDevice({ access: encodeManagedAccess(access({ nodePort: 47821 })) }), 'ssh'],
  ] as const) {
    const f = devicesFixture(t, { device, ownSsh });
    const view = (await f.devices.view()).devices[0]!;
    assert.equal(view.route, route);
    assert.equal(view.missingSsh, undefined);
    await f.devices.check(NODE);
    const args = f.launches[0]!;
    assert.deepEqual(args.slice(-2), route === 'account' ? ['--', '203.0.113.7'] : ['--', 'box']);
    assert.equal(args.includes('-F'), route === 'account');
    assert.ok(f.requests.every((request) => request.url.startsWith('http://127.0.0.1:4710')));
    assert.equal((await f.devices.view()).devices[0]?.online, true);
    if (route === 'account' && process.platform !== 'win32') {
      const keyFile = join(f.keys, NODE, 'key');
      assert.equal(readFileSync(keyFile, 'utf8'), readManagedAccess(device.access)!.key);
      assert.equal(statSync(keyFile).mode & 0o777, 0o600);
      assert.equal(readFileSync(join(f.keys, NODE, 'known_hosts'), 'utf8'), `pugport-access ${HOST_KEY}\n`);
    }
  }

  const none = devicesFixture(t, { ownSsh: false });
  const view = (await none.devices.view()).devices[0]!;
  assert.equal(view.missingSsh, 'box');
  assert.match((await none.devices.check(NODE)).reason ?? '', /还没开通账号直连/);
  assert.equal(none.launches.length, 0);

  // A key the server turns away falls back to the own alias here and counts as not upgraded.
  const refused = devicesFixture(t, { device: managed, ownSsh: true, refuseManaged: true });
  await refused.devices.check(NODE);
  assert.deepEqual(
    refused.launches.map((args) => args.at(-1)),
    ['203.0.113.7', 'box'],
  );
  assert.equal((await refused.devices.view()).devices[0]?.route, 'ssh');
  // An address this computer cannot reach (not a refusal) also falls back, and the key stays in use.
  const unreachable = devicesFixture(t, { device: managed, ownSsh: true, failManaged: true });
  await unreachable.devices.check(NODE);
  assert.deepEqual(
    unreachable.launches.map((args) => args.at(-1)),
    ['203.0.113.7', 'box'],
  );
  assert.equal((await unreachable.devices.view()).devices[0]?.route, 'account');
  const stuck = devicesFixture(t, { device: managed, ownSsh: false, refuseManaged: true });
  await assert.rejects(stuck.devices.check(NODE), /账号直连隧道：.*Permission denied/);

  // Removing the device removes its key files.
  const gone = devicesFixture(t, { device: managed, ownSsh: false });
  await gone.devices.check(NODE);
  assert.equal(existsSync(join(gone.keys, NODE)), true);
  await gone.devices.remove(NODE);
  assert.equal(existsSync(join(gone.keys, NODE)), false);
});

test('upgrade: installs the restricted line with the own SSH, proves the key alone works, then keeps it', async (t) => {
  const scripts: string[] = [];
  let hostKeysReply = `user root\nhostkey ${HOST_KEY} root@box\n`;
  const upgrade = {
    config: async () => 'hostname 203.0.113.7\nport 22\nuser root\nproxycommand none\n',
    run: async (_alias: string, script: string) => {
      scripts.push(script);
      return script.includes('hostkey') ? hostKeysReply : '';
    },
  };
  const f = devicesFixture(t, { ownSsh: true, upgrade });
  assert.deepEqual((await f.devices.view()).devices[0]?.accessUpgrade, { state: 'pending' });
  assert.equal(f.devices.needsAccessUpgrade(NODE), true);
  assert.equal(await f.devices.upgradeAccess(NODE), true);

  assert.equal(scripts.length, 1);
  assert.match(
    scripts[0]!,
    /restrict,port-forwarding,permitopen="127\.0\.0\.1:47820",permitlisten="127\.0\.0\.1:47820"/,
  );
  const saved = JSON.parse(readFileSync(f.file, 'utf8')).devices[0] as StoredDevice;
  const stored = readManagedAccess(saved.access)!;
  assert.deepEqual(
    { host: stored.host, port: stored.port, user: stored.user, hostKeys: stored.hostKeys, nodePort: stored.nodePort },
    { host: '203.0.113.7', port: 22, user: 'root', hostKeys: [HOST_KEY], nodePort: 47820 },
  );
  // Proven with the managed key alone, with the pairing token, before it was kept.
  assert.equal(f.launches[0]?.includes('-F'), true);
  assert.deepEqual(f.requests[0], {
    url: 'http://127.0.0.1:47100/peer/v1/info',
    authorization: `Bearer ${storedDevice().token}`,
  });
  const view = (await f.devices.view()).devices[0]!;
  assert.equal(view.route, 'account');
  assert.equal(view.accessUpgrade, undefined);
  assert.equal(f.devices.needsAccessUpgrade(NODE), false);
  assert.equal(await f.devices.upgradeAccess(NODE), false);
  assert.equal(scripts.length, 1);

  // A key that does not work is taken off the server again and nothing is kept.
  const failing = devicesFixture(t, { ownSsh: true, refuseManaged: true, upgrade });
  scripts.length = 0;
  await assert.rejects(failing.devices.upgradeAccess(NODE), /Permission denied/);
  assert.equal(scripts.length, 2);
  const installed = /line='([^']+)'/.exec(scripts[0]!)![1]!;
  assert.ok(scripts[1]!.includes(installed) && scripts[1]!.includes('awk'));
  assert.equal((JSON.parse(readFileSync(failing.file, 'utf8')).devices[0] as StoredDevice).access, undefined);
  assert.equal((await failing.devices.view()).devices[0]?.accessUpgrade?.state, 'failed');

  // A jump host cannot be reproduced; nothing is installed.
  const proxied = devicesFixture(t, {
    ownSsh: true,
    upgrade: { ...upgrade, config: async () => 'hostname 10.0.0.5\nport 22\nproxyjump bastion\n' },
  });
  scripts.length = 0;
  await assert.rejects(proxied.devices.upgradeAccess(NODE), /跳板机/);
  assert.equal(scripts.length, 0);

  // A server without readable host keys is not upgraded.
  hostKeysReply = 'user root\n';
  const keyless = devicesFixture(t, { ownSsh: true, upgrade });
  await assert.rejects(keyless.devices.upgradeAccess(NODE), /主机密钥/);
});

test('node status endpoint: the probe readings behind the pairing token, services validated', async (t) => {
  const patterns: string[][] = [];
  const node = new DeviceNode({
    peersFile: join(temporaryFolder(t, 'server-access-node-'), 'peers.json'),
    port: 0,
    runner: fakeRunner().runner,
    runtimes: () => fakeRuntimes,
    machine: () => ({ totalBytes: 8e9, cpus: 4, cpuPercent: 12.5, availableMemoryBytes: 6e9 }),
    slackHost: () => false,
    now: () => Date.parse('2026-11-16T00:00:00.000Z'),
    disk: async () => ({ diskTotal: 1e11, diskFree: 4e10 }),
    services: async (given) => {
      patterns.push(given);
      return [{ name: 'actions.runner.owner-repo.box1.service', state: 'active' }];
    },
  });
  const peer = await startPeer(t, { serverStatus: (services) => node.serverStatus(services) });
  const { code } = peer.registry.createCode();
  const paired = await fetch(`${peer.url}/peer/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, name: 'Desk' }),
  });
  const { token } = await paired.json();
  const auth = { authorization: `Bearer ${token}` };

  assert.equal((await fetch(`${peer.url}/peer/v1/status`)).status, 401);
  const reply = await fetch(`${peer.url}/peer/v1/status?service=nginx&service=actions.runner.*`, { headers: auth });
  assert.equal(reply.status, 200);
  const status = await reply.json();
  assert.deepEqual(patterns, [['nginx', 'actions.runner.*']]);
  assert.equal(status.cpuPercent, 12.5);
  assert.equal(status.cores, 4);
  assert.equal(status.memoryTotal, 8e9);
  assert.equal(status.memoryAvailable, 6e9);
  assert.equal(status.diskTotal, 1e11);
  assert.equal(status.diskFree, 4e10);
  assert.equal(typeof status.arch, 'string');
  assert.deepEqual(status.services, [{ name: 'actions.runner.owner-repo.box1.service', state: 'active' }]);
  for (const query of ['service=-x', 'service=a%20b', 'other=1'])
    assert.equal((await fetch(`${peer.url}/peer/v1/status?${query}`, { headers: auth })).status, 400, query);
  assert.equal(patterns.length, 1);
  assert.ok(!(await (await fetch(`${peer.url}/peer/v1/status`, { headers: auth })).text()).includes(token));
});

test('remote server card: live status through the node; own SSH only as fallback or for a status command', async (t) => {
  const file = join(temporaryFolder(t, 'server-access-card-'), 'remote-servers.json');
  writeFileSync(
    file,
    JSON.stringify({
      servers: [
        { name: 'box', ssh: 'box', services: ['actions.runner.*'] },
        { name: 'cmd', ssh: 'cmd', statusCommand: 'uptime' },
        { name: 'far', ssh: 'far' },
        { name: 'down', ssh: 'down' },
      ],
    }),
  );
  const ssh: string[] = [];
  const node: [string, string[]][] = [];
  const monitor = new RemoteServerMonitor(
    file,
    async (alias) => {
      ssh.push(alias);
      return 'cores 2\narch x86_64\nstatus up 3 days\n';
    },
    () => Date.parse('2026-11-16T00:00:00.000Z'),
    undefined,
    undefined,
    {
      sshAvailable: (alias) => alias === 'cmd' || alias === 'down',
      accountRoute: (alias) => alias !== 'far',
      nodeReading: async (alias, services) => {
        node.push([alias, services]);
        if (alias === 'down') throw new Error('offline');
        return {
          cpuPercent: 20,
          memoryTotal: 8e9,
          memoryAvailable: 2e9,
          services: [{ name: 'actions.runner.owner-repo.box1.service', state: 'active' }],
          observedAt: '2026-11-16T00:00:00.000Z',
        };
      },
    },
  );
  const view = await monitor.view(true);
  const server = (name: string) => view.servers.find((item) => item.name === name)!;
  assert.deepEqual(node, [
    ['box', ['actions.runner.*']],
    ['down', []],
  ]);
  assert.deepEqual(ssh.sort(), ['cmd', 'down']);
  assert.equal(server('box').live?.online, true);
  assert.equal(server('box').live?.cpuPercent, 20);
  assert.deepEqual(server('box').live?.services, [{ name: 'box1', state: 'active' }]);
  assert.equal(server('box').missingSsh, undefined);
  assert.equal(server('cmd').live?.status, 'up 3 days');
  assert.equal(server('down').live?.cores, 2);
  assert.equal(server('far').missingSsh, 'far');
  assert.equal(server('far').live, undefined);
});

test('disconnect needs the own SSH: an account-only computer changes nothing; the uninstall drops the key line', async (t) => {
  const folder = temporaryFolder(t, 'server-access-enroll-');
  const file = join(folder, 'remote-servers.json');
  const original = JSON.stringify({ servers: [{ name: 'box', ssh: 'box' }] });
  writeFileSync(file, original);
  const calls: string[] = [];
  let ownSsh = false;
  const devices = {
    view: async () => ({ devices: [{ id: NODE, name: 'box', tunnel: { ssh: 'box', remotePort: 47820 } }] }),
    enrolledServerDevice: async () => NODE,
    remove: async (id: string) => {
      calls.push(`remove:${id}`);
      return { devices: [], slackHost: null };
    },
    serverReach: () => ({ ownSsh, account: true }),
  } as unknown as Devices;
  const host = fakeHost('linux', {
    run: async (_command, _args, options) => {
      calls.push(String(options?.input));
      return { stdout: '', stderr: '' };
    },
  });
  const jobs = new ServerEnrollments(file, devices, '/fake', host);
  await assert.rejects(jobs.disconnect('box', true), /完整 SSH 权限/);
  assert.equal(calls.length, 0);
  assert.equal(readFileSync(file, 'utf8'), original);

  ownSsh = true;
  await jobs.disconnect('box', false);
  assert.equal(calls[0], `remove:${NODE}`);
  const script = calls[1]!;
  assert.ok(script.indexOf('pugport-access:') < script.indexOf('~/pugport/bin/pugport node uninstall'));
  assert.match(script, /\|\| echo 'PugPort access key line could not be removed/);
});

test('auto pass: a computer with its own SSH upgrades enrolled servers, syncs, and waits after a failure', async (t) => {
  const file = join(temporaryFolder(t, 'server-access-auto-'), 'remote-servers.json');
  writeFileSync(
    file,
    JSON.stringify({
      servers: [
        { name: 'box', ssh: 'box' },
        { name: 'far', ssh: 'far' },
      ],
    }),
  );
  const upgrades: string[] = [];
  let fail = false,
    refreshes = 0,
    clock = 0;
  const devices = {
    enrolledServerDevice: async (name: string) => (name === 'box' ? NODE : 'b0000000-0000-4000-8000-000000000002'),
    needsAccessUpgrade: () => true,
    upgradeAccess: async (id: string) => {
      upgrades.push(id);
      if (fail) throw new Error('synthetic failure');
      return true;
    },
  } as unknown as Devices;
  const jobs = new ServerEnrollments(file, devices, '/fake', fakeHost('linux'), undefined, undefined, {
    // Only "box" has an SSH alias on this computer; "far" is reached through account access alone.
    sshAvailable: (alias) => alias === 'box',
    refresh: async () => {
      refreshes++;
      return true;
    },
    now: () => clock,
    delay: async () => {},
  });
  await jobs.runAutomatic();
  assert.deepEqual(upgrades, [NODE]);
  assert.equal(refreshes, 1);
  fail = true;
  await jobs.runAutomatic();
  assert.equal(upgrades.length, 2);
  await jobs.runAutomatic();
  assert.equal(upgrades.length, 2);
  clock += 600_001;
  await jobs.runAutomatic();
  assert.equal(upgrades.length, 3);
  assert.equal(refreshes, 1);
  await jobs.close();
});
