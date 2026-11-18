import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { dirtyFiles } from '../src/server/scope-check.ts';

test('an aborted scope snapshot waits for git to exit before releasing its folder', async (t) => {
  const child = Object.assign(new EventEmitter(), { pid: 123 });
  const abort = new AbortController();
  const mock = t.mock.method(childProcess, 'execFile', ((...args: unknown[]) => {
    const options = args[2] as { signal: AbortSignal; maxBuffer: number };
    const callback = args[3] as (error: Error, stdout: string) => void;
    assert.equal(options.signal, abort.signal);
    assert.equal(options.maxBuffer, 32 * 1024 * 1024);
    options.signal.addEventListener('abort', () => callback(new Error('aborted'), ''));
    return child;
  }) as typeof childProcess.execFile);
  syncBuiltinESMExports();
  try {
    let settled = false;
    const pending = dirtyFiles('/synthetic', abort.signal).then((result) => {
      settled = true;
      return result;
    });
    abort.abort();
    await new Promise((done) => setImmediate(done));
    assert.equal(settled, false, 'an abort callback does not mean the child has exited');
    child.emit('exit', null, 'SIGTERM');
    await new Promise((done) => setImmediate(done));
    assert.equal(settled, false, 'wait for the exited child to close its pipes too');
    child.emit('close', null, 'SIGTERM');
    assert.equal(await pending, undefined);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('scope snapshots handle a close before the callback and a git that never started', async (t) => {
  for (const started of [true, false]) {
    const child = Object.assign(new EventEmitter(), { pid: started ? 123 : undefined });
    let answer!: (error: Error | null, stdout: string) => void;
    const mock = t.mock.method(childProcess, 'execFile', ((...args: unknown[]) => {
      answer = args[3] as typeof answer;
      return child;
    }) as typeof childProcess.execFile);
    syncBuiltinESMExports();
    try {
      const pending = dirtyFiles('/synthetic');
      if (started) child.emit('close', 0, null);
      answer(started ? null : new Error('ENOENT'), '');
      assert.deepEqual(await pending, started ? new Map() : undefined);
    } finally {
      mock.mock.restore();
      syncBuiltinESMExports();
    }
  }
});

test('an already-aborted scope snapshot does not launch git', async (t) => {
  const mock = t.mock.method(childProcess, 'execFile', () => {
    throw new Error('git must not start');
  });
  syncBuiltinESMExports();
  try {
    assert.equal(await dirtyFiles('/synthetic', AbortSignal.abort()), undefined);
    assert.equal(mock.mock.callCount(), 0);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});
