import { writingRequest } from '../shared/fiction.ts';
import type { RoutingCategory, RunInput } from '../shared/types.ts';
import { matureContent } from './routing.ts';
import { requestsFileChanges } from './task-file-outcome.ts';

function keywordMatches(text: string, value: string): boolean {
  const word = value.trim();
  if (!word) return false;
  const literal = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Latin identifiers need word boundaries: "review" must not match "preview".
  const left = /^[a-zA-Z0-9_]/.test(word) ? '(?<![a-zA-Z0-9_])' : '';
  const right = /[a-zA-Z0-9_]$/.test(word) ? '(?![a-zA-Z0-9_])' : '';
  return new RegExp(`${left}${literal}${right}`, 'i').test(text);
}

/** Local domain classification never grants permissions or changes captured legacy complexity. */
export function taskCategory(
  input: Pick<RunInput, 'prompt' | 'routingPrompt' | 'attachments' | 'taskJudgment' | 'fiction' | 'permissionMode'> & {
    projectPath?: string;
    mode?: 'chat' | 'build';
    categories?: RoutingCategory[];
    parentCategory?: RunInput['category'];
  },
): NonNullable<RunInput['category']> {
  const text = input.routingPrompt ?? input.prompt;
  const visualText = text.replace(/\b(?:docker|container|disk|vm|machine|base|build)\s+images?\b/gi, '');
  const result = (id: string, reason: string, confidence: 'high' | 'low' = 'high') => ({ id, confidence, reason });
  // A word like 「截图」 is not an image: without an attachment, vision needs an image file named in the text.
  if (
    input.attachments?.some((file) => file.kind === 'image') ||
    (/识图|看图|图片|图像|截图|\b(?:image|screenshot|vision)\b/i.test(visualText) &&
      /\.(?:png|jpe?g|gif|webp|bmp|heic)\b/i.test(text))
  )
    return result('vision', '图片附件或图片关键词');
  if (input.parentCategory?.id === 'adult' || input.taskJudgment?.content === 'adult' || matureContent(text))
    return result(
      'adult',
      input.taskJudgment?.content === 'adult' ? '历史成人内容信号' : '成人内容信号',
      input.taskJudgment?.status === 'fallback' && !matureContent(text) ? 'low' : 'high',
    );
  for (const category of input.categories ?? [])
    if (category.keywords?.some((word) => keywordMatches(text, word))) return result(category.id, '自定义分类关键词');
  const code =
    /代码|函数|报错|重构|\b(?:code|coding|function|refactor|implement|debug|TypeError|SyntaxError|stack trace|docker|container)\b|\.(?:tsx?|jsx?|py|rs|go)\b/i;
  // A write task on code or i18n files that mentions 英文/翻译/文案 (new UI strings) is still code.
  const writeCode =
    input.permissionMode === 'workspace-write' &&
    (input.mode !== 'chat' || text.split(/\b(?:and|then)\b|并(?:且)?/iu).some((part) => requestsFileChanges(part))) &&
    !input.fiction &&
    (code.test(text) || /\.json\b|\bi18n\b/i.test(text));
  if (/翻译|译成|译为|\btranslat(?:e|ion)\b/i.test(text) || (writeCode && /英文/.test(text)))
    return writeCode ? result('code', '代码关键词') : result('translation', '翻译关键词');
  if (input.fiction || writingRequest(text) || /文案|写作|散文|诗歌|博客|\b(?:writing|prose|fiction)\b/i.test(text))
    return result('writing', '写作请求');
  if (input.taskJudgment?.status === 'accepted' && ['architecture', 'design'].includes(input.taskJudgment.kind ?? ''))
    return result('code', '历史架构或设计分类');
  if (code.test(text)) return result('code', '代码关键词');
  if (input.mode === 'build' && input.projectPath) return result('code', '项目构建模式', 'low');
  if (/调研|研究|查资料|检索|\b(?:research|investigate|literature)\b/i.test(text))
    return result('research', '研究关键词');
  if (/实现|修复|编程/.test(text)) return result('code', '代码关键词', 'low');
  return result('other', '没有明确分类信号', 'low');
}
