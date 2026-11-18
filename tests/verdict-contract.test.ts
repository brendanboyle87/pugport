import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ConversationMessage, MessageInput, WorkflowStep } from '../src/shared/types.ts';
import { canContinueWorkflow } from '../src/ui/queue-utils.ts';
import { systemNoticeText } from '../src/shared/system-notices.ts';
import { fixture, completed, finish } from './helpers/workspace-execution.ts';

const kv = '围绕用户列出的要点整理一份清晰的说明，不需要执行工具或修改文件…';
const answer = 'KV cache 保存先前 token 的键和值，减少重复计算。';
const cases: Array<{
  name: string;
  instruction: string;
  writes?: boolean;
  content?: string;
  expectsFileChanges?: boolean;
  output?: string;
  report?: object;
  hard?: boolean;
  note?: boolean;
  native?: boolean;
  readOnly?: boolean;
}> = [
  { name: 'KV explanation declares no writes', instruction: kv, writes: false },
  { name: 'legacy KV explanation uses a soft note', instruction: kv, note: true },
  { name: 'declared write without receipts fails visibly', instruction: kv, writes: true, hard: true },
  {
    name: 'dispatch write contract without receipts fails visibly',
    instruction: 'Perform the requested work.',
    expectsFileChanges: true,
    hard: true,
  },
  {
    // A read-only part of a dispatched write task inherits the flag; it cannot be asked for file changes.
    name: 'read-only work is never asked for file receipts',
    instruction: 'Summarise the findings for the caller.',
    expectsFileChanges: true,
    readOnly: true,
  },
  {
    name: 'B200 question ending with enumeration punctuation',
    instruction: 'Answer the pricing question.',
    content: '租一张B200的卡，每小时多少美元，我作为个人能租到吗、',
  },
  {
    name: 'prose write claim is informational',
    instruction: 'Respond to the user.',
    output: '已修改 a.ts',
    note: true,
  },
  {
    name: 'explicit false skips even prose write claims',
    instruction: 'Respond to the user.',
    writes: false,
    output: '已修改 a.ts',
  },
  { name: 'native single step permission is not expectation', instruction: 'Modify a.ts.', native: true, note: true },
  {
    name: 'original request heuristic is soft at workflow end',
    instruction: 'Inspect the result.',
    content: 'Modify a.ts.',
    note: true,
  },
  {
    name: 'all false steps skip original request heuristic',
    instruction: 'Inspect the result.',
    content: 'Modify a.ts.',
    writes: false,
  },
  {
    name: 'workflow write contract survives a non-writing final step',
    instruction: 'Inspect the result.',
    writes: false,
    expectsFileChanges: true,
    hard: true,
  },
  {
    name: 'structured partial keeps answer',
    instruction: kv,
    writes: false,
    report: { status: 'partial', summary: 'A requested section remains.' },
    hard: true,
  },
  {
    name: 'structured blocked keeps answer',
    instruction: kv,
    writes: false,
    report: { status: 'blocked', summary: 'A required input is absent.' },
    hard: true,
  },
  {
    name: 'structured file claim needs matching receipts',
    instruction: 'Respond to the user.',
    report: { status: 'completed', claims: [{ claim: 'Changed a.ts', files: ['a.ts'] }] },
    hard: true,
  },
  {
    name: 'ordinary structured research claims need no file receipts',
    instruction: 'Respond to the user.',
    report: { status: 'completed', claims: [{ claim: 'Explained KV caching', verified: true }] },
  },
];
for (const example of cases)
  test(example.name, async (t) => {
    const text = example.output ?? answer;
    const f = fixture(t, async () =>
      example.report
        ? { output: text + '\nCOMBORUNNER_TASK_RESULT: ' + JSON.stringify(example.report) }
        : completed(text),
    );
    const project = await f.workspace.createProject(f.directory);
    const conversation = f.workspace.createConversation(project.id);
    const input: MessageInput = {
      content: example.content ?? example.instruction,
      mode: 'build',
      ...(example.readOnly
        ? {
            permissionMode: 'read-only' as const,
            explicitWrite: false,
            permissionOrigin: { source: 'caller' as const, mode: 'read-only' as const },
          }
        : { permissionMode: 'workspace-write' as const, explicitWrite: true }),
      expectsFileChanges: example.expectsFileChanges,
      runtimeId: 'codex',
      model: 'fixture-model',
      executionPolicy: 'cli-only',
      autoEscalate: false,
      allowExecutorFallback: false,
    };
    const step: WorkflowStep = {
      id: 'answer',
      title: 'Answer',
      instruction: example.instruction,
      writes: example.writes,
      kind: 'general',
      transport: 'auto',
      dependsOn: [],
      status: 'pending',
      runIds: [],
    };
    const sent = await f.workspace.send(
      conversation.id,
      input,
      undefined,
      undefined,
      example.native ? undefined : { resumePlan: [step] },
    );
    const done = await finish(f, sent.workflow.id);
    assert.equal(done.status, example.hard ? 'blocked' : 'completed', done.error ?? 'Expected completion');
    const run = f.controller.run(done.plan.at(-1)!.runIds.at(-1)!)!;
    assert.equal(run.status, example.hard ? 'failed' : 'completed');
    const message = f.workspace.store.get<ConversationMessage>('message', done.finalMessageId!)!;
    assert.equal(message.content, text);
    if (example.hard) {
      assert.ok(message.systemNotice?.text);
      if (!['partial', 'blocked'].includes((example.report as { status?: string })?.status ?? ''))
        assert.match(done.error!, /结果未确认/);
    } else assert.equal(message.systemNotice?.text, example.note ? systemNoticeText.noFileChanges : undefined);
    if (!example.hard) assert.equal(canContinueWorkflow(done), !!example.note);
    if (example.writes === false) assert.equal(f.calls.at(-1)!.input.checkFileChanges, false);
    if (example.writes === true) {
      const next = await f.workspace.continue(done.id);
      assert.equal(next.workflow.plan[0]!.writes, true);
      assert.equal((await finish(f, next.workflow.id)).status, 'blocked');
    }
  });

