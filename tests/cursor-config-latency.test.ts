import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createCursorAdapter, cursorAccountFingerprint } from '../src/server/adapters/cursor.ts';
import type { ExecuteContext } from '../src/shared/types.ts';

type Selection = { model: string; reasoning_effort: string; fast: string };
type Scenario = {
  initial?: Partial<Selection>;
  reset?: { after: keyof Selection; field: keyof Selection; value: string };
  changedFinalIdentity?: boolean;
};

// Only the setup protocol is simulated. The real adapter owns selection, identity checks and prompt ordering.
function fixture(scenario: Scenario = {}) {
  const identity = { isAuthenticated: true, userInfo: { userId: 'synthetic-cursor-user' } };
  const selection: Selection = { model: 'grok-4.7', reasoning_effort: 'medium', fast: 'false', ...scenario.initial };
  const calls: string[] = [];
  const setters: Array<{ id: string; value: string }> = [];
  let statusReads = 0;
  let terminated = false;
  let mode = 'agent';
  const option = (id: string, category: string, currentValue: string, values: string[]) => ({
    id,
    category,
    type: 'select',
    currentValue,
    options: values.map((value) => ({ value })),
  });
  const parameters = () => [
    option('reasoning_effort', 'thought_level', selection.reasoning_effort, ['low', 'medium', 'high']),
    option('fast', 'model_config', selection.fast, ['false', 'true']),
    option('context', 'model_config', '256k', ['128k', '256k']),
  ];
  const configOptions = () => [
    option('model', 'model', selection.model, ['grok-4.7', 'composer-2.5']),
    ...parameters(),
  ];
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  }) as unknown as ChildProcessWithoutNullStreams;
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      const packet = JSON.parse(String(chunk)) as {
        id: number;
        method: string;
        params: { sessionId?: string; modeId?: string; configId?: keyof Selection; value?: string };
      };
      const { method, params } = packet;
      calls.push(method);
      let result: object;
      switch (method) {
        case 'initialize':
          result = { protocolVersion: 1, agentCapabilities: { loadSession: true } };
          break;
        case 'cursor/list_available_models':
          result = { models: [{ value: 'grok-4.7', name: 'Grok', configOptions: parameters() }] };
          break;
        case 'session/new':
        case 'session/load':
          if (method === 'session/load') assert.equal(params.sessionId, 'synthetic-session');
          result = {
            sessionId: 'synthetic-session',
            modes: { currentModeId: mode, availableModes: [{ id: 'agent' }, { id: 'ask' }] },
            configOptions: configOptions(),
          };
          break;
        case 'session/set_mode':
          assert.equal(params.modeId, 'ask');
          mode = params.modeId;
          result = {};
          break;
        case 'session/set_config_option': {
          const id = params.configId!;
          assert.ok(Object.hasOwn(selection, id));
          setters.push({ id, value: params.value! });
          selection[id] = params.value!;
          if (scenario.reset?.after === id) selection[scenario.reset.field] = scenario.reset.value;
          result = { configOptions: configOptions() };
          break;
        }
        case 'session/prompt':
          assert.equal(mode, 'ask', 'read-only mode is enforced before prompting');
          assert.equal(statusReads, 2, 'fresh identity is checked again after setup');
          result = { stopReason: 'end_turn' };
          break;
        default:
          assert.fail(`Unexpected synthetic ACP method: ${method}`);
      }
      child.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: packet.id, result }) + '\n'));
      done();
    },
  });
  const adapter = createCursorAdapter({
    capture: async (_target, args) => {
      assert.deepEqual(args, ['status', '--format', 'json']);
      calls.push('status');
      statusReads++;
      const value =
        scenario.changedFinalIdentity && statusReads === 2
          ? { isAuthenticated: true, userInfo: { userId: 'different-synthetic-user' } }
          : identity;
      return { stdout: JSON.stringify(value), exitCode: 0 };
    },
    spawn: async (_target, args) => {
      assert.deepEqual(args, ['--model', 'grok-4.7', '--mode', 'ask', 'acp']);
      return child;
    },
    targetPath: async (_target, path) => path,
    terminate: async (owned) => {
      assert.equal(owned, child);
      terminated = true;
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    },
    requestTimeoutMs: 1_000,
  });
  const ctx: ExecuteContext = {
    target: {
      id: 'synthetic-cursor',
      provider: 'cursor',
      label: 'Synthetic Cursor',
      command: 'never-spawned',
      environment: 'native',
      enabled: true,
    },
    input: { projectPath: 'synthetic-unused', prompt: 'synthetic', kind: 'routine', permissionMode: 'read-only' },
    route: {
      runtimeId: 'synthetic-cursor',
      model: 'grok-4.7',
      effort: 'medium',
      kind: 'routine',
      reasons: [],
      warnings: [],
      accountFingerprint: cursorAccountFingerprint(identity),
    },
    signal: new AbortController().signal,
    emit: () => {},
    approve: async () => assert.fail('No tools are requested by this synthetic peer'),
  };
  return { adapter, ctx, calls, setters, terminated: () => terminated };
}

