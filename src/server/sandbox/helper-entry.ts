import { pipeline } from 'node:stream/promises';
import { helperError, type HelperReply, type HelperRequest } from './helper-protocol.ts';
import { probeMxc, spawnMxcProcess } from './helper-sdk.ts';
import { deleteRetainedEtl } from './learning-report.ts';
import type { MxcDriver } from './mxc-child.ts';

let driver: MxcDriver | undefined;
let busy = false,
  settled = false;
function send(message: HelperReply) {
  return new Promise<void>((resolve, reject) => {
    if (!process.send || !process.connected) return reject(new Error('sandbox-helper-closed'));
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}
process.on('disconnect', () => {
  if (!settled) {
    try {
      driver?.kill();
      driver?.dispose();
    } catch {}
  }
  process.stdin.destroy();
});
process.on('message', (value: HelperRequest) => {
  if (value?.type === 'kill') {
    try {
      driver?.kill();
    } catch {}
    return;
  }
  if (busy) return;
  busy = true;
  void (async () => {
    try {
      if (value?.type === 'probe') {
        await send({ type: 'probe', result: await probeMxc() });
      } else if (value?.type === 'spawn') {
        driver = await spawnMxcProcess(value.request);
        // Take streams before wait(): the SDK otherwise drains them internally.
        const stdin = driver.standardInput,
          stdout = driver.standardOutput,
          stderr = driver.standardError;
        const outputs = [
          stdout ? pipeline(stdout, process.stdout, { end: false }) : Promise.resolve(),
          stderr ? pipeline(stderr, process.stderr, { end: false }) : Promise.resolve(),
        ];
        for (const output of outputs) void output.catch(() => {});
        if (stdin) {
          stdin.on('error', () => {});
          process.stdin.pipe(stdin);
        }
        await send({ type: 'ready', pid: driver.id });
        let outcome;
        try {
          outcome = await driver.wait();
        } finally {
          await deleteRetainedEtl(driver.outputMetadata);
        }
        let drainTimer: NodeJS.Timeout | undefined;
        await Promise.race([
          Promise.all(outputs),
          new Promise<void>((resolve) => {
            drainTimer = setTimeout(resolve, 1000);
          }),
        ]);
        clearTimeout(drainTimer);
        const metadata = driver.outputMetadata;
        driver.dispose();
        driver = undefined;
        await send({ type: 'done', ...outcome, metadata });
      } else throw Object.assign(new Error('invalid helper request'), { code: 'sandbox-helper-protocol' });
      process.exitCode = 0;
    } catch (error) {
      await send({ type: 'error', ...helperError(error) }).catch(() => {});
      process.exitCode = 1;
    } finally {
      settled = true;
      try {
        driver?.dispose();
      } catch {
        process.exitCode = 1;
      }
      process.stdin.destroy();
      if (process.connected) process.disconnect?.();
    }
  })();
});
