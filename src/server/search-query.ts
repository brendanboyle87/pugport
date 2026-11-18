import type { ConversationMessage } from '../shared/types.ts';
import type { MessageQuote } from '../shared/quotes.ts';

const reference =
  /这(?:个|些|种|一|项)(?:学位|项目|课程|专业|产品|计划|学校|东西)?|那(?:个|些|种)(?:学位|项目|课程|专业|产品|计划|学校)?|它(?:们)?|该(?:学位|项目|课程|专业|产品|计划|学校|大学|学院)|你说的(?:大学|学校|学院)|上述|前述|刚才(?:说的|提到的)|\b(?:this|that)\s+(?:degree|program|project|course|product|school)\b|\bit\b/iu;
const topicSwitch =
  /换个(?:话题|主题)|换一(?:个)?(?:话题|主题)|另一个(?:话题|主题)|不谈(?:这个|之前|上面)|\b(?:new topic|switch(?:ing)? topics?|unrelated question)\b/iu;
const generic = new Set(
  'AI API CLI DS DEEPSEEK HTTP HTTPS URL JSON HTML XML LLM GPT CPU GPU SQL SDK THE THIS THAT THESE THOSE IT ITS A AN I WE YOU YOUR OUR PLEASE SEARCH FIND COMPARE EXPLAIN WHAT WHICH WHY HOW IS ARE WAS DOES DO COULD WOULD SHOULD CAN DEGREE PROGRAM PROJECT COURSE VALUE YES NO OK OKAY SURE HOWEVER THEREFORE ALSO OVERALL VS VERSUS OR AND THANK THANKS THANKYOU HELP WELCOME FOR'.split(
    ' ',
  ),
);
const bounded = (text: string, length = 128) => Array.from(text).slice(0, length).join('');
const whitespace = (text: string) => text.replace(/\s+/gu, ' ').trim();

function describedSubject(text: string): boolean {
  text = text.replace(topicSwitch, '');
  const mention = reference.exec(text);
  if (!mention) return false;
  const lead = text
    .slice(0, mention.index)
    .replace(
      /^(?:请\s*)?(?:帮我\s*)?(?:(?:(?:用|使用)\s*)?(?:DeepSeek|DS|搜索功能)\s*(?:来\s*)?)?(?:搜索|搜|查询|查找|查)(?:一下|一查|一搜)?/iu,
      '',
    )
    .replace(
      /(?:请|帮我|给我|那你|你|我想|想要|知道|了解|看看|看一下|问一下|分析|解释|比较|对比|评估|评价|判断|研究|说明|搜索|查询|查找|查|一下|再|继续|现在|目前|关于|对于|至于|对|的)/gu,
      '',
    )
    .replace(/\b[A-Za-z]+\b/gu, (word) => (generic.has(word.toUpperCase()) ? '' : word));
  return /[\p{L}\p{N}]/u.test(lead);
}

