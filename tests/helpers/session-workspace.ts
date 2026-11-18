import { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { Controller } from '../../src/server/controller.ts';
import { Workspace } from '../../src/server/workspace.ts';
import type { MessageInput, RuntimeSnapshot, Workflow } from '../../src/shared/types.ts';

export const input: MessageInput = {
  content: 'Finish the synthetic parser and keep its public API.',
  mode: 'build',
  permissionMode: 'workspace-write',
  executionPolicy: 'cli-first',
  autoEscalate: true,
};
export function fixture(t: TestContext, resume = true) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-vendor-session-')));
  const oldMemory = process.env.COMBORUNNER_MEMORY_DIR;
  process.env.COMBORUNNER_MEMORY_DIR = join(directory, 'memory');
  const controller = new Controller(directory, join(directory, 'data'));
  clearInterval(controller.timer);
  controller.settings.taskJudgment = 'local';
  controller.settings.laya = { mode: 'rules', shareTraining: false, recordTraining: true };
  controller.settings.routineProvider = 'codex';
  controller.targets = [
    { id: 'mock', provider: 'codex', label: 'Synthetic', command: 'unused', environment: 'native', enabled: true },
    { id: 'other', provider: 'claude', label: 'Other', command: 'unused', environment: 'native', enabled: true },
  ];
  const snapshot = (id: string, provider: 'codex' | 'claude'): RuntimeSnapshot => ({
    id,
    provider,
    label: id,
    environment: 'native',
    installed: true,
    status: 'ready',
    authMode: 'chatgpt',
    accountFingerprint: `synthetic-${id}`,
    models: [{ id: 'mock-model', label: 'Mock', efforts: ['medium', 'high'] }],
    quota: {
      status: 'known',
      source: 'fixture',
      observedAt: new Date().toISOString(),
      windows: [{ id: 'week', label: 'Week', usedPercent: 10, resetsAt: new Date(Date.now() + 3600000).toISOString() }],
    },
    capabilities: { execute: true, resume, cancel: true, approvals: true },
    refreshedAt: new Date().toISOString(),
  });
  controller.snapshots = [snapshot('mock', 'codex'), snapshot('other', 'claude')];
  t.mock.method(controller, 'refresh', async () => {});
  const workspace = new Workspace(controller, { memoryDebounceMs: 100000 });
  t.after(async () => {
    await workspace.close();
    await controller.close();
    if (oldMemory === undefined) delete process.env.COMBORUNNER_MEMORY_DIR;
    else process.env.COMBORUNNER_MEMORY_DIR = oldMemory;
    assert.ok(
      directory.startsWith(realpathSync.native(tmpdir()) + sep) &&
        basename(directory).startsWith('pugport-vendor-session-'),
    );
    rmSync(directory, { recursive: true, force: true });
  });
  return { controller, workspace, directory };
}
export async function finished(workspace: Workspace, id: string) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const flow = workspace.store.get<Workflow>('workflow', id)!;
    if (['completed', 'blocked', 'cancelled', 'failed'].includes(flow.status)) return flow;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error('Synthetic workflow did not finish');
}
export function result(status: 'completed' | 'blocked', summary: string, nativeSessionId = 'synthetic-session') {
  return { nativeSessionId, output: `${summary}\nCOMBORUNNER_TASK_RESULT: ${JSON.stringify({ status, summary })}` };
}
/**
 * Like finished, for turns that delegate: parent and child turns can take far longer on a busy machine, so the
 * deadline only ends a genuine hang (the same 60 s guard multi-agent tests use) and the queue is ticked meanwhile.
 */
export async function settled(workspace: Workspace, id: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await workspace.tickQueue();
    const flow = workspace.store.get<Workflow>('workflow', id)!;
    if (['completed', 'blocked', 'cancelled', 'failed'].includes(flow.status)) return flow;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error('Synthetic workflow did not settle');
}
