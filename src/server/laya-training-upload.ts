import { randomBytes, randomUUID } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { configuredSync, readSyncConfig, type SyncConfig } from '../shared/account-sync.ts';
import { layaSharesTraining, type LayaReviewRecord, type LayaSettings } from '../shared/laya.ts';
import { sanitizeLayaReviewValue } from './laya-review-store.ts';
import { restrictFile } from './platform/secure-file.ts';
import { sanitizeLayaCloudValue } from './laya-cloud-privacy.ts';
import { underTest } from './platform/under-test.ts';
import { trustedDirectory } from './platform/trusted-path.ts';

type Pending = { record: LayaReviewRecord; attempts: number; nextAttempt: number };
type UploadState = {
  version: 1;
  identity: { installId: string; token: string; attempted: boolean };
  deleting: boolean;
  deletedBefore: number;
  consentAfter: number;
  pending: Pending[];
};
export type LayaTrainingUploadOptions = {
  dataDir: string;
  appVersion: string;
  settings: () => LayaSettings | undefined;
  region: () => 'eu' | 'other' | undefined;
  consentAfter?: () => number;
  eligible: (record: LayaReviewRecord) => boolean;
  config?: SyncConfig;
  fetch?: typeof fetch;
  now?: () => number;
};
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const terminal = new Set(['completed', 'failed', 'cancelled']);
const maxQueue = 500;
const maxStateBytes = 40 * 1024 * 1024;
const batchSize = 10;
const identity = () => ({ installId: randomUUID(), token: randomBytes(32).toString('base64url'), attempted: false });

