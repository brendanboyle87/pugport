import type { MacUpdateStatus } from '../shared/app-update.ts';
import { currentHost, type Host } from '../server/platform/host.ts';
import {
  downloadMacUpdate,
  fetchMacManifest,
  MacUpdateFailure,
  unpackMacUpdate,
  type MacInstallJob,
  type MacUpdateFeed,
} from '../server/platform/mac-update.ts';

type Staged = { app: string; version: string };

/**
 * One update at a time: download → verify → ready → (the user agrees) normal quit → detached installer.
 * The manifest is fetched and verified again here; nothing the page sends chooses a file or an address.
 */
export class MacUpdater {
  private status: Omit<MacUpdateStatus, 'installable'> = { phase: 'idle' };
  private staged?: Staged;
  private abort?: AbortController;
  private running?: Promise<void>;
  private lastProgress = 0;
  constructor(
    private readonly deps: {
      feed: MacUpdateFeed;
      currentVersion: string;
      /** `<data>/updates`, owned by the updater. */
      updatesDir: string;
      /** The bundle to replace, or undefined when one-click install is not allowed. */
      target: () => string | undefined;
      /** The app's normal quit; false when the user cancels it. */
      quit: () => Promise<boolean>;
      launch: (job: MacInstallJob) => void;
      changed: (status: MacUpdateStatus) => void;
      fetch?: typeof fetch;
      host?: Host;
      publicKey?: string;
      pid?: number;
      env?: NodeJS.ProcessEnv;
      now?: () => number;
    },
  ) {
    // A download left by an earlier run (quit without installing, or a failed install) is not reused.
    try {
      this.host.fs.rmSync(this.work, { recursive: true, force: true });
    } catch {
      /* The next download clears it again. */
    }
  }
  get state(): MacUpdateStatus {
    return { installable: !!this.deps.target(), ...this.status };
  }
  private set(status: Omit<MacUpdateStatus, 'installable'>) {
    this.status = status;
    this.deps.changed(this.state);
  }
  private get host() {
    return this.deps.host ?? currentHost();
  }
  private get work() {
    return this.host.path.join(this.deps.updatesDir, 'staging');
  }
  /** Starts (or joins) a download. Resolves when it is ready or has failed; the status says which. */
  download(): Promise<void> {
    if (this.running) return this.running;
    if (this.status.phase === 'ready' || this.status.phase === 'installing') return Promise.resolve();
    if (!this.deps.target()) {
      this.set({ phase: 'error', error: 'install' });
      return Promise.resolve();
    }
    this.abort = new AbortController();
    this.running = this.run(this.abort.signal).finally(() => {
      this.running = undefined;
      this.abort = undefined;
    });
    return this.running;
  }
  private async run(signal: AbortSignal) {
    const { fs, path } = this.host;
    const work = this.work;
    try {
      this.staged = undefined;
      this.set({ phase: 'downloading', received: 0 });
      fs.rmSync(work, { recursive: true, force: true });
      fs.mkdirSync(work, { recursive: true, mode: 0o700 });
      const manifest = await fetchMacManifest(this.deps.feed, {
        currentVersion: this.deps.currentVersion,
        fetch: this.deps.fetch,
        signal,
        publicKey: this.deps.publicKey,
      });
      this.set({ phase: 'downloading', version: manifest.version, received: 0, total: manifest.size });
      const zip = path.join(work, 'update.zip');
      await downloadMacUpdate(manifest, zip, {
        fetch: this.deps.fetch,
        signal,
        host: this.host,
        onProgress: (received, total) => {
          const now = (this.deps.now ?? Date.now)();
          if (received < total && now - this.lastProgress < 200) return;
          this.lastProgress = now;
          this.set({ phase: 'downloading', version: manifest.version, received, total });
        },
      });
      this.set({ phase: 'verifying', version: manifest.version });
      const unpacked = path.join(work, 'app');
      fs.mkdirSync(unpacked);
      const app = await unpackMacUpdate(zip, unpacked, manifest.version, this.host);
      fs.rmSync(zip, { force: true });
      if (signal.aborted) throw new MacUpdateFailure('network', 'cancelled');
      this.staged = { app, version: manifest.version };
      this.set({ phase: 'ready', version: manifest.version });
    } catch (error) {
      fs.rmSync(work, { recursive: true, force: true });
      this.set({
        phase: 'error',
        version: this.status.version,
        error: error instanceof MacUpdateFailure ? error.reason : 'download',
      });
    }
  }
  /**
   * Runs the app's normal quit (running work asks first). Only once that quit is under way does the detached
   * installer start; a cancelled quit leaves the downloaded update ready.
   */
  async install(): Promise<boolean> {
    const staged = this.staged;
    if (this.status.phase !== 'ready' || !staged) return false;
    const target = this.deps.target();
    if (!target || !this.host.fs.existsSync(staged.app)) {
      this.staged = undefined;
      this.set({ phase: 'error', version: staged.version, error: 'install' });
      return false;
    }
    this.set({ phase: 'installing', version: staged.version });
    let quitting = false;
    try {
      quitting = await this.deps.quit();
    } catch {
      quitting = false;
    }
    if (!quitting) {
      this.set({ phase: 'ready', version: staged.version });
      return false;
    }
    this.deps.launch({
      pid: this.deps.pid ?? process.pid,
      target,
      staged: staged.app,
      work: this.work,
      log: this.host.path.join(this.deps.updatesDir, 'install.log'),
      env: this.deps.env ?? process.env,
    });
    return true;
  }
  close() {
    this.abort?.abort();
  }
}
