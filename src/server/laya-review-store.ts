import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, opendir, rename, rmdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { LayaReviewRecord } from '../shared/laya.ts';
import { trustedDirectory } from './platform/trusted-path.ts';

type TrainingStatus = LayaReviewRecord['training']['status'];
export type StoredLayaReviewRecord = LayaReviewRecord & { capture: { redacted: boolean; truncated: boolean } };
const statuses: TrainingStatus[] = ['pending', 'reviewed', 'reserved', 'used', 'excluded'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const maxFileBytes = 512 * 1024;
const maxEntries = 10_000;
const lockWaitMs = 3000;
const queues = new Map<string, Promise<unknown>>();
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
type LockSnapshot = { directory: BigIntStats; file: BigIntStats; pid: number; token: string; name: string };
const sameIdentity = (a: BigIntStats, b: BigIntStats) =>
  a.ino === b.ino && (process.platform === 'win32' || a.dev === b.dev);
const deadOwner = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
};
async function lockJSON(path: string): Promise<{ file: BigIntStats; value: Record<string, unknown> } | undefined> {
  let handle;
  try {
    const file = await lstat(path, { bigint: true });
    if (file.isSymbolicLink() || !file.isFile() || file.nlink > 1n || file.size > 1024)
      throw new Error('Unsafe Laya review lock.');
    // Another recovery may unlink the marker after pathname lookup but before stat reads the inode.
    if (file.nlink === 0n) return undefined;
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!sameIdentity(file, await handle.stat({ bigint: true }))) return undefined;
    const buffer = Buffer.alloc(1025);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > 1024) throw new Error('Unsafe Laya review lock.');
    let value;
    try {
      value = JSON.parse(buffer.subarray(0, size).toString('utf8'));
    } catch {
      return undefined;
    }
    return value && typeof value === 'object' ? { file, value } : undefined;
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}
const validDate = (date: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  Number.isFinite(Date.parse(date)) &&
  new Date(date).toISOString().slice(0, 10) === date;

function recordId(id: string): [string, string] {
  const parts = id.split('/');
  if (parts.length !== 2 || !validDate(parts[0]!) || !uuid.test(parts[1]!)) throw new Error('Invalid Laya review ID.');
  return parts as [string, string];
}
function localDate(timestamp: string): string {
  const date = new Date(timestamp);
  if (
    !validDate(timestamp.slice(0, 10)) ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp) ||
    !Number.isFinite(date.getTime())
  )
    throw new Error('Invalid Laya review createdAt.');
  return `${date.getFullYear().toString().padStart(4, '0')}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
}

/** Same credential families as tool diagnostics, while preserving training text formatting and public URLs. */
function redact(text: string): string {
  return text
    .replace(
      /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g,
      '[redacted private key]',
    )
    .replace(
      /(^|\n)(\s*(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*:\s*)[^\r\n]*/gi,
      '$1$2[redacted]',
    )
    .replace(/\b(?:sk|pk|xai)-[\w-]+/gi, '[redacted]')
    .replace(
      /\b(?:gh[pousr]_[\w]+|github_pat_[\w]+|xox[baprs]-[\w-]+|AKIA[A-Z0-9]{16}|AIza[\w-]{20,})\b/g,
      '[redacted]',
    )
    .replace(/\beyJ[\w-]+(?:\.[\w-]+){0,2}\b/g, '[redacted]')
    .replace(/((?:bearer|basic)\s+)[^\s"',;]+/gi, '$1[redacted]')
    .replace(
      /\b(["']?(?:[\w-]*(?:api[_-]?key|access[_-]?key|token|password|secret)|authorization|credentials?|cookie)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&#]+)/gi,
      '$1[redacted]',
    )
    .replace(/\bhttps?:\/\/[^\s<>"']+/gi, (url) => {
      try {
        const parsed = new URL(url);
        let changed = false;
        if (parsed.username || parsed.password) {
          parsed.username = '[redacted]';
          parsed.password = '';
          changed = true;
        }
        for (const key of [...parsed.searchParams.keys()]) {
          if (
            /token|secret|password|credential|signature|authorization|api[-_]?key|access[-_]?key|^key$|^sig$|^code$/i.test(
              key,
            )
          ) {
            parsed.searchParams.set(key, '[redacted]');
            changed = true;
          }
        }
        if (parsed.hash && /token|secret|password|credential|authorization|api[-_]?key/i.test(parsed.hash)) {
          parsed.hash = '[redacted]';
          changed = true;
        }
        return changed ? parsed.toString().replace(/%5Bredacted%5D/g, '[redacted]') : url;
      } catch {
        return '[redacted invalid URL]';
      }
    })
    .replace(/data:[^;,\s]+;base64,[^\s"']+/gi, '[redacted attachment content]');
}

function sanitize<T>(
  value: T,
  characterLimit = 64_000,
  arrayMarkers = true,
  redactText?: (text: string) => string,
): { value: T; redacted: boolean; truncated: boolean } {
  let remaining = characterLimit;
  let nodes = 0;
  let redacted = false;
  let truncated = false;
  const visit = (item: unknown, depth = 0): unknown => {
    if (++nodes > 2000 || depth > 10) {
      truncated = true;
      return '[truncated: structure limit]';
    }
    if (typeof item === 'string') {
      const length = Math.min(12_000, remaining);
      // Redact before cutting: a tail without its credential prefix would evade the redactor.
      const credentialsRedacted = redact(item);
      const redactedItem = redactText ? redactText(credentialsRedacted) : credentialsRedacted;
      redacted ||= redactedItem !== item;
      const safe =
        redactedItem.length <= length
          ? redactedItem
          : redactedItem.slice(0, Math.floor(length / 3)) +
            '\n[...middle omitted...]\n' +
            (length ? redactedItem.slice(-(length - Math.floor(length / 3))) : '');
      remaining -= Math.min(item.length, length);
      if (item.length <= length) return safe;
      truncated = true;
      return `${safe}[truncated: originalChars=${item.length}; retainedChars=${length}]`;
    }
    if (Array.isArray(item)) {
      const result = item.slice(0, 100).map((entry) => visit(entry, depth + 1));
      if (item.length > 100) {
        truncated = true;
        if (arrayMarkers) result.push(`[truncated: originalItems=${item.length}; retainedItems=100]`);
      }
      return result;
    }
    if (item && typeof item === 'object') {
      const entries = Object.entries(item);
      const result: Record<string, unknown> = Object.create(null);
      for (const [key, entry] of entries.slice(0, 100)) {
        const keyPrefix = key.slice(0, 120);
        const credentialsRedacted = redact(keyPrefix);
        const safeKey =
          (redactText ? redactText(credentialsRedacted) : credentialsRedacted) +
          (key.length > 120 ? '[truncated key]' : '');
        redacted ||= safeKey !== key && key.length <= 120;
        truncated ||= key.length > 120;
        if (
          /(?:^|[_-])(?:authorization|credentials?|cookie|password|secret|token|api[_-]?key|private[_-]?key|access[_-]?key)$/i.test(
            key,
          ) ||
          /^(?:accessToken|refreshToken|apiKey|privateKey|clientSecret|secretAccessKey)$/i.test(key)
        ) {
          result[safeKey] = '[redacted]';
          redacted = true;
        } else result[safeKey] = visit(entry, depth + 1);
      }
      if (entries.length > 100) {
        truncated = true;
        result.__truncated__ = `originalKeys=${entries.length}; retainedKeys=100`;
      }
      return result;
    }
    return typeof item === 'bigint' ? String(item) : item;
  };
  const safe = visit(value) as T;
  return { value: safe, redacted, truncated };
}

export { sanitize as sanitizeLayaReviewValue };

/** Local review bookkeeping only. No model training, upload, or user-project writes occur here. */
export class LayaReviewStore {
  readonly directory: string;
  private readonly dataDir: string;
  private readonly newRecords = new Set<string>();
  private uploadEpoch = 0;
  constructor(
    dataDir: string,
    private readonly options: {
      onCompleted?: (record: LayaReviewRecord) => void | Promise<void>;
      canShare?: (record: Omit<LayaReviewRecord, 'id' | 'training'>) => boolean;
    } = {},
  ) {
    // Links above the data folder belong to the system (macOS /var); links from the data folder down stay refused.
    this.dataDir = resolve(trustedDirectory(dataDir));
    this.directory = join(this.dataDir, 'routing-training');
  }

  invalidateUploads(): void {
    ++this.uploadEpoch;
    this.newRecords.clear();
  }

  private async safeDirectory(path: string, create = false): Promise<boolean> {
    const parent = dirname(path);
    if (parent !== path && !(await this.safeDirectory(parent))) return false;
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (!missing(error)) throw error;
      if (!create) return false;
      try {
        await mkdir(path, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
      }
      info = await lstat(path);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Unsafe Laya review directory.');
    return true;
  }

  private async lockSnapshot(path: string): Promise<LockSnapshot | null | undefined> {
    let directory;
    try {
      directory = await lstat(path, { bigint: true });
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
    if (directory.isSymbolicLink()) throw new Error('Unsafe Laya review lock.');
    if (!directory.isDirectory()) {
      if (!directory.isFile() || directory.nlink !== 1n) throw new Error('Unsafe Laya review lock.');
      return null;
    }
    const entries: string[] = [];
    try {
      for await (const entry of await opendir(path)) {
        if (entry.isSymbolicLink()) throw new Error('Unsafe Laya review lock.');
        entries.push(entry.name);
        if (entries.length > 1) return null;
      }
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    if (!entries.length) return (await this.recoverEmptyLock(path, directory)) ? undefined : null;
    const name = entries[0];
    const match = name && /^(\d+)\.([0-9a-f-]{36})\.json$/.exec(name);
    if (!match || !uuid.test(match[2]!)) return null;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || String(pid) !== match[1]) return null;
    const filePath = join(path, name!);
    try {
      const parsed = await lockJSON(filePath);
      if (!parsed) return null;
      const { file, value: owner } = parsed;
      if (owner?.version !== 1 || owner.pid !== pid || owner.token !== match[2]) return null;
      const current = await lstat(path, { bigint: true });
      if (current.isSymbolicLink() || !sameIdentity(directory, current)) return null;
      return { directory, file, pid, token: match[2]!, name: name! };
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  private async ownershipProof(pid: number, token: string, directory: BigIntStats) {
    const stage = join(this.directory, `.laya-lock-${pid}-${token}`);
    if (!(await this.safeDirectory(stage))) return undefined;
    const proof = await lockJSON(join(stage, 'proof.json'));
    if (
      !proof ||
      proof.value.version !== 1 ||
      proof.value.pid !== pid ||
      proof.value.token !== token ||
      proof.value.ino !== directory.ino.toString() ||
      proof.value.dev !== directory.dev.toString() ||
      proof.value.birthtimeNs !== directory.birthtimeNs.toString()
    )
      return undefined;
    return { stage, file: proof.file };
  }

  private async removeProof(owner: Pick<LockSnapshot, 'pid' | 'token' | 'directory'>) {
    const proof = await this.ownershipProof(owner.pid, owner.token, owner.directory);
    if (!proof) return;
    const path = join(proof.stage, 'proof.json');
    const current = await lstat(path, { bigint: true });
    if (current.isSymbolicLink() || current.nlink !== 1n || !sameIdentity(current, proof.file)) return;
    await unlink(path);
    await rmdir(proof.stage).catch((error) => {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    });
  }

  private async recoverEmptyLock(path: string, directory: BigIntStats): Promise<boolean> {
    // An independent identity proof survives a crash between marker removal and rmdir.
    if (directory.birthtimeNs <= 0n) return false;
    let count = 0;
    for await (const entry of await opendir(this.directory)) {
      if (++count > maxEntries) throw new Error('Laya lock recovery scan limit reached.');
      const match = /^\.laya-lock-(\d+)-([0-9a-f-]{36})$/.exec(entry.name);
      if (!match || !uuid.test(match[2]!)) continue;
      const pid = Number(match[1]),
        token = match[2]!;
      if (
        !Number.isSafeInteger(pid) ||
        pid <= 0 ||
        !deadOwner(pid) ||
        !(await this.ownershipProof(pid, token, directory))
      )
        continue;
      try {
        await this.safeDirectory(this.directory);
        const current = await lstat(path, { bigint: true });
        if (
          current.isSymbolicLink() ||
          !current.isDirectory() ||
          !sameIdentity(current, directory) ||
          current.birthtimeNs !== directory.birthtimeNs ||
          !deadOwner(pid)
        )
          return false;
        await rmdir(path);
        await this.removeProof({ pid, token, directory });
        return true;
      } catch (error) {
        if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
        throw error;
      }
    }
    return false;
  }

  private async removeLock(path: string, owner: LockSnapshot, recover = false): Promise<boolean> {
    await this.safeDirectory(this.directory);
    if (recover && !deadOwner(owner.pid)) return false;
    try {
      const directory = await lstat(path, { bigint: true });
      if (directory.isSymbolicLink() || !directory.isDirectory() || !sameIdentity(directory, owner.directory))
        return false;
      const filePath = join(path, owner.name);
      const file = await lstat(filePath, { bigint: true });
      if (file.isSymbolicLink() || !file.isFile() || file.nlink !== 1n || !sameIdentity(file, owner.file)) return false;
      if (recover && (file.size !== owner.file.size || file.mtimeNs !== owner.file.mtimeNs || !deadOwner(owner.pid)))
        return false;
      // This token's unique filename cannot name a later owner's marker. New published locks are always nonempty.
      await unlink(filePath);
      await rmdir(path).catch((error) => {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      });
      await this.removeProof(owner);
      return true;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  }

  private async acquireLock(started: number): Promise<{ path: string; owner: LockSnapshot }> {
    const token = randomUUID();
    const stage = join(this.directory, `.laya-lock-${process.pid}-${token}`);
    const lease = join(stage, 'lease');
    const path = join(this.directory, '.laya.lock');
    const name = `${process.pid}.${token}.json`;
    await mkdir(stage, { mode: 0o700 });
    await this.safeDirectory(stage);
    await mkdir(lease, { mode: 0o700 });
    const directory = await lstat(lease, { bigint: true });
    if (directory.isSymbolicLink() || !directory.isDirectory()) throw new Error('Unsafe Laya review lock.');
    let owner: LockSnapshot | undefined;
    let published = false;
    let acquired = false;
    try {
      const handle = await open(join(lease, name), 'wx', 0o600);
      try {
        owner = { directory, file: await handle.stat({ bigint: true }), pid: process.pid, token, name };
        await handle.writeFile(JSON.stringify({ version: 1, pid: process.pid, token }));
        await handle.sync();
        owner.file = await handle.stat({ bigint: true });
      } finally {
        await handle.close();
      }
      const proof = await open(join(stage, 'proof.json'), 'wx', 0o600);
      try {
        await proof.writeFile(
          JSON.stringify({
            version: 1,
            pid: process.pid,
            token,
            ino: directory.ino.toString(),
            dev: directory.dev.toString(),
            birthtimeNs: directory.birthtimeNs.toString(),
          }),
        );
        await proof.sync();
      } finally {
        await proof.close();
      }
      while (Date.now() - started < lockWaitMs) {
        await this.safeDirectory(this.directory);
        const existing = await this.lockSnapshot(path);
        if (existing === undefined) {
          try {
            // Publishing a prepared nonempty directory leaves no ownerless acquisition window.
            await rename(lease, path);
            published = true;
            const current = await this.lockSnapshot(path);
            if (!current || current.token !== token || !sameIdentity(current.directory, directory))
              throw new Error('Laya review lock changed.');
            acquired = true;
            return { path, owner };
          } catch (error) {
            if (
              published ||
              !['EEXIST', 'ENOTEMPTY', 'EACCES', 'EPERM', 'ENOTDIR'].includes(
                (error as NodeJS.ErrnoException).code ?? '',
              )
            )
              throw error;
          }
        } else if (existing && deadOwner(existing.pid)) {
          await this.removeLock(path, existing, true);
          continue;
        }
        await delay(10);
      }
      throw new Error('Laya review store is busy.');
    } finally {
      if (!acquired) {
        if (owner) await this.removeLock(published ? path : lease, owner);
        else
          await rmdir(lease).catch((error) => {
            if (!missing(error)) throw error;
          });
      }
    }
  }

  private async locked<T>(action: () => Promise<T>, empty: T, create = true): Promise<T> {
    const key = process.platform === 'win32' ? this.directory.toLowerCase() : this.directory;
    const previous = (queues.get(key) ?? Promise.resolve()).catch(() => {});
    // Work queued in this process always ends, so waiting for it is not timed: on a busy computer that wait used to
    // drop Laya judgments as "busy". Only another process holding the lock is bounded, from this write's own turn.
    const operation = previous.then(async () => {
      const started = Date.now();
      if (!(await this.safeDirectory(this.dataDir))) {
        if (!create) return empty;
        throw new Error('Laya data directory does not exist.');
      }
      if (!(await this.safeDirectory(this.directory, create))) return empty;
      const lock = await this.acquireLock(started);
      try {
        return await action();
      } finally {
        if (!(await this.removeLock(lock.path, lock.owner))) throw new Error('Laya review lock changed.');
      }
    });
    queues.set(key, operation);
    try {
      return await operation;
    } finally {
      if (queues.get(key) === operation) queues.delete(key);
    }
  }

  private async read(id: string): Promise<LayaReviewRecord | undefined> {
    const [date, name] = recordId(id);
    if (!(await this.safeDirectory(join(this.directory, date)))) return undefined;
    const file = join(this.directory, date, name + '.json');
    let info;
    try {
      info = await lstat(file, { bigint: true });
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1n || info.size > maxFileBytes)
      throw new Error('Unsafe or oversized Laya review file.');
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let text;
    try {
      const current = await handle.stat({ bigint: true });
      if (
        (process.platform !== 'win32' && current.dev !== info.dev) ||
        current.ino !== info.ino ||
        current.size > maxFileBytes
      )
        throw new Error('Laya review file changed.');
      const buffer = Buffer.alloc(maxFileBytes + 1);
      let size = 0;
      while (size < buffer.length) {
        const result = await handle.read(buffer, size, buffer.length - size, null);
        if (!result.bytesRead) break;
        size += result.bytesRead;
      }
      if (size > maxFileBytes) throw new Error('Oversized Laya review file.');
      text = buffer.subarray(0, size).toString('utf8');
    } finally {
      await handle.close();
    }
    const value = JSON.parse(text) as LayaReviewRecord;
    if (
      value.id !== id ||
      !uuid.test(value.workflowId) ||
      (value.messageId ?? value.workflowId) !== name ||
      !value.projectId ||
      !value.state ||
      !value.inference ||
      !value.policy ||
      typeof value.question !== 'string' ||
      !statuses.includes(value.training?.status)
    )
      throw new Error('Invalid Laya review record.');
    return value;
  }

  private async write(record: LayaReviewRecord): Promise<void> {
    const [date, name] = recordId(record.id);
    const directory = join(this.directory, date);
    await this.safeDirectory(directory, true);
    const target = join(directory, name + '.json');
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw new Error('Unsafe Laya review file.');
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const json = JSON.stringify(record, null, 2) + '\n';
    if (Buffer.byteLength(json) > maxFileBytes) throw new Error('Laya review exceeds storage limit.');
    const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(json);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.safeDirectory(directory);
      await rename(temporary, target);
    } finally {
      await this.safeDirectory(directory);
      await unlink(temporary).catch((error) => {
        if (!missing(error)) throw error;
      });
    }
  }

  async capture(
    record: Omit<LayaReviewRecord, 'id' | 'training'>,
    options: { incognito?: boolean } = {},
  ): Promise<string | undefined> {
    if (options.incognito) return undefined;
    const uploadEpoch = this.uploadEpoch;
    const canShare = !!this.options.onCompleted && (this.options.canShare?.(record) ?? true);
    const identity = record.messageId ?? record.workflowId;
    if (!uuid.test(record.workflowId) || !uuid.test(identity))
      throw new Error('Laya workflow/message identity must be a UUID.');
    const id = `${localDate(record.createdAt)}/${identity}`;
    const { raw, ...inference } = record.inference;
    const safe = sanitize(
      {
        ...record,
        inference,
        state: {
          message: record.state.message,
          recent_context: record.state.recent_context,
          reference_text: record.state.reference_text,
          candidate_executors: record.state.candidate_executors,
          attachments: record.state.attachments.map(({ kind, name, mime_type }) => ({
            kind,
            name,
            ...(mime_type ? { mime_type } : {}),
          })),
        },
      },
      64_000,
      false,
    );
    const safeRaw = sanitize(raw, 32_000);
    const capturedInference = {
      ...safe.value.inference,
      ...(safeRaw.value === undefined ? {} : { raw: safeRaw.value }),
    };
    return this.locked(async () => {
      const existing = (await this.read(id)) as StoredLayaReviewRecord | undefined;
      if (existing) {
        // Only the unclaimed enqueue placeholder may be completed; captured judgments stay immutable.
        if (
          existing.training.status === 'pending' &&
          existing.inference.reason === 'queued-pending-judgment' &&
          capturedInference.reason !== 'queued-pending-judgment' &&
          existing.question === safe.value.question &&
          existing.workflowId === safe.value.workflowId &&
          existing.messageId === safe.value.messageId &&
          existing.projectId === safe.value.projectId &&
          existing.conversationId === safe.value.conversationId
        ) {
          existing.state = safe.value.state;
          existing.inference = capturedInference;
          existing.policy = safe.value.policy;
          existing.capture = {
            redacted: !!existing.capture?.redacted || safe.redacted || safeRaw.redacted,
            truncated: !!existing.capture?.truncated || safe.truncated || safeRaw.truncated,
          };
          await this.write(existing);
        }
        return id;
      }
      const value: StoredLayaReviewRecord = {
        ...safe.value,
        inference: capturedInference,
        id,
        training: { status: 'pending', updatedAt: new Date().toISOString() },
        capture: { redacted: safe.redacted || safeRaw.redacted, truncated: safe.truncated || safeRaw.truncated },
      };
      await this.write(value);
      if (canShare && uploadEpoch === this.uploadEpoch) this.newRecords.add(id);
      return id;
    }, undefined);
  }

  async updateOutcome(id: string, outcome: LayaReviewRecord['outcome']): Promise<void> {
    recordId(id);
    const completed = await this.locked<LayaReviewRecord | undefined>(
      async () => {
        const record = await this.read(id);
        if (!record) return;
        const safe = sanitize(outcome, 64_000, false);
        record.outcome = safe.value;
        const stored = record as StoredLayaReviewRecord;
        stored.capture = {
          redacted: !!stored.capture?.redacted || safe.redacted,
          truncated: !!stored.capture?.truncated || safe.truncated,
        };
        await this.write(record);
        if (this.newRecords.has(id) && ['completed', 'failed', 'cancelled'].includes(record.outcome?.status ?? ''))
          return record;
      },
      undefined,
      false,
    );
    if (completed && this.newRecords.delete(id)) {
      const uploadEpoch = this.uploadEpoch;
      try {
        await this.options.onCompleted?.(completed);
      } catch (error) {
        if (uploadEpoch === this.uploadEpoch) this.newRecords.add(id);
        throw error;
      }
    }
  }

  private async ids(date?: string): Promise<string[]> {
    if (date && !validDate(date)) throw new Error('Invalid Laya review date.');
    const dates: string[] = [];
    let entries = 0;
    if (date) dates.push(date);
    else
      for await (const entry of await opendir(this.directory)) {
        if (++entries > maxEntries) throw new Error('Laya review scan limit reached.');
        if (validDate(entry.name)) dates.push(entry.name);
      }
    const ids: string[] = [];
    for (const day of dates.sort().reverse()) {
      const directory = join(this.directory, day);
      if (!(await this.safeDirectory(directory))) continue;
      for await (const entry of await opendir(directory)) {
        if (++entries > maxEntries) throw new Error('Laya review scan limit reached.');
        if (entry.isSymbolicLink()) throw new Error('Unsafe Laya review file.');
        if (entry.name.endsWith('.json') && uuid.test(entry.name.slice(0, -5)))
          ids.push(`${day}/${entry.name.slice(0, -5)}`);
      }
    }
    return ids;
  }

  async list(options: { date?: string; status?: TrainingStatus; limit?: number } = {}): Promise<LayaReviewRecord[]> {
    if (options.date !== undefined && !validDate(options.date)) throw new Error('Invalid Laya review date.');
    if (options.status !== undefined && !statuses.includes(options.status))
      throw new Error('Invalid Laya review status.');
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Laya review limit must be 1 to 500.');
    return this.locked(
      async () => {
        const records: LayaReviewRecord[] = [];
        let bytes = 0;
        for (const id of await this.ids(options.date)) {
          const record = await this.read(id);
          if (!record) continue;
          bytes += Buffer.byteLength(JSON.stringify(record));
          if (bytes > 32 * 1024 * 1024) throw new Error('Laya review read limit reached.');
          if (!options.status || record.training.status === options.status) records.push(record);
        }
        return records
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
          .slice(0, limit);
      },
      [],
      false,
    );
  }

  async transition(
    ids: string[],
    status: TrainingStatus,
    options: { batchId?: string; modelVersion?: string } = {},
  ): Promise<void> {
    if (!statuses.includes(status) || ids.length > 500) throw new Error('Invalid Laya review transition.');
    ids.forEach(recordId);
    if (options.batchId !== undefined && !/^[a-zA-Z0-9_.:-]{1,128}$/.test(options.batchId))
      throw new Error('Invalid Laya training batch ID.');
    if (options.modelVersion !== undefined && !/^[a-zA-Z0-9_.:-]{1,200}$/.test(options.modelVersion))
      throw new Error('Invalid Laya training model version.');
    await this.locked(
      async () => {
        const records: LayaReviewRecord[] = [];
        for (const id of new Set(ids)) {
          const record = await this.read(id);
          if (!record) throw new Error('Laya review record not found.');
          const old = record.training;
          if (
            (status === 'reserved' || status === 'used' || old.status === 'reserved' || old.status === 'used') &&
            !options.batchId
          )
            throw new Error('Laya training transition requires a batch ID.');
          if ((old.status === 'reserved' || old.status === 'used') && old.batchId !== options.batchId)
            throw new Error('Laya review belongs to another training batch.');
          if (old.status === 'used' && status !== 'used') throw new Error('Used Laya review records cannot be reused.');
          if (status === 'reserved' && old.status !== 'reviewed' && old.status !== 'reserved')
            throw new Error('Only reviewed Laya records may be reserved.');
          if (status === 'used' && old.status !== 'reserved' && old.status !== 'used')
            throw new Error('Only reserved Laya records may be used.');
          if (old.status === 'reserved' && !['reserved', 'used', 'reviewed'].includes(status))
            throw new Error('Release the reservation to reviewed before changing its status.');
          if (old.status === status) continue;
          record.training = {
            status,
            updatedAt: new Date().toISOString(),
            ...(status === 'reserved' || status === 'used'
              ? {
                  batchId: options.batchId,
                  ...((options.modelVersion ?? old.modelVersion)
                    ? { modelVersion: options.modelVersion ?? old.modelVersion }
                    : {}),
                }
              : {}),
          };
          records.push(record);
        }
        for (const record of records) await this.write(record);
      },
      undefined,
      false,
    );
  }

  private async remove(match?: (record: LayaReviewRecord) => boolean): Promise<void> {
    await this.locked(
      async () => {
        const selected: string[] = [];
        let bytes = 0;
        for (const id of await this.ids()) {
          if (!match) {
            const [date, name] = recordId(id);
            const info = await lstat(join(this.directory, date, name + '.json'));
            if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1)
              throw new Error('Unsafe Laya review file.');
            selected.push(id);
            continue;
          }
          const record = await this.read(id);
          if (!record) continue;
          bytes += Buffer.byteLength(JSON.stringify(record));
          if (bytes > 32 * 1024 * 1024) throw new Error('Laya review read limit reached.');
          if (match(record)) selected.push(id);
        }
        const dates = new Set<string>();
        for (const id of selected) {
          const [date, name] = recordId(id);
          await this.safeDirectory(join(this.directory, date));
          await unlink(join(this.directory, date, name + '.json'));
          this.newRecords.delete(id);
          dates.add(date);
        }
        for (const date of dates) {
          const directory = join(this.directory, date);
          await this.safeDirectory(directory);
          await rmdir(directory).catch((error) => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY' && !missing(error)) throw error;
          });
        }
      },
      undefined,
      false,
    );
  }
  async clear(): Promise<void> {
    await this.remove();
  }
  async deleteProject(projectId: string): Promise<void> {
    if (!projectId || projectId.length > 512) throw new Error('Invalid Laya project ID.');
    await this.remove((record) => record.projectId === projectId);
  }
  async deleteConversations(conversationIds: string[]): Promise<void> {
    const ids = new Set(conversationIds);
    if (ids.size) await this.remove((record) => !!record.conversationId && ids.has(record.conversationId));
  }
}
