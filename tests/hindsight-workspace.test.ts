import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import express from 'express';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { hindsightRoutes } from '../src/server/hindsight-routes.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { defaultHindsightSettings } from '../src/shared/hindsight.ts';
import type { ExecuteContext, RuntimeSnapshot, Workflow } from '../src/shared/types.ts';
import { finished, result } from './helpers/session-workspace.ts';
import { listenForFetch } from './helpers/fetch-port.ts';

test('Hindsight routes are wired behind the app mutation guards without starting the app', () => {
  // Inspect wiring only: importing main would start a live app and its background integrations.
  const source = readFileSync(new URL('../src/server/main.ts', import.meta.url), 'utf8');
  const route = source.indexOf('hindsightRoutes(app, workspace);');
  for (const guard of [
    'app.use(localApiGuard(token, allowedHosts, allowedOrigins))',
    "app.use(express.json({ limit: '256kb' }))",
  ])
    assert.ok(source.indexOf(guard) > 0 && source.indexOf(guard) < route);
  assert.match(source, /hindsight: hindsightSettingsSchema\.optional\(\)/);
  assert.match(source, /if \(patch\.hindsight !== undefined\) workspace\.configureHindsight\(\)/);
});

function fixture(t: TestContext) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-hindsight-workspace-')));
  const previousMemory = process.env.COMBORUNNER_MEMORY_DIR;
  process.env.COMBORUNNER_MEMORY_DIR = join(directory, 'memory');
  const controller = new Controller(directory, join(directory, 'data'));
  clearInterval(controller.timer);
  controller.settings.taskJudgment = 'local';
  controller.settings.routineProvider = 'codex';
  controller.targets = [
    { id: 'mock', provider: 'codex', label: 'Synthetic', command: 'unused', environment: 'native', enabled: true },
  ];
  const at = new Date().toISOString();
  controller.snapshots = [
    {
      id: 'mock',
      provider: 'codex',
      label: 'Synthetic',
      environment: 'native',
      installed: true,
      status: 'ready',
      authMode: 'chatgpt',
      accountFingerprint: 'synthetic',
      models: [{ id: 'mock-model', label: 'Mock', efforts: ['medium', 'high'] }],
      quota: {
        status: 'known',
        source: 'fixture',
        observedAt: at,
        windows: [
          { id: 'week', label: 'Week', usedPercent: 10, resetsAt: new Date(Date.now() + 3600000).toISOString() },
        ],
      },
      capabilities: { execute: true, resume: false, cancel: true, approvals: true },
      refreshedAt: at,
    } as RuntimeSnapshot,
  ];
  t.mock.method(controller, 'refresh', async () => {});
  const workspace = new Workspace(controller, {
    autoTick: false,
    memoryDebounceMs: 100000,
    retrieveMemory: async () => ({ context: '', excerpts: [], paths: [], elapsedMs: 0 }),
  });
  let beforeClose = async () => {};
  t.after(async () => {
    await beforeClose();
    await workspace.close();
    await controller.close();
    if (previousMemory === undefined) delete process.env.COMBORUNNER_MEMORY_DIR;
    else process.env.COMBORUNNER_MEMORY_DIR = previousMemory;
    assert.equal(dirname(directory).toLowerCase(), realpathSync.native(tmpdir()).toLowerCase());
    assert.ok(basename(directory).startsWith('pugport-hindsight-workspace-'));
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    controller,
    workspace,
    beforeClose: (work: () => Promise<void>) => {
      beforeClose = work;
    },
  };
}

