/**
 * Mac one-click update: the release feed and the key its manifests are signed with. The release scripts write the
 * same layout: `<root>/mac/<arch>/latest.json` plus `latest.json.sig`, a base64 Ed25519 signature of the exact bytes.
 */
export const MAC_UPDATE_ROOT = 'https://download.pugport.com';
export const MAC_UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA53vN/yibIS0yQmsymAP97Hwc+l8LVIupeCTAZx0eP9g=
-----END PUBLIC KEY-----
`;
/** The bundle name inside every update archive. */
export const MAC_UPDATE_APP_NAME = 'PugPort.app';

export type MacUpdateManifest = { version: string; url: string; sha256: string; size: number; releasedAt: string };

/** Short reasons the update notice can show; the page owns the wording. */
export type MacUpdateError = 'network' | 'manifest' | 'download' | 'checksum' | 'package' | 'install' | 'not-newer';

export type MacUpdateStatus = {
  /** False when one-click install is not possible here (not the packaged app, or its folder is read-only). */
  installable: boolean;
  phase: 'idle' | 'downloading' | 'verifying' | 'ready' | 'installing' | 'error';
  version?: string;
  received?: number;
  total?: number;
  error?: MacUpdateError;
};

function semver(value: string): number[] | undefined {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return;
  const numbers = value.split('.').map(Number);
  return numbers.every(Number.isSafeInteger) ? numbers : undefined;
}

/** True only for two plain x.y.z versions where `next` is strictly newer. */
export function isNewerVersion(next: string, current: string): boolean {
  const a = semver(next);
  const b = semver(current);
  if (!a || !b) return false;
  const differing = a.findIndex((part, index) => part !== b[index]);
  return differing >= 0 && a[differing]! > b[differing]!;
}
