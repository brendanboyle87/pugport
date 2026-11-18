import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Dirent, promises as fsPromises } from 'node:fs';
import { codexMcpTables, object, parseLenientJson, parseMcpInput, skillInfo, skippedFolders } from './extensions.ts';
import type { Extension, McpExtension, SyncSource } from '../shared/extensions.ts';
import { claudeConfigFile, codexHome } from './mcp-connect.ts';

export function discoverPaths(options: {
  platform: NodeJS.Platform;
  home: string;
  appData: string;
  env: NodeJS.ProcessEnv;
}) {
  const p = options.platform === 'win32' ? path.win32 : path.posix;
  const host = { ...options, path: p };
  const claudeDir =
    options.env.CLAUDE_CONFIG_DIR && p.isAbsolute(options.env.CLAUDE_CONFIG_DIR)
      ? options.env.CLAUDE_CONFIG_DIR
      : p.join(options.home, '.claude');
  const codexDir = codexHome(host);
  const store =
    options.platform === 'win32' && options.env.LOCALAPPDATA
      ? p.join(
          options.env.LOCALAPPDATA,
          'Packages',
          'Claude_*',
          'LocalCache',
          'Roaming',
          'Claude',
          'claude_desktop_config.json',
        )
      : undefined;
  return {
    agentsSkills: p.join(options.home, '.agents', 'skills'),
    claudeSkills: p.join(claudeDir, 'skills'),
    codexSkills: p.join(codexDir, 'skills'),
    pluginCache: p.join(claudeDir, 'plugins', 'cache'),
    installedPlugins: p.join(claudeDir, 'plugins', 'installed_plugins.json'),
    pluginSettings: p.join(claudeDir, 'settings.json'),
    claudeConfig: claudeConfigFile(host),
    codexConfig: p.join(codexDir, 'config.toml'),
    desktopConfigs: [p.join(options.appData, 'Claude', 'claude_desktop_config.json'), ...(store ? [store] : [])],
  };
}

export function loginSensitive(name: string, description: string): boolean {
  return (
    !name.trim() ||
    !description.trim() ||
    /browser|logged-in|login|cookies|session|chrome/i.test(`${name} ${description}`)
  );
}

export type DiscoveryPaths = ReturnType<typeof discoverPaths>;
export type DiscoveryFs = Pick<typeof fsPromises, 'readFile' | 'readdir' | 'stat' | 'realpath'>;
/** Skill folder → what was read from it, reused while its files' stat signature is unchanged. Owned by the caller. */
export type SkillCache = Map<string, { signature: string; name: string; description: string; hash?: string }>;
type McpDefinition = Omit<McpExtension, 'id' | 'enabled' | 'installedAt' | 'source'>;
export type Found =
  | {
      kind: 'skill';
      name: string;
      description: string;
      path: string;
      loginSensitive: boolean;
      source: SyncSource;
      hash?: string;
      pluginRoot?: string;
    }
  | { kind: 'mcp'; name: string; definition: McpDefinition; source: SyncSource; pluginRoot?: string };

const ignored = new Set(['pugport', 'pugport-app', 'comborunner']);
const slashed = (from: string, to: string) => path.relative(from, to).replace(/\\/g, '/') || '.';

async function entries(fs: DiscoveryFs, folder: string) {
  try {
    return await fs.readdir(folder, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Whether to descend into an entry; a symbolic link or junction is followed once per real path. */
async function folderEntry(fs: DiscoveryFs, parent: string, entry: Dirent, seen: Set<string>) {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    const file = path.join(parent, entry.name);
    if (!(await fs.stat(file)).isDirectory()) return false;
    const real = await fs.realpath(file);
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  } catch {
    return false;
  }
}

async function skillFolders(fs: DiscoveryFs, root: string): Promise<string[]> {
  const result: string[] = [];
  const seen = new Set<string>();
  async function walk(folder: string, depth: number) {
    const list = await entries(fs, folder);
    if (list.some((e) => e.isFile() && e.name.toLowerCase() === 'skill.md')) {
      result.push(folder);
      return;
    }
    if (depth === 0 || result.length >= 500) return;
    for (const e of list)
      if (!e.name.startsWith('.') && !skippedFolders.has(e.name) && (await folderEntry(fs, folder, e, seen)))
        await walk(path.join(folder, e.name), depth - 1);
  }
  await walk(root, 4);
  return result;
}

/** A skill's files and their stat signature, or undefined when limits or links stop a complete listing. */
async function listSkill(fs: DiscoveryFs, root: string) {
  const files: { rel: string; file: string; size: number }[] = [];
  const stamps: string[] = [];
  async function walk(dir: string): Promise<boolean> {
    let list;
    try {
      list = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of list) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!skippedFolders.has(e.name) && !(await walk(file))) return false;
      } else if (e.isFile()) {
        const s = await fs.stat(file);
        const rel = slashed(root, file);
        files.push({ rel, file, size: s.size });
        stamps.push(`${rel}\0${s.mtimeMs}:${s.size}`);
        if (files.length > 500) return false;
      } else return false;
    }
    return true;
  }
  try {
    if (!(await walk(root))) return undefined;
  } catch {
    return undefined;
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { files, signature: stamps.sort().join('\n') };
}

