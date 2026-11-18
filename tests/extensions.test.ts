import assert from 'node:assert/strict';
import { execFileSync } from '../src/server/platform/test-process.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isolatedUserPath } from '../src/server/platform/under-test.ts';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import AdmZip from 'adm-zip';
import {
  ExtensionHub,
  extractZip,
  parseCodexMcp,
  parseGitHubLink,
  parseMcpInput,
  parseSkill,
  splitCommandLine,
} from '../src/server/extensions.ts';
import { claudeExecutionArgs } from '../src/server/adapters/claude.ts';
import type { ExecuteContext } from '../src/shared/types.ts';
import type { McpExtension } from '../src/shared/extensions.ts';

const scratch = mkdtempSync(join(tmpdir(), 'comborunner-extensions-'));
beforeEach(() => {
  process.env.COMBORUNNER_SECRETS_DIR = mkdtempSync(join(scratch, 'secrets-'));
});
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A tiny MCP server over stdio: one read-only tool and one that changes things. */
const fakeServer = join(scratch, 'fake-mcp.mjs');
writeFileSync(
  fakeServer,
  `import { createInterface } from 'node:readline';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
console.log('a server that logs to stdout first');
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize')
    return send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
  if (message.method === 'tools/list')
    return send({ jsonrpc: '2.0', id: message.id, result: { tools: [
      { name: 'echo', description: 'Repeats text', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
      { name: 'write.note', description: 'Saves a note', inputSchema: { type: 'object' } },
    ] } });
  if (message.method === 'tools/call')
    return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: message.params.name + ':' + (message.params.arguments.text ?? '') + ':' + (process.env.FAKE_KEY ?? '') }] } });
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'nope' } });
});
`,
);

test('a SKILL.md gives its name and description in any common front matter style', () => {
  const folded = parseSkill(
    '---\nname: aws-auth\ndescription: >-\n  Adds user authentication\n  to web apps.\nlicense: MIT\n---\n# Body\nDo this.',
  );
  assert.equal(folded.name, 'aws-auth');
  assert.equal(folded.description, 'Adds user authentication to web apps.');
  assert.equal(folded.body, '# Body\nDo this.');
  const quoted = parseSkill(`---\r\nname: "pdf"\r\ndescription: 'Read PDFs, it''s fast'\r\n---\r\nText`);
  assert.equal(quoted.name, 'pdf');
  assert.equal(quoted.description, "Read PDFs, it's fast");
  assert.equal(parseSkill('# Just markdown').name, undefined);
});

