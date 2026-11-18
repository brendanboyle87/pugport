import type { Api } from './issue-lifecycle.mjs';
export const LIMIT: number;
export type ChangedFile = { filename: string; previous_filename?: string; additions: number; deletions: number };
export type Pr = {
  number: number;
  head: { sha: string };
  state?: string;
  changed_files?: number;
  labels?: { name: string }[];
};
export type SizeEvent = {
  repository?: { full_name: string };
  pull_request?: Pr;
};
export function excludedPath(path: string): boolean;
export function countLines(files: ChangedFile[]): {
  total: number;
  excluded: number;
  counted: number;
  excludedFiles: string[];
};
export function runSize(api: Api, event: SizeEvent, summaryPath?: string): Promise<{ large: boolean }>;
