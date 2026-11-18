import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { apiLimitRange, apiPreset, validateApiConnection, validateFreeBaseUrl } from '../shared/api-providers.ts';
import { stableJson, type SyncValue } from '../shared/account-sync.ts';
import type { RuntimeTarget } from '../shared/types.ts';
import { readApiKey, saveApiKey, removeApiKey, validApiKey } from './api-providers.ts';
import { readApiModelList } from './api-model-discovery.ts';
import { apiBudgetInput } from './api-budget.ts';

const date = z
  .string()
  .max(40)
  .refine((value) => Number.isFinite(Date.parse(value)));
const modelId = z
  .string()
  .max(256)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/);
// A limit travels with its connection; only macOS applies it (platform/api-limits.ts). validateApiConnection re-checks it.
const tokenLimit = z.number().int().min(apiLimitRange.min).max(apiLimitRange.max).optional();
const cardSchema = z
  .object({
    apiProvider: z
      .string()
      .max(60)
      .refine((id) => !!apiPreset(id)),
    apiBaseUrl: z.string().max(2000).optional(),
    apiConnection: z
      .object({
        protocol: z.enum(['azure-openai-responses', 'openai-responses', 'openai-completions', 'anthropic-messages']),
        baseUrl: z.string().max(2000),
        model: modelId,
        price: z
          .object({ input: z.number().positive().finite(), output: z.number().positive().finite() })
          .strict()
          .optional(),
        limits: z.object({ contextWindow: tokenLimit, maxTokens: tokenLimit }).strict().optional(),
      })
      .strict()
      .optional(),
    apiMayLog: z.boolean().optional(),
    apiWorkspaceId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,100}$/)
      .optional(),
    label: z.string().min(1).max(60),
    enabled: z.boolean(),
    executionDisabledByUser: z.boolean().optional(),
    accountingMode: z.enum(['subscription', 'usage', 'auto']).optional(),
    apiBudget: z
      .object({
        limitUsd: z.number().positive().finite().optional(),
        expiresAt: date.optional(),
        perRunUsd: z.number().positive().finite(),
        maxConcurrentRuns: z.number().int().min(1).max(1000),
        burstConcurrentRuns: z.number().int().min(1).max(1000),
        preferExpiring: z.boolean(),
        monthlyUsd: z.number().positive().finite().optional(),
        linkedAccountId: z.string().max(200).optional(),
        startedAt: date,
      })
      .strict()
      .optional(),
  })
  .strict();
const valueSchema = z
  .object({
    id: z.string().regex(/^api-[a-z0-9-]{1,40}$/),
    card: cardSchema,
    key: z.string().max(4096).optional(),
    excluded: z.boolean(),
    models: z
      .object({ ids: z.array(modelId).max(4000), retired: z.array(modelId).max(4000) })
      .strict()
      .optional(),
  })
  .strict();
