import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { claudeAdapter } from '../src/server/adapters/claude.ts';
import type { ExecuteContext, Workflow } from '../src/shared/types.ts';
import { fixture, finished, input, result } from './helpers/session-workspace.ts';

const notice = '所选模型 mock-fast 不能用（服务商不允许这个账号使用），改用这张卡的默认模型 mock-model 重试';

function withTwoModels(f: ReturnType<typeof fixture>) {
  f.controller.snapshots[0]!.models = [
    { id: 'mock-model', label: 'Mock', efforts: ['medium', 'high'], catalogDefault: true },
    { id: 'mock-fast', label: 'Mock fast', efforts: ['medium', 'high'] },
  ];
}

for (const later of ['completes', 'refused-again', 'lightweight', 'provider-pin'] as const)
  test(`a refused model retries once on the same card with its default model: ${later}`, async (t) => {
    const f = fixture(t);
    withTwoModels(f);
    if (later === 'lightweight') f.controller.settings.routeGoal = 'save';
    const calls: ExecuteContext[] = [];
    const statuses: string[] = [];
    f.controller.on('run', ({ event }) => {
      if (event.type === 'status') statuses.push(event.text ?? '');
    });
    const technical = t.mock.method(f.controller, 'technicalRelay');
    const other = t.mock.method(claudeAdapter, 'execute', async () => {
      throw new Error('must not switch executor');
    });
    t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
      calls.push(ctx);
      if (ctx.route.model === 'mock-fast' || later === 'refused-again') throw new Error('runtime-model-unavailable');
      return result('completed', 'Finished with the default model.');
    });
    const project = await f.workspace.createProject(f.directory);
    const conversation = f.workspace.createConversation(project.id);
    const sent = await f.workspace.send(conversation.id, {
      ...input,
      ...(later === 'provider-pin' ? { provider: 'codex' as const } : { runtimeId: 'mock' }),
      model: 'mock-fast',
      effort: 'high',
      allowExecutorFallback: true,
    });
    const final = await finished(f.workspace, sent.workflow.id);
    assert.deepEqual(
      calls.map((ctx) => [ctx.target.id, ctx.route.model, ctx.route.effort]),
      [
        ['mock', 'mock-fast', 'high'],
        ['mock', 'mock-model', 'high'],
      ],
    );
    assert.ok(statuses.includes(notice));
    assert.equal(final.status, later === 'refused-again' ? 'blocked' : 'completed');
    // The rest of this task keeps the default model (and the chosen effort it supports) instead of failing again.
    const saved = f.workspace.store.get<Workflow>('workflow', final.id)!;
    assert.equal(saved.input.model, 'mock-model');
    assert.equal(saved.input.effort, 'high');
    // The switch is said in the chat, not only in the run's trajectory.
    const messages = f.workspace.store.messages(conversation.id);
    assert.equal(messages.filter((message) => message.systemNotice?.text === notice).length, 1);
    const firstRun = f.controller.runWithAudit(final.runIds[0]!)!;
    const switched = firstRun.events.find((event) => event.text === notice)!;
    assert.ok(switched.seq, 'model fallback is stored in the numbered audit trail');
    // A second refusal falls through to the usual relay checks, which do not move a model refusal elsewhere.
    if (later === 'completes') assert.equal(technical.mock.callCount(), 0);
    assert.equal(other.mock.callCount(), 0);
  });

