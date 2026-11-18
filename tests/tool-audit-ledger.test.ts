import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Store } from '../src/server/store.ts';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { AgentBridge } from '../src/server/agent-bridge.ts';
import { retainRunEvent, retainedRunEventLimit } from '../src/shared/run-events.ts';
import type { RunRecord } from '../src/shared/types.ts';

function record(id = 'fixture'): RunRecord {
  return {
    id,
    prompt: 'Synthetic task',
    projectPath: 'C:/Fixture',
    kind: 'routine',
    status: 'completed',
    route: { runtimeId: 'fixture', model: 'fixture', kind: 'routine', reasons: [], warnings: [] },
    startedAt: '2026-10-08T12:00:00Z',
    events: [],
    eventsDropped: 0,
    auditVersion: 1,
    output: '',
  };
}
function directory() {
  return realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-audit-test-')));
}
function clean(path: string) {
  const absolute = resolve(path);
  assert.ok(absolute.startsWith(realpathSync.native(tmpdir()) + sep));
  assert.ok(absolute.split(sep).at(-1)?.startsWith('pugport-audit-test-'));
  rmSync(absolute, { recursive: true, force: true });
}

test('durable tool archive restores every call after live retention, without archiving private reasoning', () => {
  const path = directory();
  let store = new Store(path);
  try {
    const run = record();
    for (let index = 0; index < retainedRunEventLimit + 40; index++) {
      const event = retainRunEvent(run, {
        at: run.startedAt,
        type: 'tool',
        data: { toolCallId: `call-${index}`, tool: 'read_file', status: 'completed' },
      });
      store.appendRunAuditEvent(run.id, event);
      store.appendRunAuditEvent(run.id, event);
    }
    store.appendRunAuditEvent(run.id, { seq: 5000, at: run.startedAt, type: 'reasoning', text: 'private fixture' });
    store.saveRun(run);
    assert.equal(run.events.length, retainedRunEventLimit);
    store.close();
    store = new Store(path);
    const restored = store.run(run.id)!;
    assert.equal(restored.events.length, retainedRunEventLimit + 40);
    assert.equal(restored.events[0]!.data?.toolCallId, 'call-0');
    assert.equal(restored.events.at(-1)!.data?.toolCallId, `call-${retainedRunEventLimit + 39}`);
    assert.ok(!JSON.stringify(restored).includes('private fixture'));
    assert.equal(store.runSummaries()[0]!.events.length, 0);
    assert.equal(store.storedRun(run.id)!.events.length, retainedRunEventLimit);
  } finally {
    store.close();
    clean(path);
  }
});

test('public model turn deltas survive live-window eviction and a database reopen', () => {
  const path = directory();
  let store = new Store(path);
  try {
    const run = record('public-turn-history');
    for (let index = 0; index < retainedRunEventLimit + 10; index++) {
      const event = retainRunEvent(run, { at: run.startedAt, type: 'text', text: `PUBLIC-TURN-${index}` });
      store.appendRunAuditEvent(run.id, event);
    }
    store.appendRunAuditEvent(run.id, {
      seq: 2000,
      at: run.startedAt,
      type: 'reasoning',
      text: 'PRIVATE-NATIVE-REASONING',
    });
    store.saveRun(run);
    store.close();
    store = new Store(path);
    const restored = store.run(run.id)!;
    assert.equal(restored.events.length, retainedRunEventLimit + 10);
    assert.equal(restored.events[0]?.text, 'PUBLIC-TURN-0');
    assert.equal(restored.events.at(-1)?.text, `PUBLIC-TURN-${retainedRunEventLimit + 9}`);
    assert.equal(store.storedRun(run.id)?.events.length, retainedRunEventLimit);
    assert.ok(!JSON.stringify(restored).includes('PRIVATE-NATIVE-REASONING'));
  } finally {
    store.close();
    clean(path);
  }
});

