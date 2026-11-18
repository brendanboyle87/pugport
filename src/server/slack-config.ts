import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { secretsDirectory } from './api-providers.ts';
import { writePrivateConfig } from './private-config.ts';

const userSchema = z
  .object({
    id: z.string().regex(/^[UW][A-Z0-9]{2,30}$/),
    name: z.string().max(200).optional(),
    pairedAt: z.string().max(40),
    isOwner: z.boolean().optional(),
  })
  .strict();
const configSchema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    appToken: z.string().max(1000).optional(),
    botToken: z.string().max(1000).optional(),
    users: z.array(userSchema).max(100),
  })
  .strict();
export type SlackConfig = z.infer<typeof configSchema>;
export type SlackUser = z.infer<typeof userSchema>;

const empty = (): SlackConfig => ({ version: 1, enabled: false, users: [] });
export const validSlackUserId = (id: string) => /^[UW][A-Z0-9]{2,30}$/.test(id);

export function validAppToken(token: string): string {
  const value = token.trim();
  if (!/^xapp-[A-Za-z0-9-]{10,1000}$/.test(value)) throw new Error('App-Level Token 应以 xapp- 开头，请重新复制。');
  return value;
}

export function validBotToken(token: string): string {
  const value = token.trim();
  if (!/^xoxb-[A-Za-z0-9-]{10,1000}$/.test(value)) throw new Error('Bot Token 应以 xoxb- 开头，请重新复制。');
  return value;
}

/**
 * Slack tokens and the paired users live in the per-user secrets folder, outside the data folder (which may sync
 * to the cloud), readable only by this Windows user. Who may give commands is part of that secret state.
 * A node keeps a handed-over setup in slack-gateway-node.json, separate from the desktop's slack-gateway.json.
 */
export class SlackConfigStore {
  private cache?: SlackConfig;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly file = join(secretsDirectory(), 'slack-gateway.json'),
    private readonly aclHelperTimeoutMs?: number,
  ) {}
  get secretsDir() {
    return dirname(this.file);
  }
  async exists(): Promise<boolean> {
    try {
      await lstat(this.file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  /** Publish a complete private copy without replacing even an empty or concurrently created file. */
  copyIfAbsent(config: SlackConfig): Promise<boolean> {
    const next = this.writes
      .catch(() => {})
      .then(async () => {
        if (await this.exists()) return false;
        const parsed = configSchema.parse(config);
        const temporary = `${this.file}.${randomUUID()}.copy`;
        try {
          await writePrivateConfig(temporary, JSON.stringify(parsed, null, 2) + '\n', '', this.aclHelperTimeoutMs);
          // rename publishes the private temporary; link is the atomic no-replace publication of the final name.
          try {
            await link(temporary, this.file);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
            throw error;
          }
          this.cache = parsed;
          return true;
        } finally {
          await unlink(temporary).catch(() => {});
        }
      });
    this.writes = next;
    return next;
  }
  /** Which PugPort conversation each Slack thread continues: not secret, so a plain file next to this one. */
  get threadsFile() {
    return join(dirname(this.file), 'slack-threads.json');
  }
  private async load(): Promise<{ config: SlackConfig; text: string }> {
    let text = '';
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取本机 Slack 设置。');
    }
    try {
      return { text, config: text ? configSchema.parse(JSON.parse(text)) : empty() };
    } catch {
      throw new Error('本机 Slack 设置格式无效，未覆盖原文件。');
    }
  }
  async read(): Promise<SlackConfig> {
    this.cache ??= (await this.load()).config;
    return structuredClone(this.cache);
  }
  update<T>(mutate: (config: SlackConfig) => T): Promise<T> {
    const next = this.writes
      .catch(() => {})
      .then(async () => {
        const { config, text } = await this.load();
        const result = mutate(config);
        const parsed = configSchema.parse(config);
        await writePrivateConfig(this.file, JSON.stringify(parsed, null, 2) + '\n', text, this.aclHelperTimeoutMs);
        this.cache = parsed;
        return result;
      });
    this.writes = next;
    return next;
  }
}

const threadSchema = z
  .object({
    conversationId: z.string().min(1).max(200),
    lastTs: z.string().regex(/^\d{1,12}\.\d{1,9}$/),
    usedAt: z.string().max(40),
  })
  .strict();
const threadsSchema = z
  .object({ version: z.literal(1), threads: z.record(z.string().max(200), threadSchema) })
  .strict();
export type SlackThreadRecord = z.infer<typeof threadSchema>;
const threadLifetimeMs = 30 * 24 * 60 * 60 * 1000;

/** Lets a follow-up continue the same PugPort conversation after a restart; threads unused for 30 days drop out. */
export class SlackThreadStore {
  private threads?: Map<string, SlackThreadRecord>;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}
  private fresh = (record: SlackThreadRecord) => this.now() - Date.parse(record.usedAt) < threadLifetimeMs;
  private async load() {
    if (this.threads) return this.threads;
    let saved: Record<string, SlackThreadRecord> = {};
    try {
      saved = threadsSchema.parse(JSON.parse(await readFile(this.file, 'utf8'))).threads;
    } catch {
      // Missing or unreadable: follow-ups start new conversations, nothing else is lost.
    }
    this.threads ??= new Map(Object.entries(saved).filter(([, record]) => this.fresh(record)));
    return this.threads;
  }
  async get(key: string): Promise<SlackThreadRecord | undefined> {
    const record = (await this.load()).get(key);
    return record && this.fresh(record) ? record : undefined;
  }
  set(key: string, record: Omit<SlackThreadRecord, 'usedAt'>): Promise<void> {
    const next = this.writes
      .catch(() => {})
      .then(async () => {
        const threads = await this.load();
        threads.delete(key);
        threads.set(key, { ...record, usedAt: new Date(this.now()).toISOString() });
        for (const [old, value] of threads) if (!this.fresh(value)) threads.delete(old);
        while (threads.size > 2000) threads.delete(threads.keys().next().value!);
        await mkdir(dirname(this.file), { recursive: true });
        const text = JSON.stringify({ version: 1, threads: Object.fromEntries(threads) }, null, 2) + '\n';
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, text);
          // Windows refuses to replace a file another process (a virus scan, a reader) has open; retry briefly.
          for (let attempt = 1; ; attempt++)
            try {
              await rename(temporary, this.file);
              break;
            } catch (error) {
              if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? ''))
                throw error;
              await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
            }
        } finally {
          await unlink(temporary).catch(() => {});
        }
      });
    this.writes = next;
    return next;
  }
  /** Waits for saves already started, so quitting keeps the latest map. */
  flush(): Promise<void> {
    return this.writes.then(
      () => undefined,
      () => undefined,
    );
  }
}
