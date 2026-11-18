import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { claudeAdapter } from '../src/server/adapters/claude.ts';
import { handoffNoteIn } from '../src/shared/handoff-note.ts';
import { withContinuationSuffix } from '../src/server/continuation-input.ts';
import type { ExecuteContext, RunInput } from '../src/shared/types.ts';
import { fixture, finished, input, result } from './helpers/session-workspace.ts';

for (const change of ['none', 'account', 'permissions'] as const)
  test(`A → B → A: ${change}`, async (t) => {
    const f = fixture(t);
    const calls: ExecuteContext[] = [];
    const execute = async (ctx: ExecuteContext) => {
      if (!ctx.input.stepId)
        return {
          output: JSON.stringify({
            steps: [
              {
                id: 'parser',
                title: 'Parser',
                instruction: 'Finish parser',
                kind: 'general',
                transport: 'auto',
                dependsOn: [],
              },
            ],
          }),
        };
      calls.push(ctx);
      return result('completed', 'Synthetic reply.', `session-${ctx.target.id}`);
    };
    t.mock.method(codexAdapter, 'execute', execute);
    t.mock.method(claudeAdapter, 'execute', execute);
    const project = await f.workspace.createProject(f.directory);
    const conversation = f.workspace.createConversation(project.id);
    for (const runtimeId of ['mock', 'other', 'mock']) {
      if (calls.length === 2 && change === 'account') f.controller.snapshots[0]!.accountFingerprint = 'new-account';
      // Let routing select A on the final turn: the latest candidate is B, A is an alternate.
      if (calls.length === 2) f.controller.targets[1]!.enabled = false;
      const sent = await f.workspace.send(conversation.id, {
        ...input,
        runtimeId: calls.length === 2 ? undefined : runtimeId,
        permissionMode: calls.length === 2 && change === 'permissions' ? 'read-only' : 'workspace-write',
      });
      assert.equal((await finished(f.workspace, sent.workflow.id)).status, 'completed');
    }
    assert.deepEqual(
      calls.map((ctx) => ctx.target.id),
      ['mock', 'other', 'mock'],
    );
    assert.equal(calls[2]!.nativeSessionId, change === 'none' ? 'session-mock' : undefined);
    assert.equal(calls[2]!.input.prompt.includes('续接本对话的原生会话'), change === 'none');
    if (change === 'none') {
      assert.ok(calls[2]!.input.prompt.includes('<<<PUGPORT_HANDOFF_DELTA>>>'));
      assert.equal(handoffNoteIn(calls[2]!.input.prompt), undefined);
    }
    if (change !== 'none') assert.ok(calls[2]!.input.prompt.includes('此前对话'));
  });

test('continuation suffix reaches every vendor; clearing preserves the full prompt only', () => {
  const input = {
    prompt: 'full',
    continuationRunId: 'b',
    continuationPrompt: 'compact-b',
    continuationAlternates: [{ runId: 'a', runtimeId: 'a', prompt: 'compact-a' }],
  } as RunInput;
  const suffixed = withContinuationSuffix(input, '\n\nnew evidence');
  assert.equal(suffixed.continuationAlternates![0]!.prompt, 'compact-a\n\nnew evidence');
  const cleared = withContinuationSuffix(suffixed);
  assert.equal(cleared.prompt, 'full\n\nnew evidence');
  assert.equal(cleared.continuationRunId, undefined);
  assert.equal(cleared.continuationPrompt, undefined);
  assert.equal(cleared.continuationAlternates, undefined);
});

