/** A question about operating a named feature is not permission to invoke it. */
export const isInvocationDiscussion = (text: string) =>
  /^(?:是|是否|应该|可以吗|的|(?:需要|要)(?:先|额外|付费|收费|费用|配置|设置|登录|登陆|授权|安装|什么条件|哪些条件)|安全(?:吗|么|不|性)|(?:如何|怎么|怎样|怎麼)(?:使用|调用|配置|工作)|(?:有(?:什么|哪些))(?:功能|限制|风险|要求|用处)|什么意思|收费|is\b|does\b|requires?\b|costs?\b|needs?\b|safe\b)/iu.test(
    text,
  );

/** A direct search instruction in the user's own message; keep its context and restrictions intact. */
export function explicitSearchQuery(content: string): string | undefined {
  const text = content.trim();
  if (/^\/(?:搜索|search)(?:\s+|$)/i.test(text)) return /^\/(?:搜索|search)\s+\S/i.test(text) ? text : undefined;
  if (
    /(?:不要|不用|无需|不需要|不能|不可|不允许|不准|禁止|别|不)\s*(?:联网|上网|访问(?:网络|互联网)|搜索|搜|查|调用|使用|用)|\b(?:do not|don't|cannot|can't|must not|without|no need to)\s+(?:search|browse|go online)\b/i.test(
      text,
    )
  )
    return undefined;
  const match = text.match(
    /^(?:请\s*)?(?:帮我\s*)?(?:(?:用|使用)的?\s*)?(?:DeepSeek|DS|搜索功能)\s*(?:来\s*)?(?:搜索|搜|查询|查找|查)([\s\S]*)$/i,
  );
  const query = match?.[1]
    ?.trim()
    .replace(/^(?:一下|一查|一搜)\s*/u, '')
    .replace(/^\s*[:：,，]?\s*/u, '');
  if (!query || !/[\p{L}\p{N}]/u.test(query)) return undefined;
  if (isInvocationDiscussion(query)) return undefined;
  return text;
}
