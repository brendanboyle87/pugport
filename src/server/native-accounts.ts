import { nativeCliProviders, providerSpec } from '../shared/provider-registry.ts';
import { assertTestProcess, isolatedUserPath, underTest, testPath } from './platform/under-test.ts';
import { spawn, type ChildProcess, type SpawnOptions } from './platform/test-process.ts';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from 'node:fs';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { RuntimeTarget } from '../shared/types.ts';
import { cliEnvironment, isDirectExecutable, isRemovedGoogleCliLaunch } from './platform/executables.ts';
import { currentHost, type Host } from './platform/host.ts';
import { restrictDirectory } from './platform/secure-file.ts';
import { mirrorAccountSharedConfig } from './account-shared-config.ts';
import { fileIdentity } from './platform/file-identity.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_AUTH_BYTES = 256 * 1024;
/** Claude keeps its project history in the same file as the account record, so that file grows with use. */
const MAX_CLAUDE_PROFILE_BYTES = 16 * 1024 * 1024;
const MANAGED_PROVIDERS: readonly string[] = nativeCliProviders;
const unsupported = () =>
  new Error('目前仅支持 Grok、Codex、Claude 和 Cursor 原生独立账号；其他 CLI 的账号隔离尚未开放。');
const unsafeHome = () => new Error('独立账号目录无效或包含链接，请重新创建账号。');
const comparablePath = (path: string) => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path));
const providerEnvironment =
  /^(?:GROK|XAI|OPENAI|CODEX|ANTHROPIC|CLAUDE|CURSOR|GEMINI)_|^GOOGLE_(?:API_KEY$|APPLICATION_CREDENTIALS$|CLOUD_|GENAI_|GEMINI_BASE_URL$)/i;

/**
 * OpenAI key variables a Codex CLI would pick up in place of its ChatGPT login. With one present, Codex (and its
 * built-in image tool) silently bills the API key instead of the subscription, so Codex never inherits them.
 */
const openAiKeyEnvironment = /^(?:OPENAI_API_KEY|OPENAI_ADMIN_KEY|CODEX_API_KEY|AZURE_OPENAI_API_KEY)$/i;
export function withoutOpenAiKeys(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const key of Object.keys(env)) if (openAiKeyEnvironment.test(key)) delete env[key];
  return env;
}

function environmentValue(source: NodeJS.ProcessEnv, name: string): string | undefined {
  const value =
    source[name] ??
    (process.platform === 'win32'
      ? source[Object.keys(source).find((key) => key.toUpperCase() === name) ?? '']
      : undefined);
  return value?.trim() ? value : undefined;
}

/** Locate the existing profile without changing it or copying its authentication. */
export function defaultGrokHome(source: NodeJS.ProcessEnv = process.env): string {
  const configured = environmentValue(source, 'GROK_HOME');
  const userHome = environmentValue(source, process.platform === 'win32' ? 'USERPROFILE' : 'HOME') ?? homedir();
  return isolatedUserPath(resolve(configured ?? join(userHome, '.grok')));
}

export function defaultNativeAccountHome(
  target: RuntimeTarget,
  source: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (
    providerSpec(target.provider)?.accountIdentity !== 'home' ||
    target.id !== `${target.provider}-native` ||
    target.environment !== 'native' ||
    target.gateway ||
    target.accountId ||
    target.accountHome
  )
    return undefined;
  if (target.provider === 'grok') return defaultGrokHome(source);
  const userHome = environmentValue(source, process.platform === 'win32' ? 'USERPROFILE' : 'HOME') ?? homedir();
  const dir = providerSpec(target.provider)?.configDir;
  if (!dir) return undefined;
  const configured = environmentValue(source, dir.env);
  return isolatedUserPath(
    dir.envIsParent ? resolve(configured ?? userHome, dir.name) : resolve(configured ?? join(userHome, dir.name)),
  );
}

function requireSupportedNative(target: RuntimeTarget): void {
  if (!MANAGED_PROVIDERS.includes(target.provider) || target.environment !== 'native' || target.gateway)
    throw unsupported();
  if (isRemovedGoogleCliLaunch(target)) throw new Error('provider-retired');
  // Only Windows keeps Cursor's login in a file that can be moved (see docs/CROSS-PLATFORM.md).
  if (target.provider === 'cursor' && process.platform !== 'win32')
    throw new Error('第二个 Cursor 账号目前只支持 Windows。');
}

/** Claude and Cursor are pointed at the account folder by their environment alone (see nativeAccountEnvironment). */
function isolatedArguments(target: RuntimeTarget, home: string): string[] {
  requireSupportedNative(target);
  if (target.provider === 'grok') return ['--leader-socket', join(home, 'leader.sock')];
  if (target.provider === 'codex')
    return ['-c', 'cli_auth_credentials_store="file"', '-c', 'forced_login_method="chatgpt"'];
  return [];
}