async function skillHash(fs: DiscoveryFs, files: { rel: string; file: string; size: number }[]) {
  if (files.reduce((sum, f) => sum + f.size, 0) > 20 * 1024 * 1024) return undefined;
  const hash = createHash('sha256');
  try {
    for (const { rel, file } of files) {
      const data = await fs.readFile(file);
      const content =
        path.basename(file).toLowerCase() === 'skill.md'
          ? Buffer.from(data.toString('utf8').replace(/\r\n?/g, '\n'))
          : data;
      hash.update(`${Buffer.byteLength(rel)}:${rel}:${content.length}:`).update(content);
    }
  } catch {
    return undefined;
  }
  return hash.digest('hex');
}

export async function hashSkillFolder(
  fs: DiscoveryFs,
  folder: string,
  cache?: Map<string, { signature: string; hash?: string }>,
) {
  const listing = await listSkill(fs, folder);
  if (!listing) return undefined;
  const cached = cache?.get(folder);
  if (cached?.signature === listing.signature) return cached.hash;
  const hash = await skillHash(fs, listing.files);
  if (hash) cache?.set(folder, { signature: listing.signature, hash });
  return hash;
}

type Plugin = { name: string; id: string; dir: string; root: string };

export async function discover(
  paths: DiscoveryPaths,
  fs: DiscoveryFs,
  cache?: SkillCache,
): Promise<{ found: Found[]; errors: string[] }> {
  const found: Found[] = [];
  const errors: string[] = [];
  const visited = new Set<string>();
  async function read(file: string): Promise<string | undefined> {
    try {
      return await fs.readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(`无法读取 ${file}`);
      return undefined;
    }
  }
  async function json(file: string): Promise<Record<string, unknown>> {
    const text = await read(file);
    if (text === undefined) return {};
    try {
      return object(parseLenientJson(text));
    } catch {
      errors.push(`无法读取 ${file}`);
      return {};
    }
  }
  async function skills(root: string, origin: SyncSource['origin'], plugin?: Plugin) {
    for (const folder of await skillFolders(fs, root)) {
      visited.add(folder);
      const listing = await listSkill(fs, folder);
      let info = listing && cache?.get(folder);
      if (!info || info.signature !== listing?.signature) {
        const entry = (await entries(fs, folder)).find((e) => e.isFile() && e.name.toLowerCase() === 'skill.md');
        const text = entry && (await read(path.join(folder, entry.name)));
        if (text === undefined) continue;
        const { name, description } = skillInfo(text, folder);
        const hash = listing && (await skillHash(fs, listing.files));
        info = { signature: listing?.signature ?? '', name, description, hash };
        if (listing) cache?.set(folder, info);
      }
      if (!info.hash) errors.push(`无法完整比较 ${folder}`);
      const name = plugin ? `${plugin.name}:${info.name}` : info.name;
      found.push({
        kind: 'skill',
        name,
        description: info.description,
        path: await fs.realpath(folder).catch(() => folder),
        loginSensitive: loginSensitive(name, info.description),
        // The folder, not the frontmatter name, identifies a skill; a plugin's version folder is left out.
        source: plugin
          ? { origin, file: plugin.dir, key: `${plugin.id}/${slashed(plugin.root, folder)}`, plugin: plugin.name }
          : { origin, file: root, key: slashed(root, folder) },
        hash: info.hash,
        ...(plugin ? { pluginRoot: plugin.root } : {}),
      });
    }
  }
  await skills(paths.agentsSkills, 'agents');
  await skills(paths.claudeSkills, 'claude');
  await skills(paths.codexSkills, 'codex');

  // Installed plugins only; scanning the cache is the fallback when Claude Code's list does not exist.
  const listed = await fs.stat(paths.installedPlugins).then(
    () => true,
    () => false,
  );
  const enabled = object((await json(paths.pluginSettings)).enabledPlugins);
  const candidates: { name: string; market: string; installPaths: string[] }[] = [];
  if (listed) {
    for (const [id, records] of Object.entries(object((await json(paths.installedPlugins)).plugins))) {
      const at = id.lastIndexOf('@');
      const global = (Array.isArray(records) ? records : [records])
        .map(object)
        .filter((r) => r.scope !== 'project' && r.scope !== 'local' && !r.projectPath);
      if (at > 0 && global.length)
        candidates.push({
          name: id.slice(0, at),
          market: id.slice(at + 1),
          installPaths: global.map((r) => r.installPath).filter((p): p is string => typeof p === 'string'),
        });
    }
  } else {
    for (const market of await entries(fs, paths.pluginCache))
      if (market.isDirectory() && !market.name.startsWith('.'))
        for (const plugin of await entries(fs, path.join(paths.pluginCache, market.name)))
          if (plugin.isDirectory() && !plugin.name.startsWith('.'))
            candidates.push({ name: plugin.name, market: market.name, installPaths: [] });
  }
  const pluginRoots: Plugin[] = [];
  for (const { name, market, installPaths } of candidates) {
    const id = `${name}@${market}`;
    if (enabled[id] === false || [name, market].some((part) => /[\\/]|^\.\.?$/.test(part))) continue;
    const dir = path.join(paths.pluginCache, market, name);
    const versions: string[] = [];
    for (const v of await entries(fs, dir)) {
      if (!v.isDirectory() || v.name.startsWith('.')) continue;
      const file = path.join(dir, v.name);
      // Claude Code marks a version it replaced or uninstalled with this file before deleting it.
      const orphaned = await fs.stat(path.join(file, '.orphaned_at')).then(
        () => true,
        () => false,
      );
      if (!orphaned) versions.push(file);
    }
    let chosen = versions.find((v) => installPaths.some((p) => path.resolve(p) === path.resolve(v)));
    if (!chosen) {
      const dated = await Promise.all(
        versions.map(async (file) => ({ file, mtime: (await fs.stat(file).catch(() => undefined))?.mtimeMs ?? 0 })),
      );
      chosen = dated.sort((a, b) => b.mtime - a.mtime || (a.file < b.file ? -1 : 1))[0]?.file;
    }
    if (!chosen) continue;
    const plugin = { name, id, dir, root: chosen };
    await skills(path.join(chosen, 'skills'), 'claude-plugin', plugin);
    pluginRoots.push(plugin);
  }
  if (cache) for (const folder of cache.keys()) if (!visited.has(folder)) cache.delete(folder);

  function addMcp(servers: Record<string, unknown>, file: string, origin: SyncSource['origin'], plugin?: Plugin) {
    const definitions = Object.keys(servers).length ? parseMcpInput(JSON.stringify({ mcpServers: servers })) : [];
    for (const definition of definitions) {
      if (plugin) {
        const expand = (value: string) => value.replaceAll('${CLAUDE_PLUGIN_ROOT}', plugin.root);
        for (const key of ['command', 'cwd', 'url'] as const)
          if (definition[key] !== undefined) definition[key] = expand(definition[key]!);
        if (definition.args) definition.args = definition.args.map(expand);
        for (const key of ['env', 'headers'] as const)
          if (definition[key])
            definition[key] = Object.fromEntries(
              Object.entries(definition[key]!).map(([name, value]) => [name, expand(value)]),
            );
      }
      if (!ignored.has(definition.name.toLowerCase()))
        found.push({
          kind: 'mcp',
          name: definition.name,
          definition,
          source: plugin
            ? {
                origin,
                file: plugin.dir,
                key: `${plugin.id}/${slashed(plugin.root, file)}#${definition.name}`,
                plugin: plugin.name,
              }
            : { origin, file, key: definition.name },
          ...(plugin ? { pluginRoot: plugin.root } : {}),
        });
    }
  }
  async function mcp(file: string, origin: SyncSource['origin'], codex = false, plugin?: Plugin) {
    const text = await read(file);
    if (text === undefined) return;
    try {
      if (codex) addMcp(codexServers(text), file, origin);
      else {
        const root = object(parseLenientJson(text));
        addMcp(object(root.mcpServers ?? (plugin ? root : undefined)), file, origin, plugin);
      }
    } catch {
      errors.push(`无法读取 ${file}`);
    }
  }
  await mcp(paths.claudeConfig, 'claude');
  await mcp(paths.codexConfig, 'codex', true);
  for (const plugin of pluginRoots) {
    const first = found.length;
    await mcp(path.join(plugin.root, '.mcp.json'), 'claude-plugin', false, plugin);
    const manifestFile = path.join(plugin.root, '.claude-plugin', 'plugin.json');
    const manifest = await json(manifestFile);
    const declared = manifest.mcpServers;
    for (const rel of Array.isArray(declared) ? declared : [declared]) {
      if (rel && typeof rel === 'object' && !Array.isArray(rel)) {
        addMcp(object(rel), manifestFile, 'claude-plugin', plugin);
        continue;
      }
      if (typeof rel !== 'string' || !rel.startsWith('./')) continue;
      const file = path.resolve(plugin.root, rel);
      const within = path.relative(plugin.root, file);
      if (within.startsWith('..') || path.isAbsolute(within)) continue;
      try {
        const realRel = path.relative(await fs.realpath(plugin.root), await fs.realpath(file));
        if (!realRel.startsWith('..') && !path.isAbsolute(realRel)) await mcp(file, 'claude-plugin', false, plugin);
      } catch {
        /* Optional manifest path is unavailable. */
      }
    }
    const unique = new Set<string>();
    for (let index = found.length - 1; index >= first; index--) {
      const key = found[index]!.name.toLowerCase();
      if (unique.has(key)) found.splice(index, 1);
      else unique.add(key);
    }
  }
  for (const file of paths.desktopConfigs) {
    if (!file.includes('*')) await mcp(file, 'claude-desktop');
    else {
      const packages = file.slice(0, file.indexOf('*'));
      const parent = path.dirname(packages);
      const prefix = path.basename(packages);
      for (const e of await entries(fs, parent))
        if (e.isDirectory() && e.name.startsWith(prefix))
          await mcp(
            path.join(parent, e.name, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'),
            'claude-desktop',
          );
    }
  }
  return { found, errors };
}

/** Codex servers with its environment keys as `${VAR}` references, resolved at run time, never here. */
function codexServers(text: string): Record<string, unknown> {
  const servers: Record<string, unknown> = {};
  for (const [name, table] of codexMcpTables(text)) {
    if (table.enabled === false) continue;
    const headers: Record<string, unknown> = { ...object(table.http_headers), ...object(table.headers) };
    for (const [header, variable] of Object.entries(object(table.env_http_headers)))
      if (typeof variable === 'string') headers[header] = `\${${variable}}`;
    if (typeof table.bearer_token_env_var === 'string')
      headers.Authorization = `Bearer \${${table.bearer_token_env_var}}`;
    // env_vars needs nothing: the server process inherits the environment.
    servers[name] = { ...table, headers };
  }
  return servers;
}

export async function fingerprint(paths: DiscoveryPaths, fs: DiscoveryFs): Promise<string> {
  const records: string[] = [];
  const seen = new Set<string>();
  async function stat(file: string) {
    try {
      const s = await fs.stat(file);
      records.push(`${file}\0${s.mtimeMs}:${s.size}`);
    } catch {
      records.push(`${file}\0missing`);
    }
  }
  async function walk(dir: string, top: boolean) {
    await stat(dir);
    for (const e of await entries(fs, dir)) {
      const file = path.join(dir, e.name);
      if (await folderEntry(fs, dir, e, seen)) {
        if (!skippedFolders.has(e.name) && !(top && e.name.startsWith('.'))) await walk(file, false);
      } else if (e.isFile()) await stat(file);
    }
  }
  for (const file of [paths.claudeConfig, paths.codexConfig, paths.installedPlugins, paths.pluginSettings])
    await stat(file);
  for (const root of [paths.agentsSkills, paths.claudeSkills, paths.codexSkills, paths.pluginCache])
    await walk(root, true);
  for (const file of paths.desktopConfigs) {
    if (!file.includes('*')) await stat(file);
    else {
      const prefix = file.slice(0, file.indexOf('*'));
      const parent = path.dirname(prefix);
      await stat(parent);
      for (const e of await entries(fs, parent))
        if (e.isDirectory() && e.name.startsWith(path.basename(prefix)))
          await stat(path.join(parent, e.name, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'));
    }
  }
  return records.sort().join('\n');
}

type Existing = Extension & { contentHash?: string };
export type SyncPlan = {
  add: (Found & { sync: { sources: SyncSource[] } })[];
  update: { item: Existing; found: Found; sources: SyncSource[] }[];
  markRemoved: Existing[];
  clearRemoved: Existing[];
};
const sourceKey = (source: SyncSource) => `${source.origin}|${source.file}|${source.key}`;
function mcpIdentity(
  mcp: Pick<McpExtension, 'transport' | 'command' | 'args' | 'cwd' | 'url' | 'env' | 'headers' | 'secretValues'>,
) {
  const sorted = (value?: Record<string, string>) => Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([
    mcp.transport,
    mcp.command ?? '',
    mcp.args ?? [],
    mcp.cwd ?? '',
    mcp.url ?? '',
    sorted(mcp.env),
    sorted(mcp.headers),
    sorted(mcp.secretValues?.args),
    sorted(mcp.secretValues?.url),
  ]);
}
function equalContent(a: Found, b: Found | Existing): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'mcp' && b.kind === 'mcp')
    return mcpIdentity(a.definition) === mcpIdentity('definition' in b ? b.definition : b);
  if (a.kind === 'skill' && b.kind === 'skill') {
    if (path.resolve(a.path) === path.resolve(b.path)) return true;
    const other = b as { hash?: string; contentHash?: string };
    return !!a.hash && a.hash === (other.hash ?? other.contentHash);
  }
  return false;
}
export function syncSourceLabel(source: SyncSource): string {
  switch (source.origin) {
    case 'claude':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'agents':
      return '共享技能目录';
    case 'claude-plugin':
      return `Claude 插件：${source.plugin ?? ''}`;
    case 'claude-desktop':
      return 'Claude Desktop';
    case 'pugport':
      return 'PugPort 内置';
  }
}

/**
 * What to add, update and mark removed. A found skill is the same as an item at the same folder (discover
 * returns real paths, so the caller passes manual items' real paths) or with the same hash (batch 2 supplies
 * `contentHash` for PugPort-managed copies).
 */
export function planSync(items: Existing[], found: Found[], dismissed: Iterable<string>): SyncPlan {
  const dismiss = new Set(dismissed);
  const active = found.filter((item) => !dismiss.has(sourceKey(item.source)));
  const used = new Set<Found>();
  const take = (list: Found[]) => (list.forEach((f) => used.add(f)), list);
  const alike = (f: Found, like: Found | Existing, name: string) =>
    !used.has(f) && f.name.toLowerCase() === name.toLowerCase() && equalContent(f, like);
  const plan: SyncPlan = { add: [], update: [], markRemoved: [], clearRemoved: [] };
  const names = new Set(items.map((item) => `${item.kind}|${item.name.toLowerCase()}`));
  const groups = new Map<Existing, Found[]>();
  // First every item keeps the sources it already has, so the order of items cannot move a source.
  for (const item of items) {
    const keys = new Set((item.sync?.sources ?? []).map(sourceKey));
    const own = active.filter((f) => !used.has(f) && keys.has(sourceKey(f.source)));
    if (own.length) groups.set(item, take(own));
  }
  for (const group of groups.values()) group.push(...take(active.filter((f) => alike(f, group[0]!, group[0]!.name))));
  for (const item of items) {
    if (groups.has(item)) continue;
    const match = active.find((f) => alike(f, item, item.name));
    if (match) groups.set(item, [...take([match]), ...take(active.filter((f) => alike(f, match, match.name)))]);
    else if (item.sync?.sources.length && !item.sync.removedAt) plan.markRemoved.push(item);
  }
  for (const item of items) {
    const group = groups.get(item);
    if (!group) continue;
    plan.update.push({ item, found: group[0]!, sources: group.map((f) => f.source) });
    if (item.sync?.removedAt) plan.clearRemoved.push(item);
  }
  for (const f of active) {
    if (used.has(f)) continue;
    const group = [...take([f]), ...take(active.filter((other) => alike(other, f, f.name)))];
    let name = f.name;
    if (names.has(`${f.kind}|${name.toLowerCase()}`)) {
      const base = `${name} (${syncSourceLabel(f.source)})`;
      name = base;
      for (let n = 2; names.has(`${f.kind}|${name.toLowerCase()}`); n++) name = `${base} (${n})`;
    }
    names.add(`${f.kind}|${name.toLowerCase()}`);
    plan.add.push({ ...f, name, sync: { sources: group.map((other) => other.source) } });
  }
  return plan;
}