test('tools come from any app’s configuration, a command line or an address', () => {
  const fromJson = parseMcpInput(`{
    // Cursor allows comments
    "mcpServers": {
      "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\\\Users"], },
      "search": { "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer <YOUR_TOKEN>" } },
      "off": { "command": "x", "disabled": true },
    },
  }`);
  assert.deepEqual(
    fromJson.map((item) => [item.name, item.transport]),
    [
      ['files', 'stdio'],
      ['search', 'http'],
    ],
  );
  assert.deepEqual(fromJson[0]!.args, ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users']);
  const command = parseMcpInput('BRAVE_API_KEY=your-api-key npx -y @playwright/mcp@latest --isolated')[0]!;
  assert.equal(command.name, 'playwright-mcp');
  assert.equal(command.command, 'npx');
  assert.deepEqual(command.args, ['-y', '@playwright/mcp@latest', '--isolated']);
  assert.deepEqual(command.env, { BRAVE_API_KEY: 'your-api-key' });
  const added = parseMcpInput('claude mcp add --scope user fetch -- uvx mcp-server-fetch')[0]!;
  assert.deepEqual([added.name, added.command, added.args], ['fetch', 'uvx', ['mcp-server-fetch']]);
  assert.equal(parseMcpInput('https://api.example.com/mcp')[0]!.transport, 'http');
  assert.deepEqual(splitCommandLine('node "C:\\My Tools\\server.js" --name \'a b\''), [
    'node',
    'C:\\My Tools\\server.js',
    '--name',
    'a b',
  ]);
  assert.throws(() => parseMcpInput('{ "nothing": 1 }'), /没有在这段配置里找到/);
});

test('Gemini CLI and Antigravity command imports are refused', () => {
  for (const command of ['gemini mcp add fetch -- uvx mcp-server-fetch', 'gemini', 'agy'])
    assert.throws(() => parseMcpInput(command), /不再支持 Gemini CLI/);
});

test('extension imports ignore Gemini settings and skills present on disk', async () => {
  const home = isolatedUserPath(homedir());
  assert.notEqual(home, homedir());
  const skill = join(home, '.gemini', 'skills', 'gemini-only-fixture');
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: gemini-only-fixture\ndescription: Fixture\n---\nFixture');
  const settings = join(home, '.gemini', 'settings.json');
  const original = JSON.stringify({ mcpServers: { 'gemini-only-fixture': { command: 'fixture' } } });
  writeFileSync(settings, original);
  const hub = new ExtensionHub(join(scratch, 'hub-no-gemini-imports'));
  const preview = await hub.previewImports();
  assert.ok(preview.drafts.every((draft) => draft.name !== 'gemini-only-fixture'));
  assert.equal(readFileSync(settings, 'utf8'), original);
});

test('Codex config.toml MCP servers are read, with their environment and multi-line arguments', () => {
  const servers = parseCodexMcp(`model = "gpt"
[mcp_servers.node_repl]
command = 'node'
args = [
  "repl.js", # comment
  "--flag",
]
startup_timeout_sec = 20

[mcp_servers.node_repl.env]
TOKEN = "abc"

[mcp_servers."remote.one"]
url = "https://example.com/mcp"
http_headers = { "X-Key" = "k" }

[mcp_servers.codegraph.tools.explore]
approval = "auto"

[mcp_servers.off]
command = "x"
enabled = false
`);
  assert.deepEqual(
    servers.map((server) => server.name),
    ['node_repl', 'remote.one'],
  );
  assert.deepEqual(servers[0]!.args, ['repl.js', '--flag']);
  assert.deepEqual(servers[0]!.env, { TOKEN: 'abc' });
  assert.deepEqual(servers[1]!.headers, { 'X-Key': 'k' });
});

test('GitHub links name the repository, the branch and the folder', () => {
  assert.deepEqual(parseGitHubLink('https://github.com/anthropics/skills/tree/main/skills/pdf'), {
    owner: 'anthropics',
    repo: 'skills',
    rest: ['main', 'skills', 'pdf'],
    file: false,
  });
  assert.equal(parseGitHubLink('https://github.com/a/b.git')!.repo, 'b');
  assert.equal(parseGitHubLink('https://github.com/a/b/blob/main/x/SKILL.md')!.file, true);
  assert.equal(parseGitHubLink('https://gitlab.com/a/b'), undefined);
});

test('a skill folder installs as a copy that executors can open, read and that uninstalls cleanly', async () => {
  const source = join(scratch, 'skills-source');
  mkdirSync(join(source, 'group', 'notes'), { recursive: true });
  mkdirSync(join(source, 'report', 'scripts'), { recursive: true });
  writeFileSync(
    join(source, 'group', 'notes', 'SKILL.md'),
    '---\nname: meeting-notes\ndescription: 整理会议记录\n---\n按模板整理。',
  );
  writeFileSync(
    join(source, 'report', 'SKILL.md'),
    '---\nname: weekly-report\ndescription: Write the weekly report\n---\nSee reference.md.',
  );
  writeFileSync(join(source, 'report', 'reference.md'), 'The template');
  writeFileSync(join(source, 'report', 'scripts', 'make.py'), 'print(1)');
  writeFileSync(join(scratch, 'secret.txt'), 'outside');
  const hub = new ExtensionHub(join(scratch, 'hub-skills'));
  const preview = await hub.preview(source);
  assert.deepEqual(preview.drafts.map((draft) => draft.name).sort(), ['meeting-notes', 'weekly-report']);
  const report = preview.drafts.find((draft) => draft.name === 'weekly-report')!;
  await hub.install(preview.token, [report.key]);
  const [installed] = hub.all();
  assert.equal(installed!.kind, 'skill');
  assert.ok(installed!.kind === 'skill' && installed.managed && installed.path.startsWith(join(scratch, 'hub-skills')));

  // Executors see the skill listed, open it, and read its files, but nothing outside it.
  assert.match(hub.skillHint('写周报')!, /weekly-report：Write the weekly report/);
  assert.deepEqual(
    hub.bridgeTools(false).map((tool) => tool.name),
    ['use_skill', 'read_skill_file'],
  );
  const [useSkill, readSkill] = hub.bridgeTools(false);
  assert.match(String(useSkill!.description), /SKILL\.md/);
  assert.match(String(useSkill!.description), /runs no scripts/);
  assert.match(String(readSkill!.description), /never executes/);
  assert.equal((useSkill!.annotations as { readOnlyHint?: boolean }).readOnlyHint, true);
  assert.equal((readSkill!.annotations as { readOnlyHint?: boolean }).readOnlyHint, true);
  const opened = await hub.call('use_skill', { name: 'Weekly-Report' }, false);
  assert.match(String(opened.content[0]!.text), /See reference\.md\.[\s\S]*- reference\.md[\s\S]*- scripts\/make\.py/);
  const file = await hub.call('read_skill_file', { skill: 'weekly-report', path: 'reference.md' }, false);
  assert.equal(file.content[0]!.text, 'The template');
  await assert.rejects(hub.call('read_skill_file', { skill: 'weekly-report', path: '../../secret.txt' }, false));
  await assert.rejects(hub.call('use_skill', { name: 'missing' }, false), /没有名为/);

  // Installing the same name again replaces it; uninstalling removes the copy.
  const again = await hub.preview(join(source, 'report'));
  assert.equal(again.drafts[0]!.installed, true);
  await hub.install(again.token, [again.drafts[0]!.key]);
  assert.equal(hub.all().length, 1);
  const copy = (hub.all()[0] as { path: string }).path;
  await hub.remove(hub.all()[0]!.id);
  assert.equal(existsSync(copy), false);
  assert.equal(hub.skillHint('x'), undefined);
  assert.ok(existsSync(join(source, 'report', 'SKILL.md')), 'the original folder stays');
});

test('a zip of skills installs like a folder', { skip: process.platform !== 'win32' }, async () => {
  const folder = join(scratch, 'zip-source', 'translator');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'SKILL.md'), '---\nname: translator\ndescription: 翻译文档\n---\n逐段翻译。');
  const zip = join(scratch, 'skills.zip');
  execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), [
    '-a',
    '-cf',
    zip,
    '-C',
    join(scratch, 'zip-source'),
    'translator',
  ]);
  const hub = new ExtensionHub(join(scratch, 'hub-zip'));
  const preview = await hub.preview(zip);
  assert.deepEqual(
    preview.drafts.map((draft) => draft.name),
    ['translator'],
  );
  await hub.install(preview.token, [preview.drafts[0]!.key]);
  assert.match(String((await hub.call('use_skill', { name: 'translator' }, false)).content[0]!.text), /逐段翻译/);
});

