import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { z } from 'zod';
import { parse } from 'jsonc-parser';
import { currentHost, type Host } from '../src/server/platform/host.ts';
import { McpConnections, mcpConnectRoutes, type McpCommand } from '../src/server/mcp-connect.ts';
import type { RuntimeTarget } from '../src/shared/types.ts';
import { listenForFetch } from './helpers/fetch-port.ts';
import { fakeFs, fakeHost } from './helpers/fake-host.ts';
import { parseCodexMcp } from '../src/server/extensions.ts';

const windows = process.platform === 'win32';
// A synthetic session token: it must never reach another tool's configuration.
const token = 'fixture-session-token-91d3';

/*
 * Stand-ins for the tools' own CLIs. Each records how it was called and edits its configuration under the fake
 * home the way the real one does, with the same argument rules (Claude, Codex and Grok need "--" before the server
 * command).
 */
const fakeCli = String.raw`
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const [label, ...argv] = process.argv.slice(2);
const [tool, via] = label.split('@');
const home = process.env.HOME;
appendFileSync(join(home, 'calls.jsonl'), JSON.stringify({ tool, via: via ?? 'path', argv, cwd: process.cwd() }) + '\n');
const fail = (message) => { console.error(message); process.exit(1); };
if (process.env.FAKE_CLI_FAIL === tool) fail('boom');
const [mcp, verb, ...rest] = argv;
if (mcp !== 'mcp' || !['add', 'remove'].includes(verb)) fail('unexpected ' + argv.join(' '));
let scope, dash = false;
const env = {}, positional = [];
for (let i = 0; i < rest.length; i++) {
  const word = rest[i];
  if (dash) positional.push(word);
  else if (word === '--') dash = true;
  else if (word === '--scope' || word === '-s') scope = rest[++i];
  else if (word === '-e' || word === '--env') { const [k, ...v] = rest[++i].split('='); env[k] = v.join('='); }
  else positional.push(word);
}
if (tool !== 'codex' && scope !== 'user') fail('not the user scope');
if (verb === 'add' && !dash) fail(tool + ': no -- before the command');
const [name, command, ...args] = positional;
if (process.env.FAKE_CLI_NOWRITE === tool) process.exit(0);
const files = {
  claude: join(home, '.claude.json'),
  codex: join(home, '.codex', 'config.toml'),
  grok: join(home, '.grok', 'config.toml'),
};
const file = files[tool];
mkdirSync(dirname(file), { recursive: true });
if (file.endsWith('.json')) {
  const root = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  root.mcpServers ??= {};
  if (verb === 'add') {
    if (tool === 'claude' && root.mcpServers[name]) fail('MCP server ' + name + ' already exists in user config');
    root.mcpServers[name] = { ...(tool === 'claude' ? { type: 'stdio' } : {}), command, args, env };
  } else {
    if (!root.mcpServers[name]) fail('No MCP server named ' + name);
    delete root.mcpServers[name];
  }
  writeFileSync(file, JSON.stringify(root, null, 2));
} else {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = text.split('\n');
  const mine = (line) => new RegExp('^\\[mcp_servers\\.' + name + '(\\.|\\])').test(line);
  let inside = false;
  const kept = lines.filter((line) => { if (/^\[/.test(line)) inside = mine(line); return !inside; });
  if (verb === 'remove' && kept.length === lines.length) fail('No MCP server named ' + name);
  let out = kept.join('\n').replace(/\n+$/, '');
  if (verb === 'add') {
    out += '\n\n[mcp_servers.' + name + ']\ncommand = ' + JSON.stringify(command) + '\nargs = ' + JSON.stringify(args) + '\n';
    if (Object.keys(env).length) out += '\n[mcp_servers.' + name + '.env]\n' + Object.entries(env).map(([k, v]) => k + ' = ' + JSON.stringify(v)).join('\n') + '\n';
  }
  writeFileSync(file, out.replace(/^\n+/, '') + '\n');
}
`;

type Call = { tool: string; via: string; argv: string[]; cwd: string };

