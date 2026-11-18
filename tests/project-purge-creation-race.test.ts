import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fixture } from './helpers/session-workspace.ts';

test('a project creation held across a completed purge cannot recreate the project', { timeout: 10000 }, async (t) => {
  const { workspace, directory } = fixture(t);
  t.mock.property(process, 'env', { ...process.env, COMBORUNNER_MEMORY_VECTORS_DIR: join(directory, 'vectors') });
  const source = join(directory, 'original');
  mkdirSync(source);
  writeFileSync(join(source, 'keep.txt'), 'Original project content');
  const project = await workspace.createProject(source);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((done) => {
    entered = done;
  });
  const held = new Promise<void>((done) => {
    release = done;
  });
  const originalRealpath = fsPromises.realpath;
  let intercepted = false;
  const mock = t.mock.method(fsPromises, 'realpath', async (path: any, options: any) => {
    if (!intercepted && resolve(String(path)) === resolve(source)) {
      intercepted = true;
      entered();
      await held;
    }
    return originalRealpath(path, options);
  });
  syncBuiltinESMExports();
  const stale = workspace.createProject(source);
  void stale.catch(() => {});
  try {
    await started;
    workspace.removeProject(project.id);
    const preview = await workspace.projectData.preview(project.id);
    assert.equal(preview.canPurge, true);
    await workspace.projectData.purge(project.id, preview.token);
    assert.equal(workspace.store.projects(true).length, 0);
    release();
    await assert.rejects(stale, /清空状态已变化/);
    assert.equal(workspace.store.projects(true).length, 0);
    assert.equal(readFileSync(join(source, 'keep.txt'), 'utf8'), 'Original project content');
  } finally {
    release();
    mock.mock.restore();
    syncBuiltinESMExports();
    await stale.catch(() => {});
  }
});

for (const during of [true, false]) {
  test(
    `project creation is refused ${during ? 'during' : 'across'} a conversation empty`,
    { timeout: 15000 },
    async (t) => {
      const { workspace, directory, controller } = fixture(t);
      t.mock.property(process, 'env', { ...process.env, COMBORUNNER_MEMORY_VECTORS_DIR: join(directory, 'vectors') });
      const source = join(directory, 'original');
      mkdirSync(source);
      writeFileSync(join(source, 'keep.txt'), 'Original source');
      const project = await workspace.createProject(source);
      const chat = workspace.createConversation(project.id);
      workspace.store.deleteConversation(chat.id);
      const owned = join(controller.dataDir, 'member-results', chat.id);
      mkdirSync(owned, { recursive: true });
      writeFileSync(join(owned, 'result.txt'), 'Synthetic result');
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>((done) => {
        entered = done;
      });
      const held = new Promise<void>((done) => {
        release = done;
      });
      const originalRealpath = fsPromises.realpath;
      let intercepted = false;
      const mock = t.mock.method(fsPromises, 'realpath', async (path: any, options: any) => {
        if (!intercepted && resolve(String(path)) === resolve(source)) {
          intercepted = true;
          entered();
          await held;
        }
        return originalRealpath(path, options);
      });
      syncBuiltinESMExports();
      const token = workspace.conversationPurge.history().token;
      const pending = during ? workspace.conversationPurge.empty(token) : workspace.createProject(source);
      void pending.catch(() => {});
      try {
        await started;
        if (during) await assert.rejects(workspace.createProject(owned), /清空/);
        else await workspace.conversationPurge.empty(token);
        release();
        if (during) await pending;
        else await assert.rejects(pending, /清空状态已变化/);
        assert.equal(workspace.store.projects().length, 1);
        assert.equal(workspace.store.get('conversation', chat.id), undefined);
        assert.equal(readFileSync(join(source, 'keep.txt'), 'utf8'), 'Original source');
      } finally {
        release();
        mock.mock.restore();
        syncBuiltinESMExports();
        await pending.catch(() => {});
      }
    },
  );
}