/** Each CLI's own sign-in command; Claude is told to use the subscription login, never Console API billing. */
const loginArguments = (provider: RuntimeTarget['provider']): string[] => [
  ...(providerSpec(provider)?.loginArgs ?? []),
];

/** Where Cursor's CLI keeps one account's login inside its folder (%APPDATA%\Cursor\auth.json, with APPDATA moved). */
const cursorRoaming = (home: string) => join(home, 'AppData', 'Roaming');
const cursorLoginFile = (home: string) => join(cursorRoaming(home), 'Cursor', 'auth.json');

/** The login file a managed Cursor account's CLI uses, for its own usage reading. Throws for anything else. */
export function nativeAccountCursorLogin(target: RuntimeTarget): string {
  if (target.provider !== 'cursor') throw unsupported();
  return cursorLoginFile(accountHome(target));
}

/**
 * realpathSync, or within one display pass (one state build) a memo of it: every check still runs, but a folder that
 * several accounts and checks share is resolved once. Never shared across passes or with gates before an action.
 */
const sharedRealpath = (paths?: Map<string, string>): ((path: string) => string) =>
  paths
    ? (path) => {
        let real = paths.get(path);
        if (real === undefined) paths.set(path, (real = realpathSync(path)));
        return real;
      }
    : realpathSync;

/** Managed homes are UUID directories created directly below the private accounts directory. */
function accountHome(target: RuntimeTarget, realpath: (path: string) => string = realpathSync): string {
  requireSupportedNative(target);
  const { accountId, accountHome: home } = target;
  if (
    !accountId ||
    !UUID.test(accountId) ||
    !home ||
    !isAbsolute(home) ||
    basename(home) !== accountId ||
    basename(dirname(home)) !== 'accounts' ||
    target.id !== `${target.provider}-account-${accountId}`
  )
    throw unsafeHome();
  try {
    for (const directory of [dirname(home), home]) {
      const info = lstatSync(directory);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        comparablePath(realpath(directory)) !== comparablePath(directory)
      )
        throw unsafeHome();
    }
  } catch {
    throw unsafeHome();
  }
  return resolve(home);
}

async function restrictAccountDirectory(directory: string): Promise<void> {
  try {
    await restrictDirectory(directory);
  } catch {
    throw new Error('无法限制独立账号目录访问权限，未创建或复制任何凭据。');
  }
}

/**
 * Windows: the .exe itself (never a link or a .cmd wrapper, whose argument parsing cannot be trusted). macOS and
 * Linux: npm, Homebrew and official installers link the binary into a bin folder, so a link to an executable
 * file is accepted; wrappers named .cmd/.bat/.ps1 are not.
 */
export function requireDirectExecutable(command: string, host: Host = currentHost()): string {
  const { path } = host;
  if (
    !path.isAbsolute(command) ||
    /[\0\r\n]/.test(command) ||
    (host.platform === 'win32' ? !/\.exe$/i.test(command) : /\.(cmd|bat|ps1)$/i.test(command))
  ) {
    throw new Error('独立账号需要已发现的原生 CLI 可执行文件，不支持命令包装脚本。');
  }
  let found: boolean;
  try {
    found = host.platform === 'win32' ? host.fs.lstatSync(command).isFile() : isDirectExecutable(command, host);
  } catch {
    found = false;
  }
  if (!found) throw new Error('找不到原生 CLI 可执行文件。');
  return path.resolve(command);
}

/**
 * Cursor's official Windows installer ships only a .cmd launcher (it starts its bundled node.exe through PowerShell).
 * Exactly that launcher, at the installer's own location and not a link, is accepted; every other wrapper is not.
 */
function accountExecutable(target: RuntimeTarget): string {
  if (target.provider === 'cursor' && process.platform === 'win32' && /\.cmd$/i.test(target.command)) {
    const launcher = join(
      environmentValue(process.env, 'LOCALAPPDATA') ?? join(homedir(), 'AppData', 'Local'),
      'cursor-agent',
      'cursor-agent.cmd',
    );
    let found = false;
    try {
      const info = lstatSync(launcher);
      found =
        comparablePath(target.command) === comparablePath(launcher) &&
        info.isFile() &&
        !info.isSymbolicLink() &&
        comparablePath(realpathSync(launcher)) === comparablePath(launcher);
    } catch {
      found = false;
    }
    if (found) return resolve(launcher);
  }
  return requireDirectExecutable(target.command);
}

