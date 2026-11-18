import { safeToolEventText } from './tool-event-data.ts';

// Native names and ACP kinds share one display vocabulary; unknown extensions remain tools.
export const activityVocabulary = {
  read: [
    '正在读取文件',
    '已读取文件',
    'Reading files',
    'Read files',
    ['read', 'ReadFile', 'read_file', 'readTextFile'],
  ],
  image: ['正在查看图片', '已查看图片', 'Viewing images', 'Viewed images', ['read_image', 'view_image', 'imageView']],
  search: [
    '正在搜索代码',
    '已搜索代码',
    'Searching code',
    'Searched code',
    ['grep', 'glob', 'search', 'code_search', 'list_directory', 'rg', 'find', 'ls'],
  ],
  write: ['正在写入文件', '已写入文件', 'Writing files', 'Wrote files', ['write', 'write_file', 'writeTextFile']],
  edit: [
    '正在修改文件',
    '修改了文件',
    'Editing files',
    'Edited files',
    ['edit', 'MultiEdit', 'apply_patch', 'fileChange', 'file_change', 'NotebookEdit', 'edit_file'],
  ],
  command: [
    '正在运行命令',
    '执行了命令',
    'Running a command',
    'Ran commands',
    [
      'bash',
      'pwsh',
      'powershell',
      'execute',
      'exec_command',
      'write_stdin',
      'commandExecution',
      'command_execution',
      'run_shell_command',
      'shell',
      'run_code',
    ],
  ],
  webSearch: [
    '正在搜索网页',
    '已搜索网页',
    'Searching the web',
    'Searched the web',
    ['WebSearch', 'web_search', 'webSearch'],
  ],
  webFetch: ['正在访问网页', '已访问网页', 'Opening pages', 'Opened pages', ['WebFetch', 'web_fetch', 'fetch']],
  browser: ['正在操作浏览器', '操作了浏览器', 'Using the browser', 'Used the browser', ['browser', 'browse']],
  member: [
    '正在协调成员',
    '已协调成员',
    'Coordinating members',
    'Coordinated members',
    [
      'Task',
      'Agent',
      'subagent',
      'spawn_agent',
      'delegate',
      'delegate_many',
      'get_result',
      'message_agent',
      'list_swarm',
      'collabAgentToolCall',
    ],
  ],
  plan: [
    '正在更新计划',
    '更新了计划',
    'Updating the plan',
    'Updated the plan',
    ['TodoWrite', 'todo_write', 'update_plan', 'set_plan', 'plan', 'create_goal', 'update_goal', 'get_goal'],
  ],
  question: [
    '等待你的回答',
    '向你提了问题',
    'Waiting for you',
    'Asked you a question',
    ['AskUserQuestion', 'ask_user_question', 'ask_user', 'request_user_input', 'request_user_input_async'],
  ],
  pugport: ['正在使用 PugPort 工具', '用了 PugPort 工具', 'Using PugPort tools', 'Used PugPort tools', []],
  other: ['正在调用工具', '调用了工具', 'Calling tools', 'Called tools', []],
  thinking: ['正在分析', '已完成分析', 'Thinking', 'Thought it through', ['think']],
} as const;
export type ActivityCategory = keyof typeof activityVocabulary;
const normalize = (name: string) => name.toLowerCase().replace(/[_-]/g, '');
export function activityCategory(name: string, kind = '', source = ''): ActivityCategory {
  const short = name.split(/__|\./).at(-1) ?? name;
  for (const candidate of [short, kind]) {
    for (const [category, entry] of Object.entries(activityVocabulary))
      if ((entry[4] as readonly string[]).some((alias) => normalize(alias) === normalize(candidate)))
        return category as ActivityCategory;
    if (/^browser[_-]/i.test(candidate)) return 'browser';
    if (/^terminal[_-]/i.test(candidate)) return 'command';
    if (/^subagent[_-]/i.test(candidate)) return 'member';
    if (/_inspect$/i.test(candidate)) return 'search';
  }
  return source === 'pugport' || /(?:^|__)pugport(?:__|$)/i.test(name) ? 'pugport' : 'other';
}
export function activityLabel(category: ActivityCategory, running = false, language: 'zh' | 'en' = 'zh') {
  const entry = activityVocabulary[category];
  return language === 'en' ? (running ? entry[2] : entry[3]) : running ? entry[0] : entry[1];
}
export function activitySummary(calls: { key: string; category: ActivityCategory }[], language: 'zh' | 'en' = 'zh') {
  const counts = new Map<ActivityCategory, number>();
  const seen = new Set<string>();
  for (const call of calls) {
    if (seen.has(call.key)) continue;
    seen.add(call.key);
    counts.set(call.category, (counts.get(call.category) ?? 0) + 1);
  }
  const categories = [...counts].sort((a, b) => b[1] - a[1]).map(([category]) => category);
  const phrases = categories.slice(0, 3).map((category) => activityLabel(category, false, language));
  if (!phrases.length) return activityLabel('thinking', false, language);
  const text =
    phrases.length === 2
      ? language === 'zh'
        ? `${phrases[0]}并${phrases[1].replace(/^已/, '')}`
        : phrases.join(' and ')
      : phrases.join(language === 'zh' ? '，' : ', ');
  return text + (categories.length > 3 ? (language === 'zh' ? '等' : ', and more') : '');
}
export function presentationPreview(value: string, limit = 160): string {
  const clean = safeToolEventText(value).replace(/\s+/gu, ' ').trim();
  const parts: string[] = [];
  for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(clean)) {
    if (parts.length >= limit) break;
    parts.push(part.segment);
  }
  return parts.join('');
}
export function activityArgument(input: Record<string, unknown>): string {
  for (const key of [
    'title',
    'description',
    'objective',
    'command',
    'cmd',
    'query',
    'path',
    'file_path',
    'file',
    'url',
    'pattern',
  ]) {
    if (typeof input[key] === 'string' && input[key].trim()) return presentationPreview(input[key]);
  }
  return '';
}
/**
 * A short reason for a failed tool call, chosen from sentences written here. The raw error, which can carry
 * addresses, page text or secrets, is only matched against and never shown in the row.
 */
export function toolFailureReason(error: string): '已超时' | '没连上' | '被拒绝' | '找不到' | '失败' {
  const text = error.slice(0, 4000);
  if (/time[ds]?[ _-]?out|ETIMEDOUT|deadline exceeded|超时/i.test(text)) return '已超时';
  if (
    /ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|fetch failed|getaddrinfo|socket hang up|network|connection (?:refused|reset|closed|failed|error)|(?:could not|couldn't|unable to|failed to) connect|无法连接|连接失败|网络/i.test(
      text,
    )
  )
    return '没连上';
  if (
    /\b(?:401|403|407|429|451)\b|forbidden|denied|not allowed|refused to|blocked|unauthori[sz]ed|rate.?limit|captcha|拒绝|禁止/i.test(
      text,
    )
  )
    return '被拒绝';
  if (/\b(?:404|410)\b|not found|no such file|ENOENT|找不到|不存在/i.test(text)) return '找不到';
  return '失败';
}
