import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from './platform/test-process.ts';
import { assertPublishCommon, hostGit, hostRepositoryCommon, validBranch } from './managed-worktrees.ts';
import type { ProjectGates } from '../shared/types.ts';
import {
  compareText,
  decide,
  scanMessage,
  scanOutbound,
  type NewCommit,
  type Readback,
  type RuleId,
} from './github-gate.ts';
import { countChecks as counts } from '../shared/lane-github.ts';

/** Accept only the three GitHub remote shapes. The host is anchored; userinfo and other hosts are rejected. */
export function githubRepository(url: string): { owner: string; repo: string } | undefined {
  const value = url.trim();
  const https = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s?#]+?)(?:\.git)?\/?$/i.exec(value);
  const sshUrl = /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s?#]+?)(?:\.git)?\/?$/i.exec(value);
  const scp = /^git@github\.com:([^/\s]+)\/([^/\s?#]+?)(?:\.git)?$/i.exec(value);
  const match = https ?? sshUrl ?? scp;
  if (!match) return;
  const owner = match[1] ?? '';
  let repo = match[2] ?? '';
  if (repo.toLowerCase().endsWith('.git')) repo = repo.slice(0, -4);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) return;
  if (
    !repo ||
    !/^[A-Za-z0-9._-]{1,100}$/.test(repo) ||
    repo.includes('..') ||
    repo.startsWith('.') ||
    repo.endsWith('.')
  )
    return;
  return { owner, repo };
}

export type PublishCaller = {
  write?: boolean;
  network?: boolean;
  child?: boolean;
  background?: boolean;
  prohibitCommands?: boolean;
};

/** The three publish tools exist only on a writable, networked, foreground run that is not a child. */
export function branchPublishAvailable(caller: PublishCaller): boolean {
  return (
    caller.write === true &&
    caller.network === true &&
    !caller.child &&
    !caller.background &&
    caller.prohibitCommands !== true
  );
}

type GitResult = { code: number; stdout: string; stderr: string };
export type GitRunner = (
  cwd: string,
  args: string[],
  options?: {
    input?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    allowFailure?: boolean;
    readUserConfig?: boolean;
    ceiling?: string;
  },
) => Promise<GitResult>;
export type GhRunner = (
  args: string[],
  options: { cwd: string; input?: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<GitResult>;
type Repository = { owner: string; repo: string; url: string };
type Phase =
  'requested' | 'reverified' | 'executed' | 'readback' | 'failed' | 'scanned' | 'refused' | 'readback-mismatch';
type AuditFields = {
  op: string;
  repository?: string;
  remote?: string;
  branch?: string;
  sha?: string;
  number?: number;
  url?: string;
  method?: string;
  deleteBranch?: boolean;
  hits?: { rule: string; field: string; line: number }[];
  reason?: 'scan' | 'author' | 'window' | 'hold';
  readback?: Readback;
  commits?: number;
  paths?: number;
  field?: string;
};

export type PublishDeps = {
  directory: string;
  git?: GitRunner;
  gh?: GhRunner;
  approve?: (title: string, description: string) => Promise<'approved' | 'denied' | 'expired'>;
  /** Test injection. Production reads the remote URL and parses it. */
  repository?: Repository;
  /** Host-known common dir. A branch lane passes its record; otherwise the filesystem layout is used. */
  commonDirectory?: string;
  /** Host-decided Git paths this run may write. The common dir must not sit inside them. */
  gitWritePaths?: string[];
  /** Empty git/gh directories are created under this directory, never the process temp dir. */
  tmpRoot: string;
  lock?: <T>(operation: () => Promise<T>) => Promise<T>;
  audit?: (phase: Phase, fields: AuditFields) => void;
  signal?: AbortSignal;
  gates?: ProjectGates;
  now?: () => Date;
  commitLimit?: number;
  mergeHold?: (
    repo: string,
    pull: number,
    opts: { refresh: boolean; paths?: string[] },
  ) => Promise<{ refuse?: string; cardLine?: string } | undefined>;
};

const remoteName = /^[A-Za-z0-9][\w.-]*$/;
const shaText = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

function stripUrl(text: string, url?: string): string {
  let out = url ? text.split(url).join('[redacted]') : text;
  out = out.replace(/\b(?:https?|ssh|file):\/\/\S+/gi, '[redacted]');
  out = out.replace(/\bgit@\S+/gi, '[redacted]');
  return out;
}

async function empty<T>(root: string, operation: (cwd: string) => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(join(root, 'pugport-publish-'));
  try {
    return await operation(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function defaultGh(ceiling: string): GhRunner {
  return (args, options) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        'gh',
        args,
        {
          cwd: options.cwd,
          windowsHide: true,
          timeout: options.timeoutMs,
          maxBuffer: 1024 * 1024,
          signal: options.signal,
          env: {
            ...process.env,
            GIT_CEILING_DIRECTORIES: ceiling,
            GH_PROMPT_DISABLED: '1',
            GH_NO_UPDATE_NOTIFIER: '1',
            GH_PAGER: 'cat',
          },
        },
        (error, stdout, stderr) => {
          if (error && typeof error.code !== 'number') reject(error);
          else resolve({ code: error ? Number(error.code) : 0, stdout: String(stdout), stderr: String(stderr) });
        },
      );
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(options.input ?? '');
    });
}

function runners(deps: PublishDeps) {
  const ceiling = deps.tmpRoot;
  const git: GitRunner = (cwd, args, options) => (deps.git ?? hostGit)(cwd, args, { ...options, ceiling });
  return {
    git,
    gh: deps.gh ?? defaultGh(ceiling),
    lock: deps.lock ?? (<T>(operation: () => Promise<T>) => operation()),
  };
}

async function worktree(git: GitRunner, deps: PublishDeps) {
  const known = deps.commonDirectory ?? (await hostRepositoryCommon(deps.directory, deps.signal));
  const common = await assertPublishCommon(known, deps.directory, deps.gitWritePaths ?? []);
  const branch = await git(deps.directory, ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    signal: deps.signal,
    allowFailure: true,
  });
  if (branch.code !== 0 || !branch.stdout.trim()) throw new Error('当前不在具名分支上，未操作。');
  const name = branch.stdout.trim();
  validBranch(name);
  const head = (await git(deps.directory, ['rev-parse', 'HEAD'], { signal: deps.signal })).stdout.trim();
  if (!shaText.test(head)) throw new Error('当前不在具名分支上，未操作。');
  const claimed = (
    await git(deps.directory, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { signal: deps.signal })
  ).stdout.trim();
  const claimedReal = await realpath(claimed).catch(() => undefined);
  const same =
    !!claimedReal &&
    (process.platform === 'win32' ? claimedReal.toLowerCase() === common.toLowerCase() : claimedReal === common);
  if (!same) throw new Error('仓库的 Git 目录不在安全位置，未操作。');
  return { branch: name, head, common };
}

async function repositoryOf(
  git: GitRunner,
  deps: PublishDeps,
  remote: string,
  common: string,
): Promise<Repository & { email?: string }> {
  if (!remoteName.test(remote)) throw new Error('远程名称无效。');
  // Read as data: `--file` loads only this file and does not follow includes. One process for all three keys.
  const prefix = `remote.${remote}.`;
  const read = await empty(deps.tmpRoot, (cwd) =>
    git(
      cwd,
      [
        'config',
        '--file',
        join(common, 'config'),
        '--get-regexp',
        `^(${prefix.replaceAll('.', '\\.')}(pushurl|url)|user\\.email)$`,
      ],
      { signal: deps.signal, allowFailure: true },
    ),
  );
  // Later lines win, as with `--get`.
  const values = new Map<string, string>();
  for (const row of read.stdout.split(/\r?\n/)) {
    const space = row.indexOf(' ');
    if (space > 0) values.set(row.slice(0, space), row.slice(space + 1).trim());
  }
  const email = values.get('user.email') || undefined;
  if (deps.repository) return { ...deps.repository, email };
  const url = values.get(`${prefix}pushurl`) || values.get(`${prefix}url`);
  if (!url) throw new Error('远程地址不是 GitHub 仓库，未操作。');
  const parsed = githubRepository(url);
  if (!parsed) throw new Error('远程地址不是 GitHub 仓库，未操作。');
  return { ...parsed, url, email };
}

/** Network Git never loads a repository config: ls-remote runs with no repository at all. */
async function lsRemote(git: GitRunner, deps: PublishDeps, args: string[]) {
  return empty(deps.tmpRoot, (cwd) =>
    git(cwd, ['ls-remote', ...args], {
      timeoutMs: 30_000,
      signal: deps.signal,
      allowFailure: true,
      readUserConfig: true,
    }),
  );
}

/** Push from a fresh bare repo that borrows the real objects, so the checkout's config is never read. */
async function borrowedRepository<T>(
  git: GitRunner,
  deps: PublishDeps,
  common: string,
  operation: (cwd: string) => Promise<T>,
) {
  return empty(deps.tmpRoot, async (cwd) => {
    await git(cwd, ['init', '--quiet', '--bare', cwd], { signal: deps.signal });
    // One plain line: Git reads quoted alternates with backslash escapes.
    await writeFile(join(cwd, 'objects', 'info', 'alternates'), `${join(common, 'objects')}\n`);
    await copyFile(join(common, 'shallow'), join(cwd, 'shallow')).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    return operation(cwd);
  });
}

async function pushFromScratch(git: GitRunner, deps: PublishDeps, common: string, args: string[]) {
  return borrowedRepository(git, deps, common, (cwd) =>
    git(cwd, [`--git-dir=${cwd}`, 'push', ...args], {
      timeoutMs: 60_000,
      signal: deps.signal,
      allowFailure: true,
      readUserConfig: true,
    }),
  );
}

function configuredEmails(gates?: ProjectGates): string[] {
  return Array.isArray(gates?.commitAuthor?.emails)
    ? gates.commitAuthor.emails.filter((email): email is string => typeof email === 'string')
    : [];
}

async function newCommits(
  git: GitRunner,
  deps: PublishDeps,
  line: { head: string; common: string },
  heads: string,
  branch: string,
  url: string,
  remoteDefault?: string,
) {
  const entries = heads
    .split(/\r?\n/)
    .map((row) => /^([0-9a-f]{40,64})\trefs\/heads\/(.+)$/i.exec(row))
    .filter((row): row is RegExpExecArray => !!row);
  const branchTip = tipOf(heads, branch);
  const defaultTip = remoteDefault ? tipOf(heads, remoteDefault) : undefined;
  const allTips = [...new Set([branchTip, defaultTip, ...entries.map((e) => e[1])].filter((x): x is string => !!x))];
  const tips = allTips.slice(0, 2000);
  const limit = deps.commitLimit ?? 500;
  return borrowedRepository(git, deps, line.common, async (cwd) => {
    const run = (args: string[], input?: string) =>
      git(cwd, [`--git-dir=${cwd}`, ...args], { input, signal: deps.signal, allowFailure: true });
    const present = async (list: string[]) => {
      if (!list.length) return new Set<string>();
      const checked = await run(['cat-file', '--batch-check'], list.join('\n') + '\n');
      if (checked.code !== 0) throw new Error('无法核对远程提交。');
      return new Set(
        checked.stdout
          .split(/\r?\n/)
          .filter((row) => row && !row.endsWith(' missing'))
          .map((row) => row.split(' ')[0]),
      );
    };
    const local = await present(tips);
    // A merge on GitHub leaves the default tip off this machine. Fetch only it and this branch, from the
    // validated URL into this throwaway repo; local remote-tracking refs are agent-writable and never trusted.
    const wanted = [
      ...(defaultTip && !local.has(defaultTip) ? [remoteDefault!] : []),
      ...(branchTip && !local.has(branchTip) ? [branch] : []),
    ];
    if (wanted.length) {
      await git(
        cwd,
        [
          `--git-dir=${cwd}`,
          'fetch',
          '--quiet',
          '--no-tags',
          '--no-write-fetch-head',
          '--',
          url,
          ...wanted.map((name) => `refs/heads/${name}`),
        ],
        { timeoutMs: 60_000, signal: deps.signal, allowFailure: true, readUserConfig: true },
      );
      for (const tip of await present(tips.filter((tip) => !local.has(tip)))) local.add(tip);
    }
    const missingTips = allTips.length - tips.filter((tip) => local.has(tip)).length;
    const excluded = tips.filter((tip) => local.has(tip));
    const log = await run(
      ['log', '-z', '--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B', `--max-count=${limit + 1}`, '--stdin'],
      [line.head, ...excluded.map((tip) => `^${tip}`)].join('\n') + '\n',
    );
    if (log.code !== 0) throw new Error('无法读取待推提交。');
    const fields = log.stdout ? log.stdout.split('\0') : [];
    if (fields.length && (fields.pop() !== '' || fields.length % 6 !== 0)) throw new Error('无法解析待推提交。');
    const commits: NewCommit[] = [];
    for (let i = 0; i < fields.length; i += 6) {
      const [sha, authorName, authorEmail, committerName, committerEmail, message] = fields.slice(i, i + 6);
      if (
        !sha ||
        !shaText.test(sha) ||
        authorName === undefined ||
        authorEmail === undefined ||
        committerName === undefined ||
        committerEmail === undefined ||
        message === undefined
      )
        throw new Error('无法解析待推提交。');
      commits.push({ sha, authorName, authorEmail, committerName, committerEmail, message });
    }
    let base: string | undefined;
    if (defaultTip && local.has(defaultTip)) {
      const mergeBase = await run(['merge-base', line.head, defaultTip]);
      if (mergeBase.code === 0) base = mergeBase.stdout.trim();
    }
    if (!base && branchTip && local.has(branchTip)) base = branchTip;
    let paths: string[] = [];
    let pathsUnverified = !base;
    if (base) {
      const diff = await run(['diff-tree', '-z', '-r', '--name-only', '--no-commit-id', base, line.head]);
      if (diff.code !== 0) pathsUnverified = true;
      else {
        paths = diff.stdout.split('\0').filter(Boolean);
        if (paths.length > 5000) {
          paths = paths.slice(0, 5000);
          pathsUnverified = true;
        }
      }
    }
    return {
      commits: commits.slice(0, limit),
      commitsTruncated: commits.length > limit,
      paths,
      pathsUnverified,
      missingTips,
    };
  });
}

function tipOf(stdout: string, branch: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^([0-9a-f]{40,64})\trefs\/heads\/(.+)$/i.exec(line.trim());
    if (match && match[2] === branch) return match[1];
  }
}

function defaultBranchOf(stdout: string): string | undefined {
  const match = /^ref: refs\/heads\/(\S+)\tHEAD/m.exec(stdout);
  return match?.[1];
}

async function remoteTip(git: GitRunner, deps: PublishDeps, url: string, branch: string) {
  const result = await lsRemote(git, deps, ['--heads', '--', url, `refs/heads/${branch}`]);
  if (result.code !== 0) throw new Error(stripUrl(result.stderr || result.stdout || '无法读取远程分支。', url));
  return tipOf(result.stdout, branch);
}

function porcelain(stdout: string, stderr: string, branch: string, code: number) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.includes('\t') && line.includes('refs/heads/'));
  if (lines.length !== 1) {
    if (/non-fast-forward/i.test(`${stdout}\n${stderr}`))
      throw new Error('远程分支已前进，PugPort 不会强推；请在工作线里合并或变基后再推。');
    throw new Error(code === 0 ? '推送结果无法确认。' : stripUrl(stderr.trim() || '推送被拒绝。'));
  }
  const line = lines[0] ?? '';
  const dest = (line.split('\t')[1] ?? '').split(':').pop();
  if (dest !== `refs/heads/${branch}`) throw new Error('推送结果无法确认。');
  if (line.startsWith('!') || /non-fast-forward|\[rejected\]/i.test(line))
    throw new Error(
      /non-fast-forward|\[rejected\]/i.test(line)
        ? '远程分支已前进，PugPort 不会强推；请在工作线里合并或变基后再推。'
        : '推送被拒绝。',
    );
  if (line.startsWith('+') || line.startsWith('-')) throw new Error('推送结果无法确认。');
}

