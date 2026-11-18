import { nativeVisionProviders, providerSpec } from '../shared/provider-registry.ts';
import type { ExecutionPolicy, Provider, RuntimeTarget } from '../shared/types.ts';

export type HistoryImagePolicy = {
  provider?: Provider;
  runtimeId?: string;
  /** The selected or confirmed runtime's actual provider, not a preferred provider. */
  runtimeProvider?: Provider;
  /** Observed image support for the selected runtime (or every eligible account of a selected provider). */
  runtimeImageInput?: boolean;
  executionPolicy?: ExecutionPolicy;
  excludeProviders?: readonly Provider[];
  /** Only set for a selected runtime; this gateway does not accept image pixels. */
  gateway?: RuntimeTarget['gateway'];
  /**
   * Providers of eligible native vision candidates for an unpinned route.
   * An empty list means none exist. Omission preserves the existing automatic
   * routing behavior, where Codex/Claude remain candidates until discovery.
   */
  visionProviders?: readonly Provider[];
};

const nativeVision = (provider: Provider): boolean => !!providerSpec(provider)?.nativeVision;

/** A plan step whose own words are about the attached pictures, so it needs their pixels. */
export function stepNamesImages(text: string): boolean {
  return /图片|图像|照片|截图|相片|附图|配图|原图|效果图|设计图|设计稿|参考图|示意图|这张图|该图|图中|图里|图上|看图|识图|画面|屏幕上|\b(?:images?|pictures?|photos?|screenshots?|screen\s*shots?|mockups?|diagrams?|figures?)\b/iu.test(
    text,
  );
}

/** Explicit references retain original pixels so a text-only preference can use technical failover. */
export function requestsHistoryImage(intent: string, quotedImage: boolean): boolean {
  return (
    quotedImage ||
    /(?:这|那|上一|刚才|之前|前面|原来)(?:张|个|幅)?的?(?:图(?:片)?|照片|截图|相片)|(?:同一|相同|同样)(?:张|个|幅)?(?:图片|照片|截图)|(?:继续|再|重新).{0,8}(?:看|查|搜|找|读|分析|识别|对比).{0,8}(?:图片|照片|截图)/u.test(
      intent,
    ) ||
    /\b(?:this|that|same|previous|earlier|last|attached)\s+(?:image|picture|photo|screenshot)\b|\b(?:image|picture|photo|screenshot)\s+(?:above|before|again)\b/i.test(
      intent,
    )
  );
}

/**
 * Applies only to optional image context inherited from earlier messages.
 * Never use this result to discard attachments explicitly supplied this turn;
 * those attachments must still reach capability validation and routing errors.
 * Skipping inheritance does not remove the saved attachment or its history row.
 */
export function canInheritHistoryImage(policy: HistoryImagePolicy): boolean {
  if (policy.executionPolicy === 'api-only' || policy.gateway) return false;
  if (policy.runtimeId && !policy.runtimeProvider) return false;
  if (policy.provider && policy.runtimeProvider && policy.provider !== policy.runtimeProvider) return false;

  const selected = policy.runtimeProvider ?? policy.provider;
  const allowed = (provider: Provider) => !policy.excludeProviders?.includes(provider);
  if (selected) return allowed(selected) && (policy.runtimeImageInput ?? nativeVision(selected));

  // When supplied, this list has already been restricted to channels with verified image support.
  return (policy.visionProviders ?? nativeVisionProviders).some(allowed);
}

/** Disclose omitted pixels without claiming the executor opened the saved files. */
export function historyImageOmissionContext(names: readonly string[], paths: readonly string[] = []): string {
  const images = [...new Set(names)];
  if (!images.length) return '';
  const saved = [...new Set(paths)];
  return (
    `\n此前图片 ${images.map((name) => JSON.stringify(name)).join('、')} 的像素未提供给本次执行器，原件仍保留在对话历史附件中。不要假装看过其图片内容。` +
    (saved.length
      ? `原件路径：${saved.map((path) => JSON.stringify(path)).join('、')}；需要处理这些图片（例如用 find_similar_images 接着找图）时按路径使用。`
      : '')
  );
}
