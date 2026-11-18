import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { collectProcessOutput } from '../src/server/adapters/process.ts';

function fixture() {
  const events = new EventEmitter();
  const streams = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() };
  let kills = 0;
  const child = Object.assign(events, streams, {
    exitCode: null as number | null,
    signalCode: null,
    kill: () => {
      kills++;
      return true;
    },
  });
  const exit = (code: number) => {
    child.exitCode = code;
    child.emit('exit', code, null);
  };
  return { child: child as unknown as ChildProcessWithoutNullStreams, ...streams, exit, kills: () => kills };
}

test('metadata capture completes when a Windows process exits but its output pipe never closes', async () => {
  const f = fixture();
  const started = Date.now();
  const result = collectProcessOutput(f.child, 5000);
  f.stdout.write('{"status":"authenticated"}\n');
  f.exit(0);
  assert.deepEqual(await result, { stdout: '{"status":"authenticated"}\n', exitCode: 0 });
  assert.ok(Date.now() - started < 1500, 'must not wait for the general capture timeout');
  assert.equal(f.kills(), 0);
  assert.equal(f.stdout.destroyed, true);
  assert.equal(f.stderr.destroyed, true);
});

test('exit allows buffered output to drain and finishes on stdout end without child close', async () => {
  const f = fixture();
  const result = collectProcessOutput(f.child, 5000);
  f.stdout.write('{"value":');
  f.exit(0);
  f.stdout.end('42}\n');
  assert.deepEqual(await result, { stdout: '{"value":42}\n', exitCode: 0 });
  assert.equal(f.kills(), 0);
});

test('a process that exited before capture still drains its buffered output', async () => {
  const f = fixture();
  f.stdout.write('already finished');
  f.exit(0);
  assert.deepEqual(await collectProcessOutput(f.child, 5000), { stdout: 'already finished', exitCode: 0 });
  assert.equal(f.kills(), 0);
});

test('a nonzero exit with a lingering pipe remains an error unless explicitly accepted', async () => {
  const bad = fixture();
  const failure = collectProcessOutput(bad.child, 5000);
  bad.exit(7);
  await assert.rejects(failure, /runtime-process-closed/);
  const allowed = fixture();
  const success = collectProcessOutput(allowed.child, 5000, [7]);
  allowed.stdout.write('expected diagnostic');
  allowed.exit(7);
  assert.deepEqual(await success, { stdout: 'expected diagnostic', exitCode: 7 });
});

test('a running process still times out, and a normal close completes immediately', async () => {
  const running = fixture();
  await assert.rejects(collectProcessOutput(running.child, 20), /runtime-timeout/);
  assert.equal(running.kills(), 1);
  const closed = fixture();
  const capture = collectProcessOutput(closed.child, 5000);
  closed.stdout.write('ok');
  closed.child.emit('close', 0);
  assert.deepEqual(await capture, { stdout: 'ok', exitCode: 0 });
});

test('successful cached metadata preserves only an authentication classification from split stderr', async () => {
  const f = fixture();
  const result = collectProcessOutput(f.child, 5000);
  f.stdout.write(' - cached-model\n');
  f.stderr.write('private@example.test refresh credential=secret-fixture\nerror: invalid_');
  f.stderr.write('grant: refresh token expired\n');
  f.child.emit('close', 0);
  assert.deepEqual(await result, {
    stdout: ' - cached-model\n',
    exitCode: 0,
    diagnostic: 'authentication-required',
  });
  assert.ok(!JSON.stringify(await result).includes('private'));
  assert.ok(!JSON.stringify(await result).includes('secret-fixture'));
});

test('stderr can finish after stdout and still classify an incompatible CLI option', async () => {
  const f = fixture();
  const result = collectProcessOutput(f.child, 5000);
  f.exit(1);
  f.stdout.end();
  f.stderr.end("error: unknown option '--permission-prompts' private-secret\n");
  await assert.rejects(result, (error: Error) => {
    assert.equal(error.message, 'runtime-protocol-incompatible');
    assert.ok(!JSON.stringify(error).includes('private-secret'));
    return true;
  });
});

test('unrelated token expiry metadata and connection failures do not imply signed out', async () => {
  const f = fixture();
  const result = collectProcessOutput(f.child, 5000);
  f.stderr.write('cached token expires tomorrow; model refresh failed: network timeout\n');
  f.stdout.write(' - cached-model\n');
  f.child.emit('close', 0);
  assert.deepEqual(await result, { stdout: ' - cached-model\n', exitCode: 0 });
});

test('metadata diagnostic capture remains bounded across long private stderr chunks', async () => {
  const f = fixture();
  const result = collectProcessOutput(f.child, 5000);
  f.stderr.write('private-secret'.repeat(100_000));
  f.stderr.write('\nAuthentication required\n');
  f.child.emit('close', 1);
  await assert.rejects(result, { message: 'authentication-required' });
});
