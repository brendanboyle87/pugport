import { memoryRecordStore } from './helpers/record-store.ts';
import { sessionTokenFile } from '../src/server/platform/desktop-endpoint.ts';
import { UnderTestError } from '../src/server/platform/under-test.ts';
import { productionPaths } from './helpers/production-paths.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { once } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fork } from '../src/server/platform/test-process.ts';
import { testDirectory } from '../src/server/platform/under-test.ts';
import { defaultDataDir, desktopWork, nodeDataProblem, nodeLocalPort, serverRole } from '../src/server/node/role.ts';
import {
  isLoopbackAddress,
  isTailscaleAddress,
  normalizeAddress,
  peerAddressAllowed,
  PeerListener,
  tailscaleAddress,
} from '../src/server/node/peer-listener.ts';
import { FailureLimiter, PeerRegistry } from '../src/server/node/peer-auth.ts';
import { createMachineReader } from '../src/server/platform/machine-load.ts';
import { currentHost } from '../src/server/platform/host.ts';
import { DeviceNode, peerHost, peerPort, projectFolderCheck } from '../src/server/node/device-node.ts';
import { externalTaskRunner } from '../src/server/node/peer-tasks.ts';
import { peerApp } from '../src/server/node/peer-routes.ts';
import { ExternalTasks } from '../src/server/external-tasks.ts';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import type { RunRecord, Workflow } from '../src/shared/types.ts';
import { fakeHost } from './helpers/fake-host.ts';
import { fakeRunner, startPeer, temporaryFolder } from './helpers/fake-peer.ts';
import { fetchPortAllowed } from './helpers/fetch-port.ts';
import { hostGit } from '../src/server/managed-worktrees.ts';

const repoGit = async (path: string, args: string[]) =>
  (await hostGit(path, args, { readUserConfig: true })).stdout.trim();
async function shuttleFixture(t: import('node:test').TestContext) {
  const source = temporaryFolder(t, 'peer-repo-source-');
  await repoGit(source, ['init', '-q']);
  writeFileSync(join(source, 'a.txt'), 'original\n');
  writeFileSync(join(source, '.gitignore'), 'ignored.txt\n');
  await repoGit(source, ['add', '-A']);
  await repoGit(source, ['commit', '-qm', 'initial']);
  const snapshot = await repoGit(source, ['rev-parse', 'HEAD']);
  const bundle = async (trip: string) => {
    await repoGit(source, ['update-ref', `refs/pugport/shuttle/${trip}`, snapshot]);
    const bundlePath = join(source, `${trip}.bundle`);
    await repoGit(source, ['bundle', 'create', bundlePath, `refs/pugport/shuttle/${trip}`]);
    return { key: '0123456789abcdef', trip, snapshot, bundlePath };
  };
  return { source, snapshot, bundle };
}

test('repo shuttle import preserves leftover and ignored files, blocks a running task and foreign peer', async (t) => {
  const { createRepoImporter } = await import('../src/server/node/peer-repos.ts');
  const fixture = await shuttleFixture(t);
  const store = memoryRecordStore();
  const fake = fakeRunner();
  const importer = createRepoImporter(store, fake.runner, temporaryFolder(t, 'peer-repo-home-'));
  const owner = { id: 'peer-a', name: 'Desk' };
  const first = await importer(owner, await fixture.bundle('trip-1'));
  assert.match(first.path.replaceAll('\\', '/'), /PugPort-Workspace\/repos\/0123456789abcdef$/);
  assert.equal(await repoGit(first.path, ['branch', '--show-current']), 'pugport/trip-1');
  writeFileSync(join(first.path, 'a.txt'), 'leftover\n');
  writeFileSync(join(first.path, 'ignored.txt'), 'keep me');
  const second = await importer(owner, await fixture.bundle('trip-2'));
  assert.match(await repoGit(second.path, ['log', '--all', '--format=%s']), /leftover from trip-1/);
  await repoGit(second.path, ['show-ref', '--verify', 'refs/pugport/leftover/trip-1']);
  assert.equal(readFileSync(join(second.path, 'ignored.txt'), 'utf8'), 'keep me');
  const { taskId } = await fake.runner.dispatch(
    { task: 'hold', write: true, untrusted: false, caller: 'test' },
    owner.id,
  );
  store.save('peer-repo', second.path, owner.id, {
    ...store.get<object>('peer-repo', second.path),
    lastTaskId: taskId,
  });
  await assert.rejects(importer(owner, await fixture.bundle('trip-3')), /上一条任务还没结束/);
  fake.finish(taskId, 'done');
  await importer(owner, await fixture.bundle('trip-4'));
  await assert.rejects(importer({ id: 'other', name: 'Desk' }, await fixture.bundle('trip-5')), /没有这个项目/);
});

for (const state of ['missing', 'expired', 'running', 'settled'] as const) {
  for (const operation of ['import', 'dispatch'] as const) {
    test(`repo shuttle lease: ${operation} with ${state} previous task`, async (t) => {
      const { createRepoImporter } = await import('../src/server/node/peer-repos.ts');
      const fixture = await shuttleFixture(t);
      const store = memoryRecordStore();
      const tasks = {
        dispatch: async () => ({ taskId: 'next-task', status: 'running' }),
        status: () => (state === 'missing' ? undefined : { status: state === 'settled' ? 'completed' : 'running' }),
      } as unknown as ExternalTasks;
      const runner = externalTaskRunner(tasks, store);
      const importer = createRepoImporter(store, runner, temporaryFolder(t, 'peer-lease-home-'));
      const owner = { id: 'peer', name: 'Synthetic lease' };
      const first = await importer(owner, await fixture.bundle('lease-first'));
      const lastTaskAt = Date.now() - (state === 'expired' ? 24 * 60 * 60 * 1000 + 1000 : 0);
      store.save('peer-repo', first.path, owner.id, {
        ...store.get<object>('peer-repo', first.path),
        lastTaskId: 'previous-task',
        lastTaskAt,
      });
      const pending =
        operation === 'import'
          ? importer(owner, await fixture.bundle('lease-next'))
          : runner.dispatch(
              { task: 'next', projectPath: first.path, write: true, untrusted: false, caller: 'test' },
              owner.id,
            );
      if (state === 'running') await assert.rejects(pending, /上一条任务还没结束/);
      else {
        await pending;
        if (operation === 'dispatch') {
          const record = store.get<{ lastTaskId: string; lastTaskAt: number }>('peer-repo', first.path)!;
          assert.equal(record.lastTaskId, 'next-task');
          assert.ok(record.lastTaskAt >= lastTaskAt && record.lastTaskAt > Date.now() - 10_000);
        }
      }
    });
  }
}

test('repo shuttle import route requires this peer upload, valid key and write permission', async (t) => {
  const { createRepoImporter } = await import('../src/server/node/peer-repos.ts');
  const fixture = await shuttleFixture(t);
  const store = memoryRecordStore();
  const importer = createRepoImporter(store, fakeRunner().runner, temporaryFolder(t, 'peer-route-home-'));
  const peer = await startPeer(t, { importRepo: importer });
  const pair = async (name: string) => {
    const { code } = peer.registry.createCode();
    return (await (await fetch(`${peer.url}/peer/v1/pair`, json({ code, name }))).json()).token as string;
  };
  const token = await pair('Desk');
  const other = await pair('Other');
  const body = await fixture.bundle('route-trip');
  const bytes = readFileSync(body.bundlePath);
  const upload = await fetch(
    `${peer.url}/peer/v1/files?name=project.bundle&size=${bytes.length}&requestId=repo-upload`,
    {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      body: bytes,
    },
  );
  assert.equal(upload.status, 200, await upload.clone().text());
  body.bundlePath = (await upload.json()).path;
  const { key: repoKey, ...importBody } = body;
  const post = (key: string, auth = token) =>
    fetch(`${peer.url}/peer/v1/repos/${key}/import`, {
      ...json(importBody),
      headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    });
  assert.equal((await post(body.key, other)).status, 404);
  assert.equal((await post('bad')).status, 400);
  assert.equal((await post(body.key)).status, 201);
  assert.equal((await post(body.key)).status, 404);
  const readonly = await startPeer(t, { allowWrite: false, importRepo: importer });
  const { code } = readonly.registry.createCode();
  const readonlyToken = (await (await fetch(`${readonly.url}/peer/v1/pair`, json({ code, name: 'Desk' }))).json())
    .token;
  assert.equal(
    (
      await fetch(`${readonly.url}/peer/v1/repos/${body.key}/import`, {
        ...json(body),
        headers: { authorization: `Bearer ${readonlyToken}`, 'content-type': 'application/json' },
      })
    ).status,
    400,
  );
});

