import { splitCommandLine } from './command-line.ts';
import { isolatedUserPath } from './platform/under-test.ts';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import AdmZip from 'adm-zip';
import {
  extensionCatalog,
  type Extension,
  type ExtensionDraft,
  type ExtensionInstallOptions,
  type ExtensionPreview,
  type ExtensionTool,
  type ExtensionView,
  type McpExtension,
  type SkillExtension,
} from '../shared/extensions.ts';
import { McpConnection, type ToolContent } from './mcp-client.ts';
import { appDirs } from './platform/dirs.ts';
import { displayCommand } from '../shared/permission-change.ts';
import { DesktopPermissionRequired } from './permission-guards.ts';
import { secretsDirectory } from './api-providers.ts';
import { writePrivateConfig } from './private-config.ts';
import type { Locale } from '../shared/i18n/index.ts';
import { SkillSummaryJob, skillSummaryHash, validSkillSummary } from './skill-summaries.ts';
import * as discoveryFs from 'node:fs/promises';
import {
  discoverPaths,
  fingerprint,
  discover,
  planSync,
  hashSkillFolder,
  syncSourceLabel,
  type DiscoveryFs,
  type DiscoveryPaths,
  type SkillCache,
} from './extension-sync.ts';

/*
 * Installed extensions: skills and MCP tools, installed once and offered to every executor through the
 * PugPort tool bridge. Installing starts from a preview (a link, a folder or archive, a pasted
 * configuration or command, or what other AI apps on this computer already have), so the user sees what
 * will be added, and what will run, before anything is.
 *
 * Configuration lives in the user's local app data, outside the project and outside synced folders, because
 * tool settings often hold keys.
 */

type Row = Record<string, unknown>;
export const object = (value: unknown): Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
const record = (value: unknown): Record<string, string> | undefined => {
  const entries = Object.entries(object(value)).filter(([, item]) =>
    ['string', 'number', 'boolean'].includes(typeof item),
  );
  return entries.length ? Object.fromEntries(entries.map(([key, item]) => [key, String(item)])) : undefined;
};

export function extensionsDir() {
  if (process.env.COMBORUNNER_EXTENSIONS_DIR) return resolve(process.env.COMBORUNNER_EXTENSIONS_DIR);
  return appDirs().extensions;
}

/** Where older releases kept extensions (Linux: ~/.local/share/ComboRunner); read until the first save, never written. */
export function legacyExtensionsDirs(): string[] {
  if (process.env.COMBORUNNER_EXTENSIONS_DIR) return [];
  return appDirs().legacy.extensions;
}

/* ---------- Skills ---------- */

/** The name, description and instructions of a SKILL.md (YAML front matter, then Markdown). */
export function parseSkill(text: string): { name?: string; description?: string; body: string } {
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { body: text.trim() };
  const fields: Record<string, string> = {};
  const lines = match[1]!.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(lines[index]!);
    if (!line) continue;
    const [, key, raw] = line as unknown as [string, string, string];
    let value = raw.trim();
    // A block (`>`, `|`) or a plain value continued on indented lines.
    if (/^[>|][+-]?$/.test(value) || value === '') {
      const block: string[] = [];
      while (index + 1 < lines.length && (/^\s+\S/.test(lines[index + 1]!) || lines[index + 1] === '')) {
        block.push(lines[++index]!.trim());
      }
      value = value.startsWith('|') ? block.join('\n').trim() : block.join(' ').replace(/\s+/g, ' ').trim();
    } else if (/^"(.*)"$/.test(value)) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        value = value.slice(1, -1);
      }
    } else if (/^'(.*)'$/.test(value)) value = value.slice(1, -1).replace(/''/g, "'");
    else {
      while (
        index + 1 < lines.length &&
        /^\s+\S/.test(lines[index + 1]!) &&
        !/^\s+[A-Za-z0-9_-]+:/.test(lines[index + 1]!)
      )
        value += ` ${lines[++index]!.trim()}`;
    }
    fields[key] = value;
  }
  return { name: fields.name, description: fields.description, body: text.slice(match[0].length).trim() };
}

export const skippedFolders = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build']);

/** Folders holding a SKILL.md under root (root itself included); a skill's own subfolders are not searched. */
export async function findSkillFolders(root: string, depth = 4): Promise<string[]> {
  const found: string[] = [];
  const walk = async (folder: string, left: number) => {
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isFile() && entry.name.toLowerCase() === 'skill.md')) {
      found.push(folder);
      return;
    }
    if (left <= 0 || found.length >= 500) return;
    for (const entry of entries)
      if (entry.isDirectory() && !skippedFolders.has(entry.name) && !entry.name.startsWith('.'))
        await walk(join(folder, entry.name), left - 1);
  };
  await walk(root, depth);
  return found;
}

async function skillFile(folder: string) {
  const entries = await readdir(folder);
  const name = entries.find((entry) => entry.toLowerCase() === 'skill.md');
  if (!name) throw new Error('这个文件夹里没有 SKILL.md。');
  return join(folder, name);
}

async function readSkillFolder(folder: string) {
  return skillInfo(await readFile(await skillFile(folder), 'utf8'), folder);
}

/** A skill's name and description from its SKILL.md text, by the rules every install path uses. */
export function skillInfo(text: string, folder: string) {
  const parsed = parseSkill(text);
  return {
    name: (parsed.name || basename(folder)).trim().slice(0, 80),
    description: (
      parsed.description ??
      parsed.body.split(/\r?\n/).find((line) => line.trim() && !line.startsWith('#')) ??
      ''
    )
      .trim()
      .slice(0, 1024),
    body: parsed.body,
  };
}

/** A short licence name from the first licence file found from the skill folder up to the archive root. */
async function licenseOf(folder: string, top: string): Promise<string | undefined> {
  for (let current = folder; ; current = dirname(current)) {
    for (const name of ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'license', 'COPYING']) {
      const text = await readFile(join(current, name), 'utf8').catch(() => '');
      if (!text) continue;
      if (/Apache License/i.test(text)) return 'Apache-2.0';
      if (/MIT License|Permission is hereby granted, free of charge/i.test(text)) return 'MIT';
      if (/BSD/i.test(text) && /Redistribution and use/i.test(text)) return 'BSD';
      if (/GNU (?:AFFERO|GENERAL|LESSER) GENERAL PUBLIC LICENSE/i.test(text)) return 'GPL 系列';
      if (/Mozilla Public License/i.test(text)) return 'MPL-2.0';
      if (/all rights reserved/i.test(text)) return '保留所有权利（请先阅读其许可条款）';
      return '自定义许可（请先阅读）';
    }
    if (resolve(current) === resolve(top) || dirname(current) === current) return undefined;
  }
}

/* ---------- MCP configurations ---------- */

/** JSON as other apps write it: comments and trailing commas allowed. */
export function parseLenientJson(text: string): unknown {
  let out = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      out += text.slice(index, end + 1);
      index = end;
    } else if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index++;
      out += '\n';
    } else if (char === '/' && text[index + 1] === '*') {
      index = text.indexOf('*/', index + 2);
      if (index < 0) break;
      index++;
    } else out += char;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

export { splitCommandLine } from './command-line.ts';

const placeholder =
  /^$|^<[^>]*>$|^\{\{[^}]*\}\}$|your[-_ ]?(?:api[-_ ]?)?(?:key|token|secret)|YOUR_|REPLACE|_HERE$|^x{3,}$|^\*{3,}$|^sk-\.\.\.$|^\.\.\.$/i;

/** A friendly short name for a server started with npx/uvx/docker, e.g. “@playwright/mcp@1” → “playwright-mcp”. */
function nameFromCommand(command: string, args: string[]): string {
  const runners = /^(?:npx|pnpx|bunx|uvx|pipx|docker|node|python3?|deno|bun|npm|pnpm|yarn)(?:\.cmd|\.exe)?$/i;
  const program = basename(command);
  const candidate = runners.test(program)
    ? args.find(
        (arg, index) =>
          !arg.startsWith('-') &&
          !['run', 'exec', 'dlx', '-y', 'x'].includes(arg) &&
          !(index > 0 && /^-(?:e|v|p|-env)$/.test(args[index - 1]!)),
      )
    : program;
  const plain = (candidate ?? program)
    .replace(/^@/, '')
    .replace(/@[^/]*$/, '')
    .replace(/\.(?:js|mjs|py|exe|cmd)$/i, '')
    .split(/[\\/:]/)
    .filter(Boolean)
    .slice(-2)
    .join('-');
  return slug(plain.replace(/^(?:mcp-server-|server-)/, '').replace(/-mcp-server$|-server$/, '')) || 'tool';
}

export function slug(text: string, max = 24) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
}

type McpDraft = Omit<McpExtension, 'id' | 'enabled' | 'installedAt' | 'source'> & { note?: string };

function mcpFromConfig(name: string, value: unknown): McpDraft | undefined {
  const config = object(value);
  if (config.disabled === true) return undefined;
  const url =
    typeof config.url === 'string' ? config.url : typeof config.serverUrl === 'string' ? config.serverUrl : undefined;
  const type =
    typeof config.type === 'string'
      ? config.type.toLowerCase()
      : typeof config.transport === 'string'
        ? config.transport.toLowerCase()
        : '';
  if (url) {
    return {
      kind: 'mcp',
      name,
      transport: 'http',
      url,
      headers: record(config.headers) ?? record(config.http_headers),
      ...(type === 'sse' || /\/sse\/?$/.test(url)
        ? { note: '它使用旧版 SSE 连接方式，可能连不上；如有 /mcp 地址请改用那个。' }
        : {}),
    };
  }
  if (typeof config.command !== 'string' || !config.command.trim()) return undefined;
  // A whole command line in "command" (some apps allow it).
  let command = config.command.trim();
  let args = strings(config.args) ?? [];
  if (!args.length && /\s/.test(command) && !existsSync(command)) {
    const parts = splitCommandLine(command);
    command = parts[0]!;
    args = parts.slice(1);
  }
  return {
    kind: 'mcp',
    name,
    transport: 'stdio',
    command,
    args,
    env: record(config.env),
    ...(typeof config.cwd === 'string' && config.cwd ? { cwd: config.cwd } : {}),
  };
}

