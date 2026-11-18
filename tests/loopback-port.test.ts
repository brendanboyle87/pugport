import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { fetchPortAllowed, listenLoopback } from '../src/server/platform/loopback-port.ts';
import { listenForFetch } from './helpers/fetch-port.ts';

test('an automatic port that Fetch refuses is given back before the server reports ready', async (t) => {
  const server = createServer((_req, res) => res.end('ok'));
  t.after(() => server.close());
  let binds = 0;
  server.on('listening', () => binds++);
  const address = server.address.bind(server);
  // The OS hands out a port Fetch refuses on the first bind.
  t.mock.method(server, 'address', () => {
    const actual = address() as AddressInfo;
    return binds === 1 ? { ...actual, port: 6665 } : actual;
  });
  let ready = 0;
  await new Promise<void>((done) =>
    listenLoopback(server, 0, () => {
      ready++;
      done();
    }),
  );
  assert.equal(binds, 2, 'the refused port was given back and another taken');
  assert.equal(ready, 1, 'startup runs once, on the usable port');
  const { port } = address() as AddressInfo;
  assert.equal(fetchPortAllowed(port), true);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'ok');
});

test('an explicit port is used as given, even one Fetch would refuse', async (t) => {
  const free = await listenForFetch(createServer());
  const { port } = free.address() as AddressInfo;
  await new Promise((done) => free.close(done));
  const server = createServer();
  t.after(() => server.close());
  let binds = 0;
  server.on('listening', () => binds++);
  const address = server.address.bind(server);
  // Refused on the first bind only, so a missing explicit-port guard fails here instead of rebinding forever.
  t.mock.method(server, 'address', () => {
    const actual = address() as AddressInfo;
    return binds === 1 ? { ...actual, port: 6665 } : actual;
  });
  await new Promise<void>((done) => listenLoopback(server, port, done));
  assert.equal(binds, 1);
  assert.equal((address() as AddressInfo).port, port);
});
