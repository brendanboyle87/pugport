import { forwardTokenFile, sessionTokenDirectory } from '../platform/desktop-endpoint.ts';
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, win32 } from 'node:path';
import { homedir } from 'node:os';
import type { RunInput, RuntimeTarget, Settings } from '../../shared/types.ts';
import { appDirs } from '../platform/dirs.ts';
import { nativeAccountEnvironment } from '../native-accounts.ts';
import { mxcRuntime } from './mxc-runtime.ts';
import { buildSandboxRequest, containsPath } from './policy-builder.ts';
import { createRunTemp } from './run-temp.ts';
import { environmentValue, isLearningProvider, providerProfiles, type LearningProvider } from './provider-profiles.ts';
import { captureDenialsStreamingSupported } from '../../shared/sandbox-capabilities.ts';
import { mxcExecutionEnvironment } from './execution-environment.ts';

export function shouldLearn(
  target: RuntimeTarget,
  input: RunInput,
  settings: Settings,
): target is RuntimeTarget & { provider: LearningProvider } {
  return (
    target.environment === 'native' &&
    isLearningProvider(target.provider) &&
    !input.untrustedContent &&
    settings.sandbox?.[target.provider] === 'learn'
  );
}

/** Metadata only: resolve junction targets even for not-yet-created config paths. */
export function canonical(file: string, strict = false): string {
  if (strict && file.split(/[/\\]/).includes('..'))
    throw new Error('Parent path segments cannot be canonicalized safely');
  try {
    return realpathSync(file);
  } catch (error) {
    if (strict && lstatSync(file, { throwIfNoEntry: false })) throw error;
    const parent = dirname(file);
    return parent === file ? resolve(file) : join(canonical(parent, strict), win32.basename(file));
  }
}
/**
 * Synchronous `undefined` when learning is off, so ordinary runs reach their adapter without an extra async hop
 * (callers and tests rely on the adapter starting in the same turn as `execute`).
 */
export function prepareSandboxExecution(
  target: RuntimeTarget,
  input: RunInput,
  settings: Settings,
  root: string,
  dataDir: string,
  bridgeToken?: string,
  managedWorkspace?: { directory: string; repositoryCommonDirectory: string },
) {
  if (!shouldLearn(target, input, settings)) return undefined;
  return prepareLearningExecution(target, input, root, dataDir, bridgeToken, managedWorkspace);
}

async function prepareLearningExecution(
  target: RuntimeTarget & { provider: LearningProvider },
  input: RunInput,
  root: string,
  dataDir: string,
  bridgeToken?: string,
  managedWorkspace?: { directory: string; repositoryCommonDirectory: string },
) {
  const status = await mxcRuntime.probe();
  if (!status.available || !captureDenialsStreamingSupported(status.sdkVersion)) return undefined;
  const temporary = await createRunTemp(target.provider);
  try {
    const environment = mxcExecutionEnvironment(nativeAccountEnvironment(target));
    const home = homedir();
    const own = [
      ...providerProfiles(home, dataDir, environment)[target.provider],
      ...(target.accountHome ? [target.accountHome] : []),
    ].map((path) => canonical(path));
    const managed = managedWorkspace && canonical(managedWorkspace.directory, true);
    const common = managedWorkspace && canonical(managedWorkspace.repositoryCommonDirectory, true);
    if (managed && (managed !== resolve(managedWorkspace!.directory) || managed !== canonical(input.projectPath, true)))
      throw new Error('Managed execution directory changed before sandbox preparation.');
    if (common && common !== resolve(managedWorkspace!.repositoryCommonDirectory))
      throw new Error('Shared Git metadata directory changed before sandbox preparation.');
    if (common && (containsPath(common, canonical(dataDir, true)) || (managed && containsPath(common, managed))))
      throw new Error('Shared Git metadata overlaps protected application data.');
    const visibleData = [...own, ...(managed ? [managed] : []), ...(common ? [common] : [])];
    const protectedDataPaths: string[] = [forwardTokenFile(), sessionTokenDirectory()];
    const splitData = (directory: string) => {
      if (visibleData.some((p) => containsPath(p, canonical(directory)))) return;
      if (!visibleData.some((p) => containsPath(canonical(directory), p))) {
        protectedDataPaths.push(directory);
        return;
      }
      if (!existsSync(directory)) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name);
        if (entry.isDirectory() && !lstatSync(file).isSymbolicLink()) splitData(file);
        else if (!visibleData.includes(canonical(file))) protectedDataPaths.push(file);
      }
    };
    splitData(dataDir);
    const readExecutePaths = [
      ...(common ? [common] : []),
      ...(environmentValue(environment, 'PATH') ?? '').split(';'),
      ...[
        'PYTHONPATH',
        'PYTHONHOME',
        'VCINSTALLDIR',
        'VSINSTALLDIR',
        'PSModulePath',
        'VCPKG_ROOT',
        'GOPATH',
        'GOROOT',
        'CARGO_HOME',
        'RUSTUP_HOME',
        'JAVA_HOME',
        'NVM_HOME',
        'NVM_SYMLINK',
        'NODE_PATH',
        'DOTNET_ROOT',
        'CONDA_PREFIX',
        'VIRTUAL_ENV',
        'PYENV_ROOT',
      ].flatMap((name) => (environmentValue(environment, name) ?? '').split(';')),
      dirname(process.execPath),
      join(root, 'src', 'server'),
      join(root, 'dist', 'server'),
      join(root, 'node_modules'),
      join(root, '.runtime'),
      ...(win32.isAbsolute(target.command) ? [dirname(target.command)] : []),
      join(environmentValue(environment, 'APPDATA') ?? join(home, 'AppData', 'Roaming'), 'npm'),
      environmentValue(environment, 'SystemRoot') ?? 'C:\\Windows',
      environmentValue(environment, 'ProgramFiles') ?? 'C:\\Program Files',
      environmentValue(environment, 'ProgramFiles(x86)') ?? 'C:\\Program Files (x86)',
      environmentValue(environment, 'ProgramData') ?? 'C:\\ProgramData',
    ]
      .map((p) => p.trim())
      .filter((p) => p && win32.isAbsolute(p) && win32.parse(p).root !== p && existsSync(p));
    const request = buildSandboxRequest(
      {
        provider: target.provider,
        taskKind:
          input.textOnly || input.untrustedContent
            ? 'tool-less'
            : input.permissionMode === 'read-only'
              ? 'read-only'
              : 'write',
        projectPath: input.projectPath,
        runTemp: temporary.directory,
        accountHome: target.accountHome,
        bridgeToken,
        gitWritePaths: input.gitWritePaths,
      },
      {
        home,
        dataDir,
        secrets: appDirs().secrets,
        environment,
        hostEnvironment: process.env,
        readExecutePaths,
        protectedDataPaths,
        realpath: canonical,
      },
    );
    return { request, dispose: temporary.dispose };
  } catch (error) {
    await temporary.dispose();
    throw error;
  }
}

export const sandboxExecutions = { prepare: prepareSandboxExecution };