// Twin of the Windows test above for every system: macOS and Linux unpack zip files in Node (no `unzip`).
test('a zip made by another tool installs like a folder on every system', async () => {
  const archive = new AdmZip();
  archive.addFile('translator/SKILL.md', Buffer.from('---\nname: translator\ndescription: 翻译文档\n---\n逐段翻译。'));
  const zip = join(scratch, 'skills-any.zip');
  archive.writeZip(zip);
  const hub = new ExtensionHub(join(scratch, 'hub-zip-any'));
  const preview = await hub.preview(zip);
  assert.deepEqual(
    preview.drafts.map((draft) => draft.name),
    ['translator'],
  );
  await hub.install(preview.token, [preview.drafts[0]!.key]);
  assert.match(String((await hub.call('use_skill', { name: 'translator' }, false)).content[0]!.text), /逐段翻译/);
});

test('an MCP tool asks for missing keys, runs once for every task, and read-only tasks get only read-only tools', async () => {
  const hub = new ExtensionHub(join(scratch, 'hub-mcp'));
  const config = JSON.stringify({
    mcpServers: { 'Fake Notes': { command: process.execPath, args: [fakeServer], env: { FAKE_KEY: '<YOUR_KEY>' } } },
  });
  const preview = await hub.preview(config);
  const [draft] = preview.drafts;
  assert.deepEqual(draft!.needs, ['FAKE_KEY']);
  assert.match(draft!.detail!, /fake-mcp\.mjs/);
  await hub.install(preview.token, [draft!.key], { [draft!.key]: { FAKE_KEY: 'k-123' } });
  const id = hub.all()[0]!.id;
  const tools = await hub.check(id);
  assert.deepEqual(
    tools.map((tool) => [tool.name, tool.readOnly]),
    [
      ['echo', true],
      ['write.note', false],
    ],
  );
  // The page never sees the key itself.
  const view = hub.list()[0] as { env?: Record<string, boolean> };
  assert.deepEqual(view.env, { FAKE_KEY: true });

  const [readTool] = hub.toolNames(false);
  const writeTool = hub.toolNames(true).find((name) => name !== readTool)!;
  assert.equal(hub.bridgeTools(false).length, 1);
  assert.equal(hub.toolNames(true).length, 2);
  assert.ok(hub.toolNames(true).every((name) => /^[A-Za-z0-9_-]{1,60}$/.test(name)));
  const echoed = await hub.call(readTool!, { text: 'hi' }, false);
  assert.deepEqual(echoed.content, [{ type: 'text', text: 'echo:hi:k-123' }]);
  await assert.rejects(hub.call(writeTool, {}, false), /只读/);
  const written = await hub.call(writeTool, { text: 'x' }, true);
  assert.equal(written.content[0]!.text, 'write.note:x:k-123');

  // Turned off, its tools disappear; uninstalled, it is gone.
  await hub.setEnabled(id, false);
  assert.deepEqual(hub.bridgeTools(true), []);
  await hub.remove(id);
  assert.deepEqual(hub.all(), []);
  await hub.stopAll();
});