export type SyncedApiProvider = z.infer<typeof valueSchema>;
export type ApiSyncRecord = { id: string; value: SyncedApiProvider };
export type ApiSyncKeys = {
  read: (id: string) => string | undefined;
  save: (id: string, key: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
};
export const apiSyncKeys: ApiSyncKeys = { read: readApiKey, save: saveApiKey, remove: removeApiKey };

export function validateApiProviderValue(value: unknown): SyncedApiProvider {
  try {
    const parsed = valueSchema.parse(value);
    if (parsed.key !== undefined) parsed.key = validApiKey(parsed.key);
    if (parsed.card.apiBaseUrl) parsed.card.apiBaseUrl = validateFreeBaseUrl(parsed.card.apiBaseUrl);
    if (parsed.card.apiProvider === 'custom-api')
      parsed.card.apiConnection = validateApiConnection(parsed.card.apiConnection);
    else if (parsed.card.apiConnection) throw Error('INVALID_API_PROVIDER');
    if (parsed.card.apiBudget) {
      const { startedAt, ...budget } = parsed.card.apiBudget;
      parsed.card.apiBudget = { ...apiBudgetInput.parse(budget), startedAt };
    }
    return parsed;
  } catch {
    throw Error('INVALID_API_PROVIDER');
  }
}
export function apiProviderIdentity(value: SyncValue): string {
  const parsed = validateApiProviderValue(value);
  const base =
    parsed.card.apiConnection?.baseUrl ??
    parsed.card.apiBaseUrl ??
    apiPreset(parsed.card.apiProvider)?.endpoint?.baseUrl ??
    '';
  const normalized = base ? new URL(validateFreeBaseUrl(base)).toString().replace(/\/+$/, '') : '';
  return createHash('sha256')
    .update(stableJson([parsed.card.apiProvider, normalized, parsed.key ?? '']))
    .digest('hex');
}
export function portableApiCard(target: RuntimeTarget): SyncedApiProvider['card'] {
  return cardSchema.parse(
    Object.fromEntries(
      Object.keys(cardSchema.shape)
        .filter((key) => Object.hasOwn(target, key))
        .map((key) => [key, (target as unknown as SyncValue)[key]]),
    ),
  );
}
export function apiSyncModels(target: RuntimeTarget): SyncedApiProvider['models'] {
  const list = readApiModelList(target);
  return list && { ids: list.ids, retired: list.retired };
}
export function writeApiSyncModels(target: RuntimeTarget, models: SyncedApiProvider['models']) {
  if (!target.agentDir || !models) return;
  mkdirSync(target.agentDir, { recursive: true });
  writeFileSync(
    join(target.agentDir, 'model-list.json'),
    JSON.stringify({ preset: target.apiProvider, checkedAt: Date.now(), ...models }) + '\n',
    'utf8',
  );
}
export const localApiUnavailable = '这台电脑的本地 API 或模型不可用。';
export function localApiDependency(target: RuntimeTarget): { url?: string; modelPath?: string } | undefined {
  if (target.gateway !== 'api') return;
  const model = target.apiConnection?.model;
  const modelPath = model && (isAbsolute(model) || /^[a-z]:[\\/]/i.test(model)) ? model : undefined;
  const base = target.apiConnection?.baseUrl ?? target.apiBaseUrl ?? apiPreset(target.apiProvider)?.endpoint?.baseUrl;
  let localUrl: string | undefined;
  try {
    const url = new URL(base ?? '');
    if (url.hostname === 'localhost' || /^127\./.test(url.hostname) || url.hostname === '[::1]')
      localUrl = validateFreeBaseUrl(base!);
  } catch {
    /* Invalid endpoints are rejected by card validation. */
  }
  return localUrl || modelPath ? { url: localUrl, modelPath } : undefined;
}
/** No key, authorization header, response body, redirect or model execution. Health stays on this computer. */
export async function checkLocalApi(target: RuntimeTarget, request: typeof fetch = fetch): Promise<boolean> {
  const local = localApiDependency(target);
  if (!local) return true;
  if (local.modelPath && !existsSync(local.modelPath)) return false;
  if (!local.url) return true;
  try {
    await request(local.url, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}
export interface ApiSyncHost {
  readSyncedApiCards(keys?: ApiSyncKeys): Promise<ApiSyncRecord[]>;
  applySyncedApiCards(desired: ApiSyncRecord[], expected: ApiSyncRecord[], keys?: ApiSyncKeys): Promise<void>;
}
export class AccountSyncApi {
  constructor(
    private readonly host: ApiSyncHost,
    private readonly keys: ApiSyncKeys = apiSyncKeys,
  ) {}
  read() {
    return this.host.readSyncedApiCards(this.keys);
  }
  /** How many cards would sync. Reads no API key, so it never opens the system keychain. */
  async count() {
    return (await this.host.readSyncedApiCards({ ...this.keys, read: () => undefined })).length;
  }
  write(desired: { id: string; value: SyncValue }[], expected: { id: string; value: SyncValue }[]) {
    const parse = (entries: { id: string; value: SyncValue }[]) =>
      entries.map(({ id, value }) => {
        const parsed = validateApiProviderValue(value);
        if (parsed.id !== id) throw Error('INVALID_API_PROVIDER');
        return { id, value: parsed };
      });
    return this.host.applySyncedApiCards(parse(desired), parse(expected), this.keys);
  }
}
