import assert from 'node:assert/strict';
import { access, appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, type TestContext } from 'node:test';
import {
  githubRepository,
  mergeBranchPullRequest,
  openBranchPullRequest,
  pushBranch,
  type GhRunner,
  type GitRunner,
} from '../src/server/branch-publish.ts';
import { hostGit } from '../src/server/managed-worktrees.ts';

test('githubRepository accepts only anchored github.com remotes', () => {
  assert.deepEqual(githubRepository('https://github.com/o/r'), { owner: 'o', repo: 'r' });
  assert.deepEqual(githubRepository('git@github.com:o/r.git'), { owner: 'o', repo: 'r' });
  assert.deepEqual(githubRepository('ssh://git@github.com/o/r'), { owner: 'o', repo: 'r' });
  assert.deepEqual(githubRepository('https://github.com/o/r.git'), { owner: 'o', repo: 'r' });
  for (const url of [
    'https://notgithub.com/o/r',
    'https://github.com.evil.com/o/r',
    'https://x:tok@github.com/o/r',
    'https://gitlab.com/o/r',
    'ssh://token@github.com/o/r',
    'https://github.com/o/r/extra',
  ])
    assert.equal(githubRepository(url), undefined, url);
});

const envNames = ['HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP'] as const;

/** Repos sit beside a private temp dir, so the publish temp-dir refusal does not fire and nothing is written above it. */
async function isolatedRoot(t: TestContext, prefix: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const home = join(root, 'home');
  const temp = join(root, 'tmp');
  await mkdir(home);
  await mkdir(temp);
  // The test harness keeps one per-process directory under the first temp dir it sees; create it before the swap.
  await hostGit(root, ['--version']);
  const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  Object.assign(process.env, { HOME: home, USERPROFILE: home, TMPDIR: temp, TEMP: temp, TMP: temp });
  t.after(async () => {
    for (const name of envNames)
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function sandbox(t: TestContext) {
  const root = await isolatedRoot(t, 'pp-pub-');
  const source = join(root, 'source');
  const bare = join(root, 'origin.git');
  await hostGit(root, ['init', '-b', 'feature', source]);
  await writeFile(join(source, 'a.txt'), 'one\n');
  await hostGit(source, ['add', 'a.txt']);
  await hostGit(source, ['commit', '-m', 'one']);
  await hostGit(root, ['init', '--bare', bare]);
  const sha = (await hostGit(source, ['rev-parse', 'HEAD'])).stdout.trim();
  const url = pathToFileURL(bare).href;
  const git: GitRunner = async (cwd, args, options) => hostGit(cwd, args, options);
  return {
    root,
    scratch: join(root, 'scratch'),
    source,
    bare,
    sha,
    url,
    git,
    repository: { owner: 'o', repo: 'r', url },
  };
}

const ref = async (bare: string, branch = 'feature') =>
  hostGit(bare, ['rev-parse', `refs/heads/${branch}`], { allowFailure: true });

test('push refuses a new commit with a private path before approval', async (t) => {
  const f = await sandbox(t);
  await hostGit(f.source, ['commit', '--allow-empty', '-m', '/home/x/secret-notes.md']);
  let cards = 0;
  const phases: string[] = [];
  await assert.rejects(
    pushBranch(
      {},
      {
        directory: f.source,
        tmpRoot: f.scratch,
        git: f.git,
        repository: f.repository,
        approve: async () => {
          cards++;
          return 'approved';
        },
        audit: (phase, fields) => phases.push(`${phase}:${fields.reason ?? ''}`),
      },
    ),
    /外发文本检查未通过/,
  );
  assert.equal(cards, 0);
  assert.ok(phases.includes('refused:scan'));
  assert.equal((await ref(f.bare)).code !== 0, true);
});

test('push refuses an unpushed author that is not configured', async (t) => {
  const f = await sandbox(t);
  await hostGit(f.source, ['commit', '--amend', '--no-edit', '--reset-author'], {
    identity: { name: 'Owner', email: 'owner@example.test' },
  });
  await hostGit(f.source, ['commit', '--allow-empty', '-m', 'other'], {
    identity: { name: 'Other', email: 'other@example.invalid' },
  });
  const sha = (await hostGit(f.source, ['rev-parse', 'HEAD'])).stdout.trim();
  let cards = 0;
  await assert.rejects(
    pushBranch(
      {},
      {
        directory: f.source,
        tmpRoot: f.scratch,
        git: f.git,
        repository: f.repository,
        gates: { version: 1, commitAuthor: { emails: ['owner@example.test'] } },
        approve: async () => {
          cards++;
          return 'approved';
        },
      },
    ),
    (error: Error) =>
      error.message.includes(sha.slice(0, 7)) &&
      error.message.includes('o***@example.invalid') &&
      error.message.includes('2 个提交里有 1 个不是'),
  );
  assert.equal(cards, 0);
});

test('push rejects malformed log records before approval', async (t) => {
  const f = await sandbox(t);
  const git: GitRunner = async (cwd, args, options) =>
    args.includes('log')
      ? { code: 0, stdout: `${f.sha}\0Owner\0owner@example.test\0incomplete`, stderr: '' }
      : f.git(cwd, args, options);
  let cards = 0;
  await assert.rejects(
    pushBranch(
      {},
      {
        directory: f.source,
        tmpRoot: f.scratch,
        git,
        repository: f.repository,
        approve: async () => {
          cards++;
          return 'approved';
        },
      },
    ),
    /无法解析待推提交/,
  );
  assert.equal(cards, 0);
});

for (const authorPolicy of ['ask', 'absent'] as const) {
  test(`push accepts a foreign author when policy is ${authorPolicy}`, async (t) => {
    const f = await sandbox(t);
    await hostGit(f.source, ['commit', '--amend', '--no-edit', '--reset-author'], {
      identity: { name: 'Owner', email: 'owner@example.test' },
    });
    await hostGit(f.source, ['commit', '--allow-empty', '-m', 'other'], {
      identity: { name: 'Other', email: 'other@example.invalid' },
    });
    let card = '';
    const result = await pushBranch(
      {},
      {
        directory: f.source,
        tmpRoot: f.scratch,
        git: f.git,
        repository: f.repository,
        ...(authorPolicy === 'ask'
          ? {
              gates: {
                version: 1 as const,
                commitAuthor: { emails: ['owner@example.test'], onMismatch: 'ask' as const },
              },
            }
          : {}),
        approve: async (_title, description) => {
          card = description;
          return 'approved';
        },
      },
    );
    assert.equal(result.status, 'pushed');
    if (authorPolicy === 'ask') assert.match(card, /提交作者与项目配置不符/);
    else assert.doesNotMatch(card, /提交作者与项目配置不符/);
  });
}

test('push excludes foreign commits present on another remote branch', async (t) => {
  const f = await sandbox(t);
  const owner = { name: 'Owner', email: 'owner@example.test' };
  await hostGit(f.source, ['commit', '--amend', '--no-edit', '--reset-author'], { identity: owner });
  await hostGit(f.source, ['checkout', '-b', 'develop']);
  await hostGit(f.source, ['commit', '--allow-empty', '-m', 'other'], {
    identity: { name: 'Other', email: 'other@example.invalid' },
  });
  await hostGit(f.source, ['push', f.url, 'develop:refs/heads/develop']);
  await hostGit(f.source, ['checkout', 'feature']);
  await hostGit(f.source, ['merge', '--no-ff', 'develop', '-m', 'merge develop'], { identity: owner });
  const result = await pushBranch(
    {},
    {
      directory: f.source,
      tmpRoot: f.scratch,
      git: f.git,
      repository: f.repository,
      gates: { version: 1, commitAuthor: { emails: ['owner@example.test'] } },
      approve: async () => 'approved',
    },
  );
  assert.equal(result.status, 'pushed');
});

/** A second machine moves a remote branch, so its new tip is not in this machine's object store. */
async function moveRemoteTip(f: Awaited<ReturnType<typeof sandbox>>, branch: string) {
  const other = join(f.root, 'other-machine');
  await hostGit(f.root, ['clone', '--quiet', '--branch', branch, f.url, other]);
  await hostGit(other, ['commit', '--allow-empty', '-m', 'merged on GitHub'], {
    identity: { name: 'Owner', email: 'owner@example.test' },
  });
  await hostGit(other, ['push', f.url, `HEAD:refs/heads/${branch}`]);
}

test('push does not count commits only reachable from a remote default tip missing locally', async (t) => {
  const f = await sandbox(t);
  const owner = { name: 'Owner', email: 'owner@example.test' };
  await hostGit(f.source, ['commit', '--amend', '--no-edit', '--reset-author'], { identity: owner });
  await hostGit(f.source, ['checkout', '-b', 'main']);
  await hostGit(f.source, ['commit', '--allow-empty', '-m', 'other'], {
    identity: { name: 'Other', email: 'other@example.invalid' },
  });
  await hostGit(f.source, ['push', f.url, 'main:refs/heads/main']);
  await hostGit(f.bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await hostGit(f.source, ['checkout', 'feature']);
  await hostGit(f.source, ['merge', '--no-ff', 'main', '-m', 'merge main'], { identity: owner });
  await moveRemoteTip(f, 'main');
  let card = '';
  const result = await pushBranch(
    {},
    {
      directory: f.source,
      tmpRoot: f.scratch,
      git: f.git,
      repository: f.repository,
      gates: { version: 1, commitAuthor: { emails: ['owner@example.test'] } },
      approve: async (_title, description) => {
        card = description;
        return 'approved';
      },
    },
  );
  assert.equal(result.status, 'pushed');
  assert.match(card, /提交：1 个新提交/);
  assert.doesNotMatch(card, /不在本地/);
});

test('push notes other remote tips missing locally on the card', async (t) => {
  const f = await sandbox(t);
  await hostGit(f.source, ['checkout', '-b', 'develop']);
  await hostGit(f.source, ['push', f.url, 'develop:refs/heads/develop']);
  await hostGit(f.source, ['checkout', 'feature']);
  await moveRemoteTip(f, 'develop');
  let card = '';
  const result = await pushBranch(
    {},
    {
      directory: f.source,
      tmpRoot: f.scratch,
      git: f.git,
      repository: f.repository,
      approve: async (_title, description) => {
        card = description;
        return 'approved';
      },
    },
  );
  assert.equal(result.status, 'pushed');
  assert.match(card, /远程 1 个分支的最新提交不在本地，新提交数可能偏多/);
});

test('push marks more than 5000 changed paths as unverified', async (t) => {
  const f = await sandbox(t);
  await hostGit(f.source, ['push', f.url, `${f.sha}:refs/heads/feature`]);
  await hostGit(f.source, ['commit', '--allow-empty', '-m', 'big']);
  const git: GitRunner = async (cwd, args, options) =>
    args.includes('diff-tree')
      ? { code: 0, stdout: Array.from({ length: 5001 }, (_, i) => `src/f${i}.ts\0`).join(''), stderr: '' }
      : f.git(cwd, args, options);
  let card = '';
  const result = await pushBranch(
    {},
    {
      directory: f.source,
      tmpRoot: f.scratch,
      git,
      repository: f.repository,
      approve: async (_title, description) => {
        card = description;
        return 'approved';
      },
    },
  );
  assert.equal(result.status, 'pushed');
  assert.match(card, /路径：未能核对/);
});

test('push shows the must-ask migration path', async (t) => {
  const f = await sandbox(t);
  await hostGit(f.source, ['push', f.url, `${f.sha}:refs/heads/feature`]);
  await mkdir(join(f.source, 'db', 'migrations'), { recursive: true });
  await writeFile(join(f.source, 'db', 'migrations', '0001.sql'), 'select 1;\n');
  await hostGit(f.source, ['add', 'db/migrations/0001.sql']);
  await hostGit(f.source, ['commit', '-m', 'migration']);
  let card = '';
  const result = await pushBranch(
    {},
    {
      directory: f.source,
      tmpRoot: f.scratch,
      git: f.git,
      repository: f.repository,
      approve: async (_title, description) => {
        card = description;
        return 'approved';
      },
    },
  );
  assert.equal(result.status, 'pushed');
  assert.match(card, /migrations.*必问/);
});

test('push reads non-ASCII workflow paths without Git quoting', async (t) => {
  const f = await sandbox(t);
  await hostGit(f.source, ['push', f.url, `${f.sha}:refs/heads/feature`]);
  await hostGit(f.source, ['commit', '--allow-empty', '-m', 'workflow']);
  const git: GitRunner = async (cwd, args, options) => {
    if (args.includes('diff-tree')) {
      assert.ok(args.includes('-z'));
      return { code: 0, stdout: '.github/workflows/测试.yml\0', stderr: '' };
    }
    return f.git(cwd, args, options);
  };
  let card = '';
  const result = await pushBranch(
    {},
    {
      directory: f.source,
      tmpRoot: f.scratch,
      git,
      repository: f.repository,
      approve: async (_title, description) => {
        card = description;
        return 'approved';
      },
    },
  );
  assert.equal(result.status, 'pushed');
  assert.match(card, /workflows.*必问/);
});

test('push refuses a new record filename before approval', async (t) => {
  const f = await sandbox(t);
  await hostGit(f.source, ['push', f.url, `${f.sha}:refs/heads/feature`]);
  await mkdir(join(f.source, 'notes'));
  await writeFile(join(f.source, 'notes', 'AI_STATE.md'), 'synthetic');
  await hostGit(f.source, ['add', 'notes/AI_STATE.md']);
  await hostGit(f.source, ['commit', '-m', 'notes']);
  let cards = 0;
  await assert.rejects(
    pushBranch(
      {},
      {
        directory: f.source,
        tmpRoot: f.scratch,
        git: f.git,
        repository: f.repository,
        approve: async () => {
          cards++;
          return 'approved';
        },
      },
    ),
    /AI_STATE\.md/,
  );
  assert.equal(cards, 0);
});

for (const message of [
  'Co-Authored-By: Claude <noreply@anthropic.com>',
  'Co-Authored-By: Codex <noreply@openai.com>',
  'Author: owner@example.test',
]) {
  test(`push permits an allowed attribution: ${message}`, async (t) => {
    const f = await sandbox(t);
    await hostGit(f.source, ['commit', '--allow-empty', '-m', message], {
      identity: { name: 'Owner', email: 'owner@example.test' },
    });
    const result = await pushBranch(
      {},
      {
        directory: f.source,
        tmpRoot: f.scratch,
        git: f.git,
        repository: f.repository,
        approve: async () => 'approved',
      },
    );
    assert.equal(result.status, 'pushed');
  });
}

test('push warns when new commits exceed the inspection limit', async (t) => {
  const f = await sandbox(t);
  for (let i = 0; i < 3; i++) await hostGit(f.source, ['commit', '--allow-empty', '-m', `commit ${i}`]);
  let card = '';
  const result = await pushBranch(
    {},
    {
      directory: f.source,
      tmpRoot: f.scratch,
      git: f.git,
      repository: f.repository,
      commitLimit: 3,
      approve: async (_title, description) => {
        card = description;
        return 'approved';
      },
    },
  );
  assert.equal(result.status, 'pushed');
  assert.match(card, /未逐个核对/);
});

test('an approved push uses the sha refspec and does not follow tags', async (t) => {
  const f = await sandbox(t);
  await hostGit(f.source, ['config', 'push.followTags', 'true']);
  await hostGit(f.source, ['tag', '-a', 'v1', '-m', 'synthetic']);
  const seen: string[][] = [];
  let card = '';
  const git: GitRunner = async (cwd, args, options) => {
    seen.push(args);
    return f.git(cwd, args, options);
  };
  const result = await pushBranch(
    {},
    {
      directory: f.source,
      tmpRoot: f.scratch,
      git,
      repository: f.repository,
      approve: async (_title, description) => {
        card = description;
        return 'approved';
      },
    },
  );
  assert.equal(result.status, 'pushed');
  assert.equal(result.createdBranch, true);
  assert.equal((await ref(f.bare)).stdout.trim(), f.sha);
  assert.equal((await hostGit(f.bare, ['show-ref', '--tags'], { allowFailure: true })).code, 1);
  const push = seen.find((args) => args[1] === 'push');
  const common = (await hostGit(f.source, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim();
  assert.match(push?.[0] ?? '', /^--git-dir=/);
  const pushedFrom = resolve(push![0]!.slice('--git-dir='.length));
  const below = relative(f.scratch, pushedFrom);
  assert.ok(below && !below.startsWith('..') && !isAbsolute(below), pushedFrom);
  assert.notEqual(pushedFrom.toLowerCase(), resolve(common).toLowerCase());
  assert.deepEqual(push?.slice(1), [
    'push',
    '--porcelain',
    '--no-follow-tags',
    '--no-recurse-submodules',
    '--',
    f.url,
    `${f.sha}:refs/heads/feature`,
  ]);
  assert.equal(card.includes(f.url), false);
});

test('denial, expiry and a commit after the card push nothing', async (t) => {
  const f = await sandbox(t);
  for (const decision of ['denied', 'expired'] as const) {
    await assert.rejects(
      pushBranch(
        {},
        {
          directory: f.source,
          tmpRoot: f.scratch,
          git: f.git,
          repository: f.repository,
          approve: async () => decision,
        },
      ),
      decision === 'denied' ? /用户未同意推送/ : /4\.5 分钟内无人确认，未推送/,
    );
  }
  await assert.rejects(
    pushBranch(
      {},
      {
        directory: f.source,
        tmpRoot: f.scratch,
        git: f.git,
        repository: f.repository,
        approve: async () => {
          await writeFile(join(f.source, 'a.txt'), 'two\n');
          await hostGit(f.source, ['add', 'a.txt']);
          await hostGit(f.source, ['commit', '-m', 'two']);
          return 'approved';
        },
      },
    ),
    /确认后工作线提交已变化，未推送/,
  );
  assert.notEqual((await ref(f.bare)).code, 0);
});

test('pushing the remote default branch warns, and a non-fast-forward is refused', async (t) => {
  const f = await sandbox(t);
  await hostGit(f.source, ['push', f.url, `${f.sha}:refs/heads/feature`]);
  await hostGit(f.bare, ['symbolic-ref', 'HEAD', 'refs/heads/feature']);
  await hostGit(f.source, ['commit', '--allow-empty', '-m', 'second']);
  let card = '';
  await pushBranch(
    {},
    {
      directory: f.source,
      tmpRoot: f.scratch,
      git: f.git,
      repository: f.repository,
      approve: async (_title, description) => {
        card = description;
        return 'approved';
      },
    },
  );
  assert.match(card, /注意：feature 是远程默认分支/);
  assert.equal(card.includes(f.url), false);
  await hostGit(f.source, ['commit', '--allow-empty', '-m', 'ahead']);
  const ahead = (await hostGit(f.source, ['rev-parse', 'HEAD'])).stdout.trim();
  await hostGit(f.source, ['push', f.url, `${ahead}:refs/heads/feature`]);
  await hostGit(f.source, ['reset', '--hard', 'HEAD~1']);
  await assert.rejects(
    pushBranch(
      { remote: 'origin' },
      {
        directory: f.source,
        tmpRoot: f.scratch,
        git: f.git,
        repository: f.repository,
        approve: async () => 'approved',
      },
    ),
    /不会强推/,
  );
  assert.equal((await ref(f.bare)).stdout.trim(), ahead);
});

test('a bad remote name or a non-GitHub URL is refused before the card', async (t) => {
  const f = await sandbox(t);
  let cards = 0;
  const approve = async () => {
    cards += 1;
    return 'approved' as const;
  };
  await assert.rejects(
    pushBranch(
      { remote: 'bad name' },
      { directory: f.source, tmpRoot: f.scratch, git: f.git, repository: f.repository, approve },
    ),
    /远程名称无效/,
  );
  await hostGit(f.source, ['remote', 'add', 'origin', 'https://example.com/o/r.git']);
  let error = '';
  try {
    await pushBranch({}, { directory: f.source, tmpRoot: f.scratch, git: f.git, approve });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  assert.match(error, /不是 GitHub/);
  assert.equal(error.includes('example.com'), false);
  assert.equal(cards, 0);
});

test('a read-back mismatch is an error and the URL stays out of it', async (t) => {
  const f = await sandbox(t);
  let heads = 0;
  const git: GitRunner = async (cwd, args, options) => {
    if (args.includes('--heads')) {
      heads += 1;
      if (heads > 1) return { code: 0, stdout: `${'a'.repeat(40)}\trefs/heads/feature\n`, stderr: '' };
    }
    if (args.includes('push'))
      return { code: 0, stdout: `*\trefs/heads/feature:refs/heads/feature\t[new branch]\n`, stderr: '' };
    return f.git(cwd, args, options);
  };
  let error = '';
  try {
    await pushBranch(
      {},
      { directory: f.source, tmpRoot: f.scratch, git, repository: f.repository, approve: async () => 'approved' },
    );
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  assert.match(error, /远程分支与本地不一致/);
  assert.equal(error.includes(f.url), false);
});

function ghOf(script: (args: string[], input?: string) => { code: number; stdout: string; stderr?: string }): {
  gh: GhRunner;
  calls: Array<{ args: string[]; cwd: string; input?: string }>;
} {
  const calls: Array<{ args: string[]; cwd: string; input?: string }> = [];
  const gh: GhRunner = async (args, options) => {
    calls.push({ args, cwd: options.cwd, input: options.input });
    const result = script(args, options.input);
    return { code: result.code, stdout: result.stdout, stderr: result.stderr ?? '' };
  };
  return { gh, calls };
}

test('PR text scan refuses before approval and any gh call', async (t) => {
  const f = await sandbox(t);
  const { gh, calls } = ghOf(() => ({ code: 0, stdout: '[]' }));
  const phases: string[] = [];
  let cards = 0;
  await assert.rejects(
    openBranchPullRequest(
      { base: 'main', title: 'Synthetic', body: 'C:\\Users\\x\\notes.md' },
      {
        directory: f.source,
        tmpRoot: f.scratch,
        git: f.git,
        gh,
        repository: f.repository,
        approve: async () => {
          cards++;
          return 'approved';
        },
        audit: (phase, fields) => {
          phases.push(`${phase}:${fields.reason ?? ''}`);
        },
      },
    ),
    /外发文本检查未通过/,
  );
  assert.equal(cards, 0);
  assert.equal(calls.length, 0);
  assert.ok(phases.includes('refused:scan'));
});

test('PR text readback reports mismatch and missing fields', async (t) => {
  const f = await sandbox(t);
  await hostGit(f.source, ['push', f.url, `${f.sha}:refs/heads/feature`]);
  for (const body of ['changed', undefined, 'body\r\n']) {
    const { gh } = ghOf((args) => {
      if (args[1] === 'list') return { code: 0, stdout: '[]' };
      if (args[1] === 'create') return { code: 0, stdout: 'https://github.com/o/r/pull/7\n' };
      return {
        code: 0,
        stdout: JSON.stringify({
          number: 7,
          headRefOid: f.sha,
          headRefName: 'feature',
          baseRefName: 'main',
          isCrossRepository: false,
          title: 'Synthetic',
          body,
        }),
      };
    });
    const operation = openBranchPullRequest(
      { base: 'main', title: ' Synthetic', body: 'body' },
      {
        directory: f.source,
        tmpRoot: f.scratch,
        git: f.git,
        gh,
        repository: f.repository,
        approve: async () => 'approved',
      },
    );
    if (body === 'changed') await assert.rejects(operation, /https:\/\/github\.com\/o\/r\/pull\/7.*请勿重复创建/);
    else {
      const result = await operation;
      assert.equal(result.status, 'opened');
      if (result.status === 'opened') {
        assert.equal(result.readback, body === undefined ? 'unverified' : 'match');
        assert.equal(result.url, 'https://github.com/o/r/pull/7');
      }
    }
  }
});

test('PR readback failure reports created and unverified without another write', async (t) => {
  const f = await sandbox(t);
  await hostGit(f.source, ['push', f.url, `${f.sha}:refs/heads/feature`]);
  for (const failure of ['http', 'invalid-json', 'missing-head'] as const) {
    const { gh, calls } = ghOf((args) => {
      if (args[1] === 'list') return { code: 0, stdout: '[]' };
      if (args[1] === 'create') return { code: 0, stdout: 'https://github.com/o/r/pull/7\n' };
      return failure === 'http'
        ? { code: 1, stdout: '', stderr: 'offline' }
        : { code: 0, stdout: failure === 'invalid-json' ? '{' : JSON.stringify({ title: 'Synthetic', body: 'body' }) };
    });
    const events: Array<{ phase: string; readback?: string }> = [];
    const result = await openBranchPullRequest(
      { base: 'main', title: 'Synthetic', body: 'body' },
      {
        directory: f.source,
        tmpRoot: f.scratch,
        git: f.git,
        gh,
        repository: f.repository,
        approve: async () => 'approved',
        audit: (phase, fields) => events.push({ phase, readback: fields.readback }),
      },
    );
    assert.equal(result.status, 'opened');
    if (result.status === 'opened') {
      assert.equal(result.readback, 'unverified');
      assert.equal(result.url, 'https://github.com/o/r/pull/7');
    }
    assert.equal(calls.filter((call) => call.args[1] === 'create').length, 1);
    assert.ok(events.some((event) => event.phase === 'readback' && event.readback === 'unverified'));
  }
});

test('merge hold refuses before any gh call and records hold audit', async (t) => {
  const f = await sandbox(t);
  const { gh, calls } = ghOf(() => ({ code: 0, stdout: '{}' }));
  const phases: string[] = [];
  await assert.rejects(
    mergeBranchPullRequest(
      { number: 7, expected_head_sha: f.sha },
      {
        directory: f.source,
        tmpRoot: f.scratch,
        git: f.git,
        gh,
        repository: f.repository,
        mergeHold: async (repo, pull, opts) => {
          assert.equal(repo, 'o/r');
          assert.equal(pull, 7);
          assert.equal(opts.refresh, true);
          return { refuse: 'synthetic hold refusal' };
        },
        approve: async () => {
          assert.fail('hold must not be overridable by approval');
        },
        audit: (phase, fields) => phases.push(`${phase}:${fields.reason ?? ''}`),
      },
    ),
    /synthetic hold refusal/,
  );
  assert.equal(calls.length, 0);
  assert.ok(phases.includes('refused:hold'));
});

test('unreadable freeze check adds a card line, and a hold discovered during confirmation refuses inside the lock', async (t) => {
  const f = await sandbox(t);
  const { gh, calls } = ghOf(() => ({
    code: 0,
    stdout: JSON.stringify({
      state: 'OPEN',
      title: 'Synthetic',
      headRefOid: f.sha,
      headRefName: 'feature',
      baseRefName: 'main',
      isCrossRepository: false,
      files: [{ path: 'src/inside.ts' }, { path: 'tests/outside.ts' }],
      reviewDecision: null,
      statusCheckRollup: [],
    }),
  }));
  const phases: string[] = [],
    refreshes: boolean[] = [];
  let approved = false,
    locked = false;
  await assert.rejects(
    mergeBranchPullRequest(
      { number: 7, expected_head_sha: f.sha },
      {
        directory: f.source,
        tmpRoot: f.scratch,
        git: f.git,
        gh,
        repository: f.repository,
        mergeHold: async (_repo, _pull, opts) => {
          refreshes.push(opts.refresh);
          if (opts.paths) {
            assert.equal(opts.refresh, false);
            assert.deepEqual(opts.paths, ['src/inside.ts', 'tests/outside.ts']);
            assert.equal(approved, false);
            return { cardLine: 'synthetic unreadable freeze warning; tests/outside.ts' };
          }
          if (!opts.refresh) {
            assert.equal(approved, true);
            assert.equal(locked, true);
            return { refuse: 'new hold after approval' };
          }
          return { cardLine: 'synthetic unreadable freeze warning' };
        },
        approve: async (_title, description) => {
          assert.match(description, /synthetic unreadable freeze warning/);
          assert.match(description, /tests\/outside.ts/);
          approved = true;
          return 'approved';
        },
        lock: async (operation) => {
          locked = true;
          return operation();
        },
        audit: (phase, fields) => phases.push(`${phase}:${fields.reason ?? ''}`),
      },
    ),
    /new hold after approval/,
  );
  assert.deepEqual(refreshes, [true, false, true, false]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[1], 'view');
  assert.ok(phases.includes('refused:hold'));
});

test('a hold appearing during card wait is refreshed after approval and refuses before the publish lock', async (t) => {
  const f = await sandbox(t);
  const { gh, calls } = ghOf(() => ({
    code: 0,
    stdout: JSON.stringify({
      state: 'OPEN',
      title: 'Synthetic',
      headRefOid: f.sha,
      headRefName: 'feature',
      baseRefName: 'main',
      isCrossRepository: false,
      files: [],
      reviewDecision: null,
      statusCheckRollup: [],
    }),
  }));
  const phases: string[] = [],
    refreshes: boolean[] = [];
  let approved = false,
    locked = false;
  await assert.rejects(
    mergeBranchPullRequest(
      { number: 7, expected_head_sha: f.sha },
      {
        directory: f.source,
        tmpRoot: f.scratch,
        git: f.git,
        gh,
        repository: f.repository,
        mergeHold: async (_repo, _pull, opts) => {
          refreshes.push(opts.refresh);
          if (approved) {
            assert.equal(opts.refresh, true);
            assert.equal(approved, true);
            assert.equal(locked, false);
            return { refuse: 'new hold after approval' };
          }
          return { cardLine: 'synthetic unreadable freeze warning' };
        },
        approve: async (_title, description) => {
          assert.match(description, /synthetic unreadable freeze warning/);
          approved = true;
          return 'approved';
        },
        lock: async (operation) => {
          locked = true;
          return operation();
        },
        audit: (phase, fields) => phases.push(`${phase}:${fields.reason ?? ''}`),
      },
    ),
    /new hold after approval/,
  );
  assert.deepEqual(refreshes, [true, false, true]);
  assert.equal(locked, false);
  assert.ok(!calls.some((call) => call.args[1] === 'merge'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[1], 'view');
  assert.ok(phases.includes('refused:hold'));
});

test('merge window refuses before invoking gh', async (t) => {
  const f = await sandbox(t);
  const { gh, calls } = ghOf(() => ({ code: 0, stdout: '{}' }));
  const phases: string[] = [];
  await assert.rejects(
    mergeBranchPullRequest(
      { number: 7, expected_head_sha: f.sha },
      {
        directory: f.source,
        tmpRoot: f.scratch,
        git: f.git,
        gh,
        repository: f.repository,
        gates: { version: 1, windows: { noMerge: { from: '22:00', to: '07:00', tz: 'America/New_York' } } },
        now: () => new Date('2026-10-28T03:41:00Z'),
        audit: (phase, fields) => phases.push(`${phase}:${fields.reason ?? ''}`),
      },
    ),
    /不合并/,
  );
  assert.equal(calls.length, 0);
  assert.ok(phases.includes('refused:window'));
});

test('merge outside its window shows CODEOWNERS in the card', async (t) => {
  const f = await sandbox(t);
  const { gh } = ghOf(() => ({
    code: 0,
    stdout: JSON.stringify({
      state: 'OPEN',
      title: 'Synthetic',
      headRefOid: f.sha,
      headRefName: 'feature',
      baseRefName: 'main',
      isCrossRepository: false,
      files: [{ path: 'CODEOWNERS' }],
      reviewDecision: null,
      statusCheckRollup: [],
    }),
  }));
  let card = '';
  await assert.rejects(
    mergeBranchPullRequest(
      { number: 7, expected_head_sha: f.sha },
      {
        directory: f.source,
        tmpRoot: f.scratch,
        git: f.git,
        gh,
        repository: f.repository,
        gates: { version: 1, windows: { noMerge: { from: '22:00', to: '07:00', tz: 'America/New_York' } } },
        now: () => new Date('2026-10-28T11:00:00Z'),
        approve: async (_title, description) => {
          card = description;
          return 'denied';
        },
      },
    ),
    /用户未同意合并/,
  );
  assert.match(card, /CODEOWNERS/);
});

test('opening a pull request sends the body on stdin outside the repo', async (t) => {
  const f = await sandbox(t);
  await hostGit(f.source, ['push', f.url, `${f.sha}:refs/heads/feature`]);
  const { gh, calls } = ghOf((args) => {
    if (args[1] === 'list') return { code: 0, stdout: '[]' };
    if (args[1] === 'create') return { code: 0, stdout: 'https://github.com/o/r/pull/7\n' };
    return {
      code: 0,
      stdout: JSON.stringify({
        number: 7,
        url: 'https://github.com/o/r/pull/7',
        headRefOid: f.sha,
        headRefName: 'feature',
        baseRefName: 'main',
        isCrossRepository: false,
      }),
    };
  });
  let card = '';
  const opened = await openBranchPullRequest(
    { base: 'main', title: 'Synthetic', body: 'hello body\nsecond' },
    {
      directory: f.source,
      tmpRoot: f.scratch,
      git: f.git,
      gh,
      repository: f.repository,
      approve: async (_title, description) => {
        card = description;
        return 'approved';
      },
    },
  );
  assert.equal(opened.status, 'opened');
  if (opened.status === 'opened') {
    assert.equal(opened.repository, 'o/r');
    assert.equal(opened.headSha, f.sha);
  }
  assert.match(card, /创建 Pull Request|main ← feature/);
  const create = calls.find((call) => call.args[1] === 'create');
  assert.ok(create);
  assert.deepEqual(create.args.slice(0, 8), ['pr', 'create', '--repo', 'o/r', '--base', 'main', '--head', 'feature']);
  assert.ok(create.args.includes('--body-file') && create.args.includes('-'));
  assert.equal(create.input, 'hello body\nsecond');
  assert.notEqual(create.cwd, f.source);
  assert.notEqual(create.cwd, f.bare);
  assert.equal(card.includes(f.url), false);
});

test('an existing same-repo pull request skips the card; a cross-repo row does not', async (t) => {
  const f = await sandbox(t);
  await hostGit(f.source, ['push', f.url, `${f.sha}:refs/heads/feature`]);
  let cards = 0;
  const approve = async () => {
    cards += 1;
    return 'denied' as const;
  };
  const same = ghOf(() => ({
    code: 0,
    stdout: JSON.stringify([
      { number: 4, url: 'https://github.com/o/r/pull/4', headRefOid: f.sha, isCrossRepository: false },
    ]),
  }));
  const exists = await openBranchPullRequest(
    { base: 'main', title: 'Synthetic', body: 'body' },
    { directory: f.source, tmpRoot: f.scratch, git: f.git, gh: same.gh, repository: f.repository, approve },
  );
  assert.deepEqual(exists, {
    status: 'exists',
    number: 4,
    url: 'https://github.com/o/r/pull/4',
    repository: 'o/r',
    headSha: f.sha,
  });
  assert.equal(cards, 0);
  const cross = ghOf(() => ({
    code: 0,
    stdout: JSON.stringify([
      { number: 5, url: 'https://github.com/o/r/pull/5', headRefOid: f.sha, isCrossRepository: true },
    ]),
  }));
  await assert.rejects(
    openBranchPullRequest(
      { base: 'main', title: 'Synthetic', body: 'body' },
      { directory: f.source, tmpRoot: f.scratch, git: f.git, gh: cross.gh, repository: f.repository, approve },
    ),
    /用户未同意创建 PR/,
  );
  assert.equal(cards, 1);
});

test('opening a pull request refuses when the branch is not pushed', async (t) => {
  const f = await sandbox(t);
  let cards = 0;
  await assert.rejects(
    openBranchPullRequest(
      { base: 'main', title: 'Synthetic', body: 'body' },
      {
        directory: f.source,
        tmpRoot: f.scratch,
        git: f.git,
        repository: f.repository,
        gh: ghOf(() => ({ code: 0, stdout: '[]' })).gh,
        approve: async () => {
          cards += 1;
          return 'approved';
        },
      },
    ),
    /请先推送分支/,
  );
  assert.equal(cards, 0);
});

test('merge asks with the head sha, deletes only when asked, and reads MERGED back', async (t) => {
  const f = await sandbox(t);
  await hostGit(f.source, ['push', f.url, `${f.sha}:refs/heads/feature`]);
  const view = {
    state: 'OPEN',
    title: 'Synthetic PR',
    headRefOid: f.sha,
    headRefName: 'feature',
    baseRefName: 'main',
    isCrossRepository: false,
    reviewDecision: 'APPROVED',
    statusCheckRollup: [{ state: 'SUCCESS' }],
  };
  const run = async (deleteBranch: boolean) => {
    const { gh, calls } = ghOf((args) => {
      if (args.includes('state,mergeCommit'))
        return { code: 0, stdout: JSON.stringify({ state: 'MERGED', mergeCommit: { oid: 'b'.repeat(40) } }) };
      if (args[1] === 'merge') return { code: 0, stdout: '' };
      return { code: 0, stdout: JSON.stringify(view) };
    });
    let card = '';
    const merged = await mergeBranchPullRequest(
      { number: 7, expected_head_sha: f.sha, ...(deleteBranch ? { delete_branch: true } : {}) },
      {
        directory: f.source,
        tmpRoot: f.scratch,
        git: f.git,
        gh,
        repository: f.repository,
        approve: async (_title, description) => {
          card = description;
          return 'approved';
        },
      },
    );
    return { merged, calls, card };
  };
  const kept = await run(false);
  assert.equal(kept.merged.status, 'merged');
  assert.equal(kept.merged.repository, 'o/r');
  assert.match(kept.card, /合并 Pull Request|方式：squash|远程分支：合并后保留/);
  const merge = kept.calls.find((call) => call.args[1] === 'merge')!;
  assert.ok(merge.args.includes('--match-head-commit') && merge.args.includes(f.sha));
  assert.equal(merge.args.includes('--delete-branch'), false);
  assert.equal(
    merge.args.some((arg) => arg === '--admin' || arg === '--auto'),
    false,
  );
  const removed = await run(true);
  assert.equal(removed.calls.find((call) => call.args[1] === 'merge')!.args.includes('--delete-branch'), true);
  assert.match(removed.card, /合并后删除 feature/);
});

test('merge does not run when the head moves or the worktree is ahead, and a non-MERGED read-back fails', async (t) => {
  const f = await sandbox(t);
  await hostGit(f.source, ['push', f.url, `${f.sha}:refs/heads/feature`]);
  const base = {
    state: 'OPEN',
    title: 'Synthetic PR',
    headRefOid: f.sha,
    headRefName: 'feature',
    baseRefName: 'main',
    isCrossRepository: false,
    reviewDecision: null,
    statusCheckRollup: [],
  };
  let views = 0;
  const moving = ghOf((args) => {
    if (args[1] !== 'view') return { code: 0, stdout: '' };
    views += 1;
    return { code: 0, stdout: JSON.stringify(views === 1 ? base : { ...base, headRefOid: 'c'.repeat(40) }) };
  });
  await assert.rejects(
    mergeBranchPullRequest(
      { number: 7, expected_head_sha: f.sha },
      {
        directory: f.source,
        tmpRoot: f.scratch,
        git: f.git,
        gh: moving.gh,
        repository: f.repository,
        approve: async () => 'approved',
      },
    ),
    /确认后 PR 已变化/,
  );
  assert.equal(
    moving.calls.some((call) => call.args[1] === 'merge'),
    false,
  );
  let cards = 0;
  await assert.rejects(
    mergeBranchPullRequest(
      { number: 7, expected_head_sha: 'd'.repeat(40) },
      {
        directory: f.source,
        tmpRoot: f.scratch,
        git: f.git,
        repository: f.repository,
        gh: ghOf(() => ({ code: 0, stdout: JSON.stringify(base) })).gh,
        approve: async () => {
          cards += 1;
          return 'approved';
        },
      },
    ),
    /请先推送后再合并/,
  );
  assert.equal(cards, 0);
  const unread = ghOf((args) =>
    args.includes('state,mergeCommit')
      ? { code: 0, stdout: JSON.stringify({ state: 'OPEN', mergeCommit: null }) }
      : args[1] === 'merge'
        ? { code: 0, stdout: '' }
        : { code: 0, stdout: JSON.stringify(base) },
  );
  await assert.rejects(
    mergeBranchPullRequest(
      { number: 7, expected_head_sha: f.sha },
      {
        directory: f.source,
        tmpRoot: f.scratch,
        git: f.git,
        gh: unread.gh,
        repository: f.repository,
        approve: async () => 'approved',
      },
    ),
    /合并后回读未确认已合并/,
  );
  assert.equal(
    unread.calls.some((call) => call.args.includes('--admin') || call.args.includes('--auto')),
    false,
  );
});

const malicious = `[protocol "ext"]\n\tallow = always\n[url "ext::evil"]\n\tinsteadOf = https://github.com/\n`;

test('a commondir inside the worktree git dir is refused before any network git', async (t) => {
  const f = await sandbox(t);
  const checkout = join(f.root, 'linked');
  await hostGit(f.source, ['worktree', 'add', '-b', 'other', checkout, 'HEAD']);
  const gitDir = (await hostGit(checkout, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
  const fake = join(gitDir, 'fake-common');
  await mkdir(fake, { recursive: true });
  await writeFile(join(fake, 'config'), malicious);
  await writeFile(join(gitDir, 'commondir'), 'fake-common\n');
  const seen: string[][] = [];
  let cards = 0;
  const git: GitRunner = async (cwd, args, options) => {
    seen.push(args);
    return f.git(cwd, args, options);
  };
  await assert.rejects(
    pushBranch(
      {},
      {
        directory: checkout,
        tmpRoot: f.scratch,
        git,
        repository: f.repository,
        approve: async () => {
          cards += 1;
          return 'approved';
        },
      },
    ),
    /仓库的 Git 目录不在安全位置/,
  );
  assert.equal(cards, 0);
  assert.equal(
    seen.some((args) => args.includes('ls-remote') || args.includes('push')),
    false,
  );
});

test('a .git pointer inside the checkout is refused before any network git', async (t) => {
  const f = await sandbox(t);
  const checkout = join(f.root, 'pointer');
  const fake = join(checkout, 'fake-git');
  await mkdir(fake, { recursive: true });
  await writeFile(join(fake, 'config'), malicious);
  await writeFile(join(fake, 'HEAD'), 'ref: refs/heads/feature\n');
  await writeFile(join(checkout, '.git'), 'gitdir: fake-git\n');
  const seen: string[][] = [];
  let cards = 0;
  const git: GitRunner = async (cwd, args, options) => {
    seen.push(args);
    return f.git(cwd, args, options);
  };
  await assert.rejects(
    pushBranch(
      {},
      {
        directory: checkout,
        tmpRoot: f.scratch,
        git,
        approve: async () => {
          cards += 1;
          return 'approved';
        },
      },
    ),
    /仓库的 Git 目录不在安全位置/,
  );
  assert.equal(cards, 0);
  assert.equal(
    seen.some((args) => args.includes('ls-remote') || args.includes('push')),
    false,
  );
});

test('a pull request title with a control character is refused before the card', async (t) => {
  const f = await sandbox(t);
  let cards = 0;
  await assert.rejects(
    openBranchPullRequest(
      { base: 'main', title: 'bad\ntitle', body: 'body' },
      {
        directory: f.source,
        tmpRoot: f.scratch,
        git: f.git,
        repository: f.repository,
        approve: async () => {
          cards += 1;
          return 'approved';
        },
      },
    ),
    /控制字符/,
  );
  assert.equal(cards, 0);
});

test('a push with no ref line keeps the redacted git error', async (t) => {
  const f = await sandbox(t);
  const git: GitRunner = async (cwd, args, options) => {
    if (args.includes('push')) return { code: 1, stdout: '', stderr: 'https://secret.example/denied\n' };
    return f.git(cwd, args, options);
  };
  await assert.rejects(
    pushBranch(
      {},
      {
        directory: f.source,
        tmpRoot: f.scratch,
        git,
        repository: f.repository,
        approve: async () => 'approved',
      },
    ),
    /\[redacted\]/,
  );
});

/** A repo config that runs a host command as soon as Git rewrites the pushed URL through it. */
const planted = (url: string, marker: string) =>
  `[protocol "ext"]\n\tallow = always\n[url "ext::sh -c touch% ${marker.replaceAll(sep, '/')}"]\n\tinsteadOf = ${url}\n`;
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

test('a worktree pointer to a fake common dir under objects never loads its config', async (t) => {
  const f = await sandbox(t);
  const marker = join(f.root, 'marker-a');
  const checkout = join(f.root, 'linked');
  // The executor's rewritten pointer; written fresh because Windows here refuses overwriting a Git-made `.git` file.
  await mkdir(checkout);
  const common = join(f.source, '.git');
  const fake = join(common, 'objects', 'x');
  const gitDir = join(fake, 'worktrees', 'n');
  await mkdir(gitDir, { recursive: true });
  await mkdir(join(fake, 'objects', 'info'), { recursive: true });
  await mkdir(join(fake, 'refs', 'heads'), { recursive: true });
  await writeFile(join(fake, 'config'), planted(f.url, marker));
  await writeFile(join(fake, 'HEAD'), 'ref: refs/heads/side\n');
  await writeFile(join(fake, 'objects', 'info', 'alternates'), `${join(common, 'objects').replaceAll(sep, '/')}\n`);
  await writeFile(join(fake, 'refs', 'heads', 'side'), `${f.sha}\n`);
  await writeFile(join(gitDir, 'commondir'), '../..\n');
  await writeFile(join(gitDir, 'gitdir'), `${join(checkout, '.git')}\n`);
  await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/side\n');
  await writeFile(join(checkout, '.git'), `gitdir: ${gitDir}\n`);
  let outcome: unknown;
  try {
    outcome = await pushBranch(
      {},
      {
        directory: checkout,
        tmpRoot: f.scratch,
        git: f.git,
        repository: f.repository,
        approve: async () => 'approved',
      },
    );
  } catch (error) {
    outcome = error;
  }
  assert.equal(await exists(marker), false, 'the planted config ran a host command');
  if (outcome instanceof Error) assert.match(outcome.message, /不在安全位置/);
  else assert.equal((await ref(f.bare, 'side')).stdout.trim(), f.sha);
});

test('a main checkout with a planted config pushes without loading it', async (t) => {
  const f = await sandbox(t);
  const marker = join(f.root, 'marker-b');
  await appendFile(join(f.source, '.git', 'config'), planted(f.url, marker));
  const result = await pushBranch(
    {},
    { directory: f.source, tmpRoot: f.scratch, git: f.git, repository: f.repository, approve: async () => 'approved' },
  );
  assert.equal(result.status, 'pushed');
  assert.equal((await ref(f.bare)).stdout.trim(), f.sha);
  assert.equal(await exists(marker), false, 'the planted config ran a host command');
});

test('a common dir the run may write, or another repository, is refused before any network git', async (t) => {
  const f = await sandbox(t);
  const other = join(f.root, 'other');
  await hostGit(f.root, ['init', other]);
  for (const placed of [
    { commonDirectory: join(f.source, '.git'), gitWritePaths: [f.source] },
    { commonDirectory: join(other, '.git') },
  ]) {
    const seen: string[][] = [];
    await assert.rejects(
      pushBranch(
        {},
        {
          directory: f.source,
          tmpRoot: f.scratch,
          git: async (cwd, args, options) => {
            seen.push(args);
            return f.git(cwd, args, options);
          },
          repository: f.repository,
          approve: async () => 'approved',
          ...placed,
        },
      ),
      /不在安全位置/,
    );
    assert.equal(
      seen.some((args) => args.includes('ls-remote') || args.includes('push')),
      false,
    );
  }
});

test('the merge card counts a completed check run by its conclusion', async (t) => {
  const f = await sandbox(t);
  const view = {
    state: 'OPEN',
    title: 'Synthetic PR',
    headRefOid: f.sha,
    headRefName: 'feature',
    baseRefName: 'main',
    isCrossRepository: false,
    reviewDecision: null,
    statusCheckRollup: [
      { status: 'COMPLETED', conclusion: 'FAILURE' },
      { status: 'IN_PROGRESS' },
      { state: 'SUCCESS' },
    ],
  };
  let card = '';
  await assert.rejects(
    mergeBranchPullRequest(
      { number: 7, expected_head_sha: f.sha },
      {
        directory: f.source,
        tmpRoot: f.scratch,
        git: f.git,
        repository: f.repository,
        gh: ghOf(() => ({ code: 0, stdout: JSON.stringify(view) })).gh,
        approve: async (_title, description) => {
          card = description;
          return 'denied';
        },
      },
    ),
    /用户未同意合并/,
  );
  assert.match(card, /检查：1 通过，1 失败，1 未完成/);
});
