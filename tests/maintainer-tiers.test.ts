import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  classifyPullRequest,
  collaboratorPermission,
  pathsFromFiles,
  type Tier,
} from '../src/server/maintainer/tiers.ts';

for (const [paths, tier] of [
  [['docs/x.md', 'docs/nested/y.md'], 'docs'],
  [['README.md', 'docs/x.md'], 'docs'],
  [['README.zh.md', 'CONTRIBUTING.md', 'docs/CHANGELOG.md'], 'docs'],
  [['DOCS/X.MD', 'Readme.MD'], 'docs'],
  [['docs/decisions/x.md'], 'owner'],
  [['.github/CONTRIBUTING.md'], 'owner'],
  [['agents.md'], 'owner'],
  [['src/foo/AGENTS.md'], 'owner'],
  [['package-lock.json'], 'owner'],
  [['src/server/github-gate.ts'], 'owner'],
  [['src/server/sandbox/x.ts'], 'owner'],
  [['src/shared/i18n/en.json'], 'code'],
  [['src/ui/app.tsx'], 'code'],
  [['docs/x.md', 'src/ui/app.tsx'], 'code'],
  [['docs/data.json'], 'code'],
  [['docs/readme.md.ts'], 'code'],
] as [string[], Tier][]) {
  test(`${paths.join(' + ')} is ${tier}`, () => {
    const result = classifyPullRequest({ paths, authorIsCollaborator: true });
    assert.equal(result.tier, tier);
    assert.equal(result.label, `tier:${tier}`);
    assert.equal(result.external, false);
    assert.ok(result.reasons.length > 0);
  });
}

test('all supported docs images are human-facing, including nested paths', () => {
  for (const extension of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])
    for (const path of [`docs/image.${extension}`, `docs/nested/image.${extension.toUpperCase()}`])
      assert.equal(classifyPullRequest({ paths: [path], authorIsCollaborator: true }).tier, 'docs', path);
});

test('instruction, dependency, security, and execution paths require owner review', () => {
  for (const path of [
    'CLAUDE.md',
    'docs/nested/GEMINI.md',
    'docs/SECURITY.md',
    '.pugport/judge.md',
    '.claude/skills/x.md',
    '.codex/config.toml',
    '.cursor/rules/x.md',
    '.cursorrules',
    '.agents/skills/x.md',
    '.mcp.json',
    '.gitattributes',
    '.gitmodules',
    '.vscode/settings.json',
    'docs/AGENT-WORKFLOW.md',
    'docs/skills/x.md',
    'docs/ui-glossary.md',
    'docs/CLA.md',
    'package.json',
    'nested/package.json',
    'nested/package-lock.json',
    'npm-shrinkwrap.json',
    'nested/npm-shrinkwrap.json',
    '.npmrc',
    'licenses/example.txt',
    'LICENSE',
    'LICENSE.txt',
    'NOTICE',
    'NOTICE.md',
    'THIRD_PARTY_NOTICES.md',
    'docs/DEPENDENCY-LICENSES.json',
    'docs/NPM-LICENSE-SUPPLEMENTS.json',
    'src/shared/permission-reason.ts',
    'github.ts',
    'src/server/project-trust.ts',
    'src/server/local-api-guard.ts',
    'src/server/caller-policy.ts',
    'src/server/node/peer-auth.ts',
    'src/electron/main.ts',
    'src/server/maintainer/tiers.ts',
    'launchers/start.command',
    'bin/pugport',
    'scripts/build.mjs',
    'Setup.ps1',
    'nested/setup.sh',
    'Start.cmd',
    'nested/start.bat',
    'CODEOWNERS',
    'nested/CODEOWNERS',
    'src/migrations/001.sql',
  ])
    assert.equal(classifyPullRequest({ paths: ['README.md', path], authorIsCollaborator: true }).tier, 'owner', path);
});

