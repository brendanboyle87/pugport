import { createHash } from 'node:crypto';
import {
  configuredSync,
  filterSyncValue,
  readSyncConfig,
  stableJson,
  syncKinds,
  type SyncConfig,
  type SyncPayload,
  type SyncStatus,
  type SyncValue,
} from '../shared/account-sync.ts';
import { conversationFolderNameKey } from '../shared/conversation-folders.ts';
import { messageProvenanceHash } from './account-sync-crypto.ts';
import { type SyncRemote, type SyncDevice, type RemoteRecord } from './account-sync-remote.ts';
import { type SyncStore, type LocalChange } from './account-sync-store.ts';
import type { AccountSyncFiles } from './account-sync-files.ts';
import { deviceSchema } from './devices/store.ts';
import { serverSchema } from './remote-servers.ts';
import { apiProviderIdentity, validateApiProviderValue } from './account-sync-api.ts';

export type SyncEngineOptions = {
  local: SyncStore;
  remote: SyncRemote;
  deviceId: string;
  config?: SyncConfig;
  onStatus?: (status: SyncStatus) => void;
  onApplied?: () => void;
  onReset?: () => void;
  onFirstPull?: () => void;
  isStreaming?: (message: SyncValue) => boolean;
  /** Per-computer key for the local server-node/API-card mirror rows; never uploaded. */
  sealKey?: Uint8Array;
  files?: AccountSyncFiles;
};
type EngineSession = { userId: string; generation: string; allowAccountChange?: boolean };
const equal = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);
const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 24);
const extensionKinds = ['remote-server', 'server-node', 'api-provider'];
const knownKind = (kind: string) => ([...syncKinds, 'settings'] as readonly string[]).includes(kind);
function unionMemory(a: unknown, b: unknown): string {
  const first = typeof a === 'string' ? a : '',
    second = typeof b === 'string' ? b : '';
  if (!first || second.includes(first)) return second;
  if (!second || first.includes(second)) return first;
  return `${first}\n\n${second}`;
}
const activeWorkflow = new Set([
  'queued',
  'waiting-resource',
  'planning',
  'running',
  'waiting-approval',
  'waiting-confirmation',
]);

