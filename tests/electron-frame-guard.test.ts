import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import electron from 'electron';
import { electronArgs } from './helpers/electron-app.cjs';

// Owner-only acceptance test. Do not include it in the batch's targeted Node test command.
test('Electron: Mod frames cannot use host capabilities or leak HTTP, DNS or STUN', { timeout: 120000 }, async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'pugport-mod-frame-guard-')));
  t.after(async () => {
    assert.equal(dirname(directory).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
    assert.ok(basename(directory).startsWith('pugport-mod-frame-guard-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await build({
    entryPoints: [resolve('tests/helpers/mod-frame-guard-app.ts')],
    outfile: join(directory, 'app.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  });
  await build({
    entryPoints: [resolve('src/electron/preload.ts')],
    outfile: join(directory, 'preload.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const execution = promisify(execFile)(String(electron), electronArgs(join(directory, 'app.cjs'), directory), {
    env,
    timeout: 110000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  execution.child.once('exit', (code, signal) =>
    t.diagnostic(`EXIT ModFrameGuard parent: code=${code} signal=${signal ?? 'none'}`),
  );
  execution.child.once('error', (error) => t.diagnostic(`ERROR ModFrameGuard parent: ${error.stack ?? error}`));
  const result = await execution.catch((error) => {
    t.diagnostic(
      `FAIL ModFrameGuard parent: code=${error.code} signal=${error.signal ?? 'none'} killed=${error.killed}`,
    );
    if (error.stdout) t.diagnostic(error.stdout);
    if (error.stderr) t.diagnostic(error.stderr);
    throw error;
  });
  t.diagnostic(result.stdout);
  if (result.stderr.trim()) t.diagnostic(result.stderr);
  assert.match(result.stdout, /MOD_FRAME_GUARD_ACCEPTED/);
});
