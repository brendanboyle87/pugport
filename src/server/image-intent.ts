import type { LayaChoices, LayaInference } from '../shared/laya.ts';
import { layaInputCompacted } from './laya-policy.ts';

export type ImageIntent = {
  kind: 'create' | 'edit';
  /**
   * laya: Laya's media_output judgment. rules: Laya was unavailable, the narrow grammar below decided. pin: the owner
   * picked an image or video model in the model picker.
   */
  source: 'laya' | 'rules' | 'pin';
  reason: string;
  /** pin: the exact platform model id (without the runtime provider prefix) to run. */
  model?: string;
  /** pin: the picked model is listed but PugPort cannot run it on this card yet. */
  unsupported?: 'image' | 'video';
};

type IntentInput = {
  message: string;
  inference?: Pick<LayaInference, 'status' | 'reason' | 'choices' | 'raw'>;
  /** The conversation has an image PugPort generated earlier: the reference for an edit follow-up. */
  lastImage: boolean;
  /** That image is on the newest reply, so a short follow-up without a noun ("make it brighter") refers to it. */
  lastImageIsLatestReply?: boolean;
  /** The current message attaches an image the owner wants changed. */
  attachedImage?: boolean;
};

// Questions about an existing picture ask to see it (vision), never to draw one.
const visionQuestion =
  /(?:这|那|此|该)(?:张|幅|个)?(?:图|图片|照片|截图|图像)(?:里|中|上)?(?:面)?(?:是|有|写|画)(?:的是)?(?:什么|啥|谁|哪)|(?:图|图片|照片|截图)(?:里|中|上)(?:面)?(?:是|有)(?:什么|啥|谁)|(?:描述|识别|解读|分析|看看|看一下|读一下|翻译)(?:一下)?(?:这|那|此|该)?(?:张|幅|个)?(?:图|图片|照片|截图|图像)|\bwhat(?:'s|\s+is|\s+does)?\s+(?:in|on|shown\s+in)?\s*(?:this|that|the)\s+(?:image|picture|photo|screenshot)\b|\b(?:describe|explain|analy[sz]e|read|transcribe|caption|identify)\s+(?:what(?:'s|\s+is)\s+in\s+)?(?:this|that|the|my|these)\s+(?:attached\s+)?(?:images?|pictures?|photos?|screenshots?)\b|\bwhat\s+(?:does|do)\s+(?:this|that|the|these)\s+(?:image|picture|photo|screenshot)s?\s+(?:show|say|mean)\b/iu;
// Advice about drawing or making images ("how do I draw…", "怎么画…") wants an answer, not a picture.
const howTo =
  /(?:怎么|如何|怎样|教我|教程|技巧|步骤)(?:才能)?(?:画|绘制|生成|做)|\bhow\s+(?:do|can|should|would|to)\b.{0,30}\b(?:draw|paint|sketch|generate|make|create|design)\b|\b(?:tips|tutorial|steps)\s+(?:for|on|to)\s+(?:drawing|painting|sketching)\b/iu;
// Code that renders a picture (an SVG icon, a React component, a chart in Python) is a coding task.
const codeArtifact =
  /\b(?:svg|css|html|react|component|canvas|matplotlib|plotly|d3|code|script|function|class|chart\.js)\b|代码|组件|脚本|图表|流程图|架构图|示意图/iu;
const zhNoun =
  '(?:图|图片|图像|插画|插图|海报|头像|图标|logo|壁纸|封面|照片|表情包|贴纸|漫画|素描|水彩|油画|banner|横幅|商标)';
const createZh = new RegExp(
  [
    // 画一张猫 / 帮我画只狐狸 / 请绘制… : 画 needs no noun, but must start the request.
    '^(?:请|麻烦|帮我|给我|替我|你)?(?:帮我|给我|替我)?(?:画|绘制|手绘)(?!家|面|质|风|廊|展|册|室|画)',
    '(?:画|绘制)(?:一|两|三|几)(?:张|幅|个|只|副)',
    // 把这张照片画成水彩画 : redraw a picture in another style.
    '(?:画成|绘成|转绘成?|做成)(?:一[张幅个])?.{0,12}?(?:风格|水彩|油画|素描|漫画|卡通|像素|插画|图|画)',
    // 生成/做/设计/来 一张…海报 : other verbs need an image noun within a short span.
    `(?:生成|做|制作|设计|创作|来|出|弄|搞)(?:一下)?(?:一|两|三|几)?(?:张|幅|个|副|套)?.{0,24}?${zhNoun}`,
  ].join('|'),
  'iu',
);
const enNoun =
  '(?:images?|pictures?|illustrations?|posters?|icons?|logos?|wallpapers?|avatars?|banners?|thumbnails?|artworks?|drawings?|paintings?|stickers?|portraits?|photos?|renders?|covers?|emojis?|mascots?)';
