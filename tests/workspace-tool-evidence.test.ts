import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { hostGit } from '../src/server/managed-worktrees.ts';
import type { ExecuteContext, MessageInput, WorkflowStep } from '../src/shared/types.ts';
import { fixture, completed, finish } from './helpers/workspace-execution.ts';

const input: MessageInput = {
  content: 'Extract the synthetic packages, then verify the synthetic outputs and recycle only confirmed copies.',
  mode: 'build',
  permissionMode: 'workspace-write',
  executionPolicy: 'cli-only',
  runtimeId: 'codex',
  model: 'fixture-model',
  effort: 'high',
  autoEscalate: false,
  allowExecutorFallback: false,
};
const plan = (): WorkflowStep[] => [
  {
    id: 'first',
    title: 'Extract fixture',
    instruction: 'Complete synthetic first step.',
    kind: 'routine',
    transport: 'auto',
    dependsOn: [],
    status: 'pending',
    runIds: [],
    acceptance: 'Report captured integrity and recycle receipts.',
  },
  {
    id: 'second',
    title: 'Verify fixture',
    instruction: 'Verify the synthetic outputs without repeating completed mutations.',
    kind: 'routine',
    transport: 'auto',
    dependsOn: ['first'],
    status: 'pending',
    runIds: [],
    acceptance: 'Report actual verified result.',
  },
];
function receipt(ctx: ExecuteContext) {
  const emit = (data: Record<string, unknown>, type: 'tool' | 'status' = 'tool') =>
    ctx.emit({ at: new Date().toISOString(), type, data });
  emit({
    source: 'native',
    kind: 'commandExecution',
    itemId: 'failed-search',
    status: 'failed',
    exitCode: 1,
    output: 'Synthetic earlier failed search',
  });
  emit({
    source: 'native',
    kind: 'commandExecution',
    itemId: 'test-packages',
    status: 'completed',
    exitCode: 0,
    input: { command: 'synthetic7za t' },
    output: 'Everything is Ok\nFiles: 21\nSize: 892962763',
  });
  emit({
    source: 'pugport',
    hostAudit: true,
    kind: 'pugportToolCall',
    toolCallId: 'bridge:synthetic-recycle',
    tool: 'recycle_files',
    status: 'running',
    arguments: { paths: ['synthetic.001', 'synthetic.002'] },
  });
  emit(
    {
      source: 'pugport',
      hostAudit: true,
      kind: 'internal-step',
      parentToolCallId: 'bridge:synthetic-recycle',
      status: 'completed',
      detail: {
        status: 'completed',
        detail: { moved: ['synthetic.001', 'synthetic.002'], failed: [], skipped: ['retained-fixture'] },
      },
    },
    'status',
  );
  emit({
    source: 'pugport',
    hostAudit: true,
    kind: 'pugportToolCall',
    toolCallId: 'bridge:synthetic-recycle',
    tool: 'recycle_files',
    status: 'completed',
    result: { moved: ['synthetic.001', 'synthetic.002'], failed: [], skipped: ['retained-fixture'] },
  });
  emit({
    source: 'native',
    kind: 'mcpToolCall',
    server: 'pugport',
    tool: 'recycle_files',
    toolCallId: 'native-recycle',
    status: 'completed',
    output: 'Moved synthetic volumes.',
  });
}
async function submit(f: ReturnType<typeof fixture>, overrides: Partial<MessageInput> = {}) {
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  return f.workspace.send(conversation.id, { ...input, ...overrides }, undefined, undefined, { resumePlan: plan() });
}

