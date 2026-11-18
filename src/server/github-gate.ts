import { effectiveGates } from '../shared/project-gates.ts';
export { effectiveGates } from '../shared/project-gates.ts';
import type { ProjectGates } from '../shared/types.ts';

export type RuleId = 'local-path' | 'email' | 'secret' | 'record-file' | 'chat-quote';
export type ScanInput = { field: string; value: unknown; only?: RuleId[] };
export type ScanHit = { rule: RuleId; field: string; line: number; shown: string };
export type NewCommit = {
  sha: string;
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
  message: string;
};
export type GitHubWrite = {
  op: 'push' | 'open-pr' | 'merge' | 'comment' | 'file' | 'branch' | 'other';
  repo: string;
  branch?: string;
  defaultBranch?: string;
  paths?: string[];
  pathsUnverified?: boolean;
  commits?: NewCommit[];
  commitsTruncated?: boolean;
};
export type GateDecision = { outcome: 'pass' | 'ask' | 'refuse'; cardLines: string[]; error?: string };
export type Readback = 'match' | 'mismatch' | 'unverified';
export type ReadbackPlan = {
  path: string | undefined;
  fields: { field: string; expected: string }[];
};

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string' && !!s) : [];

function redactEmail(email: string): string {
  const at = email.indexOf('@');
  return at < 1 ? '***' : `${email[0]}***${email.slice(at)}`;
}
function redactPath(path: string): string {
  const separator = path.includes('\\') ? '\\' : '/';
  const parts = path.split(/[\\/]/).filter(Boolean);
  const windows = /^[a-z]:/i.test(path);
  const root = windows ? parts[0] : `/${parts[0]}`;
  const last = parts.length > (windows ? 3 : 2) ? parts.at(-1) : '';
  return `${root}${separator}***${separator}${last ?? ''}`;
}
const builtinEmails = new Set([
  'noreply@github.com',
  'noreply@anthropic.com',
  'noreply@openai.com',
  'git@github.com',
  'git@gitlab.com',
  'cursoragent@cursor.com',
]);
const secretPattern =
  /-----BEGIN [^-\r\n]*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\b(?:sk|xai)-[A-Za-z0-9_-]{20,}|\bxox[baprs]-[A-Za-z0-9-]{10,}|\beyJ[\w-]{20,}\.[\w-]{20,}\.[\w-]{20,}|\bBearer[ \t]+[A-Za-z0-9._~+/=-]{20,}/;