const fakeConfig = (name: string, key: string) =>
  JSON.stringify({ mcpServers: { [name]: { command: process.execPath, args: [fakeServer], env: { FAKE_KEY: key } } } });

test('adding the same MCP twice keeps independent named instances and credentials', async (t) => {
  const hub = new ExtensionHub(join(scratch, 'hub-multiple'));
  t.after(() => hub.stopAll());
  const first = await hub.preview(fakeConfig('Mail', 'personal-secret'));
  const [personalId] = await hub.install(first.token, [first.drafts[0]!.key]);
  await hub.check(personalId!);
  const [personalTool] = hub.toolNames(false);

  const second = await hub.preview(fakeConfig('Mail', 'work-secret'));
  assert.equal(second.drafts[0]!.existingId, personalId);
  const [workId] = await hub.install(second.token, [second.drafts[0]!.key]);
  await hub.check(workId!);
  assert.notEqual(workId, personalId);
  assert.deepEqual(
    hub.all().map((item) => item.name),
    ['Mail', 'Mail (2)'],
  );
  const workTool = hub.toolNames(false).find((name) => name !== personalTool)!;
  assert.equal(
    (await hub.call(personalTool!, { text: 'personal' }, false)).content[0]!.text,
    'echo:personal:personal-secret',
  );
  assert.equal((await hub.call(workTool, { text: 'work' }, false)).content[0]!.text, 'echo:work:work-secret');
  assert.doesNotMatch(JSON.stringify(hub.list()), /personal-secret|work-secret/);
  await hub.remove(personalId!);
  assert.deepEqual(hub.toolNames(false), [workTool], 'removing another connection does not rename this tool');
});

