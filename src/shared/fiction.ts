import type { Conversation, Project } from './types.ts';

/*
 * Novel writing gets its own tools and process (style check, taste tests, the long-form pipeline). Everything else,
 * code included, never sees them; this decides which is which. Three kinds of text are told apart: asking for
 * prose (which may start a taste test), anything else about a novel (reviewing, discussing), and software work
 * that happens to use a word from fiction ("登录场景的测试", "角色权限页面").
 */

const writeVerb =
  /(续写|改写|重写|扩写|润色|仿写|创作|改成|改得|改一下|修改|接着写|继续写|帮我写|写(?:一|个|段|篇|章|下|完|出|成|第|本|场|首|点))/;
const proseNoun =
  /(小说|故事|章|情节|剧情|人物|角色|对白|台词|文风|正文|描写|散文|诗|文案|剧本|番外|场景|段落|句子|开头|结尾)/;
/** Words only a novel uses; "场景" or "角色" alone could just as well be software. */
const novelWord =
  /(小说|章节|第\s*[\d一二三四五六七八九十百零]+\s*[章回节]|正文|情节|剧情|对白|台词|文风|番外|续写|人物卡|伏笔|书稿)/;
const softwareWord =
  /(测试|代码|程序|页面|按钮|接口|函数|组件|模块|报错|bug|数据库|脚本|权限|登录|部署|前端|后端|字段|表单|配置|api|sql)/i;
const reviewVerb = /(审阅|审核|审稿|检查|点评|评价|看看|讨论|分析|通读)/;

/** A clear instruction such as "续写第三章" survives software words in the following plot description. */
function explicitFictionClause(text: string, verb: RegExp): boolean {
  return text
    .split(/[，,。！？!?；;：:\n]/)
    .some((clause) => verb.test(clause) && novelWord.test(clause) && !softwareWord.test(clause));
}

/** Asking for prose to be written or rewritten, as opposed to reviewing it, discussing it, or code and chores. */
export function writingRequest(text: string): boolean {
  return (
    writeVerb.test(text) && proseNoun.test(text) && (!softwareWord.test(text) || explicitFictionClause(text, writeVerb))
  );
}

/** About a novel at all: writing it, reviewing it or talking about it, but not software work. */
export function novelRequest(text: string): boolean {
  return (
    writingRequest(text) ||
    (!softwareWord.test(text) && novelWord.test(text)) ||
    explicitFictionClause(text, reviewVerb)
  );
}

/**
 * Whether this is novel work: the conversation hands chapters to sub-agents, the project names the book's text
 * or has writing preferences, or the message itself is about a novel.
 */
export function fictionContext(
  conversation: Pick<Conversation, 'routing'> | undefined,
  project: Pick<Project, 'manuscript' | 'writingPreferences'> | undefined,
  text?: string,
): boolean {
  return (
    !!conversation?.routing?.chapterAgents ||
    !!project?.manuscript ||
    !!project?.writingPreferences?.length ||
    (text !== undefined && novelRequest(text))
  );
}
