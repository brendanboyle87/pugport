import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { Controller } from '../src/server/controller.ts';
import { memoryConversationPaths } from '../src/server/local-memory.ts';
import { refreshLocalMemory } from '../src/server/local-memory-runtime.ts';
import { LocalMemoryScheduler, type MemoryJob, type MemoryResult } from '../src/server/local-memory-scheduler.ts';
import { Workspace } from '../src/server/workspace.ts';
import type {
  ConversationMessage,
  ExecuteContext,
  MessageInput,
  Project,
  RuntimeSnapshot,
} from '../src/shared/types.ts';
import { appDataEnv } from './helpers/fake-host.ts';
import { finished, result } from './helpers/session-workspace.ts';

const input: MessageInput = {
  content: 'Read docs/synthetic.md.',
  mode: 'chat',
  permissionMode: 'read-only',
  executionPolicy: 'cli-only',
  runtimeId: 'mock',
};

function fixture(t: TestContext, debounceMs = 100000) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-memory-foreground-')));
  const projectPath = join(directory, 'project');
  mkdirSync(projectPath);
  const previousMemory = process.env.COMBORUNNER_MEMORY_DIR;
  process.env.COMBORUNNER_MEMORY_DIR = join(directory, 'memory');
  const controller = new Controller(directory, join(directory, 'data'));
  clearInterval(controller.timer);
  controller.settings.taskJudgment = 'local';
  controller.targets = [
    { id: 'mock', provider: 'codex', label: 'Synthetic', command: 'unused', environment: 'native', enabled: true },
  ];
  const at = new Date().toISOString();
  controller.snapshots = [
    {
      ...controller.targets[0]!,
      installed: true,
      status: 'ready',
      authMode: 'chatgpt',
      accountFingerprint: 'synthetic-account',
      models: [{ id: 'mock-model', label: 'Mock', efforts: ['low', 'medium', 'high'] }],
      quota: {
        status: 'known',
        source: 'fixture',
        observedAt: at,
        windows: [
          { id: 'week', label: 'Week', usedPercent: 10, resetsAt: new Date(Date.now() + 3600000).toISOString() },
        ],
      },
      capabilities: { execute: true, resume: true, cancel: true, approvals: true },
      refreshedAt: at,
    } as RuntimeSnapshot,
  ];
  t.mock.method(controller, 'refresh', async () => {});
  t.mock.method(controller, 'broadcast', () => {});
  const workspace = new Workspace(controller, {
    autoTick: false,
    memoryDebounceMs: debounceMs,
    retrieveMemory: async () => ({ context: '', excerpts: [], paths: [], elapsedMs: 0 }),
  });
  const scheduler = (workspace as unknown as { memoryExports: LocalMemoryScheduler }).memoryExports;
  const jobs: MemoryJob[] = [];
  // Keep the real scheduler and real tiny export, replacing only the worker boundary. No worker/model runs.
  (
    scheduler as unknown as { executor: { execute(job: MemoryJob): Promise<MemoryResult>; close(): Promise<void> } }
  ).executor = {
    async execute(job) {
      jobs.push(job);
      const project = workspace.store.get<Project>('project', job.projectId)!;
      const warnings =
        job.all || !job.conversationIds.length
          ? refreshLocalMemory(workspace.store, project, job.dataDir, job.appRoot)
          : job.conversationIds.flatMap((id) =>
              refreshLocalMemory(workspace.store, project, job.dataDir, job.appRoot, id),
            );
      return { projectId: job.projectId, files: [], warnings };
    },
    async close() {},
  };
  t.after(async () => {
    await workspace.close();
    await controller.close();
    if (previousMemory === undefined) delete process.env.COMBORUNNER_MEMORY_DIR;
    else process.env.COMBORUNNER_MEMORY_DIR = previousMemory;
    assert.equal(dirname(directory).toLowerCase(), realpathSync.native(tmpdir()).toLowerCase());
    assert.ok(basename(directory).startsWith('pugport-memory-foreground-'));
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, projectPath, controller, workspace, scheduler, jobs };
}

async function settle() {
  for (let turn = 0; turn < 15; turn++) await Promise.resolve();
}

test('five foreground sends coalesce into one delayed export and shutdown exports the last pending message', async (t) => {
  const f = fixture(t, 2000);
  const project = await f.workspace.createProject(f.projectPath);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const flush = t.mock.method(f.scheduler, 'flush');
  const conversations = Array.from({ length: 5 }, (_, i) =>
    f.workspace.createConversation(project.id, `Synthetic ${i}`),
  );
  const sent = await Promise.all(
    conversations.map((conversation, i) =>
      f.workspace.send(conversation.id, { ...input, content: `Read docs/synthetic-${i}.md.` }),
    ),
  );
  assert.equal(flush.mock.callCount(), 0, 'foreground sends leave exports on the scheduler debounce');
  assert.equal(f.jobs.length, 0);
  for (const item of sent) assert.deepEqual(f.workspace.store.get('message', item.message.id), item.message);
  t.mock.timers.tick(1999);
  await settle();
  assert.equal(f.jobs.length, 0);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(f.jobs.length, 1);
  assert.deepEqual(new Set(f.jobs[0]!.conversationIds), new Set(conversations.map((c) => c.id)));
  for (const item of sent) {
    const path = memoryConversationPaths(f.controller.dataDir, project.id, item.message.conversationId).historyPath;
    const rows = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as ConversationMessage);
    assert.ok(rows.some((row) => row.id === item.message.id && row.content === item.message.content));
  }
  const last = f.workspace.createConversation(project.id, 'Last pending conversation');
  const pending = await f.workspace.send(last.id, { ...input, content: 'Read docs/shutdown.md.' });
  const lastPath = memoryConversationPaths(f.controller.dataDir, project.id, last.id).historyPath;
  assert.equal(existsSync(lastPath), false);
  await f.workspace.close();
  assert.equal(f.jobs.length, 2, 'close drains the pending batch without advancing debounce time');
  assert.match(readFileSync(lastPath, 'utf8'), /Read docs\/shutdown\.md\./);
  assert.ok(readFileSync(lastPath, 'utf8').includes(pending.message.id));
  t.diagnostic('Five sends: immediate flush calls 0; delayed export batches 1; shutdown drains the final batch.');
});

