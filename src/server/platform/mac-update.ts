import { createHash, createPublicKey, verify } from 'node:crypto';
import * as childProcess from './test-process.ts';
import { currentHost, type Host } from './host.ts';
import {
  isNewerVersion,
  MAC_UPDATE_APP_NAME,
  MAC_UPDATE_PUBLIC_KEY,
  MAC_UPDATE_ROOT,
  type MacUpdateError,
  type MacUpdateManifest,
} from '../../shared/app-update.ts';

/** Larger archives are refused whatever the manifest says. */
export const MAC_UPDATE_MAX_BYTES = 1024 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 64 * 1024;
const SIGNATURE_MAX_BYTES = 1024;

export class MacUpdateFailure extends Error {
  constructor(
    readonly reason: MacUpdateError,
    detail: string = reason,
  ) {
    super(`Mac update refused: ${detail}`);
  }
}

export type MacUpdateFeed = { root: string; arch: 'arm64' | 'x64' };

/**
 * Where this Mac reads updates, or undefined on other systems. `PUGPORT_UPDATE_ROOT` may point a source checkout at a
 * loopback test server; the packaged app always reads the release feed.
 */
export function macUpdateFeed(
  options: { packaged: boolean; env?: NodeJS.ProcessEnv; arch?: string },
  host: Host = currentHost(),
): MacUpdateFeed | undefined {
  if (host.platform !== 'darwin') return;
  const arch = options.arch ?? process.arch;
  if (arch !== 'arm64' && arch !== 'x64') return;
  const override = options.env?.PUGPORT_UPDATE_ROOT;
  const local = !options.packaged && !!override && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(override);
  return { root: local ? override! : MAC_UPDATE_ROOT, arch };
}

async function readLimited(response: Response, max: number, reason: MacUpdateError): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) throw new MacUpdateFailure(reason, 'too large');
  if (!response.body) throw new MacUpdateFailure(reason, 'empty');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > max) throw new MacUpdateFailure(reason, 'too large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Checks the signature over the exact bytes first, then every field. Anything unexpected is refused. */
export function verifyMacManifest(
  body: Uint8Array,
  signature: string,
  options: { feed: MacUpdateFeed; currentVersion: string; publicKey?: string },
): MacUpdateManifest {
  const encoded = signature.trim();
  if (!/^[A-Za-z0-9+/]{86}==$/.test(encoded)) throw new MacUpdateFailure('manifest', 'signature format');
  let signed = false;
  try {
    signed = verify(
      null,
      body,
      createPublicKey(options.publicKey ?? MAC_UPDATE_PUBLIC_KEY),
      Buffer.from(encoded, 'base64'),
    );
  } catch {
    signed = false;
  }
  if (!signed) throw new MacUpdateFailure('manifest', 'signature');
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(body).toString('utf8'));
  } catch {
    throw new MacUpdateFailure('manifest', 'JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MacUpdateFailure('manifest', 'shape');
  const { version, url, sha256, size, releasedAt } = value as Record<string, unknown>;
  if (
    typeof version !== 'string' ||
    typeof url !== 'string' ||
    typeof sha256 !== 'string' ||
    typeof releasedAt !== 'string' ||
    typeof size !== 'number'
  )
    throw new MacUpdateFailure('manifest', 'fields');
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new MacUpdateFailure('manifest', 'sha256');
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAC_UPDATE_MAX_BYTES)
    throw new MacUpdateFailure('manifest', 'size');
  if (!Number.isFinite(Date.parse(releasedAt))) throw new MacUpdateFailure('manifest', 'releasedAt');
  const prefix = `${options.feed.root}/mac/${options.feed.arch}/`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MacUpdateFailure('manifest', 'url');
  }
  // An exact round trip rules out dot segments, escapes and credentials that would move the file elsewhere.
  if (
    parsed.href !== url ||
    !url.startsWith(prefix) ||
    !/^[A-Za-z0-9._-]+\.zip$/.test(url.slice(prefix.length)) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new MacUpdateFailure('manifest', 'url');
  if (!isNewerVersion(version, options.currentVersion)) throw new MacUpdateFailure('not-newer');
  return { version, url, sha256, size, releasedAt };
}