/** No constructor side effects. The account service supplies a session once the cloud generation is known. */
export class SyncEngine {
  private deferredKinds = new Map<string, number>();
  status: SyncStatus = 'off';
  private session?: { userId: string; generation: string };
  private epoch = 0;
  private running?: Promise<void>;
  private enabling?: Promise<void>;
  private deviceWrite?: Promise<void>;
  private deleting = false;
  private timer?: ReturnType<typeof setInterval>;
  private nextAttempt = 0;
  private failures = 0;
  private observedGeneration = 0;
  private quietUntil = 0;
  private nextPull = 0;
  private active = true;
  private firstPullComplete = false;
  private readonly config: SyncConfig;
  private get local() {
    return this.options.local;
  }
  private get remote() {
    return this.options.remote;
  }
  constructor(private readonly options: SyncEngineOptions) {
    this.config = options.config ?? readSyncConfig();
  }
  private setStatus(status: SyncStatus) {
    this.status = status;
    // A status observer must never turn a successful data commit into a retry.
    try {
      this.options.onStatus?.(status);
    } catch {
      /* UI observers are outside the sync transaction. */
    }
  }
  enable(session: EngineSession): Promise<void> {
    const work = this.enableSession(session);
    this.enabling = work;
    return work.finally(() => {
      if (this.enabling === work) this.enabling = undefined;
    });
  }
  private async enableSession(session: EngineSession): Promise<void> {
    if (this.deleting) {
      this.setStatus('error: CLOUD_DELETE_IN_PROGRESS');
      return;
    }
    this.stop();
    if (!session.userId || !configuredSync(this.config)) return;
    const epoch = this.epoch;
    try {
      const prior = this.local.state();
      if (prior?.account && prior.account !== session.userId && !session.allowAccountChange)
        throw Error('ACCOUNT_CHANGE_REQUIRES_CONSENT');
      if (this.remote.userId !== session.userId) throw Error('ACCOUNT_MISMATCH');
      if (!session.generation) throw Error('GENERATION_REQUIRED');
      if (this.options.sealKey && this.options.sealKey.length !== 32) throw Error('INVALID_SEAL_KEY');
      this.local.setSealKey(this.options.sealKey);
      await this.local.activate(session.userId, session.allowAccountChange);
      if (epoch !== this.epoch) {
        this.local.deactivate();
        return;
      }
      this.session = { userId: session.userId, generation: session.generation };
      this.firstPullComplete = false;
      this.failures = 0;
      this.nextAttempt = 0;
      this.nextPull = 0;
      this.quietUntil = Date.now() + 3000;
      this.setStatus('idle');
      this.timer = setInterval(() => this.tick(), 250);
      this.timer.unref();
    } catch (error) {
      this.setStatus(`error: ${this.code(error)}`);
    }
  }
  stop() {
    this.deferredKinds.clear();
    ++this.epoch;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const wasActive = !!this.session;
    this.session = undefined;
    if (wasActive) this.local.deactivate();
    this.local.dispose();
    this.local.setSealKey();
    this.setStatus('off');
  }
  async drain() {
    await Promise.all([this.enabling, this.running, this.deviceWrite]);
  }
  /** Foreground activation can pull now; idle windows poll less often. */
  setActive(active: boolean) {
    this.active = active;
    if (active) this.nextPull = 0;
  }
  private tick() {
    if (!this.session || this.running) return;
    try {
      const { pending, generation } = this.local.activity();
      const now = Date.now();
      if (generation !== this.observedGeneration) {
        this.observedGeneration = generation;
        this.quietUntil = now + 3000;
      }
      if (now < this.nextAttempt) return;
      const eligible =
        pending && now >= this.quietUntil && this.local.pending(1, (change) => this.uploadable(change)).length;
      if (pending && now >= this.quietUntil && !eligible) this.quietUntil = now + 60000;
      if (eligible || now >= this.nextPull) void this.syncNow(!!eligible || now >= this.quietUntil);
    } catch (error) {
      this.failed(error);
    }
  }
  /** Serialized, failure-contained flush; useful for focus events and deterministic host tests. */
  async syncNow(push = true): Promise<void> {
    if (!this.session) return;
    if (this.running) return this.running;
    const epoch = this.epoch;
    this.running = this.cycle(epoch, push).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private current(epoch: number) {
    return !!this.session && epoch === this.epoch;
  }
  private code(error: unknown) {
    const code = error instanceof Error ? error.message : '';
    return /^[A-Z][A-Z0-9_]+$/.test(code) ? code : 'SYNC_FAILED';
  }
  private failed(error: unknown) {
    const code = this.code(error);
    this.nextAttempt = Date.now() + Math.min(300000, 1000 * 2 ** Math.min(this.failures++, 9));
    this.nextPull = this.nextAttempt;
    this.setStatus(code === 'OFFLINE' ? 'offline' : `error: ${code}`);
  }
  private uploadable(change: LocalChange) {
    return (this.deferredKinds.get(change.kind) ?? 0) <= Date.now() && !this.streaming(change);
  }
  private async cycle(epoch: number, push: boolean) {
    this.setStatus('syncing');
    try {
      let uploadFailure: string | undefined;
      await this.options.files?.capture(this.local, this.session!.userId);
      if (!this.current(epoch)) return;
      // The first pull discovers identities before any existing local projects/folders are uploaded.
      if (!this.firstPullComplete) await this.pull(epoch);
      if (!this.current(epoch)) return;
      if (push) {
        // Unsupported new kinds cannot roll back an ordinary upload or monopolize its first 100 rows.
        for (const kind of ['legacy', ...extensionKinds]) {
          const batch = this.local.pending(
            100,
            (change) =>
              this.uploadable(change) &&
              (kind === 'legacy' ? !extensionKinds.includes(change.kind) : change.kind === kind),
          );
          const changes = batch.map((change) => ({
            kind: change.kind,
            id: change.id,
            last_seq: this.local.base(change.kind, change.id)?.seq ?? 0,
            body: this.payload(change),
            deleted: change.deleted,
            device_id: this.options.deviceId,
          }));
          if (changes.length) {
            let results;
            try {
              results = await this.remote.push(this.session!.generation, changes);
            } catch (error) {
              if (!this.current(epoch)) return;
              if (kind !== 'legacy' && this.code(error) === 'UNSUPPORTED_KIND') {
                this.deferredKinds.set(kind, Date.now() + 300000);
                continue;
              }
              throw error;
            }
            if (!this.current(epoch)) return;
            if (results.length !== batch.length) throw Error('INVALID_RESPONSE');
            // Only the generation check reports a real cloud reset.
            if (results.some((result) => result.status === 'error' && result.code === 'CLOUD_DATA_RESET'))
              throw Error('CLOUD_DATA_RESET');
            let failure: string | undefined;
            for (let i = 0; i < results.length; i++) {
              const result = results[i],
                sent = batch[i];
              if (result.kind !== sent.kind || result.id !== sent.id) throw Error('INVALID_RESPONSE');
              if (result.status === 'error') {
                if (kind !== 'legacy' && result.code === 'UNSUPPORTED_KIND') {
                  this.deferredKinds.set(kind, Date.now() + 300000);
                  continue;
                }
                failure = result.code;
                continue;
              }
              if (result.status === 'accepted')
                this.local.suppress(() => {
                  const authenticated = this.decode(result.record);
                  if (!equal(authenticated, this.payload(sent))) throw Error('INVALID_RESPONSE');
                  this.local.setBase(sent.kind, sent.id, result.record.seq, authenticated, this.options.deviceId);
                  this.local.acknowledge(sent);
                });
              else if (result.record) {
                this.receive(result.record);
                this.applied();
              } else {
                // The cloud has no row for this base (for example after another computer started over):
                // forget the base and upload the queued change as new on the next cycle.
                this.local.dropBase(sent.kind, sent.id);
              }
            }
            uploadFailure ??= failure;
          }
        }
      }
      await this.pull(epoch);
      if (!this.current(epoch)) return;
      await this.options.files?.flush(this.local, this.session!.userId);
      if (!this.current(epoch)) return;
      if (this.options.files) this.applied();
      if (uploadFailure) throw Error(uploadFailure);
      await this.local.markSuccessfulSync();
      if (!this.current(epoch)) return;
      this.failures = 0;
      this.nextAttempt = 0;
      this.nextPull = Date.now() + (this.active ? 60000 : 300000);
      this.quietUntil = Date.now() + 3000;
      this.setStatus('idle');
    } catch (error) {
      if (this.current(epoch)) {
        const code = this.code(error);
        if (code === 'CLOUD_DATA_RESET') {
          this.stop();
          this.setStatus(`error: ${code}`);
          this.options.onReset?.();
        } else this.failed(error);
      }
    }
  }
  private payload(change: LocalChange): SyncPayload {
    return {
      owner: change.owner,
      value: change.deleted ? {} : filterSyncValue(change.kind, change.value),
      deleted: change.deleted,
      ...(change.kind === 'message' ? { observedSeq: this.local.cursor } : {}),
    };
  }
  private streaming(change: LocalChange) {
    if (change.kind !== 'message' && change.kind !== 'human-message') return false;
    const value =
      change.kind === 'human-message'
        ? (this.local.workspace.get<SyncValue>('message', change.id) ?? {})
        : change.value;
    if (this.options.isStreaming?.(value) || value.streaming === true) return true;
    const external = value.externalAgent as SyncValue | undefined;
    if (external && ['working', 'queued'].includes(String(external.status))) return true;
    const workflow =
      typeof value.workflowId === 'string'
        ? this.local.workspace.get<SyncValue>('workflow', value.workflowId)
        : undefined;
    return value.role === 'assistant' && workflow && activeWorkflow.has(String(workflow.status));
  }
  private decode(record: RemoteRecord): SyncPayload {
    if (
      !record ||
      !Number.isSafeInteger(record.seq) ||
      record.seq <= 0 ||
      typeof record.id !== 'string' ||
      ![...syncKinds, 'settings'].includes(record.kind)
    )
      throw Error('INVALID_RECORD');
    const body = record.body as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('INVALID_RECORD');
    const payload = structuredClone(body) as SyncPayload;
    if (
      typeof payload.owner !== 'string' ||
      typeof payload.deleted !== 'boolean' ||
      payload.deleted !== record.deleted ||
      !payload.value ||
      typeof payload.value !== 'object' ||
      Array.isArray(payload.value)
    )
      throw Error('INVALID_RECORD');
    if (payload.observedSeq !== undefined && (!Number.isSafeInteger(payload.observedSeq) || payload.observedSeq < 0))
      throw Error('INVALID_RECORD');
    if (
      (payload.value.id !== undefined && payload.value.id !== record.id) ||
      (record.kind === 'conversation' && payload.value.incognito) ||
      (record.kind === 'message' && payload.value.importedFrom)
    )
      throw Error('INVALID_RECORD');
    if (!payload.deleted) {
      if (record.kind === 'api-provider') {
        try {
          validateApiProviderValue(payload.value);
        } catch {
          throw Error('INVALID_RECORD');
        }
      }
      if (
        record.kind === 'server-node' &&
        (!deviceSchema.safeParse(payload.value).success ||
          typeof payload.value.enrolledServer !== 'string' ||
          !payload.value.enrolledServer.trim())
      )
        throw Error('INVALID_RECORD');
      if (
        record.kind === 'remote-server' &&
        (!serverSchema.safeParse(payload.value).success ||
          (this.local.opaqueId('remote-server', String(payload.value.name)) !== record.id &&
            payload.value.name !== record.id))
      )
        throw Error('INVALID_RECORD');
    }
    return { ...payload, value: filterSyncValue(record.kind, payload.value) };
  }
  private async pull(epoch: number) {
    while (this.current(epoch)) {
      const records = await this.remote.pull(this.local.cursor, 200);
      if (!this.current(epoch)) return;
      if (!Array.isArray(records) || records.length > 200) throw Error('INVALID_RESPONSE');
      // Validate the complete page before applying any part of it.
      let seq = this.local.cursor;
      for (const record of records) {
        if (
          !record ||
          typeof record.kind !== 'string' ||
          typeof record.id !== 'string' ||
          typeof record.device_id !== 'string' ||
          typeof record.deleted !== 'boolean' ||
          !Number.isSafeInteger(record.seq) ||
          record.seq <= seq
        )
          throw Error('INVALID_RESPONSE');
        if (knownKind(record.kind)) this.decode(record);
        seq = record.seq;
      }
      this.local.suppress(() => {
        for (const record of records) if (knownKind(record.kind)) this.receive(record);
        this.local.cursor = seq;
      });
      if (records.length) this.applied();
      if (records.length < 200) {
        if (!this.firstPullComplete) {
          await this.options.files?.flush(this.local, this.session!.userId);
          if (!this.current(epoch)) return;
          if (this.options.files) this.applied();
          this.firstPullComplete = true;
          this.options.onFirstPull?.();
        }
        return;
      }
    }
  }
  private applied() {
    try {
      this.options.onApplied?.();
    } catch {
      /* UI notification cannot roll back committed data. */
    }
  }
  private receive(record: RemoteRecord) {
    const payload = this.decode(record);
    // Legacy names are retired by capture; replaying them must not resurrect or delete servers.
    if (
      record.kind === 'remote-server' &&
      ((!payload.deleted && payload.value.name === record.id) || (payload.deleted && !/^[a-f0-9]{64}$/.test(record.id)))
    )
      return;
    const base = this.local.base(record.kind, record.id);
    if (base && base.seq >= record.seq) return;
    this.local.suppress(() => {
      const kind = record.kind;
      let id = record.id;
      if (!payload.deleted) id = this.identity(kind, id, payload);
      if (kind === 'memory' && !payload.deleted) id = this.local.alias('project', id);
      payload.value = this.references(kind, payload.value);
      if (kind === 'conversation' || kind === 'memory')
        payload.owner = String(payload.value.projectId ?? payload.owner);
      let pending = this.local.pendingOne(kind, id);
      const old = this.local.current(kind, id);
      if (kind === 'memory' && id !== record.id && old && !payload.deleted) {
        payload.value.content = unionMemory(old.value.content, payload.value.content);
        this.local.enqueue(kind, id, payload);
        pending = this.local.pendingOne(kind, id);
      }
      if (
        kind === 'message' &&
        pending &&
        !pending.deleted &&
        !payload.deleted &&
        !equal(pending.value, payload.value)
      ) {
        // UUID collisions or edits of a common message retain both authenticated bodies.
        const copyId = `${id}-${digest(pending.value)}`;
        const copy = { ...this.payload(pending), value: { ...pending.value, id: copyId } };
        const human = this.local.workspace.get<SyncValue>('human-message', id);
        this.local.apply(kind, copyId, copy);
        this.local.enqueue(kind, copyId, copy);
        if (human) {
          const marker = {
            owner: copy.owner,
            value: { id: copyId, messageHash: messageProvenanceHash(copy.owner, copy.value) },
            deleted: false,
          };
          this.local.apply('human-message', copyId, marker);
          this.local.enqueue('human-message', copyId, marker);
          this.local.workspace.deleteRecord('human-message', id);
          this.local.db.prepare("DELETE FROM sync_outbox WHERE kind='human-message' AND id=?").run(id);
        }
        this.local.acknowledge(pending);
        pending = undefined;
      }
      let merged = payload;
      if (pending && kind !== 'message' && kind !== 'human-message') {
        const value = { ...payload.value };
        const before = base?.value ?? {};
        for (const field of new Set([...Object.keys(before), ...Object.keys(pending.value)])) {
          if (kind === 'settings' && !base && Object.hasOwn(payload.value, field)) continue;
          if (equal(pending.value[field], before[field])) continue;
          if (Object.hasOwn(pending.value, field)) value[field] = pending.value[field];
          else delete value[field];
        }
        merged = {
          owner: pending.owner,
          value,
          deleted: pending.deleted !== !!base?.deleted ? pending.deleted : payload.deleted,
        };
        if (
          payload.deleted &&
          !pending.deleted &&
          ['project', 'memory', 'conversation-folder'].includes(kind) &&
          !equal(pending.value, before)
        ) {
          merged = { owner: pending.owner, value: pending.value, deleted: false };
        }
        if (
          kind === 'memory' &&
          !payload.deleted &&
          !equal(pending.value.content, before.content) &&
          !equal(payload.value.content, before.content)
        )
          merged.value.content = unionMemory(payload.value.content, pending.value.content);
      }
      if (kind === 'server-node' && pending && !pending.deleted && !payload.deleted) {
        // A pairing credential is one unit: never merge a token with another pairing's peer id.
        const latest = String(pending.value.pairedAt) > String(payload.value.pairedAt) ? pending.value : payload.value;
        for (const field of ['token', 'peerId', 'pairedAt']) merged.value[field] = latest[field];
      }
      // Provenance flags only become more conservative during field merges.
      for (const field of ['untrustedContent', 'combinedFrom', 'externalRequest', 'externalAgent']) {
        if (old?.value[field] && !merged.value[field]) merged.value[field] = old.value[field];
      }
      for (const [field, flag] of [
        ['externalRequest', 'thirdParty'],
        ['externalAgent', 'untrusted'],
      ] as const) {
        if ((old?.value[field] as SyncValue | undefined)?.[flag])
          merged.value[field] = { ...(merged.value[field] as SyncValue), [flag]: true };
      }
      if (Array.isArray(old?.value.combinedFrom))
        merged.value.combinedFrom = [
          ...new Set([
            ...old.value.combinedFrom,
            ...(Array.isArray(merged.value.combinedFrom) ? merged.value.combinedFrom : []),
          ]),
        ];
      if (kind === 'conversation')
        for (const title of [old?.value.title, payload.value.title]) {
          if (title && title !== merged.value.title)
            this.local.workspace.save('sync-title-history', `${id}-${record.seq}-${digest(title)}`, id, {
              title,
              seq: record.seq,
            });
        }
      this.local.apply(kind, id, merged);
      // Store the remote baseline, never the merged candidate, for the next three-way merge.
      this.local.setBase(kind, record.id, record.seq, payload, record.device_id);
      if (pending) {
        this.local.acknowledge(pending);
        if (!equal(merged, payload)) this.local.enqueue(kind, id, merged);
      }
      if (kind === 'memory' && id !== record.id && !payload.deleted) this.local.enqueue(kind, id, merged);
      if (kind === 'api-provider' && id !== record.id && !payload.deleted) this.local.enqueue(kind, id, merged);
      if (kind === 'conversation' && !record.deleted) this.restoreForNewMessages(id);
      if (kind === 'message' && !payload.deleted && !payload.value.systemNotice) {
        this.restoreForNewMessages(payload.owner);
        const localNew = this.local.hasNewMessage(payload.owner, id);
        const unseenLocal = this.local.db
          .prepare(
            `SELECT 1 FROM sync_base WHERE kind='message' AND id<>? AND device_id=? AND seq>?
          AND json_extract(payload,'$.owner')=? AND json_extract(payload,'$.deleted')=0 LIMIT 1`,
          )
          .get(id, this.options.deviceId, payload.observedSeq ?? record.seq, payload.owner);
        if (record.device_id !== this.options.deviceId && (localNew || unseenLocal))
          this.notice(payload.owner, 'concurrent', String(payload.value.createdAt ?? record.server_updated_at));
      }
    });
  }
  private restoreForNewMessages(id: string) {
    const conversation = this.local.current('conversation', id);
    if (!conversation?.value.deletedAt) return;
    // A hard purge stays in the recycle bin even if retained messages have later client timestamps.
    if (this.local.base('conversation', id)?.deleted) return;
    const deletedAt = String(conversation.value.deletedAt);
    const messages = this.local.workspace.messages(id);
    const latest = messages.filter((m) => !m.systemNotice && m.createdAt > deletedAt).at(-1);
    if (!latest) return;
    delete conversation.value.deletedAt;
    delete conversation.value.deletedByUser;
    this.local.apply('conversation', id, conversation);
    this.local.enqueue('conversation', id, conversation);
    this.notice(id, 'restored', latest.createdAt);
  }
  private notice(conversationId: string, reason: 'concurrent' | 'restored', createdAt: string) {
    const id = `sync-notice-${digest([conversationId, reason])}`;
    if (this.local.workspace.get('message', id)) return;
    const text =
      reason === 'restored'
        ? 'This conversation was deleted on another device and was kept because it has new messages.'
        : 'Another device also added messages to this conversation.';
    this.local.workspace.save('message', id, conversationId, {
      id,
      conversationId,
      role: 'assistant',
      content: text,
      systemNotice: { text },
      syncNotice: reason,
      createdAt,
      replyIdentity: { automatic: true, kind: 'system', runs: [] },
    });
  }
  private references(kind: string, value: SyncValue): SyncValue {
    const next = { ...value };
    if (typeof next.projectId === 'string') next.projectId = this.local.alias('project', next.projectId);
    if (typeof next.folderId === 'string') next.folderId = this.local.alias('conversation-folder', next.folderId);
    if (kind === 'project' && typeof next.id === 'string') next.id = this.local.alias(kind, next.id);
    return next;
  }
  private identity(kind: string, id: string, payload: SyncPayload): string {
    if (kind === 'api-provider') {
      const identity = apiProviderIdentity(payload.value);
      const matches = (
        this.local.db.prepare("SELECT id FROM workspace_records WHERE kind='api-provider'").all() as { id: string }[]
      )
        .filter((row) => apiProviderIdentity(this.local.current(kind, row.id)!.value) === identity)
        .map((row) => row.id);
      const canonical = [this.local.alias(kind, id), ...matches].sort()[0];
      for (const loser of new Set([id, ...matches].filter((candidate) => candidate !== canonical))) {
        const existing = this.local.current(kind, loser);
        this.local.setAlias(kind, loser, canonical);
        if (existing && !this.local.current(kind, canonical)) {
          const moved = { ...existing, value: { ...existing.value, id: canonical } };
          this.local.apply(kind, canonical, moved);
          this.local.enqueue(kind, canonical, moved);
        }
        const deleted = { owner: '', value: {}, deleted: true };
        this.local.apply(kind, loser, deleted);
        if (loser === id || this.local.base(kind, loser)) this.local.enqueue(kind, loser, deleted);
        else this.local.db.prepare('DELETE FROM sync_outbox WHERE kind=? AND id=?').run(kind, loser);
      }
      payload.value.id = canonical;
      return canonical;
    }
    if (kind !== 'project' && kind !== 'conversation-folder') return id;
    const rows = this.local.workspace
      .list<SyncValue>(kind, undefined, Number.MAX_SAFE_INTEGER)
      .map((row) => this.local.filtered(kind, row));
    const match = rows.find(
      (row) =>
        row.id !== id &&
        (kind === 'conversation-folder'
          ? typeof row.name === 'string' &&
            typeof payload.value.name === 'string' &&
            conversationFolderNameKey(row.name) === conversationFolderNameKey(payload.value.name)
          : (row.scope === 'chat' && payload.value.scope === 'chat') ||
            (typeof row.gitRemote === 'string' &&
              !!row.gitRemote &&
              row.name === payload.value.name &&
              row.gitRemote === payload.value.gitRemote)),
    );
    const known = this.local.alias(kind, id);
    if (!match && known === id) return id;
    const canonical = [known, ...(match ? [String(match.id)] : [])].sort()[0];
    const losers = [id, ...(match ? [String(match.id)] : [])].filter((candidate) => candidate !== canonical);
    for (const loser of losers) {
      const local = this.local.current(kind, loser);
      this.local.setAlias(kind, loser, canonical);
      if (local) {
        const raw = this.local.workspace.get<SyncValue>(kind, loser)!;
        const value = { ...payload.value, ...raw, id: canonical };
        this.local.workspace.save(kind, canonical, kind === 'project' ? canonical : '', value);
        this.local.workspace.deleteRecord(kind, loser);
        this.local.enqueue(kind, canonical, {
          owner: kind === 'project' ? canonical : '',
          value: filterSyncValue(kind, value),
          deleted: false,
        });
      }
      this.local.db.prepare('DELETE FROM sync_outbox WHERE kind=? AND id=?').run(kind, loser);
      for (const row of this.local.db
        .prepare(
          "SELECT kind,id,owner,value FROM workspace_records WHERE (kind IN ('conversation','memory')) OR (?='project' AND owner=?)",
        )
        .all(kind, loser)) {
        const value = JSON.parse(row.value as string) as SyncValue;
        const field = kind === 'project' ? 'projectId' : 'folderId';
        if (value[field] !== loser && !(kind === 'project' && row.owner === loser)) continue;
        if (value[field] === loser) value[field] = canonical;
        const owner = kind === 'project' ? canonical : (row.owner as string);
        const targetId =
          kind === 'project' && ['memory', 'memory-auto'].includes(row.kind as string) ? canonical : (row.id as string);
        if (targetId !== row.id) {
          const existing = this.local.workspace.get<SyncValue>(row.kind as string, targetId);
          value.content = unionMemory(existing?.content, value.content);
          this.local.workspace.deleteRecord(row.kind as string, row.id as string);
          this.local.db
            .prepare('DELETE FROM sync_outbox WHERE kind=? AND id=?')
            .run(row.kind as string, row.id as string);
          if (value.id === row.id) value.id = targetId;
        }
        this.local.workspace.save(row.kind as string, targetId, owner, value);
        if ((syncKinds as readonly string[]).includes(row.kind as string))
          this.local.enqueue(row.kind as string, targetId, { owner, value, deleted: false });
      }
    }
    payload.value.id = canonical;
    if (kind === 'project') payload.owner = canonical;
    return canonical;
  }
  async upsertDevice(device: Omit<SyncDevice, 'id'>): Promise<void> {
    if (!this.session) return;
    const epoch = this.epoch;
    this.deviceWrite = (this.deviceWrite ?? Promise.resolve()).then(async () => {
      if (!this.current(epoch)) return;
      try {
        await this.remote.upsertDevice({ ...device, id: this.options.deviceId });
      } catch (error) {
        if (this.current(epoch)) this.failed(error);
      }
    });
    await this.deviceWrite;
  }
  /** The UI must obtain confirmation before calling this destructive operation. Local records stay intact. */
  async deleteCloudData(): Promise<boolean> {
    if (!this.session || this.deleting) return false;
    const userId = this.session.userId;
    this.deleting = true;
    this.stop();
    try {
      // Drain the old request before deleting, so a late upload cannot recreate the just-deleted cloud data.
      await Promise.all([this.running, this.deviceWrite]);
      await this.remote.deleteMyCloudData();
      if (this.local.state()?.account !== userId) throw Error('ACCOUNT_MISMATCH');
      this.local.resetAfterCloudDeletion();
      this.setStatus('off');
      return true;
    } catch (error) {
      this.setStatus(`error: ${this.code(error)}`);
      return false;
    } finally {
      this.deleting = false;
    }
  }
}
