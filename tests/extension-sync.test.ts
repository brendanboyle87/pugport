import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  discover,
  discoverPaths,
  fingerprint,
  loginSensitive,
  planSync,
  type Found,
  type SkillCache,
} from '../src/server/extension-sync.ts';
import { parseCodexMcp } from '../src/server/extensions.ts';
import type { Extension, SyncSource } from '../src/shared/extensions.ts';

test('discovery paths honor absolute overrides on each platform', () => {
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    const win = platform === 'win32';
    const root = win ? 'C:\\test' : '/test';
    const separator = win ? '\\' : '/';
    const paths = discoverPaths({
      platform,
      home: root,
      appData: root,
      env: {
        CLAUDE_CONFIG_DIR: `${root}${separator}claude`,
        CODEX_HOME: `${root}${separator}codex`,
        LOCALAPPDATA: root,
      },
    });
    assert.equal(paths.claudeConfig, `${root}${separator}claude${separator}.claude.json`);
    assert.equal(paths.codexConfig, `${root}${separator}codex${separator}config.toml`);
    assert.equal(paths.desktopConfigs.length, win ? 2 : 1);
  }
});

test('discovery reads synthetic homes, plugins, MCP sources and redacts parse errors', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-test-'));
  const paths = discoverPaths({ platform: process.platform, home, appData: path.join(home, 'app'), env: {} });
  async function put(file: string, text: string) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  }
  const skill = '---\nname: common\ndescription: format text\n---\nbody\n';
  for (const root of [paths.agentsSkills, paths.claudeSkills, paths.codexSkills])
    await put(path.join(root, 'common', 'SKILL.md'), skill);
  await put(path.join(paths.codexSkills, '.system', 'hidden', 'SKILL.md'), skill);
  const old = path.join(paths.pluginCache, 'market', 'sample', '1');
  const newer = path.join(paths.pluginCache, 'market', 'sample', '2');
  await put(path.join(old, 'skills', 'tool', 'SKILL.md'), skill);
  await put(path.join(old, '.mcp.json'), '{"mcpServers":{"plugin-tool":{"command":"node"}}}');
  await put(path.join(old, '.claude-plugin', 'plugin.json'), '{"mcpServers":{"manifest-tool":{"command":"node"}}}');
  await put(path.join(newer, 'skills', 'tool', 'SKILL.md'), skill);
  await put(path.join(paths.pluginCache, 'market', 'disabled', '1', 'skills', 'tool', 'SKILL.md'), skill);
  await put(
    path.join(home, '.claude', 'plugins', 'marketplaces', 'market', 'bad', 'skills', 'tool', 'SKILL.md'),
    skill,
  );
  await put(paths.installedPlugins, JSON.stringify({ plugins: { 'sample@market': [{ installPath: old }] } }));
  await put(paths.pluginSettings, JSON.stringify({ enabledPlugins: { 'disabled@market': false } }));
  await put(
    paths.claudeConfig,
    JSON.stringify({
      mcpServers: {
        good: { command: 'node', env: { KEY: 'sk-synthetic-TEST-0001' } },
        'pugport-app': { command: 'node' },
        off: { command: 'node', disabled: true },
      },
      projects: { x: { mcpServers: { private: { command: 'node' } } } },
    }),
  );
  await put(
    paths.codexConfig,
    '[mcp_servers.remote]\nurl = "https://example.invalid"\nbearer_token_env_var = "TOKEN"\nenv_vars = ["OTHER"]\n[mcp_servers.remote.env_http_headers]\nX-Test = "HEADER"\n[mcp_servers.local]\ncommand = "node"\n[mcp_servers.local.env]\nKEY = "${VAR}"\n[mcp_servers.off]\ncommand = "node"\nenabled = false\n',
  );
  await put(
    paths.desktopConfigs[0]!,
    '{ // synthetic\n "mcpServers": {"desktop": {"url":"https://example.invalid", "headers": {"Authorization":"Bearer synthetic-HDR-0002"},},},}',
  );
  const output = await discover(paths, fs);
  assert.deepEqual(output.errors, []);
  const skills = output.found.filter((f) => f.kind === 'skill');
  assert.equal(skills.length, 4);
  assert.equal(skills.filter((f) => f.name === 'common').length, 3);
  assert.equal(skills.find((f) => f.name === 'sample:common')?.pluginRoot, old);
  const mcps = output.found.filter((f) => f.kind === 'mcp');
  assert.deepEqual(mcps.map((f) => f.name).sort(), [
    'desktop',
    'good',
    'local',
    'manifest-tool',
    'plugin-tool',
    'remote',
  ]);
  assert.equal(mcps.find((f) => f.name === 'remote')?.definition.headers?.Authorization, 'Bearer ${TOKEN}');
  assert.equal(mcps.find((f) => f.name === 'remote')?.definition.headers?.['X-Test'], '${HEADER}');
  // env_vars adds nothing: the server inherits the environment.
  assert.equal(mcps.find((f) => f.name === 'remote')?.definition.env, undefined);
  assert.equal(mcps.find((f) => f.name === 'local')?.definition.env?.KEY, '${VAR}');
  await put(paths.claudeConfig, '{ "sk-synthetic-TEST-0001": ');
  const bad = await discover(paths, fs);
  assert.ok(bad.errors.includes(`无法读取 ${paths.claudeConfig}`));
  assert.ok(!JSON.stringify(bad.errors).includes('sk-synthetic-TEST-0001'));
  assert.ok(!JSON.stringify(bad).includes('sk-synthetic-TEST-0001'));
  // Codex's reader skips an entry it cannot read and keeps the rest of the file.
  await put(
    paths.codexConfig,
    '[mcp_servers.fine]\ncommand = "node"\n[mcp_servers.bad]\ncommand = "sk-synthetic-TEST-0001\n',
  );
  const badToml = await discover(paths, fs);
  assert.ok(badToml.found.some((f) => f.kind === 'mcp' && f.name === 'fine'));
  assert.ok(!badToml.found.some((f) => f.kind === 'mcp' && f.name === 'bad'));
  assert.ok(!JSON.stringify(badToml).includes('sk-synthetic-TEST-0001'));
  await fs.rm(paths.installedPlugins);
  const now = new Date();
  await fs.utimes(old, new Date(now.getTime() - 10000), new Date(now.getTime() - 10000));
  await fs.utimes(newer, now, now);
  const fallback = await discover(paths, fs);
  const selected = fallback.found.find((f) => f.kind === 'skill' && f.name === 'sample:common');
  assert.equal(selected?.kind === 'skill' ? selected.pluginRoot : undefined, newer);
});

