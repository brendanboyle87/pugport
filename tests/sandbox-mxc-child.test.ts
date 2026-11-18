import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { mxcExecution } from '../src/server/sandbox/mxc-runtime.ts';
import { prepareMxcRequest } from '../src/server/sandbox/helper-sdk.ts';
import { MxcChildProcess, type MxcDriver } from '../src/server/sandbox/mxc-child.ts';
import {
  captureTarget,
  spawnTarget,
  isOwnedProcess,
  terminateProcess,
  shutdownOwnedProcesses,
} from '../src/server/adapters/process.ts';
import type { SandboxRequest } from '../src/server/sandbox/policy-builder.ts';
import type { RuntimeTarget } from '../src/shared/types.ts';

const target: RuntimeTarget = {
  id: 'synthetic-mxc',
  provider: 'pi',
  environment: 'native',
  command: process.execPath,
  label: 'Pi',
  enabled: true,
};
const sandbox: SandboxRequest = {
  provider: 'pi',
  runTemp: process.cwd(),
  reportDirectory: process.cwd(),
  fallback: { allowDaclMutation: false },
  containment: { type: 'processcontainer', config: { captureDenials: { mode: 'allow' } } },
  workingDirectory: process.cwd(),
};
function fake() {
  let settle!: (value: { exitCode: number; timedOut: boolean }) => void;
  const terminal = new Promise<{ exitCode: number; timedOut: boolean }>((resolve) => (settle = resolve));
  const driver = {
    id: 999999,
    standardInput: new PassThrough(),
    standardOutput: new PassThrough(),
    standardError: new PassThrough(),
    kills: 0,
    disposals: 0,
    wait: () => terminal,
    finish(code = 0) {
      driver.standardOutput.end();
      driver.standardError.end();
      settle({ exitCode: code, timedOut: false });
    },
    kill() {
      driver.kills++;
      driver.finish(1);
    },
    dispose() {
      driver.disposals++;
    },
  } satisfies MxcDriver & Record<string, unknown>;
  return driver;
}

test('pinned SDK wire mapping retains fallback consent and disables telemetry', async () => {
  const wire = await prepareMxcRequest({
    command: 'synthetic',
    inheritDefaultEnvironment: false,
    containment: { type: 'processcontainer', config: { captureDenials: { mode: 'allow' } } },
  });
  assert.deepEqual(wire.fallback, { allowDaclMutation: false });
  assert.deepEqual(wire.telemetry, { enabled: false });
  assert.equal(wire.processContainer.captureDenials.mode, 'allow');
  // The pinned SDK omits false; the native contract defaults to no inheritance.
  assert.equal(wire.process.inheritDefaultEnv ?? false, false);
});
test('MXC shim exposes streams, drains before close, and cleans metadata before exit', async () => {
  const driver = fake();
  const events: string[] = [];
  const child = new MxcChildProcess(driver, 'fixture', ['one'], async () => {
    events.push('metadata');
  });
  child.on('exit', () => events.push('exit'));
  child.on('close', () => events.push('close'));
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.resume();
  await once(child, 'spawn');
  driver.standardOutput.write('fixture output');
  driver.finish(7);
  await once(child, 'close');
  assert.equal(output, 'fixture output');
  assert.equal(child.exitCode, 7);
  assert.deepEqual(events, ['metadata', 'exit', 'close']);
  assert.equal(driver.disposals, 1);
  assert.equal(child.kill(), false);
});
test('spawnTarget registers MXC ownership, uses driver kill and redirects TEMP', async (t) => {
  const driver = fake();
  t.mock.method(mxcExecution, 'status', async () => ({ available: true, sdkVersion: '1.0.1' }));
  t.mock.method(mxcExecution, 'spawn', async (request: Parameters<typeof mxcExecution.spawn>[0]) => {
    assert.equal(request.environment?.TEMP, sandbox.runTemp);
    assert.equal(request.inheritDefaultEnvironment, sandbox.inheritDefaultEnvironment);
    assert.match(request.command, /synthetic/);
    return driver;
  });
  const child = await spawnTarget(target, [join(tmpdir(), 'synthetic')], { sandbox });
  assert.equal(isOwnedProcess(999999), true);
  child.stdout.resume();
  child.stderr.resume();
  const closed = once(child, 'close');
  await terminateProcess(child);
  await closed;
  assert.equal(driver.kills, 1);
  assert.equal(isOwnedProcess(999999), false);
});

