// Small releases increment the patch number; explicit larger releases may pass X.Y.Z.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = resolve(root, 'package.json'),
  lockPath = resolve(root, 'package-lock.json');
const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
const lock = JSON.parse(await readFile(lockPath, 'utf8'));
const requested = process.argv[2] || 'patch';
const [major, minor, patch] = pkg.version.split('.').map(Number);
const version = requested === 'patch' ? `${major}.${minor}.${patch + 1}` : requested;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Use patch or an explicit X.Y.Z version.');
pkg.version = version;
lock.version = version;
lock.packages[''].version = version;
await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
await writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n');
// The packaged license check requires the inventory to name the same project version.
const licensesPath = resolve(root, 'docs/DEPENDENCY-LICENSES.json');
const licenses = JSON.parse(await readFile(licensesPath, 'utf8'));
licenses.projectVersion = version;
await writeFile(licensesPath, JSON.stringify(licenses, null, 2) + '\n');
// Replace only the version line so other identity exports survive a bump.
const identityPath = resolve(root, 'src/shared/identity.ts');
const identity = await readFile(identityPath, 'utf8');
const versionLine = /^export const APP_VERSION = '[^']*';$/m;
if (!versionLine.test(identity)) throw new Error('APP_VERSION line not found in src/shared/identity.ts.');
await writeFile(identityPath, identity.replace(versionLine, `export const APP_VERSION = '${version}';`));
console.log(`PugPort ${version}`);
