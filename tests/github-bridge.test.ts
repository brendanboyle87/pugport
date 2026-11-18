import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubConnection } from '../src/server/github.ts';
import { readBridge } from './helpers/read-bridge.ts';
import type { TestContext } from 'node:test';
import type { ProjectGates } from '../src/shared/types.ts';
import type { Workspace } from '../src/server/workspace.ts';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';

// Every stored task has its input; the bridge reads its work mode before gated tools run.
const syntheticInput = { content: 'Synthetic', mode: 'build', permissionMode: 'workspace-write' };

async function writeFixture(
  t: TestContext,
  approved = true,
  defaultBranch: string | undefined = 'main',
  gates?: ProjectGates,
) {
  const token = 'SYNTHETIC_GH_TOKEN';
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const approvals: any[][] = [];
  let lookups = 0;
  const readbacks = new Map<string, unknown>();
  let result: unknown = { number: 12, id: 42, object: { sha: 'a'.repeat(40) } };
  const github = new GitHubConnection({
    enabled: () => true,
    tokenSource: async () => ({ token }),
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) {
        lookups++;
        return Response.json({ default_branch: defaultBranch });
      }
      return readbacks.has(path) ? Response.json(readbacks.get(path)) : new Response('', { status: 404 });
    },
    connect: () => ({
      listTools: async () =>
        [
          'list_issues',
          'create_pull_request',
          'merge_pull_request',
          'delete_file',
          'actions_run_trigger',
          'issue_write',
          'push_files',
          'create_or_update_file',
          'pull_request_review_write',
          'add_issue_comment',
        ].map((name) => ({ name, description: 'fixture', readOnly: name === 'list_issues' })),
      callTool: async (name, args) => {
        calls.push({ name, args });
        return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
      },
      close: async () => {},
    }),
  });
  t.after(() => github.close());
  await github.setEnabled(true);
  const workspace = gates
    ? ({
        store: {
          get: (kind: string) => (kind === 'workflow' ? { projectId: 'project', input: syntheticInput } : { gates }),
        },
      } as unknown as Workspace)
    : undefined;
  const f = readBridge(t, process.cwd(), github, workspace);
  if (gates) f.caller.run.workflowId = 'workflow';
  f.controller.approve = async (...args) => {
    approvals.push(args);
    return approved;
  };
  f.controller.retainMutation = () => {
    throw new Error('GitHub must not lock local files');
  };
  return {
    ...f,
    calls,
    approvals,
    token,
    lookups: () => lookups,
    readbacks,
    setResult: (value: unknown) => {
      result = value;
    },
  };
}

for (const approved of [false, true])
  test(`deferred GitHub writes retain their exact owner confirmation: ${approved}`, async (t) => {
    const f = await writeFixture(t, approved);
    Object.assign(f.caller, { write: true, deferredTools: true });
    assert.ok(!(await f.list()).tools.some((tool: { name: string }) => tool.name.startsWith('github_')));
    const search = await f.call('search_tools', { names: ['github_delete_file'] });
    assert.equal(JSON.parse(search.content[0].text).tools[0].name, 'github_delete_file');
    const args = { owner: 'synthetic', repo: 'fixture', path: 'fixture.txt', branch: 'test' };
    const result = await f.call('call_tool', { name: 'github_delete_file', arguments: args });
    assert.equal(result.isError, !approved);
    assert.equal(f.approvals.length, 1);
    assert.equal(f.approvals[0]![4].requireUser, true);
    assert.equal(f.calls.length, approved ? 1 : 0);
    assert.ok(
      f.events.some((event) => event.data?.tool === 'github_delete_file' && event.data?.dispatchedVia === 'call_tool'),
    );
  });

