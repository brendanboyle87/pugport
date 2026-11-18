import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { installLocalMemoryBootstrap } from '../src/server/local-memory-bootstrap.ts';
import { memoryConversationPaths } from '../src/server/local-memory.ts';
import type {
  Conversation,
  ExecuteContext,
  MessageInput,
  Project,
  RuntimeSnapshot,
  Workflow,
} from '../src/shared/types.ts';

const input: MessageInput = {
  content: 'Synthetic explanation request',
  mode: 'chat',
  permissionMode: 'read-only',
  executionPolicy: 'cli-only',
  runtimeId: 'mock',
};
const snapshot = (): RuntimeSnapshot => ({
  id: 'mock',
  provider: 'codex',
  label: 'Synthetic runtime',
  environment: 'native',
  installed: true,
  status: 'ready',
  models: [{ id: 'fixture-model', label: 'Fixture model', efforts: ['low', 'medium', 'high'] }],
  quota: {
    status: 'known',
    source: 'fixture',
    observedAt: new Date().toISOString(),
    windows: [
      { id: 'weekly', label: 'Fixture quota', usedPercent: 5, resetsAt: new Date(Date.now() + 3600000).toISOString() },
    ],
  },
  capabilities: { execute: true, resume: true, cancel: true, approvals: true },
  refreshedAt: new Date().toISOString(),
});

