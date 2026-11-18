import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createServer as createTcpServer, type Server } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { SshTunnels } from '../src/server/devices/ssh-tunnel.ts';
import { hardenedSshSettings } from '../src/server/ssh-options.ts';
import { Devices } from '../src/server/devices/service.ts';

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  }) as unknown as ChildProcessWithoutNullStreams;
}

test('tunnel uses hardened arguments, waits for an HTTP answer, and closes its process', async () => {
  const child = fakeChild();
  let clock = 0,
    probes = 0,
    stopped = 0;
  let args: string[] = [];
  const tunnels = new SshTunnels({
    launch: async (value) => {
      args = value;
      return child;
    },
    terminate: async () => {
      stopped++;
    },
    port: async () => 47001,
    ready: async () => ++probes === 2,
    now: () => clock,
    pause: async (ms) => {
      clock += ms;
    },
  });
  assert.equal(await tunnels.ensure('fixture-host', 4318), 47001);
  assert.equal(probes, 2);
  assert.ok(args.includes('127.0.0.1:47001:127.0.0.1:4318'));
  assert.ok(args.includes('ExitOnForwardFailure=yes'));
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
  assert.ok(!args.includes('ClearAllForwardings=yes'));
  for (const setting of hardenedSshSettings.filter((s) => s !== 'ClearAllForwardings=yes'))
    assert.ok(args.includes(setting), setting);
  assert.equal(await tunnels.ensure('fixture-host', 4318), 47001);
  await tunnels.close('fixture-host');
  assert.equal(stopped, 1);
  assert.equal(tunnels.isOpen('fixture-host'), false);
});

test('failed readiness includes first stderr line and is cached for 30 seconds', async () => {
  let clock = 0,
    launches = 0;
  const tunnels = new SshTunnels({
    launch: async () => {
      launches++;
      const child = fakeChild();
      queueMicrotask(() => (child.stderr as PassThrough).write('forward refused\nother'));
      return child;
    },
    terminate: async () => {},
    port: async () => 47002,
    ready: async () => false,
    now: () => clock,
    pause: async (ms) => {
      clock += ms;
      await new Promise((resolve) => setImmediate(resolve));
    },
  });
  await assert.rejects(tunnels.ensure('fixture-host', 4318), /forward refused/);
  await assert.rejects(tunnels.ensure('fixture-host', 4318), /forward refused/);
  assert.equal(launches, 1);
  clock += 30_001;
  await assert.rejects(tunnels.ensure('fixture-host', 4318), /forward refused/);
  assert.equal(launches, 2);
});

test('closed tunnel refresh is passive, mentions need three at signs, and calls and transfers use the tunnel', async () => {
  const tunnels = new SshTunnels();
  let open = false,
    ensures = 0;
  tunnels.isOpen = () => open;
  tunnels.ensure = async () => {
    ensures++;
    open = true;
    return 47003;
  };
  const info = {
    name: 'fixture',
    version: '1',
    role: 'node',
    hostname: 'fixture',
    platform: 'linux',
    arch: 'x64',
    capabilities: {},
    slackHost: false,
  };
  const requests: string[] = [];
  const devices = new Devices({
    file: 'unused',
    selfName: 'fixture',
    tunnels,
    fetch: async (input) => {
      requests.push(String(input));
      return new Response(JSON.stringify(String(input).endsWith('/runtimes') ? { executors: [], running: 0 } : info), {
        status: 200,
      });
    },
  });
  const data = {
    version: 1 as const,
    devices: [
      {
        id: 'f0000000-0000-4000-8000-000000000001',
        name: 'fixture-server',
        address: '127.0.0.1',
        token: 'fixture',
        peerId: 'fixture',
        pairedAt: '',
        tunnel: { ssh: 'fixture-server', remotePort: 4318 },
      },
    ],
  };
  devices.store.read = async () => data;
  devices.store.current = () => data;
  const view = await devices.view(true);
  assert.equal(ensures, 0);
  assert.equal(view.devices[0]?.online, false);
  assert.equal(requests.length, 0);
  assert.equal(await devices.messageFor({ content: '@@fixture-server run' } as never), undefined);
  const called = await devices.messageFor({ content: '@@@fixture-server run' } as never);
  assert.equal((called as { deviceId?: string } | undefined)?.deviceId, data.devices[0]!.id);
  assert.ok(requests.every((url) => url.startsWith('http://127.0.0.1:47003/')));
  const before = ensures;
  await devices.sendFiles(data.devices[0]!.id, []);
  assert.ok(ensures > before);
});