test('read-only caller cannot list or call write tools', async (t) => {
  const f = await writeFixture(t);
  assert.deepEqual(
    (await f.list()).tools.filter((tool: any) => tool.name.startsWith('github_')).map((tool: any) => tool.name),
    ['github_list_issues'],
  );
  const result = await f.call('github_create_pull_request', { owner: 'other-owner', repo: 'public-repo' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /只读任务不能写入 GitHub/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.approvals.length, 0);
});

test('write tasks auto-create PRs and comments on other repositories without a local lock', async (t) => {
  const f = await writeFixture(t);
  f.caller.write = true;
  const tool = (await f.list()).tools.find((tool: any) => tool.name === 'github_create_pull_request');
  assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  for (const name of ['create_pull_request', 'add_issue_comment']) {
    const args = { owner: 'other-owner', repo: 'public-repo', title: 'Synthetic PR', body: 'Synthetic comment' };
    assert.equal((await f.call('github_' + name, args)).isError, false);
    assert.deepEqual(f.calls.at(-1), { name, args });
  }
  assert.equal(f.approvals.length, 0);
  assert.equal(f.lookups(), 0);
});

for (const [name, extra] of [
  ['merge_pull_request', { pullNumber: 12 }],
  ['delete_file', { path: 'fixture.txt', branch: 'feat/x' }],
  ['actions_run_trigger', { method: 'run_workflow' }],
  ['issue_write', { method: 'update', state: 'closed', issue_number: 12 }],
  ['pull_request_review_write', { event: 'APPROVE', pullNumber: 12 }],
  [
    'push_files',
    { branch: 'main', files: [{ path: 'fixture.txt', content: 'FILE_CONTENT' }], message: 'Synthetic commit' },
  ],
  [
    'create_or_update_file',
    { branch: 'main', path: 'fixture.txt', content: 'FILE_CONTENT', message: 'Synthetic commit' },
  ],
] as [string, Record<string, unknown>][])
  for (const approved of [true, false])
    test(`${name} requires owner confirmation: ${approved}`, async (t) => {
      const f = await writeFixture(t, approved);
      f.caller.write = true;
      const args = { owner: 'synthetic', repo: 'fixture', ...extra };
      const result = await f.call('github_' + name, args);
      assert.equal(result.isError, !approved);
      assert.equal(f.calls.length, approved ? 1 : 0);
      assert.equal(f.approvals.length, 1);
      const approval = f.approvals[0]!;
      assert.equal(approval[4].requireUser, true);
      assert.equal(approval[4].timeoutMs, 270_000);
      assert.equal(approval[3], f.caller.signal);
      assert.match(approval[2], /synthetic\/fixture/);
      assert.ok(approval[2].includes(name));
      assert.ok(!approval[2].includes(f.token));
      assert.ok(!approval[2].includes('FILE_CONTENT'));
      if (extra.message) {
        assert.ok(approval[2].includes('Synthetic commit'));
        assert.ok(approval[2].includes('fixture.txt'));
      }
      if (!approved) assert.match(result.content[0].text, /用户未同意 GitHub 写入/);
    });

test('file writes resolve each supplied branch and ask on lookup failure or missing branch', async (t) => {
  const f = await writeFixture(t);
  f.caller.write = true;
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await f.call('github_push_files', { owner: 'synthetic', repo: 'fixture', branch: 'feat/x' })).isError,
      false,
    );
  assert.equal(f.lookups(), 2);
  assert.equal(f.approvals.length, 0);
  assert.equal((await f.call('github_push_files', { owner: 'synthetic', repo: 'fixture' })).isError, false);
  assert.equal(f.approvals.length, 1);
  assert.equal(f.lookups(), 2);
  assert.equal(
    (await f.call('github_push_files', { owner: '../invalid', repo: 'fixture', branch: 'feat/x' })).isError,
    false,
  );
  assert.equal(f.approvals.length, 2);
});

test('failed branch lookup asks, and a large file preview is truncated without rejecting the call', async (t) => {
  const f = await writeFixture(t, true, '');
  f.caller.write = true;
  const args = {
    owner: 'synthetic',
    repo: 'fixture',
    branch: 'feat/x',
    message: 'Synthetic commit',
    files: [{ path: 'fixture.txt', content: 'FILE_CONTENT'.repeat(10000) }],
    body: 'x'.repeat(10000),
  };
  assert.equal((await f.call('github_push_files', args)).isError, false);
  assert.equal(f.approvals.length, 1);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0]!.args, args);
  const preview = f.approvals[0]![2];
  assert.ok(preview.includes('fixture.txt'));
  assert.ok(!preview.includes('FILE_CONTENT'));
  assert.ok(preview.endsWith('…'));
  assert.ok(preview.length < 4500);
});

