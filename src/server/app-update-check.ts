import type { DatabaseSync } from 'node:sqlite';
import { APP_VERSION, GITHUB_REPO_URL } from '../shared/identity.ts';
import { fetchMacManifest, macUpdateFeed, type MacUpdateFeed } from './platform/mac-update.ts';

/** `mac` marks a signed Mac feed entry; its url is the archive, which the page offers when it cannot install. */
export type AppUpdate = { version: string; url: string; mac?: true };
export function usesNativeWindowsUpdater(env = process.env, platform = process.platform) {
  return env.COMBORUNNER_PACKAGED === '1' && platform === 'win32';
}

const day = 24 * 60 * 60_000;
const releases = `${GITHUB_REPO_URL}/releases/`;

function semver(value: string): number[] | undefined {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return;
  const numbers = value.split('.').map(Number);
  return numbers.every(Number.isSafeInteger) ? numbers : undefined;
}

export class AppUpdateCheck {
  update?: AppUpdate;
  private running?: Promise<void>;
  private abort?: AbortController;
  constructor(
    private readonly host: { db: DatabaseSync; enabled(): boolean; changed(): void },
    private readonly deps: {
      fetch?: typeof fetch;
      now?: () => number;
      version?: string;
      /** The Mac feed; null forces the GitHub check. Defaults to this machine's feed (none off macOS). */
      mac?: MacUpdateFeed | null;
      publicKey?: string;
    } = {},
  ) {
    host.db.exec(
      'CREATE TABLE IF NOT EXISTS app_update_check (id INTEGER PRIMARY KEY CHECK(id=1), lastCheck INTEGER NOT NULL)',
    );
  }
  tick(): Promise<void> | undefined {
    if (usesNativeWindowsUpdater() || !this.host.enabled() || this.running) return;
    const now = (this.deps.now ?? Date.now)();
    const previous = this.host.db.prepare('SELECT lastCheck FROM app_update_check WHERE id=1').get() as
      { lastCheck: number } | undefined;
    if (previous && now - previous.lastCheck < day) return;
    this.host.db
      .prepare(
        'INSERT INTO app_update_check(id,lastCheck) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET lastCheck=excluded.lastCheck',
      )
      .run(now);
    this.abort = new AbortController();
    this.running = this.check(this.abort.signal).finally(() => {
      this.running = undefined;
      this.abort = undefined;
    });
    return this.running;
  }
  private async check(signal: AbortSignal) {
    const timer = setTimeout(() => this.abort?.abort(), 10_000);
    const mac =
      this.deps.mac !== undefined
        ? this.deps.mac
        : macUpdateFeed({ packaged: process.env.COMBORUNNER_PACKAGED === '1', env: process.env });
    if (mac) {
      try {
        // Signature, fields, version and address are all checked; any failure shows nothing.
        const manifest = await fetchMacManifest(mac, {
          currentVersion: this.deps.version ?? APP_VERSION,
          fetch: this.deps.fetch,
          signal,
          publicKey: this.deps.publicKey,
        });
        if (signal.aborted || !this.host.enabled()) return;
        this.update = { version: manifest.version, url: manifest.url, mac: true };
        this.host.changed();
      } catch {
        // Fail closed until the next daily check.
      } finally {
        clearTimeout(timer);
      }
      return;
    }
    try {
      const response = await (this.deps.fetch ?? fetch)(
        `https://api.github.com/repos${new URL(GITHUB_REPO_URL).pathname}/releases/latest`,
        {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'PugPort' },
          signal,
          redirect: 'error',
        },
      );
      if (!response.ok) return;
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object' || !('tag_name' in body) || !('html_url' in body)) return;
      if (typeof body.tag_name !== 'string' || typeof body.html_url !== 'string') return;
      const version = body.tag_name.replace(/^v/, '');
      const next = semver(version);
      const current = semver(this.deps.version ?? APP_VERSION);
      if (!next || !current) return;
      const differing = next.findIndex((part, index) => part !== current[index]);
      if (differing < 0 || next[differing]! <= current[differing]!) return;
      const url = new URL(body.html_url);
      if (!url.href.startsWith(releases) || url.username || url.password || url.search || url.hash) return;
      if (signal.aborted || !this.host.enabled()) return;
      this.update = { version, url: url.href };
      this.host.changed();
    } catch {
      // Private repositories and offline machines wait until tomorrow too.
    } finally {
      clearTimeout(timer);
    }
  }
  close(): Promise<void> | undefined {
    this.abort?.abort();
    return this.running;
  }
}
