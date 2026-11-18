import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentBridge } from '../src/server/agent-bridge.ts';
import { parseTaskOutcome, reportTaskOutcome, taskOutcomeInstruction } from '../src/server/task-outcome.ts';
import type { ConversationMessage, WorkflowStep } from '../src/shared/types.ts';
import { canContinueWorkflow } from '../src/ui/queue-utils.ts';
import { openQuestion } from '../src/ui/QuestionCard.tsx';
import { fixture, finish } from './helpers/workspace-execution.ts';

const marker = (status: string) =>
  `Answer kept\nCOMBORUNNER_TASK_RESULT: ${JSON.stringify({ status, summary: 'Marker' })}`;

for (const status of ['completed', 'partial', 'blocked', 'failed', 'dropped', 'missing'] as const) {
  test(`host handles ${status} and preserves the answer`, async (t) => {
    const f = fixture(t, async (ctx) => {
      assert.ok(ctx.agentBridge?.extraTools?.includes('report_outcome'));
      assert.match(ctx.input.prompt, /report_outcome/);
      assert.match(ctx.input.prompt, /调用后直接结束，不要再写任何文字，也不要复述或总结答复/);
      assert.doesNotMatch(ctx.input.prompt, /COMBORUNNER_TASK_RESULT/);
      if (status !== 'missing') {
        const caller = f.controller.agentBridgeCaller(ctx.agentBridge!.token)!;
        const bridge = Object.create(AgentBridge.prototype) as AgentBridge;
        Object.assign(bridge, { controller: f.controller, workspace: f.workspace });
        const rpc = bridge as unknown as { message(caller: unknown, request: unknown): Promise<any> };
        const listed = await rpc.message(caller, { id: 0, method: 'tools/list' });
        assert.ok(listed.result.tools.some((tool: { name: string }) => tool.name === 'report_outcome'));
        const disabled = { ...caller, reportTaskOutcome: false };
        const hidden = await rpc.message(disabled, { id: 0, method: 'tools/list' });
        assert.ok(!hidden.result.tools.some((tool: { name: string }) => tool.name === 'report_outcome'));
        const denied = await rpc.message(disabled, {
          id: 0,
          method: 'tools/call',
          params: { name: 'report_outcome', arguments: { status: 'completed', summary: 'Forged' } },
        });
        assert.equal(denied.result.isError, true);
        const call = (args: unknown) =>
          rpc.message(caller, { id: 1, method: 'tools/call', params: { name: 'report_outcome', arguments: args } });
        // Invalid calls are visible tool errors and cannot erase a valid report.
        for (const args of [
          { status: 'blocked', summary: 'Need input' },
          {
            status: 'blocked',
            summary: 'Need input',
            question: { text: 'Choose?', options: ['1', '2', '3', '4', '5'] },
          },
        ]) {
          const response = await call(args);
          assert.equal(response.result.isError, true);
          assert.match(response.result.content[0].text, /Invalid report_outcome/);
          assert.equal(caller.run.taskOutcome, undefined);
        }
        assert.equal((await call({ status: 'partial', summary: 'Earlier report' })).result.isError, undefined);
        const report = {
          status,
          summary: 'token=synthetic-secret; Done',
          ...(status === 'blocked' ? { question: { text: 'Which input?', options: ['A', 'B', 'C', 'D'] } } : {}),
        };
        const recorded = await call(report);
        assert.equal(recorded.result.isError, undefined);
        // The answer is already shown: a rewrite after the report would appear twice.
        assert.match(recorded.result.content[0].text, /End the turn now: write nothing more, and do not restate/);
        assert.equal((await call({ status: 'blocked', summary: 'Invalid last call' })).result.isError, true);
      }
      return { output: status === 'missing' ? 'Answer kept' : marker('completed') };
    });
    f.controller.agentBridgeUrl = 'http://127.0.0.1:0/mcp';
    const project = await f.workspace.createProject(f.directory);
    const conversation = f.workspace.createConversation(project.id);
    const step: WorkflowStep = {
      id: 'answer',
      title: 'Answer',
      instruction: 'Give an answer.',
      writes: status === 'dropped',
      kind: 'general',
      transport: 'auto',
      dependsOn: [],
      status: 'pending',
      runIds: [],
    };
    const sent = await f.workspace.send(
      conversation.id,
      {
        content: 'Give an answer.',
        mode: 'build',
        permissionMode: 'workspace-write',
        runtimeId: 'codex',
        model: 'fixture-model',
        executionPolicy: 'cli-only',
        autoEscalate: false,
        allowExecutorFallback: false,
      },
      undefined,
      undefined,
      { resumePlan: [step] },
    );
    const done = await finish(f, sent.workflow.id);
    const run = f.controller.run(done.plan[0]!.runIds.at(-1)!)!;
    const message = f.workspace.store.get<ConversationMessage>('message', done.finalMessageId!)!;
    const incomplete = ['partial', 'blocked', 'failed'].includes(status);
    assert.equal(done.status, incomplete ? 'blocked' : 'completed', done.error ?? 'Expected completion');
    assert.equal(run.status, incomplete ? 'failed' : 'completed');
    assert.equal(message.content, 'Answer kept');
    assert.equal(run.taskOutcome?.status, status === 'missing' ? 'unverified' : status);
    assert.equal(run.taskOutcome?.source, status === 'missing' ? 'missing-report' : 'executor-tool');
    assert.ok(!run.taskOutcome?.summary?.includes('synthetic-secret'));
    if (status === 'blocked') {
      assert.equal(openQuestion(done)?.text, 'Which input?');
      assert.deepEqual(done.userQuestion?.options, ['A', 'B', 'C', 'D']);
      f.workspace.answerUserQuestions(conversation.id, 'human-reply');
      assert.equal(openQuestion(f.workspace.store.get('workflow', done.id)), undefined);
    }
    if (status === 'dropped') {
      assert.equal(message.systemNotice?.text, '无需处理：token=[redacted]; Done');
      assert.equal(canContinueWorkflow(done), false);
      assert.equal(done.plan[0]?.status, 'completed');
      assert.equal(done.error, undefined);
    }
    if (status === 'failed') assert.ok(message.systemNotice);
  });
}