test('paths normalize Windows separators and repeated leading ./ or /', () => {
  const result = classifyPullRequest({ paths: ['.\\/./SRC\\foo\\agents.md'], authorIsCollaborator: true });
  assert.equal(result.tier, 'owner');
  assert.deepEqual(result.reasons, ['SRC/foo/agents.md is owner-only']);
  assert.equal(classifyPullRequest({ paths: ['/./docs\\x.md'], authorIsCollaborator: true }).tier, 'docs');
});

test('empty or truncated file lists require owner review', () => {
  assert.deepEqual(classifyPullRequest({ paths: [], authorIsCollaborator: true }), {
    tier: 'owner',
    external: false,
    label: 'tier:owner',
    reasons: ['no files'],
  });
  const result = classifyPullRequest({ paths: ['README.md'], pathsTruncated: true, authorIsCollaborator: true });
  assert.equal(result.tier, 'owner');
  assert.deepEqual(result.reasons, ['file list incomplete']);
});

test('custom always-ask paths are owner-only and match case-insensitively', () => {
  const result = classifyPullRequest({
    paths: ['src/PAYMENTS/charge.ts'],
    authorIsCollaborator: true,
    gates: { version: 1, alwaysAsk: { paths: ['src/payments/**'] } },
  });
  assert.equal(result.tier, 'owner');
  assert.equal(
    classifyPullRequest({
      paths: ['package.json'],
      authorIsCollaborator: true,
      gates: { version: 1, alwaysAsk: { paths: [] } },
    }).tier,
    'owner',
  );
});

test('external status is independent of tier', () => {
  for (const paths of [['README.md'], ['src/ui/app.tsx'], ['AGENTS.md'], []]) {
    const internal = classifyPullRequest({ paths, authorIsCollaborator: true });
    const external = classifyPullRequest({ paths, authorIsCollaborator: false });
    assert.equal(external.tier, internal.tier);
    assert.equal(external.label, internal.label);
    assert.equal(internal.external, false);
    assert.equal(external.external, true);
    assert.ok(external.reasons.includes('author is not a collaborator'));
  }
});

test('reasons are capped at five while preserving external status', () => {
  for (const authorIsCollaborator of [true, false])
    for (const prefix of ['.github/', 'src/ui/']) {
      const paths = Array.from({ length: 10 }, (_, i) => `${prefix}${i}.ts`);
      const result = classifyPullRequest({ paths, authorIsCollaborator });
      assert.equal(result.reasons.length, 5);
      if (!authorIsCollaborator) assert.equal(result.reasons.at(-1), 'author is not a collaborator');
    }
});

for (const permission of ['admin', 'maintain', 'write', 'triage', 'read', 'none', 'unknown', '']) {
  test(`collaborator permission ${permission || '(empty)'} is checked`, async () => {
    const calls: string[][] = [];
    const result = await collaboratorPermission(
      async (args) => {
        calls.push(args);
        return `${permission}\n`;
      },
      'owner/repo',
      'contributor',
    );
    assert.deepEqual(calls, [['api', 'repos/owner/repo/collaborators/contributor/permission', '--jq', '.permission']]);
    assert.deepEqual(result, { trusted: ['admin', 'maintain', 'write'].includes(permission), permission });
  });
}

test('collaborator lookup failures are untrusted', async () => {
  for (const message of ['HTTP 404: Not Found', 'network unavailable']) {
    let calls = 0;
    const result = await collaboratorPermission(
      async () => {
        calls++;
        throw new Error(message);
      },
      'owner/repo',
      'contributor',
    );
    assert.equal(calls, 1);
    assert.deepEqual(result, { trusted: false, permission: 'none' });
  }
});

test('invalid repos, invalid logins, and bot logins never call the runner', async () => {
  let calls = 0;
  const run = async () => {
    calls++;
    return 'admin';
  };
  for (const [repo, login, permission] of [
    ['owner/repo', '../user', 'invalid'],
    ['owner/repo', 'user/name', 'invalid'],
    ['owner/repo', '', 'invalid'],
    ['owner/repo', 'user_name', 'invalid'],
    ['owner/repo', '\nuser', 'invalid'],
    ['owner/repo/extra', 'user', 'invalid'],
    ['owner/repo?query', 'user', 'invalid'],
    ['', 'user', 'invalid'],
    ['owner/repo', 'dependabot[bot]', 'none'],
    ['owner/repo', 'pugport-maintainer[bot]', 'none'],
  ])
    assert.deepEqual(await collaboratorPermission(run, repo!, login!), { trusted: false, permission });
  assert.equal(calls, 0);
});