/** Reads and verifies `latest.json` and its signature for this Mac's architecture. */
export async function fetchMacManifest(
  feed: MacUpdateFeed,
  options: { currentVersion: string; fetch?: typeof fetch; signal?: AbortSignal; publicKey?: string },
): Promise<MacUpdateManifest> {
  const base = `${feed.root}/mac/${feed.arch}/`;
  const get = async (name: string, max: number) => {
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(base + name, {
        headers: { 'User-Agent': 'PugPort' },
        cache: 'no-store',
        redirect: 'error',
        signal: options.signal,
      });
    } catch {
      throw new MacUpdateFailure('network');
    }
    if (!response.ok)
      throw new MacUpdateFailure(response.status >= 500 ? 'network' : 'manifest', `HTTP ${response.status}`);
    try {
      return await readLimited(response, max, 'manifest');
    } catch (error) {
      throw error instanceof MacUpdateFailure ? error : new MacUpdateFailure('network');
    }
  };
  // The signature is read only once a manifest exists, so an empty feed costs one request.
  const body = await get('latest.json', MANIFEST_MAX_BYTES);
  const signature = await get('latest.json.sig', SIGNATURE_MAX_BYTES);
  return verifyMacManifest(body, signature.toString('utf8'), {
    feed,
    currentVersion: options.currentVersion,
    publicKey: options.publicKey,
  });
}