test('project MCP selection limits catalogues and calls independently from skills and global enabling', async (t) => {
  const directory = join(scratch, 'hub-project-scope');
  mkdirSync(directory);
  const item = (id: string, enabled = true): McpExtension => ({
    kind: 'mcp',
    id,
    name: id,
    transport: 'stdio',
    command: process.execPath,
    args: [fakeServer],
    source: 'synthetic',
    enabled,
    installedAt: new Date().toISOString(),
    tools: [{ name: 'echo', description: 'Echo', readOnly: true, inputSchema: { type: 'object' } }],
  });
  writeFileSync(
    join(directory, 'extensions.json'),
    JSON.stringify({ items: [item('second'), item('first'), item('disabled', false)] }),
  );
  const hub = new ExtensionHub(directory);
  t.after(() => hub.stopAll());
  const all = hub.toolNames(false);
  assert.equal(all.length, 2);
  assert.deepEqual(all, [...all].sort(), 'catalogue ordering is stable');
  const selected = hub.toolNames(false, undefined, ['first', 'disabled']);
  assert.equal(selected.length, 1);
  assert.deepEqual(
    hub.bridgeTools(false, undefined, ['first']).map((tool) => tool.name),
    selected,
  );
  assert.deepEqual(hub.toolNames(true, undefined, []), []);
  assert.deepEqual(hub.bridgeTools(true, undefined, ['missing']), []);
  const other = all.find((name) => !selected.includes(name))!;
  await assert.rejects(hub.call(other, {}, false, undefined, undefined, ['first']), /没有这个扩展工具/);
  assert.equal(
    (await hub.call(selected[0]!, { text: 'scoped' }, false, undefined, undefined, ['first'])).content[0]!.text,
    'echo:scoped:',
  );
  await hub.setEnabled('first', false);
  assert.deepEqual(hub.toolNames(false, undefined, ['first']), []);
  await assert.rejects(hub.call(selected[0]!, {}, false, undefined, undefined, ['first']), /没有这个扩展工具/);
});

test('project MCP catalogue checks only selected servers and does not change skill scope', async (t) => {
  const directory = join(scratch, 'hub-project-check');
  mkdirSync(directory);
  writeFileSync(
    join(directory, 'extensions.json'),
    JSON.stringify({
      items: [
        ...['first', 'second'].map((id) => ({
          kind: 'mcp',
          id,
          name: id,
          transport: 'http',
          url: 'http://127.0.0.1/never-connect',
          enabled: true,
          source: 'synthetic',
          installedAt: '',
        })),
        {
          kind: 'skill',
          id: 'skill',
          name: 'fixture-skill',
          description: 'Fixture',
          path: directory,
          source: 'synthetic',
          managed: false,
          enabled: true,
          installedAt: '',
        },
      ],
    }),
  );
  const hub = new ExtensionHub(directory);
  const checked: string[] = [];
  t.mock.method(hub, 'check', async (id: string) => {
    checked.push(id);
    return [];
  });
  assert.deepEqual(hub.toolNames(false, [], []), []);
  assert.ok(hub.bridgeTools(false, undefined, []).some((tool) => tool.name === 'use_skill'));
  assert.deepEqual(checked, []);
  hub.bridgeTools(false, [], ['second']);
  assert.deepEqual(checked, ['second']);
});

test('project MCP calls recheck live scope, server configuration and catalogue after approval', async (t) => {
  for (const change of ['scope', 'disabled', 'configuration', 'catalogue', 'rename'] as const) {
    const hub = new ExtensionHub(join(scratch, `hub-project-recheck-${change}`));
    t.after(() => hub.stopAll());
    const preview = await hub.preview(fakeConfig('Fixture', 'synthetic'));
    const [id] = await hub.install(preview.token, [preview.drafts[0]!.key]);
    await hub.check(id!);
    const name = hub.toolNames(false)[0]!;
    t.mock.method(hub, 'check', async () => []);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const approved = new Promise<void>((resolve) => {
      release = resolve;
    });
    let allowed = true;
    const pending = hub.call(
      name,
      { text: 'allowed' },
      false,
      undefined,
      undefined,
      [id!],
      async () => {
        enter();
        await approved;
      },
      () => {
        if (!allowed) throw new Error('project scope revoked');
      },
    );
    const settled = Promise.allSettled([pending]);
    await entered;
    if (change === 'scope') allowed = false;
    if (change === 'disabled') await hub.setEnabled(id!, false);
    if (change === 'configuration') await hub.configure(id!, { FAKE_KEY: 'changed-synthetic' });
    if (change === 'catalogue') (hub.all()[0] as McpExtension).tools = [];
    if (change === 'rename') await hub.rename(id!, 'New display name');
    release();
    const [result] = await settled;
    assert.equal(result!.status, change === 'rename' ? 'fulfilled' : 'rejected', change);
    if (result!.status === 'fulfilled') assert.equal(result.value.content[0]!.text, 'echo:allowed:synthetic');
  }
});

