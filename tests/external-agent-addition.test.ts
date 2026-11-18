import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { ExternalAgentConfig } from '../src/server/external-agents/config.ts';
import { ExternalAgents } from '../src/server/external-agents/service.ts';
import { externalAgentRoutes } from '../src/server/external-agents/routes.ts';
import { GrokRoutineStore } from '../src/server/external-agents/grok-routine.ts';
import type { WebAgentRequest } from '../src/shared/web-bridge.ts';
import type { ExternalAgentView } from '../src/shared/external-agents.ts';
import { listenForFetch } from './helpers/fetch-port.ts';

const quota = {
  status: 'known' as const,
  source: 'Synthetic quota',
  observedAt: '2026-10-16T12:00:00Z',
  windows: [{ id: 'weekly', label: 'Weekly', usedPercent: 25, resetsAt: null }],
};

function fixture(t: TestContext) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'external-addition-test-')));
  const dataDir = join(directory, 'data');
  const previousMemory = process.env.COMBORUNNER_MEMORY_DIR;
  process.env.COMBORUNNER_MEMORY_DIR = join(directory, 'memory');
  const controller = new Controller(directory, dataDir);
  clearInterval(controller.timer);
  controller.targets = [];
  t.mock.method(controller, 'refresh', async () => {});
  const workspace = new Workspace(controller, { autoTick: false });
  const calls: WebAgentRequest[] = [];
  let sessionReads = 0;
  let now = Date.parse('2026-10-16T12:00:00Z');
  const routineStore = new GrokRoutineStore(join(directory, 'synthetic-routine.json'));
  const agents = new ExternalAgents(workspace, dataDir, {
    autoPoll: false,
    routineStore,
    now: () => now,
    bridge: {
      available: () => true,
      request: async (request) => {
        calls.push(request);
        return { ok: true, quota };
      },
    },
    grokUsage: {
      session: async () => {
        sessionReads++;
        return undefined;
      },
    },
  });
  t.after(async () => {
    agents.close();
    await workspace.close();
    await controller.close();
    if (previousMemory === undefined) delete process.env.COMBORUNNER_MEMORY_DIR;
    else process.env.COMBORUNNER_MEMORY_DIR = previousMemory;
    rmSync(directory, { recursive: true, force: true });
  });
  const saved = () => JSON.parse(readFileSync(agents.config.file, 'utf8'));
  return {
    agents,
    calls,
    dataDir,
    routineStore,
    saved,
    sessionReads: () => sessionReads,
    tick: () => (now += 60_000),
    legacy: (entries: Record<string, unknown>) =>
      writeFileSync(agents.config.file, JSON.stringify({ version: 1, agents: entries })),
  };
}

