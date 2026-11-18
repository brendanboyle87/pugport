import assert from 'node:assert/strict';
import { connect, createServer, type AddressInfo, type Socket } from 'node:net';
import { test } from 'node:test';
import {
  chainHasExecutor,
  executorCaller,
  parseLsof,
  parseNetstat,
  parseSs,
  perConnection,
  walkTable,
} from '../src/server/caller-identity.ts';

test('process output parsers select the peer direction and address, keeping every candidate', () => {
  const netstat =
    '\r\nActive Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n' +
    '  TCP    127.0.0.1:4317         127.0.0.2:5000         ESTABLISHED     99\r\n' +
    '  TCP    127.0.0.2:5000         127.0.0.1:4317         ESTABLISHED     42\r\n';
  assert.deepEqual(parseNetstat(netstat, '127.0.0.2', 5000, 4317), [42]);
  assert.deepEqual(parseNetstat(netstat, '127.0.0.1', 5000, 4317), []);
  assert.deepEqual(parseNetstat(netstat, '127.0.0.2', 5001, 4317), []);
  assert.deepEqual(
    parseNetstat(netstat + '  TCP    127.0.0.2:5000  127.0.0.1:4317  ESTABLISHED  43\r\n', '127.0.0.2', 5000, 4317),
    [42, 43],
  );
  const ss =
    '0 0 127.0.0.1:4317 127.0.0.2:5000 users:(("node",pid=99,fd=3))\n' +
    '0 0 127.0.0.2:5000 127.0.0.1:4317 users:(("node",pid=42,fd=3))';
  assert.deepEqual(parseSs(ss, '127.0.0.2', 5000, 4317), [42]);
  assert.deepEqual(parseSs(ss, '127.0.0.1', 5000, 4317), []);
  assert.deepEqual(parseSs(ss + ',("other",pid=43,fd=4))', '127.0.0.2', 5000, 4317), [42, 43]);
  const lsof = 'p99\nn127.0.0.1:4317->127.0.0.2:5000\np42\nn127.0.0.2:5000->127.0.0.1:4317\n';
  assert.deepEqual(parseLsof(lsof, '127.0.0.2', 5000, 4317), [42]);
  assert.deepEqual(parseLsof(lsof, '127.0.0.2', 5001, 4317), []);
  assert.deepEqual(parseLsof(lsof + 'p43\nf4\nn127.0.0.2:5000->127.0.0.1:4317\n', '127.0.0.2', 5000, 4317), [42, 43]);
});

test('the ancestor walk keeps only live processes and stops at an exited parent', () => {
  // 42 (curl) <- 12 (shell) <- 7 (executor) <- 3 (backend) <- 900, whose parent 4 has exited.
  const table = '42 12\r\n12 7\r\n7 3\r\n3 900\r\n900 4\r\n';
  assert.deepEqual(walkTable(table, 42), [42, 12, 7, 3, 900]);
  assert.deepEqual(walkTable('1 0\n', 1), [1]);
  assert.deepEqual(walkTable('', 42), [42], 'the peer holds the live connection, so it always counts');
  assert.equal(walkTable(Array.from({ length: 20 }, (_, i) => `${i + 1} ${i + 2}`).join('\n'), 1).length, 8);
});

test('chain matches only the backend or an owned process', () => {
  assert.equal(
    chainHasExecutor([2, 3], 3, () => false),
    true,
  );
  assert.equal(
    chainHasExecutor([2, 3], 4, (pid) => pid === 2),
    true,
  );
  assert.equal(
    chainHasExecutor([2, 3], 4, () => false),
    false,
  );
});

test('caller lookup finds an executor ancestor and fails open, without a definite answer, on errors, odd addresses and timeouts', async () => {
  const options = { remotePort: 5000, localPort: 4317, remoteAddress: '127.0.0.2', owns: () => false, timeoutMs: 20 };
  assert.equal(
    await executorCaller({
      ...options,
      run: async () => {
        throw new Error('fixture');
      },
    }),
    undefined,
  );
  assert.equal(await executorCaller({ ...options, run: () => new Promise(() => {}) }), undefined);
  const windows = async (file: string) =>
    file.endsWith('netstat.exe')
      ? '  TCP    127.0.0.2:5000   127.0.0.1:4317   ESTABLISHED   42\r\n  TCP    127.0.0.2:5000   127.0.0.1:4317   ESTABLISHED   43\r\n'
      : '42 12\r\n12 1\r\n43 7\r\n7 1\r\n';
  const win = { ...options, platform: 'win32' as const, run: windows };
  assert.equal(await executorCaller({ ...win, owns: (pid) => pid === 7 }), true, 'any sharing process counts');
  assert.equal(await executorCaller({ ...win, owns: () => false }), false);
  assert.equal(await executorCaller({ ...win, owns: () => true, run: async () => 'invalid' }), undefined);
  for (const remoteAddress of [undefined, '::1', '127.0.0.256', "127.0.0.1'; calc"])
    assert.equal(await executorCaller({ ...win, remoteAddress, owns: () => true }), undefined, String(remoteAddress));
});

test('a connection keeps a definite answer and asks again after a failed lookup', async () => {
  const answers: (boolean | undefined)[] = [undefined, true, false];
  let asked = 0;
  const check = perConnection(async (_connection: object) => answers[asked++]);
  const first = {};
  assert.equal(await check(first), false, 'a failure lets the request through');
  assert.deepEqual(
    await Promise.all([check(first), check(first)]),
    [true, true],
    'concurrent requests share one lookup',
  );
  assert.equal(await check(first), true);
  const second = {};
  assert.equal(await check(second), false);
  assert.equal(await check(second), false);
  assert.equal(asked, 3);
});

test('a real loopback connection from this process is found with the system tools', async (t) => {
  const server = createServer((socket) => socket.on('error', () => {}));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const serverPort = (server.address() as AddressInfo).port;
  const client: Socket = connect(serverPort, '127.0.0.1');
  t.after(() => {
    client.destroy();
    server.close();
  });
  await new Promise<void>((done, fail) => client.once('connect', done).once('error', fail));
  assert.equal(
    await executorCaller({
      remotePort: client.localPort,
      localPort: serverPort,
      remoteAddress: '127.0.0.1',
      owns: () => false,
      timeoutMs: 15000,
    }),
    true,
    'the peer is this test process, which counts as the backend itself',
  );
});