test('bridge captures real input, output, internal stages and rejected calls with unique lifecycle IDs', async (t) => {
  const path = directory();
  const controller = new Controller(path, join(path, 'data'), { readAccountIdentity: () => undefined });
  clearInterval(controller.timer);
  const workspace = new Workspace(controller, { autoTick: false });
  const bridge = new AgentBridge(workspace, controller, path);
  const run = { ...record(), projectPath: path };
  controller.store.saveRun(run);
  const abort = new AbortController();
  t.mock.method(controller, 'agentBridgeCaller', () => ({
    run,
    target: { id: 'fixture', provider: 'codex', label: 'Fixture' },
    delegate: true,
    recycle: false,
    child: false,
    write: false,
    signal: abort.signal,
  }));
  t.mock.method(controller, 'returnExecution', () => async () => {});
  writeFileSync(join(path, 'fixture.txt'), 'ordinary tool result\nTAIL-OF-TOOL-RESULT');
  const call = async (name: string, args: unknown, id: number) =>
    bridge.handle('Bearer fixture', {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    });
  try {
    const result = await call('read_document', { path: join(path, 'fixture.txt'), password: 'secret-fixture' }, 1);
    assert.equal((result.body as any).result.isError, undefined);
    await Promise.all([call('list_agents', {}, 2), call('list_agents', {}, 2)]);
    const denied = await call('organize_files', { moves: [] }, 3);
    assert.equal((denied.body as any).result.isError, true);
    const saved = controller.store.run(run.id)!;
    const tools = saved.events.filter((event) => event.type === 'tool');
    assert.equal(tools.length, 8);
    const ids = new Set(tools.map((event) => event.data?.toolCallId));
    assert.equal(ids.size, 4);
    for (const id of ids) {
      const pair = tools.filter((event) => event.data?.toolCallId === id);
      assert.equal(pair.length, 2);
      assert.equal(pair[0]!.data?.status, 'inProgress');
      assert.ok(['completed', 'failed'].includes(String(pair[1]!.data?.status)));
    }
    assert.ok(saved.events.some((event) => event.data?.kind === 'internal-step' && event.data?.parentToolCallId));
    assert.ok(JSON.stringify(saved).includes('TAIL-OF-TOOL-RESULT'));
    assert.ok(!JSON.stringify(saved).includes('secret-fixture'));
    assert.equal(saved.status, 'completed');
  } finally {
    await workspace.close();
    await controller.close();
    clean(path);
  }
});

test('background audit is persisted on its original finished run without changing the run outcome', async () => {
  const path = directory();
  const controller = new Controller(path, join(path, 'data'), { readAccountIdentity: () => undefined });
  clearInterval(controller.timer);
  try {
    const owner = record('original-run'),
      successor = record('later-run');
    for (let index = 0; index < retainedRunEventLimit + 2; index++) {
      const event = retainRunEvent(owner, { at: owner.startedAt, type: 'tool', data: { toolCallId: `old-${index}` } });
      controller.store.appendRunAuditEvent(owner.id, event);
    }
    controller.store.saveRun(owner);
    controller.store.saveRun(successor);
    controller.recordRunEvent(owner.id, {
      at: owner.startedAt,
      type: 'status',
      text: 'Synthetic background progress',
      data: { source: 'pugport', kind: 'internal-step', detail: { jobId: 'job-fixture', done: 3 } },
    });
    assert.equal(controller.store.run(owner.id)!.events.length, retainedRunEventLimit + 3);
    assert.equal(controller.store.storedRun(owner.id)!.eventsDropped, 3);
    assert.equal(controller.store.run(successor.id)!.events.length, 0);
    assert.equal(controller.store.run(owner.id)!.status, 'completed');
  } finally {
    await controller.close();
    clean(path);
  }
});

test('explicit active-run inspection merges archive and current state without expanding the live dispatch window', async () => {
  const path = directory();
  const controller = new Controller(path, join(path, 'data'), { readAccountIdentity: () => undefined });
  clearInterval(controller.timer);
  const active = (controller as any).active as Map<string, { run: RunRecord }>;
  try {
    const live = { ...record('active-fixture'), status: 'running' as const, output: 'Newest in-memory output' };
    controller.store.saveRun({ ...live, status: 'completed', output: 'Saved older output' });
    controller.store.appendRunAuditEvent(live.id, {
      seq: 1,
      at: live.startedAt,
      type: 'tool',
      data: { toolCallId: 'older-call' },
    });
    live.events = [{ seq: 2, at: live.startedAt, type: 'tool', data: { toolCallId: 'latest-call' } }];
    active.set(live.id, { run: live });
    const inspected = controller.runWithAudit(live.id)!;
    assert.equal(inspected.output, live.output);
    assert.equal(inspected.status, 'running');
    assert.equal(inspected.events.length, 2);
    assert.equal(live.events.length, 1);
  } finally {
    active.clear();
    await controller.close();
    clean(path);
  }
});
