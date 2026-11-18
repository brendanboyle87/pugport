import { open, opendir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative } from 'node:path';

/*
 * A style check for fiction, by fixed rules rather than a model: it costs no quota, reads every chapter at once,
 * and so finds what a reviewer reading ten lines cannot — a sentence pattern that runs through the whole book.
 * Dialogue is left out of the narration rules: people may speak in fragments.
 */

export type StyleRule = 'selfAnswer' | 'contrast' | 'fragment' | 'staccato' | 'echo' | 'stock';

/** What each rule finds, in the words the report uses. */
export const styleRuleLabels: Record<StyleRule, string> = {
  selfAnswer: '先否定再自己作答（「白不是雪。是……」）',
  contrast: '「不是……而是……」「与其说……不如说……」式对比',
  fragment: '一两个字单独成句（「冷。」「走了。」）',
  staccato: '一连四句以上的短句',
  echo: '下一句拿上一句的尾巴开头',
  stock: '套话词（微微、缓缓、仿佛、一丝……）',
};
/** Per thousand characters, the density above which a chapter is called out. */
const thresholds: Record<StyleRule, number> = {
  selfAnswer: 0.3,
  contrast: 0.3,
  fragment: 1.5,
  staccato: 0.6,
  echo: 0.8,
  stock: 2,
};
const stockWords = [
  '微微',
  '缓缓',
  '轻轻地',
  '仿佛',
  '似乎',
  '一丝',
  '不禁',
  '不由得',
  '深吸一口气',
  '嘴角勾起',
  '眸子',
  '眼底',
  '心底',
  '莫名',
  '某种',
  '说不清',
];

export type ChapterStyle = {
  file: string;
  title: string;
  chars: number;
  counts: Record<StyleRule, number>;
  examples: Partial<Record<StyleRule, string[]>>;
};
export type StyleReport = {
  root: string;
  chapters: ChapterStyle[];
  /** Short narration sentences that recur across chapters, with the chapters they appear in. */
  repeats: { sentence: string; chapters: string[] }[];
  text: string;
};

export const styleCheckLimits = {
  chapters: 400,
  chapterBytes: 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
  depth: 5,
} as const;
const limitError = (detail: string) =>
  new Error(`文风体检未完成：${detail}。请分批检查或选择更具体的正文目录；未生成不完整的全书报告。`);

const chapterFile = /第\s*[\d一二三四五六七八九十百零]+\s*[章回节]/;
// Old versions and other people's books are not the user's chapters, even when their file names say 第N章.
const skipped = /(归档|archive|备份|backup|旧稿|废稿|_占位|参考|资料|范本|reference|node_modules|\.git)/i;
const textFile = (name: string) => ['.txt', '.md'].includes(extname(name).toLowerCase());
const cjk = (text: string) => text.replace(/[^一-鿿]/g, '');

/**
 * Narration only, so short spoken lines are not counted: dialogue in 「」, “” or "" is cut out, and so is speech
 * written after a colon without quotes, up to the end of that one sentence. The speech tag stays joined to the
 * narration that follows ("她笑：今天不错。随后她起身。" reads as "她笑，随后她起身。"), so it is never a fragment.
 */
function narration(text: string): string {
  return text
    .replace(/「[^」]*」|“[^”]*”|"[^"\n]*"/g, '\n')
    .replace(/([说问道答喊叫骂笑])[：:][^。！？\n]*[。！？]?/g, '$1，');
}
/** A first line that names the chapter rather than starting it. */
const titleLine = (line: string) =>
  /^第\s*[\d一二三四五六七八九十百零]+\s*[章回节]/.test(line) || (line.length <= 30 && !/[。！？]/.test(line));
function sentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[。！？!?…])/)
    .map((sentence) => sentence.replace(/^[\s　]+|[\s　]+$/g, ''))
    .filter((sentence) => cjk(sentence).length > 0);
}
const clip = (text: string, size = 60) => (text.length > size ? `${text.slice(0, size)}…` : text);
/** The words around a match, from the start of its sentence, for an example. */
function around(text: string, index: number, length: number): string {
  const start = Math.max(text.lastIndexOf('。', index - 1), text.lastIndexOf('\n', index - 1), index - 20) + 1;
  return clip(text.slice(start, index + length + 16).trim());
}

export function checkChapter(file: string, raw: string): ChapterStyle {
  const lines = raw.split(/\r?\n/);
  // A file may start with its first paragraph rather than a title; then the file name is the title.
  const first = lines.findIndex((line) => line.trim());
  const named = first >= 0 && titleLine(lines[first]!.trim());
  const title = named ? lines[first]!.trim().slice(0, 40) : basename(file, extname(file));
  const body = (named ? lines.slice(first + 1) : lines).join('\n');
  const counts: Record<StyleRule, number> = { selfAnswer: 0, contrast: 0, fragment: 0, staccato: 0, echo: 0, stock: 0 };
  const examples: Partial<Record<StyleRule, string[]>> = {};
  const note = (rule: StyleRule, example: string | (() => string)) => {
    counts[rule]++;
    const list = (examples[rule] ??= []);
    if (list.length >= 3) return;
    const snippet = typeof example === 'function' ? example() : example;
    if (!list.includes(snippet)) list.push(snippet);
  };
  const told = narration(body);
  // Each pattern is matched on its own, without the words around it, so neighbouring hits are all counted.
  // "白不是雪。是霜": a denial the narrator answers at once. "不是……而是……" is the contrast rule's.
  for (const match of told.matchAll(/不是[^。！？\n，]{1,12}[。，；]\s*是/g))
    note('selfAnswer', () => around(told, match.index, match[0].length));
  for (const match of told.matchAll(/不是[^。！？\n]{1,20}而是|与其说[^。！？\n]{1,20}不如说/g))
    note('contrast', () => around(told, match.index, match[0].length));
  for (const paragraph of told.split(/\n+/)) {
    const list = sentences(paragraph);
    let run: string[] = [];
    const endRun = () => {
      if (run.length >= 4) note('staccato', clip(run.join('')));
      run = [];
    };
    list.forEach((sentence, index) => {
      const size = cjk(sentence).length;
      // A speech tag left after the dialogue was cut out ("她说。") is not a fragment.
      if (size <= 2 && /[。！？]$/.test(sentence) && !/[说道问]/.test(sentence)) note('fragment', sentence);
      if (size <= 8) run.push(sentence);
      else endRun();
      // The next sentence opens with the last two to four characters of this one ("抄下来。抄下来以后").
      const previous = cjk(list[index - 1] ?? '');
      const opening = cjk(sentence);
      const echoed = [4, 3, 2].some((size) => {
        const tail = previous.slice(-size);
        return (
          tail.length === size && size < previous.length && opening.startsWith(tail) && !/^[的了着是在]/.test(tail)
        );
      });
      if (echoed) note('echo', clip(`${list[index - 1]}${sentence}`));
    });
    endRun();
  }
  for (const word of stockWords)
    for (let at = told.indexOf(word); at >= 0; at = told.indexOf(word, at + word.length))
      note('stock', () => around(told, at, word.length));
  return { file, title, chars: cjk(body).length, counts, examples };
}

/** Narration sentences of a few characters that appear in several chapters: a writer's habit, not a choice. */
function repeatedSentences(chapters: { title: string; raw: string }[]) {
  const seen = new Map<string, Set<string>>();
  for (const chapter of chapters)
    for (const paragraph of narration(chapter.raw).split(/\n+/))
      for (const sentence of sentences(paragraph)) {
        const core = cjk(sentence);
        // A speech tag ("林照说") recurs by nature; it is not a habit worth reporting.
        if (core.length < 3 || core.length > 12 || /[说道问答]$/.test(core)) continue;
        const where = seen.get(core) ?? new Set<string>();
        where.add(chapter.title);
        seen.set(core, where);
      }
  return [...seen]
    .filter(([, where]) => where.size >= 3)
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 12)
    .map(([sentence, where]) => ({ sentence, chapters: [...where] }));
}

