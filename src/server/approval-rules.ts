import { isAbsolute, resolve } from 'node:path';
import type { ApprovalKey } from '../shared/types.ts';

export function normalizedCommand(command: unknown): string | undefined {
  if (typeof command !== 'string' || !/^[a-zA-Z0-9 _./:@=+,\-]+$/.test(command)) return;
  const words = command.trim().split(/ +/);
  if (words[0].includes('=')) return;
  if (words.length < 2 || /^[-/]/.test(words[1])) return;
  return words.join(' ');
}

export function approvalKey(tool: string, input: Record<string, unknown>, cwd: string): ApprovalKey | undefined {
  if (input.grantRoot != null || input.networkApprovalContext != null) return;
  if (tool === 'Bash') {
    if (input.dangerouslyDisableSandbox) return;
    const command = normalizedCommand(input.command);
    return command ? { tool, command } : undefined;
  }
  if (!['Codex file change', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) return;
  const paths: unknown[] =
    tool === 'Codex file change'
      ? Array.isArray(input.changes)
        ? input.changes.flatMap((change) => {
            if (!change || typeof change !== 'object') return [undefined];
            if (
              !change.kind ||
              typeof change.kind !== 'object' ||
              Array.isArray(change.kind) ||
              !['add', 'delete', 'update'].includes(change.kind.type)
            )
              return [undefined];
            const paths: unknown[] = [change.path];
            for (const field of ['move_path', 'movePath']) {
              if (change.kind[field] != null) paths.push(change.kind[field]);
            }
            return paths;
          })
        : []
      : [tool === 'NotebookEdit' ? input.notebook_path : input.file_path];
  if (
    !paths.length ||
    paths.some(
      (path) =>
        typeof path !== 'string' ||
        !path.trim() ||
        path.includes('\0') ||
        path.split(/[/\\]/).includes('..') ||
        path.trimStart().startsWith('~') ||
        (tool !== 'Codex file change' &&
          (!isAbsolute(path) ||
            path !== path.trim() ||
            (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(path)))),
    )
  )
    return;
  if (!isAbsolute(cwd)) return;
  return {
    tool: tool as Extract<ApprovalKey, { paths: string[] }>['tool'],
    paths: [...new Set((paths as string[]).map((path) => resolve(cwd, path)))],
  };
}
