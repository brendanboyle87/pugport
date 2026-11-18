import assert from 'node:assert/strict';
import { execFileSync } from '../src/server/platform/test-process.ts';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
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
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join, resolve, sep } from 'node:path';
import test, { after, type TestContext } from 'node:test';
import {
  exportConversationMemory,
  exportProjectMemory,
  memoryStorageRoot,
  memoryProjectDirectory,
  memoryConversationPaths,
  migrateLegacyProjectMemory,
  inspectLegacyProjectMemory,
} from '../src/server/local-memory.ts';
import { Store } from '../src/server/store.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { appDataEnv } from './helpers/fake-host.ts';
import type { Conversation, ConversationMessage, Project, Workflow, RunRecord } from '../src/shared/types.ts';
import { fixture as sessionFixture, input, finished, result } from './helpers/session-workspace.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';

test('Batch C coordinator context includes the board only with its own lanes and enabled export', async (t) => {
  const f = sessionFixture(t, false);
  t.mock.method(codexAdapter, 'execute', async () => result('completed', 'Synthetic reply.'));
  const project = await f.workspace.createProject(f.directory);
  const parent = f.workspace.createConversation(project.id);
  for (const hasLane of [false, true]) {
    if (hasLane) {
      const lane = f.workspace.createConversation(project.id);
      lane.lane = { parentConversationId: parent.id, sourceWorkflowId: 'synthetic' };
      f.workspace.store.save('conversation', lane.id, project.id, lane);
    }
    const sent = await f.workspace.send(parent.id, {
      ...input,
      mode: 'chat',
      permissionMode: 'read-only',
      runtimeId: 'mock',
    });
    await finished(f.workspace, sent.workflow.id);
    assert.equal(sent.workflow.memoryExcerpt.includes('本项目工作线看板：'), hasLane);
    if (hasLane)
      assert.ok(
        sent.workflow.memoryExcerpt.includes(
          memoryConversationPaths(f.controller.dataDir, project.id, parent.id).lanesPath,
        ),
      );
  }
  project.localMemory = { exportEnabled: false, cliEnabled: false };
  f.workspace.store.save('project', project.id, project.id, project);
  const sent = await f.workspace.send(parent.id, {
    ...input,
    mode: 'chat',
    permissionMode: 'read-only',
    runtimeId: 'mock',
  });
  await finished(f.workspace, sent.workflow.id);
  assert.doesNotMatch(sent.workflow.memoryExcerpt, /本项目工作线看板/);
});

