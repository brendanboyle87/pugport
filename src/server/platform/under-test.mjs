import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, delimiter, isAbsolute, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const modulePath = typeof process === 'undefined' ? '' : import.meta.url ? fileURLToPath(import.meta.url) : __filename;
const packaged = /[\\/]resources[\\/]app(?:\.asar)?[\\/]/i.test(modulePath);
function repoTests() {
  if (typeof process === 'undefined') return undefined;
  const starts = [dirname(modulePath), process.cwd()];
  for (let root of starts) {
    for (;;) {
      if (existsSync(join(root, 'src/server/platform/under-test.mjs')) && existsSync(join(root, 'tests')))
        return join(root, 'tests');
      const parent = dirname(root);
      if (parent === root) break;
      root = parent;
    }
  }
  return undefined;
}
const foundTests = repoTests();
const testScripts = foundTests ?? resolve('tests');
// The checkout this module belongs to; unknown when it runs from a bundle elsewhere.
const checkout = foundTests && dirname(foundTests);
let installed = false;
let temporary;
let swept = false;
function underTest() {
  if (typeof process === 'undefined') return false;
  if (packaged) {
    delete process.env.PUGPORT_UNDER_TEST;
    delete process.env.NODE_TEST_CONTEXT;
    return false;
  }
  const detected =
    process.env.NODE_TEST_CONTEXT !== void 0 ||
    process.env.PUGPORT_UNDER_TEST === '1' ||
    (process.execArgv ?? []).some((arg) => arg === '--test' || arg.startsWith('--test=')) ||
    (!process.versions?.electron && /\.test\.(?:ts|mjs|cjs)$/.test(process.argv?.[1] ?? ''));
  if (detected) {
    process.env.PUGPORT_UNDER_TEST = '1';
    installFetchGuard();
    if (!swept) {
      swept = true;
      cleanupTestDirectories();
    }
  }
  return detected;
}
function testDirectory() {
  if (!temporary) {
    const parent = process.env.PUGPORT_TEST_DIRECTORY;
    if (parent && insideDirectory(canonical(parent), canonical(tmpdir())) && existsSync(parent)) {
      temporary = mkdtempSync(join(canonical(parent), 'child-'));
    } else {
      temporary = mkdtempSync(join(canonical(tmpdir()), `pugport-test-${process.pid}-`));
    }
    process.env.PUGPORT_TEST_DIRECTORY = temporary;
    const directory = temporary;
    process.once('exit', () => {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // Windows may still hold a child file open. The next run retries stale roots.
      }
    });
  }
  return temporary;
}
function cleanupTestDirectories() {
  let entries;
  try {
    entries = readdirSync(tmpdir(), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const owner = /^pugport-test-(\d+)-/.exec(entry.name);
    if (!entry.name.startsWith('pugport-test-') || entry.name === 'pugport-test-memory') continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = join(tmpdir(), entry.name);
    try {
      if (dirname(canonical(directory)) !== canonical(tmpdir())) continue;
      if (Date.now() - statSync(directory).mtimeMs < (owner ? 2 : 24) * 60 * 60 * 1000) continue;
      if (owner) {
        try {
          process.kill(Number(owner[1]), 0);
          continue;
        } catch (error) {
          if (error.code !== 'ESRCH') continue;
        }
      }
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Another test run or an open Windows handle can win this cleanup race.
    }
  }
}
function canonical(file, seen = new Set()) {
  const original = resolve(file);
  if (seen.has(original)) return original;
  seen.add(original);
  let ancestor = original;
  const missing = [];
  for (;;) {
    try {
      return join(realpathSync.native(ancestor), ...missing);
    } catch (error) {
      if (error.code !== 'ENOENT') return original;
      try {
        // A dangling link can still point outside the temporary tree.
        const target = resolve(dirname(ancestor), readlinkSync(ancestor));
        return join(canonical(target, seen), ...missing);
      } catch (linkError) {
        if (!['EINVAL', 'ENOENT', 'ENOTDIR'].includes(linkError.code)) return original;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) return resolve(file);
      missing.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}
// Test roots and not-yet-created fixture descendants must use the same physical spelling.
const canonicalTestPath = canonical;
function insideDirectory(file, directory) {
  const rel = relative(resolve(directory), resolve(file));
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
}
function testPath(file) {
  const target = canonical(file);
  if (insideDirectory(target, canonical(testScripts))) return true;
  // A checkout under the temp folder is still the real app: only its tests count, not its other files.
  return insideDirectory(target, canonical(tmpdir())) && !(checkout && insideDirectory(target, canonical(checkout)));
}
function isolatedUserPath(file) {
  return underTest() && !testPath(file) ? join(testDirectory(), 'home') : file;
}
class UnderTestError extends Error {
  constructor(kind) {
    super(`PugPort under test: refused ${kind}`);
  }
}
const tools = new Set();
let git;
let electron;
function allowTestTool(file) {
  if (file) tools.add(canonical(file));
}
function resolveCommand(command, env) {
  if (isAbsolute(command) || /[\\/]/.test(command)) return command;
  const extensions = process.platform === 'win32' ? ['', '.exe', '.com', '.cmd', '.bat'] : [''];
  return (env.PATH ?? env.Path ?? '')
    .split(delimiter)
    .filter(Boolean)
    .flatMap((dir) => extensions.map((extension) => join(dir.replace(/^"|"$/g, ''), command + extension)))
    .find(existsSync);
}
if (underTest()) {
  git = resolveCommand('git', process.env);
  allowTestTool(git);
  const require = createRequire(modulePath);
  try {
    allowTestTool(require('@vscode/ripgrep').rgPath);
    const directory = dirname(require.resolve('electron/package.json'));
    const binary = join(directory, 'dist', readFileSync(join(directory, 'path.txt'), 'utf8').trim());
    if (existsSync(binary)) electron = canonical(binary);
  } catch {
    // Minimal synthetic installs need neither package.
  }
  if (process.platform === 'win32')
    for (const name of ['taskkill.exe', 'icacls.exe', 'whoami.exe', 'tar.exe'])
      allowTestTool(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', name));
}
function testProcessEnv(command, env = process.env) {
  const result = {
    TMPDIR: tmpdir(),
    TMP: tmpdir(),
    TEMP: tmpdir(),
    ...env,
    PUGPORT_UNDER_TEST: '1',
    PUGPORT_TEST_DIRECTORY: testDirectory(),
  };
  if (git && canonical(command) === canonical(git)) {
    const config = join(testDirectory(), 'git-config');
    writeFileSync(config, '', { flag: 'a' });
    for (const key of Object.keys(result)) if (/^GIT_CONFIG/i.test(key)) delete result[key];
    Object.assign(result, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config });
  }
  return result;
}
function assertTestProcess(command, args = [], launcher = false, env = process.env) {
  if (!underTest()) return command;
  if (!isAbsolute(command) && !/[\\/]/.test(command)) {
    const found = resolveCommand(command, env);
    if (!found) throw new UnderTestError('external CLI');
    command = found;
  }
  if (tools.has(canonical(command)) && !launcher) return command;
  if (canonical(command) === electron) {
    const app = args[0] && canonical(args[0]) === canonical(electronLoader) ? args[1] : args[0];
    if (app && isAbsolute(app) && testPath(app)) return command;
  }
  if (resolve(command) === resolve(process.execPath)) {
    if (launcher) {
      for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (
          [
            '--import',
            '--loader',
            '--require',
            '-r',
            '--eval',
            '-e',
            '--print',
            '-p',
            '-c',
            '--config',
            '--leader-socket',
          ].includes(arg)
        ) {
          index++;
          continue;
        }
        if (arg.startsWith('-')) continue;
        if (!testPath(arg)) throw new UnderTestError('CLI script');
        break;
      }
    }
    return command;
  }
  if (
    process.platform === 'win32' &&
    resolve(command).toLowerCase() ===
      resolve(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')).toLowerCase() &&
    args.length === 4 &&
    args.slice(0, 3).join(' ') === '/d /s /c'
  ) {
    const match = /^""([^"\r\n]+)"(?: "[^"\r\n]*")*"$/.exec(args[3]);
    if (match && !/[&|<>^%!\r\n\0]/.test(args[3]) && testPath(match[1])) return command;
  }
  if (!isAbsolute(command) || !testPath(command)) throw new UnderTestError('external CLI');
  return command;
}
// Electron's default app opens a modal error box for a missing or broken app, so under test it always starts the app
// through the loader, which prints the error and exits instead.
const electronLoader = join(testScripts, 'helpers', 'electron-loader.cjs');
function testProcessArgs(command, args, env = process.env) {
  // In Node mode (ELECTRON_RUN_AS_NODE) Electron opens no app and so no dialog.
  if (!underTest() || !electron || canonical(command) !== electron || env.ELECTRON_RUN_AS_NODE) return args;
  if (args[0] && canonical(args[0]) === canonical(electronLoader)) return args;
  if (!existsSync(electronLoader)) throw new UnderTestError('Electron app without the test loader');
  return [electronLoader, ...args];
}
function assertTestUrl(input) {
  if (!underTest()) return;
  const url = new URL(input);
  const loopback =
    url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  // 4317 is the desktop app's backend, 4319 a device node's.
  if (!['http:', 'https:'].includes(url.protocol) || !loopback || url.port === '4317' || url.port === '4319')
    throw new UnderTestError('network request (only loopback outside ports 4317 and 4319 is allowed)');
}
function installFetchGuard() {
  if (installed) return;
  installed = true;
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assertTestUrl(input instanceof Request ? input.url : input);
    const redirect = init?.redirect ?? (input instanceof Request ? input.redirect : 'follow');
    return original(input, { ...init, redirect: redirect === 'manual' ? 'manual' : 'error' });
  };
}
underTest();
export {
  UnderTestError,
  allowTestTool,
  assertTestProcess,
  assertTestUrl,
  insideDirectory,
  canonicalTestPath,
  isolatedUserPath,
  testDirectory,
  testPath,
  testProcessArgs,
  testProcessEnv,
  underTest,
};