for (const subfolder of [false, true])
  test(`repo shuttle exports HEAD first, excludes new secrets and names committed secrets (subfolder=${subfolder})`, async (t) => {
    const { createRepoImporter } = await import('../src/server/node/peer-repos.ts');
    const fixture = await shuttleFixture(t);
    const store = memoryRecordStore();
    let ended = false;
    const outputs: string[] = [];
    const tasks = {
      dispatch: async () => ({ taskId: 'export-task', status: 'running' }),
      status: () => ({ status: ended ? 'completed' : 'running' }),
      result: async () => ({ status: 'completed', result: 'done' }),
      fullOutputs: () => outputs,
      cancel: () => true,
    } as unknown as ExternalTasks;
    const runner = externalTaskRunner(tasks, store);
    const importer = createRepoImporter(store, runner, temporaryFolder(t, 'peer-export-home-'));
    const imported = await importer({ id: 'peer', name: 'Synthetic export' }, await fixture.bundle('export-trip'));
    const path = subfolder ? join(imported.path, 'sub') : imported.path;
    mkdirSync(path, { recursive: true });
    await runner.dispatch({ task: 'change', projectPath: path, write: true, untrusted: false, caller: 'test' }, 'peer');
    assert.equal(store.get<{ lastTaskId: string }>('peer-repo', imported.path)?.lastTaskId, 'export-task');
    await assert.rejects(
      runner.dispatch(
        {
          task: 'too soon',
          projectPath: path,
          write: true,
          untrusted: false,
          caller: 'test',
          requestId: 'busy-request',
        },
        'peer',
      ),
      /上一条任务还没结束/,
    );
    assert.equal(await runner.lookup('busy-request', 'peer'), undefined);
    await repoGit(imported.path, ['checkout', '-b', 'another']);
    writeFileSync(join(imported.path, 'id_rsa'), 'synthetic known filename');
    await repoGit(imported.path, ['add', 'id_rsa']);
    await repoGit(imported.path, ['commit', '-qm', 'task commit']);
    writeFileSync(join(imported.path, '.env'), 'DO_NOT_SEND=fixture');
    writeFileSync(join(imported.path, 'a.txt'), 'device changes\n');
    const attachments = temporaryFolder(t, 'peer-export-files-');
    for (let i = 0; i < 16; i++) {
      const file = join(attachments, `${i}.txt`);
      writeFileSync(file, 'synthetic');
      outputs.push(`PUGPORT_SEND_FILE: ${file}`);
    }
    ended = true;
    const result = await runner.result('export-task', 0);
    assert.equal(result?.files?.length, 16);
    assert.equal(result?.files?.[0]?.name, 'pugport-back-export-task.bundle');
    assert.match(result?.result ?? '', /id_rsa/);
    assert.match(result?.result ?? '', /15.txt/);
    const file = runner.file!('export-task', result!.files![0]!.id)!;
    assert.match(await repoGit(imported.path, ['bundle', 'list-heads', file.path]), / HEAD$/);
    assert.doesNotMatch(await repoGit(imported.path, ['ls-tree', '-r', '--name-only', 'HEAD']), /^\.env$/m);
  });

test('node status reports the backend executable for Full Disk Access', (t) => {
  const node = new DeviceNode({
    peersFile: join(temporaryFolder(t, 'node-status-'), 'peers.json'),
    port: 0,
    runner: {} as never,
    runtimes: () => ({ executors: [], running: 0 }),
    slackHost: () => false,
    machine: () => ({ totalBytes: 8 * 1024 ** 3, cpus: 4, availableMemoryBytes: 2 * 1024 ** 3 }),
  });
  assert.equal(node.status().execPath, process.execPath);
});

test('node info and local status report GitHub hosting independently of Slack', (t) => {
  let hosting = true;
  const node = new DeviceNode({
    peersFile: join(temporaryFolder(t, 'node-github-status-'), 'peers.json'),
    port: 0,
    runner: fakeRunner().runner,
    runtimes: () => ({ executors: [], running: 0 }),
    slackHost: () => false,
    githubHost: () => hosting,
    hardware: async () => ({ os: 'Synthetic OS', readAt: '2026-10-28T12:00:00.000Z' }),
    gpuStats: async () => undefined,
    machine: () => ({ totalBytes: 8 * 1024 ** 3, cpus: 4 }),
  });
  assert.equal(node.info().githubHost, true);
  assert.equal(node.status().githubHost, true);
  assert.equal(node.info().slackHost, false);
  hosting = false;
  assert.equal(node.info().githubHost, false);
  assert.equal(node.status().githubHost, false);
});

const iface = (address: string, family: 'IPv4' | 'IPv6' = 'IPv4', internal = false) =>
  ({
    address,
    family,
    internal,
    netmask: '',
    mac: '00:00:00:00:00:00',
    cidr: null,
    ...(family === 'IPv6' ? { scopeid: 0 } : {}),
  }) as NetworkInterfaceInfo;

test('node mode: only PUGPORT_ROLE=node, desktop work off unless named, data in the per-user folder', () => {
  assert.equal(serverRole({}), 'desktop');
  assert.equal(serverRole({ PUGPORT_ROLE: 'Node ' }), 'node');
  assert.equal(serverRole({ PUGPORT_ROLE: 'desktop' }), 'desktop');
  assert.deepEqual(desktopWork({}), { imageIndex: true, memoryIndex: true, pageTests: true });
  assert.deepEqual(desktopWork({ PUGPORT_ROLE: 'node' }), {
    imageIndex: false,
    memoryIndex: false,
    pageTests: false,
  });
  assert.deepEqual(desktopWork({ PUGPORT_ROLE: 'node', PUGPORT_NODE_FEATURES: 'images, Memory,bogus' }), {
    imageIndex: true,
    memoryIndex: true,
    pageTests: false,
  });
  const linux = fakeHost('linux');
  assert.equal(
    productionPaths(() => defaultDataDir('/srv/pugport', { PUGPORT_ROLE: 'node' }, linux)),
    '/home/fixture/.local/share/pugport/data',
  );
  assert.equal(
    productionPaths(() =>
      defaultDataDir(
        '/srv/pugport',
        { PUGPORT_ROLE: 'node' },
        fakeHost('linux', { env: { XDG_DATA_HOME: '/data/x' } }),
      ),
    ),
    '/data/x/pugport/data',
  );
  assert.equal(
    productionPaths(() => defaultDataDir('/Users/me/pugport', { PUGPORT_ROLE: 'node' }, fakeHost('darwin'))),
    '/Users/fixture/Library/Application Support/PugPort/data',
  );
  // The desktop keeps its folder next to the app, as before.
  assert.equal(
    productionPaths(() => defaultDataDir('/srv/pugport', {}, linux)),
    '/srv/pugport/.data',
  );
  assert.equal(
    productionPaths(() => peerPort({})),
    4318,
  );
  assert.equal(
    productionPaths(() => peerPort({ PUGPORT_PEER_PORT: '5000' })),
    5000,
  );
  assert.equal(
    productionPaths(() => peerPort({ PUGPORT_PEER_PORT: 'x' })),
    4318,
  );
  assert.equal(
    productionPaths(() => peerHost({ PUGPORT_PEER_HOST: '127.0.0.1' })),
    '127.0.0.1',
  );
  assert.equal(
    productionPaths(() => peerHost({ PUGPORT_PEER_HOST: 'evil.example' })),
    undefined,
  );
});

