import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { countLines, excludedPath, runSize, type ChangedFile, type SizeEvent } from '../scripts/pr-size.mjs';
import type { Api, Comment } from '../scripts/issue-lifecycle.mjs';

const repo = 'pugport/pugport';
const sha = 'a'.repeat(40);
const nextSha = 'b'.repeat(40);
const bot = { login: 'github-actions[bot]', type: 'Bot' };
const file = (filename: string, additions = 300, deletions = 201): ChangedFile => ({ filename, additions, deletions });

test('exact exclusions cover locks, generated output and catalogs without hiding runtime sources', () => {
  for (const path of [
    'package-lock.json',
    'nested/yarn.lock',
    'npm-shrinkwrap.json',
    'pnpm-lock.yaml',
    'bun.lock',
    'bun.lockb',
    'dist/app.js',
    'release/app.js',
    'coverage/a.json',
    'node_modules/a.ts',
    '.runtime/a.js',
    'src/a.generated.ts',
    'ui/app.min.js',
    'ui/style.min.css',
    'src/a.ts.map',
    'src/shared/i18n/en.json',
  ])
    assert.equal(excludedPath(path), true, path);
  for (const path of [
    'src/ui/i18n.ts',
    'src/shared/i18n/format.ts',
    'src/shared/i18n/nested/manual.json',
    'scripts/i18n-extract.mjs',
    'src/generated-utils.ts',
    'src/types.d.ts',
    'docs/decisions/a.md',
    'tests/size.test.ts',
    '.github/workflows/ci.yml',
    'vendor/source.ts',
    'src/dist/source.ts',
    'src/lock.json',
    'package.json',
  ])
    assert.equal(excludedPath(path), false, path);
});

test('count additions plus deletions and do not hide source by renaming into excluded paths', () => {
  const counts = countLines([
    file('src/a.ts'),
    file('package-lock.json', 900, 100),
    { ...file('dist/moved.ts', 10, 10), previous_filename: 'src/moved.ts' },
  ]);
  assert.deepEqual(counts, { total: 1521, excluded: 1000, counted: 521, excludedFiles: ['package-lock.json'] });
  assert.equal(countLines([{ ...file('src/moved.ts'), previous_filename: 'dist/moved.ts' }]).counted, 501);
  assert.throws(() => countLines([file('src/b.ts', -1, 0)]), /Invalid/);
});

class FakeGitHub implements Api {
  repo = repo;
  pr = { number: 1, head: { sha }, state: 'open', changed_files: 1, labels: [] as { name: string }[] };
  files = [file('src/a.ts')];
  comments: Comment[] = [];
  writes: { method: string; path: string; body: any }[] = [];
  headChangesDuringCount = false;
  reads = 0;
  async list(path: string): Promise<any[]> {
    if (path.endsWith('/files')) return structuredClone(this.files);
    if (path.endsWith('/comments')) return structuredClone(this.comments);
    throw new Error(`Unexpected list ${path}`);
  }
  async request(method: string, path: string, body?: any): Promise<any> {
    if (method === 'GET') {
      this.reads++;
      if (this.headChangesDuringCount && this.reads > 1) this.pr.head.sha = nextSha;
      return structuredClone(this.pr);
    }
    this.writes.push({ method, path, body });
    if (path === '/issues/1/labels') {
      for (const name of body.labels) this.pr.labels.push({ name });
      return;
    }
    if (path.startsWith('/issues/1/labels/')) {
      this.pr.labels = this.pr.labels.filter((label) => label.name !== decodeURIComponent(path.split('/').at(-1)!));
      return;
    }
    if (path === '/issues/1/comments') {
      const comment = { id: this.comments.length + 1, user: bot, body: body.body };
      this.comments.push(comment);
      return structuredClone(comment);
    }
    if (path.startsWith('/issues/comments/')) {
      const target = this.comments.find((comment) => comment.id === Number(path.split('/').at(-1)))!;
      target.body = body.body;
      return structuredClone(target);
    }
    throw new Error(`Unexpected mutation ${method} ${path}`);
  }
  event(): SizeEvent {
    return {
      repository: { full_name: repo },
      pull_request: structuredClone(this.pr),
    };
  }
  run() {
    return runSize(this, this.event(), '');
  }
}

