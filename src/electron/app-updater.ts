import type { AppState } from '../shared/types.ts';

export const WINDOWS_UPDATE_FEED = 'https://download.pugport.com/windows';
export function nativeUpdatesEnabled(packaged: boolean, platform: string, smoke: boolean) {
  return packaged && platform === 'win32' && !smoke;
}

type Updater = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  setFeedURL(value: { provider: 'generic'; url: string }): void;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(silent: boolean, reopen: boolean): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
};

/** All installation exits go through the desktop's normal scripted quit guard. */
export class AppUpdater {
  update?: AppState['appUpdate'];
  private first?: ReturnType<typeof setTimeout>;
  private recurring?: ReturnType<typeof setInterval>;
  private waiting?: ReturnType<typeof setInterval>;
  private busy = false;
  private closed = false;
  private logged = false;
  constructor(
    private readonly updater: Updater,
    private readonly host: {
      enabled(): Promise<boolean>;
      requestQuit(install: () => void): Promise<boolean>;
      changed(): void;
      error(error: unknown): void;
    },
  ) {
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.setFeedURL({ provider: 'generic', url: WINDOWS_UPDATE_FEED });
    updater.on('error', this.error);
    updater.on('update-downloaded', this.downloaded);
    this.first = setTimeout(() => void this.check(), 30_000);
    this.recurring = setInterval(() => void this.check(), 6 * 60 * 60_000);
  }
  private error = (error: unknown) => {
    if (this.logged || this.closed) return;
    this.logged = true;
    this.host.error(error);
  };
  private downloaded = (info: { version: string }) => {
    if (this.closed) return;
    this.update = { version: info.version, status: 'ready' };
    this.host.changed();
  };
  async check() {
    try {
      if (!this.closed && (await this.host.enabled())) await this.updater.checkForUpdates();
    } catch (error) {
      this.error(error);
    }
  }
  async restart() {
    if (this.closed || !this.update || this.busy) return;
    this.busy = true;
    try {
      if (!(await this.host.enabled())) return;
      if (this.update.status !== 'waiting') {
        this.update = { ...this.update, status: 'waiting' };
        this.host.changed();
      }
      const accepted = await this.host.requestQuit(() => this.updater.quitAndInstall(true, true));
      if (accepted) {
        if (this.waiting) clearInterval(this.waiting);
        this.waiting = undefined;
      } else if (!this.waiting) this.waiting = setInterval(() => void this.restart(), 1000);
    } catch (error) {
      this.error(error);
    } finally {
      this.busy = false;
    }
  }
  close() {
    this.closed = true;
    clearTimeout(this.first);
    clearInterval(this.recurring);
    clearInterval(this.waiting);
    this.updater.removeListener('error', this.error);
    this.updater.removeListener('update-downloaded', this.downloaded);
  }
}