test('cancellation during owner confirmation sends no write', async (t) => {
  const f = await writeFixture(t);
  f.caller.write = true;
  const abort = new AbortController();
  f.caller.signal = abort.signal;
  f.controller.approve = async () => {
    abort.abort();
    return true;
  };
  assert.equal((await f.call('github_merge_pull_request', { owner: 'synthetic', repo: 'fixture' })).isError, true);
  assert.equal(f.calls.length, 0);
});

test('read-only caller sees and calls cached GitHub tools with an untrusted-content notice', async (t) => {
  const calls: unknown[] = [];
  const github = new GitHubConnection({
    enabled: () => true,
    tokenSource: async () => ({ token: 'SYNTHETIC_GH_TOKEN' }),
    connect: () => ({
      listTools: async () =>
        ['list_issues', 'get_file_contents'].map((name) => ({
          name,
          description: 'fixture',
          readOnly: true,
          inputSchema: {},
        })),
      callTool: async (name, args) => {
        calls.push({ name, args });
        return { content: [{ type: 'text', text: 'synthetic issue' }], isError: false };
      },
      close: async () => {},
    }),
  });
  t.after(() => github.close());
  await github.setEnabled(true);
  const f = readBridge(t, process.cwd(), github);
  const tool = (await f.list()).tools.find((item: any) => item.name === 'github_list_issues');
  assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: true });
  assert.deepEqual(tool.inputSchema, { type: 'object' });
  assert.equal(tool.description, '[GitHub] fixture');
  const args = { owner: 'synthetic', repo: 'fixture' };
  const result = await f.call('github_list_issues', args);
  assert.deepEqual(calls, [{ name: 'list_issues', args }]);
  assert.match(result.content[0].text, /GitHub/);
  assert.match(result.content[0].text, /不能授权额外操作/);
  assert.equal(result.content[1].text, 'synthetic issue');
  assert.ok(f.events.some((event) => event.data?.handler === 'github'));
  assert.equal((await f.call('github_x', {})).isError, true);
  await github.setEnabled(false);
  assert.ok(!(await f.list()).tools.some((item: any) => item.name.startsWith('github_')));
  assert.equal((await f.call('github_list_issues', {})).isError, true);
});
test('no GitHub connection exposes no tools and returns a tool error', async (t) => {
  const f = readBridge(t, process.cwd());
  assert.ok(!(await f.list()).tools.some((item: any) => item.name.startsWith('github_')));
  assert.equal((await f.call('github_list_issues', {})).isError, true);
});