test('MCP replacement is explicit, preserves identity and keeps its custom name and enabled state', async (t) => {
  const hub = new ExtensionHub(join(scratch, 'hub-replace'));
  t.after(() => hub.stopAll());
  const first = await hub.preview(fakeConfig('Mail', 'original-secret'));
  const key = first.drafts[0]!.key;
  const [id] = await hub.install(first.token, [key], {}, { [key]: { name: 'Work Gmail' } });
  await hub.check(id!);
  const tools = hub.toolNames(false);
  const installedAt = hub.all()[0]!.installedAt;
  await hub.setEnabled(id!, false);

  const replacement = await hub.preview(fakeConfig('Mail', 'replacement-secret'));
  const replacementKey = replacement.drafts[0]!.key;
  const ids = await hub.install(replacement.token, [replacementKey], {}, { [replacementKey]: { replaceId: id } });
  assert.deepEqual(ids, [id]);
  assert.equal(hub.all().length, 1);
  assert.equal(hub.all()[0]!.name, 'Work Gmail');
  assert.equal(hub.all()[0]!.enabled, false);
  assert.equal(hub.all()[0]!.installedAt, installedAt);
  await hub.setEnabled(id!, true);
  await hub.check(id!);
  assert.deepEqual(hub.toolNames(false), tools);
  assert.equal((await hub.call(tools[0]!, {}, false)).content[0]!.text, 'echo::replacement-secret');
});

test('renaming an MCP keeps granted tool IDs and rejects duplicate or invalid names without mutation', async (t) => {
  const hub = new ExtensionHub(join(scratch, 'hub-rename'));
  t.after(() => hub.stopAll());
  for (const name of ['Personal', 'Work']) {
    const preview = await hub.preview(fakeConfig(name, `${name}-secret`));
    const [id] = await hub.install(preview.token, [preview.drafts[0]!.key]);
    await hub.check(id!);
  }
  const id = hub.all()[0]!.id;
  const tools = hub.toolNames(false);
  const personalTool = hub.bridgeTools(false).find((tool) => String(tool.description).startsWith('[Personal] '))?.name;
  assert.ok(typeof personalTool === 'string');
  const inFlight = hub.call(personalTool, { text: 'before' }, false);
  await hub.rename(id, '  我的 Gmail  ');
  assert.equal(hub.all()[0]!.id, id);
  assert.equal(hub.all()[0]!.name, '我的 Gmail');
  assert.deepEqual(hub.toolNames(false), tools);
  assert.equal((await inFlight).content[0]!.text, 'echo:before:Personal-secret');
  assert.equal((await hub.call(personalTool, { text: 'after' }, false)).content[0]!.text, 'echo:after:Personal-secret');
  assert.match(String(hub.bridgeTools(false).find((tool) => tool.name === personalTool)?.description), /我的 Gmail/);
  for (const invalid of ['work', '', '  ', 'a'.repeat(81), 'bad\nname'])
    await assert.rejects(hub.rename(id, invalid), /名称|其他名称/);
  assert.equal(hub.all()[0]!.name, '我的 Gmail');
  assert.equal(new ExtensionHub(join(scratch, 'hub-rename')).all()[0]!.name, '我的 Gmail');
});

test('invalid MCP install batches leave every existing instance and persisted config untouched', async (t) => {
  const directory = join(scratch, 'hub-invalid-batch');
  const hub = new ExtensionHub(directory);
  t.after(() => hub.stopAll());
  const original = await hub.preview(fakeConfig('Original', 'keep-secret'));
  const [id] = await hub.install(original.token, [original.drafts[0]!.key]);
  await hub.check(id!);
  const before = structuredClone(hub.all());
  const beforeFile = readFileSync(join(directory, 'extensions.json'), 'utf8');
  const batch = await hub.preview(
    JSON.stringify({
      mcpServers: {
        First: { command: process.execPath, args: [fakeServer] },
        Second: { command: process.execPath, args: [fakeServer] },
      },
    }),
  );
  const [first, second] = batch.drafts.map((draft) => draft.key);
  const options = [
    { [first!]: { replaceId: id }, [second!]: { name: '' } },
    { [first!]: { replaceId: id }, [second!]: { name: 'original' } },
    { [first!]: { name: 'Same' }, [second!]: { name: 'same' } },
    { [first!]: { replaceId: id }, [second!]: { replaceId: id } },
    { [first!]: { replaceId: id }, [second!]: { replaceId: 'missing' } },
  ];
  for (const option of options) {
    await assert.rejects(hub.install(batch.token, [first!, second!], {}, option));
    assert.deepEqual(hub.all(), before);
    assert.equal(readFileSync(join(directory, 'extensions.json'), 'utf8'), beforeFile);
  }
  await assert.rejects(hub.install(batch.token, [first!, 'missing']));
  await assert.rejects(hub.install(batch.token, [first!, first!]));
  assert.deepEqual(hub.all(), before);
});