function fixture(t: TestContext, beforeStartup?: (project: string) => void) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'comborunner-memory-workspace-')));
  const app = join(root, 'app'),
    projectPath = join(root, 'project'),
    privateMemory = join(root, 'private-memory');
  for (const path of [app, projectPath, privateMemory]) mkdirSync(path);
  const previous = process.env.COMBORUNNER_MEMORY_DIR;
  process.env.COMBORUNNER_MEMORY_DIR = privateMemory;
  const ruleContents = {
    'AGENTS.md': Buffer.from('\ufeff# Team rules\r\nKeep this exact rule content.\r\n'),
    'AGENTS.override.md': Buffer.from('Override priority rules.\n'),
    'CLAUDE.md': Buffer.from('# Claude user rules\nNo final newline'),
  };
  for (const [name, content] of Object.entries(ruleContents)) writeFileSync(join(projectPath, name), content);
  beforeStartup?.(projectPath);
  const before = Object.keys(ruleContents).map((name) => {
    const path = join(projectPath, name),
      stat = statSync(path);
    return { path, bytes: readFileSync(path), mtime: stat.mtimeMs, mode: stat.mode };
  });
  t.mock.method(codexAdapter, 'discover', async () => snapshot());
  let executions = 0;
  t.mock.method(codexAdapter, 'execute', async (_context: ExecuteContext) => {
    executions++;
    return { output: 'Synthetic fixture reply; no external inference.', nativeSessionId: 'synthetic-session' };
  });
  const controller = new Controller(app, join(app, 'data'));
  clearInterval(controller.timer);
  controller.targets = [
    {
      id: 'mock',
      provider: 'codex',
      label: 'Synthetic runtime',
      command: 'unused',
      environment: 'native',
      enabled: true,
    },
  ];
  controller.snapshots = [snapshot()];
  const seedStore = new WorkspaceStore(controller.store.db);
  const timestamp = '2026-09-01T12:00:00.000Z';
  const project: Project = {
    id: randomUUID(),
    name: 'Team fixture',
    path: projectPath,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const oldConversation: Conversation = {
    id: randomUUID(),
    projectId: project.id,
    title: 'Private prior conversation',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  seedStore.save('project', project.id, project.id, project);
  seedStore.save('conversation', oldConversation.id, project.id, oldConversation);
  const messageId = randomUUID();
  seedStore.save('message', messageId, oldConversation.id, {
    id: messageId,
    conversationId: oldConversation.id,
    role: 'user',
    content: 'PRIVATE_PRIOR_CONVERSATION',
    createdAt: timestamp,
  });
  const workspace = new Workspace(controller, { memoryDebounceMs: 20 });
  t.after(async () => {
    await workspace.close();
    await controller.close();
    if (previous === undefined) delete process.env.COMBORUNNER_MEMORY_DIR;
    else process.env.COMBORUNNER_MEMORY_DIR = previous;
    const cleanup = resolve(root);
    assert.equal(cleanup, realpathSync.native(root));
    assert.ok(cleanup.startsWith(realpathSync.native(tmpdir()) + sep));
    assert.ok(basename(cleanup).startsWith('comborunner-memory-workspace-'));
    rmSync(cleanup, { recursive: true, force: true });
  });
  return {
    root,
    projectPath,
    privateMemory,
    controller,
    workspace,
    project,
    oldConversation,
    before,
    executions: () => executions,
  };
}

function assertOriginalRules(f: ReturnType<typeof fixture>) {
  for (const original of f.before) {
    assert.deepEqual(readFileSync(original.path), original.bytes);
    assert.equal(statSync(original.path).mtimeMs, original.mtime);
    assert.equal(statSync(original.path).mode, original.mode);
  }
}

async function complete(workspace: Workspace, workflowId: string) {
  for (let attempts = 0; attempts < 250; attempts++) {
    const workflow = workspace.store.get<Workflow>('workflow', workflowId)!;
    if (['completed', 'failed', 'blocked', 'cancelled'].includes(workflow.status)) {
      assert.equal(workflow.status, 'completed', workflow.error ?? 'Synthetic workflow did not complete.');
      return workflow;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Synthetic workflow did not finish.');
}

test(
  'startup, default task lifecycle and refresh never edit existing team instruction files or execute project helpers',
  { timeout: 20000 },
  async (t) => {
    const f = fixture(t, (projectPath) => {
      mkdirSync(join(projectPath, '.comborunner'));
      writeFileSync(join(projectPath, '.comborunner', 'sync-memory.cmd'), '@echo EXECUTED>"EXECUTED-SENTINEL"\r\n');
    });
    assert.deepEqual(await f.workspace.flushLocalMemory(), []);
    const settings = f.workspace.localMemorySettings(f.project.id);
    assert.equal(settings.cliEnabled, false);
    assert.equal(settings.exportEnabled, true);
    assert.deepEqual(settings.files, []);
    assertOriginalRules(f);
    const conversation = f.workspace.createConversation(f.project.id, 'Fresh fixture conversation');
    const submitted = await f.workspace.send(conversation.id, input);
    await complete(f.workspace, submitted.workflow.id);
    f.workspace.renameConversation(conversation.id, 'Renamed fixture');
    f.workspace.updateMemory(f.project.id, 'Private fixture project preference', 0);
    assert.equal(f.workspace.state().projects?.find((project) => project.id === f.project.id)?.localMemory, undefined);
    assert.deepEqual(await f.workspace.refreshLocalHistory(), { warnings: [] });
    assertOriginalRules(f);
    assert.equal(f.executions(), 1);
    assert.equal(existsSync(join(f.projectPath, 'EXECUTED-SENTINEL')), false);
    assert.equal(existsSync(join(f.projectPath, '.comborunner', 'INDEX.md')), false);
    assert.equal(existsSync(join(f.projectPath, '.claude')), false);
    const history = memoryConversationPaths(f.controller.dataDir, f.project.id, conversation.id).historyPath;
    assert.match(readFileSync(history, 'utf8'), /Synthetic explanation request/);
    assert.match(readFileSync(history, 'utf8'), /Synthetic fixture reply/);
  },
);

test(
  'new projects remain unenrolled and acquire no root instruction files from default conversation creation',
  { timeout: 20000 },
  async (t) => {
    const f = fixture(t);
    const emptyPath = join(f.root, 'new-project');
    mkdirSync(emptyPath);
    const project = await f.workspace.createProject(emptyPath);
    const conversation = f.workspace.createConversation(project.id);
    assert.deepEqual(await f.workspace.flushLocalMemory(project.id), []);
    assert.equal(f.workspace.localMemorySettings(project.id).cliEnabled, false);
    for (const name of ['AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', '.claude', '.comborunner'])
      assert.equal(existsSync(join(emptyPath, name)), false);
    assert.ok(existsSync(memoryConversationPaths(f.controller.dataDir, project.id, conversation.id).historyPath));
    assertOriginalRules(f);
  },
);

test(
  'explicit enrollment returns concrete changed paths, leaves CLAUDE untouched and explicit disabling removes known rules',
  { timeout: 20000 },
  async (t) => {
    const f = fixture(t);
    const enabled = await f.workspace.configureLocalMemory(f.project.id, { cliEnabled: true });
    assert.deepEqual(enabled.warnings, []);
    assert.equal(enabled.cliEnabled, true);
    assert.deepEqual(enabled.files, [
      join(f.projectPath, 'AGENTS.md'),
      join(f.projectPath, 'AGENTS.override.md'),
      join(f.projectPath, '.claude', 'rules', 'comborunner-local-memory.md'),
    ]);
    for (const path of enabled.files) {
      const text = readFileSync(path, 'utf8');
      assert.match(text, /LOCAL MEMORY v2 BEGIN/);
      assert.doesNotMatch(text, /run that local helper once|sync-memory\.cmd/);
    }
    const claude = f.before.find((file) => file.path.endsWith('CLAUDE.md'))!;
    assert.deepEqual(readFileSync(claude.path), claude.bytes);
    assert.equal(statSync(claude.path).mtimeMs, claude.mtime);
    const projectIndex = readFileSync(join(f.projectPath, '.comborunner', 'INDEX.md'), 'utf8');
    assert.doesNotMatch(projectIndex, /PRIVATE_PRIOR_CONVERSATION|Private prior conversation/);
    assert.equal(
      existsSync(join(f.projectPath, '.comborunner', 'conversations', f.oldConversation.id, 'history.jsonl')),
      false,
    );
    const disabled = await f.workspace.configureLocalMemory(f.project.id, { cliEnabled: false });
    assert.deepEqual(disabled.warnings, []);
    assert.equal(disabled.cliEnabled, false);
    assert.equal(disabled.files.length, 3);
    assert.equal(existsSync(join(f.projectPath, '.claude', 'rules', 'comborunner-local-memory.md')), false);
    for (const file of f.before) {
      const bytes = readFileSync(file.path);
      assert.deepEqual(bytes.subarray(0, file.bytes.length), file.bytes);
      assert.doesNotMatch(bytes.toString('utf8'), /COMBORUNNER LOCAL MEMORY/);
    }
    assert.deepEqual(readFileSync(claude.path), claude.bytes);
    assert.equal(statSync(claude.path).mtimeMs, claude.mtime);
  },
);

test(
  'failed enrollment reports disabled CLI and preserves edited legacy CLAUDE plus all user rules during later tasks',
  { timeout: 20000 },
  async (t) => {
    const f = fixture(t, (projectPath) => {
      writeFileSync(
        join(projectPath, 'CLAUDE.md'),
        '# User Claude rules\n' +
          '<!-- COMBORUNNER LOCAL MEMORY v1 BEGIN -->\n' +
          'User-edited legacy block must be reviewed manually.\n' +
          '<!-- COMBORUNNER LOCAL MEMORY v1 END -->\n' +
          'User trailing rules stay unchanged.\n',
      );
      mkdirSync(join(projectPath, '.comborunner'));
      writeFileSync(join(projectPath, '.comborunner', 'sync-memory.cmd'), '@echo EXECUTED>"EXECUTED-SENTINEL"\r\n');
    });
    assert.deepEqual(await f.workspace.flushLocalMemory(), []);
    assertOriginalRules(f);
    const settings = await f.workspace.configureLocalMemory(f.project.id, { cliEnabled: true });
    assert.equal(settings.cliEnabled, false);
    assert.equal(settings.exportEnabled, true);
    assert.deepEqual(settings.files, []);
    assert.match(settings.warnings.join(' '), /已被修改|内容未知/);
    assert.equal(f.workspace.store.get<Project>('project', f.project.id)?.localMemory?.cliEnabled, false);
    assert.equal(
      f.workspace.state().projects?.find((project) => project.id === f.project.id)?.localMemory?.cliEnabled,
      false,
    );
    assertOriginalRules(f);
    assert.equal(existsSync(join(f.projectPath, '.claude', 'rules', 'comborunner-local-memory.md')), false);
    assert.ok(
      existsSync(memoryConversationPaths(f.controller.dataDir, f.project.id, f.oldConversation.id).historyPath),
    );
    const conversation = f.workspace.createConversation(f.project.id, 'After rejected enrollment');
    const submitted = await f.workspace.send(conversation.id, input);
    await complete(f.workspace, submitted.workflow.id);
    assert.deepEqual(await f.workspace.refreshLocalHistory(), { warnings: [] });
    assert.equal(f.workspace.localMemorySettings(f.project.id).cliEnabled, false);
    assert.match(f.workspace.localMemorySettings(f.project.id).warnings.join(' '), /已被修改|内容未知/);
    assertOriginalRules(f);
    assert.equal(existsSync(join(f.projectPath, 'EXECUTED-SENTINEL')), false);
    assert.equal(f.executions(), 1);
  },
);

test(
  'startup preserves previously generated rules until an explicit cleanup action, even when default CLI is off',
  { timeout: 20000 },
  async (t) => {
    const f = fixture(t, (projectPath) => {
      assert.deepEqual(installLocalMemoryBootstrap(projectPath).warnings, []);
    });
    assert.deepEqual(await f.workspace.flushLocalMemory(), []);
    assert.equal(f.workspace.localMemorySettings(f.project.id).cliEnabled, false);
    assertOriginalRules(f);
    assert.equal(existsSync(join(f.projectPath, '.claude', 'rules', 'comborunner-local-memory.md')), true);
    const result = await f.workspace.configureLocalMemory(f.project.id, { cliEnabled: false });
    assert.deepEqual(result.warnings, []);
    assert.equal(result.files.length, 3);
    assert.doesNotMatch(readFileSync(join(f.projectPath, 'AGENTS.md'), 'utf8'), /COMBORUNNER LOCAL MEMORY/);
    assert.equal(existsSync(join(f.projectPath, '.claude', 'rules', 'comborunner-local-memory.md')), false);
  },
);

test(
  'disabling file export preserves SQLite conversations and prior copies while stopping subsequent history writes',
  { timeout: 20000 },
  async (t) => {
    const f = fixture(t);
    assert.deepEqual(await f.workspace.flushLocalMemory(), []);
    const oldHistory = memoryConversationPaths(f.controller.dataDir, f.project.id, f.oldConversation.id).historyPath;
    const bytes = readFileSync(oldHistory),
      mtime = statSync(oldHistory).mtimeMs;
    const disabled = await f.workspace.configureLocalMemory(f.project.id, { exportEnabled: false });
    assert.equal(disabled.exportEnabled, false);
    assert.equal(disabled.cliEnabled, false);
    assert.deepEqual(disabled.warnings, []);
    const submitted = await f.workspace.send(f.oldConversation.id, input);
    await complete(f.workspace, submitted.workflow.id);
    const fresh = f.workspace.createConversation(f.project.id, 'Not exported');
    f.workspace.updateMemory(f.project.id, 'SQLite preference still updates', 0);
    assert.deepEqual(await f.workspace.flushLocalMemory(), []);
    assert.equal(f.workspace.store.messages(f.oldConversation.id).length, 3);
    assert.ok(f.workspace.store.get<Conversation>('conversation', fresh.id));
    assert.equal(f.workspace.memory(f.project.id).content, 'SQLite preference still updates');
    assert.deepEqual(readFileSync(oldHistory), bytes);
    assert.equal(statSync(oldHistory).mtimeMs, mtime);
    assert.equal(existsSync(memoryConversationPaths(f.controller.dataDir, f.project.id, fresh.id).historyPath), false);
    assertOriginalRules(f);
    const enabled = await f.workspace.configureLocalMemory(f.project.id, { exportEnabled: true });
    assert.deepEqual(enabled.warnings, []);
    assert.equal(enabled.cliEnabled, false);
    assert.match(readFileSync(oldHistory, 'utf8'), /Synthetic fixture reply/);
    assert.ok(existsSync(memoryConversationPaths(f.controller.dataDir, f.project.id, fresh.id).historyPath));
    assertOriginalRules(f);
  },
);