test('declared inspection steps advance while explicit write tasks still require evidence', async (t) => {
  for (const last of ['write', 'no-change', 'summary', 'unmeasured'])
    await t.test(last, async (t) => {
      const f = fixture(t, async (ctx) => {
        if (ctx.input.stepId === 'first') {
          assert.equal(ctx.input.requiresFileChanges, false);
          return completed('Inspected the worktree and test style.');
        }
        if (last === 'write') {
          writeFileSync(join(f.directory, 'feature.txt'), 'synthetic implementation');
          ctx.emit({
            at: '',
            type: 'tool',
            data: {
              itemId: 'write-feature',
              tool: 'Write',
              status: 'completed',
              input: { file_path: 'feature.txt' },
            },
          });
        }
        return completed(last === 'write' ? 'Updated feature.txt.' : 'Inspection finished.');
      });
      if (last !== 'unmeasured') {
        await hostGit(f.directory, ['init']);
        writeFileSync(join(f.directory, '.gitignore'), 'data/\nmemory/\n');
      }
      const project = await f.workspace.createProject(f.directory);
      const conversation = f.workspace.createConversation(project.id);
      const steps = plan();
      steps[0]!.writes = false;
      steps[1]!.writes = last === 'summary' ? false : true;
      steps[0]!.instruction = 'Implement the feature: first inspect the worktree, rule order and test style.';
      steps[1]!.instruction = last === 'summary' ? 'Summarize the inspection findings.' : 'Implement feature.txt.';
      const sent = await f.workspace.send(
        conversation.id,
        { ...input, content: 'Implement feature.txt.', expectsFileChanges: true },
        undefined,
        undefined,
        { resumePlan: steps },
      );
      const done = await finish(f, sent.workflow.id);
      const firstRun = f.controller.store.run(done.plan[0]!.runIds[0]!)!;
      if (last === 'unmeasured') {
        assert.equal(firstRun.measuredFileChanges, undefined);
      } else assert.deepEqual(firstRun.measuredFileChanges, { source: 'pugport-scope-snapshot', paths: [] });
      assert.equal(done.plan[0]!.status, 'completed', done.error ?? 'first step must advance');
      assert.deepEqual(
        f.calls.map((ctx) => ctx.input.stepId),
        ['first', 'second'],
      );
      assert.equal(
        done.status,
        last === 'write' ? 'completed' : 'blocked',
        done.error ?? 'final result requires evidence',
      );
    });
});
function assertReceipt(prompt: string, runId: string) {
  const block = /<<<PUGPORT_WORKFLOW_TOOL_EVIDENCE:[^>]+>>>\n([\s\S]*?)\n<<<END_/.exec(prompt)![1]!;
  assert.ok(block.length <= 3000);
  assert.ok(!block.includes(runId));
  assert.doesNotMatch(block, /bridge:synthetic-recycle|toolCallId|eventSeqs/);
  assert.match(prompt, /"moved":\["synthetic.001","synthetic.002"\]/);
  assert.match(prompt, /"skipped":\["retained-fixture"\]/);
  assert.match(prompt, /892962763/);
  assert.match(prompt, /unconfirmed-tool/);
  assert.match(prompt, /"safe":false/);
}

test('a real next-step dispatch includes durable tools and keeps final reply free of the evidence packet', async (t) => {
  const f = fixture(t, async (ctx) => {
    if (ctx.input.stepId === 'first') {
      receipt(ctx);
      return completed('Model-only first-step summary');
    }
    return completed();
  });
  const sent = await submit(f);
  const done = await finish(f, sent.workflow.id);
  assert.equal(done.status, 'completed', done.error ?? 'The synthetic workflow must complete.');
  assert.equal(f.calls.length, 2);
  const first = f.controller.store.run(done.plan[0]!.runIds[0]!)!;
  assertReceipt(f.calls[1]!.input.prompt, first.id);
  assert.equal(first.handoffCheckpoint?.safe, false);
  const second = f.controller.store.run(done.plan[1]!.runIds[0]!)!;
  assert.ok(
    second.events.some(
      (event) =>
        event.data?.kind === 'workflow-tool-evidence' && (event.data.fromRunIds as string[]).includes(first.id),
    ),
  );
  const final = f.workspace.store.get<{ content: string }>('message', done.finalMessageId!)!;
  assert.ok(!final.content.includes('PUGPORT_WORKFLOW_TOOL_EVIDENCE'));
});

test('explicit Continue retains predecessor receipts without replaying the completed first step', async (t) => {
  let fail = true;
  const f = fixture(t, async (ctx) => {
    if (ctx.input.stepId === 'first') {
      receipt(ctx);
      return completed();
    }
    if (fail) throw Error('runtime-request-failed');
    return completed();
  });
  const sent = await submit(f);
  const blocked = await finish(f, sent.workflow.id);
  assert.equal(blocked.status, 'blocked');
  const firstRunId = blocked.plan[0]!.runIds[0]!;
  fail = false;
  const next = await f.workspace.continue(blocked.id);
  assert.equal((await finish(f, next.workflow.id)).status, 'completed');
  assert.equal(f.calls.filter((ctx) => ctx.input.stepId === 'first').length, 1);
  assertReceipt(f.calls.at(-1)!.input.prompt, firstRunId);
});