test('MCP names and replacement IDs cannot change a skill and omitted credentials remain intact', async (t) => {
  const hub = new ExtensionHub(join(scratch, 'hub-private-settings'));
  t.after(() => hub.stopAll());
  const folder = join(scratch, 'private-settings-skill');
  mkdirSync(folder);
  writeFileSync(join(folder, 'SKILL.md'), '---\nname: local-skill\ndescription: Test\n---\nTest.');
  const skill = await hub.preview(folder);
  const [skillId] = await hub.install(skill.token, [skill.drafts[0]!.key]);
  await assert.rejects(hub.rename(skillId!, 'Cannot rename'), /工具连接/);
  const preview = await hub.preview(fakeConfig('Mail', 'keep-token'));
  const key = preview.drafts[0]!.key;
  await assert.rejects(hub.install(preview.token, [key], {}, { [key]: { replaceId: skillId } }), /类型不同/);
  const [id] = await hub.install(preview.token, [key]);
  await hub.check(id!);
  const item = hub.all().find((entry) => entry.id === id) as McpExtension;
  // This is local fixture state, including the source format used by older installations.
  item.headers = { Authorization: 'Bearer keep-header' };
  item.source = JSON.stringify({ env: { FAKE_KEY: 'old-source-secret' }, headers: item.headers });
  await hub.configure(id!, { REGION: 'test-region' });
  await hub.check(id!);
  assert.deepEqual(item.env, { FAKE_KEY: 'keep-token', REGION: 'test-region' });
  assert.deepEqual(item.headers, { Authorization: 'Bearer keep-header' });
  const view = hub.list().find((entry) => entry.id === id)!;
  assert.doesNotMatch(JSON.stringify(view), /keep-token|keep-header|old-source-secret/);
  assert.equal(
    (
      await hub.call(
        hub.toolNames(false).find((name) => name.startsWith('mcp_'))!,
        {},
        false,
      )
    ).content[0]!.text,
    'echo::keep-token',
  );
});

test('a tool that cannot start reports why instead of hanging', async () => {
  const hub = new ExtensionHub(join(scratch, 'hub-broken'));
  const preview = await hub.preview(`"${process.execPath}" -e "console.error('missing token'); process.exit(3)"`);
  await hub.install(preview.token, [preview.drafts[0]!.key]);
  const id = hub.all()[0]!.id;
  await assert.rejects(hub.check(id), /已退出/);
  assert.match((hub.all()[0] as { error?: string }).error!, /missing token|已退出/);
  await hub.stopAll();
});

test('Claude pre-approves installed tools only in automatic mode', () => {
  const ctx = (approvalMode: 'auto' | 'ask') =>
    ({
      approvalMode,
      route: {},
      input: { prompt: 'x', projectPath: '.', permissionMode: 'workspace-write' },
      agentBridge: { url: 'http://127.0.0.1/mcp', token: 't', extraTools: ['fake__echo'] },
    }) as unknown as ExecuteContext;
  const allowed = (args: string[]) => args[args.indexOf('--allowedTools') + 1]!;
  assert.match(allowed(claudeExecutionArgs(ctx('auto'), 'mcp.json')), /mcp__pugport__fake__echo/);
  assert.doesNotMatch(allowed(claudeExecutionArgs(ctx('ask'), 'mcp.json')), /fake__echo/);
});

