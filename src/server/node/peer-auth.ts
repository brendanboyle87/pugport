import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { writePrivateConfig } from '../private-config.ts';
import {
  formatPairingCode,
  maxPeers,
  normalizePairingCode,
  pairingAlphabet,
  pairingAttempts,
  pairingCodeLength,
  pairingLifetimeMs,
  peerTokenPattern,
} from './peer-protocol.ts';

const peerSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(60),
    /** sha256 of the bearer token; the token itself is only ever held by the paired PugPort. */
    tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
    pairedAt: z.string().max(40),
  })
  .strict();
const fileSchema = z
  .object({ version: z.literal(1), nodeId: z.string().uuid().optional(), peers: z.array(peerSchema).max(maxPeers) })
  .strict();
export type PeerRecord = z.infer<typeof peerSchema>;
export type PeerSummary = { id: string; name: string; pairedAt: string; lastSeenAt?: string };

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest();

/**
 * The PugPorts allowed to use this node. A short one-time code (printed by `pugport node pair`) is exchanged once
 * for a random token; only the token's hash is kept here, in the per-user secrets folder.
 */
export class PeerRegistry {
  private peers: PeerRecord[] = [];
  private text = '';
  nodeId?: string;
  private loaded = false;
  private pairing?: { hash: Buffer; expiresAt: number; attemptsLeft: number };
  private readonly lastSeen = new Map<string, number>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly options: { now?: () => number; helperTimeoutMs?: number } = {},
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }

  /** A damaged file is refused rather than overwritten: nobody is let in until it is fixed or removed. */
  async load() {
    let text = '';
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取已配对设备的记录。');
    }
    try {
      const data = text ? fileSchema.parse(JSON.parse(text)) : { peers: [], nodeId: undefined };
      this.peers = data.peers;
      this.nodeId = data.nodeId;
    } catch {
      throw new Error('已配对设备的记录格式无效，未覆盖原文件。');
    }
    this.text = text;
    this.loaded = true;
    if (text && !this.nodeId) await this.save((peers) => peers);
  }

  list(): PeerSummary[] {
    return this.peers.map(({ id, name, pairedAt }) => {
      const seen = this.lastSeen.get(id);
      return { id, name, pairedAt, ...(seen ? { lastSeenAt: new Date(seen).toISOString() } : {}) };
    });
  }

  /** A new code replaces any earlier one; it lasts ten minutes, works once, and five wrong guesses void it. */
  createCode() {
    const code = Array.from(
      { length: pairingCodeLength },
      () => pairingAlphabet[randomInt(pairingAlphabet.length)],
    ).join('');
    const expiresAt = this.now() + pairingLifetimeMs;
    this.pairing = { hash: sha256(code), expiresAt, attemptsLeft: pairingAttempts };
    return { code: formatPairingCode(code), expiresAt: new Date(expiresAt).toISOString() };
  }
  pairingExpiresAt(): string | undefined {
    const pairing = this.pairing;
    return pairing && pairing.expiresAt > this.now() ? new Date(pairing.expiresAt).toISOString() : undefined;
  }

  /** `no-code`: nothing is waiting to be paired; `wrong`: the code does not match (the attempt is used up). */
  async pair(code: string, name: string): Promise<{ peer: PeerRecord; token: string } | 'no-code' | 'wrong' | 'full'> {
    if (!this.loaded) throw new Error('已配对设备的记录还没读好，请稍后再试。');
    const pairing = this.pairing;
    if (!pairing || pairing.expiresAt <= this.now() || pairing.attemptsLeft <= 0) {
      this.pairing = undefined;
      return 'no-code';
    }
    const supplied = sha256(normalizePairingCode(code));
    if (!timingSafeEqual(supplied, pairing.hash)) {
      pairing.attemptsLeft--;
      if (pairing.attemptsLeft <= 0) this.pairing = undefined;
      return 'wrong';
    }
    // Used up before anything is awaited, so two requests with the right code cannot both pair.
    this.pairing = undefined;
    if (this.peers.length >= maxPeers) return 'full';
    const token = randomBytes(32).toString('base64url');
    const peer: PeerRecord = {
      id: randomUUID(),
      name: name.trim(),
      tokenHash: sha256(token).toString('hex'),
      pairedAt: new Date(this.now()).toISOString(),
    };
    await this.save((peers) => [...peers, peer]);
    return { peer, token };
  }

  /** The peer this bearer token belongs to. Every stored hash is compared, in constant time, whatever matches. */
  authenticate(token: string | undefined): PeerRecord | undefined {
    if (typeof token !== 'string' || !peerTokenPattern.test(token)) return undefined;
    const supplied = sha256(token);
    let found: PeerRecord | undefined;
    for (const peer of this.peers) {
      const same = timingSafeEqual(supplied, Buffer.from(peer.tokenHash, 'hex'));
      if (same && !found) found = peer;
    }
    if (found) this.lastSeen.set(found.id, this.now());
    return found;
  }

  async revoke(id: string): Promise<boolean> {
    if (!this.peers.some((peer) => peer.id === id)) return false;
    await this.save((peers) => peers.filter((peer) => peer.id !== id));
    this.lastSeen.delete(id);
    return true;
  }
  async revokeAll(): Promise<number> {
    const count = this.peers.length;
    if (count) await this.save(() => []);
    this.lastSeen.clear();
    return count;
  }

  private save(change: (peers: PeerRecord[]) => PeerRecord[]) {
    const next = this.writes
      .catch(() => {})
      .then(async () => {
        const peers = change(this.peers);
        const nodeId = this.nodeId ?? randomUUID();
        const text = JSON.stringify(fileSchema.parse({ version: 1, nodeId, peers }), null, 2) + '\n';
        await writePrivateConfig(this.file, text, this.text, this.options.helperTimeoutMs);
        this.nodeId = nodeId;
        this.peers = peers;
        this.text = text;
      });
    this.writes = next;
    return next;
  }
}

/**
 * Failed sign-ins and pairing guesses per remote address: after `limit` failures within the window, that address
 * is turned away until the window has passed.
 */
export class FailureLimiter {
  private readonly failures = new Map<string, number[]>();
  constructor(
    private readonly limit = 10,
    private readonly windowMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}
  private recent(key: string) {
    const since = this.now() - this.windowMs;
    const kept = (this.failures.get(key) ?? []).filter((at) => at > since);
    if (kept.length) this.failures.set(key, kept);
    else this.failures.delete(key);
    return kept;
  }
  blocked(key: string) {
    return this.recent(key).length >= this.limit;
  }
  fail(key: string) {
    const kept = this.recent(key);
    kept.push(this.now());
    this.failures.set(key, kept);
    // A flood of addresses must not grow this without bound: the oldest entries go first.
    while (this.failures.size > 1000) this.failures.delete(this.failures.keys().next().value!);
  }
}
