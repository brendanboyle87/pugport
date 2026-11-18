import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpExtension } from '../src/shared/extensions.ts';
import {
  GitHubConnection,
  ghTokenSource,
  githubMcpUrl,
  githubToolsets,
  githubNeedsApproval,
} from '../src/server/github.ts';
import { McpConnection } from '../src/server/mcp-client.ts';
import { listenForFetch } from './helpers/fetch-port.ts';

const token = 'SYNTHETIC_GH_TOKEN';
for (const [name, args, branch, expected] of [
  ['update_issue', { state: 'closed' }, undefined, true],
  ...['run_workflow', 'delete_workflow_run_logs', 'assign_copilot_to_issue', 'unknown_write'].map((name) => [
    name,
    {},
    undefined,
    true,
  ]),
  ...['merge_pull_request', 'delete_file', 'create_repository', 'fork_repository'].map((name) => [
    name,
    {},
    undefined,
    true,
  ]),
  ...['run_workflow', 'rerun_workflow_run', 'rerun_failed_jobs', 'cancel_workflow_run', 'delete_workflow_run_logs'].map(
    (method) => ['actions_run_trigger', { method }, undefined, true],
  ),
  ...['push_files', 'create_or_update_file'].flatMap((name) => [
    ...['refs/heads/main', 'heads/main', ' main', 'MAIN', '', '   ', 123, ['feat/x']].map((branch) => [
      name,
      { branch },
      'main',
      true,
    ]),
    [name, { branch: 'main' }, 'refs/heads/MAIN', true],
    [name, { branch: 'main' }, 'main', true],
    [name, { branch: 'feat/x' }, 'main', false],
    [name, {}, 'main', true],
    [name, { branch: 'feat/x' }, undefined, true],
  ]),
  ['issue_write', { method: 'create' }, undefined, false],
  ['issue_write', { method: 'update', title: 'New title' }, undefined, false],
  ['issue_write', { method: 'update', state: 'closed' }, undefined, true],
  ['issue_write', { state: 'open' }, undefined, true],
  ['issue_write', { duplicate_of: 12 }, undefined, true],
  ['update_pull_request', { state: 'closed' }, undefined, true],
  ['update_pull_request', { state: 'open' }, undefined, true],
  ['update_pull_request', { title: 'New title' }, undefined, false],
  ['pull_request_review_write', { event: 'APPROVE' }, undefined, true],
  ['pull_request_review_write', { event: 'approve' }, undefined, true],
  ['pull_request_review_write', { event: 'COMMENT' }, undefined, false],
  ['pull_request_review_write', { event: 'REQUEST_CHANGES' }, undefined, false],
  ...[
    'create_branch',
    'create_pull_request',
    'add_issue_comment',
    'add_comment_to_pending_review',
    'add_reply_to_pull_request_comment',
    'update_issue_comment',
    'sub_issue_write',
    'update_pull_request_branch',
  ].map((name) => [name, {}, undefined, false]),
] as [string, Record<string, unknown>, string | undefined, boolean][])
  test(`approval tier: ${name} ${JSON.stringify(args)} default=${branch}`, () => {
    assert.equal(githubNeedsApproval(name, args, branch), expected);
  });

test('default branch lookup validates the repo, sends the token without redirects, and never caches', async (t) => {
  const requests: { url: unknown; options?: RequestInit }[] = [];
  let branch = 'main';
  const github = new GitHubConnection({
    enabled: () => true,
    tokenSource: async () => ({ token }),
    connect: () => ({
      listTools: async () => [],
      callTool: async () => ({ content: [], isError: false }),
      close: async () => {},
    }),
    fetch: async (url, options) => {
      requests.push({ url, options });
      return Response.json({ default_branch: branch });
    },
  });
  t.after(() => github.close());
  await github.setEnabled(true);
  const args = { owner: 'synthetic-owner', repo: 'fixture.repo' };
  assert.equal(await github.defaultBranch(args), 'main');
  branch = 'trunk';
  assert.equal(await github.defaultBranch(args), 'trunk');
  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.url, 'https://api.github.com/repos/synthetic-owner/fixture.repo');
  assert.deepEqual(requests[0]!.options!.headers, { Authorization: 'Bearer ' + token });
  assert.equal(requests[0]!.options!.redirect, 'error');
  for (const invalid of [{ owner: '../other' }, { repo: 'repo?x' }, { owner: '' }, { repo: 1 }, { owner: 'a/b' }])
    assert.equal(await github.defaultBranch({ ...args, ...invalid }), undefined);
  assert.equal(requests.length, 2);
  assert.ok(!JSON.stringify(await github.status()).includes(token));
});