test('current prompt uses SQLite before any export, and completed replies reach the eventual snapshot', async (t) => {
  const f = fixture(t);
  const project = await f.workspace.createProject(f.projectPath);
  const conversation = f.workspace.createConversation(project.id);
  f.workspace.store.addMessage(conversation.id, 'assistant', 'SQLITE_ONLY_PRIOR_ANSWER');
  f.workspace.store.setMemory(project.id, 'SQLITE_OWNER_NOTE');
  const path = memoryConversationPaths(f.controller.dataDir, project.id, conversation.id).historyPath;
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (context: ExecuteContext) => {
    calls.push(context);
    assert.equal(existsSync(path), false, 'foreground dispatch does not require a filesystem snapshot');
    return result('completed', 'SYNTHETIC_COMPLETED_REPLY');
  });
  const sent = await f.workspace.send(conversation.id, input);
  await f.workspace.tickQueue();
  assert.equal((await finished(f.workspace, sent.workflow.id)).status, 'completed');
  assert.match(calls[0]!.input.prompt, /SQLITE_ONLY_PRIOR_ANSWER/);
  assert.match(calls[0]!.input.prompt, /SQLITE_OWNER_NOTE/);
  assert.match(calls[0]!.input.prompt, /Read docs\/synthetic\.md\./);
  assert.equal(f.jobs.length, 0);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const flushed = f.workspace.flushLocalMemory(project.id);
  t.mock.timers.tick(0);
  await settle();
  assert.deepEqual(await flushed, []);
  assert.equal(f.jobs.length, 1);
  assert.match(readFileSync(path, 'utf8'), /SYNTHETIC_COMPLETED_REPLY/);
});

for (const disabled of ['conversation-memory', 'export'] as const)
  test(`${disabled} disabled skips export path resolution across consecutive turns`, async (t) => {
    const f = fixture(t);
    const project = await f.workspace.createProject(f.projectPath);
    if (disabled === 'export') {
      project.localMemory = { exportEnabled: false, cliEnabled: false };
      f.workspace.store.save('project', project.id, project.id, project);
    }
    const conversation = f.workspace.createConversation(project.id);
    if (disabled === 'conversation-memory') {
      conversation.memory = 'off';
      f.workspace.store.save('conversation', conversation.id, project.id, conversation);
    }
    const calls: ExecuteContext[] = [];
    t.mock.method(codexAdapter, 'execute', async (context: ExecuteContext) => {
      calls.push(context);
      return result('completed', `Synthetic reply ${calls.length}`);
    });
    const appData = appDataEnv(join(f.directory, 'appdata'));
    mkdirSync(appData.memoryAnchor, { recursive: true });
    const previousEnv = Object.fromEntries(Object.keys(appData.env).map((key) => [key, process.env[key]]));
    const previousMemory = process.env.COMBORUNNER_MEMORY_DIR;
    Object.assign(process.env, appData.env);
    delete process.env.COMBORUNNER_MEMORY_DIR;
    const original = fs.lstatSync;
    let pathChecks = 0;
    const probe = t.mock.method(fs, 'lstatSync', (...args: Parameters<typeof fs.lstatSync>) => {
      if (resolve(String(args[0])) === resolve(appData.memoryAnchor)) {
        pathChecks++;
        throw new Error('Disabled memory must not resolve the export root.');
      }
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      for (let index = 0; index < 2; index++) {
        const sent = await f.workspace.send(conversation.id, { ...input, content: `Read docs/turn-${index}.md.` });
        await f.workspace.tickQueue();
        assert.equal((await finished(f.workspace, sent.workflow.id)).status, 'completed');
      }
      assert.equal(calls.length, 2);
      if (disabled === 'export')
        assert.equal(
          calls[1]!.nativeSessionId,
          'synthetic-session',
          'the resumed prompt also exercises continuation memory',
        );
      else assert.equal(calls[1]!.nativeSessionId, undefined, 'memory-off preserves fresh-session privacy');
      assert.equal(pathChecks, 0);
    } finally {
      probe.mock.restore();
      syncBuiltinESMExports();
      if (previousMemory === undefined) delete process.env.COMBORUNNER_MEMORY_DIR;
      else process.env.COMBORUNNER_MEMORY_DIR = previousMemory;
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