test("a node never uses the desktop app's data folders, and its own default is not one of them", () => {
  const mac = fakeHost('darwin', { tmpdir: '/Users/fixture' });
  const linux = fakeHost('linux', { tmpdir: '/home/fixture' });
  for (const [host, root, desktop] of [
    [
      mac,
      '/Users/fixture/pugport',
      [
        '/Users/fixture/Library/Application Support/ComboRunner/data',
        // APFS ignores case.
        '/Users/fixture/library/application support/comborunner/DATA/',
        '/Users/fixture/Library/Application Support/Agent Studio/data',
        '/Users/fixture/pugport/.data',
      ],
    ],
    [linux, '/home/fixture/pugport', ['/home/fixture/.config/ComboRunner/data', '/home/fixture/pugport/.data']],
  ] as const) {
    for (const dir of desktop) assert.match(nodeDataProblem(root, dir, host) ?? '', /桌面版 PugPort 的数据目录/, dir);
    assert.equal(nodeDataProblem(root, defaultDataDir(root, { PUGPORT_ROLE: 'node' }, host), host), undefined);
  }
  // Linux folders are case-sensitive.
  assert.equal(nodeDataProblem('/home/fixture/pugport', '/home/fixture/.config/comborunner/data', linux), undefined);
  assert.equal(nodeLocalPort, 4319);
});

test(
  'a node backend honours PUGPORT_PORT, reports a taken port plainly, and refuses a desktop data folder',
  { timeout: 60_000 },
  async (t) => {
    const root = join(testDirectory(), 'node-coexist');
    mkdirSync(root, { recursive: true });
    const taken = createServer();
    taken.listen(0, '127.0.0.1');
    await once(taken, 'listening');
    t.after(() => taken.close());
    const port = (taken.address() as AddressInfo).port;
    const start = (env: NodeJS.ProcessEnv) => {
      const child = fork(resolve('src/server/main.ts'), [], {
        silent: true,
        execArgv: ['--import', 'tsx'],
        env: {
          ...process.env,
          COMBORUNNER_PORT: '',
          AGENT_STUDIO_PORT: '',
          COMBORUNNER_ROOT: root,
          COMBORUNNER_DATA_DIR: join(root, 'node-data'),
          PUGPORT_ROLE: 'node',
          PUGPORT_PEER_HOST: '127.0.0.1',
          PUGPORT_PEER_PORT: '0',
          PUGPORT_NODE_FEATURES: '',
          PUGPORT_RUNTIME_DIR: join(root, 'runtime'),
          ...env,
        },
      });
      let stdout = '',
        stderr = '';
      const messages: { type?: string }[] = [];
      child.stdout!.on('data', (data) => (stdout += String(data)));
      child.stderr!.on('data', (data) => (stderr += String(data)));
      child.on('message', (message: { type?: string }) => messages.push(message));
      t.after(() => {
        if (child.exitCode === null) child.kill();
      });
      return once(child, 'exit').then(([code]) => ({ code, stdout, stderr, messages }));
    };
    const sessionFile = sessionTokenFile(port);
    mkdirSync(resolve(sessionFile, '..'), { recursive: true });
    const stale = JSON.stringify({ token: 'fixture', pid: process.pid, port });
    writeFileSync(sessionFile, stale);
    t.after(() => {
      try {
        unlinkSync(sessionFile);
      } catch {}
    });
    const busy = await start({ PUGPORT_PORT: String(port) });
    assert.equal(readFileSync(sessionFile, 'utf8'), stale);
    assert.equal(busy.code, 1, busy.stderr);
    assert.match(busy.stderr, new RegExp(`EADDRINUSE: 127\\.0\\.0\\.1:${port} is already in use.*PUGPORT_PORT`));
    // A listen error must not run the startup work: nothing may claim the port or start node work.
    assert.doesNotMatch(busy.stdout, /listening at|\[peer\] listening/);
    assert.deepEqual(
      busy.messages.map((message) => message.type),
      ['session', 'fatal'],
    );
    const shared = await start({ PUGPORT_PORT: '0', COMBORUNNER_DATA_DIR: join(root, '.data') });
    assert.notEqual(shared.code, 0);
    assert.match(shared.stderr, /桌面版 PugPort 的数据目录/);
    assert.equal(existsSync(join(root, '.data')), false);
  },
);

