import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Replies up to this long reach the caller whole; longer ones as their conclusion plus where the full text is. */
export const summaryLimit = 1500;

const conclusionHeading =
  /^[ \t]*(?:#{1,4}[ \t]*)?(?:\*\*)?(?:结论|总结|要点|Conclusions?|Summary)(?:\*\*)?[ \t]*(?:[:：]|$)/gim;
const artifactLine =
  /(?:详细结果|完整结果|结果文件|全文|Full (?:result|report)|Details)[ \t]*[:：][ \t]*`?([^\s`]+)`?/gi;

/**
 * The part of a member's reply its caller reads by default. Members are asked to end with a "结论：" block; failing
 * that, the end of the reply, where executors put their summary. A file the member names as its full result is
 * picked up too.
 */
export function memberSummary(text: string): { summary: string; whole: boolean; artifact?: string } {
  const artifact = [...text.matchAll(artifactLine)]
    .map((match) => match[1]!.replace(/[。，,.;；)）]+$/, ''))
    .filter((path) => path.length <= 512 && /[\\/]|\.\w{1,8}$/.test(path))
    .at(-1);
  if (text.length <= summaryLimit) return { summary: text, whole: true, ...(artifact ? { artifact } : {}) };
  const heading = [...text.matchAll(conclusionHeading)].at(-1);
  let summary: string;
  if (heading?.index !== undefined && text.slice(heading.index + heading[0].length).trim()) {
    summary = text.slice(heading.index).trim();
    if (summary.length > summaryLimit) summary = `${summary.slice(0, summaryLimit).trimEnd()}…`;
  } else {
    const tail = text.slice(-summaryLimit);
    const start = tail.indexOf('\n');
    summary = `…${(start >= 0 && start < summaryLimit / 2 ? tail.slice(start + 1) : tail).trim()}`;
  }
  return { summary, whole: false, ...(artifact ? { artifact } : {}) };
}

/**
 * Keeps a member's full reply as a Markdown file in PugPort's data folder, so the caller (or the next member) can
 * read it with read_document without carrying it in its context. Best effort: no file means no path is offered.
 */
export function saveMemberResult(dataDir: string | undefined, folder: string, taskId: string, text: string) {
  if (!dataDir || !/^[\w-]{1,80}$/.test(folder) || !/^[\w-]{1,80}$/.test(taskId)) return undefined;
  try {
    const directory = join(dataDir, 'member-results', folder);
    const path = join(directory, `${taskId}.md`);
    const bytes = Buffer.byteLength(text);
    if (statSync(path, { throwIfNoEntry: false })?.size !== bytes || readFileSync(path, 'utf8') !== text) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(path, text);
    }
    return path;
  } catch {
    return undefined;
  }
}

/**
 * What a caller that has tools hears of a web agent's reply: that it exists, never what it says (no text, and no
 * file it could open). The user reads the reply itself in the conversation; swarms also have a tool-less final step.
 */
export function thirdPartyResult(name: string, length: number, mode: 'swarm' | 'lane' = 'swarm'): string {
  if (mode === 'lane')
    return `工作线「${name}」已回复（约 ${length} 字）。回复来自第三方网站，不交给能用工具的执行器；用户可在工作线对话中阅读。不要转述或猜测回复内容。`;
  return `${name} 已经回复（约 ${length} 字）。它的回复来自第三方网站，按规则不交给能用工具的执行器；用户在对话里能直接看到这条回复，大家都交回后由一个不带工具的执行器把它和其他结果合成最终答复。你的答复里写明这一部分由 ${name} 完成，不要转述或猜测它说了什么；要用到它内容的活留到最后这一步。`;
}

/** A finished member's reply as its caller gets it: whole when short or asked for, otherwise summary and file. */
export function memberResultText(
  text: string,
  full: boolean,
  save: () => string | undefined,
  reader: 'get_result' | 'read_document' = 'get_result',
): string {
  if (full) return text;
  const digest = memberSummary(text);
  if (digest.whole) return text;
  const path = save();
  if (!path && reader === 'read_document') return text.slice(0, 10000);
  return [
    digest.summary,
    digest.artifact && !digest.summary.includes(digest.artifact) ? `详细结果：${digest.artifact}` : '',
    `（只列了结论。全文 ${text.length.toLocaleString('en-US')} 字${path ? `，已存到 ${path}，可以用 read_document 读这个文件` : ''}${reader === 'get_result' ? '；需要全文时 get_result 加 full=true' : ''}。）`,
  ]
    .filter(Boolean)
    .join('\n\n');
}
