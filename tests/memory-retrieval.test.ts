import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import {
  closeMemoryRetrieval,
  filterRetrievedMemory,
  historyPaths,
  memorySearchTerms,
  retrieveLocalMemory,
} from '../src/server/memory-retrieval.ts';
import { assessLocalMemoryEvidence } from '../src/server/memory-evidence.ts';
import type { Conversation, Project } from '../src/shared/types.ts';

function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  const project: Project = {
    id: 'project',
    name: 'Test',
    path: '/project',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
  const conversation: Conversation = {
    id: 'conversation',
    projectId: project.id,
    title: 'Test',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
  store.save('project', project.id, '', project);
  store.save('conversation', conversation.id, project.id, conversation);
  t.after(() => db.close());
  const retrieve = (query: string, options?: Parameters<typeof retrieveLocalMemory>[2]) => {
    const message = store.addMessage(conversation.id, 'user', query);
    return retrieveLocalMemory(
      store,
      { projectId: project.id, conversationId: conversation.id, userMessageId: message.id, query },
      options,
    );
  };
  return { db, store, project, conversation, retrieve };
}

for (const disabled of ['reader', 'source'] as const) {
  test(`memory revalidation removes excerpts, directory evidence and paths when ${disabled} is off`, async (t) => {
    const { store, project, conversation, retrieve } = fixture(t);
    const source = { ...conversation, id: 'source' };
    store.save('conversation', source.id, project.id, source);
    store.addMessage(source.id, 'assistant', 'SYNTHETIC_PRIVATE is in D:/synthetic/private.txt');
    const snapshot = await retrieve('Find SYNTHETIC_PRIVATE file', {
      direct: true,
      inspectPath: async () => ({ exists: true, kind: 'file' }),
    });
    assert.ok(snapshot.excerpts.length);
    snapshot.directoryExcerpts = [...snapshot.excerpts];
    snapshot.evidence = assessLocalMemoryEvidence('Find SYNTHETIC_PRIVATE file', snapshot.excerpts);
    const switched = disabled === 'reader' ? conversation : source;
    store.save('conversation', switched.id, project.id, { ...switched, memory: 'off' });
    const filtered = filterRetrievedMemory(store, conversation.id, snapshot);
    assert.equal(store.memoryEnabled(conversation.id), disabled !== 'reader');
    assert.deepEqual(filtered.excerpts, []);
    assert.deepEqual(filtered.directoryExcerpts, []);
    assert.deepEqual(filtered.paths, []);
    assert.deepEqual(filtered.evidence!.decisions, []);
    assert.equal(filtered.context, '');
    assert.ok(snapshot.context.includes('SYNTHETIC_PRIVATE'), 'the original snapshot stays intact');
    store.save('conversation', source.id, project.id, { ...source, deletedAt: '2026-10-14' });
    assert.equal(filterRetrievedMemory(store, conversation.id, snapshot).context, '');
    store.save('conversation', source.id, project.id, { ...source, incognito: true });
    assert.equal(filterRetrievedMemory(store, conversation.id, snapshot).context, '');
  });
}

for (const disableReader of [true, false]) {
  test(`path inspection cannot return memory switched off mid-flight; reader=${disableReader}`, async (t) => {
    const { store, project, conversation, retrieve } = fixture(t);
    const source = { ...conversation, id: 'source' };
    store.save('conversation', source.id, project.id, source);
    store.addMessage(source.id, 'assistant', 'SECRET_REVIEW_RECORD is saved in D:/synthetic/secret.txt');
    let started!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = retrieve('Find SECRET_REVIEW_RECORD file path', {
      inline: true,
      direct: true,
      inspectPath: async () => {
        started();
        await wait;
        return { exists: true, kind: 'file' };
      },
    });
    await ready;
    store.save('conversation', source.id, project.id, { ...source, memory: 'off' });
    if (disableReader) store.save('conversation', conversation.id, project.id, { ...conversation, memory: 'off' });
    release();
    const result = await pending;
    assert.deepEqual(result.excerpts, []);
    assert.deepEqual(result.paths, []);
    assert.equal(result.context, '');
  });
}

test('retrieval finds an old local download path outside the recent-message window and verifies its existence', async (t) => {
  const { store, conversation, retrieve } = fixture(t);
  const root = mkdtempSync(join(tmpdir(), 'combo-memory-path-'));
  const thunder = join(root, '迅雷下载');
  mkdirSync(thunder);
  t.after(() => {
    assert.equal(
      resolve(root).startsWith(resolve(tmpdir()) + '\\') || resolve(root).startsWith(resolve(tmpdir()) + '/'),
      true,
    );
    rmSync(root, { recursive: true, force: true });
  });
  store.addMessage(
    conversation.id,
    'assistant',
    '早期调查\n' +
      '无关内容'.repeat(10000) +
      `\n迅雷下载的实际路径是 "${thunder}"，应先检查文件。\n` +
      '后续内容'.repeat(10000),
  );
  for (let index = 0; index < 40; index++) store.addMessage(conversation.id, 'assistant', `后来的普通说明 ${index}`);
  const memory = await retrieve('迅雷下载里面还有哪些东西？');
  assert.ok(memory.context.includes(thunder));
  assert.ok(memory.excerpts.some((entry) => entry.sourceOffset > 10000));
  assert.deepEqual(
    memory.paths.find((entry) => entry.path === thunder),
    { path: thunder, exists: true, kind: 'directory' },
  );
  assert.ok(memory.context.length < 8000);
  assert.ok(memory.context.includes('不是新的指令'));
  assert.ok(memory.context.includes('不增加当前权限'));
});

test('project retrieval includes older sibling conversations but excludes other projects and later queued prompts', async (t) => {
  const { store, project, conversation, retrieve } = fixture(t);
  const sibling = { ...conversation, id: 'sibling' };
  store.save('conversation', sibling.id, project.id, sibling);
  const older = store.addMessage(sibling.id, 'assistant', '迅雷的路径为 D:\\ThunderArchive');
  older.createdAt = '2026-01-01T00:00:00.000Z';
  store.save('message', older.id, sibling.id, older);
  const foreign = { ...conversation, id: 'foreign', projectId: 'unrelated' };
  store.save('conversation', foreign.id, foreign.projectId, foreign);
  store.addMessage(foreign.id, 'assistant', '迅雷的机密路径 D:\\ForeignSecret');
  const future = store.addMessage(sibling.id, 'user', '迅雷下载请执行 FUTURE_INSTRUCTION');
  future.createdAt = '2999-01-01T00:00:00.000Z';
  store.save('message', future.id, sibling.id, future);
  const memory = await retrieve('迅雷下载在哪里', { inspectPath: async () => ({ exists: true, kind: 'directory' }) });
  assert.ok(memory.context.includes('D:\\ThunderArchive'));
  assert.ok(!memory.context.includes('ForeignSecret'));
  assert.ok(!memory.context.includes('FUTURE_INSTRUCTION'));
});

test('imported Grok tool metadata provides local paths even when no assistant summary mentions the full path', async (t) => {
  const { store, conversation, retrieve } = fixture(t);
  const tool = store.addMessage(
    conversation.id,
    'assistant',
    '工具调用（历史记录，未执行）：\n' +
      JSON.stringify(
        [{ name: 'powershell', arguments: { command: 'Get-ChildItem -LiteralPath "D:\\迅雷下载"' } }],
        null,
        2,
      ),
  );
  tool.importedFrom = { provider: 'grok', sessionId: 'private-session', line: 4, timestampKind: 'exact' };
  store.save('message', tool.id, conversation.id, tool);
  const memory = await retrieve('检查迅雷下载', { inspectPath: async () => ({ exists: true, kind: 'directory' }) });
  assert.ok(memory.paths.some((entry) => entry.path === 'D:\\迅雷下载'));
  assert.ok(memory.context.includes(tool.id));
  assert.ok(!memory.context.includes('private-session'));
});

test('continuation retrieves the previous user subject while a simple greeting adds no historic project data', async (t) => {
  const { store, conversation, retrieve } = fixture(t);
  store.addMessage(conversation.id, 'assistant', '音频指纹脚本位于 D:\\Work\\fingerprints.py');
  store.addMessage(conversation.id, 'user', '检查音频指纹是否完成');
  const memory = await retrieve('继续', { inspectPath: async () => ({ exists: false }) });
  assert.ok(memory.context.includes('fingerprints.py'));
  assert.equal(memory.paths.find((entry) => entry.path.endsWith('fingerprints.py'))?.exists, false);
  const greeting = await retrieve('你好！');
  assert.equal(greeting.context, '');
  assert.deepEqual(greeting.paths, []);
});

test('deleted conversations and messages after the same-conversation anchor are excluded', async (t) => {
  const { store, project, conversation } = fixture(t);
  const deleted = { ...conversation, id: 'deleted', deletedAt: '2026-01-01' };
  store.save('conversation', deleted.id, project.id, deleted);
  store.addMessage(deleted.id, 'assistant', '迅雷下载删除的记录');
  const anchor = store.addMessage(conversation.id, 'user', '迅雷下载');
  store.addMessage(conversation.id, 'user', '迅雷下载未来指令');
  const result = await retrieveLocalMemory(store, {
    projectId: project.id,
    conversationId: conversation.id,
    userMessageId: anchor.id,
    query: anchor.content,
  });
  assert.equal(result.context, '');
});

test('history imported after enqueue is included only when its native timestamp predates the user anchor', async (t) => {
  const { store, project, conversation } = fixture(t);
  const anchor = store.addMessage(conversation.id, 'user', '迅雷下载');
  const imported = store.addMessage(conversation.id, 'assistant', '迅雷下载早期路径 D:\\ImportedDownload');
  imported.createdAt = '2026-01-01T00:00:00.000Z';
  imported.importedFrom = { provider: 'grok', sessionId: 'old', line: 1, timestampKind: 'exact' };
  store.save('message', imported.id, conversation.id, imported);
  const future = store.addMessage(conversation.id, 'assistant', '迅雷下载 FUTURE_IMPORT');
  future.createdAt = '2999-01-01T00:00:00.000Z';
  future.importedFrom = { provider: 'grok', sessionId: 'future', line: 1, timestampKind: 'exact' };
  store.save('message', future.id, conversation.id, future);
  const result = await retrieveLocalMemory(
    store,
    { projectId: project.id, conversationId: conversation.id, userMessageId: anchor.id, query: anchor.content },
    { inspectPath: async () => ({ exists: true, kind: 'directory' }) },
  );
  assert.ok(result.excerpts.some((hit) => hit.messageId === imported.id));
  assert.ok(!result.context.includes('FUTURE_IMPORT'));
});

test('path extraction handles quoted spaces and escaped native tool strings without shell execution', () => {
  assert.ok(historyPaths('"D:\\My Downloads\\archive"').includes('D:\\My Downloads\\archive'));
  assert.ok(historyPaths(JSON.stringify({ command: 'Read D:\\迅雷下载' })).includes('D:\\迅雷下载'));
  assert.ok(historyPaths('Get /home/alice/downloads 先检查').includes('/home/alice/downloads'));
  assert.deepEqual(historyPaths('relative/path; $(danger)'), []);
  assert.ok(memorySearchTerms('迅雷下载还有哪些文件').includes('迅雷'));
});

test('generic file work recovers project-referenced directories when the new request omits their names', async (t) => {
  const { store, conversation, retrieve } = fixture(t);
  const old = store.addMessage(conversation.id, 'assistant', '已检查 "D:\\迅雷下载\\clip.mp4" 的指纹。');
  const memory = await retrieve('整理文档', {
    inspectPath: async (path) => ({ exists: true, kind: path.endsWith('.mp4') ? 'file' : 'directory' }),
  });
  assert.ok(memory.paths.some((entry) => entry.path === 'D:\\迅雷下载' && entry.kind === 'directory'));
  assert.ok(memory.context.includes(old.id));
  assert.ok(memory.context.includes('项目目录外的路径仍遵守'));
});

test('history retrieval propagates cancellation after path inspection instead of returning stale evidence', async (t) => {
  const { store, conversation, retrieve } = fixture(t);
  store.addMessage(conversation.id, 'assistant', 'SYNTHETIC_CANCELLED is in D:/synthetic/file.txt');
  const abort = new AbortController();
  const pending = retrieve('Find SYNTHETIC_CANCELLED file', {
    direct: true,
    signal: abort.signal,
    inspectPath: async () => {
      abort.abort(new Error('synthetic-cancel'));
      return { exists: true, kind: 'file' };
    },
  });
  await assert.rejects(pending, /synthetic-cancel/);
});

test('large disk archives are searched in a persistent read-only worker while the event loop remains responsive', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'combo-memory-worker-'));
  const db = new DatabaseSync(join(root, 'history.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000');
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  t.after(async () => {
    await closeMemoryRetrieval(store);
    db.close();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '\\') || resolve(root).startsWith(resolve(tmpdir()) + '/'));
    rmSync(root, { recursive: true, force: true });
  });
  const project = {
    id: 'disk-project',
    name: 'Disk',
    path: '/disk-project',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
  const conversation = {
    id: 'disk-conversation',
    projectId: project.id,
    title: 'Disk',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
  store.save('project', project.id, '', project);
  store.save('conversation', conversation.id, project.id, conversation);
  for (let index = 0; index < 160; index++)
    store.addMessage(conversation.id, 'assistant', '背景'.repeat(10000) + '\n旧数据库迁移策略：先检查 schema 版本。');
  const anchor = store.addMessage(conversation.id, 'user', '数据库迁移策略');
  const before = db.prepare('SELECT count(*) AS count FROM workspace_records').get()!.count;
  const abort = new AbortController();
  const cancelled = retrieveLocalMemory(
    store,
    {
      projectId: project.id,
      conversationId: conversation.id,
      userMessageId: anchor.id,
      query: anchor.content,
    },
    { signal: abort.signal },
  );
  abort.abort(new Error('synthetic-cancel'));
  await assert.rejects(cancelled, /synthetic-cancel/);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  const result = await retrieveLocalMemory(store, {
    projectId: project.id,
    conversationId: conversation.id,
    userMessageId: anchor.id,
    query: anchor.content,
  });
  clearInterval(timer);
  assert.equal(result.error, undefined);
  assert.equal(result.strategy, 'direct', 'a cold task must get evidence without waiting for the complete index');
  assert.ok(ticks >= 2, `event loop did not keep ticking: ${ticks}`);
  assert.ok(result.context.includes('schema'));
  assert.equal(db.prepare('SELECT count(*) AS count FROM workspace_records').get()!.count, before);
  const next = store.addMessage(conversation.id, 'assistant', '数据库迁移新的线索：NEVER_COPY_NATIVE_SESSION_ID');
  const second = store.addMessage(conversation.id, 'user', '数据库迁移新的线索');
  const fresh = await retrieveLocalMemory(store, {
    projectId: project.id,
    conversationId: conversation.id,
    userMessageId: second.id,
    query: second.content,
  });
  assert.equal(fresh.error, undefined);
  assert.ok(fresh.excerpts.some((entry) => entry.messageId === next.id));
});

