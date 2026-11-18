import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeSessionConfig } from '../src/server/claude-session-config.ts';
import { isolatedUserPath } from '../src/server/platform/under-test.ts';
import type { RuntimeTarget } from '../src/shared/types.ts';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'claude-config-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project');
  const config = join(root, 'profile');
  await mkdir(cwd);
  await mkdir(config);
  const env = { HOME: root, USERPROFILE: root, ProgramFiles: join(root, 'programs') };
  const target: RuntimeTarget = {
    id: 'fixture',
    provider: 'claude',
    label: 'Fixture',
    command: 'fixture',
    environment: 'native',
    enabled: true,
    accountHome: config,
  };
  const put = async (file: string, text: string) => {
    const { dirname } = await import('node:path');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  };
  return { root, cwd, config, env, target, put, digest: () => claudeSessionConfig.fingerprint(target, cwd, env) };
}

test('Claude idle configuration changes for instructions, imports, and environment without exposing contents', async (t) => {
  const f = await fixture(t);
  await f.put(join(f.cwd, 'CLAUDE.md'), 'Read @../instructions.md');
  await f.put(join(f.root, 'instructions.md'), 'Only inspect approved files.');
  const initial = await f.digest();
  assert.match(initial!, /^[a-f0-9]{64}$/);
  assert.equal(await f.digest(), initial);
  await f.put(join(f.root, 'instructions.md'), 'Never change files.');
  const updated = await f.digest();
  assert.notEqual(updated, initial);
  assert.notEqual(
    await claudeSessionConfig.fingerprint(f.target, f.cwd, { ...f.env, EXAMPLE_SECRET: 'private' }),
    updated,
  );
});

test('Claude idle configuration includes settings, rules, and enabled plugin changes', async (t) => {
  const f = await fixture(t);
  const plugin = join(f.root, 'installed-plugin');
  await f.put(
    join(f.config, 'settings.json'),
    JSON.stringify({ hooks: { Stop: [] }, enabledPlugins: { example: true } }),
  );
  await f.put(
    join(f.config, 'plugins/installed_plugins.json'),
    JSON.stringify({ plugins: { example: [{ installPath: plugin }] } }),
  );
  await f.put(join(plugin, 'skills/example/SKILL.md'), 'One skill.');
  const first = await f.digest();
  assert.ok(first);
  await f.put(join(plugin, 'skills/example/SKILL.md'), 'Changed skill.');
  const second = await f.digest();
  assert.notEqual(second, first);
  await f.put(join(f.cwd, '.claude/rules/security.md'), 'Ask before publishing.');
  assert.notEqual(await f.digest(), second);
});

test('Claude idle configuration ignores transcript and credential churn but observes project memory', async (t) => {
  const f = await fixture(t);
  const initial = await f.digest();
  assert.ok(initial);
  await f.put(join(f.config, '.credentials.json'), '{"token":"do-not-read"}');
  const project = f.cwd.replace(/[^a-zA-Z0-9]/g, '-');
  await f.put(join(f.config, 'projects', project, 'session.jsonl'), '{"message":"not-config"}');
  assert.equal(await f.digest(), initial);
  await f.put(join(f.config, 'projects', project, 'memory/MEMORY.md'), 'Current project preference.');
  assert.notEqual(await f.digest(), initial);
});

test('Claude idle configuration falls back to cold start for unknown config sources or unreadable large extensions', async (t) => {
  const f = await fixture(t);
  assert.equal(
    await claudeSessionConfig.fingerprint({ ...f.target, args: ['--settings', 'custom.json'] }, f.cwd, f.env),
    undefined,
  );
  assert.equal(await claudeSessionConfig.fingerprint({ ...f.target, environment: 'wsl' }, f.cwd, f.env), undefined);
  await f.put(join(f.config, 'settings.json'), '{"enabledPlugins":{"missing":true}}');
  assert.equal(await f.digest(), undefined);
  await f.put(join(f.config, 'settings.json'), '{}');
  await f.put(join(f.config, 'skills/large.md'), 'x'.repeat(4 * 1024 * 1024 + 1));
  assert.equal(await f.digest(), undefined);
});

test('Claude idle configuration changes when previously missing project settings are created', async (t) => {
  const f = await fixture(t);
  const initial = await f.digest();
  await f.put(join(f.cwd, '.claude/settings.local.json'), '{"permissions":{"deny":["Bash"]}}');
  assert.notEqual(await f.digest(), initial);
  await f.put(join(f.cwd, '.claude/settings.local.json'), 'invalid json');
  assert.equal(await f.digest(), undefined);
});

test('Imported settings still contribute plugin and memory sources', async (t) => {
  const f = await fixture(t);
  const plugin = join(f.root, 'plugin');
  await f.put(join(f.cwd, 'CLAUDE.md'), '@.claude/settings.json');
  await f.put(join(f.cwd, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { example: true } }));
  await f.put(
    join(f.config, 'plugins/installed_plugins.json'),
    JSON.stringify({ plugins: { example: [{ installPath: plugin }] } }),
  );
  await f.put(join(plugin, 'skills/one/SKILL.md'), 'One');
  const before = await f.digest();
  assert.ok(before);
  await f.put(join(plugin, 'skills/one/SKILL.md'), 'Two');
  assert.notEqual(await f.digest(), before);
});

test('Background hooks and oversized worktree pointers decline idle reuse', async (t) => {
  const f = await fixture(t);
  await f.put(
    join(f.config, 'settings.json'),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'example', async: true }] }] } }),
  );
  assert.equal(await f.digest(), undefined);
  await f.put(join(f.config, 'settings.json'), '{}');
  await f.put(join(f.cwd, '.git'), 'x'.repeat(16_385));
  assert.equal(await f.digest(), undefined);
});

test('Managed fragments participate in background-hook gates and memory invalidation', async (t) => {
  const f = await fixture(t);
  const managed =
    process.platform === 'win32'
      ? join(f.env.ProgramFiles, 'ClaudeCode')
      : isolatedUserPath(
          process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode' : '/etc/claude-code',
        );
  const fragment = join(managed, 'managed-settings.d', '90-fixture.json');
  t.after(() => rm(fragment, { force: true }));
  const memory = join(f.root, 'managed-memory');
  await f.put(fragment, JSON.stringify({ autoMemoryDirectory: memory }));
  await f.put(join(memory, 'MEMORY.md'), 'One');
  const before = await f.digest();
  assert.ok(before);
  await f.put(join(memory, 'MEMORY.md'), 'Two');
  assert.notEqual(await f.digest(), before);
  await f.put(fragment, JSON.stringify({ hooks: { Stop: [{ hooks: [{ async: true }] }] } }));
  assert.equal(await f.digest(), undefined);
});

test('A previously catalogued rule expands its imports when CLAUDE.md references it', async (t) => {
  const f = await fixture(t);
  await f.put(join(f.root, '.claude/rules/common.md'), '@../../policy.md');
  await f.put(join(f.root, 'policy.md'), 'One');
  await f.put(join(f.cwd, 'CLAUDE.md'), '@../.claude/rules/common.md');
  const before = await f.digest();
  assert.ok(before);
  await f.put(join(f.root, 'policy.md'), 'Two');
  assert.notEqual(await f.digest(), before);
});
