import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { relocatedProjectPath } from '../src/server/project-relocation.ts';
import type { Conversation, Project } from '../src/shared/types.ts';

test('startup preserves missing project paths even when a renamed source counterpart exists', async (t) => {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-folder-identity-')));
  const root = join(directory, 'ComboRunner');
  const original = join(directory, 'agent-studio', 'project');
  mkdirSync(join(root, 'project'), { recursive: true });
  const controller = new Controller(root, join(directory, 'data'));
  clearInterval(controller.timer);
  let workspace: Workspace | undefined;
  t.after(async () => {
    await workspace?.close();
    await controller.close();
    assert.equal(dirname(directory), realpathSync.native(tmpdir()));
    assert.ok(basename(directory).startsWith('pugport-folder-identity-'));
    rmSync(directory, { recursive: true, force: true });
  });
  const store = new WorkspaceStore(controller.store.db);
  const project: Project = { id: 'project', name: 'Synthetic', path: original, createdAt: '', updatedAt: '' };
  const chat: Conversation = { id: 'chat', projectId: project.id, title: 'Synthetic', createdAt: '', updatedAt: '' };
  store.save('project', project.id, project.id, project);
  store.save('conversation', chat.id, project.id, chat);
  workspace = new Workspace(controller);
  assert.equal(workspace.store.get<Project>('project', project.id)!.path, original);
  assert.equal(workspace.store.get<Conversation>('conversation', chat.id)!.projectId, project.id);
  assert.equal(workspace.state().projects![0].folderMissing, true);
  assert.equal(existsSync(original), false);
});

test('source rename repairs only missing paths with existing directory counterparts', () => {
  const temp = mkdtempSync(join(tmpdir(), 'comborunner-relocation-'));
  try {
    const root = join(temp, 'ComboRunner'),
      old = join(temp, 'agent-studio');
    mkdirSync(join(root, 'project'), { recursive: true });
    assert.equal(relocatedProjectPath(old, root), root);
    assert.equal(relocatedProjectPath(join(old, 'project'), root), join(root, 'project'));
    assert.equal(relocatedProjectPath(join(old, 'missing'), root), join(old, 'missing'));
    const other = join(temp, 'agent-studio-other', 'project');
    assert.equal(relocatedProjectPath(other, root), other);
    mkdirSync(old);
    assert.equal(relocatedProjectPath(join(old, 'project'), root), join(old, 'project'));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