test('fingerprints read metadata only and detect additions', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-fp-'));
  const paths = discoverPaths({ platform: process.platform, home, appData: home, env: {} });
  let reads = 0;
  const counted = {
    ...fs,
    readFile: ((...args: Parameters<typeof fs.readFile>) => {
      reads++;
      return fs.readFile(...args);
    }) as typeof fs.readFile,
  };
  const before = await fingerprint(paths, counted);
  assert.equal(await fingerprint(paths, counted), before);
  assert.equal(reads, 0);
  await fs.mkdir(path.join(paths.agentsSkills, 'new'), { recursive: true });
  await fs.writeFile(path.join(paths.agentsSkills, 'new', 'SKILL.md'), 'new');
  assert.notEqual(await fingerprint(paths, counted), before);
  const after = await fingerprint(paths, counted);
  await fs.writeFile(path.join(paths.agentsSkills, 'new', 'SKILL.md'), 'different');
  assert.notEqual(await fingerprint(paths, counted), after);
});

test('MCP equality includes secret values and references without hashing them', () => {
  const base = {
    kind: 'mcp' as const,
    name: 'server',
    source: { origin: 'claude' as const, file: 'one', key: 'server' },
    definition: {
      kind: 'mcp' as const,
      name: 'server',
      transport: 'stdio' as const,
      command: 'node',
      env: { KEY: '${A}' },
    },
  };
  const identical = { ...base, source: { origin: 'codex' as const, file: 'two', key: 'server' } };
  const different = {
    ...identical,
    source: { origin: 'agents' as const, file: 'three', key: 'server' },
    definition: { ...base.definition, env: { KEY: '${B}' } },
  };
  const plan = planSync([], [base, identical, different], []);
  assert.equal(plan.add.length, 2);
  assert.equal(plan.add[0]?.sync.sources.length, 2);
  assert.equal(plan.add[1]?.name, 'server (共享技能目录)');
});