const createEn = new RegExp(
  [
    '^(?:please\\s+|can\\s+you\\s+|could\\s+you\\s+)?(?:draw|paint|sketch|illustrate)\\b',
    `\\b(?:generate|create|make|design|render|produce|draw|paint)\\s+(?:me\\s+|us\\s+)?(?:an?\\s+|some\\s+|the\\s+|\\d+\\s+|a\\s+few\\s+)?(?:[\\w-]+\\s+){0,4}?${enNoun}\\b`,
  ].join('|'),
  'iu',
);
// A short follow-up that changes the last picture: 亮一点 / 背景换成蓝色 / make it brighter / add a hat.
const editZh =
  /^(?:请|麻烦|那|再)?(?:再|更|稍微|稍稍)?\p{Script=Han}{1,5}(?:一点|一些|些|点)儿?[吧呢。！!～~\s]*$|(?:换成|改成|变成|调成|改为|换为|加上|加个|加一[个只顶朵条]|去掉|删掉|移除|变得|调得|弄得)/u;
const editEn =
  /^(?:please\s+|now\s+|ok(?:ay)?,?\s+|and\s+|can\s+you\s+)?(?:make|turn|change)\b.{0,48}\b(?:it|this|that|the\s+\w+|brighter|darker|lighter|bigger|smaller|warmer|cooler|more|less|background|colou?rs?|style)\b|^(?:please\s+|now\s+|and\s+|can\s+you\s+)?(?:add|remove|replace|swap|put|give\s+it)\s+(?:an?\s+|the\s+|some\s+|more\s+)?\w+|^(?:brighter|darker|lighter|warmer|cooler|bigger|smaller|more\s+\w+|less\s+\w+)\b/iu;

const usable = (inference: IntentInput['inference']): LayaChoices | undefined =>
  inference?.status === 'ok' && inference.choices && !layaInputCompacted(inference as LayaInference)
    ? inference.choices
    : undefined;

/**
 * Laya's media_output decides. Only when Laya gave no judgment does a deliberately narrow grammar recognise an
 * explicit request; anything ambiguous stays with ordinary routing. Questions about a picture never draw one.
 */
export function imageIntent(input: IntentInput): ImageIntent | undefined {
  const judged = judgeImageIntent(input);
  return judged && keepsLastImage(input, judged) ? { ...judged, kind: 'edit', reason: keptReason } : judged;
}

const keptReason = 'A follow-up right after a generated image keeps that image as the reference.';
// Only these words ask to start over without the picture on screen.
const freshStart =
  /(?:新的?(?:一张)?(?:图|图片|照片)|另一张|另外一张|重新画|重画|重新生成|换一张|不要(?:参考|用)?(?:上一张|之前|原来)的?)|\b(?:a\s+(?:new|different)|another)\s+(?:image|picture|photo|drawing|one)\b|\bfrom\s+scratch\b|\bstart\s+over\b/iu;
// A request that opens a new drawing: 画一只猫 / 生成一张海报 / draw a fox. "做成透明背景的图" still edits.
const newDrawing =
  /^(?:请|麻烦|帮我|给我|替我|你)?(?:帮我|给我|替我)?(?:画|绘制|手绘)(?!成)|(?:画|绘制|生成|制作|设计|来)(?:一|两|三|几)(?:张|幅|个|只|副|套)|^(?:please\s+|can\s+you\s+|could\s+you\s+)?(?:draw|paint|sketch|illustrate)\b|\b(?:generate|create|make|design)\s+(?:me\s+)?(?:an?|\d+)\s+(?:[\w-]+\s+){0,3}?(?:images?|pictures?|illustrations?|posters?|logos?|icons?|drawings?|paintings?)\b/iu;

/**
 * Right after a generated image, a picture request without its own image is about that picture ("extract the
 * person", "other colours"), unless it plainly asks for a fresh one or starts a new drawing ("画一张猫").
 */
export function keepsLastImage(input: IntentInput, judged: Pick<ImageIntent, 'kind'>): boolean {
  const text = input.message.trim();
  return (
    judged.kind === 'create' &&
    !!input.lastImage &&
    !!input.lastImageIsLatestReply &&
    !input.attachedImage &&
    !freshStart.test(text) &&
    !newDrawing.test(text)
  );
}

function judgeImageIntent(input: IntentInput): ImageIntent | undefined {
  const text = input.message.trim();
  if (!text || text.length > 4000) return;
  if (visionQuestion.test(text)) return;
  const reference = input.lastImage || !!input.attachedImage;
  const choices = usable(input.inference);
  if (choices) {
    if (choices.media_output === 'image_create')
      return { kind: 'create', source: 'laya', reason: 'Laya judged the request asks for a new image.' };
    if (choices.media_output === 'image_edit')
      return reference
        ? { kind: 'edit', source: 'laya', reason: 'Laya judged the request edits an existing image.' }
        : {
            kind: 'create',
            source: 'laya',
            reason: 'Laya judged the request edits an image, but there is none to edit; drawing a new one.',
          };
    return;
  }
  if (howTo.test(text) || codeArtifact.test(text)) return;
  if (createZh.test(text) || createEn.test(text)) {
    const changesAttached = input.attachedImage && /这张|这幅|照着|参考|\b(?:this|the\s+attached|my)\b/iu.test(text);
    return changesAttached
      ? { kind: 'edit', source: 'rules', reason: 'Explicit request to redraw the attached image.' }
      : { kind: 'create', source: 'rules', reason: 'Explicit request for a new image; Laya gave no judgment.' };
  }
  const followUp = input.lastImage && input.lastImageIsLatestReply && text.length <= 120;
  if (followUp && (editZh.test(text) || editEn.test(text)))
    return { kind: 'edit', source: 'rules', reason: 'Short change request right after a generated image.' };
  return;
}
