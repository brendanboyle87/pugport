import './platform/under-test.ts';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getBuiltinModels, type BuiltinProvider } from '@earendil-works/pi-ai/providers/all';
import { apiPreset, metaModelIds, validateApiConnection } from '../shared/api-providers.ts';
import type { ModelInfo, RuntimeTarget } from '../shared/types.ts';
import { bestOpenAiImageModel, supportedOpenAiImageModel } from '../shared/image-generation.ts';
import type { MediaModelInfo } from '../shared/model-groups.ts';
import { probeFreeSource } from './free-sources.ts';
import { customApiLimits } from './platform/api-limits.ts';
import { currentHost, type Host } from './platform/host.ts';
import { testPath, underTest } from './platform/under-test.ts';

const day = 86_400_000;
const flights = new Map<string, Promise<void>>();
const attempts = new Map<string, number>();
/** images, videos: the platform's media models, kept apart from ids so they never enter the chat catalog. */
type ModelList = {
  preset: string;
  checkedAt: number;
  ids: string[];
  retired: string[];
  images?: string[];
  videos?: string[];
  /** Lists written before media models were kept lack this, so they refresh once instead of waiting a day. */
  media?: true;
};
const cacheFile = (target: RuntimeTarget) => join(target.agentDir!, 'model-list.json');
const validIds = (ids: unknown): ids is string[] =>
  Array.isArray(ids) &&
  ids.length <= 4000 &&
  ids.every((id) => typeof id === 'string' && id.length <= 256 && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(id));

export function readApiModelList(target: RuntimeTarget): ModelList | undefined {
  if (!target.agentDir || (underTest() && !testPath(target.agentDir))) return;
  try {
    const list = JSON.parse(readFileSync(cacheFile(target), 'utf8'));
    if (
      list.preset === target.apiProvider &&
      Number.isFinite(list.checkedAt) &&
      validIds(list.ids) &&
      validIds(list.retired) &&
      (list.images === undefined || validIds(list.images)) &&
      (list.videos === undefined || validIds(list.videos))
    )
      return target.apiProvider === 'meta-model-api'
        ? { ...list, ids: list.ids.filter((id: string) => metaModelIds.includes(id)) }
        : list;
  } catch {
    /* A missing or damaged cache is a catalog-only read. */
  }
}

/** Image models the card's platform listed for its key; only image generation reads these. */
export function apiImageModels(target: RuntimeTarget): string[] {
  return apiPreset(target.apiProvider)?.images ? (readApiModelList(target)?.images ?? []) : [];
}

/**
 * The card's image and video models for the picker's Image and Video groups. Image models run only where the platform
 * has an image API in PugPort (ApiPreset.images); video models have no endpoint in PugPort yet, so they are listed but
 * not selectable.
 */
export function apiMediaModels(target: RuntimeTarget): MediaModelInfo[] {
  const preset = apiPreset(target.apiProvider);
  if (target.gateway !== 'api' || !preset?.endpoint || preset.tier === 'free' || preset.id === 'custom-api') return [];
  const list = readApiModelList(target);
  const entry = (id: string, modality: MediaModelInfo['modality'], supported: boolean): MediaModelInfo => ({
    id: `${preset.runtimeProvider}/${id}`,
    label: id,
    modality,
    ...(supported ? {} : { unsupported: true as const }),
  });
  const images = [...(list?.images ?? [])].sort((a, b) => a.localeCompare(b));
  const best = bestOpenAiImageModel(images);
  return [
    // The model PugPort would pick first leads its group.
    ...(best ? [best] : []),
    ...images.filter((id) => id !== best),
  ]
    .map((id) => entry(id, 'image', preset.images === 'openai-images' && supportedOpenAiImageModel(id)))
    .concat([...(list?.videos ?? [])].sort((a, b) => a.localeCompare(b)).map((id) => entry(id, 'video', false)));
}

export function apiConnectionModel(target: RuntimeTarget, host: Host = currentHost()) {
  const connection = validateApiConnection(target.apiConnection);
  const limits = customApiLimits(connection, host);
  return {
    provider: apiPreset('custom-api')!.runtimeProvider,
    id: connection.model,
    name: connection.model,
    api: connection.protocol,
    baseUrl: connection.baseUrl,
    reasoning: false,
    input: ['text'],
    contextWindow: limits.contextWindow,
    maxTokens: limits.maxTokens,
    cost: {
      input: connection.price?.input ?? 0,
      output: connection.price?.output ?? 0,
      cacheRead: connection.price?.input ?? 0,
      cacheWrite: (connection.price?.input ?? 0) * 2,
    },
  };
}