test('plan adopts a manual item, merges identical sources and preserves names on clash', () => {
  const source = (origin: 'agents' | 'codex' | 'claude', file: string) => ({ origin, file, key: 'common' });
  const one = {
    kind: 'skill' as const,
    name: 'common',
    description: 'text',
    loginSensitive: false,
    path: 'C:/synthetic/one',
    hash: 'same',
    source: source('agents', 'one'),
  };
  const two = { ...one, path: 'C:/synthetic/two', source: source('codex', 'two') };
  const different = { ...one, path: 'C:/synthetic/three', hash: 'different', source: source('claude', 'three') };
  const item = {
    kind: 'skill' as const,
    id: 'id',
    name: 'common',
    description: 'text',
    path: one.path,
    source: 'manual',
    managed: false,
    enabled: true,
    installedAt: 'now',
  };
  const plan = planSync([item], [one, two, different], []);
  assert.equal(plan.update[0]?.sources.length, 2);
  assert.equal(plan.update[0]?.item.name, 'common');
  assert.equal(plan.add[0]?.name, 'common (Claude Code)');
  assert.equal(planSync([], [one], ['agents|one|common']).add.length, 0);
  const existing = { ...item, name: 'common (Claude Code)', sync: { sources: [different.source] } };
  const rescan = planSync([item, existing], [one, two, different], []);
  assert.equal(rescan.add.length, 0);
  assert.equal(
    rescan.update.find((update) => update.item.id === existing.id && update.item.name === existing.name)?.found.source
      .file,
    'three',
  );
  assert.equal(planSync([existing], [], []).markRemoved.length, 1);
  assert.equal(
    planSync([{ ...existing, sync: { ...existing.sync, removedAt: 'then' } }], [different], []).clearRemoved.length,
    1,
  );
});

test('login sensitivity includes browser terms and missing metadata', () => {
  assert.equal(loginSensitive('ego-browser', 'read pages'), true);
  assert.equal(loginSensitive('helper', 'uses cookies'), true);
  assert.equal(loginSensitive('helper', ''), true);
  assert.equal(loginSensitive('formatter', 'formats text'), false);
});

async function syntheticHome(prefix: string) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const paths = discoverPaths({ platform: process.platform, home, appData: path.join(home, 'app'), env: {} });
  const put = async (file: string, text: string) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  };
  return { home, paths, put };
}
const keyOf = (source: SyncSource) => `${source.origin}|${source.file}|${source.key}`;
const asItem = (f: Found & { sync: { sources: SyncSource[] } }, id: string): Extension =>
  f.kind === 'skill'
    ? {
        kind: 'skill',
        id,
        name: f.name,
        description: f.description,
        path: f.path,
        source: 'sync',
        managed: false,
        enabled: true,
        installedAt: 'now',
        sync: f.sync,
      }
    : { ...f.definition, id, name: f.name, source: 'sync', enabled: true, installedAt: 'now', sync: f.sync };
