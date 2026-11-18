import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { moveToRecycleBin } from './recycle-bin.ts';
import type { Conversation, Project } from '../shared/types.ts';
import type { WorkspaceStore } from './workspace-store.ts';
import type { Attachments } from './attachments.ts';
import { removeConversationRecords } from './conversation-purge.ts';

/** Refuse traversal and directory junctions before touching app-owned conversation folders. */
export function incognitoDirectory(dataDir: string, group: 'member-results' | 'workspaces', id: string) {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id)) throw Error('Invalid incognito directory ID');
  const base = realpathSync.native(dataDir);
  const root = join(base, group);
  const path = join(root, id);
  for (const entry of [root, path]) {
    const info = lstatSync(entry, { throwIfNoEntry: false });
    if (!info) continue;
    if (info.isSymbolicLink() || relative(base, realpathSync.native(entry)) !== relative(base, entry))
      throw Error('Incognito directory must stay inside its data directory');
  }
  return path;
}

/** Called only after this conversation's execution and finalisation have stopped. */
export async function deleteIncognito(
  store: WorkspaceStore,
  attachments: Attachments,
  id: string,
  recycle = moveToRecycleBin,
  stopped = () => !store.db.isOpen,
) {
  if (stopped()) return;
  const conversation = store.get<Conversation>('conversation', id);
  if (!conversation?.incognito) return;
  const project = store.get<Project>('project', conversation.projectId);
  const emptyChatProject =
    project?.scope === 'chat' &&
    !store.list('conversation-purge', project.id, Number.MAX_SAFE_INTEGER).length &&
    !store.list<Conversation>('conversation', project.id, Number.MAX_SAFE_INTEGER).some((item) => item.id !== id);
  const results = incognitoDirectory(attachments.dataDir, 'member-results', id);
  rmSync(results, { recursive: true, force: true });
  let removeProject = emptyChatProject;
  if (emptyChatProject) {
    // The folder and project are optional cleanup: any doubt keeps them, but the conversation is still deleted.
    try {
      const folder = incognitoDirectory(attachments.dataDir, 'workspaces', project.path.split(/[\\/]/).at(-1)!);
      if (resolve(project.path) !== resolve(folder)) throw Error('Invalid incognito workspace path');
      if (existsSync(folder)) {
        const outcome = await recycle(join(attachments.dataDir, 'workspaces'), [folder]);
        if (outcome.failed.length || existsSync(folder)) throw Error('Incognito workspace could not be recycled');
      }
    } catch (error) {
      removeProject = false;
      console.warn('Incognito workspace kept because recycling failed:', project.id, error);
    }
  }
  if (stopped()) return;
  attachments.removeUnshared(id);
  store.transaction(() => {
    removeConversationRecords(store, [id]);
    if (removeProject) store.db.prepare('DELETE FROM workspace_records WHERE owner=?').run(project!.id);
  });
}

export async function purgeIncognito(
  store: WorkspaceStore,
  attachments: Attachments,
  firstStart: boolean,
  recycle = moveToRecycleBin,
  stopped = () => !store.db.isOpen,
) {
  if (stopped()) return false;
  const conversations = store
    .list<Conversation>('conversation', undefined, Number.MAX_SAFE_INTEGER)
    .filter((item) => item.incognito && (firstStart || item.closedAt));
  for (const conversation of conversations) {
    if (stopped()) return false;
    conversation.closedAt ??= new Date().toISOString();
    store.save('conversation', conversation.id, conversation.projectId, conversation);
  }
  for (const conversation of conversations) {
    if (stopped()) return false;
    try {
      await deleteIncognito(store, attachments, conversation.id, recycle, stopped);
    } catch (error) {
      console.warn('Incognito cleanup failed; will retry next start:', conversation.id, error);
    }
  }
  return conversations.length > 0;
}