test('fetchJson reads valid repository paths and rejects unsafe paths', async (t) => {
  const requests: { url: unknown; options?: RequestInit }[] = [];
  const github = new GitHubConnection({
    enabled: () => true,
    tokenSource: async () => ({ token }),
    connect: () => ({
      listTools: async () => [],
      callTool: async () => ({ content: [], isError: false }),
      close: async () => {},
    }),
    fetch: async (url, options) => {
      requests.push({ url, options });
      return Response.json({ title: 'Synthetic PR' });
    },
  });
  t.after(() => github.close());
  await github.setEnabled(true);
  assert.deepEqual(await github.fetchJson('/repos/o/r/pulls/1'), { title: 'Synthetic PR' });
  assert.equal(requests[0]?.url, 'https://api.github.com/repos/o/r/pulls/1');
  assert.equal(requests[0]?.options?.redirect, 'error');
  assert.deepEqual(requests[0]?.options?.headers, {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
  });
  assert.equal(await github.fetchJson('/user'), undefined);
  assert.equal(await github.fetchJson('/repos/o/r/../../user'), undefined);
  assert.equal(requests.length, 1);
});

for (const mode of ['http', 'throw', 'json'])
  test('fetchJson returns undefined on failure: ' + mode, async (t) => {
    const github = new GitHubConnection({
      enabled: () => true,
      tokenSource: async () => ({ token }),
      connect: () => ({
        listTools: async () => [],
        callTool: async () => ({ content: [], isError: false }),
        close: async () => {},
      }),
      fetch: async () => {
        if (mode === 'throw') throw new Error('synthetic failure');
        return new Response('invalid', { status: mode === 'http' ? 403 : 200 });
      },
    });
    t.after(() => github.close());
    await github.setEnabled(true);
    assert.equal(await github.fetchJson('/repos/o/r/pulls/1'), undefined);
  });

for (const mode of ['http', 'throw', 'json', 'missing', 'empty'])
  test('default branch lookup failure asks without exposing token: ' + mode, async (t) => {
    const github = new GitHubConnection({
      enabled: () => true,
      tokenSource: async () => ({ token }),
      connect: () => ({
        listTools: async () => [],
        callTool: async () => ({ content: [], isError: false }),
        close: async () => {},
      }),
      fetch: async () => {
        if (mode === 'throw') throw new Error(token);
        if (mode === 'http') return new Response(token, { status: 403 });
        if (mode === 'json') return new Response('invalid ' + token);
        return Response.json(mode === 'empty' ? { default_branch: '' } : {});
      },
    });
    t.after(() => github.close());
    await github.setEnabled(true);
    const args = { owner: 'synthetic', repo: 'fixture', branch: 'feat/x' };
    const branch = await github.defaultBranch(args);
    assert.equal(branch, undefined);
    assert.equal(githubNeedsApproval('push_files', args, branch), true);
    assert.ok(!JSON.stringify(await github.status()).includes(token));
  });