/** Create a private profile with personal instructions, never the default profile's credentials. */
export async function createNativeAccount(
  dataDir: string,
  baseTarget: RuntimeTarget,
  label: string,
): Promise<RuntimeTarget> {
  requireSupportedNative(baseTarget);
  const command = accountExecutable(baseTarget);
  const safeLabel = label.trim();
  if (!safeLabel || safeLabel.length > 80 || /[\x00-\x1f\x7f]/.test(safeLabel))
    throw new Error('账号名称需要 1–80 个可见字符。');
  if (!isAbsolute(dataDir)) throw unsafeHome();
  let root: string;
  try {
    root = await realpath(dataDir);
    if (!(await lstat(root)).isDirectory()) throw unsafeHome();
  } catch {
    throw unsafeHome();
  }
  const directory = join(root, 'accounts');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    comparablePath(await realpath(directory)) !== comparablePath(directory)
  )
    throw unsafeHome();
  await restrictAccountDirectory(directory);
  const accountId = randomUUID();
  const home = join(directory, accountId);
  await mkdir(home, { mode: 0o700 });
  await restrictAccountDirectory(home);
  const target: RuntimeTarget = {
    id: `${baseTarget.provider}-account-${accountId}`,
    accountId,
    accountHome: home,
    provider: baseTarget.provider,
    label: safeLabel,
    command,
    args: isolatedArguments(baseTarget, home),
    environment: 'native',
    enabled: false,
    commandDiscovery: baseTarget.provider === 'codex' && baseTarget.commandDiscovery === 'auto' ? 'auto' : 'fixed',
    // Cursor publishes no balance for its CLI, so its accounts count like the existing Cursor card does.
    accountingMode: baseTarget.provider === 'cursor' ? (baseTarget.accountingMode ?? 'auto') : 'auto',
  };
  await mirrorAccountSharedConfig(target);
  return target;
}

/** Preserve the system environment, but never inherit another CLI profile or API credential. */
export function nativeAccountEnvironment(
  target: RuntimeTarget,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...source };
  // Subscription billing for every Codex CLI card, including the CLI's own saved login and fixed commands.
  if (target.provider === 'codex') withoutOpenAiKeys(env);
  if (!target.accountId && !target.accountHome) {
    // The factory subscription entry uses the CLI's saved login. A desktop launched
    // from another tool must not inherit that tool's bearer token or gateway URL.
    // Explicit fixed commands and API entries keep their owner's authentication.
    if (
      target.provider === 'claude' &&
      target.id === 'claude-native' &&
      target.environment === 'native' &&
      target.commandDiscovery === 'auto' &&
      target.accountingMode !== 'usage' &&
      !target.gateway &&
      !target.args?.length
    )
      for (const key of Object.keys(env))
        if (
          /^(?:ANTHROPIC_(?:API_KEY|AUTH_TOKEN|BASE_URL|CUSTOM_HEADERS|PROFILE|FEDERATION_RULE_ID|ORGANIZATION_ID)|CLAUDE_CODE_(?:OAUTH_TOKEN|USE_(?:BEDROCK|VERTEX|FOUNDRY)))$/i.test(
            key,
          )
        )
          delete env[key];
    return env;
  }
  const home = accountHome(target);
  for (const key of Object.keys(env)) {
    // Where Git Bash lives (Claude Code on Windows needs it) is neither a login nor a profile.
    if (providerEnvironment.test(key) && !/^CLAUDE_CODE_GIT_BASH_PATH$/i.test(key)) delete env[key];
  }
  const dir = providerSpec(target.provider)?.configDir;
  // Claude Code keeps its login, settings and history in CLAUDE_CONFIG_DIR (or the macOS Keychain).
  if (dir) env[dir.env] = home;
  else if (target.provider === 'cursor') cursorAccountEnvironment(env, home, environmentValue(source, 'APPDATA'));
  else {
    env.GROK_HOME = home;
    // Official Grok storage.rs gives GROK_AUTH_PATH precedence over GROK_HOME.
    env.GROK_AUTH_PATH = join(home, 'auth.json');
  }
  return env;
}

/** Windows variables are case-insensitive: drop every spelling before setting one. */
function setVariable(env: NodeJS.ProcessEnv, name: string, value: string): void {
  for (const key of Object.keys(env)) if (key.toUpperCase() === name.toUpperCase()) delete env[key];
  env[name] = value;
}

/**
 * Cursor's CLI (cli-credentials) keeps its Windows login in %APPDATA%\Cursor\auth.json and offers no setting of its
 * own for it, so APPDATA moves into the account folder; CURSOR_CONFIG_DIR moves its cli-config.json. The file store
 * is pinned. Tools the agent runs inherit the moved APPDATA, so the few that would visibly break keep the real one:
 * npm's global folder, Python's per-user packages and the GitHub CLI login. PATH is unchanged.
 */
function cursorAccountEnvironment(env: NodeJS.ProcessEnv, home: string, realAppData: string | undefined): void {
  env.CURSOR_CONFIG_DIR = join(home, '.cursor');
  setVariable(env, 'AGENT_CLI_CREDENTIAL_STORE', 'file');
  if (realAppData)
    for (const [name, folder] of [
      ['NPM_CONFIG_PREFIX', 'npm'],
      ['PYTHONUSERBASE', 'Python'],
      ['GH_CONFIG_DIR', 'GitHub CLI'],
    ] as const)
      if (!environmentValue(env, name)) env[name] = join(realAppData, folder);
  setVariable(env, 'APPDATA', cursorRoaming(home));
}