test('wait failure still cleans retained metadata, closes streams and disposes the driver', async () => {
  const driver = fake();
  driver.wait = async () => {
    throw new Error('synthetic failure');
  };
  let cleaned = false;
  const child = new MxcChildProcess(driver, 'fixture', [], async () => {
    cleaned = true;
  });
  const errors: string[] = [];
  child.on('error', (error) => errors.push(error.message));
  await new Promise<void>((resolve) => child.once('close', () => resolve()));
  assert.equal(cleaned, true);
  assert.deepEqual(errors, ['runtime-permission-or-sandbox-error']);
  assert.equal(driver.disposals, 1);
  assert.ok(child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed);
});
test('captureTarget collects MXC output and unavailable status preserves ordinary launch', async (t) => {
  const driver = fake();
  driver.standardInput.on('finish', () => {
    driver.standardOutput.write('MXC_OK');
    driver.finish();
  });
  t.mock.method(mxcExecution, 'status', async () => ({ available: true, sdkVersion: '1.0.1' }));
  t.mock.method(mxcExecution, 'spawn', async () => driver);
  assert.deepEqual(await captureTarget(target, [], { sandbox }), { stdout: 'MXC_OK', exitCode: 0 });
  t.mock.method(mxcExecution, 'status', async () => ({ available: false }));
  t.mock.method(mxcExecution, 'spawn', async () => assert.fail('unavailable must not load SDK'));
  const output = await captureTarget(target, ['-e', 'process.stdout.write("PLAIN_OK")'], { sandbox });
  assert.equal(output.stdout, 'PLAIN_OK');
});
test('SDK 1.0.0 still permits ordinary sandbox streaming without capture', async (t) => {
  const driver = fake();
  driver.standardInput.on('finish', () => {
    driver.standardOutput.write('MXC_OK');
    driver.finish();
  });
  t.mock.method(mxcExecution, 'status', async () => ({ available: true, sdkVersion: '1.0.0' }));
  const spawn = t.mock.method(mxcExecution, 'spawn', async (request: Parameters<typeof mxcExecution.spawn>[0]) => {
    assert.equal(
      request.containment?.type === 'processcontainer' ? request.containment.config?.captureDenials : undefined,
      undefined,
    );
    return driver;
  });
  assert.deepEqual(
    await captureTarget(target, [], {
      sandbox: { ...sandbox, containment: { type: 'processcontainer', config: { capabilities: ['registryRead'] } } },
      onSandboxFailure: () => assert.fail('ordinary sandbox spawn must succeed'),
    }),
    { stdout: 'MXC_OK', exitCode: 0 },
  );
  assert.equal(spawn.mock.callCount(), 1);
});

test('known SDK capture crash bypasses sandbox before changing TEMP and does not count a failure', async (t) => {
  t.mock.method(mxcExecution, 'status', async () => ({ available: true, sdkVersion: '1.0.0' }));
  t.mock.method(mxcExecution, 'spawn', async () => assert.fail('known broken capture must never spawn'));
  const output = await captureTarget(target, ['-e', 'process.stdout.write(process.env.TEMP)'], {
    sandbox,
    runTemp: sandbox.runTemp,
    env: { ...process.env, TEMP: 'synthetic-original-temp' },
    onSandboxFailure: () => assert.fail('an unavailable capability is not a startup failure'),
    onSandboxSuccess: () => assert.fail('ordinary launch is not sandbox success'),
  });
  assert.equal(output.stdout, 'synthetic-original-temp');
});

test('shutdown terminates registered MXC children and prevents further launches', async (t) => {
  const driver = fake();
  t.mock.method(mxcExecution, 'status', async () => ({ available: true, sdkVersion: '1.0.1' }));
  let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spawning = new Promise<void>((resolve) => {
    entered = resolve;
  });
  t.mock.method(mxcExecution, 'spawn', async () => {
    entered();
    await barrier;
    return driver;
  });
  const launching = spawnTarget(target, [], { sandbox });
  await spawning;
  let shutDown = false;
  const stopping = shutdownOwnedProcesses().then(() => {
    shutDown = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutDown, false, 'shutdown must include an MXC launch already in progress');
  release();
  await assert.rejects(launching, /operation-cancelled/);
  await stopping;
  assert.equal(driver.kills, 1);
  assert.equal(isOwnedProcess(999999), false);
  await assert.rejects(spawnTarget(target, [], { sandbox }), /operation-cancelled/);
});
