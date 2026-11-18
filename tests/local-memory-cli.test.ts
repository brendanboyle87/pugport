import { publishSessionToken } from '../src/server/platform/desktop-endpoint.ts';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { buildSync } from 'esbuild';
import { notifyLocalWorkspace, syncLocalMemory } from '../src/server/local-memory-cli.ts';
import { memoryConversationPaths, memoryProjectDirectory, writeMemorySyncHelper } from '../src/server/local-memory.ts';
import { Store } from '../src/server/store.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import type { Conversation, ConversationMessage, Project, RunRecord, Workflow } from '../src/shared/types.ts';
import { listenForFetch } from './helpers/fetch-port.ts';

const createdAt = '2026-09-30T10:00:00.000Z';

function fixture(t: TestContext) {
  // Match createProject() canonicalization, including temporary-directory path aliases.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'comborunner-cli-memory-')));
  const dataDir = join(root, 'data with spaces %SHOULD_NOT_EXPAND% !literal! & records');
  const appRoot = join(root, 'runtime app with spaces');
  const project: Project = {
    id: randomUUID(),
    name: 'Unique local fixture project',
    path: join(root, 'project with spaces'),
    createdAt,
    updatedAt: createdAt,
  };
  mkdirSync(project.path);
  mkdirSync(appRoot);
  t.mock.property(process, 'env', {
    ...process.env,
    COMBORUNNER_MEMORY_DIR: join(root, 'private memory outside the project'),
  });
  // Initialize before inserting active tasks so normal Store construction cannot interrupt them.
  const store = new Store(dataDir);
  const workspace = new WorkspaceStore(store.db);
  workspace.save('project', project.id, project.id, project);
  const conversations: Conversation[] = [];
  for (let index = 0; index < 3; index++) {
    const conversation: Conversation = {
      id: randomUUID(),
      projectId: project.id,
      title: `Existing conversation ${index}`,
      createdAt,
      updatedAt: `2026-09-30T1${index}:00:00.000Z`,
    };
    workspace.save('conversation', conversation.id, project.id, conversation);
    for (const [offset, role, content] of [
      [0, 'user', `Latest input ${index}`],
      [1, 'assistant', `Latest assistant ${index}`],
    ] as const) {
      const message: ConversationMessage = {
        id: randomUUID(),
        conversationId: conversation.id,
        role,
        content,
        createdAt: new Date(Date.parse(conversation.updatedAt) + offset * 1000).toISOString(),
      };
      workspace.save('message', message.id, conversation.id, message);
    }
    const workflow: Workflow = {
      id: randomUUID(),
      projectId: project.id,
      conversationId: conversation.id,
      userMessageId: `fixture-user-${index}`,
      input: {
        content: `Latest input ${index}`,
        mode: 'build',
        permissionMode: 'workspace-write',
        executionPolicy: 'cli-first',
      },
      status: (['running', 'planning', 'waiting-approval'] as const)[index],
      phase: 'execute',
      plan: [
        {
          id: 'step',
          title: `Active step ${index}`,
          instruction: 'Existing ongoing task',
          kind: 'general',
          transport: 'cli',
          dependsOn: [],
          status: 'running',
          runIds: [],
        },
      ],
      runIds: [],
      memoryRevision: 0,
      memoryExcerpt: '',
      createdAt,
      updatedAt: conversation.updatedAt,
      startedAt: createdAt,
    };
    const run: RunRecord = {
      id: randomUUID(),
      workflowId: workflow.id,
      prompt: workflow.input.content,
      projectPath: project.path,
      kind: 'general',
      status: 'running',
      route: { runtimeId: 'fixture-do-not-execute', model: 'fixture', kind: 'general', reasons: [], warnings: [] },
      startedAt: createdAt,
      output: `Ongoing output ${index}`,
      events: [],
    };
    workflow.runIds.push(run.id);
    workspace.save('workflow', workflow.id, conversation.id, workflow);
    store.saveRun(run);
    conversations.push(conversation);
  }
  workspace.setMemory(project.id, 'Preserve user rules and ongoing work.');
  store.close();
  const grokHome = join(root, 'fixture grok profile that does not exist');
  t.after(() => {
    const cleanup = realpathSync.native(root);
    assert.equal(cleanup, root);
    assert.ok(cleanup.startsWith(realpathSync.native(tmpdir()) + sep));
    assert.ok(basename(cleanup).startsWith('comborunner-cli-memory-'));
    rmSync(cleanup, { recursive: true, force: true });
  });
  return { root, appRoot, dataDir, project, conversations, grokHome };
}

