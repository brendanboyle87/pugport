import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createGrokAdapter } from '../src/server/adapters/grok.ts';
import { Inbox } from '../src/server/inbox.ts';
import type { RuntimeTarget } from '../src/shared/types.ts';

const target: RuntimeTarget = {
  id: 'fake',
  provider: 'grok',
  label: 'Fake',
  command: 'fake',
  environment: 'native',
  enabled: true,
};

function adapter(mode: 'ok' | 'reject' | 'unsupported' | 'banner' | 'hang', expired = false) {
  let spawns = 0;
  const instance = createGrokAdapter({
    capture: async (_target, args) => ({
      stdout:
        args[0] === '--version'
          ? 'grok 1.0.67'
          : expired
            ? 'authentication required'
            : 'You are logged in with an API key.\n - grok-4.7',
      exitCode: 0,
    }),
    spawn: async (_target, args, options) => {
      spawns++;
      assert.deepEqual(args, [
        '--permission-mode',
        'dontAsk',
        '--disable-web-search',
        '--deny',
        '*',
        'agent',
        '--no-leader',
        'stdio',
      ]);
      assert.equal(options?.env?.GROK_MEMORY, '0');
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null,
        signalCode: null,
      });
      if (mode === 'reject')
        setImmediate(() => {
          child.stderr.write('error: unknown option --deny\n');
          child.emit('close', 1);
        });
      else if (mode !== 'hang') {
        let buffer = '';
        let bannerSent = false;
        child.stdin.on('data', (chunk) => {
          if (mode === 'banner' && !bannerSent) {
            bannerSent = true;
            child.stdout.write('Grok update available\n\n');
          }
          buffer += chunk.toString();
          let pos: number;
          while ((pos = buffer.indexOf('\n')) >= 0) {
            const packet = JSON.parse(buffer.slice(0, pos));
            buffer = buffer.slice(pos + 1);
            child.stdout.write(
              JSON.stringify({
                jsonrpc: '2.0',
                id: packet.id,
                ...(mode === 'unsupported' && packet.method === '_x.ai/interject'
                  ? { error: { code: -32601 } }
                  : { result: {} }),
              }) + '\n',
            );
          }
        });
      }
      return child as unknown as ChildProcessWithoutNullStreams;
    },
    terminate: async () => {},
    handshakeTimeoutMs: 5,
  });
  return { instance, count: () => spawns };
}

test('startup banner and blank lines do not fail Grok handshake', async () => {
  const a = adapter('banner');
  const snapshot = await a.instance.discover(target, { grokHandshake: { lastPassedVersion: '1.0.66' } });
  assert.equal(snapshot.status, 'ready');
  assert.notEqual(snapshot.note, 'runtime-protocol-incompatible');
  assert.equal(a.count(), 1);
});

test('handshake timeout keeps ready status', async () => {
  const a = adapter('hang');
  const snapshot = await a.instance.discover(target, { grokHandshake: { lastPassedVersion: '1.0.66' } });
  assert.equal(snapshot.status, 'ready');
  assert.notEqual(snapshot.note, 'runtime-protocol-incompatible');
  assert.equal(a.count(), 1);
  const db = new DatabaseSync(':memory:');
  try {
    const inbox = new Inbox(db, () => {});
    inbox.reconcile([snapshot], [target]);
    assert.equal(
      inbox.list().some((notice) => notice.kind === 'executor-incompatible'),
      false,
    );
  } finally {
    db.close();
  }
});

test('authentication required skips handshake', async () => {
  const a = adapter('reject', true);
  const snapshot = await a.instance.discover(target);
  assert.equal(snapshot.status, 'auth-required');
  assert.equal(a.count(), 0);
});

test('missing CLI skips handshake', async () => {
  let spawns = 0;
  const a = createGrokAdapter({
    capture: async () => {
      throw new Error('runtime-not-found');
    },
    spawn: async () => {
      spawns++;
      throw new Error('unexpected spawn');
    },
  });
  const snapshot = await a.discover(target);
  assert.equal(snapshot.status, 'missing');
  assert.equal(spawns, 0);
});

test('same version retains unsupported steer', async () => {
  const a = adapter('ok');
  const snapshot = await a.instance.discover(target, {
    grokHandshake: { lastPassedVersion: '1.0.67', lastPassedSteer: false },
  });
  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.capabilities.steer, false);
  assert.equal(a.count(), 0);
});

test('version change reports rejected startup flag', async () => {
  const a = adapter('reject');
  const snapshot = await a.instance.discover(target, { grokHandshake: { lastPassedVersion: '1.0.66' } });
  assert.equal(snapshot.status, 'error');
  assert.match(snapshot.errorDetail ?? '', /unknown option --deny/);
  assert.equal(a.count(), 1);
});

test('unsupported interject keeps ready but disables steer', async () => {
  const a = adapter('unsupported');
  const snapshot = await a.instance.discover(target, { grokHandshake: { lastPassedVersion: '1.0.66' } });
  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.capabilities.steer, false);
});

test('same version skips handshake unless startup failed', async () => {
  const a = adapter('ok');
  await a.instance.discover(target, { grokHandshake: { lastPassedVersion: '1.0.67' } });
  assert.equal(a.count(), 0);
  await a.instance.discover(target, { grokHandshake: { lastPassedVersion: '1.0.67', afterStartupFailure: true } });
  assert.equal(a.count(), 1);
});