function fixture(enabled = true, failures: number[] = []) {
  const configs: McpExtension[] = [],
    calls: unknown[] = [];
  let tokens = 0,
    closes = 0;
  const github = new GitHubConnection({
    enabled: () => enabled,
    tokenSource: async () => {
      tokens++;
      return { token, login: 'octocat' };
    },
    connect: (config) => {
      configs.push(config);
      return {
        listTools: async () => [
          { name: 'list_issues', description: 'Read issues', readOnly: true },
          { name: 'write_issue', description: 'Write', readOnly: false },
        ],
        callTool: async (name, args) => {
          calls.push({ name, args });
          const status = failures.shift();
          if (status) throw Object.assign(new Error('HTTP ' + status), { status });
          return { content: [{ type: 'text', text: 'fixture result' }], isError: false };
        },
        close: async () => {
          closes++;
        },
      };
    },
  });
  return {
    github,
    configs,
    calls,
    setEnabled: (on: boolean) => {
      enabled = on;
      return github.setEnabled(on);
    },
    tokens: () => tokens,
    closes: () => closes,
  };
}
test('off does not read credentials or connect; enabling caches read and write tools', async () => {
  const f = fixture(false);
  assert.deepEqual(f.github.tools(), []);
  assert.deepEqual(await f.github.status(), { enabled: false, state: 'off' });
  assert.equal(f.tokens(), 0);
  assert.equal(f.configs.length, 0);
  const status = await f.setEnabled(true);
  assert.equal(status.state, 'connected');
  assert.equal(status.login, 'octocat');
  assert.ok(!('readOnly' in status));
  assert.ok(!JSON.stringify(status).includes(token));
  assert.equal(f.configs[0]!.url, 'https://api.githubcopilot.com/mcp/');
  assert.equal(f.configs[0]!.url, githubMcpUrl);
  assert.deepEqual(f.configs[0]!.headers, { Authorization: 'Bearer ' + token, 'X-MCP-Toolsets': githubToolsets });
  assert.equal(f.configs[0]!.source, 'github');
  assert.deepEqual(f.github.toolNames(false), ['github_list_issues']);
  const args = { owner: 'synthetic', repo: 'fixture' };
  await f.github.call('list_issues', args);
  assert.equal((f.calls[0] as any).args, args);
  assert.equal((f.calls[0] as any).name, 'list_issues');
  assert.deepEqual(f.github.toolNames(true), ['github_list_issues', 'github_write_issue']);
  assert.deepEqual(
    f.github.tools().map(({ readOnly }) => readOnly),
    [true, false],
  );
  await f.github.call('write_issue', {});
  await f.setEnabled(false);
  assert.ok(f.closes() > 0);
  assert.deepEqual(f.github.tools(), []);
  assert.equal((await f.github.status()).login, undefined);
  await assert.rejects(f.github.call('list_issues', {}));
});
for (const phase of ['call', 'reconnect', 'closed-reconnect'])
  test('upstream errors cannot echo the in-memory token: ' + phase, async (t) => {
    let lists = 0;
    const github = new GitHubConnection({
      enabled: () => true,
      tokenSource: async () => ({ token }),
      connect: () => ({
        listTools: async () => {
          if (++lists > 1) {
            if (phase === 'closed-reconnect') await github.close();
            throw new Error('Request header: Bearer ' + token);
          }
          return [{ name: 'list_issues', description: '', readOnly: true }];
        },
        callTool: async () => {
          throw Object.assign(new Error('Request header: Bearer ' + token), {
            status: phase === 'call' ? 500 : 404,
          });
        },
        close: async () => {},
      }),
    });
    t.after(() => github.close());
    await github.setEnabled(true);
    await assert.rejects(github.call('list_issues', {}), (error: any) => {
      assert.ok(!String(error).includes(token));
      assert.ok(!JSON.stringify(error).includes(token));
      return true;
    });
  });
test('tools and status return cached values while connection initialization waits', async () => {
  let finish!: (value: any[]) => void;
  const waiting = new Promise<any[]>((resolve) => {
    finish = resolve;
  });
  const github = new GitHubConnection({
    enabled: () => true,
    tokenSource: async () => ({ token }),
    connect: () => ({
      listTools: () => waiting,
      callTool: async () => ({ content: [], isError: false }),
      close: async () => {},
    }),
  });
  assert.deepEqual(github.tools(), []);
  const status = await github.status();
  assert.equal(status.enabled, true);
  assert.deepEqual(github.tools(), []);
  finish([{ name: 'list_issues', description: '', readOnly: true }]);
  await github.setEnabled(true);
  assert.deepEqual(github.toolNames(false), ['github_list_issues']);
  await github.close();
});
for (const status of [401, 404])
  test('reconnect and retry exactly once after ' + status, async () => {
    const f = fixture(true, [status]);
    await f.setEnabled(true);
    await f.github.call('list_issues', {});
    assert.equal(f.calls.length, 2);
    assert.equal(f.configs.length, 2);
    assert.equal(f.tokens(), status === 401 ? 2 : 1);
    assert.equal(f.closes(), 1);
    await f.github.close();
  });
test('second HTTP failure is preserved and not retried again', async () => {
  const f = fixture(true, [401, 401]);
  await f.setEnabled(true);
  await assert.rejects(f.github.call('list_issues', {}), /HTTP 401/);
  assert.equal(f.calls.length, 2);
  await f.github.close();
});
for (const code of ['ENOENT', 1, undefined])
  test('credential failure stays private: ' + code, async () => {
    const github = new GitHubConnection({
      enabled: () => true,
      tokenSource: async () => {
        throw Object.assign(new Error(token), { code, stdout: token, stderr: token });
      },
      connect: () => {
        throw new Error('must not connect');
      },
    });
    const status = await github.setEnabled(true);
    assert.equal(status.state, code === 'ENOENT' ? 'gh-missing' : code === 1 ? 'not-signed-in' : 'error');
    assert.ok(!JSON.stringify(status).includes(token));
    assert.deepEqual(github.tools(), []);
    await assert.rejects(github.call('list_issues', {}), (error: any) => !JSON.stringify(error).includes(token));
    await github.close();
  });
