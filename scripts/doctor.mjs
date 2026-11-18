import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requiredBuildFiles = [
  'dist/server/main.js',
  'dist/server/bootstrap.js',
  'dist/electron/main.cjs',
  'dist/electron/preload.cjs',
  'dist/ui/index.html',
];
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
function electronRuntime(root) {
  try {
    const electron = join(root, 'node_modules/electron');
    const marker = join(electron, 'path.txt');
    if (!isFile(marker) || statSync(marker).size > 4096) return { reason: 'missing or invalid electron/path.txt' };
    const executable = readFileSync(marker, 'utf8').trim();
    const segments = executable.split(/[\\/]/);
    if (
      !executable ||
      isAbsolute(executable) ||
      /^[a-z]:/i.test(executable) ||
      segments.some((part) => !part || part === '..' || part === '.') ||
      /[\x00-\x1f]/.test(executable)
    )
      return { reason: 'unsafe electron/path.txt executable path' };
    const dist = realpathSync(join(electron, 'dist'));
    const path = join(dist, ...segments);
    if (!isFile(path)) return { reason: 'Electron executable is missing' };
    const actual = realpathSync(path);
    const inside = relative(dist, actual);
    if (inside.startsWith('..') || isAbsolute(inside)) return { reason: 'Electron executable escapes dist' };
    return { executable: actual };
  } catch {
    return { reason: 'Electron runtime is missing or unreadable' };
  }
}
// Read-only: never load dependencies or initialize application storage.
export async function inspectEnvironment({
  root = scriptRoot,
  cwd = process.cwd(),
  env = process.env,
  nodeVersion = process.version,
  platform = process.platform,
  architecture = process.arch,
} = {}) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const runtime = electronRuntime(root);
  const missingBuildFiles = requiredBuildFiles.filter((file) => !isFile(join(root, file)));
  const applicationRoot = resolve(cwd, env.COMBORUNNER_ROOT || env.AGENT_STUDIO_ROOT || root);
  let location, dataDirectoryError;
  try {
    const { resolveDataLocation } = await import('../src/shared/data-location.ts');
    location = resolveDataLocation({ root: applicationRoot, cwd, env });
  } catch (error) {
    dataDirectoryError = error instanceof Error ? error.message : String(error);
  }
  const result = {
    app: pkg.name,
    version: pkg.version,
    node: nodeVersion,
    platform,
    architecture,
    nodeSupported: Number(nodeVersion.replace(/^v/, '').split('.')[0]) >= 24,
    dependenciesInstalled: isFile(join(root, 'node_modules/electron/package.json')),
    desktopRuntimeInstalled: Boolean(runtime.executable),
    built: missingBuildFiles.length === 0,
    dataDirectory: location?.dataDir,
    dataDirectorySource: location?.source,
    dataLocationFile: location?.locationFile,
    dataDirectoryError,
    desktopExecutable: runtime.executable,
    missingBuildFiles,
    missing: [],
  };
  if (!result.nodeSupported) result.missing.push('Node.js >=24 is required');
  if (dataDirectoryError) result.missing.push(dataDirectoryError);
  if (!result.dependenciesInstalled) result.missing.push('node_modules/electron/package.json');
  if (!result.desktopRuntimeInstalled) result.missing.push(runtime.reason);
  result.missing.push(...missingBuildFiles);
  return result;
}
if (
  process.argv[1] &&
  isFile(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const result = await inspectEnvironment();
  console.log(JSON.stringify(result, null, 2));
  if (result.missing.length) process.exitCode = 1;
}