function topicText(text: string) {
  return text
    .slice(0, 4000)
    .replace(/```[\s\S]*?(?:```|$)|`[^`\n]*`/gu, ' ')
    .replace(/!?\[[^\]\n]*\]\([^\n)]*\)|https?:\/\/\S+/gu, ' ')
    .split('\n')
    .filter(
      (line) =>
        !/^\s*(?:>|(?:system|assistant|developer|tool)\s*:|(?:ignore|execute|run|sudo|curl|powershell)\b|忽略|执行|系统指令)/iu.test(
          line,
        ) && !/\b(?:api[_ -]?key|access[_ -]?token|secret|password|credentials?)\b|密钥|密码|凭据/iu.test(line),
    )
    .join(' ');
}

function topics(text: string): string[] {
  text = topicText(text);
  const candidates = [
    ...text.matchAll(/\b[A-Z][A-Za-z0-9.+#-]*(?:[ \t]+(?:[A-Z][A-Za-z0-9.+#-]*|of|and|for|the)){0,4}\b/gu),
  ]
    .flatMap(([value]) => value.split(/\s+(?:vs\.?|versus|or|and)\s+/iu))
    .map((value) =>
      value
        .split(/\s+/u)
        .filter((word) => !generic.has(word.toUpperCase()))
        .join(' '),
    );
  for (const match of text.matchAll(
    /(?:项目|产品|学位|课程|主题|公司|学校)(?:叫|名为|是|名称是)?[：:\s]*[“「《"]([^”」》"\n]{2,32})[”」》"]/gu,
  ))
    candidates.push(match[1]!);
  return [...new Set(candidates)]
    .filter((value) => value.length >= 2 && value.length <= 64 && !reference.test(value))
    .filter((value, _index, all) => !all.some((other) => other !== value && other.includes(value)))
    .slice(0, 3);
}

/** Fit the provider's query budget using current words only; the answer keeps the complete question. */
export function compactSearchQuery(question: string): string {
  const plain = whitespace(question);
  if (Array.from(plain).length <= 128) return plain;
  const names = topics(plain);
  const anchors = bounded(names.join(' '), 48);
  const core = whitespace(
    names
      .reduce((text, name) => text.split(name).join(' '), plain)
      .replace(
        /^(?:请\s*)?(?:帮我\s*)?(?:(?:用|使用)\s*)?(?:DeepSeek|DS|搜索功能)\s*(?:来\s*)?(?:搜索|搜|查询|查找|查)(?:一下|一查|一搜)?/iu,
        '',
      )
      .replace(/^(?:please\s+)?(?:search(?:\s+for)?|find)\s+/iu, ''),
  );
  const available = 128 - (anchors ? Array.from(anchors).length + 1 : 0);
  const characters = Array.from(core);
  if (characters.length <= available) return whitespace(`${anchors} ${core}`);
  // shortcut: literal anchors plus the topic opening and question ending; upgrade only with measured query-quality evidence.
  const head = Math.ceil((available - 1) * 0.55);
  const tail = available - 1 - head;
  return [anchors, characters.slice(0, head).join('').trim(), characters.slice(-tail).join('').trim()]
    .filter(Boolean)
    .join(' ');
}

/** Best-effort context enrichment never rejects the original query when its subject is unclear. */
export function resolveSearchQuery(
  question: string,
  recent: readonly ConversationMessage[],
  quotes: readonly MessageQuote[] = [],
): { searchQuery: string } {
  const plain = whitespace(question);
  const original = { searchQuery: compactSearchQuery(plain) };
  const currentSchool = /\p{Script=Han}{2,18}(?:大学|学院|学校)/u.test(
    plain.replace(/(?:这(?:个|所)?|那(?:个|所)?|该|你说的|上述|前述)(?:大学|学校|学院)/gu, ''),
  );
  if ((!quotes.length && (!reference.test(plain) || describedSubject(plain))) || topics(plain).length || currentSchool)
    return original;
  if (!quotes.length && topicSwitch.test(plain)) return original;
  let context: Pick<ConversationMessage, 'content'> | undefined;
  let names: string[] = [];
  let assistantFallback: { message: ConversationMessage; names: string[] } | undefined;
  // The user's current selection outranks old chat subjects, but only literal names leave the quoted evidence.
  const quotedSubjects = quotes.map((quote) => {
    const text = quote.text.replace(/!?\[([^\]\n]+)\]\([^\n)]*\)/gu, '$1').replace(/`([^`\n]+)`/gu, '$1');
    const names = topics(text);
    const identifier = whitespace(topicText(text));
    const school =
      /^\p{Script=Han}{2,18}(?:大学|学院|学校)$/u.test(identifier) &&
      !/[我你他她]|朋友|老板|儿子|女儿|孩子|妹妹|哥哥|姐姐|弟弟|申请|录取|毕业|就读/u.test(identifier);
    if (!names.length && school) return [identifier];
    return names.length || !/^[a-z][a-z0-9._-]{1,63}$/u.test(identifier) || generic.has(identifier.toUpperCase())
      ? names
      : [identifier];
  });
  if (quotes.length) {
    names = [...new Set(quotedSubjects.flat())].filter(
      (name, _index, all) => !all.some((other) => other !== name && other.includes(name)),
    );
    if (!names.length) return original;
    context = { content: quotes.map((quote) => quote.text).join('\n') };
    if (
      names.length > 1 &&
      reference.test(plain) &&
      !/它们|这些|那些|\b(?:they|them|these|those)\b/iu.test(plain) &&
      quotedSubjects.filter((items) => items.length).length > 1
    )
      return original;
  }
  for (const message of quotes.length ? [] : [...recent].reverse()) {
    if (
      (message.role !== 'user' && message.role !== 'assistant') ||
      message.untrustedContent ||
      message.systemNotice ||
      message.replyIdentity?.kind === 'system' ||
      (message.role === 'assistant' && message.webSearch)
    )
      continue;
    if (topicSwitch.test(topicText(message.content))) break;
    names = topics(message.content).filter(
      (name) => message.role === 'user' || /[A-Z]{2,}|[a-z][A-Z]|\p{Script=Han}| /u.test(name),
    );
    if (names.length && message.role === 'user') {
      context = message;
      break;
    }
    if (names.length && !assistantFallback) assistantFallback = { message, names };
  }
  if (!context && assistantFallback) {
    context = assistantFallback.message;
    names = assistantFallback.names;
  }
  if (!context) return original;
  if (
    names.length > 1 &&
    (!quotes.length || (reference.test(plain) && !/它们|这些|那些|\b(?:they|them|these|those)\b/iu.test(plain))) &&
    /\b(?:vs\.?|versus)\b|对比|二者|选哪(?:个|种)|[A-Za-z0-9]\s*还是\s*[A-Z]|[A-Z][A-Za-z0-9-]+\s+or\s+[A-Z]/iu.test(
      topicText(context.content),
    )
  )
    return original;
  const subject = bounded(names.join(' '), 64);
  const keywords = whitespace(
    plain
      .replace(
        /^(?:请\s*)?(?:帮我\s*)?(?:(?:用|使用)\s*)?(?:DeepSeek|DS|搜索功能)\s*(?:来\s*)?(?:搜索|搜|查询|查找|查)(?:一下|一查|一搜)?/iu,
        '',
      )
      .replace(/(?:这|那|该)(?:个|些|种)?(学位|项目|课程|专业|产品|计划|学校)/gu, '$1')
      .replace(
        /它们?|上述|前述|刚才(?:说的|提到的)|那你看看|你看看|看一下|现在|目前|的情况下|情况下|还有没有什么|还有没有|有没有什么|有什么|是否还有/gu,
        ' ',
      )
      .replace(/[，。！？、,:;!?]/gu, ' '),
  );
  const budget = 127 - Array.from(subject).length;
  const tail = Array.from(keywords).slice(-budget).join('');
  return { searchQuery: whitespace(`${subject} ${tail}`) };
}
