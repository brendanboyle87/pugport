import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, watch, type FSWatcher, type Stats } from 'node:fs';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import type { RunRecord, RuntimeTarget } from '../shared/types.ts';
import type { VerificationEvidenceReceipt } from '../shared/run-evidence.ts';

type Result = NonNullable<RunRecord['verification']>;
type Snapshot = {
  id: string;
  durationMs: number;
  /** Whether a file event has reported a change so far. */
  valid: () => boolean;
  /** Also compares the metadata on disk now, for edits whose file events have not been delivered yet. */
  confirm: () => Promise<boolean>;
  close: () => void;
};
export type VerificationRequest = {
  command: string;
  cwd: string;
  environment: RuntimeTarget['environment'];
  permissionMode: 'read-only' | 'workspace-write';
  authorizationScope: string;
  approved: () => boolean;
  signal: AbortSignal;
};

// Dependency/runtime payloads are covered by compiler reads and executable identities, including managed junctions.
const ignored = (path: string) =>
  ['.git', 'node_modules', '.runtime'].includes(path.replace(/\\/g, '/').split('/')[0]!);
async function executablePath(command: string) {
  if (isAbsolute(command)) return realpath(command).catch(() => undefined);
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    for (const extension of process.platform === 'win32' ? ['', '.exe', '.cmd'] : ['']) {
      const path = await realpath(join(directory.replace(/^"|"$/g, ''), command + extension)).catch(() => undefined);
      if (path) return path;
    }
  }
  return undefined;
}
const within = (root: string, path: string) => {
  const local = relative(root, path);
  return !local.startsWith('..') && !isAbsolute(local);
};
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
// Access time is left out: running the Node executable updates it on macOS.
const identity = (info: Stats) => [info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs];
const stampEntryLimit = 100_000;

/**
 * File events alone cannot gate reuse: macOS delivers FSEvents several milliseconds after a write, after the next
 * turn. A stamp of the project tree and of every other path the check depends on is readable at the moment of reuse.
 */
async function metadataStamp(root: string, paths: readonly string[]) {
  const digest = createHash('sha256');
  let entriesSeen = 0;
  const visit = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const local = relative(root, path);
      if (ignored(local)) continue;
      // The walk runs on every reuse, so a very large tree gives up reuse instead of stalling each check.
      if (++entriesSeen > stampEntryLimit) throw new Error('Snapshot limit');
      const info = await lstat(path);
      digest.update(JSON.stringify([local, ...identity(info)]));
      if (info.isDirectory()) await visit(path);
    }
  };
  await visit(root);
  for (const path of paths) {
    const info = await stat(path).catch(() => undefined);
    digest.update(JSON.stringify([path, ...(info ? identity(info) : [null])]));
  }
  return digest.digest('hex');
}
const environmentId = () => hash(JSON.stringify(Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b))));

