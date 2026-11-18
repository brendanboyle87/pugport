import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { writePrivateConfig } from '../private-config.ts';
import { maxPeers, peerTokenPattern } from '../node/peer-protocol.ts';

export const deviceSchema = z
  .object({
    id: z.string().uuid(),
    nodeId: z.string().uuid().optional(),
    /** Explicitly enrolled from this remote-server entry, never inferred from an SSH alias. */
    enrolledServer: z.string().trim().min(1).max(60).optional(),
    name: z.string().min(1).max(24),
    address: z.string().min(1).max(300),
    /** The bearer token the device issued at pairing: this computer's only proof of who it is. */
    token: z.string().regex(peerTokenPattern),
    /** The device's id for this computer, as it lists it. */
    peerId: z.string().max(100),
    pairedAt: z.string().max(40),
    tunnel: z
      .object({
        ssh: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/),
        remotePort: z.number().int().min(1).max(65535),
      })
      .strict()
      .optional(),
    hostname: z.string().max(255).optional(),
    platform: z.string().max(20).optional(),
    folders: z.array(z.string().min(1).max(4000)).max(10).optional(),
    /**
     * The account's tunnel-only SSH key for an enrolled server and where it connects (managed-access.ts), as one
     * secret text: synced next to the token, never in a cloud body. Unreadable text counts as no access.
     */
    access: z.string().max(8192).optional(),
  })
  .strict();
const fileSchema = z
  .object({
    version: z.literal(1),
    devices: z.array(deviceSchema).max(maxPeers),
    /** The device that runs the Slack gateway instead of this computer. */
    slackHost: z.string().uuid().optional(),
    githubHost: z.union([z.string().uuid(), z.literal('self')]).optional(),
  })
  .strict();
export type StoredDevice = z.infer<typeof deviceSchema>;
export type DevicesFile = z.infer<typeof fileSchema>;

/** Paired devices and their tokens, in the per-user secrets folder, readable only by this user. */
export class DeviceStore {
  private cache?: DevicesFile;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly file: string,
    private readonly helperTimeoutMs?: number,
  ) {}
  private async load(): Promise<{ data: DevicesFile; text: string }> {
    let text = '';
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取本机的设备记录。');
    }
    try {
      return { text, data: text ? fileSchema.parse(JSON.parse(text)) : { version: 1, devices: [] } };
    } catch {
      throw new Error('本机的设备记录格式无效，未覆盖原文件。');
    }
  }
  async read(): Promise<DevicesFile> {
    this.cache ??= (await this.load()).data;
    return structuredClone(this.cache);
  }
  async reload(): Promise<DevicesFile> {
    await this.writes;
    this.cache = (await this.load()).data;
    return structuredClone(this.cache);
  }
  /** Synchronous view of what was last read or written (empty before the first read). */
  current(): DevicesFile {
    return structuredClone(this.cache ?? { version: 1, devices: [] });
  }
  update<T>(mutate: (data: DevicesFile) => T): Promise<T> {
    const next = this.writes
      .catch(() => {})
      .then(async () => {
        const { data, text } = await this.load();
        const result = mutate(data);
        const parsed = fileSchema.parse(data);
        await writePrivateConfig(this.file, JSON.stringify(parsed, null, 2) + '\n', text, this.helperTimeoutMs);
        this.cache = parsed;
        return result;
      });
    this.writes = next;
    return next;
  }
}
