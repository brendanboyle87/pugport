import { providerSpec } from './provider-registry.ts';

/**
 * Grouped executor and model pickers (.design/picker-groups.md). Executors group by their registry transport, models
 * by what they output. Image and video models are listed in the picker but never join text routing: they live in
 * RuntimeSnapshot.mediaModels, apart from the chat catalog in RuntimeSnapshot.models.
 */
export type ModelModality = 'text' | 'image' | 'video';

/** An image or video model an API card's platform listed for its key. */
export type MediaModelInfo = {
  /** `${runtimeProvider}/${platform id}`, like the chat catalog's ids. */
  id: string;
  label: string;
  modality: Exclude<ModelModality, 'text'>;
  /** PugPort has no working endpoint for this model on this card yet: listed, but not selectable. */
  unsupported?: true;
};

/**
 * What a model outputs, from the catalog's own metadata where the provider gives it, otherwise from its id. Returns
 * undefined for text (chat) models.
 */
export function mediaModelKind(id: string, metadata?: unknown): MediaModelInfo['modality'] | undefined {
  const item = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {};
  const architecture =
    item.architecture && typeof item.architecture === 'object' ? (item.architecture as Record<string, unknown>) : {};
  const outputs = Array.isArray(item.output_modalities)
    ? item.output_modalities
    : Array.isArray(architecture.output_modalities)
      ? architecture.output_modalities
      : undefined;
  if (outputs?.includes('video')) return 'video';
  if (outputs?.includes('image')) return 'image';
  // Output modalities that list nothing visual are a chat model, whatever the id says.
  if (outputs?.length) return undefined;
  const methods = Array.isArray(item.supportedGenerationMethods) ? item.supportedGenerationMethods : [];
  if (methods.includes('predictLongRunning') && /(?:^|\/)veo-/i.test(id)) return 'video';
  const name = id.slice(id.lastIndexOf('/') + 1);
  if (/^(?:sora|veo)(?:-|$)|grok-imagine-video|(?:^|-)video(?:-|$)/i.test(name)) return 'video';
  if (
    /^(?:gpt-image-|chatgpt-image|dall-e-|imagen-)|grok-imagine-image|grok-\d+(?:\.\d+)?-image|-image(?:-preview|-generation)?(?:-\d+)?$/i.test(
      name,
    )
  )
    return 'image';
  return undefined;
}

/** Executor picker groups, in display order. */
export type ExecutorGroup = 'cli' | 'api';
export const executorGroupLabels: Record<ExecutorGroup, string> = { cli: 'CLI · 订阅', api: 'API · 按量' };
/** By the card's runtime transport in the registry, never by its name, so new cards land in the right group. */
export const executorGroup = (provider: string): ExecutorGroup =>
  providerSpec(provider)?.transport === 'api' ? 'api' : 'cli';

export const modelGroupLabels: Record<ModelModality, string> = { text: '文字', image: '图片', video: '视频' };
/**
 * English group headers as the picker spec words them. The shared catalog already translates 图片 and 视频 as the
 * plural media-type filters (Images, Videos), so the picker names its English groups itself.
 */
export const modelGroupLabelsEn: Record<ModelModality, string> = { text: 'Text', image: 'Image', video: 'Video' };
export const modelGroupOrder: readonly ModelModality[] = ['text', 'image', 'video'];

/** Shown on a listed model PugPort cannot run on this card yet. */
export const unsupportedMediaTitle: Record<MediaModelInfo['modality'], string> = {
  image: '这个执行器暂不支持图片生成',
  video: '这个执行器暂不支持视频生成',
};

/** Groups at or under this many items in the whole picker start open; longer pickers get a filter field. */
export const shortPickerItems = 12;

/** Lower case, full-width folded to ASCII (Chinese input methods can type ｇｐｔ), separators and IME apostrophes dropped. */
const compact = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s'’\-_.·/:()]+/g, '');

/**
 * Whether a picker item matches what was typed in its filter: every space-separated word appears in one of the item's
 * texts (its name, its id), ignoring case and separators, so "gpt54", "GPT 5.4" and "gpt-5.4" all find gpt-5.4.
 */
export function pickerMatches(texts: ReadonlyArray<string | undefined>, query: string): boolean {
  const words = query.normalize('NFKC').trim().split(/\s+/).map(compact).filter(Boolean);
  if (!words.length) return true;
  const haystack = texts.flatMap((text) => (text ? [compact(text)] : []));
  return words.every((word) => haystack.some((text) => text.includes(word)));
}

/**
 * A model id read for its age, from its structure only: the version it names and any date or build stamp pinned
 * to it. "claude-3-5-sonnet-20241022" → line claude, family claude-sonnet, version 3.5, stamp 20241022, base
 * claude-3-5-sonnet. The line is the name before the version (gpt, claude-opus, o, deepseek-r); the family is every
 * word of the name, wherever it sits, so claude-3-5-sonnet and claude-sonnet-4-5 are one family.
 */
