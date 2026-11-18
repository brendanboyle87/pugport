import './platform/under-test.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  validWorkspaceId,
  validateFreeBaseUrl,
  type ApiBalance,
  type ApiPreset,
  type WorkspaceLookupFailure,
} from '../shared/api-providers.ts';
import type { RuntimeTarget } from '../shared/types.ts';
import { appDirs } from './platform/dirs.ts';
import { currentHost, type Host } from './platform/host.ts';
import { managedNodeRuntime } from './platform/node-runtime.ts';
import { writePrivateConfig } from './private-config.ts';
import { apiCatalog, apiConnectionModel, readApiModelList } from './api-model-discovery.ts';
import { underTest, testPath, UnderTestError, isolatedUserPath } from './platform/under-test.ts';

/**
 * API platforms the user added with their own key. The key lives in a per-user folder outside the data
 * folder (which may sync to the cloud), readable only by this user, and reaches only the runtime of that one
 * platform. Nothing here ever reads keys from the user's environment.
 */
export const secretsDirectory = () => isolatedUserPath(process.env.COMBORUNNER_SECRETS_DIR || appDirs().secrets);

const keyFile = (targetId: string, directory = secretsDirectory()) => join(directory, `${targetId}.key`);
const validTargetId = (id: string) => /^api-[a-z0-9-]{1,40}$/.test(id);

export function apiTarget(root: string, dataDir: string, preset: ApiPreset, id: string, label: string): RuntimeTarget {
  if (!validTargetId(id)) throw new Error('API 标识无效。');
  const home = join(dataDir, 'api', id);
  return {
    id,
    provider: 'pi',
    gateway: 'api',
    apiProvider: preset.id,
    ...(preset.tier === 'free' ? { apiBaseUrl: preset.endpoint?.baseUrl || undefined, apiMayLog: preset.mayLog } : {}),
    label,
    environment: 'native',
    enabled: true,
    commandDiscovery: 'auto',
    accountingMode: 'usage',
    command: managedNodeRuntime(root),
    agentDir: join(home, 'agent'),
    args: [
      join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js'),
      '--session-dir',
      join(home, 'sessions'),
    ],
  };
}

export function validApiKey(key: string): string {
  const value = key.trim();
  if (!value || value.length > 4096 || /[\s\0]/.test(value)) throw new Error('Key 格式不对。');
  return value;
}

export async function saveApiKey(targetId: string, key: string, directory = secretsDirectory()): Promise<void> {
  if (!validTargetId(targetId)) throw new Error('API 标识无效。');
  const file = keyFile(targetId, directory);
  const before = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  await writePrivateConfig(file, validApiKey(key), before);
}

export function readApiKey(targetId: string, directory = secretsDirectory()): string | undefined {
  if (!validTargetId(targetId)) return undefined;
  const file = keyFile(targetId, directory);
  if (!existsSync(file)) return undefined;
  return readFileSync(file, 'utf8').trim() || undefined;
}

