import { spawn } from '../server/platform/test-process.ts';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDesktopPort } from '../server/platform/desktop-endpoint.ts';
import { BackendError, BackendUnavailable, type PugPortClient } from './client.ts';

export type LaunchPlan = { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv };

/** The app folder: two levels above this file, both as source (src/cli) and as the bundle (dist/cli). */
export function appRoot(moduleUrl = import.meta.url) {
  return resolve(dirname(fileURLToPath(moduleUrl)), '..', '..');
}

type Probe = {
  platform?: NodeJS.Platform;
  execPath?: string;
  electron?: boolean;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  read?: (path: string) => string;
};

/**
 * How to start (or bring forward) the desktop app. A second start simply focuses the running window: the app
 * keeps a single instance. Returns undefined when no PugPort app can be found next to this command.
 */
export function desktopLaunchPlan(root: string, probe: Probe = {}): LaunchPlan | undefined {
  const platform = probe.platform ?? process.platform;
  const { basename, delimiter, dirname, join } = platform === 'win32' ? win32 : posix;
  const execPath = probe.execPath ?? process.execPath;
  const electron = probe.electron ?? Boolean(process.versions.electron);
  const exists = probe.exists ?? existsSync;
  const read = probe.read ?? ((path: string) => readFileSync(path, 'utf8'));
  // The command itself runs inside the app's runtime with this flag; the app must not inherit it.
  const env = { ...(probe.env ?? process.env) };
  for (const key of Object.keys(env))
    if (['ELECTRON_RUN_AS_NODE', 'PUGPORT_UNDER_TEST', 'NODE_TEST_CONTEXT'].includes(key.toUpperCase()))
      delete env[key];
  // Installed app: this command runs on PugPort.exe itself (resources/app/dist/cli), which opens the app.
  if (electron && !/^electron(\.exe)?$/i.test(basename(execPath)))
    return { command: execPath, args: [], cwd: dirname(execPath), env };
  const installed =
    platform === 'darwin'
      ? join(root, '..', '..', 'MacOS', 'PugPort')
      : join(root, '..', '..', platform === 'win32' ? 'PugPort.exe' : 'PugPort');
  // Source checkout: the development Electron opens the app folder, with the bundled Node first on PATH
  // (as Start-PugPort.cmd does).
  const pathFile = join(root, 'node_modules', 'electron', 'path.txt');
  if (exists(pathFile)) {
    const binary = join(root, 'node_modules', 'electron', 'dist', read(pathFile).trim());
    if (exists(binary)) {
      const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
      const runtime = join(root, '.runtime');
      if (exists(runtime)) env[pathKey] = [runtime, env[pathKey]].filter(Boolean).join(delimiter);
      return { command: binary, args: [root], cwd: root, env };
    }
  }
  if (exists(installed)) return { command: installed, args: [], cwd: dirname(installed), env };
  return undefined;
}

/** Starts the app on its own, so it keeps running after this command ends. */
export function launchDesktop(plan: LaunchPlan, start: typeof spawn = spawn) {
  const child = start(plan.command, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.on('error', () => undefined);
  child.unref();
}

/**
 * Makes sure the backend answers: if it does not, starts the desktop app and waits for it briefly.
 * Throws BackendUnavailable with one plain sentence when that does not work.
 */
export async function ensureBackend(
  client: PugPortClient,
  options: {
    launch?: () => boolean;
    waitMs?: number;
    onStarting?: () => void;
    sleep?: (ms: number) => Promise<void>;
    /** Whether a desktop is already running: by default, the endpoint file names a live process. */
    running?: () => boolean;
  } = {},
) {
  if (await client.health()) return;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const deadline = Date.now() + (options.waitMs ?? 30_000);
  // A running desktop that is slow to answer (a busy machine, its backend restarting) is waited for, never started
  // again: a second start only brings the owner's window to the front.
  if ((options.running ?? (() => readDesktopPort() !== undefined))()) {
    while (Date.now() < deadline) {
      await sleep(500);
      if (await client.health(5000)) return;
    }
    throw new BackendError('PugPort 没有及时回应，请稍后再试。', 504);
  }
  const launch =
    options.launch ??
    (() => {
      const plan = desktopLaunchPlan(appRoot());
      if (!plan) return false;
      launchDesktop(plan);
      return true;
    });
  if (!launch()) throw new BackendUnavailable();
  options.onStarting?.();
  while (Date.now() < deadline) {
    await sleep(500);
    if (await client.health(1500)) return;
  }
  throw new BackendUnavailable();
}