type LoginLauncher = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
type LoginState = {
  version: 1;
  nonce: string;
  phase: 'starting' | 'running' | 'finished';
  ownerPid: number;
  helperPid: number;
  pid: number;
};
const INVALID_MARKER = Symbol('invalid-login-marker');
const activeLoginLaunches = new Set<string>();
const loginStatePath = (home: string) => join(home, '.comborunner-login.json');
const loginPidPath = (home: string, nonce: string) => join(home, `.comborunner-login-${nonce}.pid`);
const loginHelperPidPath = (home: string, nonce: string) => join(home, `.comborunner-login-${nonce}.helper.pid`);
const validPid = (pid: unknown): pid is number => Number.isSafeInteger(pid) && Number(pid) > 0;

function processAlive(pid: number): boolean {
  if (!validPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function readMarker(path: string, limit: number): string | typeof INVALID_MARKER | undefined {
  let descriptor: number | undefined;
  try {
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(limit))
      return INVALID_MARKER;
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      fileIdentity(opened).ino !== fileIdentity(before).ino ||
      (process.platform !== 'win32' && fileIdentity(opened).dev !== fileIdentity(before).dev) ||
      opened.nlink !== 1n ||
      opened.size > BigInt(limit)
    )
      return INVALID_MARKER;
    const bytes = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < bytes.length) {
      const received = readSync(descriptor, bytes, count, bytes.length - count, null);
      if (!received) break;
      count += received;
    }
    return count <= limit ? bytes.subarray(0, count).toString('utf8') : INVALID_MARKER;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : INVALID_MARKER;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {}
    }
  }
}

function readLoginState(home: string): LoginState | typeof INVALID_MARKER | undefined {
  const marker = readMarker(loginStatePath(home), 4096);
  if (marker === undefined || marker === INVALID_MARKER) return marker;
  try {
    const value = JSON.parse(marker) as LoginState;
    return value.version === 1 &&
      UUID.test(value.nonce) &&
      ['starting', 'running', 'finished'].includes(value.phase) &&
      validPid(value.ownerPid) &&
      Number.isSafeInteger(value.helperPid) &&
      value.helperPid >= 0 &&
      Number.isSafeInteger(value.pid) &&
      value.pid >= 0
      ? value
      : INVALID_MARKER;
  } catch {
    return INVALID_MARKER;
  }
}

function terminalAlive(home: string, state: LoginState): boolean {
  if (state.pid) return processAlive(state.pid);
  const marker = readMarker(loginPidPath(home, state.nonce), 32);
  if (marker === INVALID_MARKER) return true;
  if (marker === undefined) return false;
  const pid = Number(marker.trim());
  return validPid(pid) ? processAlive(pid) : true;
}

function helperAlive(home: string, state: LoginState): boolean | undefined {
  const marker = readMarker(loginHelperPidPath(home, state.nonce), 32);
  if (marker === INVALID_MARKER) return true;
  if (marker === undefined) return state.helperPid ? processAlive(state.helperPid) : undefined;
  const pid = Number(marker.trim());
  return validPid(pid) ? processAlive(pid) : true;
}

/**
 * Local synchronous gate; no shell, CLI or network call is made by this probe. `paths` is a display pass's shared
 * folder resolutions (see NativeAccountDisplayCache.read); gates before an action leave it out.
 */
export function nativeAccountLoginPending(target: RuntimeTarget, paths?: Map<string, string>): boolean {
  let home: string;
  try {
    if (!target.accountId) return false;
    home = accountHome(target, sharedRealpath(paths));
  } catch {
    return false;
  } // Identity validation independently rejects invalid managed targets.
  const state = readLoginState(home);
  if (!state) return false;
  if (state === INVALID_MARKER) return true;
  if (state.phase === 'finished') return false;
  if (activeLoginLaunches.has(state.nonce) || terminalAlive(home, state)) return true;
  return state.phase === 'starting' && (helperAlive(home, state) ?? processAlive(state.ownerPid));
}

function removeLoginState(home: string, nonce: string): void {
  const current = readLoginState(home);
  if (!current || current === INVALID_MARKER || current.nonce !== nonce) return;
  try {
    unlinkSync(loginStatePath(home));
  } catch {}
  try {
    unlinkSync(loginPidPath(home, nonce));
  } catch {}
  try {
    unlinkSync(loginHelperPidPath(home, nonce));
  } catch {}
  try {
    unlinkSync(join(home, `.comborunner-login-${nonce}.command`));
  } catch {}
}

