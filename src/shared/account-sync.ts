import type { Settings } from './types.ts';

export const syncKinds = [
  'conversation',
  'message',
  'human-message',
  'conversation-folder',
  'project',
  'memory',
  'remote-server',
  'server-node',
  'api-provider',
] as const;
export type SyncKind = (typeof syncKinds)[number] | 'settings';
export type SyncValue = Record<string, unknown>;
export type SyncPayload = { owner: string; value: SyncValue; deleted: boolean; observedSeq?: number };
export const syncSettingsKeys = [
  'globalInstructions',
  'routePolicy',
  'routingRules',
  'routingProfiles',
  'routeGoal',
  'routePreferencesEnabled',
  'decisionMode',
  'composerSendKey',
  'appearanceTheme',
  'appearanceAccent',
  'locale',
  'steerOnSend',
  'notifyOnFinish',
  'notifySound',
  'showAutomaticReplyIdentity',
  'showAgentConversations',
  'agentPresets',
] as const satisfies readonly (keyof Settings)[];
export const localProjectKeys = [
  'path',
  'trusted',
  'approvedVerificationCommands',
  'localMemory',
  'manuscript',
  'mcpServers',
  'folderMissing',
] as const;
export const localLaneKeys = [
  'workspaceId',
  'base',
  'baseCommit',
  'branch',
  'files',
  'cleanup',
  'githubState',
  'worktree',
  'worktreePath',
  'branchName',
  'baseBranch',
  'executionDirectory',
] as const;
export const localConversationKeys = ['modWorkspaceId', 'modApproval'] as const;

// Equivalent to toWellFormed().replaceAll('\u0000', '�'), with the project's ES2022 typings.
function normalizeSyncStrings(value: unknown): unknown {
  if (typeof value === 'string')
    return value.replace(/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
  if (Array.isArray(value)) return value.map(normalizeSyncStrings);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [normalizeSyncStrings(key), normalizeSyncStrings(entry)]),
    );
  return value;
}

export function filterSyncValue(kind: string, source: SyncValue): SyncValue {
  const value = normalizeSyncStrings(source) as SyncValue;
  if (kind === 'settings')
    return Object.fromEntries(syncSettingsKeys.filter((k) => Object.hasOwn(value, k)).map((k) => [k, value[k]]));
  if (kind === 'project') for (const key of localProjectKeys) delete value[key];
  if (kind === 'conversation') for (const key of localConversationKeys) delete value[key];
  if (kind === 'conversation' && value.lane && typeof value.lane === 'object') {
    const lane = value.lane as SyncValue;
    for (const key of localLaneKeys) delete lane[key];
  }
  if (Array.isArray(value.attachments))
    value.attachments = value.attachments.map((a) =>
      Object.fromEntries(
        ['id', 'name', 'mimeType', 'size', 'kind'].filter((k) => Object.hasOwn(a, k)).map((k) => [k, a[k]]),
      ),
    );
  return value;
}

/** Both conflict merging and outbox equality must ignore JSON property insertion order. */
export function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as SyncValue)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export function replaceSyncedSettings(target: object, incoming: SyncValue): void {
  for (const key of syncSettingsKeys) delete (target as SyncValue)[key];
  Object.assign(target, filterSyncValue('settings', incoming));
}

export type SyncStatus = 'off' | 'syncing' | 'idle' | 'offline' | `error: ${string}`;
export type SyncConfig = { url: string; publishableKey: string };
/** Official distribution defaults live only here; the publishable key is public by design and RLS guards the data. Self-hosters override both environment variables. */
export const officialSyncConfig: Readonly<SyncConfig> = {
  url: 'https://ixfyfczpwsxwrjuuiduz.supabase.co',
  publishableKey: 'sb_publishable_POYqJNbcRCrv3S6yyT2wFg_x1Lq1OaG',
};
export function readSyncConfig(env: NodeJS.ProcessEnv = process.env): SyncConfig {
  return {
    url: env.PUGPORT_SUPABASE_URL ?? officialSyncConfig.url,
    publishableKey: env.PUGPORT_SUPABASE_PUBLISHABLE_KEY ?? officialSyncConfig.publishableKey,
  };
}
export function configuredSync(config: SyncConfig): boolean {
  if (!config.url || !config.publishableKey.startsWith('sb_publishable_')) return false;
  try {
    const url = new URL(config.url);
    return (
      !url.username &&
      !url.password &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}