const skillMd = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`;

test('a plugin upgrade updates its items, keeps dismissals and gives plugin MCP its root', async () => {
  const { paths, put } = await syntheticHome('sync-upgrade-');
  const dir = path.join(paths.pluginCache, 'market', 'sample');
  async function version(name: string, text: string) {
    await put(path.join(dir, name, 'skills', 'tool', 'SKILL.md'), skillMd('tool', text));
    await put(
      path.join(dir, name, '.mcp.json'),
      JSON.stringify({ mcpServers: { srv: { command: 'node', args: [name] } } }),
    );
    await put(
      paths.installedPlugins,
      JSON.stringify({ plugins: { 'sample@market': [{ scope: 'user', installPath: path.join(dir, name) }] } }),
    );
  }
  await version('1', 'formats text');
  const first = await discover(paths, fs);
  assert.equal(first.found.find((f) => f.kind === 'mcp')?.pluginRoot, path.join(dir, '1'));
  const items = planSync([], first.found, []).add.map((f, index) => asItem(f, `id${index}`));
  assert.equal(items.length, 2);
  await version('2', 'formats more text');
  await put(path.join(dir, '1', '.orphaned_at'), '1');
  const second = await discover(paths, fs);
  assert.equal(second.found.find((f) => f.kind === 'mcp')?.pluginRoot, path.join(dir, '2'));
  const plan = planSync(items, second.found, []);
  assert.equal(plan.add.length, 0);
  assert.equal(plan.markRemoved.length, 0);
  assert.equal(plan.update.length, 2);
  const skill = second.found.find((f) => f.kind === 'skill')!;
  assert.equal(skill.description, 'formats more text');
  assert.equal(planSync([], second.found, [keyOf(items[0]!.sync!.sources[0]!)]).add.length, 1);
  assert.equal(keyOf(items[0]!.sync!.sources[0]!), keyOf(skill.source));
});

test('plugin MCP replaces only CLAUDE_PLUGIN_ROOT with its own installed root', async () => {
  const { paths, put } = await syntheticHome('sync-plugin-root-');
  const root = path.join(paths.pluginCache, 'market', 'sample', '1');
  const definition = {
    command: '${CLAUDE_PLUGIN_ROOT}/bin/tool',
    args: ['${CLAUDE_PLUGIN_ROOT}/server.js', '${OTHER_VAR}'],
    cwd: '${CLAUDE_PLUGIN_ROOT}',
    env: { PLUGIN_DIR: '${CLAUDE_PLUGIN_ROOT}' },
    headers: { 'X-Plugin': '${CLAUDE_PLUGIN_ROOT}' },
  };
  await put(
    path.join(root, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        local: definition,
        remote: {
          url: 'https://example.invalid/mcp?root=${CLAUDE_PLUGIN_ROOT}',
          headers: { 'X-Plugin': '${CLAUDE_PLUGIN_ROOT}' },
        },
      },
    }),
  );
  await put(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ mcpServers: { manifest: definition } }));
  await put(
    paths.installedPlugins,
    JSON.stringify({ plugins: { 'sample@market': [{ scope: 'user', installPath: root }] } }),
  );
  await put(paths.claudeConfig, JSON.stringify({ mcpServers: { ordinary: definition } }));
  const previous = process.env.CLAUDE_PLUGIN_ROOT;
  process.env.CLAUDE_PLUGIN_ROOT = path.join(root, 'wrong');
  try {
    const found = (await discover(paths, fs)).found.filter((f) => f.kind === 'mcp');
    assert.equal(found.length, 4);
    for (const item of found) {
      if (item.source.origin !== 'claude-plugin') {
        assert.equal(item.definition.command, definition.command);
        continue;
      }
      if (item.definition.transport === 'http') {
        assert.equal(item.definition.url, 'https://example.invalid/mcp?root=' + root);
        assert.equal(item.definition.headers!['X-Plugin'], root);
        continue;
      }
      assert.equal(item.definition.command, root + '/bin/tool');
      assert.deepEqual(item.definition.args, [root + '/server.js', '${OTHER_VAR}']);
      assert.equal(item.definition.cwd, root);
      assert.equal(item.definition.env!.PLUGIN_DIR, root);
      assert.equal(item.definition.secretValues, undefined);
    }
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = previous;
  }
});

test('only listed user-scope plugins are read, orphaned versions are skipped, the cache is the fallback', async () => {
  const { paths, put } = await syntheticHome('sync-plugins-');
  const skill = skillMd('tool', 'formats text');
  for (const plugin of ['sample', 'project', 'stray'])
    await put(path.join(paths.pluginCache, 'market', plugin, '1', 'skills', 'tool', 'SKILL.md'), skill);
  await put(path.join(paths.pluginCache, 'market', 'sample', '2', 'skills', 'tool', 'SKILL.md'), skill);
  await put(path.join(paths.pluginCache, 'market', 'sample', '2', '.orphaned_at'), '1');
  await put(
    paths.installedPlugins,
    JSON.stringify({
      plugins: {
        'sample@market': [{ scope: 'user', installPath: path.join(paths.pluginCache, 'market', 'sample', '2') }],
        'project@market': [{ scope: 'project', projectPath: '/synthetic', installPath: 'unused' }],
      },
    }),
  );
  const names = async () =>
    (await discover(paths, fs)).found
      .filter((f) => f.kind === 'skill')
      .map((f) => `${f.name}@${f.kind === 'skill' ? path.basename(f.pluginRoot ?? '') : ''}`)
      .sort();
  assert.deepEqual(await names(), ['sample:tool@1']);
  await fs.rm(paths.installedPlugins);
  assert.deepEqual(await names(), ['project:tool@1', 'sample:tool@1', 'stray:tool@1']);
});

test('parseCodexMcp keeps its output while the sync path maps the Codex environment keys', async () => {
  const toml =
    '[mcp_servers.remote]\nurl = "https://example.invalid"\nbearer_token_env_var = "TOKEN"\n[mcp_servers.remote.env_http_headers]\nX-Test = "HEADER"\n[mcp_servers.local]\ncommand = "node"\nenv_vars = ["OTHER"]\n';
  assert.deepEqual(parseCodexMcp(toml), [
    { kind: 'mcp', name: 'remote', transport: 'http', url: 'https://example.invalid', headers: undefined },
    { kind: 'mcp', name: 'local', transport: 'stdio', command: 'node', args: [], env: undefined },
  ]);
  const { paths, put } = await syntheticHome('sync-codex-');
  await put(paths.codexConfig, toml);
  const found = (await discover(paths, fs)).found.flatMap((f) => (f.kind === 'mcp' ? [f.definition] : []));
  assert.deepEqual(found.find((d) => d.name === 'remote')?.headers, {
    'X-Test': '${HEADER}',
    Authorization: 'Bearer ${TOKEN}',
  });
  assert.equal(found.find((d) => d.name === 'local')?.env, undefined);
});

test('skill identity ignores .git, uses the folder as key and reads name and description like manual installs', async () => {
  const { paths, put } = await syntheticHome('sync-skills-');
  const long = 'n'.repeat(90);
  await put(path.join(paths.agentsSkills, 'a', 'SKILL.md'), skillMd('same', 'formats text'));
  await put(path.join(paths.agentsSkills, 'a', '.git', 'index'), 'synthetic');
  await put(path.join(paths.claudeSkills, 'a', 'SKILL.md'), skillMd('same', 'formats text'));
  await put(path.join(paths.codexSkills, 'b', 'SKILL.md'), `---\nname: ${long}\n---\n# Title\nFirst line.\n`);
  const first = await discover(paths, fs);
  const plan = planSync([], first.found, []);
  assert.equal(plan.add.length, 2);
  assert.equal(plan.add.find((f) => f.name === 'same')?.sync.sources.length, 2);
  const fallback = plan.add.find((f) => f.name.startsWith('n'));
  assert.equal(fallback?.name.length, 80);
  assert.equal(fallback?.kind === 'skill' && fallback.description, 'First line.');
  const items = plan.add.map((f, index) => asItem(f, `id${index}`));
  await put(path.join(paths.codexSkills, 'b', 'SKILL.md'), skillMd('renamed', 'formats text'));
  const rescan = planSync(items, (await discover(paths, fs)).found, []);
  assert.deepEqual([rescan.add.length, rescan.markRemoved.length, rescan.update.length], [0, 0, 2]);
});