/** Only a direct, emit-free compiler invocation is eligible; npm scripts always execute. */
export async function reusableTypecheck(command: string, cwd: string, environment: RuntimeTarget['environment']) {
  if (
    environment !== 'native' ||
    Object.entries(process.env).some(([key, value]) => /^node_options$/i.test(key) && value)
  )
    return undefined;
  if (/[\r\n`$;|<>]/.test(command)) return undefined;
  const words = command.match(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s]+/g)?.map((word) => word.replace(/^(["'])(.*)\1$/, '$2'));
  if (words?.[0] === '&' && process.platform === 'win32') words.shift();
  if (!words) return undefined;
  try {
    const require = createRequire(import.meta.url);
    const library = await realpath(require.resolve('typescript', { paths: [cwd] }));
    const compiler = await realpath(join(dirname(library), 'tsc.js'));
    let nodePath: string | undefined;
    if (/^node(?:\.exe)?$/i.test(basename(words[0]!))) {
      nodePath = await executablePath(words[0]!);
      if (!nodePath) return undefined;
      if ((await realpath(words[1]!)) !== compiler) return undefined;
      words.splice(0, 2);
    } else {
      const executable = words.shift()!;
      const resolved = await executablePath(executable);
      if (!resolved || resolved !== (await realpath(join(dirname(library), '../bin/tsc')))) return undefined;
      nodePath = await executablePath('node');
      if (!nodePath) return undefined;
    }
    let config = 'tsconfig.json';
    const flags = new Map<string, string>();
    for (let index = 0; index < words.length; index++) {
      const flag = words[index]!;
      if (flag === '--noEmit') flags.set(flag, 'true');
      else if (['--incremental', '--composite', '--project', '-p'].includes(flag)) {
        const value = words[++index];
        if (!value) return undefined;
        if (flag === '--project' || flag === '-p') config = value;
        else flags.set(flag, value);
      } else return undefined;
    }
    if (
      flags.get('--noEmit') !== 'true' ||
      flags.get('--incremental') !== 'false' ||
      flags.get('--composite') !== 'false'
    )
      return undefined;
    const configPath = await realpath(resolve(cwd, config));
    if (!within(await realpath(cwd), configPath)) return undefined;
    const apiPath = require.resolve('typescript/unstable/async', { paths: [cwd] });
    const apiModule = (await import(pathToFileURL(apiPath).href)) as typeof import('typescript/unstable/async');
    const getExeModule = (await import(pathToFileURL(join(dirname(library), 'getExePath.js')).href)) as {
      default: () => string;
    };
    return {
      library,
      nodePath,
      compiler,
      configPath,
      apiPath,
      executable: await realpath(getExeModule.default()),
      API: apiModule.API,
    };
  } catch {
    return undefined;
  }
}

/** Content plus an uninterrupted watch catches dirty, new, deleted, and changed-back files. */
export async function verificationSnapshot(
  cwd: string,
  typecheck: NonNullable<Awaited<ReturnType<typeof reusableTypecheck>>>,
): Promise<Snapshot | undefined> {
  const started = performance.now();
  const watchers: FSWatcher[] = [];
  let changed = false;
  const close = () => {
    changed = true;
    for (const watcher of watchers) watcher.close();
  };
  try {
    const root = await realpath(cwd);
    const roots = new Set([root, dirname(dirname(typecheck.library))]);
    const ancestorPaths: string[] = [];
    for (let directory = root; ; directory = dirname(directory)) {
      const dependencies = await realpath(join(directory, 'node_modules')).catch(() => undefined);
      if (dependencies) roots.add(dependencies);
      if (directory === dirname(directory)) break;
      ancestorPaths.push(join(dirname(directory), 'node_modules'), join(dirname(directory), 'package.json'));
      const ancestor = watch(dirname(directory), { persistent: false }, (_event, file) => {
        if (!file || ['node_modules', 'package.json'].includes(file.toString())) changed = true;
      });
      ancestor.on('error', () => (changed = true));
      watchers.push(ancestor);
    }
    for (const directory of roots) {
      const watcher = watch(directory, { recursive: true, persistent: false }, (_event, file) => {
        if (!file || file.toString().replace(/\\/g, '/').split('/')[0] !== '.git') changed = true;
      });
      watcher.on('error', () => (changed = true));
      watchers.push(watcher);
    }
    // The Node executable is covered by the metadata stamp, not a watch: on macOS every launch fires a change event.
    const inputs = new Set([
      typecheck.library,
      typecheck.compiler,
      typecheck.executable,
      typecheck.apiPath,
      typecheck.nodePath,
    ]);
    const api = new typecheck.API({
      cwd: root,
      tsserverPath: typecheck.executable,
      fs: {
        readFile(path) {
          try {
            const content = readFileSync(path, 'utf8');
            inputs.add(resolve(path));
            return content;
          } catch {
            return null;
          }
        },
      },
    });
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        (async () => {
          const project = await api.updateSnapshot({ openProjects: [typecheck.configPath] });
          const projects = project.getProjects();
          if (!projects.length) throw new Error('Missing compiler project');
          for (const item of projects) for (const path of await item.program.getSourceFileNames()) inputs.add(path);
        })(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Compiler snapshot timeout')), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
      await api.close();
    }
    const stampPaths = [
      ...new Set([...[...inputs].flatMap((input) => [input, dirname(input)]), ...roots, ...ancestorPaths]),
    ].sort();
    const stampBefore = await metadataStamp(root, stampPaths);
    const digest = createHash('sha256');
    let files = 0;
    let bytes = 0;
    const visit = async (directory: string) => {
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const path = join(directory, entry.name);
        const local = relative(root, path);
        if (ignored(local)) continue;
        const before = await lstat(path);
        if (before.isSymbolicLink()) throw new Error('External snapshot input');
        digest.update(JSON.stringify([local, before.mode, before.size, before.mtimeMs, before.ctimeMs]));
        if (before.isDirectory()) await visit(path);
        else if (before.isFile()) {
          // Non-source payloads cannot affect this static check; actual compiler reads are always added below.
          if (!/\.(?:[cm]?[jt]sx?|jsonc?)$/i.test(path)) continue;
          if (++files > 10000 || (bytes += before.size) > 64 * 1024 * 1024) throw new Error('Snapshot limit');
          digest.update(await readFile(path));
          const after = await stat(path);
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
            throw new Error('Snapshot changed');
        } else throw new Error('Unsupported snapshot input');
      }
    };
    await visit(root);
    for (const input of [...inputs].sort()) {
      const path = await realpath(input);
      if (path !== typecheck.nodePath && ![...roots].some((directory) => within(directory, path)))
        throw new Error('External compiler input');
      digest.update(path);
      digest.update(await readFile(path));
    }
    await nextTurn();
    // An edit after a file was read but before the end of the scan changes the stamp even if its event is late.
    const stamp = await metadataStamp(root, stampPaths);
    if (changed || stamp !== stampBefore) throw new Error('Snapshot changed');
    const confirm = async () => {
      if (changed) return false;
      if ((await metadataStamp(root, stampPaths).catch(() => undefined)) !== stamp) changed = true;
      return !changed;
    };
    return {
      id: digest.digest('hex'),
      durationMs: performance.now() - started,
      valid: () => !changed,
      confirm,
      close,
    };
  } catch {
    close();
    return undefined;
  }
}

type Entry = {
  snapshot: Snapshot;
  abort: AbortController;
  consumers: number;
  settled: boolean;
  promise: Promise<Result>;
  timer?: NodeJS.Timeout;
};

export class VerificationReceipts {
  private closed = false;
  private entries = new Map<string, Entry>();
  private flights = new Set<Entry>();
  private snapshots = new Map<string, { promise: Promise<Snapshot | undefined>; timer: NodeJS.Timeout }>();
  constructor(private readonly execute: (request: VerificationRequest, signal: AbortSignal) => Promise<Result>) {}

  async close() {
    this.closed = true;
    for (const entry of this.flights) entry.abort.abort();
    for (const entry of this.entries.values()) {
      entry.abort.abort();
      entry.snapshot.close();
      clearTimeout(entry.timer);
    }
    this.entries.clear();
    const snapshots = [...this.snapshots.values()];
    for (const cached of snapshots) {
      clearTimeout(cached.timer);
      void cached.promise.then((snapshot) => snapshot?.close());
    }
    this.snapshots.clear();
    await Promise.allSettled([
      ...[...this.flights].map((entry) => entry.promise),
      ...snapshots.map((cached) => cached.promise.then((snapshot) => snapshot?.close())),
    ]);
  }

  async verify(request: VerificationRequest): Promise<Result> {
    request = { ...request, environment: request.environment ?? 'native' };
    if (this.closed) return this.cancelled(request);
    if (!request.approved()) return this.skipped(request);
    if (request.signal.aborted) return this.cancelled(request);
    const started = performance.now();
    const reusable = await reusableTypecheck(request.command, request.cwd, request.environment);
    if (request.signal.aborted || this.closed) return this.cancelled(request);
    const currentEnvironment = environmentId();
    const snapshot = reusable ? await this.snapshot(request, reusable, currentEnvironment) : undefined;
    const snapshotDurationMs = performance.now() - started;
    if (!request.approved()) {
      snapshot?.close();
      return this.skipped(request);
    }
    if (request.signal.aborted || this.closed) {
      snapshot?.close();
      return this.cancelled(request);
    }
    const scope: VerificationEvidenceReceipt['scope'] = {
      projectPath: await realpath(request.cwd).catch(() => resolve(request.cwd)),
      environment: request.environment,
      permissionMode: request.permissionMode,
      command: request.command,
    };
    const receipt = (
      result: Result,
      reused: boolean,
      id = randomUUID(),
      checkedAt = new Date().toISOString(),
    ): Result => ({
      ...result,
      receipt: {
        id,
        source: 'host-verification',
        checkedAt,
        snapshot: snapshot?.id,
        reused,
        stable: snapshot?.valid() ?? false,
        snapshotDurationMs,
        scope,
      },
    });
    if (!snapshot) return receipt(await this.execute(request, request.signal), false);
    const key = hash(JSON.stringify([scope, request.authorizationScope, currentEnvironment, snapshot.id]));
    const existing = this.entries.get(key);
    if (existing && !existing.abort.signal.aborted) await existing.snapshot.confirm();
    if (request.signal.aborted || this.closed) {
      snapshot.close();
      return this.cancelled(request);
    }
    let entry = this.entries.get(key);
    let reused = !!entry;
    if (entry && (!entry.snapshot.valid() || entry.abort.signal.aborted)) {
      this.remove(key, entry);
      entry = undefined;
      reused = false;
    }
    if (entry) snapshot.close();
    else {
      const abort = new AbortController();
      entry = { snapshot, abort, consumers: 0, settled: false, promise: undefined! };
      const created = entry;
      this.entries.set(key, created);
      this.flights.add(created);
      created.promise = Promise.resolve()
        .then(() => (abort.signal.aborted ? this.cancelled(request) : this.execute(request, abort.signal)))
        .then(async (result) => {
          await nextTurn();
          const stable = (await created.snapshot.confirm()) && environmentId() === currentEnvironment;
          const completed = receipt(result, false);
          completed.receipt!.stable = stable;
          created.settled = true;
          this.flights.delete(created);
          if (result.status !== 'passed' || abort.signal.aborted || !stable) this.remove(key, created);
          else {
            created.timer = setTimeout(() => this.remove(key, created), 30_000);
            created.timer.unref();
            while (this.entries.size > 32) {
              const removable = [...this.entries].find(([, value]) => value.settled);
              if (!removable) break;
              this.remove(...removable);
            }
          }
          return completed;
        })
        .catch((error: unknown) => {
          created.settled = true;
          this.flights.delete(created);
          this.remove(key, created);
          throw error;
        });
    }
    return this.consume(request, key, entry, reused);
  }

  private async snapshot(
    request: VerificationRequest,
    typecheck: NonNullable<Awaited<ReturnType<typeof reusableTypecheck>>>,
    environment: string,
  ): Promise<Snapshot | undefined> {
    const key = hash(JSON.stringify([resolve(request.cwd), request.command, environment]));
    let cached = this.snapshots.get(key);
    if (cached) {
      const snapshot = await cached.promise;
      await nextTurn();
      if (snapshot && (await snapshot.confirm())) return { ...snapshot, durationMs: 0, close: () => {} };
      snapshot?.close();
      // Another request may have replaced the expired snapshot while this one was being confirmed.
      if (this.snapshots.get(key) === cached) {
        clearTimeout(cached.timer);
        this.snapshots.delete(key);
      }
      cached = undefined;
    }
    // Shutdown may have happened while the cached snapshot was being confirmed; a new one would outlive close().
    if (this.closed) return undefined;
    const promise = (async () =>
      (await verificationSnapshot(request.cwd, typecheck)) ?? (await verificationSnapshot(request.cwd, typecheck)))();
    const expire = () => {
      if (this.snapshots.get(key)?.promise === promise) this.snapshots.delete(key);
      void promise.then((snapshot) => snapshot?.close());
    };
    const timer = setTimeout(expire, 30_000);
    timer.unref();
    this.snapshots.set(key, { promise, timer });
    while (this.snapshots.size > 8) {
      const [oldKey, old] = this.snapshots.entries().next().value!;
      this.snapshots.delete(oldKey);
      clearTimeout(old.timer);
      void old.promise.then((snapshot) => snapshot?.close());
    }
    const snapshot = await promise;
    return snapshot ? { ...snapshot, close: () => {} } : undefined;
  }

  private consume(request: VerificationRequest, key: string, entry: Entry, reused: boolean): Promise<Result> {
    entry.consumers++;
    return new Promise((resolveResult, reject) => {
      let finished = false;
      const finish = () => {
        if (finished) return false;
        finished = true;
        request.signal.removeEventListener('abort', cancel);
        entry.consumers--;
        return true;
      };
      const cancel = () => {
        if (!finish()) return;
        resolveResult(this.cancelled(request));
        if (!entry.consumers && !entry.settled) {
          entry.abort.abort();
          this.remove(key, entry);
        }
      };
      request.signal.addEventListener('abort', cancel, { once: true });
      if (request.signal.aborted) cancel();
      entry.promise.then(
        (result) => {
          if (!finish()) return;
          if (!request.approved()) return resolveResult(this.skipped(request));
          // A successful command remains scoped evidence even when edits prevent its reuse.
          const source = result.receipt!;
          resolveResult({ ...result, receipt: { ...source, reused, stable: source.stable && entry.snapshot.valid() } });
        },
        (error: unknown) => {
          if (finish()) reject(error);
        },
      );
    });
  }

  private remove(key: string, entry: Entry) {
    if (this.entries.get(key) === entry) this.entries.delete(key);
    clearTimeout(entry.timer);
    entry.snapshot.close();
  }

  private skipped(request: VerificationRequest): Result {
    return this.withTerminalReceipt(request, 'skipped', '验收命令未经桌面批准，已跳过');
  }
  private cancelled(request: VerificationRequest): Result {
    return this.withTerminalReceipt(request, 'cancelled', '');
  }
  private withTerminalReceipt(request: VerificationRequest, status: 'skipped' | 'cancelled', output: string): Result {
    return {
      command: request.command,
      status,
      exitCode: null,
      output,
      receipt: {
        id: randomUUID(),
        source: 'host-verification',
        checkedAt: new Date().toISOString(),
        reused: false,
        stable: false,
        scope: {
          projectPath: resolve(request.cwd),
          environment: request.environment,
          permissionMode: request.permissionMode,
          command: request.command,
        },
      },
    };
  }
}