test('disable during token acquisition cannot restore credentials or tools', async () => {
  let finish!: (value: { token: string; login: string }) => void;
  const github = new GitHubConnection({
    enabled: () => true,
    tokenSource: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    connect: () => {
      throw new Error('must not connect');
    },
  });
  const enabling = github.setEnabled(true);
  await github.setEnabled(false);
  finish({ token, login: 'octocat' });
  await enabling;
  assert.deepEqual(await github.status(), { enabled: false, state: 'off' });
});
test('default token source is refused by the existing test process guard', async () => {
  await assert.rejects(ghTokenSource());
});
test('MCP HTTP errors retain the status code', async (t) => {
  const server = createServer((_req, res) => {
    res.writeHead(401);
    res.end();
  });
  await listenForFetch(server);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const connection = new McpConnection({
    kind: 'mcp',
    id: 'fixture',
    name: 'Fixture',
    transport: 'http',
    url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
    source: 'test',
    enabled: true,
    installedAt: '',
  });
  await assert.rejects(connection.start(), (error: any) => error.status === 401);
  await connection.close();
});
test('normal cache refresh reuses the live connection', async () => {
  const f = fixture();
  await f.setEnabled(true);
  f.github.warm();
  await f.setEnabled(true);
  assert.equal(f.configs.length, 1);
  assert.equal(f.closes(), 0);
  await f.github.close();
});
test('concurrent 404 and 401 still refresh the rejected token before retry', async () => {
  let tokens = 0,
    connections = 0;
  let releaseClose!: () => void, closeStarted!: () => void;
  const closing = new Promise<void>((resolve) => {
    closeStarted = resolve;
  });
  const closeGate = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  const failures = new Map<string, (error: unknown) => void>();
  const observed: { id: string; token: string }[] = [];
  const github = new GitHubConnection({
    enabled: () => true,
    tokenSource: async () => ({ token: token + ++tokens }),
    connect: (config) => {
      const index = ++connections;
      return {
        listTools: async () => [{ name: 'list_issues', description: '', readOnly: true }],
        callTool: async (_name, args) => {
          if (index === 1)
            return new Promise((_resolve, reject) => {
              failures.set(String(args.id), reject);
            });
          observed.push({ id: String(args.id), token: config.headers!.Authorization! });
          return { content: [], isError: false };
        },
        close: async () => {
          if (index === 1) {
            closeStarted();
            await closeGate;
          }
        },
      };
    },
  });
  await github.setEnabled(true);
  const a = github.call('list_issues', { id: '404' }),
    b = github.call('list_issues', { id: '401' });
  failures.get('404')!(Object.assign(new Error('expired session'), { status: 404 }));
  await closing;
  failures.get('401')!(Object.assign(new Error('expired token'), { status: 401 }));
  releaseClose();
  await Promise.all([a, b]);
  assert.equal(tokens, 2);
  assert.equal(observed.find((call) => call.id === '401')?.token, 'Bearer ' + token + '2');
  await github.close();
});
test('cancelling a reconnect wait does not cancel the shared refresh', { timeout: 3000 }, async () => {
  let release!: (value: { token: string }) => void, started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  let reads = 0,
    connections = 0;
  const github = new GitHubConnection({
    enabled: () => true,
    tokenSource: async () => {
      if (++reads === 1) return { token };
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    connect: () => {
      const index = ++connections;
      return {
        listTools: async () => [{ name: 'list_issues', description: '', readOnly: true }],
        callTool: async () => {
          if (index === 1) throw Object.assign(new Error('expired'), { status: 401 });
          return { content: [], isError: false };
        },
        close: async () => {},
      };
    },
  });
  await github.setEnabled(true);
  const abort = new AbortController();
  const call = github.call('list_issues', {}, abort.signal);
  await waiting;
  abort.abort();
  await assert.rejects(call, /GitHub connection failed/);
  release({ token: token + '2' });
  await github.setEnabled(true);
  assert.equal((await github.call('list_issues', {})).isError, false);
  await github.close();
});
test('a new caller waits through the shared reconnect close window', async () => {
  let release!: () => void,
    started!: () => void,
    connections = 0;
  const closing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const github = new GitHubConnection({
    enabled: () => true,
    tokenSource: async () => ({ token }),
    connect: () => {
      const index = ++connections;
      return {
        listTools: async () => [{ name: 'list_issues', description: '', readOnly: true }],
        callTool: async () => {
          if (index === 1) throw Object.assign(new Error('expired'), { status: 404 });
          return { content: [], isError: false };
        },
        close: async () => {
          if (index === 1) {
            started();
            await gate;
          }
        },
      };
    },
  });
  await github.setEnabled(true);
  const first = github.call('list_issues', {});
  await closing;
  const second = github.call('list_issues', {});
  release();
  assert.deepEqual(
    (await Promise.all([first, second])).map((result) => result.isError),
    [false, false],
  );
  await github.close();
});
test('a failed background list refresh does not swallow a caller 401 recovery', async () => {
  let reads = 0,
    connections = 0,
    lists = 0,
    failList!: (error: unknown) => void;
  const github = new GitHubConnection({
    enabled: () => true,
    tokenSource: async () => ({ token: token + ++reads }),
    connect: () => {
      const index = ++connections;
      return {
        listTools: async () => {
          if (++lists === 2)
            return new Promise((_resolve, reject) => {
              failList = reject;
            });
          return [{ name: 'list_issues', description: '', readOnly: true }];
        },
        callTool: async () => {
          if (index === 1) throw Object.assign(new Error('expired'), { status: 401 });
          return { content: [], isError: false };
        },
        close: async () => {},
      };
    },
  });
  await github.setEnabled(true);
  github.warm();
  const call = github.call('list_issues', {});
  failList(Object.assign(new Error('expired'), { status: 401 }));
  assert.equal((await call).isError, false);
  assert.equal(reads, 2);
  await github.close();
});

for (const error of [
  new Error('missing required parameter: owner'),
  Object.assign(new Error('HTTP 500'), { status: 500 }),
  new Error('Request timed out'),
])
  test('call preserves error: ' + error.message, async () => {
    let calls = 0;
    const github = new GitHubConnection({
      enabled: () => true,
      tokenSource: async () => ({ token }),
      connect: () => ({
        listTools: async () => [{ name: 'list_issues', description: '', readOnly: true }],
        callTool: async () => {
          calls++;
          throw error;
        },
        close: async () => {},
      }),
    });
    await github.setEnabled(true);
    await assert.rejects(github.call('list_issues', {}), (received) => received === error);
    assert.equal(calls, 1);
    await github.close();
  });

test('non-empty tool cache never triggers a timed background refresh', async (t) => {
  let lists = 0;
  let now = 100_000;
  t.mock.method(Date, 'now', () => now);
  const github = new GitHubConnection({
    enabled: () => true,
    tokenSource: async () => ({ token }),
    connect: () => ({
      listTools: async () => {
        lists++;
        return [{ name: 'list_issues', description: '', readOnly: true }];
      },
      callTool: async () => ({ content: [], isError: false }),
      close: async () => {},
    }),
  });
  await github.setEnabled(true);
  for (const elapsed of [0, 59_999, 60_001, 120_001]) {
    now = 100_000 + elapsed;
    assert.equal(github.tools().length, 1);
    await github.status();
    assert.equal(lists, 1);
  }
  await github.close();
});

test('empty cache retries only after the refresh interval', async (t) => {
  let lists = 0;
  let now = 100_000;
  t.mock.method(Date, 'now', () => now);
  const github = new GitHubConnection({
    enabled: () => true,
    tokenSource: async () => ({ token }),
    connect: () => ({
      listTools: async () => {
        lists++;
        return [];
      },
      callTool: async () => ({ content: [], isError: false }),
      close: async () => {},
    }),
  });
  await github.setEnabled(true);
  now += 59_999;
  github.tools();
  assert.equal(lists, 1);
  now += 2;
  github.tools();
  assert.equal(lists, 2);
  await github.setEnabled(true);
  await github.close();
});

test('a reconnect list error keeps its message while token-source errors stay private', async () => {
  for (const credentialFailure of [false, true]) {
    const error = new Error(credentialFailure ? token : 'HTTP 500 during tool listing');
    let tokens = 0,
      lists = 0;
    const github = new GitHubConnection({
      enabled: () => true,
      tokenSource: async () => {
        if (++tokens === 2 && credentialFailure) throw error;
        return { token };
      },
      connect: () => ({
        listTools: async () => {
          if (++lists === 2) throw error;
          return [{ name: 'list_issues', description: '', readOnly: true }];
        },
        callTool: async () => {
          throw Object.assign(new Error('HTTP 401'), { status: 401 });
        },
        close: async () => {},
      }),
    });
    await github.setEnabled(true);
    await assert.rejects(github.call('list_issues', {}), (received: any) =>
      credentialFailure ? received.message === 'GitHub connection failed.' : received === error,
    );
    await github.close();
  }
});
