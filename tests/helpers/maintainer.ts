import type { Gh } from '../../src/server/maintainer/gh.ts';
import type { WorkspaceStore } from '../../src/server/workspace-store.ts';
import type { OutboxItem } from '../../src/server/maintainer/outbox.ts';

export const sha = 'a'.repeat(40),
  baseSha = 'b'.repeat(40),
  mergeBaseSha = 'd'.repeat(40),
  blobSha = 'c'.repeat(40);
export const stamp = '2026-10-28T12:00:00.000Z';
export function fakeGh(answer: (args: string[], input?: string) => unknown) {
  const calls: { args: string[]; input?: string }[] = [];
  const gh: Gh = {
    async run(args, options) {
      calls.push({ args, input: options?.input });
      const value = await answer(args, options?.input);
      return { code: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' };
    },
    async text(args, options) {
      const reply = await gh.run(args, options);
      if (reply.code) throw new Error(reply.stderr);
      return reply.stdout;
    },
    async json(schema, args, options) {
      return schema.parse(JSON.parse(await gh.text(args, options)));
    },
  };
  return { gh, calls };
}
export function memoryStore(): Pick<WorkspaceStore, 'get' | 'list' | 'save'> {
  const rows = new Map<string, { owner: string; value: unknown }>();
  return {
    get<T>(kind: string, id: string) {
      return structuredClone(rows.get(`${kind}:${id}`)?.value) as T | undefined;
    },
    list<T>(kind: string, owner?: string, limit = 100) {
      return [...rows]
        .filter(([key, row]) => key.startsWith(kind + ':') && (!owner || row.owner === owner))
        .slice(0, limit)
        .map(([, row]) => structuredClone(row.value) as T);
    },
    save(kind: string, id: string, owner: string, value: unknown) {
      rows.set(`${kind}:${id}`, { owner, value: structuredClone(value) });
    },
  };
}
export function card(extra: Partial<OutboxItem> = {}): OutboxItem {
  return {
    id: 'card-20261028-12345678',
    kind: 'merge',
    mode: 'live',
    number: 7,
    title: 'Synthetic PR',
    url: 'https://github.com/o/r/pull/7',
    author: 'contributor',
    external: false,
    tier: 'code',
    judgedSha: sha,
    baseRef: 'main',
    verdict: 'pass',
    reasons: [],
    createdAt: stamp,
    ...extra,
  };
}
export function pullFixture() {
  const files = [
    { filename: 'src/widget.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ patch' },
    {
      filename: 'src/new.ts',
      previous_filename: 'src/old.ts',
      status: 'renamed',
      additions: 1,
      deletions: 0,
      patch: '@@ rename',
    },
    { filename: 'image.png', status: 'modified', additions: 0, deletions: 0, patch: null },
  ];
  const view = {
    number: 7,
    url: 'https://github.com/o/r/pull/7',
    title: 'Synthetic PR',
    body: 'Synthetic description',
    author: { login: 'contributor' },
    isCrossRepository: false,
    isDraft: false,
    state: 'OPEN',
    labels: [] as { name: string }[],
    baseRefName: 'main',
    baseRefOid: baseSha,
    headRefName: 'feature',
    headRefOid: sha,
    additions: 2,
    deletions: 1,
    changedFiles: 3,
    statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    files: files.map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions })),
  };
  const tree = {
    truncated: false,
    tree: ['src/widget.ts', 'src/old.ts', 'tests/widget.test.ts', 'tests/widget-extra.test.ts'].map((path, i) => ({
      path,
      type: 'blob',
      sha: (i + 1).toString().repeat(40),
      size: 30,
    })),
  };
  const fixture = {
    view,
    files,
    tree,
    mergeBaseSha,
    diff: 'diff --git a/src/widget.ts b/src/widget.ts\n-old\n+new\n+LAST-DIFF-LINE',
    blobs: new Map(tree.tree.map((entry) => [entry.sha, `Base text for ${entry.path}`])),
  };
  const fake = fakeGh((args) => {
    if (args[0] === 'pr' && args[1] === 'view') return fixture.view;
    if (args[1] === `repos/o/r/compare/${baseSha}...${sha}`)
      return args.includes('Accept: application/vnd.github.diff')
        ? fixture.diff
        : { merge_base_commit: { sha: fixture.mergeBaseSha }, files: fixture.files, total_commits: 1 };
    if (args[1] === `repos/o/r/git/trees/${mergeBaseSha}?recursive=1`) return fixture.tree;
    if (args[1]?.startsWith('repos/o/r/git/blobs/')) {
      const content = fixture.blobs.get(args[1].split('/').at(-1)!);
      if (content === undefined) throw new Error('Unknown blob');
      return content;
    }
    throw new Error(`Unexpected fake gh call: ${args.join(' ')}`);
  });
  return { ...fake, fixture };
}
export function mergeFixture() {
  const view = {
    state: 'OPEN',
    isDraft: false,
    headRefOid: sha,
    baseRefName: 'main',
    isCrossRepository: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    labels: [] as { name: string }[],
    title: 'Synthetic PR',
    files: [{ path: 'src/widget.ts' }],
  };
  const data = {
    view,
    rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci' }] } }],
    merged: { state: 'MERGED', mergeCommit: { oid: blobSha } },
    ruleError: false,
  };
  return {
    data,
    ...fakeGh((args) => {
      if (args[1] === 'view') return args.at(-1) === 'state,mergeCommit' ? data.merged : data.view;
      if (args[0] === 'api') {
        if (data.ruleError) throw new Error('rules unavailable');
        return data.rules;
      }
      if (args[1] === 'merge') return '';
      throw new Error('Unexpected fake gh call');
    }),
  };
}
