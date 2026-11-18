import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { listCursorChats, cursorTranscript } from '../src/server/cursor-import.ts';
import { attachmentLimits } from '../src/server/attachments.ts';
import { Workspace } from '../src/server/workspace.ts';
import { Controller } from '../src/server/controller.ts';
import { cursorDatabase, cursorFixture, cursorWorkspace, fakeCursorToken } from './helpers/cursor-fixture.ts';
import type { Conversation } from '../src/shared/types.ts';

function temp(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pugport-cursor-import-'));
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

for (const inline of [true, false])
  for (const blob of [false, true]) {
    test(`${inline ? 'inline' : 'headers'} / ${blob ? 'blob' : 'text'}: ordered, bounded transcript without secrets`, (t) => {
      const root = temp(t);
      const { ids } = cursorFixture(root, root, 'Design notes', inline, blob);
      const statements: string[] = [],
        logs: string[] = [];
      const prepare = DatabaseSync.prototype.prepare;
      t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
        statements.push(sql);
        return prepare.call(this, sql);
      });
      for (const method of ['log', 'warn', 'error'] as const)
        t.mock.method(console, method, (...args: unknown[]) => logs.push(String(args)));
      const list = listCursorChats(root, root);
      assert.equal(list.chats.length, 1);
      assert.deepEqual(statements, ['SELECT value FROM ItemTable WHERE key = ?']);
      statements.length = 0;
      const transcript = cursorTranscript(list.chats[0]!, root, root).toString();
      assert.equal(statements.length, inline ? 1 : ids.length + 1);
      assert.ok(statements.every((sql) => sql === 'SELECT value FROM cursorDiskKV WHERE key = ?'));
      assert.equal(transcript.match(/### Cursor/g)?.length, 3);
      assert.equal(transcript.match(/### You/g)?.length, 3);
      assert.match(transcript, /First reply\.\n\n```ts\nconst x = 1;\n```\n\n\*read\\_file\*/);
      assert.match(transcript, /unclosed\(\)\n```\n\n### You/);
      assert.match(transcript, /### Cursor\n\n\*search, read\\_file\*/);
      assert.ok(!JSON.stringify({ list, transcript, logs }).includes(fakeCursorToken));
    });
  }

test('paths: escaped Chinese, Windows slashes/case, Darwin case, Linux exact, duplicate workspaces and skipped kinds', (t) => {
  const root = temp(t);
  const chats = [{ composerId: 'same', name: 'Older', lastUpdatedAt: 1700000000000 }];
  cursorWorkspace(root, 'a', { folder: 'file:///c%3A/Users/Test/%E4%B8%AD%E6%96%87' }, chats);
  cursorWorkspace(
    root,
    'b',
    { folder: 'file:///C:/Users/Test/%E4%B8%AD%E6%96%87/' },
    [
      { ...chats[0], name: 'Newest', lastUpdatedAt: 1700000300000 },
      { composerId: 'other', name: 'Other', lastUpdatedAt: 1700000200000 },
    ],
    true,
  );
  cursorWorkspace(root, 'multi', { workspace: 'file:///c:/Users/Test/example.code-workspace' }, [
    { composerId: 'skip' },
  ]);
  cursorWorkspace(root, 'remote', { folder: 'vscode-remote://ssh-remote/test' }, [{ composerId: 'skip' }]);
  const win = listCursorChats('C:\\users\\TEST\\中文', root, 'win32');
  assert.deepEqual(
    win.chats.map((chat) => chat.name),
    ['Newest', 'Other'],
  );
  cursorWorkspace(root, 'mac', { folder: 'file:///Users/Test/Project' }, chats);
  assert.equal(listCursorChats('/users/test/project', root, 'darwin').chats.length, 1);
  assert.equal(listCursorChats('/users/test/project', root, 'linux').chats.length, 0);
  assert.equal(listCursorChats('/Users/Test/Project', root, 'linux').chats.length, 1);
  assert.equal(listCursorChats('/Users/Test/Project\\', root, 'linux').chats.length, 0);
  assert.deepEqual(listCursorChats(root, join(root, 'absent')), { installed: false, chats: [] });
});

test('workspace aliases match the physical project path without including unrelated chats', (t) => {
  const root = temp(t);
  const alias = join(root, 'project-alias');
  symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  cursorFixture(join(root, 'cursor'), alias);
  const physical = realpathSync.native(root);
  assert.equal(listCursorChats(physical, join(root, 'cursor')).chats[0]?.composerId, 'chat');
  assert.deepEqual(listCursorChats(join(root, 'other-project'), join(root, 'cursor')).chats, []);
});

test('unreadable, missing, empty and unknown records produce a plain safe error before writes', (t) => {
  const root = temp(t);
  const chat = { composerId: 'chat', name: 'Fixture' };
  assert.throws(() => cursorTranscript(chat, root, root), /读不到这条 Cursor 对话/);
  for (const value of [
    {},
    { conversation: [] },
    { fullConversationHeadersOnly: [] },
    { fullConversationHeadersOnly: [{ bubbleId: 'missing' }] },
    { conversation: [{ type: 9, text: fakeCursorToken }] },
  ]) {
    cursorDatabase(join(root, 'globalStorage', 'state.vscdb'), 'cursorDiskKV', { 'composerData:chat': value });
    assert.throws(
      () => cursorTranscript(chat, root, root),
      (error) =>
        error instanceof Error &&
        !error.message.includes(fakeCursorToken) &&
        error.message.startsWith('读不到这条 Cursor 对话：'),
    );
  }
});

test('empty workspace index is skipped; locked or malformed global data exposes no record values', (t) => {
  const root = temp(t);
  const { file } = cursorFixture(root, root);
  const index = new DatabaseSync(join(root, 'workspaceStorage', 'one', 'state.vscdb'));
  index.exec('DELETE FROM ItemTable');
  index.close();
  assert.deepEqual(listCursorChats(root, root), { installed: true, chats: [] });
  const db = new DatabaseSync(file);
  try {
    db.prepare('UPDATE cursorDiskKV SET value=? WHERE key=?').run(fakeCursorToken, 'composerData:chat');
    assert.throws(
      () => cursorTranscript({ composerId: 'chat', name: 'Fixture' }, root, root),
      (error) => error instanceof Error && !error.message.includes(fakeCursorToken),
    );
    db.exec('BEGIN EXCLUSIVE');
    assert.throws(() => cursorTranscript({ composerId: 'chat', name: 'Fixture' }, root, root), /database unreadable/);
    db.exec('ROLLBACK');
  } finally {
    db.close();
  }
});

async function fixture(t: TestContext, name?: string) {
  const root = mkdtempSync(join(tmpdir(), 'pugport-cursor-import-'));
  const controller = new Controller(root, join(root, 'data'));
  clearInterval(controller.timer);
  const workspace = new Workspace(controller, { autoTick: false });
  const project = await workspace.createProject(root);
  cursorFixture(join(root, 'cursor'), root, name);
  t.after(async () => {
    await workspace.close();
    await controller.close();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    rmSync(root, { recursive: true, force: true });
  });
  return { root: join(root, 'cursor'), workspace, project };
}

test('one conversation/message/attachment, no run, repeat opens, deleted and archived imports allow a fresh copy', async (t) => {
  const { root, workspace, project } = await fixture(t);
  const publisher = workspace as unknown as { publish: () => void };
  const publish = publisher.publish.bind(workspace);
  t.mock.method(publisher, 'publish', () => {
    for (const item of workspace.store.conversations(project.id))
      assert.equal(workspace.store.allMessages(item.id).length, 1);
    publish();
  });
  const conversation = await workspace.importCursorChat(project.id, 'chat', root);
  const messages = workspace.store.allMessages(conversation.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.role, 'user');
  assert.equal(messages[0]!.content, 'Imported from Cursor: Design notes');
  assert.deepEqual(messages[0]!.importedFrom, { provider: 'cursor', composerId: 'chat' });
  assert.equal(messages[0]!.attachments?.length, 1);
  assert.equal(workspace.store.list('workflow').length, 0);
  assert.equal(workspace.controller.store.runSummaries().length, 0);
  const attachment = workspace.attachments.get(conversation.id, messages[0]!.attachments![0]!.id);
  assert.match(readFileSync(attachment.path, 'utf8'), /### Cursor/);
  const history = t.mock.method(workspace.store, 'allMessages', () => {
    throw Error('Listing imports must not load message bodies');
  });
  assert.equal(workspace.cursorChats(project.id, root).chats[0]!.conversationId, conversation.id);
  history.mock.restore();
  assert.equal((await workspace.importCursorChat(project.id, 'chat', root)).id, conversation.id);
  assert.equal(workspace.store.conversations(project.id).length, 1);
  workspace.store.deleteConversation(conversation.id);
  assert.equal(workspace.cursorChats(project.id, root).chats[0]!.conversationId, undefined);
  const second = await workspace.importCursorChat(project.id, 'chat', root);
  workspace.store.archiveConversation(second.id, true);
  assert.equal(workspace.cursorChats(project.id, root).chats[0]!.conversationId, undefined);
  assert.notEqual((await workspace.importCursorChat(project.id, 'chat', root)).id, second.id);
});

test('concurrent import refuses the second request and writes once', async (t) => {
  const { root, workspace, project } = await fixture(t);
  const publisher = workspace as unknown as { publish: () => void };
  const publish = publisher.publish.bind(workspace);
  const broadcasts = t.mock.method(publisher, 'publish', () => {
    for (const item of workspace.store.conversations(project.id))
      assert.equal(workspace.store.allMessages(item.id).length, 1);
    publish();
  });
  const result = await Promise.allSettled([
    workspace.importCursorChat(project.id, 'chat', root),
    workspace.importCursorChat(project.id, 'chat', root),
  ]);
  assert.deepEqual(
    result.map((item) => item.status),
    ['fulfilled', 'rejected'],
  );
  assert.equal(workspace.store.conversations(project.id).length, 1);
  assert.equal(broadcasts.mock.callCount(), 1);
});

for (const step of ['attachment', 'message', 'publish'] as const)
  test(`${step} failure hides shell from conversation list and recycle bin`, async (t) => {
    const { root, workspace, project } = await fixture(t);
    if (step === 'attachment')
      t.mock.method(workspace.attachments, 'saveStream', async () => {
        throw Error(fakeCursorToken);
      });
    else if (step === 'publish') {
      t.mock.method(workspace as unknown as { publish: () => void }, 'publish', () => {
        throw Error(fakeCursorToken);
      });
    } else {
      const save = workspace.store.save.bind(workspace.store);
      t.mock.method(workspace.store, 'save', (kind: string, ...args: unknown[]) => {
        if (kind === 'message') throw Error(fakeCursorToken);
        return (save as (...args: unknown[]) => unknown)(kind, ...args);
      });
    }
    await assert.rejects(
      workspace.importCursorChat(project.id, 'chat', root),
      (error) => error instanceof Error && !error.message.includes(fakeCursorToken),
    );
    assert.equal(workspace.store.conversations(project.id).length, 0);
    assert.equal(workspace.store.deletedConversations().length, 0);
    assert.ok(workspace.store.list<Conversation>('conversation')[0]!.deletedAt);
  });

test('size is checked before creation; invalid names keep md extension and empty names fall back', async (t) => {
  const { root, workspace, project } = await fixture(t, '/\\\x01' + '界'.repeat(230));
  const previous = attachmentLimits.fileBytes;
  Object.defineProperty(attachmentLimits, 'fileBytes', { value: 10 });
  t.after(() => Object.defineProperty(attachmentLimits, 'fileBytes', { value: previous }));
  await assert.rejects(workspace.importCursorChat(project.id, 'chat', root), /attachment exceeds/);
  assert.equal(workspace.store.conversations(project.id).length, 0);
  Object.defineProperty(attachmentLimits, 'fileBytes', { value: previous });
  assert.equal(attachmentLimits.fileBytes, previous);
  const conversation = await workspace.importCursorChat(project.id, 'chat', root);
  const name = workspace.store.allMessages(conversation.id)[0]!.attachments![0]!.name;
  assert.equal(name.length, 200);
  assert.ok(name.endsWith('.md'));
  assert.ok(!/[\\/\x00-\x1f\x7f]/.test(name));
  workspace.store.deleteConversation(conversation.id);
  cursorFixture(root, project.path, '   ');
  const fallback = await workspace.importCursorChat(project.id, 'chat', root);
  assert.equal(fallback.title, 'Cursor chat 2023-11-14');
  assert.equal(workspace.store.allMessages(fallback.id)[0]!.attachments![0]!.name, fallback.title + '.md');
});

for (const problem of ['empty metadata', 'broken metadata', 'missing database', 'invalid composers']) {
  test(`workspace isolation: ${problem} does not hide readable matches`, (t) => {
    const root = temp(t);
    cursorFixture(root, root);
    const metadata = { folder: new URL('file:///unrelated').href };
    cursorWorkspace(root, 'broken', metadata, []);
    const directory = join(root, 'workspaceStorage', 'broken');
    if (problem.endsWith('metadata')) {
      writeFileSync(join(directory, 'workspace.json'), problem === 'empty metadata' ? '' : '{broken');
    } else {
      const original = readFileSync(join(root, 'workspaceStorage', 'one', 'workspace.json'));
      writeFileSync(join(directory, 'workspace.json'), original);
      if (problem === 'missing database') rmSync(join(directory, 'state.vscdb'));
      else
        cursorDatabase(join(directory, 'state.vscdb'), 'ItemTable', {
          'composer.composerData': { allComposers: {} },
        });
    }
    assert.equal(listCursorChats(root, root).chats.length, 1);
    cursorDatabase(join(root, 'workspaceStorage', 'one', 'state.vscdb'), 'ItemTable', {
      'composer.composerData': { allComposers: [] },
    });
    assert.deepEqual(listCursorChats(root, root).chats, []);
    // Remove only the known synthetic healthy folder to check the all-failed case.
    rmSync(join(root, 'workspaceStorage', 'one', 'workspace.json'));
    if (problem.endsWith('metadata')) assert.deepEqual(listCursorChats(root, root).chats, []);
    else assert.throws(() => listCursorChats(root, root), /workspace index unreadable/);
  });
}

test('missing bubble rows are skipped while available turns stay in header order', (t) => {
  const root = temp(t);
  const { file } = cursorFixture(root, root, 'Partial chat', false);
  const db = new DatabaseSync(file);
  db.prepare('DELETE FROM cursorDiskKV WHERE key = ?').run('bubbleId:chat:a');
  db.close();
  const transcript = cursorTranscript(listCursorChats(root, root).chats[0]!, root, root).toString();
  assert.ok(!transcript.includes('First reply.'));
  assert.match(transcript, /### You/);
  assert.match(transcript, /const x = 1;/);
});

test('filename truncation preserves an emoji at the 197-character boundary', async (t) => {
  const title = 'a'.repeat(196) + '\u{1f436}' + 'tail';
  const { root, workspace, project } = await fixture(t, title);
  const conversation = await workspace.importCursorChat(project.id, 'chat', root);
  const name = workspace.store.allMessages(conversation.id)[0]!.attachments![0]!.name;
  assert.equal(name, 'a'.repeat(196) + '\u{1f436}.md');
  assert.equal(Array.from(name).length, 200);
  await assert.rejects(
    workspace.attachments.saveStream(
      conversation.id,
      { name: '\u{1f436}'.repeat(201), mimeType: 'text/markdown' },
      Readable.from('synthetic'),
    ),
    /文件名无效/,
  );
});