test('a manual install at the same folder is adopted without a hash', () => {
  const found: Found = {
    kind: 'skill',
    name: 'common',
    description: 'formats text',
    path: path.resolve('synthetic', 'common'),
    loginSensitive: false,
    source: { origin: 'agents', file: 'root', key: 'common' },
  };
  const manual: Extension = {
    kind: 'skill',
    id: 'manual',
    name: 'common',
    description: 'formats text',
    path: found.path,
    source: 'manual',
    managed: false,
    enabled: true,
    installedAt: 'now',
  };
  const plan = planSync([manual], [found], []);
  assert.deepEqual([plan.add.length, plan.update[0]?.item.id], [0, 'manual']);
});

test('the plan does not depend on the order of existing items', () => {
  const found: Found = {
    kind: 'skill',
    name: 'x',
    description: 'formats text',
    path: path.resolve('synthetic', 'x'),
    loginSensitive: false,
    source: { origin: 'claude', file: 'root', key: 'x' },
  };
  const base = { kind: 'skill' as const, description: 'formats text', managed: false, enabled: true };
  const manual: Extension = { ...base, id: 'a', name: 'x', path: found.path, source: 'manual', installedAt: 'now' };
  const synced: Extension = {
    ...base,
    id: 'b',
    name: 'y',
    path: found.path,
    source: 'sync',
    installedAt: 'now',
    sync: { sources: [found.source] },
  };
  const summary = (items: Extension[]) => {
    const plan = planSync(items, [found], []);
    return JSON.stringify([
      plan.add.map((f) => f.name),
      plan.update.map((u) => `${u.item.id}:${u.sources.map(keyOf).join(',')}`).sort(),
      plan.markRemoved.map((item) => item.id).sort(),
    ]);
  };
  assert.equal(summary([manual, synced]), summary([synced, manual]));
  assert.equal(summary([manual, synced]), JSON.stringify([[], ['b:claude|root|x'], []]));
});