function savedRecords(dataDir: string) {
  const db = new DatabaseSync(join(dataDir, 'studio.sqlite'));
  try {
    return {
      records: db
        .prepare(
          "SELECT kind,id,owner,updated_at,value FROM workspace_records WHERE kind != 'local-memory-status' ORDER BY kind,id",
        )
        .all(),
      runs: db.prepare('SELECT id,started_at,value FROM runs ORDER BY id').all(),
    };
  } finally {
    db.close();
  }
}

function syncFixture(f: ReturnType<typeof fixture>, argument = f.project.id) {
  const previous = process.env.GROK_HOME;
  process.env.GROK_HOME = f.grokHome;
  try {
    return syncLocalMemory(argument, f.appRoot, f.dataDir);
  } finally {
    if (previous === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previous;
  }
}

function exportedHistory(f: ReturnType<typeof fixture>, conversation: Conversation) {
  return memoryConversationPaths(f.dataDir, f.project.id, conversation.id).historyPath;
}

test('standalone sync rejects removed projects by ID and path without changing records', (t) => {
  const f = fixture(t);
  const db = new DatabaseSync(join(f.dataDir, 'studio.sqlite'));
  try {
    const store = new WorkspaceStore(db, { recoverInterrupted: false });
    store.save('project', f.project.id, f.project.id, { ...f.project, removedAt: createdAt });
  } finally {
    db.close();
  }
  const before = savedRecords(f.dataDir);
  for (const argument of [f.project.id, f.project.path])
    assert.throws(() => syncFixture(f, argument), /请先在 PugPort 添加这个项目/);
  assert.deepEqual(savedRecords(f.dataDir), before);
  assert.equal(existsSync(memoryProjectDirectory(f.dataDir, f.project.id)), false);
});

test('standalone sync exports all existing conversations without interrupting active workflows or runs', (t) => {
  const f = fixture(t);
  const before = savedRecords(f.dataDir);
  const result = syncFixture(f);
  assert.equal(result.projectId, f.project.id);
  assert.equal(result.conversations, 3);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.grok, undefined);
  assert.deepEqual(savedRecords(f.dataDir), before);
  const index = readFileSync(join(memoryProjectDirectory(f.dataDir, f.project.id), 'INDEX.md'), 'utf8');
  for (const [number, conversation] of f.conversations.entries()) {
    assert.ok(index.includes(conversation.id));
    const history = readFileSync(exportedHistory(f, conversation), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as ConversationMessage);
    assert.deepEqual(
      history.map((item) => item.content),
      [`Latest input ${number}`, `Latest assistant ${number}`],
    );
    const handoff = readFileSync(join(dirname(exportedHistory(f, conversation)), 'handoff.md'), 'utf8');
    assert.ok(handoff.includes(`Latest input ${number}`));
    assert.ok(handoff.includes(`Latest assistant ${number}`));
    // The shared handoff note omits a redundant singleton plan; retain the goal and live workflow state.
    assert.ok(handoff.includes('交接条'));
    assert.ok(handoff.includes(`目标：Latest input ${number}`));
    assert.ok(handoff.includes(`导出时的状态：${(['running', 'planning', 'waiting-approval'] as const)[number]}`));
  }
  assert.equal(existsSync(f.grokHome), false);
  const files = f.conversations.map((conversation) => exportedHistory(f, conversation));
  const mtimes = files.map((path) => statSync(path).mtimeMs);
  assert.deepEqual(syncFixture(f, f.project.path), result);
  assert.deepEqual(
    files.map((path) => statSync(path).mtimeMs),
    mtimes,
  );
  assert.deepEqual(savedRecords(f.dataDir), before);
  for (const path of ['.comborunner', 'AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', '.claude'])
    assert.equal(existsSync(join(f.project.path, path)), false);
});