async function ghJson(deps: PublishDeps, gh: GhRunner, args: string[], timeoutMs: number) {
  const result = await empty(deps.tmpRoot, (cwd) => gh(args, { cwd, timeoutMs, signal: deps.signal }));
  if (result.code !== 0) throw new Error(stripUrl(result.stderr || result.stdout || 'gh 没有返回结果。'));
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function previewLines(body: string) {
  return body
    .split(/\r?\n/)
    .slice(0, 8)
    .map((line) => `│ ${line.slice(0, 200)}`);
}

function pullDrift(view: Record<string, unknown>, pinned: { head: string; branch: string; base: string }): string[] {
  const changed: string[] = [];
  if (String(view.state).toUpperCase() !== 'OPEN') changed.push(`状态 ${String(view.state)}`);
  if (view.isCrossRepository !== false) changed.push('跨仓库');
  if (String(view.headRefName) !== pinned.branch) changed.push(`头分支 ${String(view.headRefName)}`);
  if (String(view.baseRefName) !== pinned.base) changed.push(`基分支 ${String(view.baseRefName)}`);
  if (String(view.headRefOid).toLowerCase() !== pinned.head.toLowerCase())
    changed.push(`头提交 ${String(view.headRefOid)}`);
  return changed;
}

export async function pushBranch(input: { remote?: string }, deps: PublishDeps) {
  const remote = input.remote ?? 'origin';
  const { git, lock } = runners(deps);
  let url = '';
  let quiet = false;
  let repoName = '';
  let line = { branch: '', head: '', common: '' };
  try {
    deps.signal?.throwIfAborted();
    line = await worktree(git, deps);
    const repo = await repositoryOf(git, deps, remote, line.common);
    url = repo.url;
    repoName = `${repo.owner}/${repo.repo}`;
    const remoteHeads = await lsRemote(git, deps, ['--heads', '--', url]);
    if (remoteHeads.code !== 0)
      throw new Error(stripUrl(remoteHeads.stderr || remoteHeads.stdout || '无法读取远程分支。', url));
    const tip = tipOf(remoteHeads.stdout, line.branch);
    const sym = await lsRemote(git, deps, ['--symref', '--', url, 'HEAD']);
    const remoteDefault = sym.code === 0 ? defaultBranchOf(sym.stdout) : undefined;
    const collected = await newCommits(git, deps, line, remoteHeads.stdout, line.branch, url, remoteDefault);
    const email = repo.email;
    const missingNote = collected.missingTips
      ? `注意：远程 ${collected.missingTips} 个分支的最新提交不在本地，新提交数可能偏多。`
      : undefined;
    const withNote = (text: string) =>
      missingNote
        ? `${text}
${missingNote}`
        : text;
    const hits = collected.commits
      .flatMap((commit) =>
        scanOutbound([{ field: `commit ${commit.sha.slice(0, 7)}`, value: commit.message }], {
          allow: deps.gates?.text?.allow,
          block: deps.gates?.text?.block,
          allowEmails: [
            commit.authorEmail,
            commit.committerEmail,
            ...(email ? [email] : []),
            ...configuredEmails(deps.gates),
          ],
        }),
      )
      .concat(
        scanOutbound(
          collected.paths.map((path) => ({ field: 'path', value: path, only: ['record-file'] as RuleId[] })),
          { allow: deps.gates?.text?.allow, block: deps.gates?.text?.block },
        ),
      );
    const auditFields = { op: 'push', repository: repoName, remote, branch: line.branch, sha: line.head };
    deps.audit?.('scanned', {
      ...auditFields,
      hits: hits.map(({ rule, field, line }) => ({ rule, field, line })),
      commits: collected.commits.length,
      paths: collected.paths.length,
    });
    if (hits.length) {
      deps.audit?.('refused', { ...auditFields, reason: 'scan' });
      throw new Error(withNote(scanMessage(hits)));
    }
    const gate = decide(
      { op: 'push', repo: repoName, branch: line.branch, defaultBranch: remoteDefault, ...collected },
      deps.gates,
      deps.now?.() ?? new Date(),
    );
    if (gate.outcome === 'refuse') {
      deps.audit?.('refused', { ...auditFields, reason: 'author' });
      throw new Error(withNote(gate.error ?? ''));
    }
    const warning = !remoteDefault
      ? '注意：无法确认远程默认分支，按推默认分支处理。'
      : remoteDefault === line.branch
        ? `注意：${line.branch} 是远程默认分支。`
        : undefined;
    const requiredEmails = configuredEmails(deps.gates).map((email) => email.toLowerCase());
    const authorsMatch =
      !!deps.gates?.commitAuthor &&
      !collected.commitsTruncated &&
      collected.commits.every(
        (commit) =>
          requiredEmails.includes(commit.authorEmail.toLowerCase()) &&
          requiredEmails.includes(commit.committerEmail.toLowerCase()),
      );
    const description = [
      `仓库：${repoName}`,
      `远程：${remote}`,
      `分支：${line.branch} → refs/heads/${line.branch}`,
      `本地提交：${line.head}`,
      tip ? `远程当前：${tip}` : '远程没有这个分支，将新建。',
      '文本检查：通过',
      `提交：${collected.commits.length} 个新提交${authorsMatch ? '，作者均为项目配置身份' : ''}`,
      ...gate.cardLines,
      ...(missingNote ? [missingNote] : []),
      ...(warning ? [warning] : []),
      '不会强制推送；推送后会回读远程分支核对。',
    ].join('\n');
    const audit = (phase: Phase) =>
      deps.audit?.(phase, { op: 'push', repository: repoName, remote, branch: line.branch, sha: line.head });
    audit('requested');
    const decision = await (deps.approve ?? (async () => 'denied' as const))('推送分支到远程', description);
    if (decision !== 'approved') {
      quiet = true;
      throw new Error(decision === 'expired' ? '4.5 分钟内无人确认，未推送。' : '用户未同意推送。');
    }
    return await lock(async () => {
      const again = await worktree(git, deps);
      if (again.branch !== line.branch || again.head !== line.head)
        throw new Error('确认后工作线提交已变化，未推送；请重新发起。');
      audit('reverified');
      const pushed = await pushFromScratch(git, deps, line.common, [
        '--porcelain',
        '--no-follow-tags',
        '--no-recurse-submodules',
        '--',
        url,
        `${line.head}:refs/heads/${line.branch}`,
      ]);
      porcelain(pushed.stdout, pushed.stderr, line.branch, pushed.code);
      audit('executed');
      const after = await remoteTip(git, deps, url, line.branch);
      if (after?.toLowerCase() !== line.head.toLowerCase())
        throw new Error(`推送已报告成功，但远程分支与本地不一致：远程 ${after ?? '缺失'}，本地 ${line.head}。`);
      audit('readback');
      return {
        status: 'pushed' as const,
        repository: repoName,
        remote,
        branch: line.branch,
        sha: line.head,
        createdBranch: !tip,
      };
    });
  } catch (error) {
    if (!quiet)
      deps.audit?.('failed', {
        op: 'push',
        repository: repoName || undefined,
        remote,
        branch: line.branch || undefined,
        sha: line.head || undefined,
      });
    throw new Error(stripUrl(error instanceof Error ? error.message : String(error), url));
  }
}

export async function openBranchPullRequest(
  input: { base: string; title: string; body: string; draft?: boolean; remote?: string },
  deps: PublishDeps,
) {
  const remote = input.remote ?? 'origin';
  if (
    typeof input.title !== 'string' ||
    input.title.length > 256 ||
    typeof input.body !== 'string' ||
    input.body.length > 65536
  )
    throw new Error('PR 标题或正文超出长度。');
  if (/[\u0000-\u001F]/.test(input.title)) throw new Error('PR 标题含有控制字符，未创建。');
  validBranch(input.base);
  const { git, gh, lock } = runners(deps);
  let url = '';
  let quiet = false;
  let repoName = '';
  let line = { branch: '', head: '', common: '' };
  let mismatch = false;
  try {
    deps.signal?.throwIfAborted();
    line = await worktree(git, deps);
    const repo = await repositoryOf(git, deps, remote, line.common);
    url = repo.url;
    repoName = `${repo.owner}/${repo.repo}`;
    const email = repo.email;
    const hits = scanOutbound(
      [
        { field: 'title', value: input.title },
        { field: 'body', value: input.body },
      ],
      {
        allow: deps.gates?.text?.allow,
        block: deps.gates?.text?.block,
        allowEmails: [...(email ? [email] : []), ...configuredEmails(deps.gates)],
      },
    );
    const scanFields = { op: 'open', repository: repoName, remote, branch: line.branch, sha: line.head };
    deps.audit?.('scanned', { ...scanFields, hits: hits.map(({ rule, field, line }) => ({ rule, field, line })) });
    if (hits.length) {
      deps.audit?.('refused', { ...scanFields, reason: 'scan' });
      throw new Error(scanMessage(hits));
    }
    const tip = await remoteTip(git, deps, url, line.branch);
    if (tip?.toLowerCase() !== line.head.toLowerCase())
      throw new Error(`请先推送分支；远程 ${tip ?? '缺失'} 与本地 ${line.head} 不一致。`);
    const listed = await empty(deps.tmpRoot, (cwd) =>
      gh(
        [
          'pr',
          'list',
          '--repo',
          repoName,
          '--head',
          line.branch,
          '--state',
          'open',
          '--json',
          'number,url,headRefOid,isCrossRepository',
        ],
        { cwd, timeoutMs: 30_000, signal: deps.signal },
      ),
    );
    if (listed.code !== 0) throw new Error(stripUrl(listed.stderr || '无法读取已有 PR。', url));
    const rows = JSON.parse(listed.stdout) as Array<Record<string, unknown>>;
    const existing = rows.find(
      (row) => row.isCrossRepository === false && String(row.headRefOid).toLowerCase() === line.head.toLowerCase(),
    );
    if (existing)
      return {
        status: 'exists' as const,
        number: Number(existing.number),
        url: String(existing.url),
        repository: repoName,
        headSha: String(existing.headRefOid),
      };
    const description = [
      `仓库：${repoName}`,
      `${input.base} ← ${line.branch}（提交 ${line.head}）`,
      `标题：${input.title}`,
      '文本检查：通过',
      '正文前几行：',
      ...previewLines(input.body),
      input.draft ? '草稿：是' : '草稿：否',
    ].join('\n');
    deps.audit?.('requested', { op: 'open', repository: repoName, remote, branch: line.branch, sha: line.head });
    const decision = await (deps.approve ?? (async () => 'denied' as const))('创建 Pull Request', description);
    if (decision !== 'approved') {
      quiet = true;
      throw new Error(decision === 'expired' ? '4.5 分钟内无人确认，未创建 PR。' : '用户未同意创建 PR。');
    }
    return await lock(async () => {
      const again = await worktree(git, deps);
      const againTip = await remoteTip(git, deps, url, again.branch);
      if (
        again.branch !== line.branch ||
        again.head !== line.head ||
        againTip?.toLowerCase() !== line.head.toLowerCase()
      )
        throw new Error('确认后工作线提交已变化，未创建 PR；请重新发起。');
      deps.audit?.('reverified', { op: 'open', repository: repoName, remote, branch: line.branch, sha: line.head });
      const created = await empty(deps.tmpRoot, (cwd) =>
        gh(
          [
            'pr',
            'create',
            '--repo',
            repoName,
            '--base',
            input.base,
            '--head',
            line.branch,
            '--title',
            input.title,
            '--body-file',
            '-',
            ...(input.draft ? ['--draft'] : []),
          ],
          { cwd, input: input.body, timeoutMs: 60_000, signal: deps.signal },
        ),
      );
      if (created.code !== 0) throw new Error(stripUrl(created.stderr || created.stdout || '创建 PR 失败。', url));
      const number = Number(/\/pull\/(\d+)/.exec(created.stdout)?.[1]);
      if (!number) throw new Error('创建 PR 后没有得到编号。');
      deps.audit?.('executed', {
        op: 'open',
        repository: repoName,
        remote,
        branch: line.branch,
        sha: line.head,
        number,
      });
      let view: Record<string, unknown> | undefined;
      try {
        const response = await ghJson(
          deps,
          gh,
          [
            'pr',
            'view',
            String(number),
            '--repo',
            repoName,
            '--json',
            'number,url,headRefOid,headRefName,baseRefName,isCrossRepository,title,body',
          ],
          30_000,
        );
        if (response && typeof response === 'object' && !Array.isArray(response)) view = response;
      } catch {
        // The PR was already created; a read failure must not invite another creation.
      }
      if (
        !view ||
        typeof view.isCrossRepository !== 'boolean' ||
        typeof view.headRefName !== 'string' ||
        typeof view.baseRefName !== 'string' ||
        typeof view.headRefOid !== 'string'
      ) {
        const prUrl = `https://github.com/${repoName}/pull/${number}`;
        deps.audit?.('readback', {
          op: 'open',
          repository: repoName,
          remote,
          branch: line.branch,
          sha: line.head,
          number,
          url: prUrl,
          readback: 'unverified',
        });
        return {
          status: 'opened' as const,
          number,
          url: prUrl,
          readback: 'unverified' as const,
          repository: repoName,
          headSha: line.head,
        };
      }
      if (
        view.isCrossRepository !== false ||
        view.headRefName !== line.branch ||
        view.baseRefName !== input.base ||
        String(view.headRefOid).toLowerCase() !== line.head.toLowerCase()
      )
        throw new Error('创建后回读与请求不一致，请先核对远程 PR。');
      const prUrl = `https://github.com/${repoName}/pull/${number}`;
      const titleReadback = compareText(input.title, view.title);
      const bodyReadback = compareText(input.body, view.body);
      const badField = titleReadback === 'mismatch' ? '标题' : bodyReadback === 'mismatch' ? '正文' : undefined;
      if (badField) {
        deps.audit?.('readback-mismatch', {
          op: 'open',
          repository: repoName,
          remote,
          branch: line.branch,
          sha: line.head,
          number,
          url: prUrl,
          readback: 'mismatch',
          field: badField,
        });
        mismatch = true;
        throw new Error(
          `已创建 PR #${number}，但回读的${badField}与请求不符：${prUrl}。请勿重复创建；先核对远程内容。`,
        );
      }
      const readback: Readback = titleReadback === 'match' && bodyReadback === 'match' ? 'match' : 'unverified';
      deps.audit?.('readback', {
        op: 'open',
        repository: repoName,
        remote,
        branch: line.branch,
        sha: line.head,
        number,
        url: prUrl,
        readback,
      });
      return { status: 'opened' as const, number, url: prUrl, readback, repository: repoName, headSha: line.head };
    });
  } catch (error) {
    if (!quiet)
      deps.audit?.('failed', {
        op: 'open',
        repository: repoName || undefined,
        remote,
        branch: line.branch || undefined,
        sha: line.head || undefined,
      });
    throw new Error(
      mismatch
        ? error instanceof Error
          ? error.message
          : String(error)
        : stripUrl(error instanceof Error ? error.message : String(error), url),
    );
  }
}

export async function mergeBranchPullRequest(
  input: { number: number; expected_head_sha: string; method?: 'squash' | 'merge' | 'rebase'; delete_branch?: boolean },
  deps: PublishDeps,
) {
  const method = input.method ?? 'squash';
  if (!Number.isInteger(input.number) || input.number < 1) throw new Error('PR 编号无效。');
  if (!shaText.test(input.expected_head_sha)) throw new Error('PR 头提交无效。');
  if (!['squash', 'merge', 'rebase'].includes(method)) throw new Error('合并方式无效。');
  const remote = 'origin';
  const { git, gh, lock } = runners(deps);
  let url = '';
  let quiet = false;
  let repoName = '';
  let line = { branch: '', head: '', common: '' };
  const expected = input.expected_head_sha;
  try {
    deps.signal?.throwIfAborted();
    line = await worktree(git, deps);
    const repo = await repositoryOf(git, deps, remote, line.common);
    url = repo.url;
    repoName = `${repo.owner}/${repo.repo}`;
    if (line.head.toLowerCase() !== expected.toLowerCase())
      throw new Error(`工作线 HEAD ${line.head} 领先 PR 头 ${expected}；请先推送后再合并。`);
    const windowGate = decide({ op: 'merge', repo: repoName, paths: [] }, deps.gates, deps.now?.() ?? new Date());
    if (windowGate.outcome === 'refuse') {
      deps.audit?.('refused', { op: 'merge', repository: repoName, number: input.number, reason: 'window' });
      throw new Error(windowGate.error);
    }
    const checkHold = async (refresh: boolean, paths?: string[]) => {
      const hold = await deps.mergeHold?.(repoName, input.number, { refresh, paths });
      if (hold?.refuse) {
        deps.audit?.('refused', { op: 'merge', repository: repoName, number: input.number, reason: 'hold' });
        throw new Error(hold.refuse);
      }
      return hold?.cardLine;
    };
    await checkHold(true);
    const viewOf = () =>
      ghJson(
        deps,
        gh,
        [
          'pr',
          'view',
          String(input.number),
          '--repo',
          repoName,
          '--json',
          'state,title,headRefOid,headRefName,baseRefName,isCrossRepository,reviewDecision,statusCheckRollup,mergeCommit,files',
        ],
        30_000,
      );
    const before = await viewOf();
    const pinned = { head: expected, branch: line.branch, base: String(before.baseRefName) };
    if (pullDrift(before, pinned).length)
      throw new Error(`PR #${input.number} 的头分支、状态或提交与请求不符，未合并。`);
    const check = counts(before.statusCheckRollup);
    const files = Array.isArray(before.files) ? before.files : undefined;
    const paths =
      files
        ?.map((file) => (file && typeof file === 'object' ? (file as { path?: unknown }).path : undefined))
        .filter((path): path is string => typeof path === 'string') ?? [];
    const holdLine = await checkHold(false, paths);
    const pathGate = decide(
      { op: 'merge', repo: repoName, paths, pathsUnverified: !files || paths.length !== files.length },
      deps.gates,
      deps.now?.() ?? new Date(),
    );
    const title = String(before.title ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    const description = [
      `PR #${input.number}：${title}`,
      `${pinned.base} ← ${line.branch}（提交 ${expected}）`,
      `方式：${method}`,
      `检查：${check.passed} 通过，${check.failed} 失败，${check.pending} 未完成`,
      `评审：${String(before.reviewDecision ?? '无')}`,
      ...pathGate.cardLines,
      ...(holdLine ? [holdLine] : []),
      input.delete_branch ? `远程分支：合并后删除 ${line.branch}（这是删除操作）。` : '远程分支：合并后保留。',
      '确认后立即合并；若 PR 头提交在确认后变化，不会合并。',
    ].join('\n');
    deps.audit?.('requested', {
      op: 'merge',
      repository: repoName,
      remote,
      branch: line.branch,
      sha: expected,
      number: input.number,
      method,
      deleteBranch: input.delete_branch === true,
    });
    const decision = await (deps.approve ?? (async () => 'denied' as const))('合并 Pull Request', description);
    if (decision !== 'approved') {
      quiet = true;
      throw new Error(decision === 'expired' ? '4.5 分钟内无人确认，未合并。' : '用户未同意合并。');
    }
    await checkHold(true);
    return await lock(async () => {
      await checkHold(false);
      const again = await viewOf();
      const changed = pullDrift(again, pinned);
      if (changed.length) throw new Error(`确认后 PR 已变化，未合并。${changed.join('、')}`);
      deps.audit?.('reverified', {
        op: 'merge',
        repository: repoName,
        remote,
        branch: line.branch,
        sha: expected,
        number: input.number,
        method,
        deleteBranch: input.delete_branch === true,
      });
      const merged = await empty(deps.tmpRoot, (cwd) =>
        gh(
          [
            'pr',
            'merge',
            String(input.number),
            '--repo',
            repoName,
            `--${method}`,
            '--match-head-commit',
            expected,
            ...(input.delete_branch ? ['--delete-branch'] : []),
          ],
          { cwd, timeoutMs: 120_000, signal: deps.signal },
        ),
      );
      if (merged.code !== 0) throw new Error(stripUrl(merged.stderr || merged.stdout || '合并失败。', url));
      deps.audit?.('executed', {
        op: 'merge',
        repository: repoName,
        remote,
        branch: line.branch,
        sha: expected,
        number: input.number,
        method,
        deleteBranch: input.delete_branch === true,
      });
      const after = await ghJson(
        deps,
        gh,
        ['pr', 'view', String(input.number), '--repo', repoName, '--json', 'state,mergeCommit'],
        30_000,
      );
      const mergeCommit =
        after.mergeCommit && typeof after.mergeCommit === 'object'
          ? String((after.mergeCommit as { oid?: string }).oid ?? '')
          : '';
      if (String(after.state).toUpperCase() !== 'MERGED' || !mergeCommit) throw new Error('合并后回读未确认已合并。');
      deps.audit?.('readback', {
        op: 'merge',
        repository: repoName,
        remote,
        branch: line.branch,
        sha: expected,
        number: input.number,
        method,
        deleteBranch: input.delete_branch === true,
      });
      return {
        status: 'merged' as const,
        number: input.number,
        repository: repoName,
        mergeCommit,
        method,
        deletedBranch: input.delete_branch === true,
      };
    });
  } catch (error) {
    if (!quiet)
      deps.audit?.('failed', {
        op: 'merge',
        repository: repoName || undefined,
        remote,
        branch: line.branch || undefined,
        sha: expected,
        number: input.number,
        method,
        deleteBranch: input.delete_branch === true,
      });
    throw new Error(stripUrl(error instanceof Error ? error.message : String(error), url));
  }
}
