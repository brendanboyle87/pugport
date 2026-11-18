import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { ConversationActions } from '../src/server/conversation-actions.ts';
import { modDebugMarker, workModeMarker } from '../src/shared/work-modes.ts';
import type { ExecuteContext } from '../src/shared/types.ts';
import { fixture, finished, input, result } from './helpers/session-workspace.ts';

const markers = [workModeMarker, modDebugMarker];
/** Records that hold the assembled run input (the trajectory): diagnostic evidence, allowed to carry the prompt. */
const trajectoryKinds = new Set(['run']);

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return files(path);
    // SQLite files are checked record by record below.
    return /\.(?:db|sqlite)(?:-wal|-shm|-journal)?$/.test(entry.name) ? [] : [path];
  });
}

test('mode text reaches the run prompt only, never memory, messages or routing input', async (t) => {
  const f = fixture(t, false);
  f.controller.targets = f.controller.targets.slice(0, 1);
  f.controller.snapshots = f.controller.snapshots.slice(0, 1);
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    return result('completed', 'Synthetic reply.');
  });
  const actions = new ConversationActions(f.workspace);
  // The memory folder may not sit inside a project, so the project gets its own subfolder.
  const folder = join(f.directory, 'project');
  mkdirSync(folder);
  const project = await f.workspace.createProject(folder);
  for (const kind of ['mods-author', 'navigator'] as const)
    for (const mode of ['chat', 'build'] as const) {
      const conversation = f.workspace.createConversation(project.id);
      assert.ok(f.workspace.store.memoryEnabled(conversation.id));
      actions.setWorkMode(conversation.id, kind);
      // A frame error waiting for the Mods author turn, so its prompt carries a real <pugport-mod-debug> block.
      if (kind === 'mods-author') {
        const record = f.workspace.modWorkspaces.ensure(conversation.id);
        f.workspace.modWorkspaces.addDiagnostics(record.id, [
          { level: 'error', source: 'frame', text: 'TypeError: synthetic frame error', at: Date.now() + 1 },
        ]);
      }
      const sent = await f.workspace.send(conversation.id, {
        ...input,
        mode,
        runtimeId: 'mock',
        content: `Synthetic ${kind} ${mode} request`,
      });
      assert.equal((await finished(f.workspace, sent.workflow.id)).status, 'completed');
    }
  assert.equal(calls.length, 4);
  assert.equal(calls.filter((ctx) => ctx.input.prompt.includes(`${modDebugMarker} since=`)).length, 2);
  for (const ctx of calls) {
    assert.ok(ctx.input.prompt.includes(workModeMarker), 'the run prompt carries the block');
    for (const marker of markers) {
      assert.ok(!ctx.input.routingPrompt?.includes(marker), 'routingPrompt');
      assert.ok(!ctx.input.taskRoutingPrompt?.includes(marker), 'taskRoutingPrompt');
      assert.ok(!ctx.input.userInput?.includes(marker), 'userInput');
    }
  }
  assert.deepEqual(await f.workspace.flushLocalMemory(), []);

  const written = files(f.directory);
  assert.ok(
    written.some((path) => path.endsWith('history.jsonl')),
    'local memory was exported',
  );
  assert.ok(
    written.some((path) => path.endsWith('handoff.md')),
    'handoff notes were exported',
  );
  for (const path of written)
    for (const marker of markers) assert.ok(!readFileSync(path, 'utf8').includes(marker), `${path} has ${marker}`);

  // Messages, Hindsight documents, project rules, memory status and every other record (the memory index is built
  // from messages) stay free of mode text.
  const rows = f.workspace.store.db.prepare('SELECT kind, id, value FROM workspace_records').all() as {
    kind: string;
    id: string;
    value: string;
  }[];
  assert.ok(rows.some((row) => row.kind === 'message'));
  for (const row of rows)
    for (const marker of markers)
      if (!trajectoryKinds.has(row.kind)) assert.ok(!row.value.includes(marker), `${row.kind} ${row.id} has ${marker}`);
});