test('nested agent folders, other agents’ instruction files, hooks, and security code are owner-only', () => {
  for (const path of [
    'docs/.cursor/rules/x.md',
    'docs/.claude/skills/x/SKILL.md',
    'docs/.agents/skills/x.md',
    '.pi/extensions/x.ts',
    '.pi/SYSTEM.md',
    '.gemini/settings.json',
    '.devcontainer/devcontainer.json',
    '.husky/pre-commit',
    '.githooks/pre-push',
    '.windsurfrules',
    '.idea/workspace.xml',
    'docs/AGENTS.override.md',
    'src/x/AGENTS.override.md',
    'CLAUDE.local.md',
    'docs/CLAUDE.local.md',
    'AGENT.md',
    'src/server/github/routes.ts',
    'src/server/git-read-only.ts',
    'src/server/approval-rules.ts',
    'src/server/agent-bridge.ts',
    'src/shared/bridge-catalog.ts',
    'src/server/remote-job-scripts.ts',
    'src/server/ssh-options.ts',
    'src/server/judge-runner.ts',
  ])
    assert.equal(classifyPullRequest({ paths: [path], authorIsCollaborator: true }).tier, 'owner', path);
});

test('unusual paths are owner-only', () => {
  for (const path of ['docs/../.claude/x.md', 'docs/../x.md', 'docs//x.md', 'docs/skılls/x.md', 'docs/x\u0000.md'])
    assert.equal(
      classifyPullRequest({ paths: [path], authorIsCollaborator: true }).tier,
      'owner',
      JSON.stringify(path),
    );
});

test('CODEOWNERS and migrations stay owner-only when the project sets its own always-ask paths', () => {
  const gates = { version: 1 as const, alwaysAsk: { paths: ['src/payments/**'] } };
  for (const path of ['CODEOWNERS', 'docs/CODEOWNERS', 'src/migrations/001.sql'])
    assert.equal(classifyPullRequest({ paths: [path], authorIsCollaborator: true, gates }).tier, 'owner', path);
});

test('every repository file AGENTS.md or CLAUDE.md links to is owner-only', () => {
  const linked = ['AGENTS.md', 'CLAUDE.md'].flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(/\]\(([^)#\s]+)/g)]
      .map((match) => match[1]!)
      .filter((target) => !/^[a-z]+:/i.test(target))
      .map((target) => target.replace(/^\.\//, '')),
  );
  assert.ok(linked.length >= 5);
  for (const path of linked)
    assert.equal(classifyPullRequest({ paths: [path], authorIsCollaborator: true }).tier, 'owner', path);
});

test('pathsFromFiles counts both names of a rename and flags a short list as truncated', () => {
  const files = [{ filename: 'docs/old.md', previous_filename: 'AGENTS.md' }, { filename: 'docs/x.md' }];
  assert.deepEqual(pathsFromFiles(files, 2), {
    paths: ['docs/old.md', 'AGENTS.md', 'docs/x.md'],
    pathsTruncated: false,
  });
  assert.equal(classifyPullRequest({ ...pathsFromFiles(files, 2), authorIsCollaborator: true }).tier, 'owner');
  assert.equal(pathsFromFiles(files, 3001).pathsTruncated, true);
  assert.equal(pathsFromFiles(files).pathsTruncated, true);
});

test('repository names with dot segments are invalid', async () => {
  let calls = 0;
  for (const repo of ['owner/..', 'owner/.', '../repo'])
    assert.deepEqual(
      await collaboratorPermission(
        async () => {
          calls++;
          return 'admin';
        },
        repo,
        'user',
      ),
      { trusted: false, permission: 'invalid' },
    );
  assert.equal(calls, 0);
});