function fixture(t: TestContext, options: { tools?: string[]; env?: Record<string, string> } = {}) {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'mcp-connect-test-')));
  t.after(() => {
    const absolute = resolve(home);
    assert.ok(
      absolute.startsWith(realpathSync.native(tmpdir()) + sep) && basename(absolute).startsWith('mcp-connect-test-'),
    );
    rmSync(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const script = join(home, 'fake-cli.mjs');
  writeFileSync(script, fakeCli);
  const bin = join(home, 'tools');
  mkdirSync(bin);
  const cli = (folder: string, name: string, label = name) => {
    if (windows) {
      const file = join(folder, `${name}.cmd`);
      writeFileSync(file, `@echo off\r\n"${process.execPath}" "${script}" ${label} %*\r\n`);
      return file;
    }
    const file = join(folder, name);
    writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${script}" ${label} "$@"\n`);
    chmodSync(file, 0o755);
    return file;
  };
  for (const tool of options.tools ?? ['claude', 'codex', 'grok']) cli(bin, tool);
  // The app: a built MCP script under a folder with a space, started by an executable path with a space.
  const app = join(home, 'Pug Port');
  const mcpScript = join(app, 'dist', 'server', 'pugport-mcp.js');
  mkdirSync(dirname(mcpScript), { recursive: true });
  writeFileSync(mcpScript, '// fixture\n');
  let command: McpCommand = {
    command: join(app, windows ? 'PugPort.exe' : 'PugPort'),
    args: [mcpScript],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
  // Only this fake home and these fake tools: nothing on the real PATH, no real configuration.
  const host: Host = {
    ...currentHost(),
    home,
    env: {
      PATH: bin,
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(home, 'AppData', 'Local'),
      ...(windows ? { SystemRoot: process.env.SystemRoot, PATHEXT: process.env.PATHEXT } : {}),
      ...options.env,
    },
  };
  let cards: RuntimeTarget[] = [];
  const connections = new McpConnections({
    command: () => command,
    cards: () => cards,
    host,
    now: () => new Date('2026-10-11T08:00:00.000Z'),
  });
  const calls = (): Call[] =>
    existsSync(join(home, 'calls.jsonl'))
      ? readFileSync(join(home, 'calls.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as Call)
      : [];
  const read = (...parts: string[]) => readFileSync(join(home, ...parts), 'utf8');
  const write = (parts: string[], text: string) => {
    mkdirSync(dirname(join(home, ...parts)), { recursive: true });
    writeFileSync(join(home, ...parts), text);
  };
  const backups = (...parts: string[]) =>
    existsSync(join(home, ...parts))
      ? readdirSync(join(home, ...parts)).filter((name) => name.includes('.pugport-backup-'))
      : [];
  return {
    home,
    bin,
    cli,
    connections,
    calls,
    read,
    write,
    backups,
    mcpScript,
    get command() {
      return command;
    },
    setCommand: (next: McpCommand) => (command = next),
    setCards: (next: RuntimeTarget[]) => (cards = next),
  };
}

function disabledCodex(t: TestContext, name: 'pugport-app' | 'pugport', initial?: string) {
  const configPath = '/home/fixture/.codex/config.toml';
  const cli = '/fixture/codex';
  const command: McpCommand = {
    command: '/fixture/PugPort',
    args: ['/fixture/dist/server/pugport-mcp.js'],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
  const config = (server: string, disabled = false) =>
    `[mcp_servers.${server}]\ncommand = ${JSON.stringify(command.command)}\nargs = ${JSON.stringify(command.args)}\n${disabled ? 'enabled = false\n' : ''}[mcp_servers.${server}.env]\nELECTRON_RUN_AS_NODE = "1"\nPUGPORT_CALLER = "codex"\n`;
  const original = initial ?? config(name, true);
  const files = new Map([
    [configPath, original],
    [cli, 'fixture'],
    [command.args[0]!, 'fixture'],
  ]);
  const host = fakeHost('linux', {
    fs: fakeFs({
      existsSync: (path: string) => files.has(path),
      readFileSync: (path: string) => {
        if (!files.has(path)) throw new Error('Fixture file is absent');
        return files.get(path)!;
      },
      statSync: (path: string) => ({ isFile: () => files.has(path) }),
      copyFileSync: (from: string, to: string) => files.set(to, files.get(from)!),
    }),
  });
  const connections = new McpConnections({
    command: () => command,
    host,
    cards: () => [{ id: 'codex-native', provider: 'codex', environment: 'native', command: cli } as RuntimeTarget],
    now: () => new Date('2026-10-28T12:00:00Z'),
  });
  const calls: string[][] = [];
  // The CLI boundary writes only this in-memory config; no executable or real home is touched.
  t.mock.method(
    connections as unknown as { run(spec: unknown, executable: string, args: string[]): Promise<void> },
    'run',
    async (_spec: unknown, executable: string, args: string[]) => {
      assert.equal(executable, cli);
      calls.push(args);
      const kept = files
        .get(configPath)!
        .split(/(?=\[mcp_servers\.)/)
        .filter(
          (table) => !table.startsWith(`[mcp_servers.${args[2]}]`) && !table.startsWith(`[mcp_servers.${args[2]}.`),
        )
        .join('');
      files.set(configPath, args[1] === 'remove' ? kept : kept + config('pugport-app'));
    },
  );
  return { connections, calls, original, read: () => files.get(configPath)! };
}

for (const name of ['pugport-app', 'pugport'] as const) {
  test(`disabled Codex ${name} stays out of imports and reconnects by removing then adding`, async (t) => {
    const f = disabledCodex(t, name);
    assert.deepEqual(parseCodexMcp(f.original), []);
    assert.equal(parseCodexMcp(f.original, { includeDisabled: true })[0]!.enabled, false);
    const before = f.connections.list().tools.find((tool) => tool.id === 'codex')!;
    assert.equal(before.state, 'outdated');
    assert.equal(before.disabled, true);
    const result = await f.connections.connect('codex');
    assert.equal(result.changed, true);
    assert.equal(result.tool.state, 'connected');
    assert.equal(result.tool.disabled, undefined);
    assert.deepEqual(f.calls[0], ['mcp', 'remove', name]);
    assert.deepEqual(f.calls[1]!.slice(0, 3), ['mcp', 'add', 'pugport-app']);
    assert.equal(f.calls.length, 2);
    assert.doesNotMatch(f.read(), /enabled = false/);
  });

  test(`disabled Codex ${name} can be removed`, async (t) => {
    const f = disabledCodex(t, name);
    const result = await f.connections.remove('codex');
    assert.equal(result.changed, true);
    assert.equal(result.tool.state, 'absent');
    assert.equal(result.tool.disabled, undefined);
    assert.match(result.entry!, /enabled = false/);
    assert.deepEqual(f.calls, [['mcp', 'remove', name]]);
    assert.equal((await f.connections.remove('codex')).changed, false);
    assert.equal(f.calls.length, 1);
  });
}

test('an own disabled legacy entry does not mark an enabled Codex entry as turned off', (t) => {
  const legacy = disabledCodex(t, 'pugport').original;
  const current = legacy.replaceAll('mcp_servers.pugport', 'mcp_servers.pugport-app').replace('enabled = false\n', '');
  const f = disabledCodex(t, 'pugport', current + legacy);
  const tool = f.connections.list().tools.find((item) => item.id === 'codex')!;
  assert.equal(tool.state, 'outdated');
  assert.equal(tool.disabled, undefined);
});

test('disabled third-party Codex legacy entry stays absent and survives connecting and removing PugPort', async (t) => {
  const original = '[mcp_servers.pugport]\ncommand = "their-own-tool"\nargs = ["third-party.js"]\nenabled = false\n';
  const f = disabledCodex(t, 'pugport', original);
  const before = f.connections.list().tools.find((tool) => tool.id === 'codex')!;
  assert.equal(before.state, 'absent');
  assert.equal(before.disabled, undefined);
  assert.equal((await f.connections.remove('codex')).changed, false);
  assert.equal(f.calls.length, 0);
  assert.equal(f.read(), original);

  const connected = await f.connections.connect('codex');
  assert.equal(connected.tool.state, 'connected');
  assert.equal(connected.tool.disabled, undefined);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0]!.slice(0, 3), ['mcp', 'add', 'pugport-app']);
  assert.ok(f.read().startsWith(original));

  const removed = await f.connections.remove('codex');
  assert.equal(removed.changed, true);
  assert.equal(removed.tool.state, 'absent');
  assert.deepEqual(f.calls[1], ['mcp', 'remove', 'pugport-app']);
  assert.equal(f.read(), original);
});

test('each tool is detected, JSON files are edited locally, TOML uses its own command, and reconnecting changes nothing', async (t) => {
  const f = fixture(t);
  // Existing settings of other tools and other servers must survive.
  const claudeBefore = JSON.stringify(
    { numStartups: 3, mcpServers: { other: { command: 'npx', args: ['x'] } } },
    null,
    2,
  );
  f.write(['.claude.json'], claudeBefore);
  const cursorBefore = JSON.stringify({ mcpServers: { github: { url: 'https://example.invalid/mcp' } } }, null, 2);
  f.write(['.cursor', 'mcp.json'], cursorBefore);

  const listed = f.connections.list();
  assert.deepEqual(
    listed.tools.map((tool) => [tool.id, tool.detected, tool.method, tool.state, tool.server]),
    [
      ['claude', true, 'file', 'absent', 'pugport-app'],
      ['codex', true, 'command', 'absent', 'pugport-app'],
      ['cursor', true, 'file', 'absent', 'pugport-app'],
      ['grok', true, 'command', 'absent', 'pugport-app'],
    ],
  );
  const exe = f.command.command;
  assert.equal(
    listed.tools.find((tool) => tool.id === 'codex')!.manual,
    `codex mcp add pugport-app --env ELECTRON_RUN_AS_NODE=1 --env PUGPORT_CALLER=codex "--" "${exe}" ${f.mcpScript.includes(' ') ? `"${f.mcpScript}"` : f.mcpScript}`,
  );
  assert.deepEqual(JSON.parse(listed.snippet), {
    mcpServers: { 'pugport-app': { command: exe, args: [f.mcpScript], env: { ELECTRON_RUN_AS_NODE: '1' } } },
  });

  for (const id of ['claude', 'codex', 'cursor', 'grok'] as const) {
    const result = await f.connections.connect(id);
    assert.equal(result.changed, true, id);
    assert.equal(result.tool.state, 'connected', id);
  }
  // The official command lines, word for word, run in the home folder.
  const run = (tool: string) => f.calls().find((call) => call.tool === tool)!;
  assert.deepEqual(run('codex').argv, [
    'mcp',
    'add',
    'pugport-app',
    '--env',
    'ELECTRON_RUN_AS_NODE=1',
    '--env',
    'PUGPORT_CALLER=codex',
    '--',
    exe,
    f.mcpScript,
  ]);
  assert.deepEqual(run('grok').argv, [
    'mcp',
    'add',
    '--scope',
    'user',
    'pugport-app',
    '-e',
    'ELECTRON_RUN_AS_NODE=1',
    '-e',
    'PUGPORT_CALLER=grok',
    '--',
    exe,
    f.mcpScript,
  ]);
  assert.ok(f.calls().every((call) => resolve(call.cwd) === resolve(f.home)));
  assert.equal(f.calls().length, 2);

  // What each config now holds, next to what was there before.
  const claude = JSON.parse(f.read('.claude.json'));
  assert.equal(claude.numStartups, 3);
  assert.deepEqual(Object.keys(claude.mcpServers), ['other', 'pugport-app']);
  const cursor = JSON.parse(f.read('.cursor', 'mcp.json'));
  assert.deepEqual(cursor.mcpServers, {
    github: { url: 'https://example.invalid/mcp' },
    'pugport-app': { command: exe, args: [f.mcpScript], env: { ELECTRON_RUN_AS_NODE: '1', PUGPORT_CALLER: 'cursor' } },
  });
  assert.match(f.read('.codex', 'config.toml'), /\[mcp_servers\.pugport-app\]/);
  assert.match(f.read('.grok', 'config.toml'), /\[mcp_servers\.pugport-app\]/);

  // A backup of each file that existed, with exactly what it held; none for a file that did not exist yet.
  assert.deepEqual(f.backups(), ['.claude.json.pugport-backup-20261011T080000Z']);
  assert.equal(f.read('.claude.json.pugport-backup-20261011T080000Z'), claudeBefore);
  assert.deepEqual(f.backups('.cursor'), ['mcp.json.pugport-backup-20261011T080000Z']);
  assert.equal(f.read('.cursor', 'mcp.json.pugport-backup-20261011T080000Z'), cursorBefore);
  assert.deepEqual([f.backups('.codex'), f.backups('.grok')], [[], []]);
  // Written atomically: no temporary file is left beside it.
  assert.deepEqual(
    readdirSync(join(f.home, '.cursor')).filter((name) => name.endsWith('.tmp')),
    [],
  );

  // The result shows what was added, as the file holds it.
  const again = await f.connections.connect('codex');
  assert.equal(again.changed, false);
  assert.match(
    again.entry!,
    /^\[mcp_servers\.pugport-app\]\ncommand = .*\nargs = .*\n\n\[mcp_servers\.pugport-app\.env\]\nELECTRON_RUN_AS_NODE = "1"\nPUGPORT_CALLER = "codex"$/,
  );
  for (const id of ['claude', 'cursor', 'grok'] as const)
    assert.equal((await f.connections.connect(id)).changed, false);
  assert.equal(f.calls().length, 2);
  assert.deepEqual([f.backups().length, f.backups('.cursor').length], [1, 1]);

  // No token, key or session value in any file PugPort wrote or had written.
  for (const parts of [
    ['.claude.json'],
    ['.cursor', 'mcp.json'],
    ['.codex', 'config.toml'],
    ['.grok', 'config.toml'],
  ]) {
    const text = f.read(...parts);
    assert.ok(!text.includes(token), parts.join('/'));
    assert.doesNotMatch(text, /token|secret|bearer|authorization/i, parts.join('/'));
  }
});

test('removing takes out only PugPort, keeps a backup, and removing again changes nothing', async (t) => {
  const f = fixture(t);
  f.write(['.cursor', 'mcp.json'], JSON.stringify({ mcpServers: { github: { url: 'https://example.invalid/mcp' } } }));
  f.write(['.codex', 'config.toml'], '[mcp_servers.github]\nurl = "https://example.invalid/mcp"\n');
  for (const id of ['claude', 'codex', 'cursor', 'grok'] as const) await f.connections.connect(id);
  const added = f.calls().length;
  for (const id of ['claude', 'codex', 'cursor', 'grok'] as const) {
    const result = await f.connections.remove(id);
    assert.deepEqual([result.changed, result.tool.state], [true, 'absent'], id);
    assert.ok(result.backup && existsSync(result.backup), id);
    assert.ok(result.entry, id);
  }
  assert.deepEqual(
    f
      .calls()
      .slice(added)
      .map((call) => [call.tool, ...call.argv]),
    [
      ['codex', 'mcp', 'remove', 'pugport-app'],
      ['grok', 'mcp', 'remove', '--scope', 'user', 'pugport-app'],
    ],
  );
  assert.deepEqual(JSON.parse(f.read('.cursor', 'mcp.json')).mcpServers, {
    github: { url: 'https://example.invalid/mcp' },
  });
  assert.match(f.read('.codex', 'config.toml'), /\[mcp_servers\.github\]/);
  assert.doesNotMatch(f.read('.codex', 'config.toml'), /pugport/);
  const removed = f.calls().length;
  for (const id of ['claude', 'codex', 'cursor', 'grok'] as const)
    assert.equal((await f.connections.remove(id)).changed, false, id);
  assert.equal(f.calls().length, removed);
});

test('an outdated entry is replaced, and an old "pugport" entry that collides with PugPort’s own runs is cleared', async (t) => {
  const f = fixture(t);
  // An older PugPort suggested `codex mcp add pugport …`; PugPort's own Codex runs override that name with a URL,
  // and Codex then refuses to start.
  f.write(
    ['.codex', 'config.toml'],
    `[mcp_servers.github]\nurl = "https://example.invalid/mcp"\n\n[mcp_servers.pugport]\ncommand = "node"\nargs = [${JSON.stringify(f.mcpScript)}]\n`,
  );
  // PugPort moved: Claude still points at the old place.
  f.write(
    ['.claude.json'],
    JSON.stringify({ mcpServers: { 'pugport-app': { command: 'C:\\Old\\PugPort.exe', args: ['old.js'] } } }),
  );
  const tools = new Map(f.connections.list().tools.map((tool) => [tool.id, tool]));
  assert.equal(tools.get('codex')!.state, 'outdated');
  assert.match(tools.get('codex')!.note!, /旧的 pugport 条目/);
  assert.equal(tools.get('claude')!.state, 'outdated');

  await f.connections.connect('codex');
  await f.connections.connect('claude');
  assert.deepEqual(
    f.calls().map((call) => [call.tool, call.argv[1], call.argv.find((word) => /^pugport/.test(word))]),
    [
      ['codex', 'remove', 'pugport'],
      ['codex', 'add', 'pugport-app'],
    ],
  );
  const codex = f.read('.codex', 'config.toml');
  assert.match(codex, /\[mcp_servers\.github\]/);
  assert.match(codex, /\[mcp_servers\.pugport-app\]/);
  assert.doesNotMatch(codex, /\[mcp_servers\.pugport\]/);
  assert.equal(JSON.parse(f.read('.claude.json')).mcpServers['pugport-app'].command, f.command.command);

  // JSON files preserve every server other than pugport-app, including the old name.
  f.write(
    ['.cursor', 'mcp.json'],
    JSON.stringify({
      mcpServers: { github: { url: 'https://example.invalid/mcp' }, pugport: { command: 'node', args: [f.mcpScript] } },
    }),
  );
  assert.equal(f.connections.list().tools.find((tool) => tool.id === 'cursor')!.state, 'absent');
  await f.connections.connect('cursor');
  assert.deepEqual(Object.keys(JSON.parse(f.read('.cursor', 'mcp.json')).mcpServers), [
    'github',
    'pugport',
    'pugport-app',
  ]);

  // Someone else's server that merely shares the name is never removed.
  f.write(['.codex', 'config.toml'], '[mcp_servers.pugport]\ncommand = "their-own-tool"\n');
  assert.equal(f.connections.list().tools.find((tool) => tool.id === 'codex')!.state, 'absent');
});

test('PugPort’s own card for the tool is used before PATH; isolated accounts are not', async (t) => {
  const f = fixture(t);
  const cardFolder = join(f.home, 'card');
  mkdirSync(cardFolder);
  const card = (id: string, command: string, extra: Partial<RuntimeTarget> = {}): RuntimeTarget => ({
    id,
    provider: 'codex',
    label: id,
    command,
    environment: 'native',
    enabled: true,
    ...extra,
  });
  f.setCards([
    card('codex-account-1', f.cli(cardFolder, 'codex-isolated', 'codex@isolated'), { accountId: '1' }),
    card('codex-native', f.cli(cardFolder, 'codex-card', 'codex@card')),
  ]);
  await f.connections.connect('codex');
  assert.deepEqual(
    f.calls().map((call) => call.via),
    ['card'],
  );
});

test('refusals: a broken file, a secret in the entry, an unbuilt server, a failing or misdirected CLI, a missing tool', async (t) => {
  const f = fixture(t, {
    tools: ['claude', 'codex'],
    env: { FAKE_CLI_NOWRITE: 'codex' },
  });
  // Broken Cursor JSONC is left as it is, and no backup is made.
  const commented = '{\n  // mine\n  "mcpServers": { broken }\n}\n';
  f.write(['.cursor', 'mcp.json'], commented);
  await assert.rejects(f.connections.connect('cursor'), /注释/);
  assert.equal(f.read('.cursor', 'mcp.json'), commented);
  assert.deepEqual(readdirSync(join(f.home, '.cursor')), ['mcp.json']);

  const failing = fixture(t, { tools: ['codex'], env: { FAKE_CLI_FAIL: 'codex' } });
  await assert.rejects(failing.connections.connect('codex'), /Codex 的命令没有成功：boom/);
  // The command ran but the file PugPort reads did not change (a CLI that keeps its settings elsewhere, e.g. WSL).
  await assert.rejects(f.connections.connect('codex'), /没有出现 pugport-app.*WSL/);

  // Grok is not on this computer: only the command to copy.
  const grok = f.connections.list().tools.find((tool) => tool.id === 'grok')!;
  assert.deepEqual([grok.detected, grok.method], [false, 'copy']);
  assert.match(grok.note!, /没有在这台电脑上找到 Grok CLI/);
  await assert.rejects(f.connections.connect('grok'), /没有在这台电脑上找到/);

  // Settings found without the command: copy only, with the reason.
  f.write(['.grok', 'config.toml'], '');
  const found = f.connections.list().tools.find((tool) => tool.id === 'grok')!;
  assert.deepEqual([found.detected, found.method], [true, 'copy']);
  assert.match(found.note!, /没找到 grok 命令/);

  const before = f.calls().length;
  f.setCommand({ ...f.command, env: { ELECTRON_RUN_AS_NODE: '1', PUGPORT_TOKEN: token } });
  await assert.rejects(f.connections.connect('claude'), /PUGPORT_TOKEN/);
  f.setCommand({ ...f.command, env: { ELECTRON_RUN_AS_NODE: '1' }, args: [join(f.home, 'missing.js')] });
  await assert.rejects(f.connections.connect('claude'), /还没有构建/);
  assert.equal(f.calls().length, before);
  assert.ok(!existsSync(join(f.home, '.claude.json')));
});

test('all JSON tools preserve comments, trailing commas, formatting and other servers byte-for-byte', async (t) => {
  for (const [id, parts] of [
    ['cursor', ['.cursor', 'mcp.json']],
    ['claude', ['.claude.json']],
  ] as const) {
    const f = fixture(t, { tools: [] });
    const other = '"other" : { "command":"npx", "args":["fixture"], "env": { "KEY": "fixture-only\\\\value", }, }';
    const before = `\uFEFF{\r\n\t// settings comment\r\n\t"theme" : "dark",\r\n\t"mcpServers" : {\r\n\t\t/* server comment */ ${other}, // trailing comment\r\n\t},\r\n}\r\n`;
    f.write([...parts], before);
    const added = await f.connections.connect(id);
    const after = f.read(...parts);
    assert.equal(added.changed, true);
    assert.equal(added.tool.state, 'connected');
    assert.ok(after.includes(other));
    assert.deepEqual(parse(after.slice(1)).mcpServers.other, parse(before.slice(1)).mcpServers.other);
    assert.equal(f.calls().length, 0);
    assert.equal(readFileSync(added.backup!, 'utf8'), before);
    const removed = await f.connections.remove(id);
    assert.equal(removed.changed, true);
    assert.equal(readFileSync(removed.backup!, 'utf8'), after);
    assert.equal(f.read(...parts), before);
  }
});

test('JSONC removal retains adjacent comments and separators for first, middle, last and sole entries', async (t) => {
  const mine = '"pugport-app": { "command": "old", "args": [] }';
  for (const [servers, kept] of [
    [
      `/* before */ ${mine}, /* after */ "other": {"env":{"KEY":"fixture"}},`,
      '/* before */  /* after */ "other": {"env":{"KEY":"fixture"}},',
    ],
    [`"a": {}, /* before */ ${mine}, /* after */ "b": {},`, '"a": {} /* before */ , /* after */ "b": {},'],
    [`"a": {}, /* before */ ${mine} /* after */,`, '"a": {} /* before */  /* after */,'],
    [`/* before */ ${mine} /* after */,`, '/* before */  /* after */'],
  ]) {
    const f = fixture(t, { tools: [] });
    f.write(['.cursor', 'mcp.json'], `{ "mcpServers": {${servers}}, "setting": 1, }`);
    await f.connections.remove('cursor');
    const after = f.read('.cursor', 'mcp.json');
    assert.equal(after, `{ "mcpServers": {${kept}}, "setting": 1, }`);
    assert.equal(parse(after).setting, 1);
  }
});

test('broken JSONC and non-object roots or server maps are refused without writes or backups', async (t) => {
  for (const text of [
    '[]',
    'null',
    '1',
    '',
    '/* only a comment */',
    '{"mcpServers": []}',
    '{"mcpServers": {',
    '{"mcpServers": {}, "other": true false}',
    '{"mcpServers": {"pugport-app": {"args": []}}} garbage',
  ]) {
    const f = fixture(t, { tools: [] });
    f.write(['.cursor', 'mcp.json'], text);
    await assert.rejects(f.connections.connect('cursor'), /PugPort 不改它/);
    await assert.rejects(f.connections.remove('cursor'), /PugPort 不改它/);
    assert.equal(f.read('.cursor', 'mcp.json'), text);
    assert.deepEqual(f.backups('.cursor'), []);
  }
});

test('updating an existing JSONC entry preserves all bytes outside its value', async (t) => {
  const f = fixture(t, { tools: [] });
  const prefix = '{ /* root */ "mcpServers": {"pugport-app" : ';
  const suffix = ', /* other */ "other": { "env": { "KEY": "fixture" } },},}';
  f.write(['.cursor', 'mcp.json'], prefix + '{"command":"old"}' + suffix);
  await f.connections.connect('cursor');
  assert.equal(
    f.read('.cursor', 'mcp.json'),
    prefix + JSON.stringify({ ...f.command, env: { ...f.command.env, PUGPORT_CALLER: 'cursor' } }) + suffix,
  );
});

test('entries without the caller marker are outdated and updating writes each client identity once', async (t) => {
  const f = fixture(t);
  for (const [id, parts] of [
    ['claude', ['.claude.json']],
    ['cursor', ['.cursor', 'mcp.json']],
  ] as const) {
    f.write([...parts], JSON.stringify({ mcpServers: { 'pugport-app': f.command } }));
    assert.equal(f.connections.list().tools.find((tool) => tool.id === id)!.state, 'outdated');
    assert.equal((await f.connections.connect(id)).changed, true);
    assert.equal(JSON.parse(f.read(...parts)).mcpServers['pugport-app'].env.PUGPORT_CALLER, id);
    assert.equal((await f.connections.connect(id)).changed, false);
  }
  for (const id of ['codex', 'grok'] as const) {
    f.write(
      [`.${id}`, 'config.toml'],
      `[mcp_servers.pugport-app]\ncommand = ${JSON.stringify(f.command.command)}\nargs = ${JSON.stringify(f.command.args)}\n[mcp_servers.pugport-app.env]\nELECTRON_RUN_AS_NODE = "1"\n`,
    );
    assert.equal(f.connections.list().tools.find((tool) => tool.id === id)!.state, 'outdated');
    assert.equal((await f.connections.connect(id)).changed, true);
    assert.match(f.read(`.${id}`, 'config.toml'), new RegExp(`PUGPORT_CALLER = "${id}"`));
    assert.equal((await f.connections.connect(id)).changed, false);
  }
});

test('the routes refuse Gemini even with its executable and settings present', async (t) => {
  const f = fixture(t, { tools: ['gemini', 'agy'] });
  const geminiConfig = '{"mcpServers":{"kept":{"command":"fixture"}}}';
  f.write(['.gemini', 'settings.json'], geminiConfig);
  f.write(['.cursor', 'mcp.json'], '{}');
  const app = express();
  app.use(express.json());
  mcpConnectRoutes(app, f.connections);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ error: error instanceof z.ZodError ? 'invalid' : (error as Error).message });
  });
  const server = await listenForFetch(app);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/external/connections`;
  const listed = (await (await fetch(base)).json()) as { tools: { id: string }[]; server: string };
  assert.deepEqual([listed.server, listed.tools.length], ['pugport-app', 4]);
  assert.equal((await fetch(`${base}/vscode`, { method: 'POST' })).status, 400);
  for (const id of ['gemini', 'agy'])
    for (const method of ['POST', 'DELETE']) assert.equal((await fetch(`${base}/${id}`, { method })).status, 400);
  assert.equal(f.read('.gemini', 'settings.json'), geminiConfig);
  assert.deepEqual(f.backups('.gemini'), []);
  assert.deepEqual(f.calls(), []);
  const connected = (await (await fetch(`${base}/cursor`, { method: 'POST' })).json()) as { changed: boolean };
  assert.equal(connected.changed, true);
  const removed = (await (await fetch(`${base}/cursor`, { method: 'DELETE' })).json()) as { changed: boolean };
  assert.equal(removed.changed, true);
});