test('under-test peers default to ephemeral loopback and reject non-loopback hosts', () => {
  assert.equal(peerPort({}), 0);
  assert.equal(peerPort({ PUGPORT_PEER_PORT: 'x' }), 0);
  assert.equal(peerPort({ PUGPORT_PEER_PORT: '5000' }), 5000);
  assert.equal(peerHost({}), '127.0.0.1');
  for (const host of ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1'])
    assert.equal(peerHost({ PUGPORT_PEER_HOST: host }), host);
  for (const host of ['0.0.0.0', '::', '100.64.0.1', '192.168.1.2', 'evil.example'])
    assert.throws(() => peerHost({ PUGPORT_PEER_HOST: host }), UnderTestError);
});

test('the peer listener accepts only Tailscale addresses (and loopback when bound to it)', () => {
  for (const address of [
    '100.64.0.1',
    '100.127.255.254',
    '::ffff:100.100.1.2',
    'fd7a:115c:a1e0::1',
    'FD7A:115C:A1E0:ab12::9',
  ])
    assert.equal(isTailscaleAddress(address), true, address);
  for (const address of ['100.63.255.255', '100.128.0.1', '10.0.0.5', '192.168.1.2', '::1', 'fd7a:115c:a1e1::1', 'x'])
    assert.equal(isTailscaleAddress(address), false, address);
  assert.equal(normalizeAddress('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(peerAddressAllowed('127.0.0.1', false), false);
  assert.equal(peerAddressAllowed('127.0.0.1', true), true);
  assert.equal(peerAddressAllowed('192.168.1.2', true), false);
  assert.equal(peerAddressAllowed(undefined, true), false);
  assert.equal(
    tailscaleAddress({
      lo: [iface('127.0.0.1', 'IPv4', true)],
      eth0: [iface('192.168.1.5')],
      tailscale0: [iface('fd7a:115c:a1e0::5', 'IPv6'), iface('100.101.102.103')],
    }),
    '100.101.102.103',
  );
  assert.equal(tailscaleAddress({ eth0: [iface('192.168.1.5')] }), undefined);
});

test('the listener waits for the Tailscale address, tries it once it appears, and keeps retrying', async (t) => {
  let interfaces: Record<string, ReturnType<typeof iface>[]> = { eth0: [iface('192.168.1.5')] };
  const logs: string[] = [];
  const listener = new PeerListener({
    handler: (_req, res) => res.end(),
    port: 0,
    interfaces: () => interfaces,
    retryMs: () => 20,
    log: (line) => logs.push(line),
  });
  t.after(() => listener.close());
  listener.start();
  assert.equal(listener.state().status, 'waiting');
  await new Promise((done) => setTimeout(done, 60));
  assert.equal(listener.state().status, 'waiting');
  assert.equal(logs.filter((line) => line.includes('waiting')).length, 1, 'said once, not on every retry');
  // An address this machine does not have cannot be bound: an error, then more attempts.
  interfaces = { tailscale0: [iface('100.101.102.103')] };
  for (let i = 0; i < 100 && listener.state().status !== 'error'; i++)
    await new Promise((done) => setTimeout(done, 10));
  assert.equal(listener.state().status, 'error');
  assert.equal(listener.state().host, '100.101.102.103');
});

test('a listener bound to all addresses drops loopback connections before reading a request', async (t) => {
  let reached = false;
  const listen = async () => {
    const listener = new PeerListener({
      handler: (_req, res) => {
        reached = true;
        res.end('{}');
      },
      port: 0,
      host: '0.0.0.0',
    });
    t.after(() => listener.close());
    listener.start();
    for (let i = 0; i < 200 && listener.state().status !== 'listening'; i++)
      await new Promise((done) => setTimeout(done, 10));
    assert.equal(listener.state().status, 'listening');
    return listener.boundPort()!;
  };
  // Fetch rejects a blocked port without connecting, which would pass this test without testing anything.
  let port = await listen();
  while (!fetchPortAllowed(port)) port = await listen();
  await assert.rejects(fetch(`http://127.0.0.1:${port}/peer/v1/info`, { signal: AbortSignal.timeout(3000) }));
  assert.equal(reached, false);
});

test('pairing: a short code works once, wrong guesses use it up, and only the token hash is kept', async (t) => {
  const folder = temporaryFolder(t, 'peer-registry-test-');
  const file = join(folder, 'peers.json');
  let now = Date.parse('2026-10-11T08:00:00Z');
  const registry = new PeerRegistry(file, { now: () => now, helperTimeoutMs: 15_000 });
  await registry.load();
  assert.equal(await registry.pair('ABCD-EFGH', 'Desk'), 'no-code');
  const { code, expiresAt } = registry.createCode();
  assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(expiresAt, '2026-10-11T08:10:00.000Z');
  assert.equal(await registry.pair('WRONG-ONE', 'Desk'), 'wrong');
  // Spacing and case do not matter.
  const paired = await registry.pair(code.toLowerCase().replace('-', ' '), 'Desk');
  assert.ok(typeof paired === 'object');
  assert.match(paired.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await registry.pair(code, 'Again'), 'no-code', 'used once');
  const saved = readFileSync(file, 'utf8');
  assert.ok(!saved.includes(paired.token), 'the token itself is never stored');
  assert.match(saved, /"tokenHash": "[a-f0-9]{64}"/);
  assert.equal(registry.authenticate(paired.token)?.name, 'Desk');
  assert.equal(registry.authenticate(`${paired.token.slice(0, -1)}x`), undefined);
  assert.equal(registry.authenticate('short'), undefined);
  assert.equal(registry.authenticate(undefined), undefined);
  assert.ok(registry.list()[0]!.lastSeenAt);

  // Five wrong guesses void a code; so does time.
  const second = registry.createCode();
  for (let i = 0; i < 5; i++) assert.equal(await registry.pair('XXXX-XXXX', 'Desk'), 'wrong');
  assert.equal(await registry.pair(second.code, 'Desk'), 'no-code');
  const third = registry.createCode();
  now += 10 * 60_000 + 1;
  assert.equal(await registry.pair(third.code, 'Desk'), 'no-code');

  // A fresh read sees the same peers; revoking removes them.
  const again = new PeerRegistry(file, { helperTimeoutMs: 15_000 });
  await again.load();
  assert.equal(again.authenticate(paired.token)?.id, paired.peer.id);
  assert.equal(await again.revoke(paired.peer.id), true);
  assert.equal(again.authenticate(paired.token), undefined);
  assert.equal(await again.revoke(paired.peer.id), false);

  // A damaged record is refused, never overwritten.
  writeFileSync(file, '{"version":1,"peers":[{"id":"x"}]}');
  await assert.rejects(new PeerRegistry(file).load(), /格式无效/);
  assert.equal(readFileSync(file, 'utf8'), '{"version":1,"peers":[{"id":"x"}]}');
});

test('failed sign-ins are limited per address', () => {
  let now = 0;
  const limiter = new FailureLimiter(3, 1000, () => now);
  for (let i = 0; i < 3; i++) limiter.fail('a');
  assert.equal(limiter.blocked('a'), true);
  assert.equal(limiter.blocked('b'), false);
  now = 1001;
  assert.equal(limiter.blocked('a'), false);
});

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('the peer API: pairing, bearer tokens, no browsers, and nothing secret in replies or logs', async (t) => {
  const peer = await startPeer(t);
  const { code } = peer.registry.createCode();
  const wrong = await fetch(`${peer.url}/peer/v1/pair`, json({ code: 'AAAA-AAAA', name: 'Desk' }));
  assert.equal(wrong.status, 403);
  assert.match((await wrong.json()).error, /配对码不对/);
  const paired = await fetch(`${peer.url}/peer/v1/pair`, json({ code, name: 'Alex 的电脑' }));
  assert.equal(paired.status, 201);
  const { token, peerId, node } = await paired.json();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(node.peerName, 'Alex 的电脑');
  assert.equal(node.hostname, 'ubuntu-box');
  const auth = { authorization: `Bearer ${token}` };

  assert.equal((await fetch(`${peer.url}/peer/v1/info`)).status, 401);
  assert.equal((await fetch(`${peer.url}/peer/v1/info`, { headers: { authorization: 'Bearer nope' } })).status, 401);
  const info = await fetch(`${peer.url}/peer/v1/info`, { headers: auth });
  assert.equal(info.status, 200);
  const infoText = await info.text();
  assert.ok(!infoText.includes(token));
  assert.equal(JSON.parse(infoText).peerName, 'Alex 的电脑');
  // A page in a browser can never use it, even with a stolen token.
  assert.equal(
    (await fetch(`${peer.url}/peer/v1/info`, { headers: { ...auth, origin: 'http://evil.example' } })).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${peer.url}/peer/v1/tasks`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'text/plain' },
        body: 'x',
      })
    ).status,
    415,
  );
  const runtimes = await (await fetch(`${peer.url}/peer/v1/runtimes`, { headers: auth })).json();
  assert.equal(runtimes.executors[0].label, 'Claude 测试号');
  assert.equal((await fetch(`${peer.url}/peer/v1/files`, { headers: auth })).status, 404);
  for (const line of peer.logs) {
    assert.ok(!line.includes(token));
    assert.ok(!line.includes(code.replace('-', '')) && !line.includes(code));
  }
  // Revoking itself ends its access.
  const revoked = await fetch(`${peer.url}/peer/v1/pairing`, { method: 'DELETE', headers: auth });
  assert.equal(revoked.status, 200);
  assert.equal((await fetch(`${peer.url}/peer/v1/info`, { headers: auth })).status, 401);
  assert.equal(
    peer.registry.list().some((item) => item.id === peerId),
    false,
  );
});

test('the peer API turns an address away after too many failed tokens', async (t) => {
  const peer = await startPeer(t, { limiter: new FailureLimiter(3) });
  const { code } = peer.registry.createCode();
  const { token } = await (await fetch(`${peer.url}/peer/v1/pair`, json({ code, name: 'Desk' }))).json();
  for (let i = 0; i < 3; i++)
    assert.equal(
      (await fetch(`${peer.url}/peer/v1/info`, { headers: { authorization: `Bearer ${'x'.repeat(43)}` } })).status,
      401,
    );
  const blocked = await fetch(`${peer.url}/peer/v1/info`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(blocked.status, 429);
});

test('peer tasks: read-only opt-out, folders only when they exist there, and each peer sees only its own', async (t) => {
  const folder = temporaryFolder(t, 'peer-tasks-test-');
  const peer = await startPeer(t, {
    allowWrite: false,
    projectFolder: (path) => (path === '/home/me/notes' ? path : undefined),
  });
  const pairOne = async (name: string) => {
    const { code } = peer.registry.createCode();
    const { token } = await (await fetch(`${peer.url}/peer/v1/pair`, json({ code, name }))).json();
    return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  };
  const desk = await pairOne('Desk');
  const laptop = await pairOne('Laptop');
  const post = (headers: Record<string, string>, body: unknown) =>
    fetch(`${peer.url}/peer/v1/tasks`, { method: 'POST', headers, body: JSON.stringify(body) });

  assert.equal((await post(desk, { task: '' })).status, 400);
  assert.equal((await post(desk, { task: 'x', extra: 1 })).status, 400, 'unknown fields are refused');
  const write = await post(desk, { task: 'x', write: true, projectPath: '/home/me/notes' });
  assert.equal(write.status, 400);
  assert.match((await write.json()).error, /已关闭写入（PUGPORT_PEER_READ_ONLY=1）/);
  const noFolder = await post(desk, { task: 'x', write: true });
  assert.equal(noFolder.status, 400);
  assert.match((await noFolder.json()).error, /已关闭写入（PUGPORT_PEER_READ_ONLY=1）/);
  const missing = await post(desk, { task: 'x', projectPath: join(folder, 'nope') });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /没有这个文件夹/);
  assert.equal((await post(desk, { task: 'x'.repeat(300_000) })).status, 413);

  const created = await post(desk, {
    task: '总结这份笔记',
    title: '笔记',
    projectPath: '/home/me/notes',
    untrusted: true,
  });
  assert.equal(created.status, 201);
  const { taskId } = await created.json();
  const task = peer.tasks.get(taskId)!;
  assert.deepEqual(task.input, {
    task: '总结这份笔记',
    title: '笔记',
    projectPath: '/home/me/notes',
    write: false,
    untrusted: true,
    caller: '设备 · Desk',
  });

  const status = await (await fetch(`${peer.url}/peer/v1/tasks/${taskId}`, { headers: desk })).json();
  assert.equal(status.status, 'running');
  assert.equal(status.executor, 'Claude 测试号');
  // Another paired PugPort cannot see, wait on or stop it.
  for (const path of [`/peer/v1/tasks/${taskId}`, `/peer/v1/tasks/${taskId}/result`])
    assert.equal((await fetch(`${peer.url}${path}`, { headers: laptop })).status, 404);
  assert.equal(
    (await fetch(`${peer.url}/peer/v1/tasks/${taskId}/cancel`, { method: 'POST', headers: laptop })).status,
    404,
  );
  assert.equal((await fetch(`${peer.url}/peer/v1/tasks/..%2F..%2Fetc/result`, { headers: desk })).status, 400);

  // The result waits for the answer.
  const waiting = fetch(`${peer.url}/peer/v1/tasks/${taskId}/result?wait=5`, { headers: desk }).then((reply) =>
    reply.json(),
  );
  setTimeout(() => peer.finish(taskId, '这是总结'), 50);
  assert.deepEqual(await waiting, { status: 'completed', result: '这是总结' });
  assert.equal((await fetch(`${peer.url}/peer/v1/tasks/${taskId}/result?wait=999`, { headers: desk })).status, 400);

  // Cancelling.
  const second = await (await post(desk, { task: '另一件事' })).json();
  assert.equal(
    (await fetch(`${peer.url}/peer/v1/tasks/${second.taskId}/cancel`, { method: 'POST', headers: desk })).status,
    200,
  );
  assert.equal(peer.tasks.get(second.taskId)!.status, 'cancelled');
});

test('peer writes use a validated default workspace and forward it to the desktop, without a chosen folder', async (t) => {
  const home = temporaryFolder(t, 'peer-home-test-');
  t.mock.getter(currentHost(), 'home', () => home);
  const workspace = join(home, 'PugPort-Workspace');
  const chosen = join(home, 'chosen');
  mkdirSync(chosen);
  const checked: string[] = [];
  const peer = await startPeer(t, {
    allowWrite: true,
    projectFolder: (path) => {
      checked.push(path);
      return projectFolderCheck()(path);
    },
  });
  const { code } = peer.registry.createCode();
  const { token } = await (await fetch(`${peer.url}/peer/v1/pair`, json({ code, name: 'Desk' }))).json();
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const post = (body: unknown) =>
    fetch(`${peer.url}/peer/v1/tasks`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await post({ task: 'x', write: true, untrusted: true })).status, 400);
  assert.equal(existsSync(workspace), false, 'untrusted writes cannot create a working folder');
  const noFolder = await post({ task: 'install requested software', write: true, requestId: 'write-1' });
  assert.equal(noFolder.status, 201);
  const input = peer.tasks.get((await noFolder.json()).taskId)!.input;
  assert.equal(input.write, true);
  assert.equal(input.projectPath, workspace);
  assert.equal(input.requestId, 'write-1');
  assert.equal(existsSync(workspace), true);
  assert.deepEqual(checked, [workspace], 'the newly created folder must pass the existing folder check');
  let forwarded: { projectPath?: string; write: boolean; task: string } | undefined;
  const store = memoryRecordStore();
  const runner = externalTaskRunner(
    { dispatch: () => assert.fail('the desktop must execute this task') } as unknown as ExternalTasks,
    store,
    {
      tray: async () => [],
      probe: async () => 'device',
      dispatch: async (task) => {
        forwarded = task;
        return { taskId: 'desktop-task', status: 'queued' };
      },
      status: async () => undefined,
      result: async () => undefined,
      cancel: async () => true,
    },
  );
  await runner.dispatch(input, 'peer-1');
  assert.equal(forwarded?.projectPath, workspace);
  assert.equal(forwarded?.write, true);
  assert.match(forwarded!.task, /Download, install, and configure/);
  assert.match(forwarded!.task, /sudo -n true/);
  assert.match(forwarded!.task, /exact command\(s\)/);
  assert.match(forwarded!.task, /exactly what to click/);
  assert.match(forwarded!.task, /PUGPORT_SEND_FILE:/);
  assert.equal((await post({ task: 'x', write: true, projectPath: chosen, untrusted: true })).status, 400);
  const created = await post({ task: 'x', write: true, projectPath: chosen });
  assert.equal(created.status, 201);
  assert.equal(peer.tasks.get((await created.json()).taskId)!.input.write, true);
});

test('peer default workspaces rejected by the project folder check never dispatch', async (t) => {
  const home = temporaryFolder(t, 'peer-rejected-home-');
  t.mock.getter(currentHost(), 'home', () => home);
  const peer = await startPeer(t, { projectFolder: () => undefined });
  const { code } = peer.registry.createCode();
  const { token } = await (await fetch(`${peer.url}/peer/v1/pair`, json({ code, name: 'Desk' }))).json();
  const result = await fetch(`${peer.url}/peer/v1/tasks`, {
    ...json({ task: 'x', write: true }),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  assert.equal(result.status, 400);
  assert.match((await result.json()).error, /不能用作项目文件夹/);
  assert.equal(peer.tasks.size, 0);
});

test('peer dispatch handler validates default folders and permissions without a listener', async (t) => {
  const home = temporaryFolder(t, 'peer-handler-home-');
  t.mock.getter(currentHost(), 'home', () => home);
  const workspace = join(home, 'PugPort-Workspace');
  const fake = fakeRunner();
  const post = (allowWrite: boolean, rejectFolder = false) => {
    const app = peerApp({
      registry: {} as PeerRegistry,
      runner: fake.runner,
      info: () => ({}) as never,
      runtimes: () => ({ executors: [], running: 0 }),
      allowWrite,
      projectFolder: rejectFolder ? () => undefined : projectFolderCheck(),
    });
    const router = app.router as {
      stack: { route?: { path: string; stack: { handle: (req: unknown, res: unknown) => Promise<void> }[] } }[];
    };
    const handle = router.stack.find((layer) => layer.route?.path === '/peer/v1/tasks')!.route!.stack[0]!.handle;
    return (body: unknown) =>
      handle(
        { body, peer: { id: 'synthetic-peer', name: 'Synthetic desk' } },
        { status: (code: number) => ({ json: () => assert.equal(code, 201) }) },
      );
  };
  await assert.rejects(post(false)({ task: 'x', write: true }), /已关闭写入/);
  await assert.rejects(post(true)({ task: 'x', write: true, untrusted: true }), /只能只读/);
  assert.equal(existsSync(workspace), false);
  await post(true)({ task: 'x', write: true });
  assert.equal(fake.tasks.get('task-1')!.input.projectPath, workspace);
  assert.equal(fake.tasks.get('task-1')!.input.write, true);
  assert.equal(existsSync(workspace), true);
  await assert.rejects(post(true, true)({ task: 'x', write: true }), /不能用作项目文件夹/);
  assert.equal(fake.tasks.size, 1);
  await post(true)({ task: 'read only' });
  assert.equal(fake.tasks.get('task-2')!.input.projectPath, undefined);
  assert.equal(fake.tasks.get('task-2')!.input.write, false);
});

test('device execution instructions reach node and desktop only on trusted writes', async () => {
  for (const desktop of [false, true]) {
    const calls: { task: string; projectPath?: string }[] = [];
    const dispatch = async (input: { task: string; projectPath?: string }) => {
      calls.push(input);
      return { taskId: `task-${calls.length}`, status: 'queued' };
    };
    const runner = externalTaskRunner(
      { dispatch } as unknown as ExternalTasks,
      memoryRecordStore(),
      desktop
        ? {
            tray: async () => [],
            probe: async () => 'device',
            dispatch,
            status: async () => undefined,
            result: async () => undefined,
            cancel: async () => true,
          }
        : undefined,
    );
    for (const [write, untrusted] of [
      [true, false],
      [false, false],
      [false, true],
      [true, true],
    ]) {
      await runner.dispatch(
        {
          task: 'x',
          caller: 'Synthetic desk',
          projectPath: '/synthetic/workspace',
          write: write!,
          untrusted: untrusted!,
        },
        'peer-1',
      );
      const input = calls.at(-1)!;
      assert.equal(input.projectPath, '/synthetic/workspace');
      assert.equal(input.task.includes('Download, install, and configure'), write && !untrusted);
      assert.match(input.task, /PUGPORT_SEND_FILE:/);
    }
  }
});

test('task events stream each change, then the result, then end', async (t) => {
  const peer = await startPeer(t);
  const { code } = peer.registry.createCode();
  const { token } = await (await fetch(`${peer.url}/peer/v1/pair`, json({ code, name: 'Desk' }))).json();
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const { taskId } = await (
    await fetch(`${peer.url}/peer/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({ task: 'x' }) })
  ).json();
  const reply = await fetch(`${peer.url}/peer/v1/tasks/${taskId}/events`, { headers });
  assert.equal(reply.headers.get('content-type'), 'text/event-stream');
  setTimeout(() => peer.finish(taskId, '完成了'), 100);
  const text = await reply.text();
  assert.match(text, /event: status\ndata: \{"taskId":"task-1","status":"running"/);
  assert.match(text, /event: result\ndata: \{"status":"completed","result":"完成了"\}/);
});

test('choosing the Slack host: tokens are checked and never echoed back', async (t) => {
  const peer = await startPeer(t);
  const { code } = peer.registry.createCode();
  const { token } = await (await fetch(`${peer.url}/peer/v1/pair`, json({ code, name: 'Desk' }))).json();
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const put = (body: unknown) =>
    fetch(`${peer.url}/peer/v1/slack`, { method: 'PUT', headers, body: JSON.stringify(body) });
  assert.equal((await put({ host: true })).status, 400);
  const appToken = 'xapp-1-fixture-app-token-0000';
  const botToken = 'xoxb-fixture-bot-token-0000';
  const handed = await put({
    host: true,
    appToken,
    botToken,
    users: [{ id: 'U12345', pairedAt: '2026-10-11T08:00:00Z' }],
  });
  const text = await handed.text();
  assert.equal(handed.status, 200);
  assert.deepEqual(JSON.parse(text), { slackHost: true });
  assert.ok(!text.includes(appToken) && !text.includes(botToken));
  assert.equal(peer.slackCalls[0]!.host, true);
  assert.deepEqual(await (await put({ host: false })).json(), { slackHost: false });
});

test('round4 request lookup is peer-scoped, survives runner recreation and never dispatches', async () => {
  const store = memoryRecordStore();

  let created = 0;
  const tasks = {
    dispatch: async () => ({ taskId: `task-${++created}`, status: 'queued' }),
  } as unknown as ExternalTasks;
  const runner = externalTaskRunner(tasks, store);
  assert.equal(await runner.lookup('missing', 'peer-1'), undefined);
  await runner.dispatch(
    { task: 'Synthetic read', requestId: 'r1', write: false, untrusted: false, caller: 'Synthetic' },
    'peer-1',
  );
  const restarted = externalTaskRunner(tasks, store);
  assert.equal(await restarted.lookup('r1', 'peer-1'), 'task-1');
  assert.equal(await restarted.lookup('r1', 'peer-2'), undefined);
  store.save('peer-request', 'peer-1:pending', 'peer-1', { status: 'dispatching' });
  await assert.rejects(restarted.lookup('pending', 'peer-1'), /不确定/);
  assert.equal(created, 1);
});

test('round4 request routes distinguish absent requests from unsupported routes and preserve completed tasks', async (t) => {
  const peer = await startPeer(t);
  const pair = await peer.registry.pair(peer.registry.createCode().code, 'Synthetic');
  assert.equal(typeof pair, 'object');
  if (typeof pair !== 'object') return;
  const headers = { authorization: `Bearer ${pair.token}`, 'content-type': 'application/json' };
  for (const method of ['GET', 'POST']) {
    const response = await fetch(`${peer.url}/peer/v1/requests/missing${method === 'POST' ? '/cancel' : ''}`, {
      method,
      headers,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { taskId: null });
  }
  assert.equal(peer.tasks.size, 0);
  const sent = await fetch(`${peer.url}/peer/v1/tasks`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ task: 'Synthetic', requestId: 'r1' }),
  });
  const { taskId } = (await sent.json()) as { taskId: string };
  peer.finish(taskId, 'Done');
  const stopped = await fetch(`${peer.url}/peer/v1/requests/r1/cancel`, { method: 'POST', headers });
  assert.deepEqual(await stopped.json(), { taskId });
  assert.equal(peer.tasks.get(taskId)!.status, 'completed');
});