test('500 counted lines stays within the advisory threshold', async () => {
  const api = new FakeGitHub();
  api.files = [file('src/a.ts', 300, 200), file('package-lock.json', 900, 100)];
  api.pr.changed_files = 2;
  assert.deepEqual(await api.run(), { large: false });
  assert.deepEqual(api.pr.labels, []);
  assert.match(api.comments[0].body, /Counted: \*\*500\*\*/);
  assert.match(api.comments[0].body, /Total: 1500; excluded: 1000/);
  assert.match(api.comments[0].body, /Within the advisory threshold/);
});

test('larger PRs report without failing; reruns are idempotent and small PRs clear large', async () => {
  const api = new FakeGitHub();
  assert.deepEqual(await api.run(), { large: true });
  assert.ok(api.pr.labels.some((label) => label.name === 'size:large'));
  assert.match(api.comments[0].body, /Counted: \*\*501\*\*/);
  assert.match(api.comments[0].body, /Above the advisory threshold/);
  assert.match(api.comments[0].body, /Size alone does not fail this check or require an owner waiver/);
  const writes = api.writes.length;
  assert.deepEqual(await api.run(), { large: true });
  assert.equal(api.writes.length, writes);
  assert.equal(api.comments.length, 1);
  api.files = [file('src/a.ts', 5, 1)];
  api.pr.head.sha = nextSha;
  assert.deepEqual(await api.run(), { large: false });
  assert.ok(!api.pr.labels.some((label) => label.name === 'size:large'));
  assert.equal(api.comments.length, 1);
  assert.match(api.comments[0].body, new RegExp(nextSha));
  assert.match(api.comments[0].body, /Counted: \*\*6\*\*/);
});

test('historical waiver labels and malformed or edited records are ignored and preserved', async () => {
  const api = new FakeGitHub();
  api.pr.labels = [{ name: 'size:waived' }];
  const historical: Comment = {
    id: 1,
    user: bot,
    body: '<!-- pugport-size-waiver-v1 {} -->',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-02T00:00:00Z',
  };
  api.comments = [structuredClone(historical)];
  assert.deepEqual(await api.run(), { large: true });
  assert.deepEqual(api.comments[0], historical);
  assert.equal(api.comments.length, 2);
  assert.deepEqual(api.pr.labels, [{ name: 'size:waived' }, { name: 'size:large' }]);
  assert.ok(api.writes.every((write) => !JSON.stringify(write).includes('size:waived')));
});

test('contributor comments cannot impersonate the bot size report', async () => {
  const api = new FakeGitHub();
  const forged: Comment = { id: 1, user: { login: 'eve', type: 'User' }, body: '<!-- pugport-pr-size-v1 -->' };
  api.comments = [structuredClone(forged)];
  await api.run();
  assert.deepEqual(api.comments[0], forged);
  assert.equal(api.comments.length, 2);
  assert.equal(api.comments[1].user?.login, bot.login);
  const writes = api.writes.length;
  await api.run();
  assert.equal(api.writes.length, writes);
});

test('incomplete pagination and concurrent pushes fail safely before any metadata writes', async () => {
  const api = new FakeGitHub();
  api.pr.changed_files = 3001;
  await assert.rejects(api.run(), /Incomplete/);
  assert.equal(api.writes.length, 0);
  api.pr.changed_files = 1;
  api.headChangesDuringCount = true;
  api.reads = 0;
  await assert.rejects(api.run(), /head changed/);
  assert.equal(api.writes.length, 0);
  await assert.rejects(
    runSize(api, { ...api.event(), repository: { full_name: 'other/repo' } }, ''),
    /Unexpected repository/,
  );
  assert.equal(api.writes.length, 0);
});

test('all GitHub workflows pin external actions to full 40-character commit SHAs', () => {
  const pinnedAction = /^(?:-\s+)?uses:\s+[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}\s+#\s*v?\d[\w.-]*$/;
  assert.doesNotMatch(`uses: actions/checkout@${'a'.repeat(40)}`, pinnedAction);
  const workflowsDir = resolve(import.meta.dirname, '..', '.github', 'workflows');
  const files = readdirSync(workflowsDir).filter((name) => /\.ya?ml$/i.test(name));
  assert.ok(files.length >= 4);
  for (const name of files) {
    const content = readFileSync(join(workflowsDir, name), 'utf8');
    const usesLines = content
      .split(/\r?\n/)
      .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
      .filter(({ line }) => /^(?:-\s+)?uses:\s*/.test(line));
    assert.ok(usesLines.length >= 1, `${name} should contain at least one action reference`);
    for (const { line, lineNumber } of usesLines) {
      assert.match(line, pinnedAction, `${name}:${lineNumber} must pin action to a 40-char commit SHA: ${line}`);
    }
  }
});