test('quota handoff retains previous-step receipts and this step real native result on another runtime', async (t) => {
  const f = fixture(t, async (ctx) => {
    if (ctx.input.stepId === 'first') {
      receipt(ctx);
      return completed();
    }
    if (ctx.target.id === 'codex') {
      ctx.emit({
        at: new Date().toISOString(),
        type: 'tool',
        data: {
          source: 'native',
          kind: 'commandExecution',
          itemId: 'second-scan',
          status: 'completed',
          exitCode: 0,
          input: { command: 'synthetic scan' },
          output: 'SCAN_RECEIPT_ACTUAL_RESULT',
        },
      });
      throw Error('quota-or-rate-limit');
    }
    return completed();
  });
  const sent = await submit(f, { autoEscalate: true, allowExecutorFallback: true });
  const done = await finish(f, sent.workflow.id);
  assert.equal(done.status, 'completed', done.error ?? 'The synthetic quota handoff must complete.');
  assert.deepEqual(
    f.calls.map((ctx) => [ctx.input.stepId, ctx.target.id]),
    [
      ['first', 'codex'],
      ['second', 'codex'],
      ['second', 'claude'],
    ],
  );
  assertReceipt(f.calls.at(-1)!.input.prompt, done.plan[0]!.runIds[0]!);
  assert.doesNotMatch(f.calls.at(-1)!.input.prompt, /SCAN_RECEIPT_ACTUAL_RESULT/);
  assert.match(f.calls.at(-1)!.input.prompt, /命令 `synthetic scan` → 退出码 0/);
});

test('follow-up three-step worktree workflow accepts child commits without intermediate receipts', async (t) => {
  let worktree = '';
  const f = fixture(t, async (ctx) => {
    if (ctx.input.stepId === 'first') {
      writeFileSync(join(worktree, 'child.txt'), 'child implementation');
      await hostGit(worktree, ['add', 'child.txt']);
      await hostGit(worktree, [
        '-c',
        'user.name=Synthetic',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-m',
        'Child commit',
      ]);
    }
    return {
      output:
        'COMBORUNNER_TASK_RESULT: {"status":"completed","summary":"Done","claims":[{"claim":"Implemented","files":["child.txt"],"verified":true}]}',
    };
  });
  await hostGit(f.directory, ['init']);
  writeFileSync(join(f.directory, '.gitignore'), 'data/\nmemory/\nlinked/\n');
  await hostGit(f.directory, ['add', '.gitignore']);
  await hostGit(f.directory, [
    '-c',
    'user.name=Synthetic',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'Baseline',
  ]);
  worktree = join(f.directory, 'linked');
  await hostGit(f.directory, ['worktree', 'add', '-b', 'synthetic-child', worktree]);
  const project = await f.workspace.createProject(worktree);
  const conversation = f.workspace.createConversation(project.id);
  f.workspace.store.addMessage(conversation.id, 'user', 'Implement child.txt in this worktree.');
  f.workspace.store.addMessage(conversation.id, 'assistant', 'Ready for the follow-up.');
  const steps = plan();
  steps.forEach((step) => {
    step.writes = true;
  });
  steps.push({ ...steps[1]!, id: 'third', dependsOn: ['second'], runIds: [] });
  const sent = await f.workspace.send(
    conversation.id,
    { ...input, content: 'Continue implementing child.txt.', expectsFileChanges: true },
    undefined,
    undefined,
    { resumePlan: steps },
  );
  const done = await finish(f, sent.workflow.id);
  assert.equal(done.status, 'completed', done.error ?? 'workflow must complete');
  assert.deepEqual(
    f.calls.map((ctx) => ctx.input.stepId),
    ['first', 'second', 'third'],
  );
  const last = f.controller.store.run(done.plan[2]!.runIds[0]!)!;
  assert.ok(last.measuredFileChanges?.commits);
  assert.equal(done.fileChangeNotice, false);
});
