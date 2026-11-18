import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writePrivateConfig } from './private-config.ts';
import { filterSyncValue, stableJson, type SyncValue } from '../shared/account-sync.ts';

export function messageProvenanceHash(owner: string, value: SyncValue): string {
  // Workflow/steering state changes after submission; only author content and provenance bind the marker.
  const filtered = filterSyncValue('message', value);
  const content = Object.fromEntries(
    [
      'id',
      'conversationId',
      'role',
      'content',
      'createdAt',
      'quotes',
      'attachments',
      'untrustedContent',
      'externalRequest',
      'combinedFrom',
    ]
      .filter((k) => Object.hasOwn(filtered, k))
      .map((k) => [k, filtered[k]]),
  );
  return createHash('sha256')
    .update(stableJson([owner, content]))
    .digest('hex');
}

export type EncryptedBody = { v: 1; nonce: string; ciphertext: string; tag: string };
export const createDataKey = () => randomBytes(32);
function encrypt(key: Uint8Array, aad: string, bytes: Uint8Array): EncryptedBody {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad));
  return {
    v: 1,
    nonce: nonce.toString('base64'),
    ciphertext: Buffer.concat([cipher.update(bytes), cipher.final()]).toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}
function decrypt(key: Uint8Array, aad: string, body: EncryptedBody): Buffer {
  try {
    if (
      body.v !== 1 ||
      Buffer.from(body.nonce, 'base64').length !== 12 ||
      Buffer.from(body.tag, 'base64').length !== 16
    )
      throw Error();
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(body.nonce, 'base64'));
    cipher.setAAD(Buffer.from(aad));
    cipher.setAuthTag(Buffer.from(body.tag, 'base64'));
    return Buffer.concat([cipher.update(Buffer.from(body.ciphertext, 'base64')), cipher.final()]);
  } catch {
    throw new Error('AUTHENTICATION_FAILED');
  }
}
export function encryptRecord(key: Uint8Array, kind: string, id: string, value: unknown): EncryptedBody {
  return encrypt(key, JSON.stringify(['pugport-record-v1', kind, id]), Buffer.from(JSON.stringify(value)));
}
export function decryptRecord<T = unknown>(key: Uint8Array, kind: string, id: string, body: EncryptedBody): T {
  try {
    return JSON.parse(decrypt(key, JSON.stringify(['pugport-record-v1', kind, id]), body).toString('utf8')) as T;
  } catch {
    throw new Error('AUTHENTICATION_FAILED');
  }
}
/** Per-computer key that seals the local server-node/API-card mirror rows. Never leaves this computer. */
export async function readLocalSealKey(directory: string): Promise<Buffer> {
  const file = join(directory, 'account-sync-seal.key');
  const text = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const saved = Buffer.from(text.trim(), 'base64');
  if (saved.length === 32) return saved;
  const key = createDataKey();
  await writePrivateConfig(file, key.toString('base64'), text);
  return key;
}