test('marker fallback remains anchored and supports new statuses and questions', () => {
  for (const status of ['completed', 'partial', 'failed', 'dropped']) {
    assert.equal(parseTaskOutcome(marker(status)).outcome.status, status);
    assert.equal(parseTaskOutcome(marker(status)).outcome.source, 'executor-report');
  }
  const blocked = parseTaskOutcome(
    'Answer\nCOMBORUNNER_TASK_RESULT: ' +
      JSON.stringify({ status: 'blocked', summary: 'Need input', question: { text: 'Which file?' } }),
  );
  assert.equal(blocked.outcome.question?.text, 'Which file?');
  assert.equal(parseTaskOutcome(marker('completed') + '\nMore prose').outcome.source, 'missing-report');
  assert.match(taskOutcomeInstruction('check'), /COMBORUNNER_TASK_RESULT/);
  assert.doesNotMatch(taskOutcomeInstruction('check', true), /COMBORUNNER_TASK_RESULT/);
});

test('tool validation checks limits and shares summary redaction with marker reports', () => {
  for (const report of [
    { status: 'completed', summary: 'x'.repeat(601) },
    { status: 'blocked', summary: 'Need input', question: { text: 'x'.repeat(501) } },
    { status: 'blocked', summary: 'Need input', question: { text: 'Choose?', options: ['x'.repeat(81)] } },
    { status: 'completed', summary: 'Done', claims: [{ claim: 'Checked', verified: 'yes' }] },
  ])
    assert.throws(() => reportTaskOutcome(report), /Invalid report_outcome/);
  const summary = 'sk-1234567890123456 bearer abc123 token=private password=private';
  const report = { status: 'completed', summary };
  assert.equal(
    reportTaskOutcome(report).summary,
    parseTaskOutcome('COMBORUNNER_TASK_RESULT: ' + JSON.stringify(report)).outcome.summary,
  );
  assert.equal(
    reportTaskOutcome({ status: 'blocked', summary: 'Need input', question: { text: 'Which file?' } }).question
      ?.options,
    undefined,
  );
});

for (const scenario of ['blocked-marker', 'missing-write', 'dropped-step'] as const) {
  test(`fallback host contract: ${scenario}`, async (t) => {
    const f = fixture(t, async (ctx) => {
      assert.equal(ctx.agentBridge, undefined);
      assert.match(ctx.input.prompt, /COMBORUNNER_TASK_RESULT/);
      assert.doesNotMatch(ctx.input.prompt, /report_outcome/);
      if (scenario === 'missing-write') return { output: 'Answer kept' };
      if (scenario === 'dropped-step')
        return { output: marker(ctx.input.stepId === 'answer' ? 'dropped' : 'completed') };
      return {
        output:
          'Answer kept\nCOMBORUNNER_TASK_RESULT: ' +
          JSON.stringify({ status: 'blocked', summary: 'Need input', question: { text: 'Which file?' } }),
      };
    });
    const project = await f.workspace.createProject(f.directory);
    const conversation = f.workspace.createConversation(project.id);
    const step: WorkflowStep = {
      id: 'answer',
      title: 'Answer',
      instruction: 'Do the requested work.',
      writes: scenario !== 'blocked-marker',
      kind: 'general',
      transport: 'auto',
      dependsOn: [],
      status: 'pending',
      runIds: [],
    };
    const plan =
      scenario === 'dropped-step' ? [step, { ...step, id: 'review', writes: false, dependsOn: ['answer'] }] : [step];
    const sent = await f.workspace.send(
      conversation.id,
      {
        content: 'Do the requested work.',
        mode: 'build',
        permissionMode: 'workspace-write',
        runtimeId: 'codex',
        model: 'fixture-model',
        executionPolicy: 'cli-only',
        autoEscalate: false,
        allowExecutorFallback: false,
      },
      undefined,
      undefined,
      { resumePlan: plan },
    );
    const done = await finish(f, sent.workflow.id);
    assert.equal(done.status, scenario === 'dropped-step' ? 'completed' : 'blocked');
    const message = f.workspace.store.get<ConversationMessage>('message', done.finalMessageId!)!;
    assert.equal(message.content, 'Answer kept');
    if (scenario === 'blocked-marker') assert.deepEqual(done.userQuestion?.options, []);
    if (scenario === 'missing-write')
      assert.equal(f.controller.run(done.plan[0]!.runIds.at(-1)!)?.taskOutcome?.source, 'file-receipts');
    if (scenario === 'dropped-step') assert.equal(canContinueWorkflow(done), false);
  });
}
