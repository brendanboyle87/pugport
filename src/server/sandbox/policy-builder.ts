import { win32 as path } from 'node:path';
import type { ContainerRequest } from '@microsoft/mxc-sdk/v1';
import { environmentValue, providerProfiles, type LearningProvider } from './provider-profiles.ts';
import { executionEnvironment } from './run-temp.ts';

export type SandboxRequest = Omit<ContainerRequest, 'command'> & {
  provider: LearningProvider;
  runTemp: string;
  reportDirectory: string;
  fallback: { allowDaclMutation: false };
};
export type SandboxPolicyInput = {
  provider: LearningProvider;
  taskKind: 'write' | 'read-only' | 'tool-less';
  projectPath: string;
  runTemp: string;
  accountHome?: string;
  bridgeToken?: string;
  /** Host-decided Git folders a linked worktree needs to commit; only used for write tasks. */
  gitWritePaths?: string[];
};
export type SandboxHost = {
  home: string;
  dataDir: string;
  secrets: string;
  environment: NodeJS.ProcessEnv;
  /** Host locations before an isolated account redirects APPDATA/config variables. */
  hostEnvironment?: NodeJS.ProcessEnv;
  readExecutePaths: string[];
  /** Immediate data children, recursively split only along an allowed account/session path. */
  protectedDataPaths: string[];
  /** Metadata-only canonicalisation supplied by the host; the builder performs no IO. */
  realpath: (value: string) => string;
};
export function containsPath(parent: string, child: string) {
  const relative = path.relative(parent, child).toLowerCase();
  return relative === '' || (!relative.startsWith('..\\') && relative !== '..' && !path.isAbsolute(relative));
}
export function buildSandboxRequest(input: SandboxPolicyInput, host: SandboxHost): SandboxRequest {
  const canonical = (p: string) => path.normalize(host.realpath(p));
  const unique = (paths: string[]) => [
    ...new Map(paths.filter(Boolean).map((p) => [canonical(p).toLowerCase(), canonical(p)])).values(),
  ];
  const env = host.environment;
  const appData = environmentValue(env, 'APPDATA') || path.join(host.home, 'AppData', 'Roaming');
  const local = environmentValue(env, 'LOCALAPPDATA') || path.join(host.home, 'AppData', 'Local');
  const hostEnv = host.hostEnvironment ?? env;
  const roamingPaths = unique([
    appData,
    environmentValue(hostEnv, 'APPDATA') || path.join(host.home, 'AppData', 'Roaming'),
  ]);
  const localPaths = unique([
    local,
    environmentValue(hostEnv, 'LOCALAPPDATA') || path.join(host.home, 'AppData', 'Local'),
  ]);
  const profiles = providerProfiles(host.home, host.dataDir, env);
  const defaults = providerProfiles(host.home, host.dataDir, {});
  const own = unique([...profiles[input.provider], ...(input.accountHome ? [input.accountHome] : [])]);
  const denied = unique([
    ...['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.codex', '.gemini'].map((p) => path.join(host.home, p)),
    ...['CODEX_HOME', 'GEMINI_CLI_HOME'].map((name) => environmentValue(hostEnv, name) ?? '').filter(Boolean),
    ...[...roamingPaths, ...localPaths].flatMap((p) =>
      ['Credentials', 'Vault', 'Protect'].map((v) => path.join(p, 'Microsoft', v)),
    ),
    ...localPaths.flatMap((p) =>
      [
        'Google\\Chrome\\User Data',
        'Microsoft\\Edge\\User Data',
        'BraveSoftware\\Brave-Browser\\User Data',
        'Chromium\\User Data',
      ].map((v) => path.join(p, v)),
    ),
    ...roamingPaths.flatMap((p) => ['Mozilla\\Firefox', 'Opera Software'].map((v) => path.join(p, v))),
    host.secrets,
    ...host.protectedDataPaths,
    ...Object.entries(defaults)
      .filter(([p]) => p !== input.provider)
      .flatMap(([, paths]) => paths),
    ...Object.entries(profiles)
      .filter(([p]) => p !== input.provider)
      .flatMap(([, paths]) => paths),
    ...Object.entries(providerProfiles(host.home, host.dataDir, hostEnv))
      .filter(([p]) => p !== input.provider)
      .flatMap(([, paths]) => paths),
  ]);
  const permitted = (p: string) => !denied.some((d) => containsPath(d, canonical(p)));
  const rw = unique([
    input.runTemp,
    ...own,
    ...(input.taskKind === 'write' ? [input.projectPath, ...(input.gitWritePaths ?? [])] : []),
  ]).filter(permitted);
  const ro = unique([...host.readExecutePaths, ...(input.taskKind === 'read-only' ? [input.projectPath] : [])])
    .filter(permitted)
    .filter((p) => !rw.includes(p));
  return {
    provider: input.provider,
    runTemp: canonical(input.runTemp),
    reportDirectory: canonical(input.runTemp),
    workingDirectory: canonical(input.taskKind === 'tool-less' ? input.runTemp : input.projectPath),
    environment: executionEnvironment(env, canonical(input.runTemp), input.bridgeToken),
    inheritDefaultEnvironment: false,
    filesystem: { readwritePaths: rw, readonlyPaths: ro, deniedPaths: denied },
    containment: {
      type: 'processcontainer',
      config: {
        capabilities: ['registryRead'],
        ui: { isolation: 'desktop', desktopSystemControl: false, systemSettings: 'none', ime: false },
        captureDenials: {
          mode: 'allow',
          outputPath: path.join(canonical(input.runTemp), 'denials.json'),
          retainEtl: false,
        },
      },
    },
    fallback: { allowDaclMutation: false },
    ui: { disable: false, clipboard: 'none', allowInputInjection: false },
    network: {
      egress: { default: 'allow' },
      ingress: { default: input.bridgeToken ? 'allow' : 'deny', hostLoopback: input.bridgeToken ? 'allow' : 'deny' },
    },
    timeoutMs: 0,
  };
}
