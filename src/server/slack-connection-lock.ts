import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  ftruncateSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { currentHost, type Host } from './platform/host.ts';
import { restrictDirectory } from './platform/secure-file.ts';
import { processStartTime } from './platform/server-lock.ts';
import { writePrivateConfig } from './private-config.ts';

type Owner = {
  id: string;
  pid: number;
  processStartedAt?: string;
  processIdentityFormat?: string;
  role: 'desktop' | 'node';
  startedAt: number;
  heartbeatAt: number;
};
export type SlackLockOptions = {
  directory: string;
  role: Owner['role'];
  pid?: number;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
  getProcessStartTime?: (pid: number) => string | undefined;
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

/** Slack uses UTC ps output (or Windows CreationDate epoch milliseconds), without changing backend locks. */
export function slackProcessStartTime(pid: number, host: Host = currentHost()): string | undefined {
  return processStartTime(pid, { ...host, env: { ...host.env, TZ: 'UTC0' } });
}

/** A nonempty directory makes rename an atomic, no-replace operation on both Windows and POSIX. */
export class SlackConnectionLock {
  private owner?: Owner;
  private path?: string;
  private timer?: ReturnType<typeof setInterval>;
  private readonly now: () => number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly getProcessStartTime: (pid: number) => string | undefined;
  constructor(private readonly options: SlackLockOptions) {
    this.now = options.now ?? Date.now;
    this.isAlive = options.isAlive ?? alive;
    this.getProcessStartTime = options.getProcessStartTime ?? slackProcessStartTime;
  }
  private read(path: string): Owner | undefined {
    try {
      const owner = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')) as Owner;
      if (
        !/^[a-f0-9-]{36}$/.test(owner.id) ||
        !Number.isSafeInteger(owner.pid) ||
        owner.pid <= 0 ||
        (owner.processStartedAt !== undefined &&
          (typeof owner.processStartedAt !== 'string' || !owner.processStartedAt)) ||
        !Number.isFinite(owner.startedAt) ||
        !Number.isFinite(owner.heartbeatAt) ||
        !['desktop', 'node'].includes(owner.role)
      )
        return;
      return owner;
    } catch {
      return;
    }
  }
  private retired(path: string, id: string) {
    return `${path}.released-${id}`;
  }
  private retire(path: string, owner: Pick<Owner, 'id'>): boolean {
    try {
      // Keep this nonempty marker: a delayed contender for this generation must not rename its successor.
      renameSync(path, this.retired(path, owner.id));
      return true;
    } catch {
      return false;
    }
  }
  private retireCorrupt(path: string): boolean {
    try {
      const directory = statSync(path, { bigint: true });
      const file = join(path, 'owner.json');
      // Unreadable or missing records still fail closed; only old corrupt records are reclaimable.
      readFileSync(file, 'utf8');
      if (this.now() - statSync(file).mtimeMs <= 90_000 || this.read(path)) return false;
      // All contenders for this directory generation use the same nonempty retirement marker.
      const id = createHash('sha256')
        .update(`${directory.dev}:${directory.ino}:${directory.birthtimeNs}`)
        .digest('hex');
      return this.retire(path, { id: `corrupt-${id}` });
    } catch {
      return false;
    }
  }
  owns(): boolean {
    return !!this.owner && !!this.path && this.read(this.path)?.id === this.owner.id;
  }
  private holderAlive(owner: Owner): boolean {
    if (!this.isAlive(owner.pid)) return false;
    // Legacy records and OS lookup failures cannot prove that a live holder's socket is gone.
    if (!owner.processStartedAt || owner.processIdentityFormat !== 'utc-v1') return true;
    if (this.now() - owner.heartbeatAt <= 90_000) return true;
    const started = this.getProcessStartTime(owner.pid);
    return started === undefined || started === owner.processStartedAt;
  }
  async acquire(appId: string, onLost: () => void): Promise<boolean> {
    if (this.owner) return this.owns();
    if (!/^A[A-Z0-9]+$/.test(appId)) throw new Error('Slack app identity is unavailable.');
    const hash = createHash('sha256').update(appId).digest('hex');
    const path = join(this.options.directory, `slack-${hash}.lock`);
    const now = this.now();
    const owner: Owner = {
      id: randomUUID(),
      pid: this.options.pid ?? process.pid,
      processStartedAt: this.getProcessStartTime(this.options.pid ?? process.pid),
      processIdentityFormat: 'utc-v1',
      role: this.options.role,
      startedAt: now,
      heartbeatAt: now,
    };
    const candidate = `${path}.${owner.id}.tmp`;
    await mkdir(candidate, { recursive: true, mode: 0o700 });
    try {
      await restrictDirectory(candidate);
      await writePrivateConfig(join(candidate, 'owner.json'), JSON.stringify(owner), '');
      const current = this.read(path);
      if (current) {
        if (this.holderAlive(current) && !existsSync(join(path, `closed-${current.id}`))) {
          if (this.now() - current.heartbeatAt > 90_000) {
            // A paused live process may still have a socket. Ask it to close; only its release confirms that.
            try {
              writeFileSync(join(path, `takeover-${current.id}`), '', { flag: 'wx', mode: 0o600 });
            } catch (error) {
              if (!['EEXIST', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
            }
          }
          return false;
        }
        if (!this.retire(path, current)) return false;
      } else if (existsSync(path) && !this.retireCorrupt(path)) return false;
      try {
        renameSync(candidate, path);
      } catch (error) {
        if (existsSync(path)) return false;
        throw error;
      }
      this.path = path;
      this.owner = owner;
      this.timer = setInterval(() => {
        if (!this.heartbeat()) onLost();
      }, 30_000);
      this.timer.unref();
      process.once('exit', this.onExit);
      return true;
    } finally {
      await rm(candidate, { recursive: true, force: true });
    }
  }
  heartbeat(): boolean {
    if (!this.owns()) {
      return false;
    }
    let fd: number | undefined;
    try {
      if (existsSync(join(this.path!, `takeover-${this.owner!.id}`))) return false;
      fd = openSync(join(this.path!, 'owner.json'), 'r+');
      if (JSON.parse(readFileSync(fd, 'utf8')).id !== this.owner!.id) return false;
      this.owner!.heartbeatAt = this.now();
      // Write through the descriptor, never a path which a takeover could replace.
      const record = Buffer.from(JSON.stringify(this.owner));
      let written = 0;
      while (written < record.length) written += writeSync(fd, record, written, record.length - written, written);
      ftruncateSync(fd, written);
      return true;
    } catch {
      return false;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  private onExit = () => {
    try {
      this.release();
    } catch {
      /* A dead pid is reclaimable even if final filesystem cleanup failed. */
    }
  };
  release() {
    if (this.owns()) {
      // This is written only after socket close (or a cancelled attempt which never opened one).
      // If directory rename is temporarily refused, another process can still confirm release and reclaim it.
      const marker = join(this.path!, `closed-${this.owner!.id}`);
      try {
        writeFileSync(marker, '', { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      this.retire(this.path!, this.owner!);
    }
    clearInterval(this.timer);
    process.removeListener('exit', this.onExit);
    this.owner = undefined;
    this.path = undefined;
  }
}
