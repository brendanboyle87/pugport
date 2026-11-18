// Offline release gate: validates the exact material shipped, not legal suitability.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageLayout, packageTarget } from './package-policy.mjs';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
function within(root, path, sourceModulesRoot) {
  if (
    typeof path !== 'string' ||
    !path ||
    isAbsolute(path) ||
    /^[a-z]:/i.test(path) ||
    path.split(/[\\/]/).includes('..')
  )
    throw new Error('Invalid license path');
  const value = realpathSync(join(root, path)),
    base = sourceModulesRoot && /^node_modules(?:[\\/]|$)/.test(path) ? sourceModulesRoot : realpathSync(root),
    rel = relative(base, value);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('License path escapes distribution');
  return value;
}
const json = (root, path) => JSON.parse(readFileSync(within(root, path), 'utf8'));
function requireText(root, path, sourceModulesRoot) {
  const bytes = readFileSync(within(root, path.split('#')[0], sourceModulesRoot));
  if (bytes.length < 20) throw new Error(`License text empty: ${path}`);
  return bytes;
}
function verifyFile(root, file) {
  if (!/^[a-f0-9]{64}$/.test(file.sha256 ?? '')) throw new Error(`Missing license digest: ${file.path}`);
  const bytes = requireText(root, file.path);
  if (sha256(bytes) !== file.sha256) throw new Error(`License digest mismatch: ${file.path}`);
}
function manifest(root, path) {
  const value = json(root, path);
  if (
    !Array.isArray(value.components) ||
    !value.components.length ||
    !Array.isArray(value.unresolved) ||
    value.unresolved.length
  )
    throw new Error(`Incomplete license manifest: ${path}`);
  for (const component of value.components) {
    if (!Array.isArray(component.licenseFiles) || !component.licenseFiles.length)
      throw new Error(`Missing license material: ${component.id ?? component.name}`);
    for (const file of [
      ...component.licenseFiles,
      ...(component.attributionFile ? [component.attributionFile] : []),
      ...(component.evidence ?? []),
    ])
      verifyFile(root, file);
  }
  return value;
}

function installedPackages(root, sourceModulesRoot) {
  const packages = [],
    visiting = new Set();
  const directories = (path) =>
    readdirSync(within(root, path, sourceModulesRoot), { withFileTypes: true }).filter(
      (entry) => !entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink()),
    );
  const visit = (path) => {
    if (!existsSync(join(root, path))) return;
    const actual = within(root, path, sourceModulesRoot);
    if (visiting.has(actual)) throw new Error(`Circular dependency directory: ${path}`);
    visiting.add(actual);
    for (const entry of directories(path)) {
      const location = `${path}/${entry.name}`;
      const locations = entry.name.startsWith('@')
        ? directories(location).map((item) => `${location}/${item.name}`)
        : [location];
      for (const packagePath of locations) {
        packages.push({
          path: packagePath,
          metadata: JSON.parse(readFileSync(within(root, `${packagePath}/package.json`, sourceModulesRoot), 'utf8')),
        });
        visit(`${packagePath}/node_modules`);
      }
    }
    visiting.delete(actual);
  };
  visit('node_modules');
  return packages;
}

function dependencyInventory(root, inventory) {
  const lock = json(root, 'package-lock.json');
  if (!lock.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages))
    throw new Error('Expected package-lock package inventory');
  if (!Array.isArray(inventory.packages)) throw new Error('Missing dependency license inventory');
  const recorded = new Map();
  for (const item of inventory.packages) {
    if (recorded.has(item.path)) throw new Error(`Duplicate dependency license entry: ${item.path}`);
    if (!Object.hasOwn(lock.packages, item.path) || !item.path)
      throw new Error(`Dependency license entry is not locked: ${item.path}`);
    recorded.set(item.path, item);
  }
  for (const [path, locked] of Object.entries(lock.packages)) {
    if (!path) continue;
    const item = recorded.get(path);
    if (!item) throw new Error(`Locked dependency missing from license inventory: ${path}`);
    if (typeof locked.version !== 'string' || item.version !== locked.version)
      throw new Error(`Locked dependency version differs from license inventory: ${path}`);
    if (item.developmentOnly !== (locked.dev === true))
      throw new Error(`Locked dependency developmentOnly differs from license inventory: ${path}`);
    recorded.set(path, { ...item, optional: locked.optional === true });
  }
  return recorded;
}

export function verifyLicenseBundle({ root = defaultRoot, packageRoot } = {}) {
  const layout = packageRoot ? packageLayout(packageRoot) : undefined;
  const appRoot = layout?.app ?? root;
  const npm = manifest(appRoot, 'docs/NPM-LICENSE-SUPPLEMENTS.json');
  const inventory = json(appRoot, 'docs/DEPENDENCY-LICENSES.json');
  const packageInfo = json(appRoot, 'package.json');
  if (inventory.projectVersion !== packageInfo.version)
    throw new Error('Dependency license inventory has a stale project version');
  const recorded = dependencyInventory(appRoot, inventory);
  // Source worktrees may share one dependency junction; shipped files must stay inside the distribution.
  const sourceModulesRoot =
    !packageRoot && existsSync(join(appRoot, 'node_modules')) ? realpathSync(join(appRoot, 'node_modules')) : undefined;
  let runtimePackages = 0;
  // Enumerate what is present rather than trusting the inventory to list it all.
  // Other-platform optional packages may remain in the lock without being installed.
  for (const { path, metadata } of installedPackages(appRoot, sourceModulesRoot)) {
    const item = recorded.get(path);
    if (!item) throw new Error(`Installed dependency missing from locked license inventory: ${path}`);
    if (metadata.version !== item.version) throw new Error(`Dependency version changed: ${path}`);
    if (!packageRoot && item.developmentOnly) continue;
    const files = [...item.licenseFiles, ...item.supplementalLicenseFiles];
    // An optional native package absent on the audit host can become installed on another OS.
    // Its locked identity is checked above; require its actual package-root license text.
    if (!files.length && item.optional === true && item.installedAtAudit === false)
      files.push(
        ...readdirSync(within(appRoot, path, sourceModulesRoot), { withFileTypes: true })
          .filter(
            (entry) => entry.isFile() && /^(?:licen[cs]e|copying|copyright|notice)(?:[._-].*)?$/i.test(entry.name),
          )
          .map((entry) => `${path}/${entry.name}`),
      );
    if (!files.length) throw new Error(`No license text for bundled dependency: ${item.name}@${item.version}`);
    for (const path of files) requireText(appRoot, path, sourceModulesRoot);
    runtimePackages++;
  }
  for (const path of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) requireText(appRoot, path);
  if (packageRoot) {
    if (existsSync(join(layout.resources, 'magpie'))) throw new Error('Retired Magpie gateway must not be bundled');
    requireText(packageRoot, relative(resolve(packageRoot), layout.electronLicense));
    requireText(packageRoot, relative(resolve(packageRoot), layout.chromiumLicense));
  }
  return {
    projectVersion: packageInfo.version,
    runtimePackages,
    npmSupplementComponents: npm.components.length,
    unresolved: 0,
    packaged: Boolean(packageRoot),
  };
}

function isMainEntry() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainEntry()) {
  const at = process.argv.indexOf('--package');
  const target = packageTarget([]);
  try {
    console.log(
      JSON.stringify(
        verifyLicenseBundle({
          packageRoot:
            at === -1
              ? undefined
              : resolve(process.argv[at + 1] ?? `release/PugPort-${target.platform}-${target.arch}`),
        }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
