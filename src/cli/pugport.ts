/**
 * The `pugport` terminal command: chat with the PugPort app on this machine, hand it one task, or check quota.
 * Bundled to dist/cli/pugport.js and started by the shims in bin/ (copied to dist/bin/).
 */
import { parseArgs } from './args.ts';
import { BackendError, BackendUnavailable } from './client.ts';
import { run } from './run.ts';

try {
  process.exitCode = await run(parseArgs(process.argv.slice(2)));
} catch (error) {
  const known = error instanceof BackendUnavailable || error instanceof BackendError;
  process.stderr.write(`${known ? (error as Error).message : `出错了：${(error as Error)?.message ?? error}`}\n`);
  process.exitCode = 1;
}
// Open connections close on their own; this only covers one that would keep the command from ending.
setTimeout(() => process.exit(), 1500).unref();