/** MCP servers from a pasted JSON configuration (any common app's format) or a command line or address. */
export function parseMcpInput(text: string): McpDraft[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (/^[{[]/.test(trimmed)) {
    let parsed: unknown;
    try {
      parsed = parseLenientJson(trimmed);
    } catch {
      throw new Error('这段配置不是有效的 JSON。');
    }
    const root = object(parsed);
    const servers = object(root.mcpServers ?? root.servers ?? root.mcp_servers ?? object(root.mcp).servers);
    if (Object.keys(servers).length)
      return Object.entries(servers).flatMap(([name, value]) => mcpFromConfig(name, value) ?? []);
    if (root.command || root.url) {
      const single = mcpFromConfig('', root)!;
      single.name =
        typeof root.name === 'string'
          ? root.name
          : single.url
            ? hostName(single.url)
            : nameFromCommand(single.command!, single.args ?? []);
      return [single];
    }
    // { "name": { "command": … } } without a wrapper.
    const entries = Object.entries(root).flatMap(([name, value]) => mcpFromConfig(name, value) ?? []);
    if (entries.length) return entries;
    throw new Error('没有在这段配置里找到 MCP 工具（需要 command 或 url）。');
  }
  if (/^https?:\/\//i.test(trimmed) && !/\s/.test(trimmed))
    return [mcpFromConfig(hostName(trimmed), { url: trimmed })!];
  let parts = splitCommandLine(trimmed);
  if (/^(?:gemini|agy)$/i.test(parts[0] ?? ''))
    throw new Error('不再支持 Gemini CLI 和 Antigravity。请使用 Gemini API 服务商。');
  // KEY=value words in front, or -e KEY=value of an `… mcp add` command, set the environment.
  const env: Record<string, string> = {};
  let given: string | undefined;
  if (/^(?:claude|codex)$/i.test(parts[0] ?? '') && parts[1] === 'mcp' && parts[2] === 'add') {
    // claude mcp add [options] <name> [--] <command> [args…]; transport http takes an address instead.
    const rest = parts.slice(3);
    let command: string[] = [];
    for (let index = 0; index < rest.length; index++) {
      const word = rest[index]!;
      if (word === '--') {
        command = rest.slice(index + 1);
        break;
      }
      if (/^-(?:e|-env)$/.test(word)) {
        const [key, ...value] = (rest[++index] ?? '').split('=');
        if (key) env[key] = value.join('=');
      } else if (word.startsWith('-')) {
        // An option's value (--scope user) is not the name.
        if (!word.includes('=')) index++;
      } else if (!given) given = word;
      else {
        command = rest.slice(index);
        break;
      }
    }
    if (command.length === 1 && /^https?:\/\//i.test(command[0]!))
      return [mcpFromConfig(given ?? hostName(command[0]!), { url: command[0] })!];
    parts = command;
  }
  if (!parts.length) return [];
  while (parts.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[0]!)) {
    const [key, ...rest] = parts.shift()!.split('=');
    env[key!] = rest.join('=');
  }
  const [command, ...args] = parts;
  return [
    {
      kind: 'mcp',
      name: given ?? nameFromCommand(command!, args),
      transport: 'stdio',
      command: command!,
      args,
      ...(Object.keys(env).length ? { env } : {}),
    },
  ];
}

const hostName = (url: string) => {
  try {
    return slug(new URL(url).hostname.replace(/^(?:www|api|mcp)\./, '').split('.')[0] ?? 'remote') || 'remote';
  } catch {
    return 'remote';
  }
};

/** The [mcp_servers.*] tables of a Codex config.toml; just enough TOML for those. */
export function parseCodexMcp(
  text: string,
  options: { includeDisabled?: boolean } = {},
): (McpDraft & { enabled?: false })[] {
  return [...codexMcpTables(text)].flatMap(([name, table]) => {
    if (table.enabled === false && !options.includeDisabled) return [];
    const draft = mcpFromConfig(name, table);
    return draft ? [{ ...draft, ...(table.enabled === false ? { enabled: false as const } : {}) }] : [];
  });
}

/** The raw [mcp_servers.*] tables by server name. */
export function codexMcpTables(text: string): Map<string, Row> {
  const tables = new Map<string, Row>();
  let current: Row | undefined;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      const path = splitTomlKey(header[1]!);
      current = undefined;
      if (path[0] !== 'mcp_servers' || !path[1]) continue;
      const table = tables.get(path[1]) ?? {};
      tables.set(path[1], table);
      if (path.length === 2) current = table;
      else if (path.length === 3 && ['env', 'http_headers', 'headers', 'env_http_headers'].includes(path[2]!))
        current = object((table[path[2]!] ??= {}));
      continue;
    }
    if (!current) continue;
    const equals = line.indexOf('=');
    if (equals < 0) continue;
    const key = splitTomlKey(line.slice(0, equals).trim())[0]!;
    let value = line.slice(equals + 1).trim();
    while (!balanced(value) && index + 1 < lines.length) value += `\n${lines[++index]}`;
    try {
      current[key] = tomlValue(value.replace(/\s+#[^"'\]}]*$/, ''));
    } catch {
      /* A value this reader does not understand is left out. */
    }
  }
  return tables;
}

function splitTomlKey(text: string): string[] {
  const parts: string[] = [];
  for (const match of text.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|([^.\s]+)/g))
    parts.push(match[1] !== undefined ? (JSON.parse(`"${match[1]}"`) as string) : (match[2] ?? match[3]!));
  return parts;
}

function balanced(text: string) {
  let depth = 0;
  let quote: string | undefined;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote) {
      if (char === '\\' && quote === '"') index++;
      else if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '[' || char === '{') depth++;
    else if (char === ']' || char === '}') depth--;
  }
  return depth <= 0 && !quote;
}

function tomlValue(text: string): unknown {
  let index = 0;
  const space = () => {
    while (index < text.length && /[\s,]/.test(text[index]!)) {
      if (text[index] === '#') while (index < text.length && text[index] !== '\n') index++;
      index++;
    }
  };
  const value = (): unknown => {
    space();
    const char = text[index];
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      const raw = text.slice(index, end + 1);
      index = end + 1;
      return JSON.parse(raw);
    }
    if (char === "'") {
      const end = text.indexOf("'", index + 1);
      const raw = text.slice(index + 1, end);
      index = end + 1;
      return raw;
    }
    if (char === '[') {
      index++;
      const items: unknown[] = [];
      for (space(); text[index] !== ']'; space()) {
        if (index >= text.length) throw new Error('unterminated');
        items.push(value());
      }
      index++;
      return items;
    }
    if (char === '{') {
      index++;
      const table: Row = {};
      for (space(); text[index] !== '}'; space()) {
        if (index >= text.length) throw new Error('unterminated');
        const equals = text.indexOf('=', index);
        const key = splitTomlKey(text.slice(index, equals).trim())[0]!;
        index = equals + 1;
        table[key] = value();
      }
      index++;
      return table;
    }
    const match = /^[^,\]}\s]+/.exec(text.slice(index))![0];
    index += match.length;
    return match === 'true' ? true : match === 'false' ? false : Number(match);
  };
  return value();
}

/** What a configuration still needs: settings left empty or holding a placeholder. */
function needsOf(draft: McpDraft) {
  const values = { ...draft.env, ...draft.headers };
  const needs = Object.entries(values)
    .filter(([, value]) => placeholder.test(value.trim()))
    .map(([key]) => key);
  const placeholderArgs = (draft.args ?? []).filter((arg) => /^<[^>]+>$/.test(arg));
  return { needs: [...needs, ...placeholderArgs], filled: Object.keys(values).filter((key) => !needs.includes(key)) };
}

const commandLine = (draft: McpDraft) =>
  draft.transport === 'http'
    ? draft.url!
    : [draft.command!, ...(draft.args ?? [])].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(' ');

/* ---------- Downloads and archives ---------- */

const maxDownload = 200 * 1024 * 1024;

async function download(url: string, file: string) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (response.status === 404) throw Object.assign(new Error('链接不存在，或者是私有仓库。'), { status: 404 });
  if (!response.ok || !response.body) throw new Error(`下载失败（HTTP ${response.status}）。`);
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxDownload) throw new Error('文件超过 200 MB，没有下载。');
  let size = 0;
  const source = Readable.fromWeb(response.body as never);
  source.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > maxDownload) source.destroy(new Error('文件超过 200 MB，已停止下载。'));
  });
  await pipeline(source, createWriteStream(file));
}

const maxUnpackedEntries = 20_000;
const maxUnpackedBytes = 1024 ** 3;
const maxExtractMs = 120_000;

export type ArchiveLimits = { maxEntries?: number; maxBytes?: number; timeoutMs?: number };

function safeArchivePath(root: string, rawName: string): string {
  const name = rawName.replaceAll('\\', '/');
  const parts = name.split('/').filter((part) => part && part !== '.');
  if (!parts.length || name.startsWith('/') || /^[a-z]:/i.test(name) || /[\0]/.test(name) || parts.includes('..'))
    throw new Error(`解压失败：压缩包里有不安全的路径（${rawName}）。`);
  const target = resolve(root, ...parts);
  if (target !== root && !target.startsWith(root + sep))
    throw new Error(`解压失败：压缩包里有不安全的路径（${rawName}）。`);
  return target;
}

function checkArchiveLink(root: string, target: string, rawLink: string, hard: boolean, entryName: string) {
  const link = rawLink.replaceAll('\\', '/');
  if (!link || link.startsWith('/') || /^[a-z]:/i.test(link) || /[\0]/.test(link))
    throw new Error(`解压失败：压缩包里有不安全的路径（${entryName}）。`);
  const resolved = resolve(hard ? root : dirname(target), ...link.split('/'));
  if (resolved !== root && !resolved.startsWith(root + sep))
    throw new Error(`解压失败：压缩包里有不安全的路径（${entryName}）。`);
}

/**
 * Unpacks a .zip in plain Node (Ubuntu Server has no `unzip`). Absolute, drive and parent paths are refused;
 * links are skipped, never created or followed; existing files are never replaced.
 */
