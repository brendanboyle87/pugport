import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { ChildProcess } from 'node:child_process';
import { PosixTask } from '../src/server/platform/posix-task.ts';

test('guarded task retains its executor identity only while it runs', () => {
  const anchor = Object.assign(new EventEmitter(), {
    pid: 4242,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  }) as unknown as ChildProcess;
  const task = new PosixTask(anchor, '/fixture/cli', []);
  assert.equal(task.pid, 4242);
  assert.equal(task.executorPid, undefined);
  anchor.emit('message', { type: 'task-started', pid: 4343 });
  assert.equal(task.executorPid, 4343);
  anchor.emit('message', { type: 'task-exit', code: 0, signal: null });
  assert.equal(task.executorPid, undefined);
  anchor.emit('message', { type: 'task-started', pid: -1 });
  assert.equal(task.executorPid, undefined);
  anchor.emit('message', { type: 'task-started', pid: 4343 });
  anchor.emit('exit', 0, null);
  assert.equal(task.executorPid, undefined);
});