test('standalone sync discovers a first Grok session in a configured isolated account without prior imports', (t) => {
  const f = fixture(t);
  const accountHome = join(f.root, 'isolated Grok account');
  const sessionId = randomUUID();
  const source = join(accountHome, 'sessions', encodeURIComponent(f.project.path), sessionId);
  mkdirSync(source, { recursive: true });
  const files = {
    'summary.json': JSON.stringify({ info: { cwd: f.project.path }, created_at: createdAt, updated_at: createdAt }),
    'chat_history.jsonl':
      JSON.stringify({ type: 'user', content: 'First isolated account task' }) +
      '\n' +
      JSON.stringify({ type: 'assistant', content: 'Isolated account saved result' }) +
      '\n',
  };
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(source, name), bytes);
  const db = new DatabaseSync(join(f.dataDir, 'studio.sqlite'));
  try {
    // The importer may change history only when the project has no unfinished tasks.
    db.prepare("UPDATE workspace_records SET value=json_set(value,'$.status','completed') WHERE kind='workflow'").run();
    db.prepare('INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(
      'targets',
      JSON.stringify([{ id: 'fixture-isolated-grok', provider: 'grok', environment: 'native', accountHome }]),
    );
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM workspace_records WHERE kind='grok-import'").get()?.count,
      0,
    );
  } finally {
    db.close();
  }
  const before = savedRecords(f.dataDir);
  assert.equal(existsSync(f.grokHome), false);
  const result = syncFixture(f);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.grok?.sessions, 1);
  assert.equal(result.grok?.addedMessages, 2);
  assert.equal(result.conversations, f.conversations.length + 1);
  const imported = readFileSync(exportedHistory(f, { id: result.grok!.conversationId } as Conversation), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as ConversationMessage);
  assert.deepEqual(
    imported.map((message) => message.content),
    ['First isolated account task', 'Isolated account saved result'],
  );
  const after = savedRecords(f.dataDir);
  assert.deepEqual(after.runs, before.runs);
  const originalIds = new Set(before.records.map((row) => `${row.kind}:${row.id}`));
  assert.deepEqual(
    after.records.filter((row) => originalIds.has(`${row.kind}:${row.id}`)),
    before.records,
  );
  assert.equal(syncFixture(f).grok?.addedMessages, 0);
  for (const [name, bytes] of Object.entries(files)) assert.equal(readFileSync(join(source, name), 'utf8'), bytes);
  assert.equal(existsSync(f.grokHome), false);
});

test('manual sync retains exact dirty instruction bytes and mtimes without bootstrap or default project files', (t) => {
  const f = fixture(t);
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: f.project.path,
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  let available = true;
  try {
    git(['--version']);
  } catch {
    available = false;
  }
  const agentsPath = join(f.project.path, 'AGENTS.md');
  const claudePath = join(f.project.path, 'CLAUDE.md');
  const overridePath = join(f.project.path, 'AGENTS.override.md');
  const gitignorePath = join(f.project.path, '.gitignore');
  writeFileSync(agentsPath, 'Existing shared rules\n');
  writeFileSync(claudePath, 'Existing Claude rules\n');
  writeFileSync(overridePath, 'Existing override rules\n');
  writeFileSync(gitignorePath, 'existing-user-rule\n');
  if (available) {
    git(['init', '--quiet']);
    git(['add', '--', 'AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', '.gitignore']);
  }
  const agents = 'Existing shared rules\nUser dirty edit: do not remove this.\n';
  const claude = 'Existing Claude rules\nUser dirty edit: preserve this too.\n';
  writeFileSync(agentsPath, agents);
  writeFileSync(claudePath, claude);
  writeFileSync(overridePath, 'Existing override rules\nUser dirty override edit.\n');
  // A compiled helper entry being available must not cause default helper or rule installation.
  const entry = join(f.appRoot, 'dist', 'server', 'local-memory-cli.js');
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, '// Synthetic entry; never executed in this test.\n');
  const paths = [agentsPath, overridePath, claudePath, gitignorePath];
  if (available) paths.push(join(f.project.path, '.git', 'info', 'exclude'));
  const original = paths.map((path) => ({ bytes: readFileSync(path), mtime: statSync(path).mtimeMs }));
  const dirty = available ? git(['status', '--porcelain=v1', '--untracked-files=all']) : '';
  const result = syncFixture(f);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(
    paths.map((path) => ({ bytes: readFileSync(path), mtime: statSync(path).mtimeMs })),
    original,
  );
  assert.equal(existsSync(join(f.project.path, '.comborunner')), false);
  assert.equal(existsSync(join(f.project.path, '.claude')), false);
  if (available) assert.equal(git(['status', '--porcelain=v1', '--untracked-files=all']), dirty);
  else t.diagnostic('Git unavailable; existing dirty instruction bytes still verified.');
});

test('missing database or unknown project reports a local error without creating exports', (t) => {
  const f = fixture(t);
  assert.throws(() => syncLocalMemory(f.project.id, f.appRoot, join(f.root, 'missing data')), /本地对话数据库不存在/);
  assert.throws(() => syncFixture(f, randomUUID()), /请先在 PugPort 添加这个项目/);
  assert.equal(existsSync(join(f.project.path, '.comborunner')), false);
});

