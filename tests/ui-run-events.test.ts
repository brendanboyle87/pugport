import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppState, RunRecord } from '../src/shared/types';
import { applyRunUpdate } from '../src/ui/run-events';

const at = '2026-01-01T00:00:00Z';
function initial(): AppState {
  const run: RunRecord = {
    id: 'run',
    prompt: 'Synthetic',
    projectPath: '',
    kind: 'routine',
    status: 'running',
    route: { runtimeId: 'fixture', model: 'model', kind: 'routine', reasons: [], warnings: [] },
    startedAt: at,
    output: '',
    events: [],
    eventsDropped: 0,
  };
  return {
    app: { name: 'Fixture', version: 'test', platform: 'win32', dataDir: '' },
    runs: [run, { ...run, id: 'other' }],
    approvals: [],
    workflows: [],
    targets: [],
    runtimes: [],
    plugins: [],
    refreshing: false,
    settings: {
      refreshSeconds: 60,
      reservePercent: 10,
      maxQuotaAgeSeconds: 60,
      preferCli: true,
      designProvider: 'claude',
      architectureProvider: 'codex',
      routineProvider: 'grok',
      unknownQuotaPolicy: 'manual-only',
      defaultProjectPath: '',
      maxConcurrentRuns: 2,
    },
  };
}

test('run updates keep unrelated references and ignore replayed or unknown events', () => {
  const before = initial();
  const event = { type: 'text' as const, text: 'first', at, seq: 3 };
  const next = applyRunUpdate(before, { runId: 'run', event });
  assert.equal(next.runs[0]!.output, 'first');
  assert.equal(next.runs[0]!.events.length, 1);
  assert.equal(before.runs[0]!.output, '');
  assert.equal(next.runs[1], before.runs[1]);
  assert.equal(next.approvals, before.approvals);
  assert.equal(next.workflows, before.workflows);
  assert.equal(applyRunUpdate(next, { runId: 'run', event }), next);
  assert.equal(applyRunUpdate(next, { runId: 'run', event: { ...event, seq: 2 } }), next);
  assert.equal(applyRunUpdate(next, { runId: 'missing', event }), next);
  const received = { ...next, runs: next.runs.map((run) => ({ ...run, events: [...run.events] })) };
  assert.equal(applyRunUpdate(received, { runId: 'run', event }), received);
});

test('reasoning stays separate, retained history stays bounded, and new text is not lost', () => {
  let state = initial();
  state.runs[0]!.events = Array.from({ length: 1000 }, (_, index) => ({ type: 'text', text: '.', seq: index + 1, at }));
  state = applyRunUpdate(state, { runId: 'run', event: { type: 'reasoning', text: 'private', at, seq: 1001 } });
  assert.equal(state.runs[0]!.reasoning, 'private');
  assert.equal(state.runs[0]!.events.length, 1000);
  assert.equal(state.runs[0]!.output, '');
  state = applyRunUpdate(state, { runId: 'run', event: { type: 'text', text: 'answer', at, seq: 1002 } });
  assert.equal(state.runs[0]!.output, 'answer');
  assert.equal(state.runs[0]!.events.length, 1000);
  assert.equal(state.runs[0]!.events.at(-1)!.seq, 1002);
  assert.equal(state.runs[0]!.eventsDropped, 1);
});

test('session metadata and native steering receipts survive the shared event reducer', () => {
  let state = applyRunUpdate(initial(), {
    runId: 'run',
    event: {
      type: 'session',
      at,
      seq: 1,
      data: { nativeSessionId: 'native', effectiveModel: { model: 'confirmed', effort: 'low', source: 'fixture' } },
    },
  });
  assert.equal(state.runs[0]!.nativeSessionId, 'native');
  assert.equal(state.runs[0]!.effectiveModel?.model, 'confirmed');
  for (const [index, steeringPhase] of ['sending', 'received'].entries()) {
    state = applyRunUpdate(state, {
      runId: 'run',
      event: {
        type: 'status',
        at,
        seq: index + 2,
        data: { steeringId: 'correction', steeringMode: 'append', steeringPhase },
      },
    });
  }
  assert.equal(state.runs[0]!.steeringProgress?.phase, 'received');
});