test('Batch C LANES board orders lanes and deliveries, keeps trusted now and queue count, and preserves mtime', (t) => {
  const f = fixture(t);
  const older = addConversation(f.workspace, f.project.id, 'Older lane', '2026-10-01T10:00:00Z');
  const newer = addConversation(f.workspace, f.project.id, 'Newer [lane]', '2026-10-02T10:00:00Z');
  for (const lane of [older, newer]) {
    lane.lane = {
      parentConversationId: f.conversation.id,
      sourceWorkflowId: 'source',
      branch: 'synthetic/lane',
      baseCommit: 'a'.repeat(40),
    };
    f.workspace.save('conversation', lane.id, lane.projectId, lane);
  }
  for (let i = 0; i < 22; i++) {
    const at = new Date(Date.parse(createdAt) + i * 1000).toISOString();
    const workflow = {
      id: `delivery-${i}`,
      conversationId: newer.id,
      projectId: f.project.id,
      status: i % 2 ? 'failed' : 'completed',
      phase: 'execute',
      input: { content: 'Synthetic' },
      runIds: [`run-${i}`],
      createdAt: at,
      updatedAt: at,
    } as Workflow;
    f.workspace.save('workflow', workflow.id, newer.id, workflow);
    f.workspace.save('lane-result', workflow.id, newer.id, { at, lastResultPath: `synthetic/result-${i}.md` });
    f.store.saveRun({
      id: `run-${i}`,
      workflowId: workflow.id,
      stepId: 'step',
      startedAt: at,
      status: 'completed',
      taskOutcome: {
        status: 'completed',
        source: 'executor-report',
        summary: i === 21 ? 'THIRD_PARTY_SUMMARY' : `Trusted result ${i}`,
      },
      events: [],
      output: '',
    } as unknown as RunRecord);
    if (i === 21) {
      const final = message(f.workspace, newer, 'assistant', 'THIRD_PARTY_REPLY', at);
      final.untrustedContent = true;
      f.workspace.save('message', final.id, newer.id, final);
      workflow.finalMessageId = final.id;
      f.workspace.save('workflow', workflow.id, newer.id, workflow);
    }
  }
  for (const [i, status] of ['queued', 'waiting-resource'].entries()) {
    const workflow = {
      id: `queued-${i}`,
      conversationId: newer.id,
      projectId: f.project.id,
      status,
      input: {},
      runIds: [],
      createdAt,
      updatedAt: createdAt,
    } as unknown as Workflow;
    f.workspace.save('workflow', workflow.id, newer.id, workflow);
  }
  for (const extra of [
    { memory: 'off' as const },
    { incognito: true },
    { deletedAt: createdAt },
    { untrustedContent: true },
  ]) {
    const hidden = addConversation(f.workspace, f.project.id, 'PRIVATE_LANE');
    Object.assign(hidden, extra, { lane: older.lane });
    f.workspace.save('conversation', hidden.id, hidden.projectId, hidden);
  }
  const paths = memoryConversationPaths(f.dataDir, f.project.id, f.conversation.id);
  // This projection test uses a synthetic filesystem; path-safety integration tests below use real files.
  const files = new Map<string, { text?: string; mtimeMs: number }>();
  for (const leaf of [f.project.path, dirname(paths.indexPath)]) {
    for (let path = leaf; ; path = dirname(path)) {
      files.set(path, { mtimeMs: 0 });
      if (dirname(path) === path) break;
    }
  }
  let clock = 0,
    fd = 100;
  const handles = new Map<number, string>();
  const stat = (path: string) => {
    const file = files.get(String(path));
    if (!file) throw Object.assign(new Error(`Synthetic ENOENT: ${path}`), { code: 'ENOENT' });
    return {
      ...file,
      nlink: 1,
      isFile: () => file.text !== undefined,
      isDirectory: () => file.text === undefined,
      isSymbolicLink: () => false,
    };
  };
  const mocks = [
    t.mock.method(fs, 'lstatSync', stat),
    t.mock.method(fs, 'statSync', stat),
    t.mock.method(fs.realpathSync, 'native', (path: string) => {
      stat(path);
      return path;
    }),
    t.mock.method(fs, 'mkdirSync', (path: string) => {
      files.set(path, { mtimeMs: ++clock });
    }),
    t.mock.method(fs, 'openSync', (path: string) => {
      handles.set(++fd, path);
      return fd;
    }),
    t.mock.method(fs, 'writeFileSync', (handle: number, text: string) => {
      files.set(handles.get(handle)!, { text, mtimeMs: ++clock });
    }),
    t.mock.method(fs, 'readFileSync', (path: string) => {
      stat(path);
      return files.get(path)!.text!;
    }),
    t.mock.method(fs, 'renameSync', (from: string, to: string) => {
      files.set(to, files.get(from)!);
      files.delete(from);
    }),
    t.mock.method(fs, 'unlinkSync', (path: string) => {
      files.delete(path);
    }),
    t.mock.method(fs, 'fsyncSync', () => {}),
    t.mock.method(fs, 'closeSync', () => {}),
  ];
  syncBuiltinESMExports();
  try {
    assert.equal(paths.lanesPath, join(dirname(paths.indexPath), 'LANES.md'));
    exportConversationMemory(f.workspace, f.project, f.conversation.id, f.dataDir);
    const board = readFileSync(paths.lanesPath, 'utf8');
    assert.ok(board.indexOf('Newer \\[lane\\]') < board.indexOf('Older lane'));
    assert.match(board, /branch: synthetic\/lane/);
    assert.match(board, /baseCommit: a{40}/);
    assert.match(board, /state: queued/);
    assert.match(board, /now\n\n```text\nTrusted result 20/);
    assert.match(board, /next: 2/);
    assert.doesNotMatch(board, /THIRD_PARTY|PRIVATE_LANE/);
    assert.match(board, /20/);
    assert.equal((board.match(/^- .*synthetic\/result-/gm) ?? []).length, 20);
    assert.ok(board.indexOf('result-21.md') < board.indexOf('result-20.md'));
    assert.match(board, /failed.*synthetic\/result-21.md/);
    assert.doesNotMatch(board, /result-[01]\.md/);
    const mtime = statSync(paths.lanesPath).mtimeMs;
    exportConversationMemory(f.workspace, f.project, f.conversation.id, f.dataDir);
    assert.equal(readFileSync(paths.lanesPath, 'utf8'), board);
    assert.equal(statSync(paths.lanesPath).mtimeMs, mtime);
    for (const lane of [older, newer]) {
      lane.memory = 'off';
      f.workspace.save('conversation', lane.id, lane.projectId, lane);
    }
    f.conversation.memory = 'off';
    f.workspace.save('conversation', f.conversation.id, f.project.id, f.conversation);
    exportProjectMemory(f.workspace, f.project, f.dataDir);
    assert.doesNotMatch(readFileSync(paths.lanesPath, 'utf8'), /Older|Newer|Trusted result/);
  } finally {
    for (const mock of mocks) mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('Batch C disabled memory export creates no LANES file', (t) => {
  const f = fixture(t);
  f.project.localMemory = { exportEnabled: false, cliEnabled: false };
  f.workspace.save('project', f.project.id, f.project.id, f.project);
  exportConversationMemory(f.workspace, f.project, f.conversation.id, f.dataDir);
  exportProjectMemory(f.workspace, f.project, f.dataDir);
  assert.equal(existsSync(join(memoryProjectDirectory(f.dataDir, f.project.id), 'LANES.md')), false);
});

const createdAt = '2026-09-29T10:00:00.000Z';
const previousMemoryDirectory = process.env.COMBORUNNER_MEMORY_DIR;
const testMemoryDirectory =
  previousMemoryDirectory || realpathSync.native(mkdtempSync(join(tmpdir(), 'comborunner-private-memory-')));
process.env.COMBORUNNER_MEMORY_DIR = testMemoryDirectory;
after(() => {
  if (previousMemoryDirectory) process.env.COMBORUNNER_MEMORY_DIR = previousMemoryDirectory;
  else {
    delete process.env.COMBORUNNER_MEMORY_DIR;
    assert.ok(basename(testMemoryDirectory).startsWith('comborunner-private-memory-'));
    rmSync(testMemoryDirectory, { recursive: true, force: true });
  }
});

function enableCli(f: ReturnType<typeof fixture>) {
  f.project.localMemory = { exportEnabled: true, cliEnabled: true };
  f.workspace.save('project', f.project.id, f.project.id, f.project);
}
function fixture(t: TestContext) {
  // Match createProject() canonicalization, including temporary-directory path aliases.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'comborunner-local-memory-')));
  const dataDir = join(root, 'data');
  const store = new Store(dataDir);
  const workspace = new WorkspaceStore(store.db);
  const project: Project = {
    id: randomUUID(),
    name: 'Fixture project',
    path: join(root, 'project'),
    createdAt,
    updatedAt: createdAt,
  };
  mkdirSync(project.path);
  workspace.save('project', project.id, project.id, project);
  const conversation = addConversation(workspace, project.id, 'First conversation');
  t.after(() => {
    store.close();
    const cleanup = realpathSync.native(root);
    assert.equal(cleanup, root);
    assert.ok(cleanup.startsWith(realpathSync.native(tmpdir()) + sep));
    assert.ok(basename(cleanup).startsWith('comborunner-local-memory-'));
    rmSync(cleanup, { recursive: true, force: true });
  });
  return { root, dataDir, store, workspace, project, conversation };
}

function addConversation(store: WorkspaceStore, projectId: string, title: string, updatedAt = createdAt) {
  const conversation: Conversation = { id: randomUUID(), projectId, title, createdAt, updatedAt };
  store.save('conversation', conversation.id, projectId, conversation);
  return conversation;
}

function message(
  store: WorkspaceStore,
  conversation: Conversation,
  role: ConversationMessage['role'],
  content: string,
  at = createdAt,
) {
  const value: ConversationMessage = {
    id: randomUUID(),
    conversationId: conversation.id,
    role,
    content,
    createdAt: at,
  };
  store.save('message', value.id, conversation.id, value);
  return value;
}

function history(path: string): ConversationMessage[] {
  const text = readFileSync(path, 'utf8').trim();
  return text ? text.split('\n').map((line) => JSON.parse(line) as ConversationMessage) : [];
}

test('side-chat archives remain separate and cannot replace main CLI handoff or appear in its pointer index', (t) => {
  const f = fixture(t);
  enableCli(f);
  message(f.workspace, f.conversation, 'assistant', 'MAIN_RECORD');
  const side = addConversation(f.workspace, f.project.id, 'Independent side chat', '2026-10-01T15:00:00.000Z');
  side.sideChat = { parentConversationId: f.conversation.id, context: '', selection: { executionPolicy: 'cli-only' } };
  f.workspace.save('conversation', side.id, side.projectId, side);
  const privateRecord = message(f.workspace, side, 'assistant', 'PRIVATE_SIDE_RECORD');
  const mainExport = exportConversationMemory(f.workspace, f.project, f.conversation.id, f.dataDir);
  const sideExport = exportConversationMemory(f.workspace, f.project, side.id, f.dataDir);
  assert.deepEqual(
    history(sideExport.historyPath).map((value) => value.id),
    [privateRecord.id],
  );
  assert.ok(!readFileSync(mainExport.historyPath, 'utf8').includes('PRIVATE_SIDE_RECORD'));
  const privateIndex = readFileSync(sideExport.indexPath, 'utf8');
  const [mainSection, sideSection] = privateIndex.split('## 侧聊记录');
  assert.ok(mainSection.includes(f.conversation.id));
  assert.ok(!mainSection.includes(side.id));
  assert.ok(sideSection.includes(side.id));
  const latest = readFileSync(sideExport.latestPath, 'utf8');
  assert.ok(latest.includes(f.conversation.id));
  assert.ok(!latest.includes(side.id));
  const pointers = join(f.project.path, '.comborunner');
  assert.ok(readFileSync(join(pointers, 'INDEX.md'), 'utf8').includes(f.conversation.id));
  assert.ok(!readFileSync(join(pointers, 'INDEX.md'), 'utf8').includes(side.id));
  assert.ok(!readFileSync(join(pointers, 'LATEST.md'), 'utf8').includes(side.id));
  assert.equal(existsSync(join(pointers, 'conversations', side.id, 'handoff.md')), false);
});

test('a project with only side-chat records never promotes one into the default main history', (t) => {
  const f = fixture(t);
  enableCli(f);
  f.conversation.deletedAt = '2026-10-01T12:00:00.000Z';
  f.workspace.save('conversation', f.conversation.id, f.project.id, f.conversation);
  const side = addConversation(f.workspace, f.project.id, 'Retained side archive');
  side.sideChat = { parentConversationId: f.conversation.id, context: '', selection: { executionPolicy: 'cli-only' } };
  f.workspace.save('conversation', side.id, side.projectId, side);
  message(f.workspace, side, 'assistant', 'Retained record');
  const exported = exportConversationMemory(f.workspace, f.project, side.id, f.dataDir);
  assert.match(readFileSync(exported.latestPath, 'utf8'), /暂无可见主对话/);
  assert.ok(!readFileSync(exported.latestPath, 'utf8').includes(side.id));
  assert.match(readFileSync(exported.indexPath, 'utf8'), /侧聊记录/);
  assert.equal(history(exported.historyPath).length, 1);
  assert.ok(!readFileSync(join(f.project.path, '.comborunner', 'INDEX.md'), 'utf8').includes(side.id));
});

test('exports full chronological records, user memory and source pointers without changing rules or native source bytes', (t) => {
  const f = fixture(t);
  const rules = {
    'AGENTS.md': 'Keep user-authored Agent rules.\n',
    'CLAUDE.md': 'Keep Claude-specific instructions.\n',
    'GROK.md': 'Keep Grok-specific instructions.\n',
    '.gitignore': 'user-ignore-rule\n',
  };
  for (const [name, text] of Object.entries(rules)) writeFileSync(join(f.project.path, name), text);
  f.workspace.setMemory(f.project.id, 'Use TypeScript. Keep the existing theme.');
  const early = message(f.workspace, f.conversation, 'user', 'First request', '2026-09-29T09:00:00.000Z');
  for (let index = 329; index >= 0; index--)
    message(
      f.workspace,
      f.conversation,
      index % 2 ? 'assistant' : 'user',
      `Record ${index}`,
      new Date(Date.parse(createdAt) + index * 1000).toISOString(),
    );
  const nativeArchive = join(f.dataDir, 'imports', 'grok', 'snapshot', 'session');
  mkdirSync(join(nativeArchive, 'compaction'), { recursive: true });
  const nativePath = join(nativeArchive, 'compaction', 'segment.md');
  const nativeText = 'Original compaction snapshot. secret-native-sentinel.\n';
  writeFileSync(nativePath, nativeText);
  const archivedHistory = join(f.dataDir, 'history', 'original.jsonl');
  mkdirSync(dirname(archivedHistory), { recursive: true });
  writeFileSync(archivedHistory, 'original history remains unchanged\n');
  f.workspace.save('history-archive', f.project.id, f.project.id, {
    path: archivedHistory,
    sourceArchives: [nativeArchive],
    conversationId: f.conversation.id,
    messages: 331,
    createdAt,
  });
  const original = f.workspace.allMessages(f.conversation.id);
  const exported = exportConversationMemory(f.workspace, f.project, f.conversation.id, f.dataDir);
  assert.equal(exported.directory, memoryConversationPaths(f.dataDir, f.project.id, f.conversation.id).directory);
  assert.equal(exported.historyPath, join(exported.directory, 'history.jsonl'));
  assert.deepEqual(history(exported.historyPath), original);
  assert.equal(history(exported.historyPath).length, 331);
  assert.equal(history(exported.historyPath)[0].id, early.id);
  assert.equal(history(exported.historyPath).at(-1)?.content, 'Record 329');
  const handoff = readFileSync(join(exported.directory, 'handoff.md'), 'utf8');
  assert.match(handoff, /Record 328/);
  assert.match(handoff, /Record 329/);
  assert.match(handoff, /Use TypeScript\. Keep the existing theme\./);
  assert.ok(handoff.includes(nativeArchive));
  assert.ok(handoff.includes(archivedHistory));
  assert.match(handoff, /compaction_checkpoints/);
  assert.match(handoff, /尚未独立核验/);
  assert.match(handoff, /不授予新权限/);
  assert.doesNotMatch(handoff, /secret-native-sentinel/);
  assert.equal(readFileSync(nativePath, 'utf8'), nativeText);
  assert.equal(readFileSync(archivedHistory, 'utf8'), 'original history remains unchanged\n');
  for (const [name, text] of Object.entries(rules))
    assert.equal(readFileSync(join(f.project.path, name), 'utf8'), text);
  assert.equal(existsSync(join(f.project.path, '.comborunner')), false);
  assert.deepEqual(f.workspace.allMessages(f.conversation.id), original);
  assert.deepEqual(exported.warnings, []);
});

test('indexes every active project conversation and retains separate histories without crossing project or conversation boundaries', (t) => {
  const f = fixture(t);
  const latest = addConversation(f.workspace, f.project.id, 'Latest conversation', '2026-09-29T12:00:00.000Z');
  const middle = addConversation(f.workspace, f.project.id, 'Middle conversation', '2026-09-29T11:00:00.000Z');
  const deleted = addConversation(f.workspace, f.project.id, 'Deleted conversation');
  deleted.deletedAt = createdAt;
  f.workspace.save('conversation', deleted.id, f.project.id, deleted);
  const foreign = addConversation(f.workspace, randomUUID(), 'Foreign project secret');
  message(f.workspace, f.conversation, 'user', 'First conversation only');
  message(f.workspace, latest, 'user', 'Latest conversation only');
  message(f.workspace, middle, 'user', 'Middle conversation only');
  message(f.workspace, foreign, 'user', 'Foreign project message');
  f.workspace.save('history-archive', f.project.id, f.project.id, {
    path: join(f.dataDir, 'foreign-archive.jsonl'),
    conversationId: latest.id,
    sourceArchives: [join(f.dataDir, 'native-archive')],
    messages: 1,
    createdAt,
  });
  const lastOutput = exportConversationMemory(f.workspace, f.project, latest.id, f.dataDir);
  const latestHistory = readFileSync(lastOutput.historyPath, 'utf8');
  const middleOutput = exportConversationMemory(f.workspace, f.project, middle.id, f.dataDir);
  const firstOutput = exportConversationMemory(f.workspace, f.project, f.conversation.id, f.dataDir);
  assert.deepEqual(
    history(firstOutput.historyPath).map((item) => item.content),
    ['First conversation only'],
  );
  assert.deepEqual(
    history(middleOutput.historyPath).map((item) => item.content),
    ['Middle conversation only'],
  );
  assert.equal(readFileSync(lastOutput.historyPath, 'utf8'), latestHistory);
  const index = readFileSync(firstOutput.indexPath, 'utf8');
  for (const item of [latest, middle, f.conversation]) assert.ok(index.includes(`conversations/${item.id}/handoff.md`));
  assert.ok(index.indexOf('Latest conversation') < index.indexOf('Middle conversation'));
  assert.doesNotMatch(index, /Foreign project|Deleted conversation/);
  const pointer = readFileSync(firstOutput.latestPath, 'utf8');
  assert.ok(pointer.includes(`conversations/${latest.id}/handoff.md`));
  assert.doesNotMatch(pointer, /First conversation only|Middle conversation only|Foreign project message/);
  const firstHandoff = readFileSync(join(firstOutput.directory, 'handoff.md'), 'utf8');
  assert.doesNotMatch(firstHandoff, /Latest conversation only|Foreign project message|foreign-archive|native-archive/);
});

test('handoff bounds messages and workflow details while the JSONL retains complete text', (t) => {
  const f = fixture(t);
  const user = 'Latest request\n' + 'u'.repeat(10000);
  const assistant = 'Historical result\n' + 'a'.repeat(10000);
  message(f.workspace, f.conversation, 'user', user);
  message(f.workspace, f.conversation, 'assistant', assistant);
  const workflow: Workflow = {
    id: randomUUID(),
    projectId: f.project.id,
    conversationId: f.conversation.id,
    userMessageId: 'fixture-user',
    input: { content: user, mode: 'build', permissionMode: 'workspace-write', executionPolicy: 'cli-first' },
    status: 'blocked',
    phase: 'verify',
    plan: Array.from({ length: 30 }, (_, index) => ({
      id: String(index),
      title: `Step ${index}`,
      instruction: 'i'.repeat(3000),
      kind: 'general',
      transport: 'cli',
      dependsOn: [],
      status: index ? 'pending' : 'completed',
      acceptance: 'c'.repeat(3000),
      runIds: [],
    })),
    runIds: [],
    error: 'Recorded error ' + 'e'.repeat(5000),
    memoryRevision: 0,
    memoryExcerpt: '',
    createdAt,
    updatedAt: '2026-09-29T11:00:00.000Z',
  };
  f.workspace.save('workflow', workflow.id, f.conversation.id, workflow);
  const output = exportConversationMemory(f.workspace, f.project, f.conversation.id, f.dataDir);
  const handoff = readFileSync(join(output.directory, 'handoff.md'), 'utf8');
  assert.match(handoff, /状态：blocked · 阶段：verify/);
  // The workflow part is the handoff note: step states, never the long instructions or acceptance texts.
  assert.match(handoff, /步骤「Step 0」已完成/);
  assert.match(handoff, /步骤「Step 1」（未开始）/);
  assert.doesNotMatch(handoff, /i{200}|c{200}|e{400}/);
  assert.match(handoff, /交接原因：记录的错误：Recorded error e+…/);
  assert.match(handoff, /摘要已截断/);
  assert.ok(handoff.length < 30000);
  assert.deepEqual(
    history(output.historyPath).map((item) => item.content),
    [user, assistant],
  );
});

test('the workflow part of handoff.md is the handoff note from recorded tool events, without raw IDs or git calls', (t) => {
  const f = fixture(t);
  message(f.workspace, f.conversation, 'user', 'Synthetic export request');
  const workflow: Workflow = {
    id: randomUUID(),
    projectId: f.project.id,
    conversationId: f.conversation.id,
    userMessageId: 'fixture-user',
    input: {
      content: 'Synthetic export request',
      mode: 'build',
      permissionMode: 'workspace-write',
      executionPolicy: 'cli-first',
      verificationCommand: 'npm test',
    },
    status: 'interrupted',
    phase: 'execute',
    plan: [],
    runIds: ['synthetic-export-run'],
    handoffBase: { at: createdAt, head: 'd'.repeat(40) },
    memoryRevision: 0,
    memoryExcerpt: '',
    createdAt,
    updatedAt: createdAt,
  };
  f.workspace.save('workflow', workflow.id, f.conversation.id, workflow);
  f.store.saveRun({
    id: 'synthetic-export-run',
    prompt: 'Synthetic prompt',
    projectPath: f.project.path,
    kind: 'general',
    status: 'interrupted',
    route: { runtimeId: 'claude', model: 'synthetic', kind: 'general', reasons: [], warnings: [] },
    startedAt: createdAt,
    output: 'EXPORT_OUTPUT_TEXT',
    workflowId: workflow.id,
    stepId: 'step1',
    events: [
      {
        at: createdAt,
        type: 'tool',
        data: {
          toolCallId: 'toolu_EXPORT_ID',
          kind: 'nativeToolCall',
          tool: 'Edit',
          status: 'inProgress',
          input: { file_path: join(f.project.path, 'src', 'export.ts') },
        },
      },
      { at: createdAt, type: 'tool', data: { toolCallId: 'toolu_EXPORT_ID', tool: 'Edit', status: 'completed' } },
    ],
  });
  const output = exportConversationMemory(f.workspace, f.project, f.conversation.id, f.dataDir);
  const handoff = readFileSync(join(output.directory, 'handoff.md'), 'utf8');
  assert.match(handoff, /交接条：PugPort 按执行记录机械整理/);
  assert.match(handoff, /目标：Synthetic export request/);
  assert.match(handoff, /- Edit src\/export\.ts → 完成/);
  assert.match(handoff, /任务开始时的提交是 dddddddddd/);
  assert.match(handoff, /验收命令：`npm test`/);
  assert.doesNotMatch(handoff, /toolu_EXPORT_ID|EXPORT_OUTPUT_TEXT/);
  assert.equal(existsSync(join(f.project.path, '.git')), false);
});

test('repeated exports are byte-identical and retain mtimes without inserting new database records', (t) => {
  const f = fixture(t);
  message(f.workspace, f.conversation, 'user', 'Keep this history');
  const output = exportConversationMemory(f.workspace, f.project, f.conversation.id, f.dataDir);
  const paths = [output.historyPath, join(output.directory, 'handoff.md'), output.latestPath, output.indexPath];
  const before = paths.map((path) => ({ text: readFileSync(path, 'utf8'), mtime: statSync(path).mtimeMs }));
  const count = f.workspace.db.prepare('SELECT COUNT(*) AS count FROM workspace_records').get();
  const again = exportConversationMemory(f.workspace, f.project, f.conversation.id, f.dataDir);
  assert.deepEqual(again, output);
  assert.deepEqual(
    paths.map((path) => ({ text: readFileSync(path, 'utf8'), mtime: statSync(path).mtimeMs })),
    before,
  );
  assert.deepEqual(f.workspace.db.prepare('SELECT COUNT(*) AS count FROM workspace_records').get(), count);
});

test('missing projects, stale paths, mismatched ownership and unsafe IDs fail without creating output', (t) => {
  const f = fixture(t);
  const foreign = addConversation(f.workspace, randomUUID(), 'Foreign conversation');
  assert.throws(() => exportConversationMemory(f.workspace, f.project, foreign.id, f.dataDir), /不属于这个项目/);
  assert.throws(
    () => exportConversationMemory(f.workspace, { ...f.project, id: randomUUID() }, f.conversation.id, f.dataDir),
    /项目不存在/,
  );
  assert.throws(
    () =>
      exportConversationMemory(
        f.workspace,
        { ...f.project, path: join(f.root, 'other') },
        f.conversation.id,
        f.dataDir,
      ),
    /路径已变化/,
  );
  const unsafe = { ...f.conversation, id: '../escape' };
  f.workspace.save('conversation', unsafe.id, f.project.id, unsafe);
  assert.throws(() => exportConversationMemory(f.workspace, f.project, unsafe.id, f.dataDir), /不安全/);
  assert.equal(existsSync(join(f.project.path, '.comborunner')), false);
  rmdirSync(f.project.path);
  assert.throws(
    () => exportConversationMemory(f.workspace, f.project, f.conversation.id, f.dataDir),
    /项目文件夹不存在/,
  );
  assert.equal(existsSync(f.project.path), false);
});

test('refuses linked directories and files before writing outside the private memory root', (t) => {
  const f = fixture(t);
  const outside = join(f.root, 'outside');
  mkdirSync(outside);
  const sentinel = join(outside, 'sentinel.txt');
  writeFileSync(sentinel, 'Outside remains untouched');
  const link = memoryProjectDirectory(f.dataDir, f.project.id);
  symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => exportConversationMemory(f.workspace, f.project, f.conversation.id, f.dataDir), /包含链接/);
  assert.equal(existsSync(join(outside, 'conversations')), false);
  assert.equal(readFileSync(sentinel, 'utf8'), 'Outside remains untouched');
  rmSync(link);
  mkdirSync(join(link, 'conversations'), { recursive: true });
  const conversationLink = join(link, 'conversations', f.conversation.id);
  symlinkSync(outside, conversationLink, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => exportConversationMemory(f.workspace, f.project, f.conversation.id, f.dataDir), /包含链接/);
  assert.equal(existsSync(join(outside, 'history.jsonl')), false);
  rmSync(conversationLink);
  const indexPath = join(link, 'INDEX.md');
  linkSync(sentinel, indexPath);
  assert.throws(() => exportConversationMemory(f.workspace, f.project, f.conversation.id, f.dataDir), /不安全文件/);
  assert.equal(readFileSync(sentinel, 'utf8'), 'Outside remains untouched');
  unlinkSync(indexPath);
  try {
    symlinkSync(sentinel, indexPath, 'file');
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    t.diagnostic('Windows file symlink permission unavailable; directory junction refusals verified.');
    return;
  }
  assert.throws(() => exportConversationMemory(f.workspace, f.project, f.conversation.id, f.dataDir), /不安全文件/);
  assert.equal(readFileSync(sentinel, 'utf8'), 'Outside remains untouched');
});

test('a repository initialized later in an ancestor also excludes existing private memory', (t) => {
  const f = fixture(t);
  enableCli(f);
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: f.root,
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  try {
    git(['--version']);
  } catch {
    t.skip('Git unavailable in this test environment.');
    return;
  }
  message(f.workspace, f.conversation, 'user', 'Private fixture history');
  const exported = exportConversationMemory(f.workspace, f.project, f.conversation.id, f.dataDir);
  assert.deepEqual(exported.warnings, []);
  assert.equal(existsSync(join(f.root, '.git')), false);
  mkdirSync(join(f.root, '.git'));
  assert.deepEqual(exportConversationMemory(f.workspace, f.project, f.conversation.id, f.dataDir).warnings, []);
  rmdirSync(join(f.root, '.git'));
  git(['init', '--quiet']);
  assert.deepEqual(exportConversationMemory(f.workspace, f.project, f.conversation.id, f.dataDir).warnings, []);
  assert.equal(git(['check-ignore', '--', 'project/.comborunner/INDEX.md']), 'project/.comborunner/INDEX.md');
  assert.equal(existsSync(join(f.project.path, '.gitignore')), false);
});

test('dirty Git repositories gain only a private info/exclude rule, with no tracked instruction or ignore edits', (t) => {
  const f = fixture(t);
  enableCli(f);
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: f.project.path,
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  try {
    git(['--version']);
  } catch {
    t.skip('Git unavailable in this test environment.');
    return;
  }
  git(['init', '--quiet']);
  writeFileSync(join(f.project.path, '.gitignore'), 'existing-user-rule\n');
  writeFileSync(join(f.project.path, 'AGENTS.md'), 'User-authored rules\n');
  git(['add', '--', '.gitignore', 'AGENTS.md']);
  writeFileSync(join(f.project.path, 'AGENTS.md'), 'User-authored rules with an unsaved Git edit\n');
  const excludePath = join(f.project.path, '.git', 'info', 'exclude');
  writeFileSync(excludePath, '# Existing local exclude\nlocal-user-file');
  const dirty = git(['status', '--porcelain=v1', '--untracked-files=all']);
  assert.match(dirty, /AM AGENTS\.md/);
  message(f.workspace, f.conversation, 'user', 'Private fixture history');
  const exported = exportConversationMemory(f.workspace, f.project, f.conversation.id, f.dataDir);
  assert.deepEqual(exported.warnings, []);
  assert.equal(git(['status', '--porcelain=v1', '--untracked-files=all']), dirty);
  assert.equal(git(['check-ignore', '--', '.comborunner/INDEX.md']), '.comborunner/INDEX.md');
  assert.equal(readFileSync(join(f.project.path, '.gitignore'), 'utf8'), 'existing-user-rule\n');
  assert.equal(
    readFileSync(join(f.project.path, 'AGENTS.md'), 'utf8'),
    'User-authored rules with an unsaved Git edit\n',
  );
  const exclude = readFileSync(excludePath, 'utf8');
  assert.equal(
    exclude,
    '# Existing local exclude\nlocal-user-file\n.comborunner/\n.claude/rules/comborunner-local-memory.md\n',
  );
  exportConversationMemory(f.workspace, f.project, f.conversation.id, f.dataDir);
  assert.equal(readFileSync(excludePath, 'utf8'), exclude);
});

test('CLI-memory opt-in exports only read-only pointers, never messages, titles or project memory', (t) => {
  const f = fixture(t);
  enableCli(f);
  f.conversation.title = 'PRIVATE_TITLE_SENTINEL';
  f.workspace.save('conversation', f.conversation.id, f.project.id, f.conversation);
  message(f.workspace, f.conversation, 'user', 'PRIVATE_MESSAGE_SENTINEL');
  f.workspace.setMemory(f.project.id, 'PRIVATE_PROJECT_MEMORY_SENTINEL');
  const exported = exportConversationMemory(f.workspace, f.project, f.conversation.id, f.dataDir);
  const projectDirectory = join(f.project.path, '.comborunner');
  const paths = [
    join(projectDirectory, 'INDEX.md'),
    join(projectDirectory, 'LATEST.md'),
    join(projectDirectory, 'conversations', f.conversation.id, 'handoff.md'),
  ];
  for (const path of paths) {
    const text = readFileSync(path, 'utf8');
    assert.match(text, /local-memory-pointer v1/);
    assert.doesNotMatch(text, /PRIVATE_(?:TITLE|MESSAGE|PROJECT_MEMORY)_SENTINEL/);
    assert.doesNotMatch(text, /sync-memory\.cmd/);
  }
  assert.ok(readFileSync(paths[2], 'utf8').includes(exported.historyPath));
  assert.equal(existsSync(join(projectDirectory, 'conversations', f.conversation.id, 'history.jsonl')), false);
  assert.match(readFileSync(exported.historyPath, 'utf8'), /PRIVATE_MESSAGE_SENTINEL/);
});

test('default export does not inspect Git or change repository-local exclude files', (t) => {
  const f = fixture(t);
  execFileSync('git', ['init', '--quiet'], { cwd: f.project.path, windowsHide: true });
  const exclude = join(f.project.path, '.git', 'info', 'exclude');
  const before = readFileSync(exclude);
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = '';
    assert.deepEqual(exportConversationMemory(f.workspace, f.project, f.conversation.id, f.dataDir).warnings, []);
    assert.deepEqual(readFileSync(exclude), before);
    assert.equal(existsSync(join(f.project.path, '.comborunner')), false);
  } finally {
    process.env.PATH = previousPath;
  }
});

test('disabling export retains SQLite records and does not create or update file copies', (t) => {
  const f = fixture(t);
  message(f.workspace, f.conversation, 'user', 'Before disabling');
  const exported = exportConversationMemory(f.workspace, f.project, f.conversation.id, f.dataDir);
  const before = readFileSync(exported.historyPath, 'utf8');
  f.project.localMemory = { exportEnabled: false, cliEnabled: false };
  f.workspace.save('project', f.project.id, f.project.id, f.project);
  message(f.workspace, f.conversation, 'user', 'After disabling remains only in database');
  exportConversationMemory(f.workspace, f.project, f.conversation.id, f.dataDir);
  assert.equal(readFileSync(exported.historyPath, 'utf8'), before);
  assert.equal(f.workspace.allMessages(f.conversation.id).length, 2);
  assert.equal(existsSync(join(f.project.path, '.comborunner')), false);
  const newConversation = addConversation(f.workspace, f.project.id, 'Never exported');
  const skipped = exportConversationMemory(f.workspace, f.project, newConversation.id, f.dataDir);
  assert.equal(existsSync(skipped.directory), false);
});

test('default private root uses local app data and isolates data-directory identities', (t) => {
  const previous = process.env.COMBORUNNER_MEMORY_DIR;
  const local = mkdtempSync(join(tmpdir(), 'comborunner-root-path-'));
  const { env, memoryBase } = appDataEnv(local);
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  try {
    delete process.env.COMBORUNNER_MEMORY_DIR;
    Object.assign(process.env, env);
    const first = memoryStorageRoot(join(local, 'first-data'));
    assert.ok(first.startsWith(join(memoryBase, 'memory') + sep));
    assert.notEqual(first, memoryStorageRoot(join(local, 'second-data')));
    assert.equal(memoryStorageRoot(join(local, 'first-data')), first);
    assert.throws(() => memoryProjectDirectory(local, '../unsafe'), /不安全/);
  } finally {
    process.env.COMBORUNNER_MEMORY_DIR = previous;
    for (const [key, value] of Object.entries(saved)) {
      if (value) process.env[key] = value;
      else delete process.env[key];
    }
    assert.ok(basename(local).startsWith('comborunner-root-path-'));
    rmSync(local, { recursive: true, force: true });
  }
});

test('default root getter never creates a missing application base, while an explicit export creates it', (t) => {
  const f = fixture(t);
  const appdata = join(f.root, 'fresh local appdata');
  mkdirSync(appdata);
  const { env, memoryBase } = appDataEnv(appdata);
  t.mock.property(process, 'env', { ...process.env, COMBORUNNER_MEMORY_DIR: '', ...env });
  const root = memoryStorageRoot(f.dataDir);
  assert.ok(root.startsWith(join(memoryBase, 'memory') + sep));
  memoryConversationPaths(f.dataDir, f.project.id, f.conversation.id);
  assert.equal(existsSync(memoryBase), false);
  const exported = exportConversationMemory(f.workspace, f.project, f.conversation.id, f.dataDir);
  assert.ok(existsSync(exported.historyPath));
  assert.ok(existsSync(memoryBase));
});

test('default-location fixtures remain recognizable when TEMP uses a short-name alias', (t) => {
  const f = fixture(t);
  const canonicalTemp = realpathSync.native(tmpdir());
  const temporaryAlias = join(f.root, 'TEMP~1');
  const appdata = join(f.root, 'temporary local appdata');
  mkdirSync(appdata);
  const { env, memoryBase } = appDataEnv(appdata);
  t.mock.property(process, 'env', { ...process.env, COMBORUNNER_MEMORY_DIR: '', ...env });
  const native = fs.realpathSync.native;
  const pathMock = t.mock.method(fs.realpathSync, 'native', (path: fs.PathLike) =>
    path === temporaryAlias ? canonicalTemp : native(path),
  );
  const tempMock = t.mock.method(os, 'tmpdir', () => temporaryAlias);
  syncBuiltinESMExports();
  try {
    assert.ok(memoryStorageRoot(f.dataDir).startsWith(join(memoryBase, 'memory') + sep));
    assert.equal(existsSync(memoryBase), false);
  } finally {
    tempMock.mock.restore();
    pathMock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('trusted default appdata base accepts a non-link MSIX virtual alias and writes only to its canonical location', (t) => {
  const f = fixture(t);
  const appdata = join(f.root, 'virtualized local appdata');
  const { env, memoryAnchor, memoryBase: alias } = appDataEnv(appdata);
  const canonical = join(memoryAnchor, 'Packages', 'Fixture.Codex', 'LocalCache', 'Local', basename(alias));
  mkdirSync(alias, { recursive: true });
  mkdirSync(canonical, { recursive: true });
  t.mock.property(process, 'env', { ...process.env, COMBORUNNER_MEMORY_DIR: '', ...env });
  const native = fs.realpathSync.native;
  t.mock.method(fs.realpathSync, 'native', (path: fs.PathLike) =>
    typeof path === 'string' && resolve(path) === resolve(alias) ? canonical : native(path),
  );
  assert.equal(fs.lstatSync(alias).isSymbolicLink(), false);
  assert.ok(memoryStorageRoot(f.dataDir).startsWith(join(canonical, 'memory') + sep));
  message(f.workspace, f.conversation, 'user', 'Private virtualized fixture history');
  const exported = exportConversationMemory(f.workspace, f.project, f.conversation.id, f.dataDir);
  assert.ok(exported.directory.startsWith(canonical + sep));
  assert.match(readFileSync(exported.historyPath, 'utf8'), /Private virtualized fixture history/);
  assert.equal(existsSync(join(alias, 'memory')), false);
});

test('default appdata base rejects real junctions even when they target another directory under local appdata', (t) => {
  const f = fixture(t);
  const appdata = join(f.root, 'local appdata with junction');
  const { env, memoryAnchor, memoryBase } = appDataEnv(appdata);
  const target = join(memoryAnchor, 'other application directory');
  mkdirSync(target, { recursive: true });
  symlinkSync(target, memoryBase, process.platform === 'win32' ? 'junction' : 'dir');
  t.mock.property(process, 'env', { ...process.env, COMBORUNNER_MEMORY_DIR: '', ...env });
  assert.throws(() => memoryStorageRoot(f.dataDir), /不安全文件/);
  assert.equal(existsSync(join(target, 'memory')), false);
});

test('custom memory roots still reject non-link path aliases and real junctions', (t) => {
  const f = fixture(t);
  const target = join(f.root, 'external private directory');
  const alias = join(f.root, 'custom memory alias');
  mkdirSync(target);
  mkdirSync(alias);
  t.mock.property(process, 'env', { ...process.env, COMBORUNNER_MEMORY_DIR: alias });
  const native = fs.realpathSync.native;
  const mock = t.mock.method(fs.realpathSync, 'native', (path: fs.PathLike) =>
    typeof path === 'string' && resolve(path) === resolve(alias) ? target : native(path),
  );
  assert.throws(() => exportConversationMemory(f.workspace, f.project, f.conversation.id, f.dataDir), /包含链接/);
  assert.equal(existsSync(join(target, f.project.id)), false);
  mock.mock.restore();
  rmdirSync(alias);
  symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => exportConversationMemory(f.workspace, f.project, f.conversation.id, f.dataDir), /包含链接/);
  assert.equal(existsSync(join(target, f.project.id)), false);
});

test('configured full-history root is rejected inside any registered project', (t) => {
  const f = fixture(t);
  const previous = process.env.COMBORUNNER_MEMORY_DIR;
  try {
    process.env.COMBORUNNER_MEMORY_DIR = join(f.project.path, 'private-history');
    assert.throws(
      () => exportConversationMemory(f.workspace, f.project, f.conversation.id, f.dataDir),
      /不能位于任何项目/,
    );
    assert.equal(existsSync(join(f.project.path, 'private-history')), false);
  } finally {
    process.env.COMBORUNNER_MEMORY_DIR = previous;
  }
});

test('opt-in Git checks are cached but the cached exclude file is revalidated before writing', (t) => {
  const f = fixture(t);
  enableCli(f);
  execFileSync('git', ['init', '--quiet'], { cwd: f.project.path, windowsHide: true });
  exportConversationMemory(f.workspace, f.project, f.conversation.id, f.dataDir);
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = '';
    assert.deepEqual(exportConversationMemory(f.workspace, f.project, f.conversation.id, f.dataDir).warnings, []);
    const exclude = join(f.project.path, '.git', 'info', 'exclude');
    const sentinel = join(f.root, 'outside-sentinel.txt');
    writeFileSync(sentinel, 'Do not replace');
    unlinkSync(exclude);
    linkSync(sentinel, exclude);
    const warnings = exportConversationMemory(f.workspace, f.project, f.conversation.id, f.dataDir).warnings;
    assert.match(warnings.join('\n'), /未能更新 Git 本地排除规则/);
    assert.equal(readFileSync(sentinel, 'utf8'), 'Do not replace');
  } finally {
    process.env.PATH = oldPath;
  }
});

test('explicit legacy migration verifies exact backups, removes generated copies and preserves unknown user files', (t) => {
  const f = fixture(t);
  message(f.workspace, f.conversation, 'user', 'Private legacy message');
  const exported = exportConversationMemory(f.workspace, f.project, f.conversation.id, f.dataDir);
  const legacyConversation = join(f.project.path, '.comborunner', 'conversations', f.conversation.id);
  mkdirSync(legacyConversation, { recursive: true });
  const originalHistory = readFileSync(exported.historyPath);
  const originalHandoff = readFileSync(join(exported.directory, 'handoff.md'));
  writeFileSync(join(legacyConversation, 'history.jsonl'), originalHistory);
  writeFileSync(join(legacyConversation, 'handoff.md'), originalHandoff);
  writeFileSync(join(legacyConversation, 'user-note.txt'), 'Keep my own note');
  const originalRecords = f.workspace.db.prepare('SELECT * FROM workspace_records ORDER BY kind,id').all();
  const result = migrateLegacyProjectMemory(f.workspace, f.project, f.dataDir);
  assert.equal(result.removed.length, 2);
  assert.equal(result.backups.length, 2);
  assert.deepEqual(readFileSync(result.backups.find((path) => path.endsWith('history.jsonl'))!), originalHistory);
  assert.deepEqual(readFileSync(result.backups.find((path) => path.endsWith('handoff.md'))!), originalHandoff);
  assert.equal(existsSync(join(legacyConversation, 'history.jsonl')), false);
  assert.equal(readFileSync(join(legacyConversation, 'user-note.txt'), 'utf8'), 'Keep my own note');
  assert.deepEqual(f.workspace.db.prepare('SELECT * FROM workspace_records ORDER BY kind,id').all(), originalRecords);
  assert.deepEqual(migrateLegacyProjectMemory(f.workspace, f.project, f.dataDir).removed, []);
});

test('legacy migration refuses linked source files and leaves unrecognized histories untouched', (t) => {
  const f = fixture(t);
  const folder = join(f.project.path, '.comborunner', 'conversations', f.conversation.id);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, 'history.jsonl');
  writeFileSync(path, 'not generated memory\n');
  assert.deepEqual(migrateLegacyProjectMemory(f.workspace, f.project, f.dataDir).removed, []);
  assert.equal(readFileSync(path, 'utf8'), 'not generated memory\n');
  unlinkSync(path);
  const outside = join(f.root, 'outside.jsonl');
  writeFileSync(outside, '[]\n');
  linkSync(outside, path);
  assert.throws(() => migrateLegacyProjectMemory(f.workspace, f.project, f.dataDir), /不安全文件/);
  assert.equal(readFileSync(outside, 'utf8'), '[]\n');
});

test('migration retains edited handoff, index and latest files even when every generated signature remains', (t) => {
  const f = fixture(t);
  message(f.workspace, f.conversation, 'user', 'Known message');
  const exported = exportConversationMemory(f.workspace, f.project, f.conversation.id, f.dataDir);
  const legacy = join(f.project.path, '.comborunner');
  const folder = join(legacy, 'conversations', f.conversation.id);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'history.jsonl'), readFileSync(exported.historyPath));
  const targets = [
    [join(folder, 'handoff.md'), join(exported.directory, 'handoff.md')],
    [join(legacy, 'INDEX.md'), exported.indexPath],
    [join(legacy, 'LATEST.md'), exported.latestPath],
  ] as const;
  for (const [target, source] of targets)
    writeFileSync(target, readFileSync(source, 'utf8') + '\nUSER_EDIT_MUST_REMAIN\n');
  const before = targets.map(([path]) => ({ bytes: readFileSync(path), mtime: statSync(path).mtimeMs }));
  const result = migrateLegacyProjectMemory(f.workspace, f.project, f.dataDir);
  assert.deepEqual(result.removed, [join(folder, 'history.jsonl')]);
  for (const [target] of targets) {
    assert.ok(result.preserved.includes(target));
    assert.ok(result.warnings.some((warning) => warning.includes(target) && warning.includes('完整已知模板不一致')));
  }
  assert.deepEqual(
    targets.map(([path]) => ({ bytes: readFileSync(path), mtime: statSync(path).mtimeMs })),
    before,
  );
});

test('migration validates every history field and complete ordered record set rather than accepting matching message text', (t) => {
  const f = fixture(t);
  message(f.workspace, f.conversation, 'user', 'First known message');
  message(f.workspace, f.conversation, 'assistant', 'Second known message');
  const original = f.workspace.allMessages(f.conversation.id);
  const folder = join(f.project.path, '.comborunner', 'conversations', f.conversation.id);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, 'history.jsonl');
  const variations = [
    [original[0]],
    [...original].reverse(),
    original.map((record, index) => (index ? record : { ...record, createdAt: '2026-01-01T00:00:00.000Z' })),
    original.map((record, index) =>
      index ? record : { ...record, unrelatedUserField: 'Preserve my custom metadata' },
    ),
  ];
  for (const records of variations) {
    const bytes = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
    writeFileSync(path, bytes);
    const result = migrateLegacyProjectMemory(f.workspace, f.project, f.dataDir);
    assert.deepEqual(result.removed, []);
    assert.ok(result.preserved.includes(path));
    assert.match(result.warnings.join('\n'), /完整已知模板不一致/);
    assert.equal(readFileSync(path, 'utf8'), bytes);
  }
  assert.deepEqual(f.workspace.allMessages(f.conversation.id), original);
});

test('migration removes byte-identical generated index and latest files only after verified private backup', (t) => {
  const f = fixture(t);
  message(f.workspace, f.conversation, 'user', 'Known message');
  const exported = exportConversationMemory(f.workspace, f.project, f.conversation.id, f.dataDir);
  const legacy = join(f.project.path, '.comborunner');
  mkdirSync(legacy);
  const targets = [
    [join(legacy, 'INDEX.md'), exported.indexPath],
    [join(legacy, 'LATEST.md'), exported.latestPath],
  ] as const;
  const original = targets.map(([, source]) => readFileSync(source));
  targets.forEach(([target], index) => writeFileSync(target, original[index]));
  const result = migrateLegacyProjectMemory(f.workspace, f.project, f.dataDir);
  assert.equal(result.removed.length, 2);
  assert.equal(result.backups.length, 2);
  targets.forEach(([target], index) => {
    assert.equal(existsSync(target), false);
    assert.deepEqual(readFileSync(result.backups.find((path) => path.endsWith(basename(target)))!), original[index]);
  });
  assert.deepEqual(result.warnings, []);
});

test('legacy settings inspection warns about edited project histories using metadata only and preserves bytes and mtimes', (t) => {
  const f = fixture(t);
  const legacy = join(f.project.path, '.comborunner');
  const folder = join(legacy, 'conversations', f.conversation.id);
  mkdirSync(folder, { recursive: true });
  const paths = [join(folder, 'history.jsonl'), join(legacy, 'INDEX.md'), join(legacy, 'LATEST.md')];
  for (const path of paths) writeFileSync(path, 'Edited unknown private data that must not be parsed.\n');
  const before = paths.map((path) => ({ bytes: readFileSync(path), mtime: statSync(path).mtimeMs }));
  const mock = t.mock.method(fs, 'readFileSync', () => {
    throw new Error('Inspection must never read full bodies');
  });
  syncBuiltinESMExports();
  let result: ReturnType<typeof inspectLegacyProjectMemory>;
  try {
    result = inspectLegacyProjectMemory(f.project.path);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(result.files, paths);
  assert.match(result.warnings.join('\n'), /1 个明文完整历史文件/);
  assert.match(result.warnings.join('\n'), /云同步或打包/);
  assert.deepEqual(
    paths.map((path) => ({ bytes: readFileSync(path), mtime: statSync(path).mtimeMs })),
    before,
  );
});

test('legacy settings inspection does not warn about current pointers without project history files', (t) => {
  const f = fixture(t);
  enableCli(f);
  exportConversationMemory(f.workspace, f.project, f.conversation.id, f.dataDir);
  assert.deepEqual(inspectLegacyProjectMemory(f.project.path), { files: [], warnings: [] });
});

test('legacy settings inspection refuses linked history destinations without reading or changing their targets', (t) => {
  const f = fixture(t);
  const folder = join(f.project.path, '.comborunner', 'conversations', f.conversation.id);
  mkdirSync(folder, { recursive: true });
  const outside = join(f.root, 'linked-private-history.jsonl');
  writeFileSync(outside, 'Outside remains unchanged.\n');
  linkSync(outside, join(folder, 'history.jsonl'));
  const result = inspectLegacyProjectMemory(f.project.path);
  assert.deepEqual(result.files, []);
  assert.match(result.warnings.join('\n'), /安全检查/);
  assert.equal(readFileSync(outside, 'utf8'), 'Outside remains unchanged.\n');
});