export function scanOutbound(
  inputs: ScanInput[],
  options: { allow?: string[]; allowEmails?: string[]; block?: string[] } = {},
): ScanHit[] {
  const hits: ScanHit[] = [];
  for (const input of inputs) {
    try {
      if (typeof input.value !== 'string') throw new Error('not text');
      const allow = strings(options.allow).map((s) => s.toLowerCase());
      const emails = strings(options.allowEmails).map((s) => s.toLowerCase());
      const enabled = (rule: RuleId) => !input.only || input.only.includes(rule);
      const add = (rule: RuleId, line: number, match: string, shown = match) => {
        if (rule !== 'secret' && allow.some((s) => match.toLowerCase().includes(s))) return;
        if (secretPattern.test(shown)) shown = '密钥样式';
        hits.push({ rule, field: input.field, line, shown });
      };
      for (const [index, line] of input.value.split('\n').entries()) {
        const lineNo = index + 1;
        if (enabled('local-path')) {
          const paths =
            /(?:[A-Za-z]:[\\/]+[Uu]sers[\\/]+[^\\/\s]+[\\/]+|(?<![\w.-])\/(?:Users|home)\/[^/\s]+\/)[^\s"'<>)]*/g;
          for (const m of line.matchAll(paths))
            if (!m[0].toLowerCase().startsWith('/home/runner/')) add('local-path', lineNo, m[0], redactPath(m[0]));
        }
        if (enabled('email') && line.includes('@')) {
          for (const word of line.split(/[^\w.+@-]+/)) {
            const pieces = word.split('@');
            for (let i = 1; i < pieces.length; i++) {
              const local = pieces[i - 1];
              if (!local) continue;
              const labels = pieces[i]!.split('.');
              let end = -1;
              let suffix = '';
              for (let j = 1; j < labels.length; j++) {
                if (!labels[j - 1] || !/^[\w-]+$/.test(labels[j - 1]!)) break;
                const tld = labels[j]!.match(/^[a-z]{2,}/i)?.[0];
                if (tld) {
                  end = j;
                  suffix = tld;
                }
              }
              if (end < 1) continue;
              const match = `${local}@${[...labels.slice(0, end), suffix].join('.')}`;
              const lower = match.toLowerCase();
              if (!builtinEmails.has(lower) && !lower.endsWith('@users.noreply.github.com') && !emails.includes(lower))
                add('email', lineNo, match, redactEmail(match));
            }
          }
        }
        if (enabled('secret')) {
          for (const m of line.matchAll(new RegExp(secretPattern.source, 'g'))) add('secret', lineNo, m[0], '密钥样式');
        }
        if (enabled('record-file')) {
          for (const m of line.matchAll(/[A-Za-z0-9_.-]+/g)) {
            const word = m[0].replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
            const lower = word.toLowerCase();
            if (
              ['claude-data', 'side-session-notes', 'ai_state.md'].includes(lower) ||
              (lower.startsWith('coordinator-handover-') && lower.length > 'coordinator-handover-'.length) ||
              (lower.includes('-handover') && lower.endsWith('.md')) ||
              /^claude_[a-z0-9]{10,}$/.test(lower)
            )
              add('record-file', lineNo, word);
          }
        }
        if (enabled('chat-quote')) {
          const quoted = line.match(/^\s*>[>\s]*(?:user|assistant|human|ai|主人|用户)\s*[:：].*/i);
          if (quoted) add('chat-quote', lineNo, quoted[0], '聊天引用');
        }
      }
      if (enabled('chat-quote')) {
        const text = input.value;
        const starts = [0];
        for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
        const lineAt = (index: number) => {
          let lo = 0,
            hi = starts.length;
          while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (starts[mid]! <= index) lo = mid + 1;
            else hi = mid;
          }
          return lo;
        };
        const quotedStart = /[“「]\s*(?:user|assistant|human|ai|主人|用户)\s*[:：]/gi;
        const lastCurly = text.lastIndexOf('”');
        const lastCorner = text.lastIndexOf('」');
        let match: RegExpExecArray | null;
        while ((match = quotedStart.exec(text))) {
          const closer = match[0][0] === '“' ? '”' : '」';
          if ((closer === '”' ? lastCurly : lastCorner) < quotedStart.lastIndex) continue;
          const end = text.indexOf(closer, quotedStart.lastIndex);
          add('chat-quote', lineAt(match.index), text.slice(match.index, end + 1), '聊天引用');
          quotedStart.lastIndex = end + 1;
        }
        for (const m of text.matchAll(/\[项目规则更新\]|\[调用方[^\]]{0,80}的消息\]/g))
          add('chat-quote', lineAt(m.index!), m[0], '聊天引用');
        const lower = text.toLowerCase();
        for (const word of strings(options.block)) {
          const index = lower.indexOf(word.toLowerCase());
          if (index >= 0) hits.push({ rule: 'chat-quote', field: input.field, line: lineAt(index), shown: '聊天引用' });
        }
      }
    } catch {
      hits.push({ rule: 'secret', field: input.field, line: 0, shown: '外发文本检查器出错' });
    }
  }
  return hits;
}
export function scanMessage(hits: ScanHit[]): string {
  const names: Record<RuleId, string> = {
    'local-path': '本地路径',
    email: '邮箱',
    secret: '密钥样式',
    'record-file': '记录文件',
    'chat-quote': '聊天引用',
  };
  return [
    `外发文本检查未通过，未写入 GitHub。命中 ${hits.length} 处：`,
    ...hits.slice(0, 5).map((h) => `· ${names[h.rule]} · ${h.field} 第 ${h.line} 行：${h.shown}`),
    '改好文字后再试。',
  ].join('\n');
}

export function glob(pattern: string, value: string, insensitive = false): boolean {
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }
  return new RegExp(re + '$', insensitive ? 'i' : '').test(value);
}
const branchName = (s: string) =>
  s
    .trim()
    .replace(/^(?:refs\/heads\/|heads\/)/i, '')
    .toLowerCase();