test('name clashes are per kind', () => {
  const skill: Extension = {
    kind: 'skill',
    id: 'skill',
    name: 'github',
    description: 'formats text',
    path: path.resolve('synthetic', 'github'),
    source: 'manual',
    managed: false,
    enabled: true,
    installedAt: 'now',
  };
  const mcp: Found = {
    kind: 'mcp',
    name: 'github',
    source: { origin: 'claude', file: 'config', key: 'github' },
    definition: { kind: 'mcp', name: 'github', transport: 'stdio', command: 'node' },
  };
  assert.equal(planSync([skill], [mcp], []).add[0]?.name, 'github');
});

test('a skill cache skips reading unchanged skills when only a config changed', async () => {
  const { paths, put } = await syntheticHome('sync-cache-');
  await put(path.join(paths.agentsSkills, 'a', 'SKILL.md'), skillMd('a', 'formats text'));
  await put(path.join(paths.claudeSkills, 'b', 'SKILL.md'), skillMd('b', 'formats text'));
  await put(paths.claudeConfig, '{"mcpServers":{}}');
  const reads: string[] = [];
  const counted = {
    ...fs,
    readFile: ((...args: Parameters<typeof fs.readFile>) => {
      reads.push(String(args[0]));
      return fs.readFile(...args);
    }) as typeof fs.readFile,
  };
  const cache: SkillCache = new Map();
  const first = await discover(paths, counted, cache);
  await put(paths.claudeConfig, '{"mcpServers":{"x":{"command":"node"}}}');
  reads.length = 0;
  const second = await discover(paths, counted, cache);
  const skillRoots = [paths.agentsSkills, paths.claudeSkills, paths.codexSkills, paths.pluginCache];
  assert.deepEqual(
    reads.filter((file) => skillRoots.some((root) => file.startsWith(root))),
    [],
  );
  assert.ok(reads.includes(paths.claudeConfig));
  const skills = (output: typeof first) => JSON.stringify(output.found.filter((f) => f.kind === 'skill'));
  assert.equal(skills(second), skills(first));
});

test('linked skill folders are found and fingerprinted', async (t) => {
  const { home, paths, put } = await syntheticHome('sync-link-');
  const target = path.join(home, 'elsewhere', 'linked');
  await put(path.join(target, 'SKILL.md'), skillMd('linked', 'formats text'));
  await fs.mkdir(paths.claudeSkills, { recursive: true });
  try {
    await fs.symlink(target, path.join(paths.claudeSkills, 'linked'), 'junction');
    // A link back to its parent must not loop.
    await fs.symlink(paths.claudeSkills, path.join(paths.claudeSkills, 'loop'), 'junction');
  } catch {
    t.skip('this platform refused to create the link');
    return;
  }
  const output = await discover(paths, fs);
  assert.equal(output.found.filter((f) => f.kind === 'skill' && f.name === 'linked').length, 1);
  const before = await fingerprint(paths, fs);
  await put(path.join(target, 'SKILL.md'), skillMd('linked', 'formats more text'));
  assert.notEqual(await fingerprint(paths, fs), before);
});