/** Anonymous contributions are local-only state, separate from account synchronization. */
export class LayaTrainingUpload {
  private readonly path: string;
  private readonly config: SyncConfig;
  private readonly testTransportMissing: boolean;
  private state?: UploadState;
  private work: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private started = false;
  private deleting = false;
  private epoch = 0;
  private flushing?: Promise<void>;
  private deletion?: Promise<number>;
  constructor(private readonly options: LayaTrainingUploadOptions) {
    // Links above the data folder belong to the system (macOS /var); the folder itself must still not be a link.
    this.path = join(trustedDirectory(options.dataDir), 'laya-training-upload.json');
    this.config = options.config ?? readSyncConfig();
    this.testTransportMissing =
      underTest() && !options.fetch && !options.config?.url && !process.env.PUGPORT_SUPABASE_URL;
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.work.catch(() => {}).then(action);
    this.work = next;
    return next;
  }
  private allowed(record: LayaReviewRecord): boolean {
    return (
      this.options.settings()?.recordTraining !== false &&
      layaSharesTraining(this.options.settings(), this.options.region()) &&
      Date.parse(record.createdAt) >
        Math.max(this.state?.deletedBefore ?? 0, this.state?.consentAfter ?? 0, this.options.consentAfter?.() ?? 0) &&
      this.options.eligible(record)
    );
  }
  private async directory(path = dirname(this.path)): Promise<void> {
    const parent = dirname(path);
    if (parent !== path) await this.directory(parent);
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (!missing(error)) throw error;
      await mkdir(path, { mode: 0o700 }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
      info = await lstat(path);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe Laya upload directory.');
  }
  private async load(): Promise<UploadState> {
    if (this.state) {
      this.state.consentAfter = Math.max(this.state.consentAfter, this.options.consentAfter?.() ?? 0);
      return this.state;
    }
    await this.directory();
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maxStateBytes)
        throw new Error('Unsafe Laya upload state.');
      const handle = await open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let state: UploadState;
      try {
        const current = await handle.stat();
        if (current.ino !== info.ino || current.size > maxStateBytes) throw new Error('Laya upload state changed.');
        state = JSON.parse(await handle.readFile('utf8')) as UploadState;
      } finally {
        await handle.close();
      }
      state.consentAfter = Math.max(state.consentAfter ?? 0, this.options.consentAfter?.() ?? 0);
      if (
        state.version !== 1 ||
        !uuid.test(state.identity?.installId ?? '') ||
        !/^[\w-]{43}$/.test(state.identity?.token ?? '') ||
        typeof state.identity.attempted !== 'boolean' ||
        typeof state.deleting !== 'boolean' ||
        !Number.isFinite(state.deletedBefore) ||
        !Number.isFinite(state.consentAfter) ||
        !Array.isArray(state.pending) ||
        state.pending.length > maxQueue ||
        state.pending.some(
          (item) =>
            !item.record?.id ||
            !item.record.projectId ||
            !item.record.conversationId ||
            !terminal.has(item.record.outcome?.status ?? '') ||
            !Number.isSafeInteger(item.attempts) ||
            item.attempts < 0 ||
            !Number.isFinite(item.nextAttempt),
        )
      )
        throw new Error('Invalid Laya upload state.');
      // A crash may have interrupted a batch after dispatch but before its single queue commit.
      if (state.pending.length) state.identity.attempted = true;
      this.state = state;
    } catch (error) {
      if (!missing(error)) throw error;
      this.state = {
        version: 1,
        identity: identity(),
        deleting: false,
        deletedBefore: 0,
        consentAfter: this.options.consentAfter?.() ?? 0,
        pending: [],
      };
    }
    return this.state;
  }
  private async save(): Promise<void> {
    if (this.state) this.state.consentAfter = Math.max(this.state.consentAfter, this.options.consentAfter?.() ?? 0);
    await this.directory();
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Unsafe Laya upload state.');
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const json = JSON.stringify(this.state);
    if (Buffer.byteLength(json) > maxStateBytes) throw new Error('Laya upload queue is full.');
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await restrictFile(temporary, { handle });
        await handle.writeFile(json);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
    } finally {
      await unlink(temporary).catch((error) => {
        if (!missing(error)) throw error;
      });
    }
  }
  start(): void {
    if (this.testTransportMissing) return;
    this.started = true;
    this.schedule();
  }
  async stop(): Promise<void> {
    this.started = false;
    ++this.epoch;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.work.catch(() => {});
  }
  private schedule(): void {
    if (!this.started || this.timer || this.deleting) return;
    if (this.state ? !this.state.pending.length : !existsSync(this.path)) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush()
        .catch(() => {})
        .finally(() => this.schedule());
    }, 30_000);
    this.timer.unref();
  }

  enqueue(record: LayaReviewRecord): Promise<void> {
    const epoch = this.epoch;
    if (this.deleting || !terminal.has(record.outcome?.status ?? '') || !this.allowed(record)) return Promise.resolve();
    const safe = sanitizeLayaReviewValue(sanitizeLayaCloudValue(record), 24_000, false).value;
    Object.assign(safe, { id: record.id, projectId: record.projectId, conversationId: record.conversationId });
    safe.outcome!.status = record.outcome!.status;
    safe.inference.modelVersion = record.inference.modelVersion;
    return this.serial(async () => {
      if (epoch !== this.epoch || this.deleting || !this.allowed(record)) return;
      const state = await this.load();
      if (
        state.deleting ||
        !Number.isFinite(Date.parse(record.createdAt)) ||
        Date.parse(record.createdAt) <=
          Math.max(state.deletedBefore, state.consentAfter, this.options.consentAfter?.() ?? 0) ||
        state.pending.some((item) => item.record.id === record.id)
      )
        return;
      if (state.pending.length >= maxQueue) throw new Error('Laya upload queue is full.');
      const item = { record: safe, attempts: 0, nextAttempt: 0 };
      state.pending.push(item);
      try {
        await this.save();
      } catch (error) {
        // Never dispatch an entry whose deletion credentials were not durably saved.
        state.pending = state.pending.filter((entry) => entry !== item);
        throw error;
      }
      this.schedule();
    });
  }

  /** Disabling sharing drops old queued work even if it is enabled again before the next batch. */
  settingsChanged(): Promise<void> {
    ++this.epoch;
    const consentAfter = this.options.now?.() ?? Date.now();
    const discardAll =
      this.options.settings()?.recordTraining === false ||
      !layaSharesTraining(this.options.settings(), this.options.region());
    return this.serial(async () => {
      const state = await this.load();
      state.consentAfter = Math.max(state.consentAfter, consentAfter);
      state.pending = discardAll ? [] : state.pending.filter((item) => this.allowed(item.record));
      await this.save();
    });
  }

  private sample(record: LayaReviewRecord): unknown {
    const sample = sanitizeLayaReviewValue(
      sanitizeLayaCloudValue({
        createdAt: record.createdAt,
        origin: record.origin,
        question: record.question,
        state: {
          message: record.state.message,
          recent_context: record.state.recent_context,
          reference_text: record.state.reference_text,
          candidate_executors: record.state.candidate_executors,
          attachments: record.state.attachments.map(({ kind, name, mime_type }) => ({ kind, name, mime_type })),
        },
        inference: record.inference,
        policy: record.policy,
        outcome: record.outcome && {
          status: record.outcome.status,
          assessment: record.outcome.assessment && {
            status: record.outcome.assessment.status,
            suggestedTier: record.outcome.assessment.suggestedTier,
            suggestedEffort: record.outcome.assessment.suggestedEffort,
            reason: record.outcome.assessment.reason,
          },
          routes: record.outcome.routes.map(({ runId, stepId, ...route }) => route),
        },
      }),
      12_000,
      false,
    ).value;
    // Pretty JSON leaves room for PostgreSQL jsonb's whitespace and UTF-8 expansion.
    if (Buffer.byteLength(JSON.stringify(sample, null, 1)) > 60 * 1024) return undefined;
    return sample;
  }
  private async rpc(name: string, body: object): Promise<unknown> {
    if (this.testTransportMissing) throw new Error('Laya training tests require an explicit transport.');
    if (!configuredSync(this.config)) throw new Error('Laya training service is not configured.');
    const response = await (this.options.fetch ?? fetch)(`${this.config.url.replace(/\/$/, '')}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: this.config.publishableKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Laya training request failed (${response.status}).`);
    }
    return response.json();
  }
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    const epoch = this.epoch;
    const work = this.serial(async () => {
      const state = await this.load();
      if (this.deleting || state.deleting) return;
      const pending = state.pending.filter((item) => this.allowed(item.record));
      let dirty = pending.length !== state.pending.length;
      state.pending = pending;
      const now = this.options.now?.() ?? Date.now();
      const batch = state.pending.filter((item) => item.nextAttempt <= now).slice(0, batchSize);
      try {
        for (const item of batch) {
          if (epoch !== this.epoch || this.deleting || !this.allowed(item.record)) break;
          const sample = this.sample(item.record);
          if (sample === undefined) {
            state.pending = state.pending.filter((entry) => entry !== item);
            dirty = true;
            continue;
          }
          if (epoch !== this.epoch || this.deleting || !this.allowed(item.record)) break;
          state.identity.attempted = true;
          dirty = true;
          try {
            const result = await this.rpc('submit_laya_sample', {
              install_id: state.identity.installId,
              token: state.identity.token,
              model_version: item.record.inference.modelVersion,
              app_version: this.options.appVersion,
              sample,
            });
            if (typeof result !== 'string' || !uuid.test(result)) throw new Error('Invalid Laya upload response.');
            state.pending = state.pending.filter((entry) => entry !== item);
          } catch {
            item.attempts++;
            item.nextAttempt = now + Math.min(24 * 60 * 60_000, 30_000 * 2 ** Math.min(item.attempts, 12));
            break;
          }
        }
      } finally {
        if (dirty) await this.save();
      }
    });
    this.flushing = work;
    void work
      .finally(() => {
        if (this.flushing === work) this.flushing = undefined;
      })
      .catch(() => {});
    return work;
  }

  deleteSamples(): Promise<number> {
    if (this.deletion) return this.deletion;
    this.deleting = true;
    const deletedBefore = this.options.now?.() ?? Date.now();
    ++this.epoch;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const work = this.serial(async () => {
      const state = await this.load();
      state.pending = [];
      state.deleting = true;
      state.deletedBefore = Math.max(state.deletedBefore, deletedBefore);
      await this.save();
      const count = state.identity.attempted
        ? await this.rpc('delete_laya_samples', { install_id: state.identity.installId, token: state.identity.token })
        : 0;
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
        throw new Error('Invalid Laya deletion response.');
      this.state = {
        version: 1,
        identity: identity(),
        deleting: false,
        deletedBefore: state.deletedBefore,
        consentAfter: state.consentAfter,
        pending: [],
      };
      try {
        await this.save();
      } catch (error) {
        this.state = state;
        throw error;
      }
      return count;
    });
    this.deletion = work;
    void work
      .finally(() => {
        if (this.deletion === work) this.deletion = undefined;
        this.deleting = false;
        this.schedule();
      })
      .catch(() => {});
    return work;
  }
}
