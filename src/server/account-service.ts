import { randomUUID } from 'node:crypto';
import { migrateLegacyCloud } from './account-sync-legacy.ts';
import { hostname } from 'node:os';
import { configuredSync, readSyncConfig, type SyncConfig, type SyncValue } from '../shared/account-sync.ts';
import type {
  AccountBackendMessage,
  AccountCounts,
  AccountMainMessage,
  AccountSession,
  AccountView,
} from '../shared/account-ui.ts';
import { readLocalSealKey } from './account-sync-crypto.ts';
import { PostgrestSyncRemote, type SyncRemote } from './account-sync-remote.ts';
import { secretsDirectory } from './api-providers.ts';
import { SyncStore } from './account-sync-store.ts';
import { SyncEngine } from './account-sync.ts';
import type { WorkspaceStore } from './workspace-store.ts';
import type { NativeAccountView } from '../shared/accounts.ts';
import type { RuntimeSnapshot } from '../shared/types.ts';

const providers = new Set(['codex', 'claude', 'grok', 'cursor']);
export function accountCliProviders(
  accounts: readonly Pick<
    NativeAccountView,
    'runtimeId' | 'provider' | 'enabled' | 'identityKnown' | 'status' | 'availability'
  >[],
  snapshots: readonly Pick<RuntimeSnapshot, 'id' | 'installed' | 'status'>[],
): string[] {
  const installed = new Set(
    snapshots
      .filter((snapshot) => snapshot.installed && snapshot.status !== 'missing' && snapshot.status !== 'auth-required')
      .map((snapshot) => snapshot.id),
  );
  return accounts
    .filter(
      (account) =>
        installed.has(account.runtimeId) &&
        account.enabled &&
        account.identityKnown &&
        account.status !== 'missing' &&
        account.status !== 'auth-required' &&
        account.availability?.reason !== 'authentication' &&
        providers.has(account.provider),
    )
    .map((account) => account.provider);
}
const emptyCounts = (): AccountCounts => ({ chats: 0, folders: 0, projects: 0, memories: 0 });
const countKind: Record<string, keyof AccountCounts> = {
  conversation: 'chats',
  'conversation-folder': 'folders',
  project: 'projects',
  memory: 'memories',
};
function errorCode(error: unknown) {
  return error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'SYNC_FAILED';
}

export type AccountServiceOptions = {
  files?: import('./account-sync-files.ts').AccountSyncFiles;
  workspace: WorkspaceStore;
  directory: string;
  desktop: boolean;
  config?: SyncConfig;
  send?: (message: AccountBackendMessage) => void;
  remote?: (session: AccountSession, token: () => string | undefined) => SyncRemote;
  providers?: () => string[];
  changed?: () => void;
  applied?: (settings: SyncValue) => void;
  /** Folder for the local seal key; defaults to the API key folder. */
  secretsDirectory?: string;
};
/** How long a computer without the old key waits before checking whether the cloud was upgraded. */
const upgradeCheckMs = 60000;