async function launchMacAccountLogin(
  target: RuntimeTarget,
  command: string,
  home: string,
  nonce: string,
  launcher: LoginLauncher,
): Promise<{ opened: true }> {
  const file = join(home, `.comborunner-login-${nonce}.command`);
  const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
  const input = {
    file,
    marker: loginStatePath(home),
    nonce,
    home,
    command,
    args: [...isolatedArguments(target, home), ...loginArguments(target.provider)],
    environment: { ...nativeAccountEnvironment(target, {}), PATH: cliEnvironment(command, process.env).PATH },
  };
  // Terminal may already be running, so open cannot pass it the account's environment.
  const script = `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const input = ${JSON.stringify(input)};
function phase(value) {
  const fd = fs.openSync(input.marker, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let state;
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > 4096) return false;
    state = JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
  if (state.nonce !== input.nonce) return false;
  const temporary = input.marker + '.' + input.nonce + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify({ ...state, phase: value, pid: process.pid }), { flag: 'wx', mode: 0o600 });
  try { fs.renameSync(temporary, input.marker); } finally { fs.rmSync(temporary, { force: true }); }
  return true;
}
try {
  fs.unlinkSync(input.file);
  if (!phase('running')) process.exit(1);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if ((${providerEnvironment}.test(key) && !/^CLAUDE_CODE_GIT_BASH_PATH$/i.test(key)) || /^(?:NODE_OPTIONS|BUN_OPTIONS|ELECTRON_RUN_AS_NODE)$/i.test(key)) delete env[key];
  }
  Object.assign(env, input.environment);
  const child = spawn(input.command, input.args, { cwd: input.home, env, stdio: 'inherit', shell: false });
  for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.once('error', () => console.error('Unable to start the account login command.'));
  child.once('close', code => {
    try { phase('finished'); } catch {}
    process.exitCode = code ?? 1;
  });
} catch {
  console.error('Unable to start the account login command.');
  process.exitCode = 1;
}
`;
  try {
    writeFileSync(
      file,
      `#!/bin/sh\nexec /usr/bin/env -u NODE_OPTIONS -u BUN_OPTIONS ELECTRON_RUN_AS_NODE=1 ${quote(process.execPath)} -e ${quote(script)}\n`,
      { flag: 'wx', mode: 0o700 },
    );
  } catch {
    activeLoginLaunches.delete(nonce);
    removeLoginState(home, nonce);
    throw new Error('无法打开独立账号登录终端。');
  }
  return new Promise((resolveOpen, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polling: ReturnType<typeof setInterval> | undefined;
    let settled = false;
    const finish = (opened: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(polling);
      activeLoginLaunches.delete(nonce);
      if (opened) resolveOpen({ opened: true });
      else {
        const current = readLoginState(home);
        if (current && current !== INVALID_MARKER && current.nonce === nonce && !terminalAlive(home, current))
          removeLoginState(home, nonce);
        reject(new Error('无法打开独立账号登录终端。'));
      }
    };
    const ready = () => {
      const current = readLoginState(home);
      if (current && current !== INVALID_MARKER && current.nonce === nonce && current.phase !== 'starting')
        finish(true);
    };
    try {
      const child = launcher('/usr/bin/open', ['-a', 'Terminal', file], {
        cwd: home,
        env: nativeAccountEnvironment(target),
        shell: false,
        detached: false,
        stdio: 'ignore',
      });
      child.once('error', () => finish(false));
      child.once('close', (code) => {
        if (code !== 0) finish(false);
        else {
          ready();
          if (!settled) polling = setInterval(ready, 50);
        }
      });
      timer = setTimeout(() => {
        child.kill();
        finish(false);
      }, 10_000);
    } catch {
      finish(false);
    }
  });
}

