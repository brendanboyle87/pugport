import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const contractRoots = ['src/server', 'src/electron', 'src/shared'];
const contractFiles = ['package.json', 'package-lock.json', 'scripts/build.mjs', 'scripts/ui-release.mjs'];
const runtimeFiles = ['dist/server/main.js', 'dist/electron/main.cjs', 'dist/electron/preload.cjs'];
const digest = (value) => createHash('sha256').update(value).digest('hex');
export const newUiBuildId = () => `ui-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

export async function checkedUiStaging(root, staging, buildId) {
  // A staging path written under the root as given (macOS /var/... for /private/var/...) is the same place.
  const given = resolve(root);
  root = await realpath(root);
  staging = resolve(given, staging);
  const below = relative(given, staging);
  if (below && below !== '..' && !below.startsWith(`..${sep}`) && !isAbsolute(below)) staging = join(root, below);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(buildId)) throw new Error('Invalid UI build id.');
  const dist = join(root, 'dist');
  await mkdir(dist, { recursive: true });
  if (relative(dist, await realpath(dist))) throw new Error('UI build dist directory must not be redirected.');
  const releases = join(dist, 'ui-releases');
  await mkdir(releases, { recursive: true });
  if (relative(releases, await realpath(releases))) throw new Error('UI release directory must not be redirected.');
  const expected = join(releases, `.staging-${buildId}`);
  if (relative(expected, resolve(root, staging))) throw new Error('UI staging directory is outside its build root.');
  try {
    if (relative(expected, await realpath(expected)) || !(await stat(expected)).isDirectory())
      throw new Error('UI staging directory must not be redirected.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return expected;
}

async function filesUnder(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error(`UI build cannot follow symbolic links: ${path}`);
    if (entry.isDirectory()) result.push(...(await filesUnder(join(directory, entry.name), `${path}/`)));
    else if (entry.isFile()) result.push(path);
  }
  return result.sort();
}

export async function uiCompatibility(root) {
  const paths = [...contractFiles];
  for (const directory of contractRoots)
    paths.push(...(await filesUnder(join(root, directory))).map((file) => `${directory}/${file}`));
  const hash = createHash('sha256');
  for (const path of paths.sort())
    hash
      .update(path)
      .update('\0')
      .update(await readFile(join(root, path)))
      .update('\0');
  return hash.digest('hex');
}

export async function writeJsonAtomic(path, value) {
  await mkdir(resolve(path, '..'), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function runtimeHashes(root) {
  return Object.fromEntries(
    await Promise.all(runtimeFiles.map(async (path) => [path, digest(await readFile(join(root, path)))])),
  );
}

export async function requireUiBaseline(root, compatibility) {
  let baseline;
  try {
    baseline = JSON.parse(await readFile(join(root, 'dist/ui-contract.json'), 'utf8'));
  } catch {
    throw new Error('UI-only updates need one complete npm run build first.');
  }
  if (baseline.compatibility !== compatibility)
    throw new Error(
      'Backend, desktop, shared contract or dependencies changed. Run a full build and restart before a UI-only update.',
    );
  if (JSON.stringify(baseline.runtimeHashes) !== JSON.stringify(await runtimeHashes(root)))
    throw new Error('Built backend or desktop changed since the baseline. Run a complete build first.');
  return baseline;
}

// This runs before the module entry, including when the new module cannot be downloaded or evaluated.
export function uiBootstrap(buildId, compatibility) {
  let ready = false;
  let recovering = false;
  const key = 'pugport-ui-failed-builds';
  async function recover() {
    if (ready || recovering) return;
    recovering = true;
    try {
      const failed = JSON.parse(sessionStorage.getItem(key) || '[]');
      if (!Array.isArray(failed) || failed.includes(buildId) || failed.length >= 32) return;
      sessionStorage.setItem(key, JSON.stringify([...failed, buildId]));
      const session = await fetch('/api/session', { cache: 'no-store' });
      if (!session.ok) return;
      const { token } = await session.json();
      const response = await fetch('/api/ui-release/fallback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-agent-token': token },
        body: JSON.stringify({ buildId }),
        cache: 'no-store',
      });
      if (!response.ok || ready) return;
      const fallback = await response.json();
      if (fallback.compatibility !== compatibility || fallback.buildId === buildId || failed.includes(fallback.buildId))
        return;
      const url = new URL(fallback.url, location.origin);
      if (url.origin !== location.origin || url.pathname !== '/' || url.search !== `?uiBuild=${fallback.buildId}`)
        return;
      location.replace(url.href);
    } catch {
      // Leave this window alone if storage, the server, or the fallback is unavailable.
    }
  }
  const timeout = setTimeout(recover, 20_000);
  addEventListener(
    'pugport:ui-ready',
    () => {
      ready = true;
      clearTimeout(timeout);
    },
    { once: true },
  );
  addEventListener(
    'error',
    (event) => {
      if (event.target instanceof HTMLScriptElement || event.error) void recover();
    },
    true,
  );
  addEventListener('unhandledrejection', () => void recover());
}

export async function finishUiDirectory(directory, release) {
  const index = join(directory, 'index.html');
  const html = await readFile(index, 'utf8');
  if (!html.includes('</head>') || !html.includes('type="module"'))
    throw new Error('UI build is missing its HTML module entry.');
  const assets = await filesUnder(directory);
  const prefix = `/ui-releases/${release.buildId}/`;
  for (const tag of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    const source = /\b(?:src|href)=["']([^"']+)["']/i.exec(tag[0])?.[1];
    if (!source || (tag[0].startsWith('<link') && !/\brel=["'](?:stylesheet|modulepreload)["']/i.test(tag[0])))
      continue;
    if (!source.startsWith(prefix) || !assets.includes(source.slice(prefix.length)))
      throw new Error('UI executable assets must be complete, local files in this release.');
  }
  const bootstrap = `<script>(${uiBootstrap.toString()})(${JSON.stringify(release.buildId)},${JSON.stringify(release.compatibility)});</script>`;
  await writeFile(index, html.replace('<head>', `<head>${bootstrap}`));
  const manifest = { schema: 1, ...release, assets };
  await writeJsonAtomic(join(directory, 'ui-release.json'), manifest);
  return manifest;
}

export async function saveUiBaseline(root, release, staging) {
  staging = await checkedUiStaging(root, staging, release.buildId);
  root = await realpath(root);
  const legacy = join(root, 'dist/ui');
  await mkdir(legacy, { recursive: true });
  if (relative(legacy, await realpath(legacy))) throw new Error('UI baseline directory must not be redirected.');
  if ((await uiCompatibility(root)) !== release.compatibility)
    throw new Error('The backend contract changed during the full build. Run the build again.');
  const directory = join(root, 'dist/ui-releases', release.buildId);
  await rename(staging, directory);
  // Keep the conventional package/doctor entry and legacy assets without deleting files used by old windows.
  await cp(directory, legacy, { recursive: true });
  await writeJsonAtomic(join(root, 'dist/ui-contract.json'), { ...release, runtimeHashes: await runtimeHashes(root) });
  await writeJsonAtomic(join(root, 'dist/ui-releases/active.json'), { buildId: release.buildId });
}

export async function buildUiOnly(root, viteBuild) {
  root = await realpath(root);
  const compatibility = await uiCompatibility(root);
  const baseline = await requireUiBaseline(root, compatibility);
  let previousBuildId = baseline.buildId;
  try {
    const active = JSON.parse(await readFile(join(root, 'dist/ui-releases/active.json'), 'utf8'));
    if (/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(active.buildId) && active.buildId !== baseline.buildId) {
      const previous = JSON.parse(
        await readFile(join(root, 'dist/ui-releases', active.buildId, 'ui-release.json'), 'utf8'),
      );
      if (previous.buildId === active.buildId && previous.compatibility === compatibility)
        previousBuildId = active.buildId;
    }
  } catch {}
  const buildId = newUiBuildId();
  const releases = join(root, 'dist/ui-releases');
  const staging = await checkedUiStaging(root, join(releases, `.staging-${buildId}`), buildId);
  try {
    await viteBuild({
      configFile: join(root, 'src/ui/vite.config.ts'),
      base: `/ui-releases/${buildId}/`,
      define: {
        __PUGPORT_UI_BUILD_ID__: JSON.stringify(buildId),
        __PUGPORT_UI_COMPATIBILITY__: JSON.stringify(compatibility),
      },
      build: { outDir: staging, emptyOutDir: true },
    });
    await finishUiDirectory(staging, { buildId, compatibility, previousBuildId });
    if ((await uiCompatibility(root)) !== compatibility)
      throw new Error('The backend contract changed during the UI build. Nothing was activated.');
    await requireUiBaseline(root, compatibility);
    await rename(staging, join(releases, buildId));
    await writeJsonAtomic(join(releases, 'active.json'), { buildId });
    return { buildId, compatibility, previousBuildId };
  } finally {
    await rm(await checkedUiStaging(root, staging, buildId), { recursive: true, force: true });
  }
}
