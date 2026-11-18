import { freeStage2Fixture } from './free-stage2-fixture.ts';
import { piAdapter } from '../src/server/adapters/pi.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import type { ExecuteContext } from '../src/shared/types.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Controller } from '../src/server/controller.ts';
import { route } from '../src/server/routing.ts';
import type { RunInput, RunRecord } from '../src/shared/types.ts';
import { now, settings, input, free, paid } from './save-money-fixture.ts';

function fixture() {
  const sources = [free, { ...free, id: 'second' }, { ...free, id: 'third' }, paid];
  const controller = Object.assign(Object.create(Controller.prototype), {
    targets: sources.map((s) => ({ ...s, enabled: true, command: 'never' })),
    store: { run: () => undefined },
    settings: { ...settings, routeGoal: 'save' },
    preview: (next: RunInput) => route(next, sources, { ...settings, routeGoal: 'save' }, new Set(), now),
  }) as Controller;
  const request = { ...input };
  const failed = (id = free.id): RunRecord => ({
    id,
    prompt: 'hello',
    projectPath: 'fixture',
    kind: 'routine',
    status: 'failed',
    route: route({ ...request, runtimeId: id }, sources, settings, new Set(), now),
    startedAt: '',
    output: '',
    events: [],
    errorCode: 'quota-or-rate-limit',
  });
  return { controller, request, failed };
}
test('429 hops once to the next free source, then normal routing even if a third is ready', () => {
  const { controller, request, failed } = fixture();
  const first = controller.freeRelay(request, failed())!;
  assert.equal(first.input.freeRelayCount, 1);
  assert.equal(first.notice, undefined);
  assert.equal(controller.preview(first.input).runtimeId, 'second');
  const fallback = controller.freeRelay(first.input, failed('second'))!;
  assert.equal(fallback.input.freeRelayCount, 2);
  assert.equal(controller.preview(fallback.input).runtimeId, paid.id);
  assert.equal(fallback.notice, '免费模型暂不可用（限流），这条改用正常路由。');
  assert.equal(controller.freeRelay(fallback.input, failed()), undefined);
});
test('exhausted sources and an empty content-policy refusal go straight to normal', () => {
  const { controller, request, failed } = fixture();
  assert.equal(
    controller.freeRelay({ ...request, excludeRuntimeIds: ['second', 'third'] }, failed())!.input.freeRelayCount,
    2,
  );
  const refusal = { ...failed(), error: 'content_policy_violation', errorCode: 'runtime-request-failed' };
  assert.equal(controller.freeRelay(request, refusal)!.input.freeRelayCount, 2);
});
test('streamed output, tools, explicit pins and unsafe failures are never relayed', () => {
  const { controller, request, failed } = fixture();
  for (const patch of [
    { output: 'partial answer' },
    { output: ' ' },
    { events: [{ at: '', type: 'text', text: 'already shown' }] },
    { hadToolActivity: true },
    { errorCode: 'runtime-permission-or-sandbox-error' },
  ] as Partial<RunRecord>[])
    assert.equal(controller.freeRelay(request, { ...failed(), ...patch }), undefined);
  assert.equal(controller.freeRelay({ ...request, runtimeId: free.id }, failed()), undefined);
});

test('a complete refusal returned before any streaming goes directly to normal routing', () => {
  const { controller, request, failed } = fixture();
  const refusal = {
    ...failed(),
    status: 'completed' as const,
    output: 'I cannot help with this content policy request.',
    errorCode: undefined,
  };
  assert.equal(controller.freeRelay(request, refusal)!.input.freeRelayCount, 2);
  assert.equal(
    controller.freeRelay(request, { ...refusal, events: [{ at: '', type: 'text', text: refusal.output }] }),
    undefined,
  );
});

test('workflow tries two free sources then normal routing, with one persisted notice', async (t) => {
  const f = await freeStage2Fixture(t);
  const calls: ExecuteContext[] = [];
  t.mock.method(piAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    throw Error('quota-or-rate-limit');
  });
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    return { output: 'Normal answer' };
  });
  const workflow = await f.finish(
    (
      await f.workspace.send(f.conversation.id, {
        content: 'Say hello',
        mode: 'chat',
        permissionMode: 'read-only',
        executionPolicy: 'cli-first',
      })
    ).workflow.id,
  );
  assert.equal(workflow.status, 'completed');
  assert.deepEqual(
    calls.map((ctx) => ctx.target.id),
    ['api-ollama', 'hosted', 'codex'],
  );
  assert.equal(calls[2]!.input.freeRelayCount, 2);
  assert.equal(calls[2]!.input.textOnly, undefined);
  assert.notEqual(calls[2]!.input.prompt, calls[1]!.input.prompt);
  const notices = f.workspace.store
    .messages(f.conversation.id)
    .filter((message) => message.systemNotice?.text === '免费模型暂不可用（限流），这条改用正常路由。');
  assert.equal(notices.length, 1);
  assert.equal(workflow.freeFallbackNotice, true);
});

test('normal fallback is attempted once and does not restart another relay chain', async (t) => {
  const f = await freeStage2Fixture(t);
  const calls: string[] = [];
  t.mock.method(piAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx.target.id);
    throw Error('quota-or-rate-limit');
  });
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx.target.id);
    throw Error('runtime-network-error');
  });
  let normalRelays = 0;
  t.mock.method(f.controller, 'accountRelay', () => {
    normalRelays++;
    return undefined;
  });
  t.mock.method(f.controller, 'technicalRelay', () => {
    normalRelays++;
    return undefined;
  });
  const workflow = await f.finish(
    (
      await f.workspace.send(f.conversation.id, {
        content: 'Say hello',
        mode: 'chat',
        permissionMode: 'read-only',
        executionPolicy: 'cli-first',
      })
    ).workflow.id,
  );
  assert.notEqual(workflow.status, 'completed');
  assert.deepEqual(calls, ['api-ollama', 'hosted', 'codex']);
  assert.equal(normalRelays, 0);
  assert.equal(
    f.workspace.store
      .messages(f.conversation.id)
      .filter((m) => m.systemNotice?.text === '免费模型暂不可用（限流），这条改用正常路由。').length,
    1,
  );
});
