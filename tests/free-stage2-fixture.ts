import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import type { RuntimeSnapshot, Workflow } from '../src/shared/types.ts';
import { free, paid } from './save-money-fixture.ts';

export async function freeStage2Fixture(t: TestContext) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'free-stage2-')));
  const previous = process.env.COMBORUNNER_MEMORY_DIR;
  process.env.COMBORUNNER_MEMORY_DIR = join(dir, 'memory');
  const controller = new Controller(dir, join(dir, 'data'), { readAccountIdentity: () => 'synthetic' });
  clearInterval(controller.timer);
  controller.settings.decisionMode = 'auto';
  controller.settings.routeGoal = 'save';
  const now = Date.now();
  const sources: RuntimeSnapshot[] = [
    free,
    { ...free, id: 'hosted', apiProvider: 'groq-free', local: false, mayLog: true },
    paid,
  ];
  controller.targets = sources.map((s) => ({
    id: s.id,
    provider: s.provider,
    label: s.id,
    command: 'never-executed',
    environment: 'native',
    enabled: true,
    gateway: s.gateway,
    apiProvider: s.apiProvider,
  }));
  controller.snapshots = sources.map((s) => ({
    ...s,
    refreshedAt: new Date(now).toISOString(),
    quota: {
      ...s.quota,
      observedAt: new Date(now).toISOString(),
      windows: s.quota.windows.map((w) => ({ ...w, resetsAt: new Date(now + 3600000).toISOString() })),
    },
  }));
  t.mock.method(controller, 'refresh', async () => {});
  const workspace = new Workspace(controller, {
    autoTick: false,
    retrieveMemory: async () => ({ context: 'PRIVATE_RETRIEVED_MEMORY', excerpts: [], paths: [], elapsedMs: 0 }),
  });
  t.after(async () => {
    await workspace.close();
    await controller.close();
    if (previous === undefined) delete process.env.COMBORUNNER_MEMORY_DIR;
    else process.env.COMBORUNNER_MEMORY_DIR = previous;
    const absolute = resolve(dir);
    assert.ok(
      absolute.startsWith(realpathSync.native(tmpdir()) + sep) && basename(absolute).startsWith('free-stage2-'),
    );
    rmSync(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const folder = join(dir, 'project');
  mkdirSync(folder);
  const project = await workspace.createProject(folder);
  project.rules = ['PRIVATE_PROJECT_RULE'];
  workspace.store.save('project', project.id, '', project);
  const conversation = workspace.createConversation(project.id);
  const finish = async (id: string) => {
    for (let i = 0; i < 1000; i++) {
      await workspace.tickQueue();
      const workflow = workspace.store.get<Workflow>('workflow', id)!;
      if (['completed', 'blocked', 'cancelled', 'failed'].includes(workflow.status)) return workflow;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('fixture did not finish');
  };
  return { controller, workspace, dir, project, conversation, finish };
}