test('a peer task is an external task on the node: owner kept beside it, only plain fields leave', async () => {
  const store = memoryRecordStore();
  const calls: unknown[] = [];
  const tasks = {
    dispatch: async (input: unknown) => {
      calls.push(input);
      return { taskId: 'wf-1', conversationId: 'conv-1', title: 't', status: 'queued' };
    },
    status: () => ({
      taskId: 'wf-1',
      conversationId: 'conv-1',
      status: 'running',
      phase: 'execute',
      executor: 'Claude B',
      model: 'm',
      startedAt: 's',
      endedAt: undefined,
      note: '排队',
      progress: {
        lastActivityAt: '2026-10-20T10:32:00Z',
        toolCalls: 12,
        toolCallsAtLeast: true,
        step: { kind: 'tool', tool: 'Edit', status: 'running', input: 'SYNTHETIC-INPUT-91d2' },
        planStep: { index: 2, total: 3 },
        recentOutput: 'SYNTHETIC-INPUT-91d2',
        outcome: { status: 'SYNTHETIC-INPUT-91d2' },
        relayedFrom: { label: 'private node account' },
      },
    }),
    result: async () => ({ status: 'completed', result: 'r'.repeat(300_000) }),
    cancel: () => true,
  } as unknown as ExternalTasks;
  const runner = externalTaskRunner(tasks, store);
  await runner.dispatch({ task: 'x', title: '标题', write: false, untrusted: true, caller: '设备 · Desk' }, 'peer-1');
  assert.deepEqual(calls[0], {
    task: `x\n\nTo send a file back to the user's other computer, put a whole line in your final answer:\nPUGPORT_SEND_FILE: <absolute path on this computer>`,
    caller: '设备 · Desk',
    source: 'device',
    title: '设备 · Desk · 标题',
    readOnly: true,
    untrusted: true,
  });
  assert.equal(runner.owner('wf-1'), 'peer-1');
  assert.equal(runner.owner('wf-2'), undefined);
  const status = runner.status('wf-1')!;
  assert.equal('conversationId' in status, false);
  assert.equal(status.executor, 'Claude B');
  assert.deepEqual(status.progress, {
    lastActivityAt: '2026-10-20T10:32:00Z',
    toolCalls: 12,
    toolCallsAtLeast: true,
    step: { kind: 'tool', tool: 'Edit', status: 'running' },
    planStep: { index: 2, total: 3 },
  });
  assert.ok(!JSON.stringify(status).includes('SYNTHETIC-INPUT-91d2'));
  for (const key of ['recentOutput', 'outcome', 'relayedFrom', 'input'])
    assert.ok(!JSON.stringify(status).includes(key));
  assert.equal((await runner.result('wf-1', 0))!.result!.length, 200_000);
});

