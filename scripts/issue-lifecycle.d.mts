export const DAY: number;
export type Claim = {
  claimer: string | null;
  renewedAt: string | null;
  releaseLogins: string[];
  lastCommentId: number;
};
export type Comment = {
  id: number;
  body: string;
  created_at?: string;
  updated_at?: string;
  user: { login: string; type: string };
};
export type Issue = {
  number: number;
  state: string;
  created_at: string;
  labels: { name: string }[];
  assignees: { login: string }[];
  pull_request?: object;
};
export type Api = {
  repo: string;
  request(method: string, path: string, body?: unknown): Promise<any>;
  list(path: string): Promise<any[]>;
};
export function parseCommand(body?: string | null): 'claim' | 'unclaim' | 'renew' | null;
export function referencedIssues(text: string | null, repo: string): number[];
export function claimStatus(claim: Claim, now: number, hasOpenPR: boolean): 'keep' | 'warn' | 'release';
export function applyCommand(
  claim: Claim,
  command: string,
  actor: string,
  owner: string,
  at: string,
  hasOpenPR: boolean,
): { claim: Claim; message: string };
export function needsFindingReminder(issue: Issue, claim: Claim, now: number, lastReminderAt?: string): boolean;
export function readClaim(comments: Comment[]): { record: Comment | null; claim: Claim };
export function runLifecycle(api: Api, event: { repository?: { full_name: string } }, now?: number): Promise<void>;
