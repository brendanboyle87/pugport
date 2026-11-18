import { z } from 'zod';
import type { ProjectGates } from './types.ts';

export const DEFAULT_ALWAYS_ASK = {
  paths: ['**/migrations/**', '**/CODEOWNERS', '.github/workflows/**'],
  branches: ['main', 'master', 'develop', 'release/*'],
};
const validTz = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
const hhmm = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const pathGlob = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[^\x00-\x1f\x7f]+$/)
  .refine(
    (v) =>
      !!v
        .trim()
        .replaceAll('\\', '/')
        .replace(/^(?:\.\/|\/)+/, ''),
  );
const branchGlob = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^\s~^:\\]+$/);
// A bare address: `<a@x.com>` or `a@x.com,` would never match a real commit author.
const email = z.string().regex(/^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[A-Za-z]{2,}$/);
const phrase = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\x00-\x1f\x7f]+$/)
  .refine((v) => !!v.trim());
export const projectGatesInputSchema = z
  .object({
    version: z.literal(1),
    text: z
      .object({
        allow: z
          .array(phrase.refine((v) => v.trim().length >= 3))
          .max(50)
          .optional(),
        block: z.array(phrase).max(50).optional(),
      })
      .strict()
      .optional(),
    alwaysAsk: z
      .object({ paths: z.array(pathGlob).max(50).optional(), branches: z.array(branchGlob).max(50).optional() })
      .strict()
      .optional(),
    windows: z
      .object({
        noMerge: z
          .object({ from: hhmm, to: hhmm, tz: z.string().refine(validTz).optional() })
          .strict()
          .refine((w) => w.from !== w.to)
          .optional(),
      })
      .strict()
      .optional(),
    commitAuthor: z
      .object({ emails: z.array(email).min(1).max(10), onMismatch: z.enum(['refuse', 'ask']).optional() })
      .strict()
      .optional(),
  })
  .strict();
export type ProjectGatesInput = z.infer<typeof projectGatesInputSchema>;
export type GateLineError = { line: number; message: string };
const unique = (values: string[], insensitive = false) =>
  values.filter((v, i) => values.findIndex((x) => (insensitive ? x.toLowerCase() === v.toLowerCase() : x === v)) === i);