for (const reason of ['already-default', 'no-default', 'partial-output', 'tool', 'approval'] as const)
  test(`a refused model is not retried: ${reason}`, async (t) => {
    const f = fixture(t);
    withTwoModels(f);
    if (reason === 'no-default') delete f.controller.snapshots[0]!.models[0]!.catalogDefault;
    const calls: ExecuteContext[] = [];
    t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
      calls.push(ctx);
      if (reason === 'partial-output') ctx.emit({ at: new Date().toISOString(), type: 'text', text: 'Partial work.' });
      if (reason === 'tool' || reason === 'approval')
        ctx.emit({ at: new Date().toISOString(), type: reason, data: { status: 'completed' } });
      throw new Error('runtime-model-unavailable');
    });
    const project = await f.workspace.createProject(f.directory);
    const conversation = f.workspace.createConversation(project.id);
    const sent = await f.workspace.send(conversation.id, {
      ...input,
      runtimeId: 'mock',
      model: reason === 'already-default' ? 'mock-model' : 'mock-fast',
      allowExecutorFallback: true,
    });
    const final = await finished(f.workspace, sent.workflow.id);
    assert.equal(calls.length, 1);
    assert.equal(final.status, 'blocked');
    const run = f.controller.store.run(final.runIds.at(-1)!)!;
    assert.equal(run.errorCode, 'runtime-model-unavailable');
  });

test('confirmation mode keeps the approved model when the provider refuses it', async (t) => {
  const f = fixture(t);
  withTwoModels(f);
  f.controller.settings.decisionMode = 'confirm';
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    throw new Error('runtime-model-unavailable');
  });
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const sent = await f.workspace.send(conversation.id, { ...input, runtimeId: 'mock', model: 'mock-fast' });
  await f.workspace.tickQueue();
  const pending = f.workspace.store.get<Workflow>('workflow', sent.workflow.id)!;
  assert.equal(pending.status, 'waiting-confirmation');
  f.workspace.confirm(pending.id, pending.routingReview!.id);
  const final = await finished(f.workspace, sent.workflow.id);
  assert.equal(final.status, 'blocked');
  assert.deepEqual(
    calls.map((ctx) => ctx.route.model),
    ['mock-fast'],
  );
  assert.equal(
    f.workspace.store.messages(conversation.id).filter((message) => message.systemNotice?.text === notice).length,
    0,
  );
});

test('later fallback attempts keep their audit event but do not repeat the task notice', async (t) => {
  const f = fixture(t);
  withTwoModels(f);
  f.controller.settings.routePreferencesEnabled = true;
  f.controller.settings.designProvider = 'claude';
  for (const snapshot of f.controller.snapshots)
    snapshot.models = [...f.controller.snapshots[0]!.models].sort(
      (a, b) => Number(!!a.catalogDefault) - Number(!!b.catalogDefault),
    );
  const calls: ExecuteContext[] = [];
  const execute = async (ctx: ExecuteContext) => {
    calls.push(ctx);
    if (ctx.route.model === 'mock-fast') throw new Error('runtime-model-unavailable');
    return result('completed', 'Checked the synthetic file.');
  };
  t.mock.method(codexAdapter, 'execute', execute);
  t.mock.method(claudeAdapter, 'execute', execute);
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const steps: Workflow['plan'] = ['one', 'two'].map((id, index) => ({
    id,
    title: id,
    instruction: 'Read the synthetic file and report its content.',
    kind: index ? 'design' : 'routine',
    transport: 'auto',
    dependsOn: index ? ['one'] : [],
    acceptance: 'Report the content.',
    status: 'pending',
    runIds: [],
  }));
  const sent = await f.workspace.send(
    conversation.id,
    {
      ...input,
      permissionMode: 'read-only',
    },
    undefined,
    undefined,
    { resumePlan: steps },
  );
  const final = await finished(f.workspace, sent.workflow.id);
  assert.equal(final.status, 'completed');
  assert.deepEqual(
    calls.map((ctx) => [ctx.route.runtimeId, ctx.route.model]),
    [
      ['mock', 'mock-fast'],
      ['mock', 'mock-model'],
      ['other', 'mock-fast'],
      ['other', 'mock-model'],
    ],
  );
  const messages = f.workspace.store.messages(conversation.id);
  assert.equal(messages.filter((message) => message.systemNotice?.text === notice).length, 1);
  const switches = final.runIds
    .flatMap((id) => f.controller.runWithAudit(id)!.events)
    .filter((event) => event.text === notice);
  assert.equal(switches.length, 2);
  assert.ok(switches.every((event) => event.seq));
});

