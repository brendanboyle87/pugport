import { appendFile, mkdir, rename, stat, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { redactToolDiagnostic } from '../tool-diagnostics.ts';
import type { MaintainerMode } from './config.ts';

function redactDiagnostic(value: string, limit: number): string {
  return redactToolDiagnostic(value.replace(/\b(?:gh[pousr]_[\w]+|github_pat_[\w]+)/g, '[redacted]'), limit);
}

export function failureReason(error: unknown): string {
  const first =
    (error instanceof Error ? error.message : String(error)).split(/\r\n|[\r\n]/).find((line) => line.trim()) ?? '';
  const safe = first
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[redacted]')
    .replace(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s"'<>]+/g, (part) =>
      /\.pem(?:["'),;:]*$)|github-app|[\\/]secrets/i.test(part) ? '[path]' : part,
    )
    .replaceAll(homedir(), '~')
    .replaceAll(homedir().replaceAll('\\', '/'), '~');
  return redactDiagnostic(safe, 160) || 'unknown error';
}

export type AuditLine = {
  at: string;
  mode: MaintainerMode;
  event: 'pr' | 'issue' | 'repo' | 'card' | 'suite' | 'poll';
  number?: number;
  sha?: string;
  action:
    | 'comment'
    | 'comment-edit'
    | 'status'
    | 'review'
    | 'label'
    | 'label-create'
    | 'merge'
    | 'card'
    | 'suite'
    | 'skip'
    | 'refused'
    | 'error';
  credential: 'app' | 'gh-login' | 'gh-desktop' | 'none';
  model?: string;
  executor?: string;
  judgeId?: string;
  result: 'ok' | 'shadow-only' | 'error' | 'skipped';
  detail?: string;
};
export class MaintainerAudit {
  private pending = Promise.resolve();
  constructor(
    private readonly file: string,
    private readonly limitBytes = 10 * 1024 * 1024,
  ) {}
  append(line: AuditLine): Promise<void> {
    const safe = {
      ...line,
      ...(line.detail
        ? {
            detail: redactDiagnostic(line.detail, 400),
          }
        : {}),
    };
    const work = this.pending.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const size = await stat(this.file).then(
        (s) => s.size,
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return 0;
          throw error;
        },
      );
      if (size >= this.limitBytes) {
        const previous = this.file.replace(/\.jsonl$/, '') + '.1.jsonl';
        await rm(previous, { force: true });
        await rename(this.file, previous);
      }
      await appendFile(this.file, JSON.stringify(safe) + '\n');
    });
    this.pending = work.catch(() => {});
    return work;
  }
  recent(n = 20): AuditLine[] {
    try {
      return readFileSync(this.file, 'utf8')
        .trim()
        .split('\n')
        .slice(-Math.max(1, n))
        .map((line) => JSON.parse(line) as AuditLine);
    } catch {
      return [];
    }
  }
}