test('Hindsight HTTP status is read-only and forget revokes the exact project without deleting chats', async (t) => {
  const f = fixture(t);
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const original = f.workspace.store.addMessage(conversation.id, 'user', 'Synthetic original chat stays intact.');
  const storedOriginal = f.workspace.store.get('message', original.id);
  const oldBank = f.workspace.hindsightMemory.bank(project.id);
  const start = t.mock.method(f.workspace.hindsightRuntime, 'start', async () => {
    assert.fail('HTTP status must not start Python');
  });
  const app = express();
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.headers['x-agent-token'] !== 'synthetic') {
      res.sendStatus(403);
      return;
    }
    next();
  });
  app.use(express.json());
  hindsightRoutes(app, f.workspace);
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
    res.sendStatus(400),
  );
  const server = await listenForFetch(app);
  f.beforeClose(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const status = await fetch(`${url}/api/hindsight/status`);
  assert.deepEqual(await status.json(), { state: 'disabled' });
  assert.equal(start.mock.callCount(), 0);
  const forget = (body: unknown, authenticated = true) =>
    fetch(`${url}/api/hindsight/forget`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(authenticated ? { 'x-agent-token': 'synthetic' } : {}) },
      body: JSON.stringify(body),
    });
  assert.equal((await forget({ projectId: project.id }, false)).status, 403);
  assert.equal((await forget({ projectId: project.id, deleteChat: true })).status, 400);
  assert.equal((await forget({ projectId: 'missing' })).status, 404);
  assert.equal(f.workspace.hindsightMemory.bank(project.id), oldBank);
  const removed = await forget({ projectId: project.id });
  assert.deepEqual(await removed.json(), { revoked: true, serviceDeleted: false });
  assert.notEqual(f.workspace.hindsightMemory.bank(project.id), oldBank);
  assert.deepEqual(f.workspace.store.get('message', original.id), storedOriginal);
});

test('applying Hindsight settings never waits for Python startup and only new completed tasks are queued', async (t) => {
  const f = fixture(t);
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  f.workspace.store.setMemory(project.id, 'SYNTHETIC_LOCAL_OWNER_MEMORY');
  const oldUser = f.workspace.store.addMessage(conversation.id, 'user', 'Synthetic old question');
  const oldReply = f.workspace.store.addMessage(conversation.id, 'assistant', 'Synthetic old reply', 'old-workflow');
  f.workspace.store.save('workflow', 'old-workflow', conversation.id, {
    id: 'old-workflow',
    projectId: project.id,
    conversationId: conversation.id,
    userMessageId: oldUser.id,
    finalMessageId: oldReply.id,
    status: 'completed',
    runIds: [],
    input: { content: oldUser.content },
    createdAt: oldUser.createdAt,
    updatedAt: oldReply.createdAt,
  } as unknown as Workflow);
  f.controller.settings.hindsight = {
    ...defaultHindsightSettings,
    enabled: true,
    projectIds: [project.id],
    pythonExecutable: join(f.directory, 'unused-python.exe'),
    runtimeId: 'synthetic-api',
  };
  let release!: () => void;
  let started = false;
  const startup = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(f.workspace.hindsightRuntime, 'start', async () => {
    started = true;
    await startup;
  });
  f.beforeClose(async () => release());
  assert.equal(f.workspace.configureHindsight(), undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, true);
  assert.equal(f.workspace.store.list('hindsight-document').length, 0, 'enabling does not import existing tasks');
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (context: ExecuteContext) => {
    calls.push(context);
    return result('completed', 'Synthetic new final reply.');
  });
  const sent = await f.workspace.send(conversation.id, {
    content: 'Read docs/security.md.',
    mode: 'chat',
    executionPolicy: 'cli-only',
    permissionMode: 'read-only',
    runtimeId: 'mock',
  });
  await f.workspace.tickQueue();
  assert.equal((await finished(f.workspace, sent.workflow.id)).status, 'completed');
  assert.match(calls[0]!.input.prompt, /SYNTHETIC_LOCAL_OWNER_MEMORY/);
  for (let i = 0; i < 30 && !f.workspace.store.list('hindsight-document').length; i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  const documents = f.workspace.store.list<{ workflowId: string; state: string }>('hindsight-document');
  assert.deepEqual(
    documents.map((document) => document.workflowId),
    [sent.workflow.id],
  );
  assert.equal(documents[0]!.state, 'queued');
});

