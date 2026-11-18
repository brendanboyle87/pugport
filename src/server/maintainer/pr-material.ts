import { z } from 'zod';
import { countChecks } from '../../shared/lane-github.ts';
import { repositorySchema } from './config.ts';
import type { Gh } from './gh.ts';
import { pathsFromFiles } from './tiers.ts';

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const count = z.number().int().nonnegative();
const fileStatus = z.enum(['added', 'modified', 'removed', 'renamed', 'copied', 'changed', 'unchanged']);
const restFileSchema = z.object({
  filename: z.string().min(1),
  previous_filename: z.string().nullish(),
  status: fileStatus,
  additions: count,
  deletions: count,
  patch: z.string().nullish(),
});
const compareSchema = z.object({
  merge_base_commit: z.object({ sha }),
  files: z.array(restFileSchema),
  total_commits: count,
});
const viewSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().url(),
  title: z.string(),
  body: z.string(),
  author: z.object({ login: z.string(), is_bot: z.boolean().optional() }),
  isCrossRepository: z.boolean(),
  isDraft: z.boolean(),
  state: z.string(),
  labels: z.array(z.object({ name: z.string() })),
  baseRefName: z.string(),
  baseRefOid: sha,
  headRefName: z.string(),
  headRefOid: sha,
  additions: count,
  deletions: count,
  changedFiles: count,
  statusCheckRollup: z.array(z.record(z.string(), z.unknown())).nullable(),
  files: z.array(z.object({ path: z.string(), additions: count, deletions: count })),
});
export type PrFile = {
  path: string;
  previousPath?: string;
  status: z.infer<typeof fileStatus>;
  additions: number;
  deletions: number;
  binary: boolean;
  baseText?: string;
  baseOmitted?: 'too-large' | 'binary' | 'budget' | 'missing';
};
export type PrMaterial = {
  repository: string;
  number: number;
  url: string;
  title: string;
  body: string;
  author: string;
  authorIsBot: boolean;
  isCrossRepository: boolean;
  isDraft: boolean;
  state: string;
  labels: string[];
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  diff: string;
  diffBytes: number;
  files: PrFile[];
  paths: string[];
  pathsTruncated: boolean;
  relatedTests: { path: string; text: string }[];
  checks: ReturnType<typeof countChecks>;
  omitted: string[];
};
export type BlockedMaterial = { blocked: string; paths: string[]; pathsTruncated: boolean };
export const materialLimits = {
  maxDiffBytes: 300_000,
  maxChangedFiles: 60,
  maxChangedLines: 6_000,
  maxBaseFileBytes: 120_000,
  maxBodyBytes: 20_000,
  maxRelatedTests: 8,
  maxRelatedTestBytes: 60_000,
  maxPromptBytes: 400_000,
} as const;
type Limits = { [K in keyof typeof materialLimits]: number };
const treeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(z.object({ path: z.string(), type: z.string(), sha, size: count.optional() })),
});
const trees = new WeakMap<Gh, Map<string, { at: number; tree: z.infer<typeof treeSchema> }>>();
export const pullViewFields = Object.keys(viewSchema.shape).join(',');
export async function fetchPullMaterial(
  gh: Gh,
  repository: string,
  number: number,
  limits: Limits = materialLimits,
  signal?: AbortSignal,
): Promise<PrMaterial | BlockedMaterial> {
  repositorySchema.parse(repository);
  z.number().int().positive().parse(number);
  const options = { signal };
  const view = await gh.json(
    viewSchema,
    ['pr', 'view', String(number), '--repo', repository, '--json', pullViewFields],
    options,
  );
  if (view.number !== number) throw new Error('GitHub returned another pull request');
  const endpoint = `repos/${repository}/compare/${view.baseRefOid}...${view.headRefOid}`;
  // If compare fails, metadata paths are only a conservative, incomplete fallback for tiering.
  let paths = pathsFromFiles(
    view.files.map((file) => ({ filename: file.path })),
    Infinity,
  );
  const blocked = (reason: string): BlockedMaterial => ({ blocked: reason, ...paths });
  const tooLarge = (error: unknown) => /maxBuffer|too large|diff[^\n]*exceed|\bHTTP\s+(406|422)\b/i.test(String(error));
  const unavailableDiff = 'too large for a no-tools review: GitHub could not return the diff';
  let comparison: z.infer<typeof compareSchema>;
  try {
    comparison = await gh.json(compareSchema, ['api', endpoint], options);
  } catch (error) {
    if (tooLarge(error)) return blocked(unavailableDiff);
    throw error;
  }
  const files = comparison.files.map((file) => ({ ...file, previous_filename: file.previous_filename ?? undefined }));
  paths = pathsFromFiles(files, files.length >= 300 ? Infinity : files.length);
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const lines = additions + deletions;
  if (files.length > limits.maxChangedFiles || lines > limits.maxChangedLines)
    return blocked(
      `too large for a no-tools review: ${files.length} files, ${lines} changed lines (limits ${limits.maxChangedFiles} files / ${limits.maxChangedLines} lines)`,
    );
  if (paths.pathsTruncated) return blocked('Incomplete GitHub file list; cannot review without tools');
  let diff: string;
  try {
    diff = await gh.text(['api', endpoint, '-H', 'Accept: application/vnd.github.diff'], options);
  } catch (error) {
    if (tooLarge(error)) return blocked(unavailableDiff);
    throw error;
  }
  const diffBytes = Buffer.byteLength(diff);
  if (diffBytes > limits.maxDiffBytes)
    return blocked(
      `too large for a no-tools review: diff is ${Math.ceil(diffBytes / 1000)} kB (limit ${limits.maxDiffBytes / 1000} kB)`,
    );
  const cache = trees.get(gh) ?? new Map<string, { at: number; tree: z.infer<typeof treeSchema> }>();
  trees.set(gh, cache);
  for (const [key, value] of cache) if (Date.now() - value.at >= 600_000) cache.delete(key);
  const baseSha = comparison.merge_base_commit.sha;
  const key = `${repository}@${baseSha}`;
  let tree = cache.get(key)?.tree;
  if (!tree) {
    tree = await gh.json(treeSchema, ['api', `repos/${repository}/git/trees/${baseSha}?recursive=1`], options);
    cache.set(key, { at: Date.now(), tree });
  }
  const blobs = new Map(
    (tree.truncated ? [] : tree.tree).filter((entry) => entry.type === 'blob').map((entry) => [entry.path, entry]),
  );
  const contents = async (path: string, max: number): Promise<{ text?: string; omitted?: 'missing' | 'too-large' }> => {
    const blob = blobs.get(path);
    if (!blob) return { omitted: 'missing' };
    if (blob.size !== undefined && blob.size > max) return { omitted: 'too-large' };
    const result = await gh.run(
      ['api', `repos/${repository}/git/blobs/${blob.sha}`, '-H', 'Accept: application/vnd.github.raw'],
      options,
    );
    if (result.code !== 0) {
      if (/\b404\b/.test(result.stderr)) return { omitted: 'missing' };
      throw new Error('Could not read base blob from GitHub');
    }
    return Buffer.byteLength(result.stdout) > max ? { omitted: 'too-large' } : { text: result.stdout };
  };
  const materialFiles: PrFile[] = [];
  for (const file of files) {
    const binary = file.patch == null;
    const item: PrFile = {
      path: file.filename,
      previousPath: file.previous_filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      binary,
    };
    if (tree.truncated) item.baseOmitted = 'missing';
    else if (binary) item.baseOmitted = 'binary';
    else if (file.status !== 'added') {
      const content = await contents(file.previous_filename ?? file.filename, limits.maxBaseFileBytes);
      item.baseText = content.text;
      item.baseOmitted = content.omitted;
    }
    materialFiles.push(item);
  }
  const relatedTests: PrMaterial['relatedTests'] = [];
  const omitted: string[] = tree.truncated ? ['Base tree truncated; base files and related tests unavailable'] : [];
  const names = materialFiles
    .filter((f) => /^src\/.*\.tsx?$/.test(f.path))
    .map((f) =>
      f.path
        .split('/')
        .at(-1)!
        .replace(/\.tsx?$/, ''),
    )
    .filter((name) => /^[A-Za-z0-9_.-]{1,80}$/.test(name));
  const changed = new Set(paths.paths);
  const candidates = [...blobs.keys()]
    .filter(
      (path) =>
        !changed.has(path) &&
        path.startsWith('tests/') &&
        !path.slice(6).includes('/') &&
        names.some(
          (name) =>
            path.slice(6) === `${name}.test.ts` ||
            path.slice(6).endsWith(`-${name}.test.ts`) ||
            (path.slice(6).startsWith(`${name}-`) && path.endsWith('.test.ts')),
        ),
    )
    .sort();
  for (const path of candidates.slice(0, limits.maxRelatedTests)) {
    const content = await contents(path, limits.maxRelatedTestBytes);
    if (content.text !== undefined) relatedTests.push({ path, text: content.text });
    else omitted.push(`RELATED TEST ${path}: ${content.omitted}`);
  }
  for (const path of candidates.slice(limits.maxRelatedTests)) omitted.push(`RELATED TEST ${path}: budget`);
  // Content is pinned; recheck that the metadata still describes the same review.
  const fresh = await gh.json(
    z.object({ headRefOid: sha, baseRefOid: sha, baseRefName: z.string() }),
    ['pr', 'view', String(number), '--repo', repository, '--json', 'headRefOid,baseRefOid,baseRefName'],
    options,
  );
  if (
    fresh.headRefOid !== view.headRefOid ||
    fresh.baseRefOid !== view.baseRefOid ||
    fresh.baseRefName !== view.baseRefName
  )
    return blocked('Pull request changed while collecting material; a new review is required');
  return {
    repository,
    number,
    url: view.url,
    title: view.title,
    body: view.body,
    author: view.author.login,
    authorIsBot: view.author.is_bot === true || view.author.login.endsWith('[bot]'),
    isCrossRepository: view.isCrossRepository,
    isDraft: view.isDraft,
    state: view.state,
    labels: view.labels.map((l) => l.name),
    baseRef: view.baseRefName,
    baseSha,
    headRef: view.headRefName,
    headSha: view.headRefOid,
    additions,
    deletions,
    changedFiles: files.length,
    diff,
    diffBytes,
    files: materialFiles,
    ...paths,
    relatedTests,
    omitted,
    checks: countChecks(view.statusCheckRollup),
  };
}
