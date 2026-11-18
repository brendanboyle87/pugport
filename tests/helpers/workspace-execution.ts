import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import type { TestContext } from 'node:test';
import { codexAdapter } from '../../src/server/adapters/codex.ts';
import { claudeAdapter } from '../../src/server/adapters/claude.ts';
import { Controller } from '../../src/server/controller.ts';
import { Workspace } from '../../src/server/workspace.ts';
import type { ExecuteContext, RuntimeSnapshot, RuntimeTarget, Workflow } from '../../src/shared/types.ts';

export function fixture(
  t: TestContext,
  behavior: (ctx: ExecuteContext, calls: ExecuteContext[]) => Promise<{ output: string }>,
) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-tool-evidence-')));
  const previousMemory = process.env.COMBORUNNER_MEMORY_DIR;
  process.env.COMBORUNNER_MEMORY_DIR = join(directory, 'memory');
  const controller = new Controller(directory, join(directory, 'data'));
  clearInterval(controller.timer);
  controller.settings.decisionMode = 'auto';
  controller.settings.taskJudgment = 'local';
  controller.targets = (['codex', 'claude'] as const).map((provider) => ({
    id: provider,
    provider,
    label: provider,
    command: 'unused',
    environment: 'native',
    enabled: true,
  }));
  const snapshot = (target: RuntimeTarget): RuntimeSnapshot => ({
    ...target,
    installed: true,
    status: 'ready',
    accountFingerprint: `fixture-${target.id}`,
    models: [{ id: 'fixture-model', label: 'Fixture', efforts: ['low', 'medium', 'high'] }],
    quota: {
      status: 'known',
      source: 'fixture',
      observedAt: new Date().toISOString(),
      windows: [{ id: 'week', label: 'Week', usedPercent: 10, resetsAt: new Date(Date.now() + 3600000).toISOString() }],
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: new Date().toISOString(),
  });
  controller.snapshots = controller.targets.map(snapshot);
  t.mock.method(controller, 'refresh', async () => {});
  t.mock.method(codexAdapter, 'discover', async (target: RuntimeTarget) => snapshot(target));
  t.mock.method(claudeAdapter, 'discover', async (target: RuntimeTarget) => snapshot(target));
  const calls: ExecuteContext[] = [];
  const execute = async (ctx: ExecuteContext) => {
    calls.push(ctx);
    return behavior(ctx, calls);
  };
  t.mock.method(codexAdapter, 'execute', execute);
  t.mock.method(claudeAdapter, 'execute', execute);
  const workspace = new Workspace(controller, { autoTick: false, memoryDebounceMs: 100000 });
  t.after(async () => {
    await workspace.close();
    await controller.close();
    assert.ok(
      directory.startsWith(realpathSync.native(tmpdir()) + sep) &&
        basename(directory).startsWith('pugport-tool-evidence-'),
    );
    rmSync(directory, { recursive: true, force: true });
    if (previousMemory === undefined) delete process.env.COMBORUNNER_MEMORY_DIR;
    else process.env.COMBORUNNER_MEMORY_DIR = previousMemory;
  });
  return { directory, controller, workspace, calls };
}
export const completed = (text = 'Synthetic final result') => ({
  output: `${text}\nCOMBORUNNER_TASK_RESULT: {"status":"completed","summary":"Done"}`,
});
export async function finish(f: ReturnType<typeof fixture>, id: string) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await f.workspace.tickQueue();
    const saved = f.workspace.store.get<Workflow>('workflow', id)!;
    if (['completed', 'blocked', 'cancelled', 'failed'].includes(saved.status)) return saved;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error('Synthetic tool-evidence workflow did not finish');
}
