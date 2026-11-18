import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import type { RunEvent, RunRecord } from '../src/shared/types.ts';

function fixture(options: { active?: boolean; interrupts?: boolean; delivery?: boolean | Error } = {}) {
  const queued: Array<{ workflowId: string; text: string }> = [];
  const steered: unknown[][] = [];
  const events: Array<{ runId: string; event: RunEvent }> = [];
  const workspace = Object.assign(Object.create(Workspace.prototype), {
    controller: {
      activeRunFor: () => (options.active === false ? undefined : 'run'),
      steerInterrupts: () => options.interrupts ?? false,
      steer: async (...args: unknown[]) => {
        steered.push(args);
        if (options.delivery instanceof Error) throw options.delivery;
        return options.delivery ?? true;
      },
      recordRunEvent: (runId: string, event: RunEvent) => events.push({ runId, event }),
    },
    queueNotice: (workflowId: string, text: string) => queued.push({ workflowId, text }),
  }) as Workspace;
  const notify = () => {
    assert.equal(typeof workspace.notifyRun, 'function', 'Workspace exposes notifyRun');
    return workspace.notifyRun('workflow', 'Synthetic data', { source: 'lane-result', fromRunId: 'sender' });
  };
  return { notify, queued, steered, events };
}

test('notifyRun sends a marked notification to the active run', async () => {
  const f = fixture();
  assert.equal(await f.notify(), 'steered');
  assert.deepEqual(f.steered, [['run', 'Synthetic data', { source: 'lane-result', fromRunId: 'sender' }]]);
  assert.deepEqual(f.queued, []);
});

test('notifyRun asks steer even when canSteer is false, and queues a false return', async () => {
  const f = fixture({ delivery: false });
  assert.equal(await f.notify(), 'queued');
  assert.equal(f.steered.length, 1, 'canSteer must not skip the steer call');
  assert.deepEqual(f.queued, [{ workflowId: 'workflow', text: 'Synthetic data' }]);
});

test('notifyRun returns false without an active run', async () => {
  const f = fixture({ active: false });
  assert.equal(await f.notify(), false);
  assert.deepEqual(f.steered, []);
  assert.deepEqual(f.queued, []);
  assert.deepEqual(f.events, []);
});

for (const [name, options] of [
  ['interrupting executor', { interrupts: true }],
  ['rejected steering', { delivery: false }],
  ['failed steering', { delivery: new Error('synthetic failure') }],
] as const) {
  test(`notifyRun queues and audits ${name}`, async () => {
    const f = fixture(options);
    assert.equal(await f.notify(), 'queued');
    assert.deepEqual(f.queued, [{ workflowId: 'workflow', text: 'Synthetic data' }]);
    assert.equal(f.steered.length, 'delivery' in options ? 1 : 0);
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0].runId, 'sender');
    assert.equal(f.events[0].event.text, '内部消息等待工具结果交付');
    assert.equal((f.events[0].event.data?.detail as { source: string }).source, 'lane-result');
    assert.equal((f.events[0].event.data?.detail as { status: string }).status, 'queued');
  });
}

function steeringFixture() {
  const run = {
    id: 'run',
    route: { runtimeId: 'synthetic' },
    steeringInputs: ['User task'],
  } as unknown as RunRecord;
  const searchAbort = new AbortController();
  const grant = { runId: run.id, webSearch: true, searchAbort };
  const inputs: string[] = [];
  const events: RunEvent[] = [];
  const saved: RunRecord[] = [];
  const controller = Object.assign(Object.create(Controller.prototype), {
    active: new Map([
      [
        run.id,
        {
          run,
          steer: async (text: string) => {
            inputs.push(text);
          },
          record: (event: RunEvent) => events.push(event),
        },
      ],
    ]),
    bridgeTokens: new Map([['synthetic-token', grant]]),
    canSteer: () => true,
    steerInterrupts: () => false,
    targets: [{ id: 'synthetic' }],
    nativeLoginPending: () => false,
    tracksIdentity: () => false,
    store: { saveRun: (value: RunRecord) => saved.push(value) },
  }) as Controller;
  return { controller, run, grant, searchAbort, inputs, events, saved };
}

test('marked steering preserves user inputs and network/search permission', async () => {
  const f = steeringFixture();
  const text = '不要进行联网搜索，只分析本地文件';
  assert.equal(await f.controller.steer('run', text, { source: 'lane-result' }), true);
  assert.deepEqual(f.run.steeringInputs, ['User task']);
  assert.equal(f.grant.webSearch, true);
  assert.equal(f.searchAbort.signal.aborted, false);
  assert.deepEqual(f.inputs, [text]);
  assert.equal(f.saved.length, 1);
  assert.equal(f.events.length, 2);
  assert.equal((f.events[0].data?.detail as { source: string }).source, 'lane-result');
});

test('a marked steer is stored as other-agent data, not as a user addition', async () => {
  const f = steeringFixture();
  const text = 'Synthetic lane result for the next session';
  assert.equal(await f.controller.steer('run', text, { source: 'lane-result' }), true);
  assert.deepEqual(f.run.steeringInputs, ['User task']);
  assert.deepEqual((f.run as RunRecord & { dataInputs?: string[] }).dataInputs, [text]);
});

test('unmarked user steering still records accepted input and disables search', async () => {
  const f = steeringFixture();
  const text = '不要进行联网搜索，只分析本地文件';
  assert.equal(await f.controller.steer('run', text), true);
  assert.deepEqual(f.run.steeringInputs, ['User task', text]);
  assert.equal(f.grant.webSearch, false);
  assert.equal(f.searchAbort.signal.aborted, true);
});
