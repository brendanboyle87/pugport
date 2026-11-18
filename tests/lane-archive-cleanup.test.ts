import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './helpers/session-workspace.ts';
import { readLaneEvents } from '../src/server/lane-events.ts';
import type { Conversation } from '../src/shared/types.ts';

test('archive records cleanup and rechecks current state inside the release operation', async (t) => {
  const f = fixture(t);
  const project = await f.workspace.createProject(f.directory);
  const lane = f.workspace.createConversation(project.id, 'Synthetic lane');
  lane.lane = {
    parentConversationId: 'parent',
    sourceWorkflowId: 'source',
    workspaceId: 'managed',
    branch: 'branch',
    base: 'main',
    baseCommit: 'abc',
  };
  f.workspace.store.save('conversation', lane.id, project.id, lane);
  let continueRelease!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    continueRelease = resolve;
  });
  const manager = {
    release: async (_id: string, options: { stillWanted: () => boolean }) => {
      started();
      await gate;
      return options.stillWanted()
        ? { status: 'removed', branch: 'branch', branchDeleted: true, unlinked: [] }
        : { status: 'kept', reason: 'revoked' };
    },
  };
  (f.workspace as unknown as { managedWorktreeStore: unknown }).managedWorktreeStore = manager;
  f.workspace.archiveConversation(lane.id, true);
  await ready;
  f.workspace.archiveConversation(lane.id, false);
  continueRelease();
  for (let i = 0; i < 100 && !f.workspace.store.get<Conversation>('conversation', lane.id)?.lane?.cleanup; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const current = f.workspace.store.get<Conversation>('conversation', lane.id)!;
  assert.equal(current.lane?.cleanup?.status, 'kept');
  assert.equal(current.lane?.workspaceId, 'managed');
  assert.deepEqual(
    readLaneEvents(f.controller.dataDir, project.id).map((event) => event.type),
    ['archived', 'worktree-kept'],
  );
});

for (const scenario of [
  {
    name: 'removed',
    result: { status: 'removed' as const, branch: 'branch', head: 'abc123', branchDeleted: true, unlinked: [] },
    event: 'worktree-removed',
  },
  {
    name: 'detached',
    result: { status: 'kept' as const, reason: 'synthetic removal failure', head: 'abc123', detached: true },
    event: 'worktree-kept',
  },
]) {
  test(`archive clears a ${scenario.name} workspace binding and records its event`, async (t) => {
    const f = fixture(t);
    const project = await f.workspace.createProject(f.directory);
    const lane = f.workspace.createConversation(project.id, 'Synthetic lane');
    lane.lane = {
      parentConversationId: 'parent',
      sourceWorkflowId: 'source',
      workspaceId: 'managed',
      branch: 'branch',
      base: 'main',
      baseCommit: 'abc',
    };
    f.workspace.store.save('conversation', lane.id, project.id, lane);
    (f.workspace as unknown as { managedWorktreeStore: unknown }).managedWorktreeStore = {
      release: async () => scenario.result,
    };
    f.workspace.archiveConversation(lane.id, true);
    for (let i = 0; i < 100 && !f.workspace.store.get<Conversation>('conversation', lane.id)?.lane?.cleanup; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const current = f.workspace.store.get<Conversation>('conversation', lane.id)!;
    assert.equal(current.lane?.cleanup?.status, scenario.result.status);
    if (scenario.result.status === 'removed') assert.equal(current.lane?.cleanup?.head, 'abc123');
    assert.equal(current.lane?.workspaceId, undefined);
    assert.equal(current.lane?.branch, undefined);
    assert.equal(current.lane?.base, undefined);
    assert.equal(current.lane?.baseCommit, undefined);
    const events = readLaneEvents(f.controller.dataDir, project.id);
    assert.deepEqual(
      events.map((event) => event.type),
      ['archived', scenario.event],
    );
    assert.equal(events[1]?.sha, 'abc123');
  });
}