async function chapterFiles(root: string): Promise<string[]> {
  const info = await stat(root).catch(() => undefined);
  if (!info) throw new Error(`找不到：${root}`);
  if (info.isFile()) return [root];
  const found: string[] = [];
  const walk = async (folder: string, depth: number) => {
    if (depth > styleCheckLimits.depth) throw limitError(`子目录超过 ${styleCheckLimits.depth} 层`);
    for await (const entry of await opendir(folder)) {
      const path = join(folder, entry.name);
      if (skipped.test(entry.name)) continue;
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile() && textFile(entry.name) && chapterFile.test(entry.name)) {
        if (found.length >= styleCheckLimits.chapters) throw limitError(`章节数量超过 ${styleCheckLimits.chapters} 章`);
        found.push(path);
      }
    }
  };
  await walk(root, 0);
  return found.sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
}

const per = (count: number, chars: number) => (chars ? (count * 1000) / chars : 0);
const order: StyleRule[] = ['selfAnswer', 'contrast', 'fragment', 'staccato', 'echo', 'stock'];

/** Read at most the remaining budget plus one byte, including when a file grows after its size was checked. */
async function readChapter(file: string, remaining: number): Promise<{ raw: string; bytes: number }> {
  const handle = await open(file, 'r');
  const tooLarge = () => limitError(`单章超过 1 MiB（${basename(file)}）`);
  const tooMuch = () => limitError('章节总大小超过 32 MiB');
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`不是普通章节文件：${file}`);
    if (info.size > styleCheckLimits.chapterBytes) throw tooLarge();
    if (info.size > remaining) throw tooMuch();
    const budget = Math.min(styleCheckLimits.chapterBytes, remaining);
    const buffer = Buffer.allocUnsafe(budget + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const next = await handle.read(buffer, bytes, buffer.length - bytes, null);
      if (!next.bytesRead) return { raw: buffer.subarray(0, bytes).toString('utf8'), bytes };
      bytes += next.bytesRead;
    }
    throw budget === styleCheckLimits.chapterBytes ? tooLarge() : tooMuch();
  } finally {
    await handle.close();
  }
}