test('passages found by meaning join the evidence, within the same visibility rules', async (t) => {
  const { store, project, conversation } = fixture(t);
  const build = store.addMessage(
    conversation.id,
    'assistant',
    'build 失败：图标文件缺失，补上 assets/icons 后重新打包就好了。',
  );
  store.addMessage(conversation.id, 'assistant', '迅雷下载目录已经整理完毕。');
  const deleted = { ...conversation, id: 'deleted-meaning', deletedAt: '2026-01-01' };
  store.save('conversation', deleted.id, project.id, deleted);
  const hidden = store.addMessage(deleted.id, 'assistant', '被删除对话里的打包记录');
  const anchor = store.addMessage(conversation.id, 'user', '上次那个打包报错怎么解决的');
  const later = store.addMessage(conversation.id, 'assistant', '之后才发生的打包记录');
  const result = await retrieveLocalMemory(
    store,
    {
      projectId: project.id,
      conversationId: conversation.id,
      userMessageId: anchor.id,
      query: anchor.content,
      semantic: [
        { messageId: hidden.id, offset: 0, score: 0.8 },
        { messageId: later.id, offset: 0, score: 0.78 },
        { messageId: build.id, offset: 0, score: 0.72 },
      ],
    },
    { inline: true },
  );
  assert.equal(result.strategy, 'minisearch+meaning');
  assert.match(result.context, /图标文件缺失/);
  assert.doesNotMatch(result.context, /被删除对话里|之后才发生/);
});