/** A new visible console is intentional: the user must complete the CLI's device login there. */
export async function launchAccountLogin(
  target: RuntimeTarget,
  launcher: LoginLauncher = spawn,
): Promise<{ opened: true }> {
  requireSupportedNative(target);
  assertTestProcess(target.command, target.args ?? [], true);
  const home = accountHome(target);
  const command = accountExecutable(target);
  if (process.platform !== 'win32' && process.platform !== 'darwin')
    throw new Error('此版本仅支持在 Windows 和 macOS 终端打开独立账号登录。');
  if (nativeAccountLoginPending(target)) throw new Error('此账号的登录仍在进行，请完成或关闭原登录窗口。');
  const previous = readLoginState(home);
  if (previous && previous !== INVALID_MARKER) removeLoginState(home, previous.nonce);
  const nonce = randomUUID();
  const state: LoginState = { version: 1, nonce, phase: 'starting', ownerPid: process.pid, helperPid: 0, pid: 0 };
  try {
    writeFileSync(loginStatePath(home), JSON.stringify(state), { flag: 'wx', mode: 0o600 });
  } catch {
    throw new Error('无法取得此账号的登录锁，请检查原登录窗口。');
  }
  activeLoginLaunches.add(nonce);
  await mirrorAccountSharedConfig(target);
  if (process.platform === 'darwin') return launchMacAccountLogin(target, command, home, nonce, launcher);
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const argv = [command, ...isolatedArguments(target, home), ...loginArguments(target.provider)];
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$loginStatePath = ${quote(loginStatePath(home))}`,
    `$loginNonce = ${quote(nonce)}`,
    'function Set-LoginPhase([string]$phase) {',
    '  if (!(Test-Path -LiteralPath $loginStatePath)) { return $false }',
    '  $state = Get-Content -LiteralPath $loginStatePath -Raw | ConvertFrom-Json',
    '  if ($state.nonce -ne $loginNonce) { return $false }',
    '  $state.phase = $phase; $state.pid = $PID',
    "  $temporary = $loginStatePath + '.' + $loginNonce + '.' + $PID + '.tmp'",
    '  try {',
    '    [System.IO.File]::WriteAllText($temporary, ($state | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))',
    '    [System.IO.File]::Replace($temporary, $loginStatePath, [NullString]::Value)',
    '  } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }',
    '  return $true',
    '}',
    "if (!(Set-LoginPhase 'running')) { throw 'This login request is no longer active.' }",
    `try { & ${argv.map(quote).join(' ')} } finally { [void](Set-LoginPhase 'finished') }`,
  ].join('\n');
  const terminal = join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const interactiveArgs = [
    '-NoLogo',
    '-NoProfile',
    '-NoExit',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ];
  // Start-Process allocates the interactive console and its own standard streams. A
  // detached Node child with stdio:'ignore' would inherit NUL handles and appear blank.
  // Omit -UseNewEnvironment so the new console inherits this profile's isolated env.
  const helper = `$ErrorActionPreference = 'Stop'\n$opened = Start-Process -FilePath ${quote(terminal)} -ArgumentList @(${interactiveArgs.map(quote).join(', ')}) -WorkingDirectory ${quote(home)} -WindowStyle Normal -ErrorAction Stop -PassThru\n[System.IO.File]::WriteAllText(${quote(loginPidPath(home, nonce))}, $opened.Id.ToString(), (New-Object System.Text.UTF8Encoding($false)))\n`;
  return new Promise((resolveOpen, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const failed = () => {
      clearTimeout(timer);
      activeLoginLaunches.delete(nonce);
      const current = readLoginState(home);
      if (
        current &&
        current !== INVALID_MARKER &&
        current.nonce === nonce &&
        !terminalAlive(home, current) &&
        !helperAlive(home, current)
      )
        removeLoginState(home, nonce);
      reject(new Error('无法打开独立账号登录终端。'));
    };
    try {
      const child = launcher(
        terminal,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(helper, 'utf16le').toString('base64'),
        ],
        {
          cwd: home,
          env: nativeAccountEnvironment(target),
          shell: false,
          detached: false,
          windowsHide: true,
          stdio: 'ignore',
        },
      );
      child.once('error', failed);
      child.once('close', (code) => {
        clearTimeout(timer);
        activeLoginLaunches.delete(nonce);
        if (code === 0) resolveOpen({ opened: true });
        else failed();
      });
      // Only the interactive PowerShell updates phases. A separate helper PID file
      // prevents the parent from overwriting a fast 'finished' with stale 'starting'.
      if (validPid(child.pid))
        writeFileSync(loginHelperPidPath(home, nonce), String(child.pid), { flag: 'wx', mode: 0o600 });
      timer = setTimeout(() => {
        child.kill();
        failed();
      }, 10_000);
    } catch {
      failed();
    }
  });
}

/** A real file in a real folder: never a link, an alias or a second hard link. Only its metadata is read. */
function ownFile(
  file: string,
  limit = MAX_AUTH_BYTES,
  realpath: (path: string) => string = realpathSync,
): BigIntStats | undefined {
  if (underTest() && !testPath(file)) return undefined;
  try {
    const directory = dirname(file);
    const parent = lstatSync(directory);
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      comparablePath(realpath(directory)) !== comparablePath(directory)
    )
      return undefined;
    const before = lstatSync(file, { bigint: true });
    return before.isFile() &&
      !before.isSymbolicLink() &&
      before.nlink === 1n &&
      before.size <= BigInt(limit) &&
      comparablePath(realpath(file)) === comparablePath(file)
      ? before
      : undefined;
  } catch {
    return undefined;
  }
}

/** One JSON object from a file that passes ownFile, re-checked on the opened handle. */
function readOwnJson(file: string, limit = MAX_AUTH_BYTES): Record<string, unknown> | undefined {
  let descriptor: number | undefined;
  try {
    const before = ownFile(file, limit);
    if (!before) return undefined;
    descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const current = fstatSync(descriptor, { bigint: true });
    // Windows reports different device numbers for pathname and handle stats. Its file ID
    // remains comparable; the canonical path and parent checks also reject volume redirection.
    if (
      !current.isFile() ||
      (process.platform !== 'win32' && fileIdentity(current).dev !== fileIdentity(before).dev) ||
      fileIdentity(current).ino !== fileIdentity(before).ino ||
      current.nlink !== 1n ||
      current.size > BigInt(limit) ||
      comparablePath(realpathSync(file)) !== comparablePath(file)
    )
      return undefined;
    const capacity = Math.min(limit, Number(current.size) + 64 * 1024);
    const buffer = Buffer.alloc(capacity + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > capacity) return undefined;
    const store: unknown = JSON.parse(buffer.subarray(0, length).toString('utf8'));
    return store && typeof store === 'object' && !Array.isArray(store) ? (store as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        /* No filesystem details escape this read-only probe. */
      }
    }
  }
}

/** Official Grok AuthStore: scope -> { auth_mode, user_id, email, ... } (model.rs).
 * Only stable profile identity is hashed. Keys, refresh tokens and scopes never form an identity.
 */
function fingerprintAuthFile(file: string, provider: RuntimeTarget['provider'] = 'grok'): string | undefined {
  try {
    const store = readOwnJson(file);
    if (!store) return undefined;
    if (provider === 'codex') return codexIdentityFingerprint(store);
    if (provider !== 'grok') return undefined;
    const identities = new Set<string>();
    const stable = (value: unknown): value is string =>
      typeof value === 'string' && value.trim().length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
    for (const entry of Object.values(store)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const auth = entry as Record<string, unknown>;
      if (!['web_login', 'grok', 'oidc'].includes(String(auth.auth_mode))) continue;
      const identity = stable(auth.user_id)
        ? ['user_id', auth.user_id.trim()]
        : stable(auth.email)
          ? ['email', auth.email.trim().toLowerCase()]
          : undefined;
      if (identity)
        identities.add(
          createHash('sha256')
            .update(JSON.stringify(['grok', ...identity]))
            .digest('hex'),
        );
    }
    return identities.size === 1 ? identities.values().next().value : undefined;
  } catch {
    return undefined;
  }
}

const fingerprint = (identity: string[]) => createHash('sha256').update(JSON.stringify(identity)).digest('hex');
const plainText = (value: unknown, limit = 512): string =>
  typeof value === 'string' && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value) ? value : '';

/**
 * Claude Code: oauthAccount in the profile's .claude.json, the same email and organization `claude auth status`
 * prints, so this matches claudeAccountFingerprint in adapters/claude.ts. Windows and Linux keep the login itself
 * in .credentials.json beside it, which is only checked to exist; macOS keeps it in the Keychain.
 */
function claudeProfileFingerprint(home: string): string | undefined {
  if (process.platform !== 'darwin' && !ownFile(join(home, '.credentials.json'))) return undefined;
  const file = join(home, '.claude.json');
  // Claude rewrites this file while it runs; one immediate retry covers a read that met a write.
  const config = readOwnJson(file, MAX_CLAUDE_PROFILE_BYTES) ?? readOwnJson(file, MAX_CLAUDE_PROFILE_BYTES);
  // A Console (API key) login has no subscription account to tell apart.
  if (!config || (typeof config.primaryApiKey === 'string' && config.primaryApiKey)) return undefined;
  const account = config.oauthAccount;
  if (!account || typeof account !== 'object' || Array.isArray(account)) return undefined;
  const { emailAddress, organizationUuid } = account as Record<string, unknown>;
  const email = plainText(emailAddress).trim().toLowerCase();
  return email.includes('@') ? fingerprint(['claude-native-oauth', email, plainText(organizationUuid)]) : undefined;
}

/**
 * Cursor CLI: cli-config.json caches the account as authInfo, from the same GetMe call `cursor-agent status` makes,
 * so this matches cursorAccountFingerprint in adapters/cursor.ts. The login (auth.json) is only checked to exist.
 */
function cursorProfileFingerprint(home: string): string | undefined {
  if (!ownFile(cursorLoginFile(home))) return undefined;
  const info = readOwnJson(join(home, '.cursor', 'cli-config.json'), 1024 * 1024)?.authInfo;
  if (!info || typeof info !== 'object' || Array.isArray(info)) return undefined;
  const { userId, email } = info as Record<string, unknown>;
  const id =
    typeof userId === 'number'
      ? Number.isSafeInteger(userId) && userId >= 0
        ? String(userId)
        : ''
      : plainText(userId).trim();
  const address = plainText(email).trim().toLowerCase();
  return id
    ? fingerprint(['cursor', 'user_id', id])
    : address.includes('@')
      ? fingerprint(['cursor', 'email', address])
      : undefined;
}

export function nativeAccountFingerprint(target: RuntimeTarget): string | undefined {
  try {
    if (!target.accountId) return undefined;
    const home = accountHome(target);
    if (target.provider === 'claude') return claudeProfileFingerprint(home);
    if (target.provider === 'cursor') return cursorProfileFingerprint(home);
    return fingerprintAuthFile(join(home, 'auth.json'), target.provider);
  } catch {
    return undefined;
  }
}

/** Display-only metadata cache; authorization and execution keep using the direct readers. */
export class NativeAccountDisplayCache {
  private entries = new Map<string, { key: string; at: number; value: string | undefined }>();

  clear() {
    this.entries.clear();
  }

  private key(target: RuntimeTarget, paths?: Map<string, string>): string | undefined {
    const realpath = sharedRealpath(paths);
    try {
      const home = target.accountId ? accountHome(target, realpath) : defaultNativeAccountHome(target);
      if (!home) return undefined;
      let files: [string, number][];
      if (target.provider === 'claude' && target.accountId) {
        files = [[join(home, '.claude.json'), MAX_CLAUDE_PROFILE_BYTES]];
        if (process.platform !== 'darwin') files.push([join(home, '.credentials.json'), MAX_AUTH_BYTES]);
      } else if (target.provider === 'cursor' && target.accountId) {
        files = [
          [join(home, '.cursor', 'cli-config.json'), 1024 * 1024],
          [cursorLoginFile(home), MAX_AUTH_BYTES],
        ];
      } else {
        const configured =
          !target.accountId && target.provider === 'grok' ? environmentValue(process.env, 'GROK_AUTH_PATH') : undefined;
        files = [[configured ? resolve(configured) : join(home, 'auth.json'), MAX_AUTH_BYTES]];
      }
      // ownFile rechecks canonical parents, links, file type and limits even on cache hits.
      return JSON.stringify([
        target.provider,
        comparablePath(realpath(home)),
        files.map(([file, limit]) => {
          const stat = ownFile(file, limit, realpath);
          return [
            comparablePath(file),
            stat ? [stat.size, stat.mtimeNs, stat.ctimeNs, stat.ino, stat.dev].map(String) : null,
          ];
        }),
      ]);
    } catch {
      return undefined;
    }
  }

  /**
   * `paths` shares folder resolutions within one display pass (one state build), never across passes. The check
   * after a fresh read always resolves again.
   */
  read(
    target: RuntimeTarget,
    reader: (target: RuntimeTarget) => string | undefined,
    paths?: Map<string, string>,
  ): string | undefined {
    const key = this.key(target, paths);
    if (key === undefined) {
      this.entries.delete(target.id);
      return reader(target);
    }
    const now = Date.now();
    const cached = this.entries.get(target.id);
    // shortcut: metadata is approximate; force a display reread every minute, never use this for execution.
    if (cached?.key === key && now >= cached.at && now - cached.at < 60_000) return cached.value;
    const value = reader(target);
    if (this.key(target) === key) this.entries.set(target.id, { key, at: now, value });
    else this.entries.delete(target.id);
    return value;
  }
}

/** The pre-existing native Grok is account A; reading it never imports or logs credentials. */
export function defaultGrokAccountFingerprint(
  target: RuntimeTarget,
  source: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return target.provider === 'grok' ? defaultNativeAccountFingerprint(target, source) : undefined;
}

export function defaultNativeAccountFingerprint(
  target: RuntimeTarget,
  source: NodeJS.ProcessEnv = process.env,
): string | undefined {
  try {
    const home = defaultNativeAccountHome(target, source);
    if (!home) return undefined;
    const configured = target.provider === 'grok' ? environmentValue(source, 'GROK_AUTH_PATH') : undefined;
    return fingerprintAuthFile(configured ? resolve(configured) : join(home, 'auth.json'), target.provider);
  } catch {
    return undefined;
  }
}

/** Official codex-rs/login/src/{auth/storage,token_data}.rs: tokens.account_id and
 * id_token["https://api.openai.com/auth"].chatgpt_account_id. JWT decoding here is
 * only an identity hint, never authentication or signature verification.
 */
function codexIdentityFingerprint(store: Record<string, unknown>): string | undefined {
  if (store.auth_mode != null && store.auth_mode !== 'chatgpt') return undefined;
  if (store.OPENAI_API_KEY != null && store.OPENAI_API_KEY !== '') return undefined;
  const tokens = store.tokens;
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return undefined;
  const value = tokens as Record<string, unknown>;
  const stable = (id: unknown): id is string =>
    typeof id === 'string' && id.length > 0 && id.length <= 512 && id.trim() === id && !/[\x00-\x1f\x7f]/.test(id);
  if (value.account_id != null && !stable(value.account_id)) return undefined;
  let claimId: unknown;
  if (value.id_token != null) {
    if (typeof value.id_token !== 'string' || value.id_token.length > 64 * 1024) return undefined;
    const parts = value.id_token.split('.');
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return undefined;
    try {
      const bytes = Buffer.from(parts[1]!, 'base64url');
      if (bytes.toString('base64url') !== parts[1]) return undefined;
      const claims: unknown = JSON.parse(bytes.toString('utf8'));
      if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return undefined;
      const auth = (claims as Record<string, unknown>)['https://api.openai.com/auth'];
      if (auth != null && (typeof auth !== 'object' || Array.isArray(auth))) return undefined;
      claimId = (auth as Record<string, unknown> | undefined)?.chatgpt_account_id;
      if (claimId != null && !stable(claimId)) return undefined;
    } catch {
      return undefined;
    }
  }
  if (stable(value.account_id) && stable(claimId) && value.account_id !== claimId) return undefined;
  const accountId = value.account_id ?? claimId;
  return stable(accountId)
    ? createHash('sha256')
        .update(JSON.stringify(['codex', 'account_id', accountId]))
        .digest('hex')
    : undefined;
}