test('node task tool input and output stay on the node while peer status carries public progress', async (t) => {
  t.after(async () => {
    await workspace.close();
    await controller.close();
  });
  const folder = temporaryFolder(t, 'node-progress-test-');
  const controller = new Controller(folder, join(folder, 'data'));
  clearInterval(controller.timer);
  const workspace = new Workspace(controller, { autoTick: false });
  const tasks = new ExternalTasks(workspace);
  const runner = externalTaskRunner(tasks, workspace.store);
  const created = await runner.dispatch(
    { task: 'Inspect synthetic input', write: false, untrusted: false, caller: 'Synthetic desk' },
    'synthetic-peer',
  );
  const workflow = workspace.store.get<Workflow>('workflow', created.taskId)!;
  const marker = 'SYNTHETIC-INPUT-91d2';
  const run: RunRecord = {
    id: 'node-progress-run',
    workflowId: workflow.id,
    projectPath: folder,
    prompt: 'Synthetic request',
    kind: 'general',
    status: 'running',
    startedAt: '2026-10-20T10:30:00Z',
    output: marker,
    eventsDropped: 2,
    route: { runtimeId: 'synthetic', model: 'synthetic-model', kind: 'general', reasons: [], warnings: [] },
    events: [
      {
        type: 'tool',
        at: '2026-10-20T10:32:00Z',
        text: marker,
        data: { tool: 'Edit', toolCallId: 'synthetic-call', status: 'running', input: marker, output: marker },
      },
    ],
  };
  workflow.status = 'running';
  workflow.runIds = [run.id];
  workflow.activeStepId = 'synthetic-step';
  workflow.plan = [
    {
      id: 'synthetic-step',
      title: 'Synthetic',
      instruction: '',
      kind: 'auto',
      transport: 'auto',
      dependsOn: [],
      status: 'running',
      runIds: [run.id],
    },
  ];
  controller.store.saveRun(run);
  workspace.store.save('workflow', workflow.id, workflow.conversationId, workflow);
  assert.equal(tasks.status(workflow.id)?.progress?.recentOutput, marker, 'node itself has its output');
  const status = runner.status(workflow.id)!;
  assert.deepEqual(status.progress, {
    lastActivityAt: '2026-10-20T10:32:00Z',
    toolCalls: 1,
    toolCallsAtLeast: true,
    step: { kind: 'tool', tool: 'Edit', status: 'running' },
    planStep: { index: 1, total: 1 },
  });
  assert.ok(!JSON.stringify(status).includes(marker));
  for (const key of ['recentOutput', 'outcome', 'relayedFrom', 'input', 'output'])
    assert.ok(!JSON.stringify(status).includes(key));
});

