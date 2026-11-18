/**
 * Natural-language image generation: what an executor run hands back and what a conversation keeps.
 * Routing policy lives in server/image-generation.ts; executor capability lives in provider-registry.ts.
 */

/** Host-only request on a run; never accepted from a public schema. */
export type ImageGenerationRequest = {
  /** Host-owned staging folder for this task's images, under the data folder, never the project. */
  outputDir: string;
  /** API cards: the image model to call (for example gpt-image-2). Native tools pick their own. */
  model?: string;
  /** The owner's words describing the image, sent as-is to an image API. */
  prompt: string;
  /** Standalone prompts sharing one run, reference set, and budget reservation. */
  prompts?: string[];
  /** A name per prompt (for example the character a document prompt draws), used for the saved file names. */
  titles?: string[];
  /** Per prompt, which of `references` (by index) that picture uses; absent means all of them. */
  referenceSets?: number[][];
  /** Host-resolved conversation images: the picture to edit, or visual references. Codex receives them as image input. */
  references?: Array<{ path: string; mimeType: string; name: string }>;
  /** Edit the reference images instead of drawing from text alone. */
  edit: boolean;
};

/**
 * How the image was made. native-tool: a CLI's own image tool (Codex image_generation), which does not report its
 * image model. api-images: an image API called with an exact model.
 */
export type ImageGenerationTool = 'native-tool' | 'api-images';

/** Models using the GPT Image parameters on OpenAI's Images endpoints. */
export const supportedOpenAiImageModel = (model: string): boolean => /^(?:gpt-image-|chatgpt-image-)/i.test(model);

/** One image a run produced, staged in its outputDir. */
export type GeneratedImage = {
  path: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  /** Which executor card made it, for the trace. */
  executor: string;
  runtimeId: string;
  tool: ImageGenerationTool;
  /**
   * The image model, only when the tool reports it (an API call names it exactly). Null when not reported: never the
   * executor's chat model, which only called the tool.
   */
  imageModel: string | null;
  revisedPrompt?: string;
  /** The batch item it draws, when the prompt came with a name. */
  title?: string;
};

/** Kept on the assistant message that shows the images; the newest one is the reference for a follow-up edit. */
export type MessageGeneratedImage = {
  attachmentId: string;
  executor: string;
  runtimeId: string;
  tool: ImageGenerationTool;
  /** Null when the tool did not report it; see GeneratedImage.imageModel. */
  imageModel: string | null;
  runId?: string;
  edit?: boolean;
};

/**
 * OpenAI image models, best first: the highest gpt-image-* version wins. Within one version the quality tier leads
 * (Sunburst, then the plain model, then Flare and other speed tiers, then mini), and a moving alias beats its dated
 * snapshot, so gpt-image-2.5-sunburst wins over gpt-image-2.5-sunburst-2026-09-08 and gpt-image-2.5-flare.
 */
export function bestOpenAiImageModel(ids: readonly string[]): string | undefined {
  const tier = (variant: string) => (/sunburst/i.test(variant) ? 0 : !variant ? 1 : /mini/i.test(variant) ? 3 : 2);
  const ranked = ids
    .filter((id) => /^gpt-image-\d+(?:\.\d+)?(?:-[a-z0-9.-]+)?$/i.test(id))
    .map((id) => {
      const [, major, minor, suffix = ''] = /^gpt-image-(\d+)(?:\.(\d+))?(-[a-z0-9.-]+)?$/i.exec(id)!;
      const dated = /-\d{4}-\d{2}-\d{2}$/.test(suffix);
      const variant = suffix.replace(/-\d{4}-\d{2}-\d{2}$/, '');
      return { id, version: Number(major) + Number(minor ?? 0) / 100, tier: tier(variant), dated: dated ? 1 : 0 };
    })
    .sort((a, b) => b.version - a.version || a.tier - b.tier || a.dated - b.dated || a.id.localeCompare(b.id));
  return ranked[0]?.id;
}

/**
 * The caption under generated images, as interface sentences with their names. A native tool reports no image model,
 * so its line names only the card and its built-in tool; an API line names the exact image model. The executor's chat
 * model never appears: it only called the tool.
 */
export function generatedImageCaption(
  images: readonly Pick<MessageGeneratedImage, 'executor' | 'imageModel' | 'edit'>[],
  name: (executor: string) => string = (executor) => executor,
): Array<{ sentence: string; names: [string] }> {
  const edit = images.some((image) => image.edit);
  const unique = (values: string[]) => [...new Set(values)].join('、');
  const builtIn = unique(images.filter((image) => !image.imageModel).map((image) => name(image.executor)));
  const named = unique(
    images.filter((image) => image.imageModel).map((image) => `${name(image.executor)} · ${image.imageModel}`),
  );
  return [
    ...(builtIn
      ? [{ sentence: edit ? '由 {0} 内置生图修改' : '由 {0} 内置生图生成', names: [builtIn] as [string] }]
      : []),
    ...(named ? [{ sentence: edit ? '由 {0} 修改' : '由 {0} 生成', names: [named] as [string] }] : []),
  ];
}

/** The route one image run took, read back from its records: who, through which tool or API, where it was kept. */
export type ImagePipeline = {
  executor: string;
  tool: ImageGenerationTool;
  /** API runs only: the exact image model and the endpoint the request went to. */
  imageModel: string | null;
  endpoint?: string;
  edit: boolean;
  /** The kept copies: the conversation attachments once saved, otherwise the run's own staged files. */
  paths: string[];
};

type PipelineRun = {
  events: readonly { type: string; data?: Record<string, unknown> }[];
  generatedImages?: readonly GeneratedImage[];
};

/** Undefined for a run that made no image. Built only from what the run recorded; nothing is assumed. */
export function imagePipeline(run: PipelineRun): ImagePipeline | undefined {
  const rows = (kind: string) =>
    run.events
      .filter((event) => event.type === 'status' && event.data?.kind === kind)
      .flatMap((event) => [event.data!.detail].flat())
      .filter((detail): detail is Record<string, unknown> => !!detail && typeof detail === 'object');
  const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  const request = rows('image-request')[0];
  const made = rows('image-generation');
  const saved = rows('image-attachments');
  const first = saved[0] ?? made[0] ?? run.generatedImages?.[0];
  if (!first) return;
  // Codex reports its own tool name (image_generation); older API records said openai-images.
  const tool = first.tool === 'native-tool' || first.tool === 'image_generation' ? 'native-tool' : 'api-images';
  // Once saved, the staged files are deleted: an older saved record without paths links nothing rather than them.
  const paths = (saved.length ? saved : made.length ? made : (run.generatedImages ?? []))
    .map((item) => text(item.path))
    .filter((path): path is string => !!path);
  return {
    executor: text(first.executor) ?? '',
    tool,
    imageModel: tool === 'api-images' ? (text(request?.model) ?? text(first.imageModel) ?? null) : null,
    ...(text(request?.endpoint) ? { endpoint: text(request!.endpoint) } : {}),
    edit: request?.edit === true || saved.some((item) => item.edit === true),
    paths,
  };
}