for (const resume of [false, true]) {
  test(`Cursor ${resume ? 'loaded' : 'new'} session skips already-confirmed model parameters but enforces mode and identity`, async () => {
    const f = fixture();
    if (resume) f.ctx.nativeSessionId = 'synthetic-session';
    const result = await f.adapter.execute(f.ctx);
    assert.deepEqual(f.setters, []);
    assert.deepEqual(result.effectiveModel, {
      model: 'grok-4.7',
      effort: 'medium',
      parameters: { reasoning_effort: 'medium', fast: 'false', context: '256k' },
      source: 'Cursor ACP confirmed model configuration',
    });
    assert.deepEqual(f.calls, [
      'status',
      'initialize',
      'cursor/list_available_models',
      resume ? 'session/load' : 'session/new',
      'session/set_mode',
      'status',
      'session/prompt',
    ]);
    assert.equal(f.terminated(), true);
  });
}

test('Cursor still sets and confirms every differing model parameter', async () => {
  const f = fixture({ initial: { model: 'composer-2.5', reasoning_effort: 'low', fast: 'true' } });
  const result = await f.adapter.execute(f.ctx);
  assert.deepEqual(f.setters, [
    { id: 'model', value: 'grok-4.7' },
    { id: 'reasoning_effort', value: 'medium' },
    { id: 'fast', value: 'false' },
  ]);
  assert.equal(result.effectiveModel?.effort, 'medium');
  assert.equal(result.effectiveModel?.parameters?.fast, 'false');
  assert.equal(f.calls.at(-1), 'session/prompt');
});

test('Cursor changes only the differing effort while retaining confirmed model and speed', async () => {
  const f = fixture({ initial: { reasoning_effort: 'low' } });
  await f.adapter.execute(f.ctx);
  assert.deepEqual(f.setters, [{ id: 'reasoning_effort', value: 'medium' }]);
});

for (const reset of [
  { after: 'reasoning_effort', field: 'model', value: 'composer-2.5' },
  { after: 'fast', field: 'reasoning_effort', value: 'low' },
] as const) {
  test(`Cursor rejects a later ${reset.after} setter that resets an earlier skipped ${reset.field}`, async () => {
    const f = fixture({ initial: { [reset.after]: reset.after === 'fast' ? 'true' : 'low' }, reset });
    await assert.rejects(f.adapter.execute(f.ctx), /runtime-protocol-incompatible/);
    assert.deepEqual(f.setters, [{ id: reset.after, value: reset.after === 'fast' ? 'false' : 'medium' }]);
    assert.equal(f.calls.includes('session/prompt'), false);
    assert.equal(f.terminated(), true);
  });
}

test('Cursor rejects changed final identity even when every model parameter was already correct', async () => {
  const f = fixture({ changedFinalIdentity: true });
  await assert.rejects(f.adapter.execute(f.ctx), /native-session-identity-changed/);
  assert.deepEqual(f.setters, []);
  assert.equal(f.calls.filter((call) => call === 'status').length, 2);
  assert.equal(f.calls.includes('session/prompt'), false);
  assert.equal(f.terminated(), true);
});