// The planner's per-step `writes` is a prediction: a later build/check step it marked as writing may change
// nothing. Only the whole workflow's receipts decide a hard write requirement.
for (const [name, writeInFirstStep, outcome] of [
  ['a writing step predicted for a build check passes when an earlier step changed files', true, 'completed'],
  ['a dispatch write contract still fails when no step changed any file', false, 'blocked'],
] as const)
  test(name, async (t) => {
    const f = fixture(t, async (ctx, calls) => {
      if (writeInFirstStep && calls.length === 1)
        writeFileSync(join(ctx.input.projectPath, 'changed.txt'), 'synthetic change');
      return completed(answer);
    });
    // A project folder apart from the fixture's data folder, so PugPort's own database writes are not receipts.
    const folder = join(f.directory, 'project');
    mkdirSync(folder);
    const project = await f.workspace.createProject(folder);
    const conversation = f.workspace.createConversation(project.id);
    // Receipts come from PugPort's own measurement of the project folder, which needs a Git checkout.
    execFileSync('git', ['init', '-q'], { cwd: folder });
    const step = (id: string, instruction: string): WorkflowStep => ({
      id,
      title: id,
      instruction,
      writes: true,
      kind: 'general',
      transport: 'auto',
      dependsOn: [],
      status: 'pending',
      runIds: [],
    });
    const sent = await f.workspace.send(
      conversation.id,
      {
        content: 'Fix the file, then build and check it.',
        mode: 'build',
        permissionMode: 'workspace-write',
        explicitWrite: true,
        expectsFileChanges: true,
        runtimeId: 'codex',
        model: 'fixture-model',
        executionPolicy: 'cli-only',
        autoEscalate: false,
        allowExecutorFallback: false,
      },
      undefined,
      undefined,
      { resumePlan: [step('fix', 'Fix changed.txt.'), step('check', 'Build and run the static checks.')] },
    );
    const done = await finish(f, sent.workflow.id);
    assert.equal(done.status, outcome, done.error ?? '');
    assert.equal(done.plan[0]!.status, 'completed');
  });