/** No files, timers, tables or network until a configured main-process session arrives. */
export class AccountService {
  private readonly config: SyncConfig;
  private readonly local: SyncStore;
  private state: AccountView;
  private session?: AccountSession;
  private remote?: SyncRemote;
  private engine?: SyncEngine;
  private generation?: string;
  private sealKey?: Buffer;
  /** Old end-to-end key handed over by Electron; only used for the one-time cloud upgrade. */
  private legacyKey?: { userId: string; key: Buffer; keyId: string };
  private epoch = 0;
  private active = true;
  private closed = false;
  private retry?: ReturnType<typeof setTimeout>;
  private deviceTimer?: ReturnType<typeof setTimeout>;
  private preparing?: Promise<void>;
  private draining: Promise<unknown> = Promise.resolve();
  private deleteRunning?: Promise<void>;
  private failures = 0;
  private busy = false;
  private deleting = false;
  /** This computer just emptied the cloud: the next first sync asks even with nothing local. */
  private cloudDeleted = false;
  private deviceId?: string;
  constructor(private readonly options: AccountServiceOptions) {
    this.config = options.config ?? readSyncConfig();
    this.local = new SyncStore(options.workspace, options.directory);
    if (options.desktop) {
      this.local.deactivate();
      this.draining = this.local.cleanupBackups().catch(() => {});
    }
    this.state = {
      configured: configuredSync(this.config) && options.desktop,
      auth: { phase: 'signed-out' },
      sync: 'off',
      devices: [],
      missingProviders: [],
      setup: 'none',
    };
  }
  view(): AccountView {
    return structuredClone(this.state);
  }
  problemReportSession() {
    return (
      this.session && {
        userId: this.session.userId,
        accessToken: this.session.accessToken,
        sessionId: this.state.sessionId,
      }
    );
  }
  async refreshServerEnrollments(): Promise<boolean> {
    if (this.state.auth.phase === 'signed-out') return true;
    if (!this.engine || !this.state.firstPullComplete || this.state.setup !== 'ready') return false;
    const engine = this.engine;
    await engine.syncNow();
    return this.engine === engine && engine.status === 'idle';
  }
  setSyncFiles(files: NonNullable<AccountServiceOptions['files']>) {
    this.options.files = files;
  }
  assertSession(sessionId: unknown) {
    if (!this.session || typeof sessionId !== 'string' || sessionId !== this.state.sessionId)
      throw Error('ACCOUNT_SESSION_CHANGED');
  }
  private changed() {
    this.options.changed?.();
  }
  private send(message: AccountBackendMessage) {
    this.options.send?.(message);
  }
  action(action: 'sign-in' | 'cancel' | 'sign-out') {
    if (!this.state.configured) throw Error('NOT_CONFIGURED');
    if (action === 'sign-out') this.clear();
    this.send({ type: 'account-action', action });
    return this.view();
  }
  private assertCurrent(epoch: number) {
    if (epoch !== this.epoch || !this.session) throw Error('SIGNED_OUT');
  }
  private async operation<T>(fn: (epoch: number) => Promise<T>): Promise<T> {
    if (!this.session || !this.remote) throw Error('SIGNED_OUT');
    if (this.busy || this.preparing || this.deleting) throw Error('ACCOUNT_BUSY');
    this.busy = true;
    const epoch = this.epoch;
    try {
      this.state.error = undefined;
      return await fn(epoch);
    } catch (error) {
      if (epoch === this.epoch) {
        this.state.error = errorCode(error);
        if (!this.deleting && this.generation && ['OFFLINE', 'AUTH_REQUIRED'].includes(errorCode(error)))
          this.retryPreparation(epoch, error);
        this.changed();
      }
      throw Error(errorCode(error));
    } finally {
      if (epoch === this.epoch) this.busy = false;
    }
  }
  async handleMainMessage(message: AccountMainMessage): Promise<void> {
    if (!this.state.configured) return;
    if (message.type === 'account-active') {
      this.active = message.active;
      this.engine?.setActive(message.active);
      return;
    }
    if (message.type === 'account-auth') {
      this.state.auth = {
        phase: message.auth.phase,
        email: message.auth.email,
        memoryOnly: message.auth.memoryOnly,
        error: message.auth.error,
      };
      this.changed();
      return;
    }
    if (message.type === 'account-clear') {
      this.clear();
      return;
    }
    if (message.type === 'account-key') {
      const key = Buffer.from(message.key, 'base64');
      if (key.length !== 32 || !message.keyId) return;
      this.legacyKey?.key.fill(0);
      this.legacyKey = { userId: message.userId, key, keyId: message.keyId };
      if (this.session?.userId === message.userId && this.state.setup === 'waiting-upgrade' && !this.preparing)
        await this.prepare(this.epoch);
      return;
    }
    if (message.type !== 'account-session') return;
    const next = message.session;
    if (!next.userId || !next.accessToken || !Number.isFinite(next.expiresAt)) return;
    if (this.session?.userId === next.userId) {
      this.session = { ...next };
      return;
    }
    this.clear(false);
    const epoch = this.epoch;
    this.session = { ...next };
    this.state.sessionId = randomUUID();
    this.state.auth = { ...this.state.auth, phase: 'signed-in', email: next.email, error: undefined };
    this.remote =
      this.options.remote?.(next, () => this.session?.accessToken) ??
      new PostgrestSyncRemote(this.config, next.userId, () => this.session?.accessToken);
    this.state.setup = 'loading';
    this.changed();
    await this.draining;
    if (epoch === this.epoch) await this.prepare(epoch);
  }
  private clear(clearKeys = true) {
    ++this.epoch;
    if (this.retry) clearTimeout(this.retry);
    if (this.deviceTimer) clearTimeout(this.deviceTimer);
    this.deviceTimer = undefined;
    this.preparing = undefined;
    this.retry = undefined;
    this.failures = 0;
    this.busy = false;
    this.deleting = false;
    this.cloudDeleted = false;
    this.engine?.stop();
    this.draining = Promise.all([this.draining, this.engine?.drain(), this.deleteRunning?.catch(() => {})]).then(
      async () => {
        if (!this.closed) await this.local.cleanupBackups().catch(() => {});
      },
    );
    this.engine = undefined;
    this.session = undefined;
    this.remote = undefined;
    this.generation = undefined;
    // Electron hands the key over right before a new session, so a session switch keeps it.
    if (clearKeys) {
      this.legacyKey?.key.fill(0);
      this.legacyKey = undefined;
    }
    this.state = {
      configured: this.state.configured,
      auth: { phase: 'signed-out', memoryOnly: this.state.auth.memoryOnly },
      sync: 'off',
      setup: 'none',
      devices: [],
      missingProviders: [],
    };
    this.changed();
  }
  private prepare(epoch: number): Promise<void> {
    if (epoch !== this.epoch || !this.session || this.deleting) return Promise.resolve();
    if (this.busy) {
      this.retry = setTimeout(() => {
        this.retry = undefined;
        void this.prepare(epoch);
      }, 1000);
      this.retry.unref();
      return Promise.resolve();
    }
    if (this.preparing) return this.preparing;
    const work = this.prepareSession(epoch).finally(() => {
      if (this.preparing === work) this.preparing = undefined;
    });
    this.preparing = work;
    return work;
  }
  private retryPreparation(epoch: number, error: unknown) {
    if (epoch !== this.epoch) return;
    const code = errorCode(error);
    this.state.sync = code === 'OFFLINE' ? 'offline' : `error: ${code}`;
    this.state.setup = 'loading';
    if (code === 'AUTH_REQUIRED') this.send({ type: 'account-action', action: 'refresh' });
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(
      () => {
        this.retry = undefined;
        void this.prepare(epoch);
      },
      Math.min(300000, 1000 * 2 ** Math.min(this.failures++, 9)),
    );
    this.retry.unref();
    this.changed();
  }
  private async prepareSession(epoch: number) {
    try {
      const userId = this.session!.userId;
      if (this.options.workspace.get('account-cloud-delete', userId)) {
        this.deleting = true;
        this.state.setup = 'loading';
        await this.deleteAttempt(epoch);
        return;
      }
      const cloud = await this.remote!.account();
      this.assertCurrent(epoch);
      this.state.sync = 'off';
      this.state.error = undefined;
      const legacy = this.legacyKey;
      if (legacy?.userId === userId && legacy.keyId === cloud.legacyKeyId) {
        this.state.setup = 'upgrading';
        this.changed();
        this.deviceId ??= this.options.workspace.get<{ id: string }>('account-device', 'local')?.id ?? randomUUID();
        this.options.workspace.save('account-device', 'local', '', { id: this.deviceId });
        // A retained key also retries an interrupted drain after the cloud mark.
        try {
          await migrateLegacyCloud({
            remote: this.remote!,
            key: legacy.key,
            generation: cloud.generation,
            deviceId: this.deviceId,
            isCurrent: () => epoch === this.epoch && !!this.session,
          });
        } catch (error) {
          this.assertCurrent(epoch);
          if (cloud.legacyPending || errorCode(error) === 'CLOUD_DATA_RESET') throw error;
          console.warn('[account-sync] Legacy retry failed after upgrade:', errorCode(error));
        }
        this.assertCurrent(epoch);
      } else if (cloud.legacyPending) {
        // The old encrypted copy is upgraded once by a computer that still holds its key.
        this.state.setup = 'waiting-upgrade';
        if (this.retry) clearTimeout(this.retry);
        this.retry = setTimeout(() => {
          this.retry = undefined;
          void this.prepare(epoch);
        }, upgradeCheckMs);
        this.retry.unref();
        this.changed();
        return;
      }
      if (this.legacyKey) this.forgetLegacyKey(this.legacyKey.userId);
      this.failures = 0;
      const known = this.options.workspace.get<{ generation: string }>('account-sync-cloud', userId);
      // A new generation means the cloud was deleted on some computer: start over, and ask before uploading.
      const reset = !!known && known.generation !== cloud.generation;
      if (reset && this.local.state()?.account === userId) this.local.resetAfterCloudDeletion();
      // A legacy cursor may be ahead of plain rows imported by another computer. Keep the merge base.
      if (!known && this.local.state()?.account === userId) this.local.cursor = 0;
      this.generation = cloud.generation;
      if (!reset && this.local.state()?.account === userId) await this.enable(epoch, false);
      else await this.showMerge(epoch, reset || this.cloudDeleted);
      this.changed();
    } catch (error) {
      if (epoch !== this.epoch) return;
      if (this.deleting) return; // The confirmed deletion owns its retry until acknowledged.
      this.retryPreparation(epoch, error);
    }
  }
  private forgetLegacyKey(userId: string) {
    this.legacyKey?.key.fill(0);
    this.legacyKey = undefined;
    this.send({ type: 'account-persist-key', userId });
  }
  /**
   * Asks only when the first sync would mix this computer's data into the cloud, the computer last synced to another
   * account, or the cloud was just deleted. Otherwise the first sync starts on its own (backup first, as confirmed).
   */
  private async showMerge(epoch: number, afterDeletion: boolean) {
    const accountChange = !!this.local.state()?.account && this.local.state()?.account !== this.session!.userId;
    if (!afterDeletion && !accountChange && !(await this.hasLocalData(epoch))) {
      try {
        await this.enable(epoch, false);
      } catch (error) {
        if (epoch === this.epoch) this.state.error = errorCode(error);
        throw error;
      }
      return;
    }
    const local = this.local.counts(),
      cloud = emptyCounts();
    await Promise.all(
      Object.entries(countKind).map(async ([kind, field]) => {
        cloud[field] = await this.remote!.count(kind);
        this.assertCurrent(epoch);
      }),
    );
    this.state.merge = { local, cloud, accountChange };
    this.state.setup = 'merge';
    this.changed();
  }
  private async hasLocalData(epoch: number) {
    if (this.local.hasLocalRecords()) return true;
    // A file that cannot be read counts as data: the owner decides.
    const files = await this.options.files?.hasLocalEntries().catch(() => true);
    this.assertCurrent(epoch);
    return !!files;
  }
  async merge(confirmed: boolean, allowAccountChange: boolean) {
    return this.operation(async (epoch) => {
      if (!confirmed) throw Error('MERGE_CONFIRMATION_REQUIRED');
      if (this.state.setup !== 'merge' || !this.state.merge) throw Error('MERGE_NOT_READY');
      if (this.state.merge.accountChange && !allowAccountChange) throw Error('ACCOUNT_CHANGE_REQUIRES_CONSENT');
      await this.enable(epoch, allowAccountChange);
      return this.view();
    });
  }
  private async enable(epoch: number, allowAccountChange: boolean) {
    this.assertCurrent(epoch);
    const workspace = this.options.workspace;
    this.deviceId ??= workspace.get<{ id: string }>('account-device', 'local')?.id ?? randomUUID();
    if (!workspace.get('account-device', 'local')) workspace.save('account-device', 'local', '', { id: this.deviceId });
    this.state.deviceName = hostname();
    this.sealKey ??= await readLocalSealKey(this.options.secretsDirectory ?? secretsDirectory());
    this.assertCurrent(epoch);
    const generation = this.generation;
    if (!generation) throw Error('GENERATION_REQUIRED');
    const engine = new SyncEngine({
      files: this.options.files,
      local: this.local,
      remote: this.remote!,
      deviceId: this.deviceId,
      config: this.config,
      sealKey: this.sealKey,
      onFirstPull: () => {
        if (epoch !== this.epoch) return;
        this.state.firstPullComplete = true;
        this.changed();
      },
      onReset: () => {
        if (epoch !== this.epoch) return;
        this.generation = undefined;
        this.state.setup = 'loading';
        this.state.firstPullComplete = false;
        if (this.deviceTimer) clearTimeout(this.deviceTimer);
        this.deviceTimer = undefined;
        this.changed();
        void engine.drain().then(() => {
          if (epoch === this.epoch) return this.prepare(epoch);
        });
      },
      onStatus: (status) => {
        if (epoch !== this.epoch) return;
        if (status === 'idle' && this.state.sync === 'syncing') this.state.lastSyncedAt = new Date().toISOString();
        this.state.sync = status;
        if (status === 'error: AUTH_REQUIRED') this.send({ type: 'account-action', action: 'refresh' });
        this.changed();
      },
      onApplied: () => {
        if (epoch !== this.epoch) return;
        workspace.invalidateRevision();
        this.options.applied?.(this.local.settings());
        this.changed();
      },
    });
    this.engine = engine;
    await engine.enable({ userId: this.session!.userId, generation, allowAccountChange });
    this.assertCurrent(epoch);
    if (engine.status.startsWith('error')) throw Error(engine.status.slice(7));
    workspace.save('account-sync-cloud', this.session!.userId, '', { generation });
    engine.setActive(this.active);
    this.state.setup = 'ready';
    this.state.merge = undefined;
    this.cloudDeleted = false;
    await this.refreshDevices(epoch);
    this.changed();
  }
  private async refreshDevices(epoch: number) {
    try {
      const installed = (this.options.providers?.() ?? []).filter((p) => providers.has(p));
      await this.engine!.upsertDevice({ name: hostname(), platform: process.platform, cli_providers: installed });
      this.assertCurrent(epoch);
      const devices = await this.remote!.listDevices();
      this.assertCurrent(epoch);
      this.state.error = undefined;
      this.state.devices = devices.map((device) => ({
        id: device.id,
        name: device.name,
        platform: device.platform,
        last_seen_at: device.last_seen_at,
        cli_providers: device.cli_providers.filter((p) => providers.has(p)),
      }));
      this.state.missingProviders = [
        ...new Set(this.state.devices.filter((d) => d.id !== this.deviceId).flatMap((d) => d.cli_providers)),
      ].filter((p) => !installed.includes(p));
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.state.error = errorCode(error);
    } finally {
      if (epoch === this.epoch && this.state.setup === 'ready' && !this.deleting) {
        this.changed();
        this.deviceTimer = setTimeout(() => {
          void this.refreshDevices(epoch);
        }, 60000);
        this.deviceTimer.unref();
      }
    }
  }
  async deleteCloud(confirmed: boolean) {
    return this.operation(async (epoch) => {
      if (!confirmed) throw Error('DELETE_CONFIRMATION_REQUIRED');
      this.deleting = true;
      this.state.setup = 'loading';
      this.failures = 0;
      if (this.retry) clearTimeout(this.retry);
      this.retry = undefined;
      const engine = this.engine;
      if (this.deviceTimer) clearTimeout(this.deviceTimer);
      this.deviceTimer = undefined;
      engine?.stop();
      await engine?.drain();
      this.assertCurrent(epoch);
      this.options.workspace.save('account-cloud-delete', this.session!.userId, '', { pending: true });
      await this.deleteAttempt(epoch);
      return this.view();
    });
  }
  private deleteAttempt(epoch: number): Promise<void> {
    const running = this.performDelete(epoch).finally(() => {
      if (this.deleteRunning === running) this.deleteRunning = undefined;
    });
    this.deleteRunning = running;
    return running;
  }
  private async performDelete(epoch: number): Promise<void> {
    try {
      this.assertCurrent(epoch);
      await this.remote!.deleteMyCloudData();
      this.assertCurrent(epoch);
      if (this.local.state()?.account === this.session!.userId) this.local.resetAfterCloudDeletion();
      this.options.workspace.deleteRecord('account-cloud-delete', this.session!.userId);
      this.generation = undefined;
      this.engine = undefined;
      this.state.setup = 'loading';
      this.state.merge = undefined;
      this.state.devices = [];
      this.state.missingProviders = [];
      this.state.sync = 'off';
      this.state.error = undefined;
      this.deleting = false;
      this.cloudDeleted = true;
      this.changed();
      // Start over like a new computer, except that the new generation always stops at the merge confirmation.
      this.retry = setTimeout(() => {
        this.retry = undefined;
        void this.prepare(epoch);
      }, 0);
      this.retry.unref();
    } catch (error) {
      if (epoch !== this.epoch) return;
      const code = errorCode(error);
      this.state.sync = code === 'OFFLINE' ? 'offline' : `error: ${code}`;
      this.state.error = code;
      if (code === 'AUTH_REQUIRED') this.send({ type: 'account-action', action: 'refresh' });
      // The RPC is idempotent. Retry the confirmed deletion, never upload after an uncertain response.
      this.retry = setTimeout(
        () => {
          this.retry = undefined;
          void this.deleteAttempt(epoch).catch(() => {});
        },
        Math.min(300000, 1000 * 2 ** Math.min(this.failures++, 9)),
      );
      this.retry.unref();
      this.changed();
      throw Error(code);
    }
  }
  async close() {
    this.closed = true;
    this.clear();
    await this.draining;
    this.local.dispose();
    this.sealKey?.fill(0);
    this.sealKey = undefined;
  }
}