test('disabling interrupts pending startup, rapid changes coalesce and close cannot restart Hindsight', async (t) => {
  const f = fixture(t);
  f.controller.settings.hindsight = { ...defaultHindsightSettings, enabled: true, runtimeId: 'initial' };
  let finishStartup: (() => void) | undefined;
  let finishStop: (() => void) | undefined;
  let stopping: Promise<void> | undefined;
  const starts: string[] = [];
  t.mock.method(f.workspace.hindsightRuntime, 'start', async () => {
    starts.push(f.controller.settings.hindsight!.runtimeId);
    await new Promise<void>((resolve) => {
      finishStartup = resolve;
    });
  });
  const stop = t.mock.method(f.workspace.hindsightRuntime, 'stop', async () => {
    finishStartup?.();
    finishStartup = undefined;
    await stopping;
  });
  f.beforeClose(async () => {
    finishStartup?.();
    finishStop?.();
  });
  assert.equal(f.workspace.configureHindsight(), undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, ['initial']);
  f.controller.settings.hindsight.enabled = false;
  assert.equal(f.workspace.configureHindsight(), undefined);
  assert.equal(stop.mock.callCount(), 2, 'disable signals stop before the old startup has settled');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, ['initial'], 'disabled settings do not restart');

  stopping = new Promise<void>((resolve) => {
    finishStop = resolve;
  });
  for (const runtimeId of ['superseded-one', 'superseded-two', 'latest']) {
    f.controller.settings.hindsight = { ...defaultHindsightSettings, enabled: true, runtimeId };
    assert.equal(f.workspace.configureHindsight(), undefined);
  }
  assert.deepEqual(starts, ['initial'], 'new startup waits for shutdown');
  finishStop!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, ['initial', 'latest'], 'only the latest settings restart after shutdown');
  const previousStops = stop.mock.callCount();
  const closing = f.workspace.close();
  assert.equal(stop.mock.callCount(), previousStops + 1, 'close also interrupts startup immediately');
  await closing;
  f.workspace.configureHindsight();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, ['initial', 'latest'], 'closing prevents any restart');
});

test('a stalled Hindsight recall reaches its deadline and foreground execution keeps local memory', async (t) => {
  const f = fixture(t);
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  f.workspace.store.setMemory(project.id, 'SYNTHETIC_LOCAL_FALLBACK');
  f.controller.settings.hindsight = {
    ...defaultHindsightSettings,
    enabled: true,
    projectIds: [project.id],
    recallTimeoutMs: 200,
  };
  t.mock.method(f.workspace.hindsightRuntime, 'endpoint', () => ({
    baseUrl: 'http://synthetic.invalid',
    token: 'synthetic',
  }));
  let recallSignal: AbortSignal | undefined;
  const transport = t.mock.method(globalThis, 'fetch', (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assert.equal(
      url,
      `http://synthetic.invalid/v1/default/banks/${f.workspace.hindsightMemory.bank(project.id)}/memories/recall`,
    );
    recallSignal = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  });
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (context: ExecuteContext) => {
    calls.push(context);
    return result('completed', 'Synthetic fallback reply.');
  });
  const sent = await f.workspace.send(conversation.id, {
    content: 'Read docs/security.md.',
    mode: 'chat',
    executionPolicy: 'cli-only',
    permissionMode: 'read-only',
    runtimeId: 'mock',
  });
  await f.workspace.tickQueue();
  assert.equal((await finished(f.workspace, sent.workflow.id)).status, 'completed');
  assert.equal(transport.mock.callCount(), 1);
  assert.equal(recallSignal?.aborted, true);
  assert.match(calls[0]!.input.prompt, /SYNTHETIC_LOCAL_FALLBACK/);
  const audits = f.workspace.store.list<{ operation: string; status: string; reason?: string }>(
    'hindsight-audit',
    sent.workflow.id,
  );
  assert.ok(
    audits.some(
      (item) => item.operation === 'recall' && item.status === 'fallback' && item.reason === 'service-timeout',
    ),
  );
});