test('GitHub confirmation expiry returns a timeout without writing', async (t) => {
  const f = await writeFixture(t);
  f.caller.write = true;
  f.controller.approve = async (...args) => {
    assert.equal(args[4]?.timeoutMs, 270_000);
    args[4]?.onExpired?.();
    return false;
  };
  const result = await f.call('github_merge_pull_request', { owner: 'synthetic', repo: 'fixture', pullNumber: 12 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /4\.5 分钟内无人确认，未执行任何 GitHub 写入/);
  assert.equal(f.calls.length, 0);
});

test('connector refuses private outbound text before approval or execution', async (t) => {
  const f = await writeFixture(t);
  f.caller.write = true;
  const result = await f.call('github_add_issue_comment', { owner: 'o', repo: 'r', body: 'C:\\Users\\x\\notes.md' });
  assert.equal(result.isError, true);
  assert.equal(f.calls.length, 0);
  assert.equal(f.approvals.length, 0);
  assert.ok(f.events.some((event) => event.data?.phase === 'refused' && event.data?.reason === 'scan'));
});

test('connector readback distinguishes match, mismatch and unavailable results', async (t) => {
  const f = await writeFixture(t);
  f.caller.write = true;
  const args = { owner: 'o', repo: 'r', title: 'Synthetic PR', body: 'Synthetic body' };
  f.readbacks.set('/repos/o/r/pulls/12', { title: args.title, body: args.body });
  assert.equal((await f.call('github_create_pull_request', args)).isError, false);
  assert.equal(f.lookups(), 0);
  assert.ok(f.events.some((event) => event.data?.phase === 'readback' && event.data?.readback === 'match'));
  f.readbacks.set('/repos/o/r/pulls/12', { title: args.title, body: 'Changed' });
  const mismatch = await f.call('github_create_pull_request', args);
  assert.equal(mismatch.isError, true);
  assert.match(mismatch.content[0].text, /请勿重复提交/);
  assert.match(mismatch.content[0].text, /\/repos\/o\/r\/pulls\/12/);
  assert.ok(f.events.some((event) => event.data?.phase === 'readback-mismatch'));
  f.setResult({});
  const noId = await f.call('github_create_pull_request', args);
  assert.equal(noId.isError, false);
  assert.match(noId.content[0].text, /回读未能核对/);
  f.setResult({ number: 13 });
  const noFetch = await f.call('github_create_pull_request', args);
  assert.equal(noFetch.isError, false);
  assert.match(noFetch.content[0].text, /回读未能核对/);
  assert.ok(f.events.some((event) => event.data?.phase === 'readback' && event.data?.readback === 'unverified'));
});

for (const mode of ['missing-method', 'throws', 'missing-field'] as const)
  test(`connector reports unverified when readback is unavailable: ${mode}`, async (t) => {
    let reads = 0;
    const github = {
      tools: () => [{ name: 'create_pull_request', description: 'fixture', readOnly: false }],
      defaultBranch: async () => 'main',
      call: async () => ({
        content: [{ type: 'text' as const, text: JSON.stringify({ number: 12 }) }],
        isError: false,
      }),
      ...(mode === 'missing-method'
        ? {}
        : {
            fetchJson: async () => {
              reads++;
              if (mode === 'throws') throw new Error('synthetic read failure');
              return { title: 'Synthetic PR' };
            },
          }),
    };
    const f = readBridge(t, process.cwd(), github);
    f.caller.write = true;
    const result = await f.call('github_create_pull_request', {
      owner: 'o',
      repo: 'r',
      title: 'Synthetic PR',
      body: 'Synthetic body',
    });
    assert.equal(result.isError, false);
    assert.match(result.content[0].text, /回读未能核对.*请勿重复提交/);
    assert.match(result.content[1].text, /以下内容来自 GitHub/);
    assert.equal(reads, mode === 'missing-method' ? 0 : 1);
    assert.ok(f.events.some((event) => event.data?.phase === 'readback' && event.data?.readback === 'unverified'));
  });

test('connector records no readback when no readback mapping exists', async (t) => {
  const f = await writeFixture(t);
  f.caller.write = true;
  const result = await f.call('github_pull_request_review_write', {
    owner: 'o',
    repo: 'r',
    event: 'COMMENT',
    body: 'Synthetic review',
  });
  assert.equal(result.isError, false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.approvals.length, 0);
  assert.ok(!f.events.some((event) => event.data?.phase === 'readback'));
});

test('connector refuses a present non-string text value before approval or write', async (t) => {
  const f = await writeFixture(t);
  f.caller.write = true;
  const result = await f.call('github_create_pull_request', { owner: 'o', repo: 'r', body: { value: 'bad' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /外发文本检查器出错/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.approvals.length, 0);
});

test('connector adds confirmation for protected paths and branches without changing other writes', async (t) => {
  const f = await writeFixture(t);
  f.caller.write = true;
  const call = (branch: string, path: string) =>
    f.call('github_push_files', {
      owner: 'o',
      repo: 'r',
      branch,
      message: 'Synthetic commit',
      files: [{ path, content: 'ordinary' }],
    });
  assert.equal((await call('feat/x', 'db/migrations/1.sql')).isError, false);
  assert.match(f.approvals.at(-1)![2], /必问/);
  assert.equal((await call('feat/x', 'src/a.ts')).isError, false);
  assert.equal(f.approvals.length, 1);
  for (const branch of ['develop', 'refs/heads/develop']) assert.equal((await call(branch, 'src/a.ts')).isError, false);
  assert.equal(f.approvals.length, 3);
  f.readbacks.set('/repos/o/r/git/commits/' + 'a'.repeat(40), { message: 'Changed' });
  const mismatch = await call('feat/x', 'src/a.ts');
  assert.equal(mismatch.isError, true);
  assert.match(mismatch.content[0].text, /请勿重复提交/);
});

test('configured identity and merge window refuse connector writes before confirmation', async (t) => {
  const f = await writeFixture(t, true, 'main', { version: 1, commitAuthor: { emails: ['owner@example.test'] } });
  f.caller.write = true;
  const result = await f.call('github_push_files', {
    owner: 'o',
    repo: 'r',
    branch: 'feature',
    message: 'Synthetic commit',
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /gh 账号/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.approvals.length, 0);
  const now = new Date();
  const minute = now.getHours() * 60 + now.getMinutes();
  const time = (value: number) =>
    `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  const g = await writeFixture(t, true, 'main', {
    version: 1,
    windows: { noMerge: { from: time((minute + 1439) % 1440), to: time((minute + 2) % 1440) } },
  });
  g.caller.write = true;
  const merge = await g.call('github_merge_pull_request', { owner: 'o', repo: 'r', pullNumber: 12 });
  assert.equal(merge.isError, true);
  assert.match(merge.content[0].text, /不合并/);
  assert.equal(g.calls.length, 0);
  assert.equal(g.approvals.length, 0);
});

test('connector checks file contents only for secrets and paths for record names', async (t) => {
  const f = await writeFixture(t);
  f.caller.write = true;
  const call = (path: string, content: string) =>
    f.call('github_push_files', {
      owner: 'o',
      repo: 'r',
      branch: 'feat/x',
      message: 'Synthetic commit',
      files: [{ path, content }],
    });
  assert.equal((await call('src/a.txt', 'ghp_' + 'a'.repeat(36))).isError, true);
  assert.equal((await call('src/a.txt', 'C:\\Users\\x\\notes.md')).isError, false);
  assert.equal((await call('coordinator-handover-2.md', 'ordinary')).isError, true);
  assert.equal(f.calls.length, 1);
});

test('commit_branch scans the message before creating a local commit', async (t) => {
  let commits = 0;
  const workspace = {
    store: {
      get: (kind: string) =>
        kind === 'workflow' ? { projectId: 'project', input: syntheticInput } : { gates: { version: 1 } },
    },
    takeNotices: () => [],
    commitBranch: async () => {
      commits++;
      return { committed: true };
    },
  } as unknown as Workspace;
  const f = readBridge(t, process.cwd(), undefined, workspace);
  f.caller.write = true;
  f.caller.run.workflowId = 'workflow';
  const refused = await f.call('commit_branch', { message: 'C:\\Users\\x\\notes.md' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /外发文本检查未通过/);
  assert.equal(commits, 0);
  const clean = await f.call('commit_branch', { message: 'Synthetic commit' });
  assert.notEqual(clean.isError, true, JSON.stringify(clean));
  assert.equal(commits, 1);
});

test('commit_branch permits the worktree identity while retaining other scan hits', async (t) => {
  let commits = 0;
  const workspace = {
    store: {
      get: (kind: string) =>
        kind === 'workflow'
          ? {
              projectId: 'project',
              input: syntheticInput,
              executionWorkspace: { mode: 'branch', state: 'ready', directory: process.cwd() },
            }
          : { gates: { version: 1 } },
    },
    takeNotices: () => [],
    commitBranch: async () => {
      commits++;
      return { committed: true };
    },
  } as unknown as Workspace;
  const mock = t.mock.method(childProcess, 'execFile', ((...args: unknown[]) => {
    const argv = args[1] as string[];
    assert.ok(argv.includes('user.email'));
    const callback = args.at(-1) as (error: null, stdout: Buffer, stderr: Buffer) => void;
    const child = Object.assign(new EventEmitter(), { stdin: Object.assign(new EventEmitter(), { end() {} }) });
    queueMicrotask(() => callback(null, Buffer.from('owner@example.test\n'), Buffer.alloc(0)));
    return child;
  }) as typeof childProcess.execFile);
  syncBuiltinESMExports();
  try {
    const f = readBridge(t, process.cwd(), undefined, workspace);
    f.caller.write = true;
    f.caller.run.workflowId = 'workflow';
    const accepted = await f.call('commit_branch', { message: 'Signed-off-by: Owner <owner@example.test>' });
    assert.notEqual(accepted.isError, true, JSON.stringify(accepted));
    assert.equal(commits, 1);
    const refused = await f.call('commit_branch', { message: 'owner@example.test other@example.invalid' });
    assert.equal(refused.isError, true);
    assert.equal(commits, 1);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});