async function api(t: TestContext, agents: ExternalAgents) {
  const app = express();
  app.use(express.json());
  externalAgentRoutes(app, agents);
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ error: 'Invalid fixture request' });
  });
  const server = await listenForFetch(app);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return async (path: string, body: unknown, method = 'PATCH') =>
    fetch(`http://127.0.0.1:${address.port}/api/external-agents/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
}

test('fresh bots are not added and never start background usage or browser monitoring', async (t) => {
  const f = fixture(t);
  assert.deepEqual(
    f.agents.list().map(({ id, added }) => [id, added]),
    [
      ['grok-bot', false],
      ['muse', false],
    ],
  );
  await f.agents.poll();
  await f.agents.readUsage('grok-bot', true);
  await f.agents.readUsage('muse', true);
  assert.equal(f.calls.length, 0);
  assert.equal(f.sessionReads(), 0);
  assert.equal(f.agents.view('grok-bot').grokDiagnostic, undefined);
  assert.equal(existsSync(f.agents.config.file), false);
});

test('legacy disabled but configured bots and existing routines remain added without being enabled', async (t) => {
  const f = fixture(t);
  f.legacy({
    muse: { enabled: false, url: 'https://fixture.test/muse', riskAcceptedAt: '2026-10-01T00:00:00Z' },
    'grok-bot': { enabled: false, botId: 'existing-bot', usageEnabled: false },
  });
  for (const id of ['muse', 'grok-bot'] as const) {
    assert.equal(f.agents.view(id).added, true);
    assert.equal(f.agents.view(id).enabled, false);
  }
  assert.equal(f.agents.view('grok-bot').botId, 'existing-bot');
  assert.equal(f.saved().agents.muse.added, undefined, 'reading does not migrate or overwrite the saved file');
  f.legacy({});
  await f.routineStore.save('https://api2.cursor.sh/automations/webhook/synthetic', 'synthetic-key');
  assert.equal(f.agents.view('grok-bot').added, true);
  assert.equal(f.agents.view('grok-bot').enabled, false);
  assert.ok(f.agents.view('grok-bot').routine);
});

test('background-only legacy observations and later learned paths do not add a bot', (t) => {
  const f = fixture(t);
  f.legacy({
    muse: { quota, detection: { at: '2026-10-16T12:00:00Z', ok: false, note: 'Synthetic observation' } },
    'grok-bot': { quota, usageDiagnostics: ['Synthetic observation'] },
  });
  for (const id of ['muse', 'grok-bot'] as const) assert.equal(f.agents.view(id).added, false);
  f.agents.config.update('muse', { usageUrl: 'https://fixture.test/learned-usage', quota });
  assert.equal(new ExternalAgentConfig(f.dataDir).agent('muse').added, false);
  assert.equal(f.saved().agents.muse.added, false);
});

test('an explicitly unadded bot cannot restart saved background login or editor usage', async (t) => {
  const f = fixture(t);
  for (const usageSource of ['separate', 'cursor-editor']) {
    f.legacy({ 'grok-bot': { added: false, usageLoginCreated: true, usageEnabled: true, usageSource } });
    await f.agents.poll();
    await f.agents.readUsage('grok-bot', true);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.sessionReads(), 0);
  assert.equal(f.agents.view('grok-bot').added, false);
});

test('normal configuration edits persist addition separately from the enabled switch', (t) => {
  const f = fixture(t);
  f.agents.update('grok-bot', { botId: 'configured-bot', enabled: false });
  f.agents.update('muse', { url: 'https://fixture.test/muse', enabled: false });
  for (const id of ['muse', 'grok-bot'] as const) {
    const persisted = new ExternalAgentConfig(f.dataDir).agent(id);
    assert.equal(persisted.added, true);
    assert.equal(persisted.enabled, false);
    assert.equal(f.agents.view(id).added, true);
  }
  assert.equal(f.calls.length, 0);
});

test('add PATCH enforces Muse risk acceptance and repeat addition preserves settings and consent', async (t) => {
  const f = fixture(t);
  const request = await api(t, f.agents);
  assert.equal((await request('muse', { added: true, enabled: true })).status, 400);
  assert.equal(f.agents.view('muse').added, false);
  assert.equal(existsSync(f.agents.config.file), false);
  const body = {
    added: true,
    enabled: true,
    acceptRisk: true,
    url: 'https://fixture.test/muse',
    usageUrl: 'https://fixture.test/usage',
  };
  const first = await request('muse', body);
  assert.equal(first.status, 200);
  const response = (await first.json()) as { agents: ExternalAgentView[] };
  assert.equal(response.agents.find((agent) => agent.id === 'muse')?.added, true);
  f.agents.config.update('muse', { quota });
  const previous = f.saved();
  f.tick();
  assert.equal((await request('muse', body)).status, 200);
  assert.deepEqual(f.saved(), previous, 'duplicate add preserves quota, configured URLs and original consent');
  assert.equal(f.calls.length, 0, 'adding does not open a website, log in or send a task');
  assert.equal((await request('muse', { added: false })).status, 400, 'removal is not part of the API');
  f.agents.update('muse', { enabled: false });
  assert.equal(f.agents.view('muse').added, true);
  assert.equal(f.agents.view('muse').enabled, false);
});

test('duplicate Grok addition preserves routine, usage snapshot and bot configuration without monitoring', async (t) => {
  const f = fixture(t);
  await f.routineStore.save('https://api2.cursor.sh/automations/webhook/synthetic', 'synthetic-key');
  const body = {
    added: true as const,
    enabled: true,
    botId: 'existing-bot',
    usageSource: 'separate' as const,
    usageEnabled: true,
  };
  f.agents.update('grok-bot', body);
  f.agents.config.update('grok-bot', { usageLoginCreated: true });
  await f.agents.readUsage('grok-bot');
  const before = f.agents.view('grok-bot');
  const persisted = f.saved();
  f.calls.length = 0;
  const request = await api(t, f.agents);
  assert.equal((await request('grok-bot', body)).status, 200);
  assert.deepEqual(f.agents.view('grok-bot'), before);
  assert.deepEqual(f.saved(), persisted);
  assert.equal(f.calls.length, 0);
  assert.equal(f.sessionReads(), 0);
});

test('saving a routine through the existing route persists addition without enabling or submitting it', async (t) => {
  const f = fixture(t);
  const request = await api(t, f.agents);
  const body = { url: 'https://api2.cursor.sh/automations/webhook/synthetic', key: 'synthetic-key' };
  assert.equal((await request('grok-bot/routine', body, 'PUT')).status, 200);
  assert.equal(new ExternalAgentConfig(f.dataDir).agent('grok-bot').added, true);
  assert.equal(f.agents.view('grok-bot').enabled, false);
  assert.ok(f.agents.view('grok-bot').routine);
  assert.equal(f.calls.length, 0);
});

test('explicit legacy Grok usage and successful login/open mark addition without enabling messaging', async (t) => {
  const f = fixture(t);
  await f.agents.readUsage('grok-bot');
  assert.equal(f.agents.view('grok-bot').added, true);
  assert.equal(f.agents.view('grok-bot').enabled, false);
  f.legacy({});
  await f.agents.login('grok-bot');
  assert.equal(new ExternalAgentConfig(f.dataDir).agent('grok-bot').added, true);
  assert.equal(f.agents.view('grok-bot').enabled, false);
  f.legacy({});
  await f.agents.openDesktop('grok-bot');
  assert.equal(new ExternalAgentConfig(f.dataDir).agent('grok-bot').added, true);
  assert.equal(f.agents.view('grok-bot').enabled, false);
  assert.equal(
    f.calls.some((call) => ['send', 'desktop-handoff'].includes(call.action)),
    false,
  );
});
