// Inspect an already-built package. Never launches the application or a model.
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageLayout, packageTarget } from './package-policy.mjs';

export function verifyLitePackage(packageDirectory) {
  const root = realpathSync(packageDirectory);
  const layout = packageLayout(root);
  const relativePath = (file) => relative(root, file).split(sep).join('/');
  const files = [];
  const walk = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const link = readlinkSync(absolute);
        const target = relative(layout.bundle ?? root, realpathSync(absolute));
        // macOS frameworks require versioned relative links. Never follow links out of the bundle.
        if (
          layout.platform !== 'darwin' ||
          isAbsolute(link) ||
          isAbsolute(target) ||
          target === '..' ||
          target.startsWith(`..${sep}`)
        )
          throw new Error(`Package link escapes distribution or is unsupported: ${path}`);
        files.push({ path, bytes: Buffer.byteLength(link), link });
        continue;
      }
      if (entry.isDirectory()) walk(absolute, path);
      else if (entry.isFile()) files.push({ path, bytes: lstatSync(absolute).size });
      else throw new Error(`Unexpected package entry: ${path}`);
    }
  };
  walk(root);
  const appPrefix = relativePath(layout.app) + '/';
  const resourcesPrefix = relativePath(layout.resources) + '/';
  const allowedAppEntries = new Set([
    'dist',
    'node_modules',
    'assets',
    'licenses',
    'docs',
    'scripts',
    'package.json',
    'package-lock.json',
    'LICENSE',
    'NOTICE',
    'THIRD_PARTY_NOTICES.md',
  ]);
  for (const { path } of files) {
    if (
      path.startsWith(resourcesPrefix) &&
      /^(?:voice|image-search|memory-search|embeddinggemma|everything|magpie)(?:\/|$)/i.test(
        path.slice(resourcesPrefix.length),
      )
    )
      throw new Error(`Optional component found in lightweight package: ${path}`);
    if (/\.(?:litertlm|whl)$/i.test(path) || /(?:^|\/)python-\d[^/]*-embed-[^/]+\.zip$/i.test(path))
      throw new Error(`Optional model/runtime download found in lightweight package: ${path}`);
    if (!path.startsWith(appPrefix)) continue;
    const appPath = path.slice(appPrefix.length);
    const first = appPath.split('/')[0];
    if (!allowedAppEntries.has(first)) throw new Error(`Unexpected application file: ${appPath}`);
    if (
      first === 'node_modules' &&
      /(?:^|\/)(?:\.vite|\.vite-temp|\.cache|\.turbo|\.parcel-cache|\.rollup\.cache|_cacache)(?:\/|$)/.test(appPath)
    )
      throw new Error(`Development cache found in package: ${appPath}`);
    const onnxPlatform = /^node_modules\/onnxruntime-node\/bin\/[^/]+\/([^/]+)\//.exec(appPath)?.[1];
    if (onnxPlatform && onnxPlatform !== layout.platform)
      throw new Error(`Other-platform inference library found: ${appPath}`);
    // Third-party packages retain their own fixture/documentation filenames.
    // Application-owned paths may never carry local diagnostic or account data.
    if (
      first !== 'node_modules' &&
      /(?:^|\/)(?:\.data|\.runtime|\.env(?:\.[^/]*)?|\.tmp[^/]*)(?:\/|$)|\.(?:log|sqlite(?:3)?|db|pem|pfx)$/i.test(
        appPath,
      )
    )
      throw new Error(`Local data found in package: ${appPath}`);
  }
  const app = JSON.parse(readFileSync(join(layout.app, 'package.json'), 'utf8'));
  const paths = new Set(files.map((file) => file.path));
  for (const required of [
    relativePath(layout.executable),
    appPrefix + 'dist/electron/main.cjs',
    appPrefix + 'package-lock.json',
    appPrefix + 'LICENSE',
    ...(layout.platform === 'darwin' ? [relativePath(join(layout.bundle, 'Contents', 'Info.plist'))] : []),
  ])
    if (!paths.has(required)) throw new Error(`Package file missing: ${required}`);
  if (app.productName !== 'PugPort') throw new Error('Unexpected package identity.');
  return {
    product: app.productName,
    platform: layout.platform,
    version: app.version,
    optionalModelsIncluded: false,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

if (process.argv[1] && realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url))) {
  const target = packageTarget([]);
  const root = resolve(process.argv[2] || `release/PugPort-${target.platform}-${target.arch}`);
  const inventory = verifyLitePackage(root);
  const path = join(dirname(root), `${basename(root)}.inventory.json`);
  writeFileSync(path, `${JSON.stringify(inventory, null, 2)}\n`);
  console.log(
    `Lightweight package verified: ${inventory.fileCount} files, ${inventory.totalBytes} bytes. Inventory: ${path}`,
  );
}
