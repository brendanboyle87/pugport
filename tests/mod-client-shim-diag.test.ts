import assert from 'node:assert/strict';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { MOD_CLIENT_SHIM } from '../src/shared/mod-client-shim.ts';

class Port {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  sent: any[] = [];
  postMessage(value: unknown) {
    this.sent.push(value);
  }
  start() {}
  close() {}
}

/** The shim in a bare realm, with a controllable clock and a console that records what authors still see. */
function frame() {
  const listeners = new Map<string, (event: unknown) => void>();
  const parent = {};
  let now = 1_000_000;
  const printed: unknown[][] = [];
  const sandbox = createContext({
    parent,
    setTimeout,
    clearTimeout,
    console: { error: (...args: unknown[]) => printed.push(args), warn: () => {}, log: () => {} },
    addEventListener: (event: string, callback: (event: unknown) => void) => listeners.set(event, callback),
    removeEventListener: (event: string) => listeners.delete(event),
  });
  runInContext('window = globalThis', sandbox);
  runInContext(`Date.now = () => globalThis.__now`, sandbox);
  const tick = (ms = 0) => {
    now += ms;
    sandbox.__now = now;
  };
  tick();
  runInContext(MOD_CLIENT_SHIM, sandbox);
  const port = new Port();
  const connect = () =>
    listeners.get('message')!({
      source: parent,
      isTrusted: true,
      data: { pugport: 2, type: 'connect' },
      ports: [port],
    });
  const run = (code: string) => runInContext(code, sandbox);
  const diags = () => port.sent.filter((item) => item.type === 'diag');
  return { listeners, port, connect, run, tick, diags, printed };
}

test('load-time errors wait for the host, then arrive as one bounded line each', () => {
  const f = frame();
  f.run(`console.error('Saving failed:', new TypeError('notes is undefined'), {code: 7})`);
  f.listeners.get('error')!({ message: 'Uncaught TypeError: x is null', lineno: 88, colno: 3 });
  f.listeners.get('unhandledrejection')!({ reason: f.run(`new Error('network down')`) });
  f.listeners.get('error')!({ target: 'img' });
  f.run(`console.warn('a'.repeat(500))`);
  f.run(`console.log(new Error('first line\\n    at frame (main.js:1:1)\\n    at other'))`);
  f.run(`console.log('line one\\nline two')`);
  assert.equal(f.diags().length, 0, 'nothing is posted before the host connects');
  assert.equal(f.printed.length, 1, 'the author still sees their console');
  f.connect();
  assert.equal(f.port.sent[0].id, 'handshake', 'the handshake goes first');
  assert.deepEqual(
    f.diags().map(({ level, text }) => [level, text]),
    [
      ['error', 'Saving failed: TypeError: notes is undefined {"code":7}'],
      ['error', 'Uncaught TypeError: x is null (line 88:3)'],
      ['error', 'Unhandled rejection: Error: network down'],
      ['warn', 'a'.repeat(200)],
      ['log', 'Error: first line'],
      ['log', 'line one'],
    ],
  );
  for (const item of f.diags()) {
    assert.equal(item.pugport, 2);
    assert.equal(item.at, 1_000_000);
  }
});

test('at most 60 lines per 10 seconds; the next window reports how many were dropped', () => {
  const f = frame();
  f.connect();
  f.run(`for (let i = 0; i < 75; i++) console.log('line ' + i)`);
  assert.equal(f.diags().length, 60);
  f.tick(5_000);
  f.run(`console.log('still limited')`);
  assert.equal(f.diags().length, 60);
  f.tick(5_000);
  f.run(`console.log('next window')`);
  assert.equal(f.diags().length, 61);
  assert.deepEqual(
    { text: f.diags().at(-1).text, dropped: f.diags().at(-1).dropped },
    { text: 'next window', dropped: 16 },
  );
  f.run(`console.log('after')`);
  assert.equal(f.diags().at(-1).dropped, undefined, 'the count is reported once');
});

test('a detached frame posts nothing more', () => {
  const f = frame();
  f.connect();
  f.port.onmessage!({ data: { type: 'event', event: 'detached', data: {} } });
  const before = f.port.sent.length;
  f.run(`console.error('late')`);
  f.listeners.get('error')!({ message: 'late' });
  assert.equal(f.port.sent.length, before);
});