/** Streams the archive to `file` (which must not exist), refusing more bytes than declared or a different hash. */
export async function downloadMacUpdate(
  manifest: MacUpdateManifest,
  file: string,
  options: {
    fetch?: typeof fetch;
    signal?: AbortSignal;
    onProgress?: (received: number, total: number) => void;
    host?: Host;
  } = {},
): Promise<void> {
  const host = options.host ?? currentHost();
  if (manifest.size > MAC_UPDATE_MAX_BYTES) throw new MacUpdateFailure('download', 'too large');
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(manifest.url, {
      headers: { 'User-Agent': 'PugPort' },
      redirect: 'error',
      signal: options.signal,
    });
  } catch {
    throw new MacUpdateFailure('network');
  }
  if (!response.ok || !response.body) throw new MacUpdateFailure('download', `HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > manifest.size) throw new MacUpdateFailure('download', 'too large');
  const hash = createHash('sha256');
  const output = await host.fs.promises.open(file, 'wx', 0o600);
  let received = 0;
  try {
    for await (const chunk of response.body) {
      received += chunk.byteLength;
      if (received > manifest.size) throw new MacUpdateFailure('download', 'larger than declared');
      hash.update(chunk);
      await output.write(chunk);
      options.onProgress?.(received, manifest.size);
    }
  } catch (error) {
    throw error instanceof MacUpdateFailure ? error : new MacUpdateFailure('network');
  } finally {
    await output.close();
  }
  if (received !== manifest.size) throw new MacUpdateFailure('download', 'incomplete');
  if (hash.digest('hex') !== manifest.sha256) throw new MacUpdateFailure('checksum');
}

/**
 * Unpacks with `ditto -x -k` into an empty `directory`, then requires exactly `PugPort.app`, the manifest's version
 * in its Info.plist, and a passing `codesign --verify --deep --strict`. Returns the app's path.
 */
export async function unpackMacUpdate(
  zip: string,
  directory: string,
  version: string,
  host: Host = currentHost(),
): Promise<string> {
  const timeout = 5 * 60_000;
  try {
    await host.run('/usr/bin/ditto', ['-x', '-k', zip, directory], { timeout });
  } catch {
    throw new MacUpdateFailure('package', 'unpack');
  }
  const entries = host.fs.readdirSync(directory);
  if (entries.length !== 1 || entries[0] !== MAC_UPDATE_APP_NAME) throw new MacUpdateFailure('package', 'name');
  const app = host.path.join(directory, MAC_UPDATE_APP_NAME);
  if (!host.fs.lstatSync(app).isDirectory()) throw new MacUpdateFailure('package', 'not a bundle');
  let bundleVersion = '';
  try {
    bundleVersion = (
      await host.run('/usr/bin/plutil', [
        '-extract',
        'CFBundleShortVersionString',
        'raw',
        '-o',
        '-',
        host.path.join(app, 'Contents', 'Info.plist'),
      ])
    ).stdout.trim();
  } catch {
    throw new MacUpdateFailure('package', 'Info.plist');
  }
  if (bundleVersion !== version) throw new MacUpdateFailure('package', 'version');
  try {
    await host.run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { timeout });
  } catch {
    throw new MacUpdateFailure('package', 'codesign');
  }
  return app;
}

/**
 * The running .app when one-click install may replace it: the packaged app (not `electron .`), with both the bundle
 * and the folder holding it writable by this user. Otherwise undefined, and the page offers the download link.
 */
export function macInstallTarget(
  options: { packaged: boolean; execPath: string },
  host: Host = currentHost(),
): string | undefined {
  if (host.platform !== 'darwin' || !options.packaged) return;
  const { dirname, basename } = host.path;
  const macos = dirname(options.execPath);
  const contents = dirname(macos);
  const bundle = dirname(contents);
  if (basename(macos) !== 'MacOS' || basename(contents) !== 'Contents' || !bundle.endsWith('.app')) return;
  try {
    host.fs.accessSync(dirname(bundle), host.fs.constants.W_OK);
    host.fs.accessSync(bundle, host.fs.constants.W_OK);
  } catch {
    return;
  }
  return bundle;
}

/**
 * Detached installer: waits for the app to exit, copies the new bundle beside the old one, swaps them by rename,
 * restores the old bundle on any failure, then opens whichever bundle is in place. All values arrive as arguments.
 */
export const MAC_INSTALL_SCRIPT = `pid=$1 target=$2 staged=$3 work=$4 log=$5 opener=$6
shift 6
exec >>"$log" 2>&1
echo "$(date '+%Y-%m-%dT%H:%M:%S') update: waiting for $pid"
n=0
while kill -0 "$pid" 2>/dev/null; do
  n=$((n + 1))
  if [ "$n" -ge 600 ]; then echo "update: the app did not exit; nothing changed"; exit 1; fi
  sleep 0.2
done
dir=$(dirname "$target")
incoming="$dir/.pugport-update-$$.app"
backup="$dir/.pugport-backup-$$.app"
if ! /usr/bin/ditto "$staged" "$incoming"; then
  echo "update: copy failed; keeping the current app"
  /bin/rm -rf "$incoming"
  "$opener" "$@" "$target"
  exit 1
fi
if ! /bin/mv "$target" "$backup"; then
  echo "update: could not move the current app aside; keeping it"
  /bin/rm -rf "$incoming"
  "$opener" "$@" "$target"
  exit 1
fi
if ! /bin/mv "$incoming" "$target"; then
  echo "update: could not move the new app in; restoring the current app"
  /bin/mv "$backup" "$target"
  /bin/rm -rf "$incoming"
  "$opener" "$@" "$target"
  exit 1
fi
/bin/rm -rf "$backup" "$work"
echo "update: installed"
"$opener" "$@" "$target"
`;

/** Variables that choose PugPort's data; `open` would otherwise relaunch with the login session's environment. */
const FORWARDED_ENV = ['COMBORUNNER_DATA_DIR', 'AGENT_STUDIO_DATA_DIR', 'COMBORUNNER_DESKTOP_USER_DATA_DIR'];

export type MacInstallJob = {
  pid: number;
  target: string;
  staged: string;
  work: string;
  log: string;
  env?: NodeJS.ProcessEnv;
  opener?: string;
};

export function macInstallArgs(job: MacInstallJob): string[] {
  const env = job.env ?? {};
  const forwarded = FORWARDED_ENV.flatMap((name) => (env[name] ? ['--env', `${name}=${env[name]}`] : []));
  return [
    '-c',
    MAC_INSTALL_SCRIPT,
    'pugport-update',
    String(job.pid),
    job.target,
    job.staged,
    job.work,
    job.log,
    job.opener ?? '/usr/bin/open',
    ...forwarded,
  ];
}

/** Starts the installer outside this process tree so it outlives the app. */
export function startMacInstall(job: MacInstallJob, spawn: typeof childProcess.spawn = childProcess.spawn): void {
  const child = spawn('/bin/sh', macInstallArgs(job), { detached: true, stdio: 'ignore' });
  child.unref();
}