export function readModelAge(id: string) {
  const tokens = id
    .slice(id.lastIndexOf('/') + 1)
    .toLowerCase()
    .split(/[-_:\s]+/)
    .filter(Boolean);
  const words: string[] = [];
  const kept: string[] = [];
  const stamp: string[] = [];
  let line: string | undefined;
  let major: number | undefined;
  let minor = 0;
  let afterMajor = false;
  for (const token of tokens) {
    const numeric = /^(\d+)(?:\.(\d+))?([a-z]*)$/.exec(token);
    const lettered = /^([a-z]+)(\d{1,2})(?:\.(\d+))?$/.exec(token);
    const versionAt = afterMajor;
    afterMajor = false;
    if (numeric) {
      const [, whole, decimal, suffix] = numeric as unknown as [string, string, string | undefined, string];
      // Once a date starts (2025-01-25), its later parts are date too, never a version.
      const small = whole.length <= 2 && !/^0\d/.test(whole) && !stamp.length;
      // Sizes and windows (8b, 70b, 32k) are part of the name, not a version.
      if (/^[bkm]$/.test(suffix)) {
        words.push(token);
        kept.push(token);
      } else if (major === undefined && small) {
        // 4o, 4.1, 5: the suffix letter of 4o is not a separate model line.
        line = words.join('-');
        major = Number(whole);
        minor = decimal ? Number(decimal) : 0;
        afterMajor = !decimal;
        kept.push(token);
      } else if (versionAt && small && !suffix) {
        // claude-3-5: the minor version written as its own part.
        minor = Number(whole);
        kept.push(token);
      } else if (!suffix) stamp.push(token);
      else {
        words.push(token);
        kept.push(token);
      }
      continue;
    }
    if (lettered && major === undefined) {
      // o1, o4-mini, qwen3, deepseek-v3.1, kimi-k2: the letters belong to the line.
      words.push(lettered[1]!);
      line = words.join('-');
      major = Number(lettered[2]);
      minor = lettered[3] ? Number(lettered[3]) : 0;
      kept.push(token);
      continue;
    }
    words.push(token);
    kept.push(token);
  }
  return {
    line: line ?? words.join('-'),
    family: words.join('-'),
    ...(major === undefined ? {} : { major, minor }),
    /** Date or build digits pinned to the id (2024-08-06, 0613, 001), joined; empty when none. */
    stamp: stamp.join(''),
    /** The id without its stamp: the alias a dated snapshot pins. */
    base: kept.join('-'),
  };
}

/**
 * Splits a long text-model list into the current models and the rest, which the picker keeps in a collapsed More
 * models group. Judged from the ids alone, so it never needs a list of retired names:
 * - a dated or numbered snapshot whose undated alias, or a later snapshot of the same alias, is also listed;
 * - an older generation: a lower major version than the newest of its line (gpt-4.1 beside gpt-5) or of its family
 *   (claude-3-5-sonnet beside claude-sonnet-4-5).
 * The catalog's default model always stays current. Short lists are left whole. Order within each part is kept.
 */
export function splitOlderModels<T extends { id: string; catalogDefault?: boolean }>(
  models: readonly T[],
): { current: T[]; older: T[] } {
  if (models.length <= shortPickerItems) return { current: [...models], older: [] };
  const ages = models.map((model) => readModelAge(model.id));
  const newest = (key: 'line' | 'family') => {
    const top = new Map<string, number>();
    for (const age of ages)
      if (age.major !== undefined) top.set(age[key], Math.max(top.get(age[key]) ?? age.major, age.major));
    return top;
  };
  const lines = newest('line');
  const families = newest('family');
  const older = new Set<T>();
  models.forEach((model, index) => {
    const age = ages[index]!;
    if (model.catalogDefault) return;
    const superseded =
      !!age.stamp &&
      ages.some(
        (other, at) =>
          at !== index &&
          other.base === age.base &&
          (!other.stamp || (other.stamp.length === age.stamp.length && other.stamp > age.stamp)),
      );
    const behind =
      age.major !== undefined && (lines.get(age.line)! > age.major || families.get(age.family)! > age.major);
    if (superseded || behind) older.add(model);
  });
  return {
    current: models.filter((model) => !older.has(model)),
    older: models.filter((model) => older.has(model)),
  };
}

/**
 * Which groups are open when a picker opens. The selection's group is always open; other groups follow what the
 * owner chose last time, and otherwise start open only when the whole list is short.
 */
export function openPickerGroups(input: {
  groups: ReadonlyArray<{ id: string; count: number }>;
  selectedGroup?: string;
  remembered?: Readonly<Record<string, boolean>>;
}): Set<string> {
  const total = input.groups.reduce((sum, group) => sum + group.count, 0);
  const open = new Set<string>();
  for (const group of input.groups) {
    const remembered = input.remembered?.[group.id];
    if (group.id === input.selectedGroup || (remembered ?? total <= shortPickerItems)) open.add(group.id);
  }
  return open;
}