for (const sideEffect of ['none', 'new-message', 'output', 'tool', 'approval', 'fails-again'] as const)
  test(`missing native session retries only once without side effects: ${sideEffect}`, async (t) => {
    const f = fixture(t);
    const calls: ExecuteContext[] = [];
    const statuses: string[] = [];
    f.controller.on('run', ({ event }) => {
      if (event.type === 'status') statuses.push(event.text ?? '');
    });
    const technical = t.mock.method(f.controller, 'technicalRelay');
    const other = t.mock.method(claudeAdapter, 'execute', async () => {
      throw new Error('must not switch vendor');
    });
    t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
      calls.push(ctx);
      if (calls.length === 1)
        return result(sideEffect === 'new-message' ? 'completed' : 'blocked', 'Synthetic task paused.', 'session-a');
      if (ctx.nativeSessionId || sideEffect === 'fails-again') {
        if (sideEffect === 'output') ctx.emit({ at: new Date().toISOString(), type: 'text', text: 'Partial work.' });
        if (sideEffect === 'tool' || sideEffect === 'approval')
          ctx.emit({
            at: new Date().toISOString(),
            type: sideEffect,
            data: { toolCallId: 'synthetic-call', status: 'completed' },
          });
        throw new Error('native-session-unavailable');
      }
      return result('completed', 'Finished in fresh session.', 'session-fresh');
    });
    const project = await f.workspace.createProject(f.directory);
    const conversation = f.workspace.createConversation(project.id);
    const sent = await f.workspace.send(conversation.id, { ...input, runtimeId: 'mock', allowExecutorFallback: true });
    const stopped = await finished(f.workspace, sent.workflow.id);
    assert.equal(stopped.status, sideEffect === 'new-message' ? 'completed' : 'blocked');
    technical.mock.resetCalls();
    const continued =
      sideEffect === 'new-message'
        ? await f.workspace.send(conversation.id, { ...input, runtimeId: 'mock', allowExecutorFallback: true })
        : await f.workspace.continue(stopped.id);
    const final = await finished(f.workspace, continued.workflow.id);
    assert.equal(calls[1]!.nativeSessionId, 'session-a');
    const retries = ['none', 'new-message', 'fails-again'].includes(sideEffect);
    assert.equal(calls.length, retries ? 3 : 2);
    if (retries) {
      assert.equal(calls[2]!.target.id, 'mock');
      assert.equal(calls[2]!.route.accountFingerprint, calls[1]!.route.accountFingerprint);
      assert.equal(calls[2]!.nativeSessionId, undefined);
      assert.equal(calls[2]!.input.continuationAlternates, undefined);
      assert.ok(handoffNoteIn(calls[2]!.input.prompt));
      assert.ok(!calls[2]!.input.prompt.includes('续接本对话的原生会话'));
      assert.ok(statuses.includes('原生会话已失效，改用新会话并附完整交接条'));
    }
    assert.equal(final.status, ['none', 'new-message'].includes(sideEffect) ? 'completed' : 'blocked');
    if (!['none', 'new-message'].includes(sideEffect))
      assert.equal(f.controller.store.run(final.runIds.at(-1)!)!.status, 'failed');
    assert.equal(technical.mock.callCount(), 0);
    assert.equal(other.mock.callCount(), 0);
  });

test('returning to A for a continued task appends only a delta, never the full note', async (t) => {
  const f = fixture(t);
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    return result(calls.length === 1 ? 'blocked' : 'completed', 'Synthetic A work.', 'session-a');
  });
  t.mock.method(claudeAdapter, 'execute', async () => result('blocked', 'Synthetic B work.', 'session-b'));
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const a = await f.workspace.send(conversation.id, { ...input, runtimeId: 'mock' });
  await finished(f.workspace, a.workflow.id);
  const b = await f.workspace.send(conversation.id, { ...input, runtimeId: 'other' });
  const stopped = await finished(f.workspace, b.workflow.id);
  const resumed = await f.workspace.continue(stopped.id, undefined, { runtimeId: 'mock' });
  assert.equal((await finished(f.workspace, resumed.workflow.id)).status, 'completed');
  assert.equal(calls[1]!.nativeSessionId, 'session-a');
  assert.equal(handoffNoteIn(calls[1]!.input.prompt), undefined);
  assert.equal(calls[1]!.input.prompt.split('<<<PUGPORT_HANDOFF_DELTA>>>').length, 2);
});