export const apiCatalog = (target: RuntimeTarget) => {
  const preset = apiPreset(target.apiProvider)!;
  if (preset.id === 'custom-api') return [apiConnectionModel(target)];
  if (preset.id === 'meta-model-api')
    return metaModelIds.map((id) => ({
      provider: preset.runtimeProvider,
      id,
      name: id,
      api: preset.endpoint!.api,
      baseUrl: preset.endpoint!.baseUrl,
      reasoning: false,
      input: ['text'],
      // shortcut: limits are unverified; reuse custom API limits until official limits are confirmed.
      contextWindow: 32768,
      maxTokens: 4096,
      cost: {
        input: id === 'muse-wonder-1.0' ? 4 : 1.25,
        output: id === 'muse-wonder-1.0' ? 20 : 4.25,
        cacheRead: id === 'muse-wonder-1.0' ? 0.2 : 0.15,
        // Pi's unknown cache-write placeholder, not a verified Meta price.
        cacheWrite: 0,
      },
    }));
  return getBuiltinModels(preset.runtimeProvider as BuiltinProvider);
};

export function mergeApiModels(target: RuntimeTarget, models: ModelInfo[]): ModelInfo[] {
  const preset = apiPreset(target.apiProvider);
  if (preset?.id === 'custom-api') {
    const connection = validateApiConnection(target.apiConnection);
    const id = `${preset.runtimeProvider}/${connection.model}`;
    return models
      .filter((model) => model.id === id)
      .map(({ price: _price, priceSource: _source, ...model }) => ({
        ...model,
        efforts: ['off'],
        ...(connection.price ? { price: connection.price, priceSource: 'user-estimate' as const } : {}),
      }));
  }
  if (!preset?.endpoint || preset.tier === 'free') return models;
  const list = readApiModelList(target);
  const catalog = new Set(apiCatalog(target).map((model) => `${preset.runtimeProvider}/${model.id}`));
  const retired = new Set(list?.retired.map((id) => `${preset.runtimeProvider}/${id}`));
  const known = models.filter((model) => catalog.has(model.id) && !retired.has(model.id));
  return [
    ...known,
    ...(list?.ids ?? []).flatMap((id): ModelInfo[] => {
      const fullId = `${preset.runtimeProvider}/${id}`;
      return catalog.has(fullId) || retired.has(fullId)
        ? []
        : [{ id: fullId, label: id, efforts: [], discovered: true }];
    }),
  ];
}

/** A corrected key must not inherit the old key's cooldown or pending result. */
export function clearApiModelList(target: RuntimeTarget): void {
  if (!target.agentDir || (underTest() && !testPath(target.agentDir))) return;
  const file = cacheFile(target);
  rmSync(file, { force: true });
  attempts.delete(file);
  flights.delete(file);
}

/** Per-card cache includes failed attempts, so a bad key cannot cause repeated daily requests. */
export function refreshApiModelList(
  target: RuntimeTarget,
  key: string | undefined,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<void> {
  const preset = apiPreset(target.apiProvider);
  if (!target.agentDir || !preset?.endpoint || preset.tier === 'free' || !key) return Promise.resolve();
  if (underTest() && !testPath(target.agentDir)) return Promise.resolve();
  const file = cacheFile(target);
  const pending = flights.get(file);
  if (pending) return pending;
  const cached = readApiModelList(target);
  const checkedAt = attempts.get(file) ?? cached?.checkedAt;
  if (checkedAt !== undefined && now >= checkedAt && now - checkedAt < day && (cached?.media || attempts.has(file)))
    return Promise.resolve();
  attempts.set(file, now);
  const task = probeFreeSource(target, key, fetchImpl)
    .then((result) => {
      if (flights.get(file) !== task) return;
      const list: ModelList = {
        preset: preset.id,
        checkedAt: now,
        ids: result.error ? (cached?.ids ?? []) : result.models.map((model) => model.id),
        retired: result.error ? (cached?.retired ?? []) : (result.retiredIds ?? []),
        ...(result.error ? (cached?.media ? { media: true as const } : {}) : { media: true as const }),
        ...((result.error ? cached?.images : result.imageModelIds)?.length
          ? { images: result.error ? cached!.images : result.imageModelIds }
          : {}),
        ...((result.error ? cached?.videos : result.videoModelIds)?.length
          ? { videos: result.error ? cached!.videos : result.videoModelIds }
          : {}),
      };
      mkdirSync(target.agentDir!, { recursive: true });
      writeFileSync(file, `${JSON.stringify(list)}\n`, 'utf8');
    })
    .catch(() => undefined)
    .finally(() => {
      if (flights.get(file) === task) flights.delete(file);
    });
  flights.set(file, task);
  return task;
}
