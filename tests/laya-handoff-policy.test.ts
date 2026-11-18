import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HandoffTracker } from '../src/server/handoff-tracker.ts';
import type { Project, RunRecord, Workflow } from '../src/shared/types.ts';
import type { WorkspaceStore } from '../src/server/workspace-store.ts';

test('host handoff metadata skips every git process when commands are prohibited', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pugport-handoff-policy-'));
  await mkdir(join(root, '.git'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  // The ordinary path proves interception works, without starting an actual git process.
  t.mock.method(childProcess, 'execFile', () => {
    calls++;
    throw new Error('Synthetic git interception');
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const project = { id: 'project', path: root } as Project;
  const store = { get: () => project } as unknown as WorkspaceStore;
  for (const prohibitCommands of [false, true]) {
    calls = 0;
    const workflow = {
      id: 'workflow',
      projectId: project.id,
      input: { permissionMode: 'workspace-write', prohibitCommands },
    } as Workflow;
    const tracker = new HandoffTracker({
      store,
      workflow: () => workflow,
      run: () => undefined,
      toolless: () => false,
      children: () => [],
    });
    try {
      tracker.start(workflow, project);
      await tracker.prepare(workflow, { id: 'run' } as RunRecord, root, new AbortController().signal);
      if (prohibitCommands) {
        assert.equal(calls, 0);
        assert.equal(workflow.handoffBase, undefined);
      } else {
        assert.ok(calls > 0);
        assert.ok(workflow.handoffBase);
      }
    } finally {
      await tracker.close();
    }
  }
});