export async function extractZip(file: string, into: string, limits: ArchiveLimits = {}): Promise<void> {
  const maxEntries = limits.maxEntries ?? maxUnpackedEntries;
  const maxBytes = limits.maxBytes ?? maxUnpackedBytes;
  const deadline = Date.now() + (limits.timeoutMs ?? maxExtractMs);
  try {
    if (Date.now() > deadline) throw new Error('解压失败：解压超时。');
    const entries = new AdmZip(file).getEntries();
    if (entries.length > maxEntries) throw new Error('解压失败：压缩包条目超过 20000 个。');
    const root = resolve(into);
    let total = 0;
    for (const entry of entries) {
      if (Date.now() > deadline) throw new Error('解压失败：解压超时。');
      const target = safeArchivePath(root, entry.entryName);
      const kind = (entry.attr >>> 16) & 0o170000;
      if (kind === 0o120000) {
        if (entry.header.size > 4096) throw new Error(`解压失败：压缩包里有不安全的路径（${entry.entryName}）。`);
        continue;
      }
      if (kind && kind !== 0o100000 && kind !== 0o040000) continue;
      if (entry.isDirectory) {
        await mkdir(target, { recursive: true });
        continue;
      }
      total += entry.header.size;
      if (total > maxBytes) throw new Error('解压失败：解压后超过 1 GiB。');
      const data = entry.getData();
      if (data.length !== entry.header.size) throw new Error(`解压失败：压缩包已损坏（${entry.entryName}）。`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data, { flag: 'wx' });
    }
  } catch (error) {
    await rm(into, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

const trimNull = (buf: Buffer) => buf.subarray(0, buf.indexOf(0) >= 0 ? buf.indexOf(0) : buf.length).toString('utf8');

function parseTarSize(field: Buffer): number {
  if (field[0]! & 0x80) {
    let value = 0;
    for (let i = 1; i < field.length; i++) value = value * 256 + field[i]!;
    return value;
  }
  const text = field
    .toString('ascii')
    .replace(/[\0 ]+$/, '')
    .trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function parsePaxRecords(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let offset = 0;
  const text = buf.toString('utf8');
  while (offset < text.length) {
    const space = text.indexOf(' ', offset);
    const newline = text.indexOf('\n', offset);
    if (space < 0 || newline < 0 || space > newline) break;
    const record = text.slice(space + 1, newline);
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    offset = newline + 1;
  }
  return out;
}

async function extractTar(file: string, into: string, limits: ArchiveLimits = {}): Promise<void> {
  const maxEntries = limits.maxEntries ?? maxUnpackedEntries;
  const maxBytes = limits.maxBytes ?? maxUnpackedBytes;
  const deadline = Date.now() + (limits.timeoutMs ?? maxExtractMs);
  const root = resolve(into);
  const raw = createReadStream(file);
  const magic = Buffer.alloc(2);
  const fhMagic = await open(file, 'r');
  try {
    await fhMagic.read(magic, 0, 2, 0);
  } finally {
    await fhMagic.close();
  }
  const gzipped = magic[0] === 0x1f && magic[1] === 0x8b;
  const stream = gzipped ? raw.pipe(createGunzip()) : raw;
  const iterator = stream[Symbol.asyncIterator]();
  let stash = Buffer.alloc(0);

  const pull = async (length: number): Promise<Buffer | undefined> => {
    while (stash.length < length) {
      if (Date.now() > deadline) throw new Error('解压失败：解压超时。');
      const next = await iterator.next();
      if (next.done) return stash.length === 0 ? undefined : undefined;
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      stash = stash.length ? Buffer.concat([stash, chunk]) : chunk;
    }
    if (Date.now() > deadline) throw new Error('解压失败：解压超时。');
    const out = stash.subarray(0, length);
    stash = stash.subarray(length);
    return out;
  };

  let entries = 0;
  let total = 0;
  let metaBlocks = 0;
  let nextPath: string | undefined;
  let nextLink: string | undefined;
  let nextSize: number | undefined;
  try {
    if (Date.now() > deadline) throw new Error('解压失败：解压超时。');
    for (;;) {
      const header = await pull(512);
      if (!header || header.every((byte) => byte === 0)) break;
      const type = header[156] ? String.fromCharCode(header[156]) : '0';
      const size = nextSize ?? parseTarSize(header.subarray(124, 136));
      if (!Number.isFinite(size) || size < 0) throw new Error('解压失败：压缩包已损坏。');
      const pad = (512 - (size % 512)) % 512;
      if (type === 'x' || type === 'g' || type === 'L' || type === 'K') {
        metaBlocks++;
        if (size > 64 * 1024 || metaBlocks > 8) throw new Error('解压失败：压缩包已损坏。');
        const payload = await pull(size);
        if (!payload) throw new Error('解压失败：压缩包已损坏。');
        if (pad) await pull(pad);
        if (type === 'x') {
          const pax = parsePaxRecords(payload);
          if (pax.path) nextPath = pax.path;
          if (pax.linkpath) nextLink = pax.linkpath;
          if (pax.size !== undefined) nextSize = Number(pax.size);
        } else if (type === 'L') nextPath = trimNull(payload);
        else if (type === 'K') nextLink = trimNull(payload);
        continue;
      }
      metaBlocks = 0;
      const prefix = trimNull(header.subarray(345, 500));
      const baseName = trimNull(header.subarray(0, 100));
      const rawName = nextPath ?? (prefix ? `${prefix}/${baseName}` : baseName);
      const rawLink = nextLink ?? trimNull(header.subarray(157, 257));
      nextPath = undefined;
      nextLink = undefined;
      nextSize = undefined;
      entries++;
      if (entries > maxEntries) throw new Error('解压失败：压缩包条目超过 20000 个。');
      const target = safeArchivePath(root, rawName);
      if (type !== '0' && type !== '\0' && size !== 0) throw new Error('解压失败：压缩包已损坏。');
      if (type === '1' || type === '2') {
        checkArchiveLink(root, target, rawLink, type === '1', rawName);
        continue;
      }
      if (type === '5') {
        await mkdir(target, { recursive: true });
        continue;
      }
      if (type !== '0' && type !== '\0') throw new Error(`解压失败：压缩包里有不安全的路径（${rawName}）。`);
      total += size;
      if (total > maxBytes) throw new Error('解压失败：解压后超过 1 GiB。');
      await mkdir(dirname(target), { recursive: true });
      const out = await open(target, 'wx');
      try {
        let remaining = size;
        while (remaining > 0) {
          const step = Math.min(remaining, 64 * 1024);
          const chunk = await pull(step);
          if (!chunk) throw new Error('解压失败：压缩包已损坏。');
          await out.writeFile(chunk);
          remaining -= step;
        }
      } finally {
        await out.close();
      }
      if (pad) await pull(pad);
    }
  } catch (error) {
    await rm(into, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    raw.destroy();
    stream.destroy();
  }
}

/** Unpacks a .zip, .skill, .tar.gz or .tgz with entry-count, expanded-byte, path, link, and deadline limits. */
export async function extractArchive(file: string, into: string, limits: ArchiveLimits = {}): Promise<void> {
  if (/\.(?:zip|skill)$/i.test(file)) return extractZip(file, into, limits);
  return extractTar(file, into, limits);
}

async function extract(file: string, into: string) {
  return extractArchive(file, into);
}

/** Copies a skill folder without following links out of it. */
async function copySkill(from: string, to: string) {
  await cp(from, to, {
    recursive: true,
    filter: async (source) => {
      const info = await lstat(source);
      return !info.isSymbolicLink() && !source.split(/[\\/]/).some((part) => skippedFolders.has(part) && part !== '');
    },
  });
}

export type GitHubLink = { owner: string; repo: string; rest: string[]; file: boolean };
export function parseGitHubLink(input: string): GitHubLink | undefined {
  const match =
    /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:\/(tree|blob)\/([^?#\s]+))?\/?(?:[?#].*)?$/i.exec(
      input.trim(),
    );
  if (!match) return undefined;
  return {
    owner: match[1]!,
    repo: match[2]!,
    rest: match[4] ? match[4].split('/').filter(Boolean).map(decodeURIComponent) : [],
    file: match[3] === 'blob',
  };
}

function secretPlaceholder(values: Record<string, string>, value: string) {
  const key = String(Math.max(0, ...Object.keys(values).map(Number)) + 1);
  values[key] = value;
  return `{{secret:${key}}}`;
}

/** Keep launch syntax visible without exposing credential values. */
function protectMcp<T extends McpDraft>(input: T): T {
  const item = structuredClone(input);
  const secrets = structuredClone(item.secretValues ?? {});
  const store = (kind: 'args' | 'url', value: string) => {
    if (/^\{\{secret:\d+\}\}$/.test(value)) return value;
    const values = (secrets[kind] ??= {});
    return secretPlaceholder(values, value);
  };
  const protectUrl = (kind: 'args' | 'url', value: string) =>
    value
      .replace(
        /([a-z][a-z0-9+.-]*:\/\/)([^/?#]*@)/gi,
        (_, prefix: string, auth: string) => prefix + store(kind, auth.slice(0, -1)) + '@',
      )
      .replace(/([?&][^=&#]*=)([^&#]*)/g, (_, prefix: string, secret: string) => prefix + store(kind, secret));
  const sensitiveValues = Object.entries({ ...item.env, ...item.headers })
    .filter(([key, value]) => /key|token|secret|password|auth/i.test(key) && value.length >= 4)
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
  let nextSecret = false;
  item.args = item.args?.map((arg) => {
    const whole = nextSecret;
    nextSecret = false;
    if (arg.includes('{{secret:')) return arg;
    if (whole || /Authorization:|Bearer /i.test(arg)) {
      return store('args', arg);
    }
    if (/^(--header|-H)$/i.test(arg)) {
      nextSecret = true;
      return arg;
    }
    if (arg.includes('://')) return protectUrl('args', arg);
    const pair = /^((?:--)?[^=]*(?:key|token|secret|password)[^=]*=)(.*)$/i.exec(arg);
    if (pair) return pair[1] + store('args', pair[2]!);
    if (/^--.*(?:key|token|secret|password)/i.test(arg)) nextSecret = true;
    if (!arg.includes('{{secret:') && sensitiveValues.length)
      arg = arg.replace(
        new RegExp(sensitiveValues.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g'),
        (value) => store('args', value),
      );
    return arg;
  });
  if (item.url) item.url = protectUrl('url', item.url);
  if (Object.keys(secrets).length) item.secretValues = secrets;
  return item;
}

type PrivateSettings = {
  env?: Record<string, string>;
  headers?: Record<string, string>;
  args?: Record<string, string>;
  url?: Record<string, string>;
};

/* ---------- The hub ---------- */

type Pending = {
  created: number;
  temp?: string;
  entries: Map<string, { draft: ExtensionDraft; mcp?: McpDraft; make: () => Promise<Extension> }>;
};

const idleMs = 10 * 60_000;

export class ExtensionHub {
  private summaryJob?: SkillSummaryJob;
  startSummaries(
    language: () => Locale | undefined,
    run: (prompt: string, language: Locale, signal: AbortSignal) => Promise<string>,
  ) {
    if (this.summaryJob) return;
    this.summaryJob = new SkillSummaryJob({
      skills: () => this.all().filter((item): item is SkillExtension => item.kind === 'skill'),
      language,
      run,
      save: (entries) =>
        this.serialize(async () => {
          const previous = new Map<SkillExtension, SkillExtension['summaries']>();
          for (const { id, value } of entries) {
            const skill = this.items.find((item) => item.kind === 'skill' && item.id === id);
            if (!skill || skill.kind !== 'skill' || skillSummaryHash(skill) !== value.hash) continue;
            previous.set(skill, skill.summaries);
            skill.summaries = { ...skill.summaries, [value.language]: value };
          }
          try {
            if (previous.size) await this.save();
          } catch (error) {
            for (const [skill, summaries] of previous) skill.summaries = summaries;
            throw error;
          }
        }),
    });
    this.summaryJob.request();
  }

  requestSummaries(language?: Locale) {
    this.summaryJob?.request(language);
  }

  private items: Extension[] = [];
  private loaded = false;
  private loadError?: Error;
  private secretText = '';
  private settingsPath?: string;
  private secretSettings: Record<string, PrivateSettings> = {};
  private get settingsFile() {
    return this.settingsPath ?? join(secretsDirectory(), 'extension-settings.json');
  }
  private connections = new Map<string, McpConnection>();
  private checking = new Set<string>();
  private previews = new Map<string, Pending>();
  private sweeper?: NodeJS.Timeout;
  private syncTimer?: NodeJS.Timeout;
  private syncInterval?: NodeJS.Timeout;
  private syncStopped = false;
  private syncFingerprint?: string;
  private skillCache: SkillCache = new Map();
  private managedSkillCache = new Map<string, { signature: string; hash?: string }>();
  private approvalSalt?: Buffer;
  private readonly confirmationKey = randomBytes(32);
  private confirmations = new Map<string, string>();
  private dismissed = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(() => {
      this.load();
      if (this.loadError) throw this.loadError;
      return work();
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  constructor(
    private dir = extensionsDir(),
    private readonlyDirs = legacyExtensionsDirs(),
    private privateWriter = writePrivateConfig,
  ) {}

  private get file() {
    return join(this.dir, 'extensions.json');
  }

  private get saltFile() {
    return join(secretsDirectory(), 'extension-launch-salt');
  }

  private existingSalt(): Buffer | undefined {
    if (this.approvalSalt) return this.approvalSalt;
    try {
      const encoded = readFileSync(this.saltFile, 'utf8').trim();
      if (/^[0-9a-f]{64}$/.test(encoded)) this.approvalSalt = Buffer.from(encoded, 'hex');
    } catch {
      return undefined;
    }
    return this.approvalSalt;
  }

  private async ensureSalt(): Promise<Buffer> {
    const existing = this.existingSalt();
    if (existing) return existing;
    const salt = randomBytes(32);
    await writePrivateConfig(this.saltFile, salt.toString('hex'), '');
    this.approvalSalt = salt;
    return salt;
  }

  private approval(item: McpExtension, salt: Buffer) {
    return createHash('sha256').update(salt).update(this.launchSignature(item)).digest('hex');
  }

  private needsApproval(item: McpExtension) {
    if (!item.sync || item.transport !== 'stdio') return false;
    if (!item.launchApproval) return true;
    const salt = this.existingSalt();
    return !salt || item.launchApproval !== this.approval(item, salt);
  }

  private confirmation(item: McpExtension) {
    return this.approval(item, this.confirmationKey);
  }

  describeApproveCommand(id: string, prepare = false) {
    const item = this.all().find((entry) => entry.id === id);
    if (!item || item.kind !== 'mcp' || !item.sync || item.transport !== 'stdio' || item.sync.removedAt)
      throw new Error('没有可批准的工具。');
    if (prepare) this.confirmations.set(id, this.confirmation(item));
    return this.describeCommand(item);
  }

  async approve(id: string, expected: string) {
    await this.serialize(async () => {
      const item = this.all().find((entry) => entry.id === id);
      if (
        !item ||
        item.kind !== 'mcp' ||
        !item.sync ||
        item.transport !== 'stdio' ||
        item.sync.removedAt ||
        this.describeCommand(item) !== expected ||
        this.confirmations.get(id) !== this.confirmation(item)
      )
        throw new Error('执行配置已变化，请重新确认。');
      const salt = await this.ensureSalt();
      item.launchApproval = this.approval(item, salt);
      await this.save();
      this.confirmations.delete(id);
      void this.check(id).catch(() => undefined);
    });
  }

  private load() {
    if (this.loaded) return;
    this.settingsPath = this.settingsFile;
    this.loaded = true;
    const file =
      [this.file, ...this.readonlyDirs.map((dir) => join(dir, 'extensions.json'))].find((path) => existsSync(path)) ??
      this.file;
    try {
      const hasConfig = existsSync(file);
      const parsed = (hasConfig ? JSON.parse(readFileSync(file, 'utf8')) : {}) as {
        items?: Extension[];
        dismissed?: string[];
      };
      if (hasConfig && (!parsed || !Array.isArray(parsed.items))) throw new Error();
      this.items = Array.isArray(parsed.items) ? parsed.items : [];
      this.dismissed = new Set(Array.isArray(parsed.dismissed) ? parsed.dismissed : []);
      try {
        this.secretText = readFileSync(this.settingsFile, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      this.secretSettings = this.secretText ? JSON.parse(this.secretText).values : {};
      if (!this.secretSettings || typeof this.secretSettings !== 'object' || Array.isArray(this.secretSettings))
        throw new Error();
      for (const item of this.items) {
        if (item.kind !== 'mcp') continue;
        // Older versions could persist unredacted server diagnostics. Rebuild them on the next check.
        delete item.error;
        const saved = this.secretSettings[item.id];
        if (saved) {
          item.env = { ...item.env, ...saved.env };
          item.headers = { ...item.headers, ...saved.headers };
          item.secretValues = { args: saved.args, url: saved.url };
        }
        const protectedItem = protectMcp(item);
        item.args = protectedItem.args;
        item.url = protectedItem.url;
        item.secretValues = protectedItem.secretValues;
      }
      const ids = new Set(this.items.map((item) => item.id));
      const stale = hasConfig ? Object.keys(this.secretSettings).filter((id) => !ids.has(id)) : [];
      for (const id of stale) delete this.secretSettings[id];
      if (stale.length) void this.serialize(() => this.save()).catch(() => undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !existsSync(file)) return;
      this.loadError = new Error('无法读取工具配置或凭据，原文件未修改。');
      this.items = [];
    }
  }

  private async save() {
    if (this.loadError) throw this.loadError;
    const values = structuredClone(this.secretSettings);
    const items = this.items.map((item) => {
      if (item.kind === 'skill') return item;
      const protectedItem = protectMcp(item);
      item.args = protectedItem.args;
      item.url = protectedItem.url;
      item.secretValues = protectedItem.secretValues;
      const { env, headers, secretValues, ...rest } = item;
      const settings = { ...(env ? { env } : {}), ...(headers ? { headers } : {}), ...secretValues };
      if (Object.values(settings).some((map) => map && Object.keys(map).length) || values[item.id])
        values[item.id] = settings;
      const empty = (map: Record<string, string>) => Object.fromEntries(Object.keys(map).map((key) => [key, '']));
      return {
        ...rest,
        source: isAbsolute(item.source) ? item.source : '工具配置',
        ...(env ? { env: empty(env) } : {}),
        ...(headers ? { headers: empty(headers) } : {}),
      };
    });
    const text = JSON.stringify({ version: 1, values }, null, 1);
    if (text !== this.secretText && (this.secretText || Object.keys(values).length)) {
      try {
        await this.privateWriter(this.settingsFile, text, this.secretText);
      } catch {
        throw new Error('无法保存工具凭据，原配置未修改。');
      }
      this.secretText = text;
      this.secretSettings = values;
    }
    mkdirSync(this.dir, { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, items, dismissed: [...this.dismissed] }, null, 1), {
      mode: 0o600,
    });
    renameSync(temporary, this.file);
    this.requestSummaries();
    // Migration is complete only after both new files are saved. Legacy sources are
    // readonlyDirs by contract, even when filesystem-writable: never scrub them or
    // change their permissions here. Their old env/header/args/URL plaintext remains
    // until the owner cleans it through a separately authorized writable path.
  }

  all(): Extension[] {
    this.load();
    return this.items;
  }

  list(): (ExtensionView & { checking?: boolean })[] & { error?: string } {
    const items = this.all().map((item) => {
      const sync = item.sync && {
        ...item.sync,
        sources: item.sync.sources.map((source) => ({ ...source, label: syncSourceLabel(source) })),
      };
      if (item.kind === 'skill') {
        const hash = skillSummaryHash(item);
        const summaries = Object.fromEntries(
          Object.entries(item.summaries ?? {}).filter(
            ([language, value]) =>
              ['zh-CN', 'zh-TW', 'en'].includes(language) &&
              value?.hash === hash &&
              value.language === language &&
              validSkillSummary(value, language as Locale),
          ),
        );
        const { summaries: _cached, ...rest } = item;
        return { ...rest, ...(Object.keys(summaries).length ? { summaries } : {}), ...(sync ? { sync } : {}) };
      }
      const { env, headers, source, launchApproval, secretValues, ...rest } = protectMcp(item);
      const filled = (values?: Record<string, string>) =>
        values
          ? Object.fromEntries(Object.entries(values).map(([key, value]) => [key, !placeholder.test(value.trim())]))
          : undefined;
      return {
        ...rest,
        ...(sync ? { sync } : {}),
        ...(item.sync
          ? {
              args: undefined,
              url: undefined,
              command: undefined,
              error: item.error,
              needsApproval: this.needsApproval(item),
            }
          : {}),
        // Older installations kept pasted JSON/commands here, including their credentials.
        source: isAbsolute(source) && existsSync(source) ? source : '工具配置',
        ...(env ? { env: filled(env) } : {}),
        ...(headers ? { headers: filled(headers) } : {}),
        ...(this.checking.has(item.id) ? { checking: true } : {}),
      };
    });
    // Keep the array contract for callers; the HTTP envelope carries this diagnostic separately.
    if (this.loadError) Object.defineProperty(items, 'error', { value: this.loadError.message });
    return items;
  }

  startSync(_appRoot: string) {
    if (this.syncTimer || this.syncInterval) return;
    this.syncStopped = false;
    const run = () => void this.syncOnce().catch(() => console.warn('extensions sync failed'));
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined;
      run();
      this.syncInterval = setInterval(run, 10 * 60_000);
      this.syncInterval.unref();
    }, 5000);
    this.syncTimer.unref();
  }

  syncOnce(paths?: DiscoveryPaths, fs: DiscoveryFs = discoveryFs): Promise<void> {
    return this.serialize(async () => {
      const home = isolatedUserPath(homedir());
      const locations =
        paths ?? discoverPaths({ platform: process.platform, home, appData: appDirs().userConfig, env: process.env });
      const stamp = await fingerprint(locations, fs);
      if (stamp === this.syncFingerprint) return;
      const result = await discover(locations, fs, this.skillCache);
      for (const found of result.found) if (found.kind === 'mcp') found.definition = protectMcp(found.definition);
      this.load();
      const existing = await Promise.all(
        this.items.map(async (item) =>
          item.kind === 'skill'
            ? {
                ...item,
                path: await fs.realpath(item.path).catch(() => item.path),
                ...(item.managed ? { contentHash: await hashSkillFolder(fs, item.path, this.managedSkillCache) } : {}),
              }
            : item,
        ),
      );
      const plan = planSync(existing, result.found, this.dismissed);
      let updates = 0;
      const check: string[] = [];
      for (const { item, found, sources } of plan.update) {
        const old = this.items.find((entry) => entry.id === item.id)!;
        const sync = { sources };
        let next: Extension;
        if (old.kind === 'skill' && found.kind === 'skill') {
          next = {
            ...old,
            description: found.description,
            path: old.managed ? old.path : found.path,
            loginSensitive: found.loginSensitive,
            pluginRoot: found.pluginRoot,
            sync,
          };
        } else if (old.kind === 'mcp' && found.kind === 'mcp') {
          next = {
            ...found.definition,
            id: old.id,
            name: old.name,
            enabled: old.enabled,
            installedAt: old.installedAt,
            source: found.source.file,
            sync,
            ...(old.launchApproval ? { launchApproval: old.launchApproval } : {}),
          };
          // A source that only names a value (`${VAR}`, empty) keeps what the user filled in with configure.
          const unresolved = (value: string) => placeholder.test(value.trim()) || /\$\{[^}]*\}/.test(value);
          const keep = (values?: Record<string, string>, filled?: Record<string, string>) =>
            values &&
            Object.fromEntries(
              Object.entries(values).map(([key, value]) => {
                const previous = filled?.[key];
                return [key, unresolved(value) && previous !== undefined && !unresolved(previous) ? previous : value];
              }),
            );
          if (next.env) next.env = keep(next.env, old.env);
          if (next.headers) next.headers = keep(next.headers, old.headers);
          if (!old.sync && old.transport === 'stdio' && found.definition.transport === 'stdio') {
            next.launchApproval = this.approval(old, await this.ensureSalt());
          }
          const definition = (mcp: McpExtension) => [
            mcp.name,
            mcp.description,
            mcp.transport,
            mcp.command,
            mcp.args,
            mcp.cwd,
            mcp.env,
            mcp.url,
            mcp.headers,
            mcp.secretValues,
            mcp.source,
            mcp.sync,
          ];
          if (JSON.stringify(definition(old)) === JSON.stringify(definition(next))) next = old;
        } else continue;
        if (JSON.stringify(old) !== JSON.stringify(next)) {
          await this.disconnect(old.id);
          this.items[this.items.indexOf(old)] = next;
          updates++;
          if (next.kind === 'mcp' && next.enabled && !this.needsApproval(next)) check.push(next.id);
        }
      }
      for (const found of plan.add) {
        const common = {
          id: randomUUID(),
          name: found.name,
          enabled: true,
          installedAt: new Date().toISOString(),
          source: found.source.file,
          sync: found.sync,
        };
        const item: Extension =
          found.kind === 'skill'
            ? {
                ...common,
                kind: 'skill',
                description: found.description,
                path: found.path,
                managed: false,
                loginSensitive: found.loginSensitive,
                pluginRoot: found.pluginRoot,
              }
            : { ...found.definition, ...common };
        this.items.push(item);
        if (item.kind === 'mcp' && item.transport === 'http') check.push(item.id);
      }
      for (const removed of plan.markRemoved) {
        const item = this.items.find((entry) => entry.id === removed.id)!;
        if (item.sync) item.sync.removedAt = new Date().toISOString();
        await this.disconnect(item.id);
      }
      if (plan.add.length || updates || plan.markRemoved.length) {
        await this.save();
        console.log(
          `extensions sync: ${plan.add.length} added, ${updates} updated, ${plan.markRemoved.length} removed`,
        );
      }
      if (result.errors.length) console.warn('extensions sync: discovery errors');
      this.syncFingerprint = stamp;
      for (const id of check) void this.check(id).catch(() => undefined);
    }).catch(() => {
      throw new Error('extensions sync failed');
    });
  }

  /* Previews */

  /** What a link, path, configuration or command would install. */
  async preview(input: string): Promise<ExtensionPreview> {
    const text = input.trim();
    if (!text) throw new Error('请粘贴链接、路径、配置或命令。');
    const pending: Pending = { created: Date.now(), entries: new Map() };
    const notes: string[] = [];
    const github = parseGitHubLink(text);
    const unquoted = text.replace(/^"(.*)"$/, '$1');
    try {
      if (github) await this.previewGitHub(github, pending, notes);
      else if (/^https?:\/\/\S+\.(?:zip|tar\.gz|tgz|skill)(?:[?#]\S*)?$/i.test(text)) {
        pending.temp = await mkdtemp(join(tmpdir(), 'comborunner-ext-'));
        const archive = join(pending.temp, `download${/\.zip|\.skill/i.test(text) ? '.zip' : '.tar.gz'}`);
        await download(text, archive);
        await this.previewArchive(archive, pending, text);
      } else if (isAbsolute(unquoted) && existsSync(unquoted)) await this.previewPath(unquoted, pending);
      else for (const draft of parseMcpInput(text)) this.addMcp(pending, draft, '粘贴的配置', '粘贴的配置');
    } catch (error) {
      await this.discard(pending);
      throw error;
    }
    if (!pending.entries.size) {
      await this.discard(pending);
      throw new Error(github ? '这个仓库里没有找到技能（含 SKILL.md 的文件夹）。' : '没有找到可以安装的技能或工具。');
    }
    return this.keep(pending, notes);
  }

  /** Skills and tools other AI apps on this computer already have. */
  async previewImports(): Promise<ExtensionPreview> {
    const home = isolatedUserPath(homedir());
    // %APPDATA%, ~/Library/Application Support or $XDG_CONFIG_HOME: where Claude Desktop and VS Code keep settings.
    const appData = appDirs().userConfig;
    const paths = discoverPaths({ platform: process.platform, home, appData, env: process.env });
    const pending: Pending = { created: Date.now(), entries: new Map() };
    const skillRoots: [string, string][] = [
      [paths.claudeSkills, 'Claude Code'],
      [paths.codexSkills, 'Codex'],
      [paths.agentsSkills, '通用技能目录'],
    ];
    for (const [root, origin] of skillRoots)
      for (const folder of await findSkillFolders(root, 3)) await this.addSkill(pending, folder, origin, false, root);
    const configs: [string, string, 'json' | 'toml'][] = [
      [join(appData, 'Claude', 'claude_desktop_config.json'), 'Claude Desktop', 'json'],
      [paths.claudeConfig, 'Claude Code', 'json'],
      [join(home, '.cursor', 'mcp.json'), 'Cursor', 'json'],
      [join(appData, 'Code', 'User', 'mcp.json'), 'VS Code', 'json'],
      [join(home, '.codeium', 'windsurf', 'mcp_config.json'), 'Windsurf', 'json'],
      [paths.codexConfig, 'Codex', 'toml'],
    ];
    for (const [file, origin, format] of configs) {
      const text = await readFile(file, 'utf8').catch(() => '');
      if (!text) continue;
      let drafts: McpDraft[] = [];
      try {
        if (format === 'toml') drafts = parseCodexMcp(text);
        else {
          // Only the user-level servers: never other settings these files keep.
          const root = object(parseLenientJson(text));
          const servers = root.mcpServers ?? root.servers;
          drafts = Object.entries(object(servers)).flatMap(([name, value]) => mcpFromConfig(name, value) ?? []);
        }
      } catch {
        continue;
      }
      for (const draft of drafts)
        // Our own tool bridge and MCP server (named "comborunner" before the PugPort rename, "pugport-app" in other
        // tools' settings) are never imported as an extension.
        if (!['pugport', 'pugport-app', 'comborunner'].includes(draft.name.toLowerCase()))
          this.addMcp(pending, draft, origin, file);
    }
    return this.keep(
      pending,
      pending.entries.size ? [] : ['没有在 Claude、Codex、Cursor 等应用里找到技能或 MCP 工具。'],
    );
  }

  async previewCatalog(id: string): Promise<ExtensionPreview> {
    const entry = extensionCatalog.find((item) => item.id === id);
    if (!entry) throw new Error('推荐列表里没有这一项。');
    let install = entry.install;
    // Edge comes with Windows; Chrome may not be installed.
    if (entry.id === 'browser' && process.platform === 'win32')
      install = install.replace('"--isolated"', '"--isolated","--browser","msedge"');
    const preview = await this.preview(install);
    for (const draft of preview.drafts) {
      draft.license ??= entry.license;
      if (draft.kind === 'mcp') draft.description = entry.description;
    }
    return preview;
  }

  private keep(pending: Pending, notes: string[]): ExtensionPreview {
    for (const [token, old] of this.previews) if (Date.now() - old.created > 30 * 60_000) void this.discard(old, token);
    const token = randomBytes(12).toString('hex');
    this.previews.set(token, pending);
    return {
      token,
      drafts: [...pending.entries.values()].map((entry) => entry.draft),
      ...(notes.length ? { notes } : {}),
    };
  }

  private async discard(pending: Pending, token?: string) {
    if (token) this.previews.delete(token);
    if (pending.temp) await rm(pending.temp, { recursive: true, force: true }).catch(() => undefined);
  }

  private async previewGitHub(link: GitHubLink, pending: Pending, notes: string[]) {
    pending.temp = await mkdtemp(join(tmpdir(), 'comborunner-ext-'));
    const archive = join(pending.temp, 'repo.tar.gz');
    // A branch name may contain slashes: try the shortest ref first, then longer ones.
    const attempts = link.rest.length ? link.rest.map((_, index) => index + 1) : [0];
    let ref = 'HEAD';
    let inside: string[] = [];
    for (const count of attempts) {
      ref = count ? link.rest.slice(0, count).join('/') : 'HEAD';
      try {
        await download(
          `https://codeload.github.com/${encodeURIComponent(link.owner)}/${encodeURIComponent(link.repo)}/tar.gz/${ref
            .split('/')
            .map(encodeURIComponent)
            .join('/')}`,
          archive,
        );
        inside = link.rest.slice(count);
        break;
      } catch (error) {
        if ((error as { status?: number }).status !== 404 || count === attempts.at(-1)) throw error;
      }
    }
    const unpacked = join(pending.temp, 'repo');
    mkdirSync(unpacked);
    await extract(archive, unpacked);
    const top = (await readdir(unpacked))[0];
    if (!top) throw new Error('下载的仓库是空的。');
    const root = join(unpacked, top);
    let start = resolve(root, ...inside);
    if (!start.startsWith(root)) throw new Error('链接里的路径无效。');
    if (link.file) start = dirname(start);
    if (!existsSync(start)) throw new Error('仓库里没有这个路径。');
    const origin = `GitHub ${link.owner}/${link.repo}`;
    const page = (folder: string) =>
      `https://github.com/${link.owner}/${link.repo}/tree/${ref === 'HEAD' ? 'HEAD' : ref}/${relative(root, folder).split(sep).join('/')}`;
    for (const folder of await findSkillFolders(start, 5))
      await this.addSkill(pending, folder, origin, true, root, page(folder));
    if (pending.entries.size > 60) notes.push(`找到 ${pending.entries.size} 个技能，请只勾选需要的。`);
  }

  private async previewArchive(archive: string, pending: Pending, source: string) {
    pending.temp ??= await mkdtemp(join(tmpdir(), 'comborunner-ext-'));
    const unpacked = join(pending.temp, 'unpacked');
    mkdirSync(unpacked, { recursive: true });
    await extract(archive, unpacked);
    for (const folder of await findSkillFolders(unpacked, 5))
      await this.addSkill(pending, folder, '压缩包', true, unpacked, source);
  }

  private async previewPath(path: string, pending: Pending) {
    const info = await stat(path);
    if (info.isDirectory()) {
      for (const folder of await findSkillFolders(path, 5))
        await this.addSkill(pending, folder, '本机文件夹', true, path, folder);
    } else if (/\.(?:zip|tar\.gz|tgz|skill)$/i.test(path)) await this.previewArchive(path, pending, path);
    else if (basename(path).toLowerCase() === 'skill.md')
      await this.addSkill(pending, dirname(path), '本机文件夹', true, dirname(path), dirname(path));
    else if (/\.(?:json|toml)$/i.test(path)) {
      const text = await readFile(path, 'utf8');
      const drafts = extname(path).toLowerCase() === '.toml' ? parseCodexMcp(text) : parseMcpInput(text);
      for (const draft of drafts) this.addMcp(pending, draft, basename(path), path);
    } else throw new Error('支持文件夹、SKILL.md、.zip/.tar.gz 压缩包，或 MCP 配置文件（.json/.toml）。');
  }

  /** copy: install a copy PugPort owns; otherwise use the folder where it is (imports from other apps). */
  private async addSkill(
    pending: Pending,
    folder: string,
    origin: string,
    copy: boolean,
    top: string,
    source = folder,
  ) {
    let info;
    try {
      info = await readSkillFolder(folder);
    } catch {
      return;
    }
    const key = `skill:${pending.entries.size}`;
    const existing = this.all().find(
      (item) => item.kind === 'skill' && item.name.toLowerCase() === info.name.toLowerCase(),
    );
    const draft: ExtensionDraft = {
      key,
      kind: 'skill',
      name: info.name,
      description: info.description,
      origin,
      detail: copy ? undefined : folder,
      ...(existing ? { installed: true } : {}),
      ...(copy ? { license: await licenseOf(folder, top) } : {}),
    };
    pending.entries.set(key, {
      draft,
      make: async () => {
        let path = folder;
        if (copy) {
          path = join(this.dir, 'skills', `${slug(info.name, 40) || 'skill'}-${randomUUID().slice(0, 8)}`);
          await copySkill(folder, path);
        }
        return {
          kind: 'skill',
          id: randomUUID(),
          name: info.name,
          description: info.description,
          path,
          source,
          managed: copy,
          enabled: true,
          installedAt: new Date().toISOString(),
        };
      },
    });
  }

  private addMcp(pending: Pending, config: McpDraft, origin: string, source: string) {
    const key = `mcp:${pending.entries.size}`;
    const { needs, filled } = needsOf(config);
    const name = config.name || 'tool';
    const existing = this.all().find((item) => item.kind === 'mcp' && item.name.toLowerCase() === name.toLowerCase());
    pending.entries.set(key, {
      mcp: config,
      draft: {
        key,
        kind: 'mcp',
        name,
        description: config.note ?? '',
        origin,
        detail: commandLine(protectMcp(config)),
        ...(needs.length ? { needs } : {}),
        ...(filled.length ? { filled } : {}),
        ...(existing ? { installed: true, existingId: existing.id } : {}),
      },
      make: async () => {
        const { note: _note, ...rest } = structuredClone(config);
        return { ...rest, name, id: randomUUID(), source, enabled: true, installedAt: new Date().toISOString() };
      },
    });
  }

  describeInstallCommands(
    token: string,
    keys: string[],
    fills: Record<string, Record<string, string>> = {},
    options: ExtensionInstallOptions = {},
  ) {
    const pending = this.previews.get(token);
    if (!pending) throw new Error('预览已过期，请重新查看。');
    return keys
      .flatMap((key) => {
        const entry = pending.entries.get(key);
        if (!entry) throw new Error('所选扩展已不存在，请重新查看预览。');
        if (!entry.mcp || entry.mcp.transport !== 'stdio') return [];
        const next = structuredClone(entry.mcp);
        this.fillMcp(next, fills[key] ?? {});
        const old = this.all().find((item) => item.id === options[key]?.replaceId);
        if (
          old?.kind === 'mcp' &&
          old.transport === 'stdio' &&
          this.launchSignature(old) === this.launchSignature(next) &&
          !this.needsApproval(old)
        )
          return [];
        return [this.describeCommand(next)];
      })
      .join('\n');
  }

  /** Compares what actually launches, so a stored placeholder and the same value typed again match. */
  private launchSignature(item: McpDraft) {
    const args = item.args?.map((arg) =>
      arg.replace(/\{\{secret:(\d+)\}\}/g, (token, key: string) => item.secretValues?.args?.[key] ?? token),
    );
    return JSON.stringify([
      item.command,
      args ?? [],
      item.cwd ?? '',
      Object.entries(item.env ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    ]);
  }

  private describeCommand(item: McpDraft) {
    return [
      displayCommand(item.command!, protectMcp(item).args),
      ...(item.cwd ? [`工作目录：${JSON.stringify(item.cwd)}`] : []),
      ...(Object.keys(item.env ?? {}).length
        ? [
            `环境变量：${Object.keys(item.env!)
              .sort()
              .map((key) => JSON.stringify(key))
              .join(', ')}`,
          ]
        : []),
    ].join('\n');
  }

  private fillMcp(item: McpDraft, fill: Record<string, string>) {
    for (const [name, value] of Object.entries(fill)) {
      if (!value.trim()) continue;
      if (item.headers && name in item.headers) item.headers[name] = value.trim();
      else if (item.args?.includes(name)) {
        const values = ((item.secretValues ??= {}).args ??= {});
        const token = secretPlaceholder(values, value.trim());
        item.args = item.args.map((arg) => (arg === name ? token : arg));
      } else item.env = { ...item.env, [name]: value.trim() };
    }
  }

  assertInstallNarrowing(
    token: string,
    keys: string[],
    fills?: Record<string, Record<string, string>>,
    options?: ExtensionInstallOptions,
  ) {
    if (this.describeInstallCommands(token, keys, fills, options)) throw new DesktopPermissionRequired();
  }

  /** Installs the chosen drafts of a preview; settings typed in by the user fill what was missing. */
  async install(
    token: string,
    keys: string[],
    fills: Record<string, Record<string, string>> = {},
    options: ExtensionInstallOptions = {},
    permission?: { expected: string },
  ) {
    return this.serialize(() => this.installInner(token, keys, fills, options, permission));
  }

  private async installInner(
    token: string,
    keys: string[],
    fills: Record<string, Record<string, string>>,
    options: ExtensionInstallOptions,
    permission?: { expected: string },
  ) {
    const pending = this.previews.get(token);
    if (!pending) throw new Error('预览已过期，请重新查看。');
    if (!keys.length) throw new Error('请至少勾选一项。');
    if (new Set(keys).size !== keys.length) throw new Error('同一项扩展不能重复选择。');
    const chosen = keys.map((key) => {
      const entry = pending.entries.get(key);
      if (!entry) throw new Error('所选扩展已不存在，请重新查看预览。');
      return entry;
    });
    // Validate the whole batch before making copies or changing an existing installation.
    const plan = () => {
      if (permission && this.describeInstallCommands(token, keys, fills, options) !== permission.expected)
        throw new Error('执行配置已变化，请重新确认。');
      const replaced = new Set<string>();
      const choices = chosen.map((entry) => {
        const option = options[entry.draft.key] ?? {};
        const old =
          option.replaceId === undefined ? undefined : this.all().find((item) => item.id === option.replaceId);
        if (option.replaceId !== undefined) {
          if (!old || old.kind !== entry.draft.kind) throw new Error('要替换的扩展不存在或类型不同，请重新选择。');
          if (replaced.has(old.id)) throw new Error('同一项已安装扩展不能在一次操作中被替换两次。');
          replaced.add(old.id);
        }
        if (entry.draft.kind === 'skill' && option.name !== undefined)
          throw new Error('技能名称由 SKILL.md 决定，只有工具连接可以自定义名称。');
        return {
          entry,
          old,
          explicitName: option.name !== undefined,
          name:
            entry.draft.kind === 'mcp' ? this.mcpName(option.name ?? old?.name ?? entry.draft.name) : entry.draft.name,
        };
      });
      const names = new Set(
        this.all()
          .filter((item) => item.kind === 'mcp' && !replaced.has(item.id))
          .map((item) => item.name.toLowerCase()),
      );
      // Reserve requested names first; automatic suffixes never displace a user's explicit choice.
      for (const choice of choices.filter(
        (item) => item.entry.draft.kind === 'mcp' && (item.explicitName || item.old),
      )) {
        if (names.has(choice.name.toLowerCase())) throw this.duplicateMcpName(choice.name);
        names.add(choice.name.toLowerCase());
      }
      for (const choice of choices.filter(
        (item) => item.entry.draft.kind === 'mcp' && !item.explicitName && !item.old,
      )) {
        const base = choice.name;
        for (let suffix = 2; names.has(choice.name.toLowerCase()); suffix++) {
          const ending = ` (${suffix})`;
          choice.name = `${base.slice(0, 80 - ending.length).trimEnd()}${ending}`;
        }
        names.add(choice.name.toLowerCase());
      }
      return choices;
    };
    plan();
    const installed: Extension[] = [];
    const removed: Extension[] = [];
    let committed = false;
    try {
      for (const entry of chosen) {
        const item = await entry.make();
        if (item.kind === 'mcp') {
          this.fillMcp(item, fills[entry.draft.key] ?? {});
        }
        installed.push(item);
      }
      // Making skill copies can yield. Revalidate against the latest names and replacement IDs.
      const choices = plan();
      let next = [...this.all()];
      for (const [index, item] of installed.entries()) {
        const choice = choices[index]!;
        item.name = choice.name;
        // Skills retain their same-name update behavior; MCP replacement requires an explicit ID.
        const old =
          choice.old ??
          next.find(
            (other) =>
              item.kind === 'skill' && other.kind === 'skill' && other.name.toLowerCase() === item.name.toLowerCase(),
          );
        if (old) {
          removed.push(old);
          next = next.filter((other) => other.id !== old.id);
          if (choice.old) item.id = old.id;
          if (item.kind === 'mcp') {
            item.enabled = old.enabled;
            item.installedAt = old.installedAt;
          }
        }
        next.push(item);
      }
      const previous = this.items;
      const previousSettings = structuredClone(this.secretSettings);
      this.items = next;
      try {
        await this.save();
      } catch (error) {
        this.items = previous;
        this.secretSettings = previousSettings;
        throw error;
      }
      committed = true;
      this.syncFingerprint = undefined;
      for (const item of removed) {
        await this.disconnect(item.id);
        await this.removeSkillCopy(item);
      }
    } finally {
      if (!committed) for (const item of installed) if (!this.items.includes(item)) await this.removeSkillCopy(item);
      await this.discard(pending, token);
    }
    for (const item of installed)
      if (item.kind === 'mcp' && item.enabled) void this.check(item.id).catch(() => undefined);
    return installed.map((item) => item.id);
  }

  private mcpName(value: string) {
    const name = value.trim();
    if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('连接名称需要 1–80 个可见字符。');
    return name;
  }

  private duplicateMcpName(name: string) {
    return new Error(`已有名为“${name}”的工具连接，请使用其他名称，或明确选择替换现有连接。`);
  }

  /** A display-name edit keeps the connection ID, settings and credentials. */
  async rename(id: string, value: string) {
    return this.serialize(() => this.renameInner(id, value));
  }

  private async renameInner(id: string, value: string) {
    const item = this.all().find((other) => other.id === id);
    if (!item || item.kind !== 'mcp') throw new Error('只有已安装的工具连接可以重命名。');
    const name = this.mcpName(value);
    if (
      this.all().some(
        (other) => other.kind === 'mcp' && other.id !== id && other.name.toLowerCase() === name.toLowerCase(),
      )
    )
      throw this.duplicateMcpName(name);
    const previous = item.name;
    item.name = name;
    try {
      await this.save();
    } catch (error) {
      item.name = previous;
      throw error;
    }
  }

  async setEnabled(id: string, enabled: boolean) {
    return this.serialize(() => this.setEnabledInner(id, enabled));
  }

  private async setEnabledInner(id: string, enabled: boolean) {
    const item = this.all().find((other) => other.id === id);
    if (!item) throw new Error('没有这个扩展。');
    item.enabled = enabled;
    await this.save();
    this.syncFingerprint = undefined;
    if (!enabled) await this.disconnect(id);
    else if (item.kind === 'mcp' && !item.tools) void this.check(id).catch(() => undefined);
  }

  describeConfigureCommand(id: string, values: Record<string, string>) {
    const item = this.all().find((other) => other.id === id);
    if (!item || item.kind !== 'mcp') throw new Error('没有这个工具。');
    if (item.transport !== 'stdio') return '';
    const next = structuredClone(item);
    for (const [name, value] of Object.entries(values)) {
      if (next.headers && name in next.headers) next.headers[name] = value;
      else next.env = { ...next.env, [name]: value };
    }
    return this.launchSignature(item) === this.launchSignature(next) ? '' : this.describeCommand(next);
  }

  assertConfigureNarrowing(id: string, values: Record<string, string>) {
    if (this.describeConfigureCommand(id, values)) throw new DesktopPermissionRequired();
  }

  /** Changes a tool's settings (e.g. a key), keeping the ones not given. `expected` is the command the native
   * confirmation showed; a synced program it names may then start. */
  async configure(id: string, values: Record<string, string>, narrowOnly = false, expected?: string) {
    return this.serialize(() => this.configureInner(id, values, narrowOnly, expected));
  }

  private async configureInner(id: string, values: Record<string, string>, narrowOnly: boolean, expected?: string) {
    if (narrowOnly) this.assertConfigureNarrowing(id, values);
    else if (expected !== undefined && this.describeConfigureCommand(id, values) !== expected)
      throw new Error('执行配置已变化，请重新确认。');
    const item = this.all().find((other) => other.id === id);
    if (!item || item.kind !== 'mcp') throw new Error('没有这个工具。');
    for (const [name, value] of Object.entries(values)) {
      if (item.headers && name in item.headers) item.headers[name] = value;
      else item.env = { ...item.env, [name]: value };
    }
    if (expected && item.sync && item.transport === 'stdio')
      item.launchApproval = this.approval(item, await this.ensureSalt());
    await this.save();
    this.syncFingerprint = undefined;
    await this.disconnect(id);
    void this.check(id).catch(() => undefined);
  }

  async remove(id: string) {
    return this.serialize(() => this.removeInner(id));
  }

  private async removeInner(id: string) {
    const item = this.all().find((other) => other.id === id);
    if (!item) return;
    for (const source of item.sync?.sources ?? []) this.dismissed.add(`${source.origin}|${source.file}|${source.key}`);
    this.items = this.items.filter((other) => other.id !== id);
    await this.save();
    this.syncFingerprint = undefined;
    await this.disconnect(id);
    await this.removeSkillCopy(item);
  }

  private async removeSkillCopy(item: Extension) {
    // Only a PugPort-managed copy beneath the managed skills root can be removed.
    if (item.kind === 'skill' && item.managed && resolve(item.path).startsWith(join(this.dir, 'skills') + sep))
      await rm(item.path, { recursive: true, force: true }).catch(() => undefined);
  }

  /** Starts a tool (if needed) and asks what it offers; remembers the answer for the next tasks. */
  // Not on the chain: a slow server must not hold up other changes. Updates and removals disconnect first.
  async check(id: string): Promise<ExtensionTool[]> {
    const item = this.all().find((other) => other.id === id);
    if (!item || item.kind !== 'mcp') throw new Error('没有这个工具。');
    if (item.sync && (this.syncStopped || !item.enabled || item.sync.removedAt || this.needsApproval(item))) return [];
    this.checking.add(id);
    try {
      const connection = await this.connection(item);
      const tools = await connection.listTools();
      item.tools = tools;
      item.checkedAt = new Date().toISOString();
      delete item.error;
      return tools;
    } catch (error) {
      item.error = error instanceof Error ? error.message : String(error);
      item.checkedAt = new Date().toISOString();
      await this.disconnect(id);
      throw error;
    } finally {
      this.checking.delete(id);
      if (this.items.includes(item)) await this.serialize(() => this.save());
    }
  }

  private async connection(item: McpExtension) {
    const open = this.connections.get(item.id);
    if (open && !open.closed) return open;
    const connection = new McpConnection(item);
    this.connections.set(item.id, connection);
    this.sweep();
    await connection.start();
    return connection;
  }

  private async disconnect(id: string) {
    const connection = this.connections.get(id);
    this.connections.delete(id);
    await connection?.close();
  }

  /** Closes tools no task has used for a while; the next call starts them again. */
  private sweep() {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      for (const [id, connection] of this.connections)
        if (connection.closed || Date.now() - connection.lastUsed > idleMs) void this.disconnect(id);
      if (!this.connections.size) {
        clearInterval(this.sweeper);
        this.sweeper = undefined;
      }
    }, 60_000);
    this.sweeper.unref();
  }

  async stopAll() {
    await this.summaryJob?.stop();
    this.summaryJob = undefined;
    this.syncStopped = true;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    if (this.syncInterval) clearInterval(this.syncInterval);
    this.syncTimer = undefined;
    this.syncInterval = undefined;
    const closeAll = () => Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)));
    await closeAll();
    await this.chain;
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
    await closeAll();
  }

  /* What executors see */

  /** Enabled skills; a conversation may narrow them to the names it allows. */
  private skills(allowed?: string[]) {
    return this.all().filter(
      (item): item is SkillExtension =>
        item.kind === 'skill' && item.enabled && !item.sync?.removedAt && (!allowed || allowed.includes(item.name)),
    );
  }

  /** Bridge tool names for the enabled tools; a run that may not change files only gets read-only ones. */
  private exposed(write: boolean, mcpAllowed?: string[]) {
    const out: { name: string; item: McpExtension; tool: ExtensionTool }[] = [];
    for (const item of this.all()) {
      if (
        item.kind !== 'mcp' ||
        !item.enabled ||
        item.sync?.removedAt ||
        this.needsApproval(item) ||
        (mcpAllowed && !mcpAllowed.includes(item.id))
      )
        continue;
      for (const tool of item.tools ?? []) {
        if (!write && !tool.readOnly) continue;
        // Display-name edits, removals and server tool reordering must not change granted tool IDs.
        const instance = createHash('sha256').update(item.id).digest('hex').slice(0, 16);
        const identity = createHash('sha256').update(tool.name).digest('hex').slice(0, 12);
        const name = `mcp_${instance}__${tool.name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 25)}_${identity}`;
        out.push({ name, item, tool });
      }
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  bridgeTools(write: boolean, allowed?: string[], mcpAllowed?: string[]) {
    // A tool installed but never checked (e.g. after an update) gets checked now, for the next task.
    for (const item of this.all())
      if (
        item.kind === 'mcp' &&
        item.enabled &&
        !item.sync?.removedAt &&
        !this.needsApproval(item) &&
        (!mcpAllowed || mcpAllowed.includes(item.id)) &&
        !item.tools &&
        !item.error &&
        !this.checking.has(item.id)
      )
        void this.check(item.id).catch(() => undefined);
    const tools: Row[] = this.exposed(write, mcpAllowed).map(({ name, item, tool }) => ({
      name,
      description: `[${item.name}] ${tool.description}`.slice(0, 1024),
      inputSchema: tool.inputSchema && Object.keys(tool.inputSchema).length ? tool.inputSchema : { type: 'object' },
      ...(tool.readOnly ? { annotations: { readOnlyHint: true } } : {}),
    }));
    if (this.skills(allowed).length) tools.push(...skillTools);
    return tools;
  }

  /** Names to pre-approve where an executor needs a list (bridge-qualified by the caller). */
  toolNames(write: boolean, allowed?: string[], mcpAllowed?: string[]) {
    return [
      ...this.exposed(write, mcpAllowed).map((entry) => entry.name),
      ...(this.skills(allowed).length ? skillTools.map((tool) => tool.name) : []),
    ];
  }

  handles(name: string) {
    return skillTools.some((tool) => tool.name === name) || /__/.test(name);
  }

  async call(
    name: string,
    args: Row,
    write: boolean,
    signal?: AbortSignal,
    allowed?: string[],
    mcpAllowed?: string[],
    authorize?: () => void | Promise<void>,
    validate?: () => void,
  ): Promise<{ content: ToolContent; isError: boolean }> {
    if (name === 'use_skill' || name === 'read_skill_file') {
      await authorize?.();
      validate?.();
      return {
        content: [
          {
            type: 'text',
            text: await (name === 'use_skill' ? this.useSkill(args, allowed) : this.readSkillFile(args, allowed)),
          },
        ],
        isError: false,
      };
    }
    const entry = this.exposed(write, mcpAllowed).find((candidate) => candidate.name === name);
    if (!entry) {
      if (this.exposed(true, mcpAllowed).some((candidate) => candidate.name === name))
        throw new Error('这次任务是只读的，不能使用会修改内容的扩展工具。');
      throw new Error(`没有这个扩展工具：${name}（可能已停用或卸载）。`);
    }
    let connection: McpConnection;
    try {
      connection = await this.connection(entry.item);
    } catch (error) {
      if (entry.item.sync) throw new Error('扩展工具调用失败。');
      throw error;
    }
    await authorize?.();
    try {
      const result = await connection.callTool(entry.tool.name, args, signal, () => {
        validate?.();
        const current = this.exposed(write, mcpAllowed).find((candidate) => candidate.name === name);
        if (
          current?.item !== entry.item ||
          current?.tool !== entry.tool ||
          this.connections.get(entry.item.id) !== connection ||
          connection.closed
        )
          throw new Error(`没有这个扩展工具：${name}（可能已停用或卸载）。`);
      });
      return result;
    } catch (error) {
      if (entry.item.sync) throw new Error('扩展工具调用失败。');
      throw error;
    }
  }

  /** The skills list put into an executor's instructions, so it knows when to open one. */
  skillHint(request: string, allowed?: string[], applied: readonly string[] = []): string | undefined {
    let skills = this.skills(allowed);
    if (!skills.length) return undefined;
    const preferred = new Set(applied);
    if (skills.length > 40) {
      // Applied skills keep their relevance check; fill the remaining slots with request matches.
      const words = new Set(request.toLowerCase().match(/[a-z0-9]{3,}|[\u4e00-\u9fff]{2}/g) ?? []);
      const score = (skill: SkillExtension) =>
        (`${skill.name} ${skill.description}`.toLowerCase().match(/[a-z0-9]{3,}|[\u4e00-\u9fff]{2}/g) ?? []).filter(
          (word) => words.has(word),
        ).length;
      skills = [...skills]
        .sort((a, b) => Number(preferred.has(b.name)) - Number(preferred.has(a.name)) || score(b) - score(a))
        .slice(0, 40);
    }
    const lines = (items: SkillExtension[]) =>
      items.map((skill) => `- ${skill.name}：${skill.description.replace(/\s+/g, ' ').slice(0, 160)}`).join('\n');
    const selected = skills.filter((skill) => preferred.has(skill.name));
    const ordinary = skills.filter((skill) => !preferred.has(skill.name));
    return [
      ...(selected.length
        ? [
            `本对话已应用的技能（每轮必须先检查是否适合当前请求；适合时必须先调用 PugPort 工具 use_skill 读取完整说明并采用，不相关则跳过；不必无条件逐个调用，也不能扩大权限）：\n${lines(selected)}`,
          ]
        : []),
      ...(ordinary.length
        ? [
            `已安装的技能（任务和某个技能相关时，先调用 PugPort 工具 use_skill 读取它的完整说明，再照着做）：\n${lines(ordinary)}`,
          ]
        : []),
    ].join('\n\n');
  }

  private skillNamed(value: unknown, allowed?: string[]) {
    const name = String(value ?? '')
      .trim()
      .toLowerCase();
    const skill = this.skills(allowed).find((item) => item.name.toLowerCase() === name);
    if (!skill)
      throw new Error(
        `没有名为“${String(value ?? '')}”的技能。已安装：${
          this.skills(allowed)
            .map((item) => item.name)
            .join('、') || '无'
        }`,
      );
    return skill;
  }

  private async useSkill(args: Row, allowed?: string[]) {
    const skill = this.skillNamed(args.name, allowed);
    const { body } = parseSkill(await readFile(await skillFile(skill.path), 'utf8'));
    const files: string[] = [];
    const walk = async (folder: string, depth: number) => {
      for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
        if (files.length >= 200) return;
        const path = join(folder, entry.name);
        if (entry.isDirectory()) {
          if (depth < 4 && !skippedFolders.has(entry.name)) await walk(path, depth + 1);
        } else if (entry.isFile() && entry.name.toLowerCase() !== 'skill.md')
          files.push(relative(skill.path, path).split(sep).join('/'));
      }
    };
    await walk(skill.path, 0);
    return [
      `技能“${skill.name}”的说明（文件夹：${skill.path}）：`,
      '',
      body,
      ...(files.length
        ? [
            '',
            `这个技能附带的文件（相对上面的文件夹；说明里提到时用 read_skill_file 读取，脚本可以用你自己的命令在该文件夹里运行）：`,
            ...files.map((file) => `- ${file}`),
          ]
        : []),
    ].join('\n');
  }

  private async readSkillFile(args: Row, allowed?: string[]) {
    const skill = this.skillNamed(args.skill ?? args.name, allowed);
    const wanted = String(args.path ?? '').trim();
    if (!wanted) throw new Error('请用 path 给出技能文件夹里的文件。');
    const root = await realpath(skill.path);
    const file = await realpath(resolve(root, wanted)).catch(() => {
      throw new Error(`技能里没有这个文件：${wanted}`);
    });
    if (file !== root && !file.startsWith(root + sep)) throw new Error('只能读取技能文件夹里的文件。');
    const info = await stat(file);
    if (!info.isFile()) throw new Error('这不是文件。');
    if (info.size > 512 * 1024)
      throw new Error(`文件太大（${Math.round(info.size / 1024)} KB），请用你自己的工具读取：${file}`);
    const text = await readFile(file, 'utf8');
    if (text.includes('\0')) throw new Error(`这是二进制文件，请直接使用路径：${file}`);
    return text;
  }
}

const skillTools = [
  {
    name: 'use_skill',
    description:
      "只读：读取本机已安装技能文件夹里的一个 SKILL.md 说明文件并返回文本，并列出它附带的文件名；不运行任何脚本、不改文件、不联网。任务和某个技能相关时先读它的说明再照做。 Read-only: returns the text of one locally installed skill's SKILL.md instruction file plus the names of its bundled files. It runs no scripts, writes nothing and uses no network.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '技能名称（见任务说明里的已安装技能列表）。' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_skill_file',
    description:
      '只读：返回技能文件夹里一个参考文件或脚本的文本，不执行它。 Read-only: returns the text of one file inside an installed skill folder; it never executes it.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: '技能名称。' },
        path: { type: 'string', description: '文件在技能文件夹里的相对路径，例如 reference.md。' },
      },
      required: ['skill', 'path'],
      additionalProperties: false,
    },
  },
];

/** The app's hub. Tests make their own with a temporary folder. */
export const extensions = new ExtensionHub();