function tarEntry(name: string, typeflag: string, body = Buffer.alloc(0), linkname = '', declaredSize = body.length) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(declaredSize.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write(typeflag, 156, 1, 'ascii');
  if (linkname) header.write(linkname, 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  const pad = (512 - (body.length % 512)) % 512;
  return Buffer.concat([header, body, Buffer.alloc(pad)]);
}

test('archive extraction enforces entry, byte, deadline, and escaping-link limits across zip and tar.gz', async () => {
  const skillBody = Buffer.from('---\nname: tar-skill\ndescription: Tar skill\n---\nHello tar.');
  const validTgz = join(scratch, 'valid-skill.tar.gz');
  writeFileSync(
    validTgz,
    gzipSync(
      Buffer.concat([tarEntry('tar-skill/', '5'), tarEntry('tar-skill/SKILL.md', '0', skillBody), Buffer.alloc(1024)]),
    ),
  );
  const hub = new ExtensionHub(join(scratch, 'hub-archive-limits'));
  const preview = await hub.preview(validTgz);
  assert.deepEqual(
    preview.drafts.map((d) => d.name),
    ['tar-skill'],
  );

  // ZIP links are skipped without creating a file or following the target.
  const escapingZip = new AdmZip();
  escapingZip.addFile('skill/SKILL.md', skillBody);
  escapingZip.addFile('skill/escape', Buffer.from('../../outside'));
  escapingZip.getEntry('skill/escape')!.attr = (0o120777 << 16) >>> 0;
  const badZipPath = join(scratch, 'escape-link.zip');
  escapingZip.writeZip(badZipPath);
  const zipOut = join(scratch, 'unzip-escape');
  await extractZip(badZipPath, zipOut);
  assert.deepEqual(readdirSync(join(zipOut, 'skill')), ['SKILL.md']);
  assert.equal(existsSync(join(scratch, 'outside')), false);
  assert.deepEqual(
    (await hub.preview(badZipPath)).drafts.map((draft) => draft.name),
    ['tar-skill'],
  );

  // Escaping symlink in tar.gz is rejected during preview.
  const escapingTgz = join(scratch, 'escape-link.tar.gz');
  writeFileSync(
    escapingTgz,
    gzipSync(
      Buffer.concat([
        tarEntry('skill/SKILL.md', '0', skillBody),
        tarEntry('skill/escape', '2', Buffer.alloc(0), '../../outside'),
        Buffer.alloc(1024),
      ]),
    ),
  );
  await assert.rejects(hub.preview(escapingTgz), /不安全的路径/);

  // Tar entry count, expanded byte budget, and deadline are enforced.
  const tooManyTgz = join(scratch, 'too-many.tar.gz');
  writeFileSync(
    tooManyTgz,
    gzipSync(
      Buffer.concat([
        tarEntry('a.txt', '0', Buffer.from('1')),
        tarEntry('b.txt', '0', Buffer.from('2')),
        tarEntry('c.txt', '0', Buffer.from('3')),
        Buffer.alloc(1024),
      ]),
    ),
  );
  await assert.rejects(
    (extractZip as unknown as (file: string, into: string, limits?: Record<string, number>) => Promise<void>)(
      badZipPath,
      join(scratch, 'unzip-many'),
      { maxEntries: 1 },
    ),
    /20000/,
  );
  const { extractArchive } = (await import('../src/server/extensions.ts')) as unknown as {
    extractArchive: (file: string, into: string, limits?: Record<string, number>) => Promise<void>;
  };
  assert.equal(typeof extractArchive, 'function');
  for (const type of ['1', '2', '5']) {
    const archive = join(scratch, `nonregular-${type}.tar.gz`);
    writeFileSync(
      archive,
      gzipSync(Buffer.concat([tarEntry('entry', type, Buffer.from('x'), 'safe'), Buffer.alloc(1024)])),
    );
    await assert.rejects(extractArchive(archive, join(scratch, `out-${type}`)), /压缩包已损坏/);
  }
  const outMany = join(scratch, 'untar-many');
  await assert.rejects(extractArchive(tooManyTgz, outMany, { maxEntries: 2 }), /20000/);
  assert.equal(existsSync(outMany), false, 'failed extraction removes target directory');

  const outBig = join(scratch, 'untar-big');
  await assert.rejects(extractArchive(validTgz, outBig, { maxBytes: 10 }), /1 GiB/);
  assert.equal(existsSync(outBig), false);

  const outExpired = join(scratch, 'untar-expired');
  await assert.rejects(extractArchive(validTgz, outExpired, { timeoutMs: -1 }), /超时/);
  assert.equal(existsSync(outExpired), false);
});