test('check opens a closed tunnel and re-reads executors, while view(true) stays passive', async () => {
  const tunnels = new SshTunnels();
  let open = false,
    starts = 0,
    failure: Error | undefined;
  tunnels.isOpen = () => open;
  tunnels.ensure = async () => {
    if (failure) throw failure;
    if (!open) starts++;
    open = true;
    return 47004;
  };
  const info = {
    name: 'fixture',
    version: '1',
    role: 'node',
    hostname: 'fixture',
    platform: 'linux',
    arch: 'x64',
    capabilities: {},
    slackHost: false,
  };
  const executors = [{ label: 'Fixture CLI', provider: 'codex', status: 'ready', windows: [], observedAt: null }];
  const requests: string[] = [];
  const devices = new Devices({
    file: 'unused',
    selfName: 'fixture',
    tunnels,
    fetch: async (input) => {
      requests.push(String(input));
      return new Response(JSON.stringify(String(input).endsWith('/runtimes') ? { executors, running: 0 } : info), {
        status: 200,
      });
    },
  });
  const id = 'f0000000-0000-4000-8000-000000000002';
  const data = {
    version: 1 as const,
    devices: [
      {
        id,
        name: 'fixture-server',
        address: '127.0.0.1',
        token: 'fixture',
        peerId: 'fixture',
        pairedAt: '',
        tunnel: { ssh: 'fixture-server', remotePort: 4318 },
      },
    ],
  };
  devices.store.read = async () => data;
  devices.store.current = () => data;

  assert.equal((await devices.view(true)).devices[0]?.online, false);
  assert.equal(starts, 0);
  assert.equal(requests.length, 0);

  const checked = await devices.check(id);
  assert.equal(starts, 1);
  assert.equal(checked.online, true);
  assert.equal(checked.executors?.[0]?.label, 'Fixture CLI');
  assert.ok(requests.some((url) => url === 'http://127.0.0.1:47004/peer/v1/runtimes'));

  open = false;
  failure = new Error('打不开到 fixture-server 的 SSH 隧道：synthetic refused');
  await assert.rejects(devices.check(id), /synthetic refused/);
  await assert.rejects(devices.check('f0000000-0000-4000-8000-00000000000f'), /已经从/);
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return (server.address() as { port: number }).port;
}

test('default readiness rejects a reset connection and accepts an HTTP 401', async (t) => {
  let resetConnections = 0;
  const reset = createTcpServer((socket) => {
    resetConnections++;
    socket.destroy();
  });
  const paths: string[] = [];
  const http = createHttpServer((request, response) => {
    paths.push(request.url ?? '');
    response.writeHead(401).end();
  });
  t.after(() => {
    reset.close();
    http.close();
  });
  const tunnelsFor = async (server: Server) => {
    const port = await listen(server);
    let clock = 0;
    return new SshTunnels({
      launch: async () => fakeChild(),
      terminate: async () => {},
      port: async () => port,
      now: () => clock,
      pause: async (ms) => {
        clock += ms;
      },
    });
  };
  await assert.rejects((await tunnelsFor(reset)).ensure('fixture-reset', 4318), /Tunnel unavailable/);
  assert.ok(resetConnections > 0, 'The reset server must receive a connection; a blocked connect is not a reset.');
  const open = await tunnelsFor(http);
  assert.equal(await open.ensure('fixture-http', 4318), (http.address() as { port: number }).port);
  assert.deepEqual(paths, ['/peer/v1/info']);
  await open.close('fixture-http');
});
