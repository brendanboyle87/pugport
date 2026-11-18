import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mxcHelpers, isMxcHelperPid } from '../src/server/sandbox/helper-client.ts';
import { mxcExecution } from '../src/server/sandbox/mxc-runtime.ts';
import { captureTarget } from '../src/server/adapters/process.ts';
import type { SandboxRequest } from '../src/server/sandbox/policy-builder.ts';
import type { RuntimeTarget } from '../src/shared/types.ts';

function peer(mode: string) {
  return fork(new URL('./helpers/mxc-helper.mjs', import.meta.url), [mode], {
    execArgv: [],
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
}
const sandbox: SandboxRequest = {
  provider: 'pi',
  runTemp: process.cwd(),
  reportDirectory: process.cwd(),
  fallback: { allowDaclMutation: false },
  containment: { type: 'processcontainer', config: { captureDenials: { mode: 'allow' } } },
};
const target: RuntimeTarget = {
  id: 'fixture-helper',
  provider: 'pi',
  label: 'Pi',
  command: process.execPath,
  environment: 'native',
  enabled: true,
};

test('helper protocol carries probe, native PID, piped streams and terminal code without loading SDK in backend', async (t) => {
  t.mock.method(mxcHelpers, 'launch', () => peer('echo'));
  assert.deepEqual(await mxcHelpers.probe(), {
    sdkVersion: '1.0.1',
    tier: 'base-container',
    probes: { baseContainerSupportsDenyPaths: true },
  });
  const driver = await mxcHelpers.spawn({ command: 'synthetic' });
  assert.ok(isMxcHelperPid(driver.id));
  let output = '',
    stderr = '';
  driver.standardOutput!.on('data', (chunk) => (output += chunk));
  driver.standardError!.on('data', (chunk) => (stderr += chunk));
  driver.standardInput!.end('synthetic input');
  assert.deepEqual(await driver.wait(), { exitCode: 7, timedOut: false });
  assert.equal(output, 'synthetic input');
  assert.equal(stderr, 'synthetic stderr');
  assert.equal(isMxcHelperPid(driver.id), false);
  const require = createRequire(import.meta.url);
  assert.ok(!Object.keys(require.cache).some((path) => /[\\/](?:koffi|@microsoft[\\/]mxc-sdk)[\\/]/.test(path)));
});

test('fake helper native-style crash before ready falls back once, emits a notice callback and preserves output', async (t) => {
  let helperPid = 0;
  t.mock.method(mxcHelpers, 'launch', () => {
    const child = peer('crash');
    helperPid = child.pid!;
    return child;
  });
  t.mock.method(mxcExecution, 'status', async () => ({ available: true, sdkVersion: '1.0.1' }));
  const notices: string[] = [];
  const result = await captureTarget(target, ['-e', 'process.stdout.write("PLAIN_OK")'], {
    sandbox,
    onSandboxFailure: (reason, phase) => {
      assert.equal(phase, 'startup');
      notices.push(reason);
    },
  });
  assert.equal(result.stdout, 'PLAIN_OK');
  assert.equal(notices.length, 1);
  assert.match(notices[0], /sandbox-helper-crashed/);
  assert.equal(isMxcHelperPid(helperPid), false);
});

test('helper crash after ready rejects wait rather than treating helper exit as native success; probe crash is isolated too', async (t) => {
  t.mock.method(mxcHelpers, 'launch', () => peer('crash-running'));
  const driver = await mxcHelpers.spawn({ command: 'synthetic' });
  driver.standardOutput!.resume();
  driver.standardError!.resume();
  await assert.rejects(driver.wait(), (error) => (error as NodeJS.ErrnoException).code === 'sandbox-helper-crashed');
  t.mock.method(mxcHelpers, 'launch', () => peer('crash'));
  await assert.rejects(
    mxcHelpers.probe(),
    (error) => (error as NodeJS.ErrnoException).code === 'sandbox-helper-crashed',
  );
});

test('helper kill travels over IPC and disposal releases the child', async (t) => {
  let child = peer('echo');
  t.mock.method(mxcHelpers, 'launch', () => child);
  const driver = await mxcHelpers.spawn({ command: 'synthetic' });
  const closing = once(child, 'close');
  driver.kill();
  await closing;
  await assert.rejects(driver.wait());
  driver.dispose();
  assert.equal(isMxcHelperPid(driver.id), false);
});

test('cancelling an in-flight helper startup never starts the ordinary task or emits a fallback notice', async (t) => {
  let child: ReturnType<typeof peer> | undefined;
  let entered!: () => void;
  const launched = new Promise<void>((resolve) => {
    entered = resolve;
  });
  t.mock.method(mxcHelpers, 'launch', () => {
    child = peer('hang');
    entered();
    return child;
  });
  t.after(() => child?.kill('SIGKILL'));
  t.mock.method(mxcExecution, 'status', async () => ({ available: true, sdkVersion: '1.0.1' }));
  const abort = new AbortController();
  let notices = 0;
  const running = captureTarget(target, ['-e', 'process.stdout.write("SHOULD_NOT_RUN")'], {
    sandbox,
    signal: abort.signal,
    onSandboxFailure: () => {
      notices++;
    },
  });
  const rejected = assert.rejects(running, /operation-cancelled/);
  await launched;
  const closing = once(child!, 'close');
  abort.abort();
  await rejected;
  await closing;
  assert.equal(notices, 0);
});