export function decide(write: GitHubWrite, gates: ProjectGates | undefined, now: Date): GateDecision {
  const config = effectiveGates(gates);
  const author =
    gates?.commitAuthor &&
    Array.isArray(gates.commitAuthor.emails) &&
    gates.commitAuthor.emails.every((e) => typeof e === 'string')
      ? gates.commitAuthor
      : undefined;
  const refuse = (error: string): GateDecision => ({ outcome: 'refuse', cardLines: [], error });
  if (write.op === 'file' && author)
    return refuse(
      '本项目要求提交作者是项目配置的身份，而 GitHub 连接器以 gh 账号提交，身份无法核对；请在工作线里提交后用 push_branch。',
    );
  let ask = false;
  const cardLines: string[] = [];
  if (write.op === 'push' && author) {
    const allowed = author.emails.map((e) => e.toLowerCase());
    const mismatches = (write.commits ?? []).filter(
      (c) => !allowed.includes(c.authorEmail.toLowerCase()) || !allowed.includes(c.committerEmail.toLowerCase()),
    );
    if (mismatches.length) {
      const lines = mismatches
        .slice(0, 5)
        .flatMap((c) => [
          ...(!allowed.includes(c.authorEmail.toLowerCase())
            ? [`· ${c.sha.slice(0, 7)}  作者 ${c.authorName} <${redactEmail(c.authorEmail)}>`]
            : []),
          ...(!allowed.includes(c.committerEmail.toLowerCase())
            ? [`· ${c.sha.slice(0, 7)}  提交者 ${c.committerName} <${redactEmail(c.committerEmail)}>`]
            : []),
        ]);
      const detail = `本项目要求提交作者是 ${author.emails.map(redactEmail).join('、')}。待推的 ${write.commits?.length ?? 0} 个提交里有 ${mismatches.length} 个不是：\n${lines.join('\n')}\n请在工作线里改好作者（git commit --amend --reset-author 或 rebase）后再推，PugPort 不会替你改历史。`;
      if (author.onMismatch !== 'ask') return refuse(detail);
      ask = true;
      cardLines.push('提交作者与项目配置不符：', detail);
    }
  }
  const window = gates?.windows?.noMerge;
  if (
    write.op === 'merge' &&
    window &&
    typeof window.from === 'string' &&
    typeof window.to === 'string' &&
    /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(window.from) &&
    /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(window.to) &&
    window.from !== window.to
  ) {
    try {
      const tz = window.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      const time = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(now);
      if (window.from < window.to ? time >= window.from && time < window.to : time >= window.from || time < window.to)
        return refuse(
          `本项目 ${window.from}–${window.to}（${tz}）不合并；现在 ${time}。等窗口过了再发起，或由主人手动合并。`,
        );
    } catch {
      /* Invalid time zone means no window. */
    }
  }
  if (write.op === 'push' || write.op === 'file' || write.op === 'merge') {
    if (write.op !== 'merge' && typeof write.branch === 'string') {
      const branch = branchName(write.branch);
      if (
        (write.defaultBranch && branch === branchName(write.defaultBranch)) ||
        strings(config.alwaysAsk?.branches).some((p) => glob(branchName(p), branch))
      ) {
        ask = true;
        cardLines.push(`分支：${write.branch} 是必问分支`);
      }
    }
    if (write.pathsUnverified) {
      ask = true;
      cardLines.push('路径：未能核对');
    } else if (write.paths) {
      const pathPatterns = strings(config.alwaysAsk?.paths);
      const matched = pathPatterns.find((p) =>
        write.paths!.some((path) => glob(p, path.replace(/\\/g, '/'), process.platform === 'win32')),
      );
      if (matched && write.op !== 'merge') ask = true;
      cardLines.push(`路径：${write.paths.length} 个文件${matched ? ` · 含 ${matched}（必问）` : ''}`);
    }
    if (write.commitsTruncated) {
      ask = true;
      cardLines.push(`提交数超过 ${write.commits?.length ?? 500}，未逐个核对作者和提交说明`);
    }
  }
  return { outcome: ask ? 'ask' : 'pass', cardLines };
}
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .normalize('NFC')
    .trim();
}
export function compareText(expected: string, actual: unknown): Readback {
  return typeof actual !== 'string'
    ? 'unverified'
    : normalizeText(expected) === normalizeText(actual)
      ? 'match'
      : 'mismatch';
}