test(
  'Windows private helper rejects shell-source injection and preserves linked destinations',
  { skip: process.platform !== 'win32' },
  (t) => {
    const f = fixture(t);
    const entry = join(f.appRoot, 'dist', 'server', 'local-memory-cli.js');
    const helper = join(f.project.path, '.comborunner', 'sync-memory.cmd');
    writeMemorySyncHelper(f.project.path, process.execPath, entry, f.dataDir, f.project.id);
    const original = readFileSync(helper, 'utf8');
    const mtime = statSync(helper).mtimeMs;
    writeMemorySyncHelper(f.project.path, process.execPath, entry, f.dataDir, f.project.id);
    assert.equal(readFileSync(helper, 'utf8'), original);
    assert.equal(statSync(helper).mtimeMs, mtime);
    assert.match(original, /setlocal DisableDelayedExpansion/);
    assert.match(original, /%%SHOULD_NOT_EXPAND%%/);
    assert.match(original, /COMBORUNNER_DATA_DIR=/);
    for (const value of [
      'unsafe" & echo injected',
      'unsafe\n@echo injected',
      'unsafe\r\n@echo injected',
      'unsafe\0command',
    ]) {
      assert.throws(() => writeMemorySyncHelper(f.project.path, value, entry, f.dataDir, f.project.id));
      assert.throws(() => writeMemorySyncHelper(f.project.path, process.execPath, value, f.dataDir, f.project.id));
      assert.throws(() => writeMemorySyncHelper(f.project.path, process.execPath, entry, value, f.project.id));
      assert.equal(readFileSync(helper, 'utf8'), original);
    }
    assert.throws(() =>
      writeMemorySyncHelper(f.project.path, process.execPath, entry, f.dataDir, 'project" & echo injected'),
    );
    const sentinel = join(f.root, 'outside helper.cmd');
    writeFileSync(sentinel, '@echo Outside helper must remain unchanged\r\n');
    unlinkSync(helper);
    linkSync(sentinel, helper);
    assert.throws(
      () => writeMemorySyncHelper(f.project.path, process.execPath, entry, f.dataDir, f.project.id),
      /不安全文件/,
    );
    assert.equal(readFileSync(sentinel, 'utf8'), '@echo Outside helper must remain unchanged\r\n');
    unlinkSync(helper);
    let fileLink = false;
    try {
      symlinkSync(sentinel, helper, 'file');
      fileLink = true;
    } catch (error) {
      if (!['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      t.diagnostic('Windows file symlink permission unavailable; helper hardlink and junction refusal verified.');
    }
    if (fileLink) {
      assert.throws(
        () => writeMemorySyncHelper(f.project.path, process.execPath, entry, f.dataDir, f.project.id),
        /不安全文件/,
      );
      assert.equal(readFileSync(sentinel, 'utf8'), '@echo Outside helper must remain unchanged\r\n');
      unlinkSync(helper);
    }
    const memoryRoot = join(f.project.path, '.comborunner');
    rmdirSync(memoryRoot);
    const outside = join(f.root, 'outside helper directory');
    mkdirSync(outside);
    symlinkSync(outside, memoryRoot, 'junction');
    assert.throws(
      () => writeMemorySyncHelper(f.project.path, process.execPath, entry, f.dataDir, f.project.id),
      /包含链接/,
    );
    assert.equal(existsSync(join(outside, 'sync-memory.cmd')), false);
  },
);

test(
  'generated Windows helper executes bundled local CLI with spaces and literal shell characters in the data path',
  { skip: process.platform !== 'win32' },
  (t) => {
    const f = fixture(t);
    const entry = join(f.appRoot, 'dist', 'server', 'local-memory-cli.js');
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(join(f.appRoot, 'package.json'), '{"type":"module"}\n');
    buildSync({
      entryPoints: [resolve(import.meta.dirname, '../src/server/local-memory-cli.ts')],
      outfile: entry,
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      target: 'node24',
      logLevel: 'silent',
    });
    writeMemorySyncHelper(f.project.path, process.execPath, entry, f.dataDir, f.project.id);
    const before = savedRecords(f.dataDir);
    const helper = join(f.project.path, '.comborunner', 'sync-memory.cmd');
    const command = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', helper], {
      cwd: f.project.path,
      env: {
        ...process.env,
        GROK_HOME: f.grokHome,
        COMBORUNNER_DATA_DIR: join(f.root, 'wrong inherited data directory'),
        SHOULD_NOT_EXPAND: 'WRONG_EXPANSION',
        NODE_NO_WARNINGS: '1',
      },
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      timeout: 30000,
    });
    assert.equal(command.error, undefined);
    assert.equal(command.status, 0, command.stderr || command.stdout);
    const result = JSON.parse(command.stdout.trim()) as {
      projectId: string;
      conversations: number;
      warnings: string[];
    };
    assert.equal(result.projectId, f.project.id);
    assert.equal(result.conversations, f.conversations.length);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(savedRecords(f.dataDir), before);
    for (const conversation of f.conversations) assert.ok(existsSync(exportedHistory(f, conversation)));
    assert.equal(existsSync(f.grokHome), false);
    for (const path of ['AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', '.claude'])
      assert.equal(existsSync(join(f.project.path, path)), false);
    assert.equal(existsSync(join(f.project.path, '.comborunner', 'conversations')), false);
  },
);