export async function removeApiKey(targetId: string, directory = secretsDirectory()): Promise<void> {
  if (!validTargetId(targetId)) return;
  await unlink(keyFile(targetId, directory)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

export const keyHint = (key?: string) => (key ? `…${key.slice(-4)}` : undefined);

/** Only system variables, an isolated home and this one platform's key; no ambient credentials. */
/**
 * Pi reads built-in provider overrides from models.json in the executor's own folder.
 * Anthropic keys may need a workspace header. DeepSeek V4 Pro also supports low effort, which Pi 1.2.0's
 * catalog disables; override just that level without copying the catalog or its USD prices.
 */
export function syncApiModelsConfig(target: RuntimeTarget, preset: ApiPreset, host: Host = currentHost()) {
  if (!target.agentDir || preset.tier === 'free' || (!preset.endpoint && preset.id !== 'custom-api')) return;
  if (underTest() && !testPath(target.agentDir)) throw new UnderTestError('API config outside test directory');
  const file = join(target.agentDir, 'models.json');
  const workspace = preset.id === 'anthropic' ? target.apiWorkspaceId : undefined;
  const providers: Record<string, any> = workspace
    ? { anthropic: { headers: { 'anthropic-workspace-id': workspace } } }
    : preset.id === 'deepseek'
      ? { deepseek: { modelOverrides: { 'deepseek-v4-pro': { thinkingLevelMap: { low: 'low' } } } } }
      : {};
  if (preset.id === 'custom-api') {
    const { provider: _provider, baseUrl, ...model } = apiConnectionModel(target, host);
    providers[preset.runtimeProvider] = { baseUrl, apiKey: `$${preset.keyVariable}`, models: [model] };
  }
  const catalog = apiCatalog(target);
  if (preset.id === 'meta-model-api')
    providers[preset.runtimeProvider] = {
      baseUrl: preset.endpoint!.baseUrl,
      api: preset.endpoint!.api,
      apiKey: `$${preset.keyVariable}`,
      models: catalog.map(({ provider: _provider, baseUrl: _baseUrl, ...model }) => model),
    };
  const known = new Set(catalog.map((model) => model.id));
  const api = (catalog.find((model) => model.api === preset.endpoint?.api) ?? catalog[0])?.api;
  const models = (preset.id === 'custom-api' ? [] : (readApiModelList(target)?.ids ?? []))
    .filter((id) => !known.has(id))
    .map((id) => ({ id, api }));
  if (models.length) providers[preset.runtimeProvider] = { ...providers[preset.runtimeProvider], models };
  const wanted = `${JSON.stringify({ providers }, null, 2)}\n`;
  const current = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  if (current === wanted) return;
  mkdirSync(target.agentDir, { recursive: true });
  writeFileSync(file, wanted, 'utf8');
}

export function apiEnvironment(
  target: RuntimeTarget,
  preset: ApiPreset,
  key: string | undefined,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!target.agentDir) throw new Error('API 执行器缺少独立配置目录。');
  syncApiModelsConfig(target, preset);
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source))
    if (
      /^(path|systemroot|windir|comspec|pathext|temp|tmp|programfiles|programfiles\(x86\)|commonprogramfiles|processor_architecture|number_of_processors|lang|lc_all|http_proxy|https_proxy|no_proxy)$/i.test(
        name,
      )
    )
      env[name] = value;
  return {
    ...env,
    USERPROFILE: target.agentDir,
    HOME: target.agentDir,
    APPDATA: join(target.agentDir, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(target.agentDir, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(target.agentDir, 'config'),
    XDG_CACHE_HOME: join(target.agentDir, 'cache'),
    PI_CODING_AGENT_DIR: target.agentDir,
    ELECTRON_RUN_AS_NODE: '1',
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    ...(underTest()
      ? {
          PUGPORT_UNDER_TEST: '1',
          NODE_OPTIONS: `--import=${new URL('./platform/under-test.mjs', import.meta.url).href}`,
          HTTP_PROXY: 'http://127.0.0.1:1',
          HTTPS_PROXY: 'http://127.0.0.1:1',
          NO_PROXY: 'localhost,127.0.0.1,::1',
        }
      : {}),
    ...(preset.tier === 'free' ? { PUGPORT_SOURCE_KEY: key || 'local' } : key ? { [preset.keyVariable]: key } : {}),
  };
}

type Fetch = typeof fetch;
const number = (value: unknown) => {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * An Anthropic key that is not scoped to a workspace must name one on every request, and such a key may list its
 * organization's workspaces. The workspace is picked for the user: the only one there is, otherwise the
 * organization's Default Workspace (the one that only appears when asked to include the default). A key scoped
 * to one workspace, or without permission to list them, is refused here and nothing is picked.
 */
export async function detectAnthropicWorkspace(
  key: string,
  fetchImpl: Fetch = fetch,
): Promise<{ workspace: string } | Omit<WorkspaceLookupFailure, 'at'>> {
  const list = async (includeDefault: boolean): Promise<{ ids: string[] } | { status: number }> => {
    const response = await fetchImpl(
      `https://api.anthropic.com/v1/organizations/workspaces?limit=100${includeDefault ? '&include_default=true' : ''}`,
      {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) return { status: response.status };
    const body = (await response.json()) as { data?: unknown };
    return {
      ids: (Array.isArray(body.data) ? body.data : []).flatMap((item: any) =>
        typeof item?.id === 'string' && validWorkspaceId(item.id) && !item.archived_at ? [item.id as string] : [],
      ),
    };
  };
  try {
    const all = await list(true);
    if (!('ids' in all)) return { outcome: 'refused', status: all.status };
    if (!all.ids.length) return { outcome: 'none' };
    if (all.ids.length === 1) return { workspace: all.ids[0] };
    const named = await list(false);
    if (!('ids' in named)) return { outcome: 'refused', status: named.status };
    const defaults = all.ids.filter((id) => !named.ids.includes(id));
    return defaults.length === 1 ? { workspace: defaults[0] } : { outcome: 'several', count: all.ids.length };
  } catch {
    return { outcome: 'network' };
  }
}

/** Reads the account balance from a platform's documented, free balance endpoint. */
export async function fetchBalance(
  preset: ApiPreset,
  key: string,
  fetchImpl: Fetch = fetch,
  now = () => new Date(),
): Promise<ApiBalance> {
  const observedAt = now().toISOString();
  if (!preset.balance) return { observedAt, error: '该平台不提供余额查询，请在控制台查看。' };
  const url = {
    deepseek: 'https://api.deepseek.com/user/balance',
    openrouter: 'https://openrouter.ai/api/v1/credits',
    moonshot: 'https://api.moonshot.ai/v1/users/me/balance',
    'moonshot-cn': 'https://api.moonshot.cn/v1/users/me/balance',
  }[preset.balance];
  try {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401 || response.status === 403) return { observedAt, error: 'Key 无效或没有权限。' };
    if (!response.ok) return { observedAt, error: `查询失败（${response.status}）。` };
    const body = (await response.json()) as Record<string, any>;
    let amounts: ApiBalance['amounts'] = [];
    if (preset.balance === 'deepseek')
      amounts = (Array.isArray(body.balance_infos) ? body.balance_infos : []).flatMap((item: any) => {
        const total = number(item?.total_balance);
        return total === undefined ? [] : [{ currency: String(item.currency || 'CNY'), total }];
      });
    else if (preset.balance === 'openrouter') {
      const credits = number(body.data?.total_credits),
        used = number(body.data?.total_usage);
      if (credits !== undefined && used !== undefined) amounts = [{ currency: 'USD', total: credits - used }];
    } else {
      const available = number(body.data?.available_balance);
      if (available !== undefined)
        amounts = [{ currency: preset.balance === 'moonshot-cn' ? 'CNY' : 'USD', total: available }];
    }
    return amounts.length ? { observedAt, amounts } : { observedAt, error: '平台返回的余额格式无法识别。' };
  } catch {
    return { observedAt, error: '网络错误，稍后再试。' };
  }
}

export const validateApiBaseUrl = validateFreeBaseUrl;