export function connectorWrite(
  tool: string,
  args: Record<string, unknown>,
  defaultBranch?: string,
): { write: GitHubWrite; texts: ScanInput[] } {
  const texts: ScanInput[] = [];
  const add = (key: string, only?: RuleId[]) => {
    if (Object.hasOwn(args, key)) texts.push({ field: key, value: args[key], ...(only ? { only } : {}) });
  };
  const repo = `${typeof args.owner === 'string' ? args.owner : ''}/${typeof args.repo === 'string' ? args.repo : ''}`;
  const write: GitHubWrite = { op: 'other', repo, defaultBranch };
  switch (tool) {
    case 'create_pull_request':
    case 'update_pull_request':
      write.op = 'open-pr';
      add('title');
      add('body');
      break;
    case 'add_issue_comment':
    case 'update_issue_comment':
    case 'add_reply_to_pull_request_comment':
    case 'add_comment_to_pending_review':
    case 'pull_request_review_write':
      write.op = 'comment';
      add('body');
      break;
    case 'issue_write':
      write.op = 'comment';
      add('title');
      add('body');
      break;
    case 'push_files':
      write.op = 'file';
      write.branch = typeof args.branch === 'string' ? args.branch : undefined;
      add('message');
      if (Array.isArray(args.files)) {
        write.paths = [];
        args.files.forEach((item: unknown, i: number) => {
          if (!item || typeof item !== 'object') {
            texts.push({ field: `files[${i}]`, value: item });
            return;
          }
          const file = item as Record<string, unknown>;
          if (Object.hasOwn(file, 'path')) {
            texts.push({ field: `files[${i}].path`, value: file.path, only: ['record-file'] });
            if (typeof file.path === 'string') write.paths!.push(file.path);
          }
          if (Object.hasOwn(file, 'content'))
            texts.push({ field: `files[${i}].content`, value: file.content, only: ['secret'] });
        });
      } else if (Object.hasOwn(args, 'files')) texts.push({ field: 'files', value: args.files });
      break;
    case 'create_or_update_file':
    case 'delete_file':
      write.op = 'file';
      write.branch = typeof args.branch === 'string' ? args.branch : undefined;
      if (typeof args.path === 'string') write.paths = [args.path];
      add('path', ['record-file']);
      add('message');
      add('content', ['secret']);
      break;
    case 'create_branch':
      write.op = 'branch';
      break;
    case 'merge_pull_request':
      write.op = 'merge';
      add('commit_title');
      add('commit_message');
      break;
    default:
      for (const key of ['title', 'body', 'message', 'comment', 'commit_title', 'commit_message', 'description'])
        if (typeof args[key] === 'string') add(key);
  }
  return { write, texts };
}

export function connectorReadback(
  tool: string,
  args: Record<string, unknown>,
  result: unknown,
): ReadbackPlan | undefined {
  let kind: 'pulls' | 'issues' | 'issue-comments' | 'pull-comments' | 'commits';
  let keys: string[];
  switch (tool) {
    case 'create_pull_request':
    case 'update_pull_request':
      kind = 'pulls';
      keys = ['title', 'body'];
      break;
    case 'issue_write':
      kind = 'issues';
      keys = ['title', 'body'];
      break;
    case 'add_issue_comment':
    case 'update_issue_comment':
      kind = 'issue-comments';
      keys = ['body'];
      break;
    case 'add_reply_to_pull_request_comment':
    case 'add_comment_to_pending_review':
      kind = 'pull-comments';
      keys = ['body'];
      break;
    case 'push_files':
    case 'create_or_update_file':
    case 'delete_file':
      kind = 'commits';
      keys = ['message'];
      break;
    default:
      return undefined;
  }
  const fields = keys
    .filter((key) => typeof args[key] === 'string')
    .map((key) => ({ field: key, expected: args[key] as string }));
  if (!fields.length) return undefined;
  let data: Record<string, unknown> = {};
  try {
    const response = result as { content?: { text?: unknown }[] };
    const parsed: unknown = JSON.parse(
      typeof response?.content?.[0]?.text === 'string' ? response.content[0].text : 'null',
    );
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    /* Missing or malformed results cannot be verified. */
  }
  const owner = args.owner,
    repo = args.repo;
  if (
    typeof owner !== 'string' ||
    typeof repo !== 'string' ||
    !/^[\w.-]+$/.test(owner) ||
    !/^[\w.-]+$/.test(repo) ||
    owner === '..' ||
    repo === '..'
  )
    return { path: undefined, fields };
  let id: unknown;
  if (kind === 'commits') {
    const commit = data.commit as Record<string, unknown> | undefined;
    const object = data.object as Record<string, unknown> | undefined;
    id = commit?.sha ?? object?.sha;
    if (typeof id !== 'string' || !/^[0-9a-f]{40}$/.test(id)) return { path: undefined, fields };
  } else {
    id =
      kind === 'pulls'
        ? (data.number ?? args.pullNumber ?? args.pull_number)
        : kind === 'issues'
          ? (data.number ?? args.issue_number)
          : data.id;
    if (!(
      (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) ||
      (typeof id === 'string' && /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) && Number(id) > 0)
    ))
      return { path: undefined, fields };
    id = Number(id);
  }
  const segment =
    kind === 'issue-comments'
      ? 'issues/comments'
      : kind === 'pull-comments'
        ? 'pulls/comments'
        : kind === 'commits'
          ? 'git/commits'
          : kind;
  return { path: `/repos/${owner}/${repo}/${segment}/${id}`, fields };
}