test('a project folder on the node must exist and stay out of system, key and home folders', (t) => {
  const folder = temporaryFolder(t, 'peer-folder-test-');
  const check = projectFolderCheck();
  assert.ok(check(folder));
  assert.equal(check(join(folder, 'missing')), undefined);
  assert.equal(check('relative/path'), undefined);
  writeFileSync(join(folder, 'file.txt'), 'x');
  assert.equal(check(join(folder, 'file.txt')), undefined);
  assert.equal(check(process.platform === 'win32' ? 'C:\\' : '/'), undefined);
});

import { nodeRuntimes, trayExecutors } from '../src/server/node/node-runtimes.ts';
import { peerInfoSchema, peerRuntimesSchema } from '../src/server/node/peer-protocol.ts';

test('node hardware refresh never blocks start or info, coalesces reads and catches failures', async (t) => {
  let reads = 0;
  let listening = false;
  t.mock.method(PeerListener.prototype, 'start', () => {
    listening = true;
  });
  let finish!: (value: { os: string; readAt: string }) => void;
  let fail = false;
  const node = new DeviceNode({
    peersFile: join(temporaryFolder(t, 'node-hardware-'), 'peers.json'),
    port: 0,
    runner: {} as never,
    runtimes: () => ({ executors: [], running: 0 }),
    slackHost: () => false,
    machine: () => ({ totalBytes: 8 * 1024 ** 3, cpus: 4, availableMemoryBytes: 2 * 1024 ** 3 }),
    gpuStats: async () => undefined,
    hardware: () => {
      reads++;
      if (fail) throw new Error('synthetic failure');
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const hardware = { os: 'Synthetic Linux', readAt: '2026-10-21T00:00:00Z' };
  // Keep the injected reader pending until startup has had a chance to open the listener.
  t.mock.method(node.registry, 'load', async () => {});
  const starting = node.start();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reads, 1);
    assert.equal(listening, true, 'hardware must not delay the peer listener');
    assert.equal(node.info().hardware, undefined);
    node.info();
    assert.equal(reads, 1);
  } finally {
    finish(hardware);
    await starting;
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(peerInfoSchema.parse(node.info()).hardware, hardware);
  const clock = Date.now();
  t.mock.method(Date, 'now', () => clock + 61_000);
  assert.deepEqual(node.info().hardware, hardware);
  node.info();
  await Promise.resolve();
  assert.equal(reads, 2);
  finish(hardware);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.method(Date, 'now', () => clock + 122_000);
  fail = true;
  node.info();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(node.info().hardware, hardware);
});

test('node runtimes merge desktop extras by label, cap web plans, retain stale extras only through tray failures', async () => {
  const own = {
    id: 'local',
    label: 'Codex',
    provider: 'codex' as const,
    status: 'ready',
    plan: 'Plus',
    windows: [{ name: '5h', remaining: 80, resetsAt: '2026-10-22T00:00:00Z' }],
    observedAt: '2026-10-21T00:00:00Z',
    reference: true as const,
  };
  let present = true;
  let fail = false;
  let lines: unknown[] = [
    { ...own, windows: [{ name: '5h', remaining: 1 }] },
    {
      label: 'Muse',
      provider: 'web',
      plan: 'M'.repeat(80),
      windows: [{ name: '每周额度', remaining: 72 }],
      observedAt: null,
    },
    { label: 'Bad', windows: 'junk' },
    { ...own, label: 'Work', status: 'auth-required' },
  ];
  const runtimes = nodeRuntimes(() => ({ lines: [own], running: 1 }), {
    probe: async () => (present ? 'device' : undefined),
    tray: async () => {
      if (fail) throw new Error('timeout');
      return trayExecutors({ lines });
    },
  });
  const first = peerRuntimesSchema.parse(await runtimes());
  assert.equal(first.executors.length, 3);
  assert.equal(first.executors[0]!.windows[0]!.remaining, 80);
  assert.equal(first.executors[0]!.windows[0]!.resetsAt, own.windows[0]!.resetsAt);
  assert.equal(first.executors[0]!.plan, 'Plus');
  assert.equal(first.executors[0]!.stale, true);
  assert.equal(first.executors[1]!.plan?.length, 60);
  assert.equal(first.executors[1]!.windows[0]!.name, '额度');
  assert.equal(first.executors[2]!.status, 'auth-required');
  fail = true;
  assert.equal((await runtimes()).executors[1]!.stale, true);
  present = false;
  assert.equal((await runtimes()).executors.length, 1);
  present = true;
  assert.equal((await runtimes()).executors.length, 1);
  fail = false;
  lines = [];
  assert.equal((await runtimes()).executors.length, 1);
});

test('live resources share the machine reader and expire GPU readings after an idle gap', async (t) => {
  let now = 0,
    cpuReads = 0,
    gpuReads = 0;
  let used = 10,
    idle = 90;
  let finish!: (value: import('../src/server/platform/system-stats.ts').NvidiaReading | undefined) => void;
  let fail = false;
  const controller = Object.create(Controller.prototype) as Controller;
  Object.assign(controller, {
    readMachine: createMachineReader({
      now: () => now,
      readCpus: () => {
        cpuReads++;
        return [{ user: used, nice: 0, sys: 0, idle, irq: 0 }];
      },
      totalBytes: () => 8 * 1024 ** 3,
      cores: () => 4,
      readMemory: () => 2 * 1024 ** 3,
    }),
  });
  const node = new DeviceNode({
    peersFile: join(temporaryFolder(t, 'node-resources-'), 'peers.json'),
    port: 0,
    runner: {} as never,
    runtimes: () => ({ executors: [], running: 0 }),
    slackHost: () => false,
    hardware: async () => ({ os: 'Fixture', readAt: new Date(0).toISOString() }),
    now: () => now,
    machine: () => controller.machineReading(),
    gpuStats: () => {
      gpuReads++;
      if (fail) throw new Error('synthetic');
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const first = node.info();
  assert.equal(first.resources!.cpuPercent, undefined);
  assert.equal(first.resources!.gpuPercent, undefined);
  assert.equal(first.resources!.memoryTotal, 8 * 1024 ** 3);
  assert.equal(first.resources!.memoryUsed, 6 * 1024 ** 3);
  await Promise.resolve();
  assert.equal(gpuReads, 1);
  now = 500;
  used = 35;
  idle = 165;
  assert.equal(node.info().resources!.cpuPercent, undefined);
  assert.equal(cpuReads, 1);
  now = 3000;
  assert.equal(controller.machineReading().cpuPercent, 25);
  assert.equal(node.info().resources!.cpuPercent, 25);
  assert.equal(cpuReads, 2);
  now = 10_000;
  const pending = node.info();
  assert.equal(pending.resources!.gpuPercent, undefined, 'info returns while GPU is still pending');
  await Promise.resolve();
  assert.equal(gpuReads, 1);
  finish({ percent: 12, gpu: { name: 'Fixture GPU', others: [], memory: { usedMiB: 1024, totalMiB: 8192 } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(node.info().resources!.gpuPercent, 12);
  assert.deepEqual(node.info().resources!.vram, { usedMiB: 1024, totalMiB: 8192 });
  now = 13_999;
  node.info();
  await Promise.resolve();
  assert.equal(gpuReads, 1);
  now = 25_000;
  assert.equal(node.info().resources!.gpuPercent, 12, 'a 15-second GPU reading is still valid');
  await Promise.resolve();
  assert.equal(gpuReads, 2);
  now = 3_600_000;
  const expired = node.info().resources!;
  assert.equal(expired.cpuPercent, undefined, 'the shared reader drops pre-idle CPU samples');
  assert.equal(expired.gpuPercent, undefined);
  assert.equal(expired.gpuName, undefined);
  assert.equal(expired.vram, undefined);
  finish({ percent: 30 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(node.info().resources!.gpuPercent, 30);
  now += 4000;
  fail = true;
  node.info();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gpuReads, 3);
  assert.equal(node.info().resources!.gpuPercent, undefined);
  const { resources, ...old } = first;
  assert.equal(peerInfoSchema.parse(old).resources, undefined);
  for (const invalid of [
    { cpuPercent: 101, observedAt: '' },
    { gpuName: 'g'.repeat(121), observedAt: '' },
    { memoryUsed: -1, observedAt: '' },
    { observedAt: 42 },
    { vram: { usedMiB: -1, totalMiB: 1 }, observedAt: '' },
  ])
    assert.equal(peerInfoSchema.parse({ ...old, resources: invalid }).resources, undefined);
});

test('a two-GPU node sends the measured NVIDIA name with its reading, bounded to 120 characters', async (t) => {
  let now = 0;
  let name = 'NVIDIA GeForce MX150';
  let reads = 0;
  const node = new DeviceNode({
    peersFile: join(temporaryFolder(t, 'node-two-gpus-'), 'peers.json'),
    port: 0,
    runner: {} as never,
    runtimes: () => ({ executors: [], running: 0 }),
    machine: () => ({ totalBytes: 8 * 1024 ** 3, cpus: 4 }),
    slackHost: () => false,
    now: () => now,
    hardware: async () => ({
      os: 'Fixture Linux',
      gpu: 'Intel UHD Graphics 620',
      gpuOthers: ['NVIDIA GeForce MX150'],
      readAt: new Date(0).toISOString(),
    }),
    gpuStats: async () => {
      reads++;
      return { percent: 42, gpu: { name, others: [], memory: { usedMiB: 1024, totalMiB: 2048 } } };
    },
  });
  node.info();
  await new Promise((resolve) => setImmediate(resolve));
  const info = peerInfoSchema.parse(node.info());
  assert.equal(info.hardware!.gpu, 'Intel UHD Graphics 620');
  assert.equal(info.resources!.gpuName, 'NVIDIA GeForce MX150');
  assert.equal(info.resources!.gpuPercent, 42);
  assert.deepEqual(info.resources!.vram, { usedMiB: 1024, totalMiB: 2048 });
  assert.equal(info.resources!.memoryUsed, undefined);
  now = 3_600_000;
  name = 'N'.repeat(200);
  const afterIdle = node.info().resources!;
  assert.equal(afterIdle.gpuPercent, undefined);
  assert.equal(afterIdle.gpuName, undefined);
  assert.equal(afterIdle.vram, undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 2, 'the first poll after idle starts a fresh background read');
  assert.equal(peerInfoSchema.parse(node.info()).resources!.gpuName, 'N'.repeat(120));
});