test('multistep structured claims without evidence block only at finalisation', async (t) => {
  const f = fixture(t, async (_ctx, calls) =>
    calls.length === 1
      ? {
          output:
            'COMBORUNNER_TASK_RESULT: {"status":"completed","claims":[{"claim":"Changed a.ts","files":["a.ts"]}]}',
        }
      : completed('Checked the result.'),
  );
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const steps: WorkflowStep[] = ['first', 'second', 'third'].map((id, index, ids) => ({
    id,
    title: id,
    instruction: 'Respond to the user.',
    kind: 'general',
    transport: 'auto',
    dependsOn: index ? [ids[index - 1]!] : [],
    status: 'pending',
    runIds: [],
  }));
  const sent = await f.workspace.send(
    conversation.id,
    {
      content: 'Continue the task.',
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
    { resumePlan: steps },
  );
  const done = await finish(f, sent.workflow.id);
  assert.equal(f.calls.length, 3);
  assert.equal(done.status, 'blocked');
  assert.match(done.error ?? '', /结果未确认/);
});

test('workflow finalisation retains accepted failed-check disclosures', async (t) => {
  const f = fixture(t, async (ctx) => {
    writeFileSync(join(ctx.input.projectPath, 'a.ts'), 'synthetic');
    ctx.emit({
      at: '',
      type: 'tool',
      data: { itemId: 'write', tool: 'Write', status: 'completed', input: { file_path: 'a.ts' } },
    });
    for (let index = 0; index < 9; index++)
      ctx.emit({
        at: '',
        type: 'tool',
        data: {
          itemId: `test-${index}`,
          kind: 'commandExecution',
          status: 'completed',
          exitCode: 1,
          input: { command: `npm test --case=${index}` },
        },
      });
    return completed('Implemented; test has a known baseline failure.');
  });
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const sent = await f.workspace.send(conversation.id, {
    content: 'Implement a.ts.',
    mode: 'build',
    permissionMode: 'workspace-write',
    expectsFileChanges: true,
    runtimeId: 'codex',
    model: 'fixture-model',
    executionPolicy: 'cli-only',
    autoEscalate: false,
  });
  const done = await finish(f, sent.workflow.id);
  assert.equal(done.status, 'completed', done.error ?? 'expected completion');
  assert.equal(done.failedChecks?.length, 8);
});

test('earlier out-of-project claims cannot borrow later project receipts', async (t) => {
  const f = fixture(t, async (ctx, calls) => {
    if (calls.length === 1)
      return {
        output:
          'COMBORUNNER_TASK_RESULT: {"status":"completed","claims":[{"claim":"Changed external file","files":["../outside.ts"]}]}',
      };
    writeFileSync(join(ctx.input.projectPath, 'a.ts'), 'synthetic');
    ctx.emit({
      at: '',
      type: 'tool',
      data: { itemId: 'write', tool: 'Write', status: 'completed', input: { file_path: 'a.ts' } },
    });
    return completed('Implemented a.ts.');
  });
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const steps: WorkflowStep[] = ['first', 'second'].map((id) => ({
    id,
    title: id,
    instruction: 'Respond to the user.',
    kind: 'general',
    transport: 'auto',
    dependsOn: [],
    status: 'pending',
    runIds: [],
  }));
  const sent = await f.workspace.send(
    conversation.id,
    {
      content: 'Continue the task.',
      mode: 'build',
      permissionMode: 'workspace-write',
      runtimeId: 'codex',
      model: 'fixture-model',
      executionPolicy: 'cli-only',
      autoEscalate: false,
    },
    undefined,
    undefined,
    { resumePlan: steps },
  );
  const done = await finish(f, sent.workflow.id);
  assert.equal(f.calls.length, 2);
  assert.equal(done.status, 'blocked');
  assert.match(done.error ?? '', /结果未确认/);
});