test('a model refusal at the task attempt limit does not launch a ninth run', async (t) => {
  const f = fixture(t);
  withTwoModels(f);
  let calls = 0;
  t.mock.method(codexAdapter, 'execute', async () => {
    if (++calls === 8) throw new Error('runtime-model-unavailable');
    return result('completed', 'Checked the synthetic file.');
  });
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const steps: Workflow['plan'] = Array.from({ length: 8 }, (_, index) => ({
    id: `step-${index}`,
    title: `Read ${index}`,
    instruction: 'Read the synthetic file and report its content.',
    kind: 'routine',
    transport: 'auto',
    dependsOn: index ? [`step-${index - 1}`] : [],
    acceptance: 'Report the content.',
    status: 'pending',
    runIds: [],
  }));
  const sent = await f.workspace.send(
    conversation.id,
    {
      ...input,
      permissionMode: 'read-only',
      runtimeId: 'mock',
      model: 'mock-fast',
    },
    undefined,
    undefined,
    { resumePlan: steps },
  );
  const final = await finished(f.workspace, sent.workflow.id);
  assert.equal(final.status, 'blocked');
  assert.equal(calls, 8);
  assert.equal(final.runIds.length, 8);
  assert.equal(
    f.workspace.store.messages(conversation.id).filter((message) => message.systemNotice?.text === notice).length,
    0,
  );
});

for (const allowed of [false, true])
  test(`a rule-selected model fallback preserves the strict rule: default allowed=${allowed}`, async (t) => {
    const f = fixture(t);
    withTwoModels(f);
    f.controller.settings.routingRules = {
      version: 2,
      text: '',
      updatedAt: new Date().toISOString(),
      unparsed: [],
      rules: [
        {
          id: 'strict-code',
          category: 'code',
          enabled: true,
          strict: true,
          source: 'manual',
          candidates: [
            { runtimeId: 'mock', model: 'mock-fast', effort: 'high' },
            ...(allowed ? [{ runtimeId: 'mock', model: 'mock-model', effort: 'medium' }] : []),
          ],
        },
      ],
    };
    const calls: ExecuteContext[] = [];
    t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
      calls.push(ctx);
      if (ctx.route.model === 'mock-fast') throw new Error('runtime-model-unavailable');
      return result('completed', 'Finished with the rule-approved default model.');
    });
    t.mock.method(claudeAdapter, 'execute', async () => {
      throw new Error('must not leave the strict rule');
    });
    const project = await f.workspace.createProject(f.directory);
    const conversation = f.workspace.createConversation(project.id);
    const sent = await f.workspace.send(conversation.id, {
      ...input,
      content: 'Explain this TypeScript function.',
      mode: 'chat',
      permissionMode: 'read-only',
      allowExecutorFallback: true,
    });
    const final = await finished(f.workspace, sent.workflow.id);
    assert.equal(calls[0]?.route.routeRule?.id, 'strict-code');
    assert.equal(calls[0]?.route.routeRule?.strict, true);
    assert.equal(final.status, allowed ? 'completed' : 'blocked');
    assert.equal(calls.length, allowed ? 2 : 1);
    if (allowed) {
      assert.equal(calls[1]?.route.model, 'mock-model');
      assert.equal(calls[1]?.route.effort, 'medium');
      assert.equal(calls[1]?.route.routeRule?.id, 'strict-code');
      assert.equal(calls[1]?.route.routeRule?.index, 1);
      assert.doesNotMatch(calls[1]!.route.reasons.join('\n'), /手动选择优先于规则|规则里没有它/);
    } else {
      assert.equal(
        f.workspace.store.messages(conversation.id).some((message) => message.systemNotice?.text === notice),
        false,
      );
    }
  });