const path = (value: string) =>
  value
    .trim()
    .replaceAll('\\', '/')
    .replace(/^(?:\.\/|\/)+/, '');
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
export function effectiveGates(gates?: ProjectGates): ProjectGates {
  return {
    ...gates,
    version: 1,
    alwaysAsk: {
      paths: Array.isArray(gates?.alwaysAsk?.paths)
        ? gates.alwaysAsk.paths.filter((v): v is string => typeof v === 'string' && !!v)
        : DEFAULT_ALWAYS_ASK.paths,
      branches: Array.isArray(gates?.alwaysAsk?.branches)
        ? gates.alwaysAsk.branches.filter((v): v is string => typeof v === 'string' && !!v)
        : DEFAULT_ALWAYS_ASK.branches,
    },
  };
}
export function normalizeGates(input: ProjectGatesInput): ProjectGates | undefined {
  const paths = input.alwaysAsk?.paths?.map(path);
  const branches = input.alwaysAsk?.branches?.map((v) => v.toLowerCase());
  const p = paths && unique(paths);
  const b = branches && unique(branches, true);
  const alwaysAsk = {
    paths: p && !sameSet(p, DEFAULT_ALWAYS_ASK.paths) ? p : undefined,
    branches: b && !sameSet(b, DEFAULT_ALWAYS_ASK.branches) ? b : undefined,
  };
  const allow = unique(input.text?.allow?.map((v) => v.trim()).filter(Boolean) ?? [], true);
  const block = unique(input.text?.block?.map((v) => v.trim()).filter(Boolean) ?? [], true);
  const author = input.commitAuthor && {
    emails: unique(
      input.commitAuthor.emails.map((v) => v.toLowerCase()),
      true,
    ),
    onMismatch: input.commitAuthor.onMismatch ?? 'refuse',
  };
  const result: ProjectGates = { version: 1 };
  if (alwaysAsk.paths || alwaysAsk.branches) result.alwaysAsk = alwaysAsk;
  if (allow.length || block.length) result.text = { ...(allow.length && { allow }), ...(block.length && { block }) };
  if (input.windows?.noMerge) result.windows = { noMerge: input.windows.noMerge };
  if (author) result.commitAuthor = author;
  return Object.keys(result).length === 1 ? undefined : result;
}
export function formatGateLines(gates?: ProjectGates): string {
  const g = effectiveGates(gates);
  return [
    ...g.alwaysAsk!.paths!.map((v) => `always-ask ${/^branch(?:\s|$)/i.test(v) ? './' : ''}${v}`),
    ...g.alwaysAsk!.branches!.map((v) => `always-ask branch ${v}`),
    ...(g.windows?.noMerge
      ? [
          `no-merge ${g.windows.noMerge.from}-${g.windows.noMerge.to}${g.windows.noMerge.tz ? ` ${g.windows.noMerge.tz}` : ''}`,
        ]
      : []),
    ...(g.commitAuthor ? [`author ${g.commitAuthor.emails.join(' ')} ${g.commitAuthor.onMismatch ?? 'refuse'}`] : []),
    ...(g.text?.allow ?? []).map((v) => `allow ${v}`),
    ...(g.text?.block ?? []).map((v) => `block ${v}`),
  ].join('\n');
}
export function parseGateLines(text: string): { gates?: ProjectGatesInput; errors: GateLineError[] } {
  const errors: GateLineError[] = [];
  const paths: string[] = [],
    branches: string[] = [],
    allow: string[] = [],
    block: string[] = [],
    emails: string[] = [];
  let window: NonNullable<NonNullable<ProjectGatesInput['windows']>['noMerge']> | undefined;
  let mode: 'ask' | 'refuse' | undefined;
  const lines = text.split(/\r?\n/);
  if (lines.filter((line) => line.trim()).length > 200) errors.push({ line: 201, message: `规则最多 200 行。` });
  for (const [i, raw] of lines.entries()) {
    const line = i + 1;
    const s = raw.trim();
    if (!s) continue;
    const fail = (message: string) => errors.push({ line, message: `第 ${line} 行：${message}` });
    const [, keyword = '', rest = ''] = /^(\S+)(?:\s+([\s\S]*))?$/.exec(s) ?? [];
    switch (keyword.toLowerCase()) {
      case 'always-ask': {
        const isBranch = /^branch(?:\s|$)/i.test(rest);
        const value = isBranch ? rest.replace(/^branch\s*/i, '').trim() : path(rest);
        if (!value) {
          fail(
            isBranch ? 'always-ask branch 后面写一个分支名，例如 release/*。' : 'always-ask 后面写路径，例如 docs/**。',
          );
          break;
        }
        if (value.length > (isBranch ? 255 : 300)) {
          fail(`太长了，最多 ${isBranch ? 255 : 300} 个字符。`);
          break;
        }
        if (isBranch && !branchGlob.safeParse(value).success) {
          fail('always-ask branch 后面写一个分支名，例如 release/*。');
          break;
        }
        if (!isBranch && !pathGlob.safeParse(value).success) {
          fail('always-ask 后面写路径，例如 docs/**。');
          break;
        }
        (isBranch ? branches : paths).push(isBranch ? value.toLowerCase() : value);
        break;
      }
      case 'no-merge': {
        if (window) {
          fail('只能有一行 no-merge。');
          break;
        }
        const match = /^(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})(?:\s+(\S+))?$/.exec(rest);
        const from = match?.[1]?.padStart(5, '0'),
          to = match?.[2]?.padStart(5, '0'),
          tz = match?.[3];
        if (!from || !to || !hhmm.safeParse(from).success || !hhmm.safeParse(to).success) {
          fail('时间写成 22:00-07:00。');
          break;
        }
        if (from === to) {
          fail('开始和结束不能是同一时间。');
          break;
        }
        if (tz && !validTz(tz)) {
          fail(`不认识时区「${tz}」，例如 America/New_York。`);
          break;
        }
        window = { from, to, ...(tz && { tz }) };
        break;
      }
      case 'author': {
        const parts = rest.split(/\s+/).filter(Boolean);
        const last = parts.at(-1)?.toLowerCase();
        const nextMode =
          last === 'ask' || last === 'refuse' ? (parts.pop()!.toLowerCase() as 'ask' | 'refuse') : 'refuse';
        if (!parts.length) {
          fail('author 后面写邮箱，最后可加 refuse 或 ask。');
          break;
        }
        if (mode && mode !== nextMode) {
          fail('所有 author 行要用同一个 refuse 或 ask。');
          break;
        }
        const invalid = parts.find((v) => !email.safeParse(v).success);
        if (invalid) {
          fail(`「${invalid}」不是邮箱。`);
          break;
        }
        mode = nextMode;
        emails.push(...parts.map((v) => v.toLowerCase()));
        break;
      }
      case 'allow':
      case 'block': {
        if (!rest || (keyword.toLowerCase() === 'allow' && rest.length < 3)) {
          fail(keyword.toLowerCase() === 'allow' ? 'allow 的文字至少 3 个字符。' : 'block 后面写文字。');
          break;
        }
        if (rest.length > 200) {
          fail('太长了，最多 200 个字符。');
          break;
        }
        if (!phrase.safeParse(rest).success) {
          fail('文字里不能有制表符等控制字符。');
          break;
        }
        (keyword.toLowerCase() === 'allow' ? allow : block).push(rest);
        break;
      }
      default:
        fail(`不认识「${keyword}」。可用 always-ask、no-merge、author、allow、block。`);
    }
  }
  const lists = [
    [paths, '路径', 50],
    [branches, '分支', 50],
    [allow, 'allow', 50],
    [block, 'block', 50],
    [emails, 'author', 10],
  ] as const;
  for (const [list, name, max] of lists)
    if (unique(list, name !== '路径').length > max) errors.push({ line: 0, message: `${name} 最多 ${max} 行。` });
  if (errors.length) return { errors };
  const gates: ProjectGatesInput = {
    version: 1,
    alwaysAsk: { paths: unique(paths), branches: unique(branches, true) },
    text: { allow: unique(allow, true), block: unique(block, true) },
    ...(window && { windows: { noMerge: window } }),
    ...(emails.length && { commitAuthor: { emails: unique(emails, true), onMismatch: mode } }),
  };
  return { gates, errors };
}
const minutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
const covered = (old: { from: string; to: string }, next: { from: string; to: string }) => {
  const has = (w: typeof old, n: number) => {
    const a = minutes(w.from),
      b = minutes(w.to);
    return a < b ? n >= a && n < b : n >= a || n < b;
  };
  return Array.from({ length: 1440 }, (_, n) => n).every((n) => !has(old, n) || has(next, n));
};
const windowLabel = (w: { from: string; to: string; tz?: string }) => `${w.from}-${w.to}${w.tz ? ` ${w.tz}` : ''}`;
export function gateLoosening(current?: ProjectGates, next?: ProjectGates): string[] {
  const a = effectiveGates(current),
    b = effectiveGates(next);
  const result: string[] = [];
  const removed = (old: string[], now: string[], insensitive = false) =>
    old.filter((v) => !now.some((x) => (insensitive ? x.toLowerCase() === v.toLowerCase() : x === v)));
  // The dialog shows only the first 20 lines, so the rarer, riskier kinds come before long path and branch lists.
  for (const v of removed(b.text?.allow ?? [], a.text?.allow ?? [], true)) result.push(`新增放行文字：${v}`);
  for (const v of removed(b.commitAuthor?.emails ?? [], a.commitAuthor?.emails ?? [], true))
    result.push(`新增提交作者邮箱：${v}（外发文字不再拦截它）`);
  if (a.commitAuthor && !b.commitAuthor) result.push('不再要求提交作者');
  if (
    a.commitAuthor &&
    b.commitAuthor &&
    (a.commitAuthor.onMismatch ?? 'refuse') === 'refuse' &&
    b.commitAuthor.onMismatch === 'ask'
  )
    result.push('作者不符时改为询问，不再拒绝');
  const old = a.windows?.noMerge,
    now = b.windows?.noMerge;
  if (old && !now) result.push(`不再禁止合并：${windowLabel(old)}`);
  else if (old && now && (old.tz !== now.tz || !covered(old, now)))
    result.push([`禁止合并时段：${windowLabel(old)}`, windowLabel(now)].join(' → '));
  for (const v of removed(a.text?.block ?? [], b.text?.block ?? [], true)) result.push(`不再拦截文字：${v}`);
  for (const v of removed(a.alwaysAsk!.paths!, b.alwaysAsk!.paths!)) result.push(`不再必问路径：${v}`);
  for (const v of removed(a.alwaysAsk!.branches!, b.alwaysAsk!.branches!, true)) result.push(`不再必问分支：${v}`);
  return result;
}