/** Checks every chapter file under a folder (or one file) and writes the findings in plain words. */
export async function checkStyle(root: string): Promise<StyleReport> {
  const files = await chapterFiles(root);
  if (!files.length) throw new Error('这里没有找到章节文件（文件名里要有“第N章”）。');
  const raws: { file: string; raw: string }[] = [];
  let bytes = 0;
  for (const file of files) {
    const chapter = await readChapter(file, styleCheckLimits.totalBytes - bytes);
    bytes += chapter.bytes;
    raws.push({ file, raw: chapter.raw });
  }
  const chapters = raws.map(({ file, raw }) => checkChapter(relative(root, file) || basename(file), raw));
  const repeats = repeatedSentences(raws.map(({ raw }, index) => ({ title: chapters[index]!.title, raw })));
  const chars = chapters.reduce((sum, chapter) => sum + chapter.chars, 0);
  const totals = Object.fromEntries(
    order.map((rule) => [rule, chapters.reduce((sum, chapter) => sum + chapter.counts[rule], 0)]),
  ) as Record<StyleRule, number>;
  // How far past the thresholds a chapter is, over every rule.
  const severity = (chapter: ChapterStyle) =>
    order.reduce((sum, rule) => sum + per(chapter.counts[rule], chapter.chars) / thresholds[rule], 0);
  const flagged = (chapter: ChapterStyle) =>
    order.filter((rule) => per(chapter.counts[rule], chapter.chars) >= thresholds[rule]);
  const lines: string[] = [
    `文风体检：${chapters.length} 章，约 ${(chars / 10000).toFixed(1)} 万字（${relative(dirname(root), root) || root}）。`,
    '下面是按固定规则数出来的命中次数，会有误报，也会漏掉，只用来提示先看哪里，不代表这些地方都要改，更不代表要整章重写。人物对白不算。',
    '',
  ];
  const ranked = order
    .filter((rule) => totals[rule])
    .sort((a, b) => per(totals[b], chars) / thresholds[b] - per(totals[a], chars) / thresholds[a])
    .slice(0, 3);
  if (!ranked.length) lines.push('没有命中这几类写法。');
  else {
    lines.push('命中最多的写法：');
    ranked.forEach((rule, index) => {
      const where = chapters.filter((chapter) => chapter.counts[rule]);
      const worst = [...where].sort((a, b) => b.counts[rule] - a.counts[rule])[0]!;
      lines.push(
        `${index + 1}. ${styleRuleLabels[rule]}：${where.length} 章里有，最集中的是「${worst.title}」。例：${
          worst.examples[rule]
            ?.slice(0, 2)
            .map((example) => `「${example}」`)
            .join('、') ?? ''
        }`,
      );
    });
  }
  if (repeats.length) {
    lines.push('', '在好几章里反复出现的同一句话（多半是写顺手的口头禅，值得看一眼）：');
    for (const repeat of repeats.slice(0, 5)) lines.push(`- 「${repeat.sentence}」出现在 ${repeat.chapters.length} 章`);
  }
  const worst = chapters
    .filter((chapter) => flagged(chapter).length)
    .sort((a, b) => severity(b) - severity(a))
    .slice(0, 5);
  if (worst.length)
    lines.push(
      '',
      `命中比较集中、建议先通读的章节：${worst.map((chapter) => `「${chapter.title}」`).join('、')}。读的时候看动作接不接得上、人物为什么这样做、对白像不像这个人，规则次数只作参考。`,
    );
  return { root, chapters, repeats, text: lines.join('\n') };
}

/**
 * Folders under a project that hold chapter files, with how many and when the newest was changed, so the user can
 * say which one is the book's current text (others are drafts, old versions or discarded copies).
 */
export async function manuscriptCandidates(root: string) {
  const folders = new Map<string, { chapters: number; changed: number }>();
  for (const file of await chapterFiles(root)) {
    const folder = dirname(file);
    const entry = folders.get(folder) ?? { chapters: 0, changed: 0 };
    entry.chapters++;
    entry.changed = Math.max(entry.changed, (await stat(file).catch(() => undefined))?.mtimeMs ?? 0);
    folders.set(folder, entry);
  }
  return [...folders]
    .map(([folder, entry]) => ({ folder, chapters: entry.chapters, changedAt: new Date(entry.changed).toISOString() }))
    .sort((a, b) => b.chapters - a.chapters || b.changedAt.localeCompare(a.changedAt));
}

/**
 * The book's current text, decided the same way for the panel button and for agents: the folder the user named,
 * else the only folder holding chapters. With several and none named it asks rather than guessing, since drafts
 * and old versions would otherwise be counted as the book.
 */
export async function resolveBook(projectPath: string, manuscript?: string): Promise<string> {
  if (manuscript) return manuscript;
  const candidates = await manuscriptCandidates(projectPath);
  if (!candidates.length) throw new Error('这个项目里没有找到章节文件（文件名里要有“第N章”）。');
  if (candidates.length > 1)
    throw new Error(
      `先在路由面板里选好这本书的正式正文文件夹：项目里有 ${candidates.length} 个放章节的文件夹（${candidates
        .slice(0, 5)
        .map((item) => `${item.folder}，${item.chapters} 章`)
        .join('；')}），不确定哪个是现在的版本。`,
    );
  return candidates[0]!.folder;
}