// Production notification gives each localhost request 1 s, but the first fetch alone can need longer on a busy
// machine. The fixture server replies immediately; this guard only ends a genuine hang.
const NOTIFY_GUARD_MS = 60_000;

async function notificationFixture(t: TestContext) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'comborunner-cli-notify-')));
  const data = join(root, 'fixture data');
  mkdirSync(data);
  const requests: { method: string; path: string; body: string; token?: string }[] = [];
  let observedData = data;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      method: request.method ?? '',
      path: request.url ?? '',
      body: Buffer.concat(chunks).toString('utf8'),
      token: request.headers['x-agent-token'] as string | undefined,
    });
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify(request.url === '/api/state' ? { app: { dataDir: observedData } } : { refreshed: true }),
    );
  });
  await listenForFetch(server);
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const originalUrl = process.env.COMBORUNNER_IMPORT_URL;
  process.env.COMBORUNNER_IMPORT_URL = `http://127.0.0.1:${address.port}/fixture`;
  t.after(async () => {
    if (originalUrl === undefined) delete process.env.COMBORUNNER_IMPORT_URL;
    else process.env.COMBORUNNER_IMPORT_URL = originalUrl;
    await new Promise<void>((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
    const cleanup = realpathSync.native(root);
    assert.equal(cleanup, root);
    assert.ok(cleanup.startsWith(realpathSync.native(tmpdir()) + sep));
    assert.ok(basename(cleanup).startsWith('comborunner-cli-notify-'));
    rmSync(cleanup, { recursive: true, force: true });
  });
  return {
    data,
    port: address.port,
    requests,
    observeData(value: string) {
      observedData = value;
    },
  };
}

test('notifies only a matching localhost desktop using state, local session and an empty refresh POST', async (t) => {
  const f = await notificationFixture(t);
  writeFileSync(join(f.data, 'server.lock'), 'fixture-local-lock');
  if (process.platform === 'win32') f.observeData(f.data.toUpperCase());
  await notifyLocalWorkspace(f.data, NOTIFY_GUARD_MS);
  assert.deepEqual(f.requests, [{ method: 'GET', path: '/api/state', body: '', token: undefined }]);
});

test('notification prefers the session file for both requests', async (t) => {
  const f = await notificationFixture(t);
  writeFileSync(join(f.data, 'server.lock'), 'fixture-local-lock');
  const remove = publishSessionToken('synthetic-file', f.port);
  t.after(remove);
  await notifyLocalWorkspace(f.data, NOTIFY_GUARD_MS);
  assert.deepEqual(f.requests, [
    { method: 'GET', path: '/api/state', body: '', token: 'synthetic-file' },
    { method: 'POST', path: '/api/workspace/refresh', body: '{}', token: 'synthetic-file' },
  ]);
});

test('different local data or an absent server lock stops before authentication and refresh', async (t) => {
  const f = await notificationFixture(t);
  writeFileSync(join(f.data, 'server.lock'), 'fixture-local-lock');
  f.observeData(join(f.data, 'different desktop database'));
  await notifyLocalWorkspace(f.data, NOTIFY_GUARD_MS);
  assert.deepEqual(f.requests, [{ method: 'GET', path: '/api/state', body: '', token: undefined }]);
  unlinkSync(join(f.data, 'server.lock'));
  f.requests.length = 0;
  await notifyLocalWorkspace(f.data, NOTIFY_GUARD_MS);
  assert.deepEqual(f.requests, []);
});

test('remote or unsupported import URLs are rejected without making any network request', async (t) => {
  const f = await notificationFixture(t);
  writeFileSync(join(f.data, 'server.lock'), 'fixture-local-lock');
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.COMBORUNNER_IMPORT_URL;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('Unexpected fixture network request');
  };
  try {
    for (const value of ['http://example.invalid', 'http://198.51.100.1:4317', 'https://127.0.0.1:4317']) {
      process.env.COMBORUNNER_IMPORT_URL = value;
      await notifyLocalWorkspace(f.data);
    }
    assert.equal(calls, 0);
    assert.deepEqual(f.requests, []);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.COMBORUNNER_IMPORT_URL;
    else process.env.COMBORUNNER_IMPORT_URL = originalUrl;
  }
});
