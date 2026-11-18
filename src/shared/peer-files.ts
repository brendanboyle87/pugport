/** Names crossing the device boundary are single path segments on every supported OS. */
export function safeSegment(value: string): string {
  let name = value
    .replace(/[^\p{L}\p{N}._-]/gu, '_')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  while (new TextEncoder().encode(name).length > 180) name = Array.from(name).slice(0, -1).join('');
  return !name || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(name)
    ? `file_${name || 'unnamed'}`
    : name;
}

export const maxPeerFileSize = 2 * 1024 ** 3;
export const maxPeerFiles = 16;
export const maxPeerFilesSize = 4 * 1024 ** 3;
export const peerFileReserveBytes = 2 * 1024 ** 3;
export const peerTransferIdleMs = 60_000;
export const peerTransferMaxMs = 30 * 60_000;
export const peerTransferLimitMs = (size: number) => Math.max(peerTransferMaxMs, (size / (256 * 1024)) * 1000);
export const maxPeerConcurrentTransfers = 4;
export const peerUploadWindowMs = 10 * 60_000;
export const maxPeerWindowFiles = 64;
export const maxPeerWindowBytes = 4 * 1024 ** 3;
export const uploadByteQuota = (batch: number, window: number, size: number, maxWindow = maxPeerWindowBytes) =>
  batch + size > maxPeerFilesSize ? 'batch' : window + size > maxWindow ? 'window' : undefined;
