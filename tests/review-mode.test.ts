import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { desktopPermissionChange } from '../src/server/permission-change.ts';
import { Workspace, parseReviewVerdict } from '../src/server/workspace.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { claudeAdapter } from '../src/server/adapters/claude.ts';
import type { ExecuteContext, MessageInput, RuntimeSnapshot, RuntimeTarget, Workflow } from '../src/shared/types.ts';

const verdict = (value: string, reason = 'reason', fix = 'fix it', extra: object = {}) =>
  `Checked the files.\nCOMBORUNNER_REVIEW ${JSON.stringify({ verdict: value, reason, fix, ...extra })}`;

function fixture(t: TestContext, verdicts: string[], worker?: (call: number) => string, writeChanges = true) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'review-mode-test-')));
  const controller = new Controller(directory, join(directory, 'data'));
  clearInterval(controller.timer);
  controller.settings.decisionMode = 'auto';
  controller.settings.routePreferencesEnabled = true;
  controller.settings.architectureProvider = 'codex';
  controller.settings.routineProvider = 'codex';
  controller.settings.designProvider = 'codex';
  controller.targets = (['codex', 'claude'] as const).map((provider): RuntimeTarget => ({
    id: provider,
    provider,
    label: provider,
    command: 'unused',
    environment: 'native',
    enabled: true,
  }));
  controller.snapshots = controller.targets.map((target): RuntimeSnapshot => ({
    ...target,
    installed: true,
    status: 'ready',
    models: [{ id: 'test-model', label: 'Test model', efforts: ['low', 'medium', 'high'] }],
    quota: {
      status: 'known',
      source: 'fixture',
      observedAt: new Date().toISOString(),
      windows: [
        { id: 'week', label: 'week', usedPercent: 10, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
      ],
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: new Date().toISOString(),
  }));
  t.mock.method(controller, 'refresh', async () => {});
  const calls: ExecuteContext[] = [];
  const execute = async (ctx: ExecuteContext) => {
    calls.push(ctx);
    if (
      writeChanges &&
      ctx.target.provider === 'codex' &&
      ctx.input.stepId &&
      ctx.input.permissionMode === 'workspace-write'
    ) {
      writeFileSync(join(ctx.input.projectPath, 'README.md'), `Fixed the typo. Revision ${calls.length}.\n`);
      ctx.emit({
        at: new Date().toISOString(),
        type: 'tool',
        data: {
          itemId: `edit-${calls.length}`,
          kind: 'fileChange',
          status: 'completed',
          input: { changes: [{ path: 'README.md', kind: { type: 'update' } }] },
        },
      });
    }
    // Codex does the work; Claude, the other platform, is the reviewer.
    const output =
      ctx.target.provider === 'claude' || ctx.input.verifierCandidates?.length
        ? (verdicts.shift() ?? verdict('pass'))
        : (worker?.(calls.length) ?? `work ${calls.length}`);
    return { output, nativeSessionId: `session-${calls.length}` };
  };
  t.mock.method(codexAdapter, 'execute', execute);
  t.mock.method(claudeAdapter, 'execute', execute);
  const workspace = new Workspace(controller, { autoTick: false });
  t.after(async () => {
    await workspace.close();
    await controller.close();
    const absolute = resolve(directory);
    assert.ok(
      absolute.startsWith(realpathSync.native(tmpdir()) + sep) && basename(absolute).startsWith('review-mode-test-'),
    );
    rmSync(absolute, { recursive: true, force: true });
  });
  return { workspace, calls, directory, controller };
}

const input: MessageInput = {
  content: 'Fix the typo in README.md',
  mode: 'build',
  permissionMode: 'workspace-write',
  executionPolicy: 'cli-first',
  autoEscalate: false,
  review: true,
};

/** Ticks the queue until nothing runs, waits or awaits review, then returns every workflow of the conversation. */
async function settle(workspace: Workspace, conversationId: string) {
  for (let i = 0; i < 600; i++) {
    await workspace.tickQueue();
    const flows = workspace.store.workflows(conversationId);
    const busy = flows.some(
      (w) =>
        !['completed', 'blocked', 'failed', 'cancelled', 'interrupted'].includes(w.status) ||
        w.review?.status === 'reviewing' ||
        (w.input.review && !w.delegation && w.status === 'completed' && !w.review),
    );
    if (!busy) return flows;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error('review did not settle');
}

async function start(f: ReturnType<typeof fixture>, resumePlan?: Workflow['plan']) {
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  await f.workspace.send(conversation.id, input, undefined, undefined, resumePlan ? { resumePlan } : undefined);
  return settle(f.workspace, conversation.id);
}

const tasks = (flows: Workflow[]) =>
  flows.filter((w) => !w.delegation).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

test('a captured verifier profile starts review but cannot override cross-provider exclusion', async (t) => {
  const f = fixture(t, [verdict('pass')]);
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  conversation.routing = {
    version: 2,
    text: 'Start with Codex; verify with Codex',
    rules: [],
    unparsed: [],
    updatedAt: 'now',
    chapterAgents: false,
    mask: false,
    roles: {
      coordinator: { provider: 'codex', model: 'test-model' },
      verifier: [
        { runtimeId: 'removed', model: 'test-model' },
        { provider: 'codex', model: 'test-model', effort: 'high' },
      ],
    },
  };
  f.workspace.store.save('conversation', conversation.id, project.id, conversation);
  const sent = await f.workspace.send(conversation.id, { ...input, review: undefined });
  assert.equal(sent.workflow.input.review, true);
  assert.equal(sent.workflow.input.provider, 'codex');
  // Later settings edits do not replace the captured reviewer choice.
  conversation.routing.roles!.verifier = [{ provider: 'claude' }];
  f.workspace.store.save('conversation', conversation.id, project.id, conversation);
  const flows = await settle(f.workspace, conversation.id);
  const parent = tasks(flows)[0]!;
  assert.equal(parent.review?.status, 'passed');
  const reviewer = flows.find((flow) => flow.delegation?.role === 'reviewer')!;
  assert.equal(reviewer.input.permissionMode, 'read-only');
  const run = reviewer.runIds.map((id) => f.controller.run(id)).find((run) => run?.stepId)!;
  assert.equal(run.route.runtimeId, 'claude');
  assert.match(run.route.reasons.join('\n'), /核验候选 1 不可用/);
  assert.match(run.route.reasons.join('\n'), /核验候选 2 不可用/);
  assert.equal(parent.taskJudgment?.reason, 'manual-selection', 'the coordinator pin skips paid task judgment');
});

test('reviewer verdict lines are parsed strictly', () => {
  assert.deepEqual(parseReviewVerdict(verdict('redo', 'Missed a file', 'Fix b.txt')), {
    verdict: 'redo',
    reason: 'Missed a file',
    fix: 'Fix b.txt',
  });
  assert.equal(parseReviewVerdict('no verdict here'), undefined);
  assert.equal(parseReviewVerdict('COMBORUNNER_REVIEW {"verdict":"maybe"}'), undefined);
  assert.equal(parseReviewVerdict('COMBORUNNER_REVIEW not json'), undefined);
});

test('a passing review marks the task and changes nothing else', async (t) => {
  const f = fixture(t, [verdict('pass', 'All good')]);
  const flows = await start(f);
  const [task] = tasks(flows);
  assert.equal(task!.review?.status, 'passed');
  assert.equal(task!.review?.reason, 'All good');
  assert.equal(task!.status, 'completed');
  const executed = task!.runIds.map((id) => f.controller.run(id)).find((run) => run?.stepId)!;
  assert.equal(executed.taskOutcome?.source, 'file-receipts');
  assert.equal(executed.taskOutcome?.status, 'completed');
  const reviewer = flows.find((w) => w.delegation?.review)!;
  assert.equal(reviewer.input.permissionMode, 'read-only');
  assert.equal(reviewer.input.review, undefined);
  assert.equal(f.calls.find((c) => c.target.provider === 'claude')?.input.permissionMode, 'read-only');
  assert.equal(tasks(flows).length, 1);
  assert.match(readFileSync(join(f.directory, 'README.md'), 'utf8'), /^Fixed the typo\. Revision \d+\.\n$/);
});

test('a completion claim without file evidence stays unconfirmed and cannot pass review', async (t) => {
  for (const aggregate of [false, true])
    await t.test(aggregate ? 'workflow evidence' : 'step evidence', async (t) => {
      const report =
        'Done.\nCOMBORUNNER_TASK_RESULT: {"status":"completed","claims":[{"claim":"Fixed README.md","files":["README.md"]}]}';
      const f = fixture(t, [verdict('pass')], () => report, false);
      const plan: Workflow['plan'] = [
        {
          id: 'inspect',
          title: 'Inspect',
          instruction: 'Inspect README.md and report its state.',
          kind: 'general',
          transport: 'auto',
          dependsOn: [],
          status: 'pending',
          runIds: [],
        },
      ];
      const [task] = tasks(await start(f, aggregate ? plan : undefined));
      assert.equal(task!.status, 'blocked');
      assert.match(task!.error ?? '', /结果未确认/);
      assert.equal(task!.review, undefined);
      assert.equal(f.calls.filter((call) => call.target.provider === 'claude').length, 0);
      const outcome = f.controller.run(task!.runIds.at(-1)!)!.taskOutcome!;
      assert.equal(outcome.status, 'unverified');
      assert.equal(outcome.source, 'file-receipts');
      assert.deepEqual(
        outcome.claims,
        [{ claim: 'Fixed README.md', files: ['README.md'] }],
        'claims remain statements, not proof',
      );
    });
});

test('a reviewer without a valid verdict never passes confirmed file work', async (t) => {
  const f = fixture(t, ['No review verdict was produced.']);
  const [task] = tasks(await start(f));
  assert.equal(task!.review?.status, 'stopped');
  assert.equal(task!.review?.verdict, undefined);
  assert.equal(f.calls.filter((call) => call.target.provider === 'claude').length, 1);
});

test('already-correct files can pass review after an injected host verification without new writes', async (t) => {
  const f = fixture(t, [verdict('pass')], undefined, false);
  t.mock.method(f.controller, 'verify', async (command: string, cwd: string) => {
    assert.equal(readFileSync(join(cwd, 'README.md'), 'utf8'), 'Fixed the typo.\n');
    return { command, status: 'passed', exitCode: 0, output: '' };
  });
  writeFileSync(join(f.directory, 'README.md'), 'Fixed the typo.\n');
  writeFileSync(
    join(f.directory, 'verify.cjs'),
    "require('node:assert/strict').equal(require('node:fs').readFileSync('README.md', 'utf8'), 'Fixed the typo.\\n');",
  );
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const quotedNode = `'${process.execPath.replaceAll("'", "''")}'`;
  const verificationCommand = `${process.platform === 'win32' ? '& ' : ''}${quotedNode} ./verify.cjs`;
  const change = { kind: 'verification', projectId: project.id, command: verificationCommand };
  const description = await desktopPermissionChange(f.workspace, change, false);
  await desktopPermissionChange(f.workspace, change, true, description);
  await f.workspace.send(conversation.id, {
    ...input,
    verificationCommand,
  });
  const [task] = tasks(await settle(f.workspace, conversation.id));
  assert.equal(task!.status, 'completed', task!.error ?? 'verified work should complete');
  assert.equal(task!.review?.status, 'passed');
  const run = task!.runIds.map((id) => f.controller.run(id)).find((run) => run?.stepId)!;
  assert.equal(run.verification?.status, 'passed');
  assert.equal(run.verification?.exitCode, 0);
  assert.equal(run.taskOutcome?.source, 'file-receipts');
  assert.equal(run.taskOutcome?.status, 'completed');
  assert.equal(
    run.events.some((event) => event.data?.kind === 'fileChange'),
    false,
  );
  assert.equal(readFileSync(join(f.directory, 'README.md'), 'utf8'), 'Fixed the typo.\n');
});

test('a redo verdict has the same executor fix the work, then reviews it again', async (t) => {
  const f = fixture(t, [verdict('redo', 'Missed a file', 'Fix b.txt'), verdict('pass', 'Fixed')]);
  const flows = await start(f);
  const [first, fix] = tasks(flows);
  assert.equal(first!.review?.status, 'fixing');
  assert.equal(first!.review?.successorId, fix!.id);
  assert.match(fix!.input.content, /需要修改：Fix b\.txt/);
  assert.equal(fix!.input.runtimeId, 'codex');
  assert.equal(fix!.review?.status, 'passed');
  assert.equal(fix!.review?.round, 1);
});

test('a stronger verdict raises the reasoning effort for the retry', async (t) => {
  const f = fixture(t, [verdict('stronger', 'Wrong approach'), verdict('pass')]);
  const flows = await start(f);
  const [first, retry] = tasks(flows);
  const firstEffort = f.calls.find((c) => c.target.provider === 'codex')!.route.effort;
  const levels = ['low', 'medium', 'high'];
  assert.equal(retry!.input.effort, levels[levels.indexOf(firstEffort!) + 1]);
  assert.equal(first!.review?.verdict, 'stronger');
});

test('automatic fixes stop after two rounds', async (t) => {
  const f = fixture(t, [verdict('redo'), verdict('redo'), verdict('redo'), verdict('redo')]);
  const flows = await start(f);
  const all = tasks(flows);
  assert.equal(all.length, 3);
  assert.equal(all.at(-1)!.review?.status, 'stopped');
  assert.match(all.at(-1)!.review!.reason!, /已自动修正 2 轮/);
});

test('a broken project rule is never a pass; claims and rules come back checked one by one', () => {
  const line = (value: object) => `Checked.\nCOMBORUNNER_REVIEW ${JSON.stringify(value)}`;
  const parsed = parseReviewVerdict(
    line({
      verdict: 'pass',
      reason: 'Looks fine',
      claims: [
        { claim: 'Added the timer', status: 'verified', note: 'timer.test.ts passes' },
        { claim: 'Best times persist', status: 'maybe' },
      ],
      rules: [
        { rule: 'Engine must not import UI code', ok: false, note: 'engine.ts imports ui/board.tsx' },
        { rule: 'Rule changes need tests', ok: true },
      ],
    }),
  )!;
  assert.equal(parsed.verdict, 'redo');
  assert.match(parsed.fix!, /遵守规则“Engine must not import UI code”：engine\.ts imports ui\/board\.tsx/);
  assert.deepEqual(
    parsed.claims!.map((item) => item.status),
    ['verified', 'unverified'],
  );
  assert.deepEqual(
    parsed.rules!.map((rule) => rule.ok),
    [false, true],
  );
});

test('the reviewer checks the executor’s claims and the project rules, and its findings are kept', async (t) => {
  const report = `Done.\nCOMBORUNNER_TASK_RESULT: ${JSON.stringify({
    status: 'completed',
    summary: 'Fixed the typo',
    claims: [
      { claim: 'Fixed the typo in README.md', evidence: 'README.md line 3' },
      { claim: 'All tests pass', evidence: '' },
    ],
  })}`;
  const review = `Checked README.md.\nCOMBORUNNER_REVIEW ${JSON.stringify({
    verdict: 'pass',
    reason: 'Typo fixed',
    claims: [
      { claim: 'Fixed the typo in README.md', status: 'verified', note: 'line 3 now reads correctly' },
      { claim: 'All tests pass', status: 'unverified', note: 'no test output' },
    ],
    rules: [{ rule: 'Only touch documentation', ok: true }],
  })}`;
  const f = fixture(t, [review], () => report);
  const project = await f.workspace.createProject(f.directory);
  f.workspace.setProjectRules(project.id, ['Only touch documentation', '  ', 'Only touch documentation']);
  const conversation = f.workspace.createConversation(project.id);
  await f.workspace.send(conversation.id, input);
  const flows = await settle(f.workspace, conversation.id);
  const [task] = tasks(flows);
  // The rules reach the executor, and the reviewer sees each claim and each rule.
  const worker = f.calls.find((call) => call.target.provider === 'codex')!;
  assert.match(worker.input.prompt, /项目规则（必须遵守；开启审核时会逐条检查）：\n- Only touch documentation/);
  const reviewer = f.calls.find((call) => call.target.provider === 'claude')!;
  assert.match(reviewer.input.prompt, /1\. Fixed the typo in README\.md（它给的依据：README\.md line 3）/);
  assert.match(reviewer.input.prompt, /2\. All tests pass（没有给依据）/);
  assert.match(
    reviewer.input.prompt,
    /项目规则（逐条检查这次的改动；任何一条不满足都不能 pass）：\n1\. Only touch documentation/,
  );
  assert.equal(task!.review?.status, 'passed');
  assert.deepEqual(
    task!.review?.claims?.map((item) => [item.claim, item.status]),
    [
      ['Fixed the typo in README.md', 'verified'],
      ['All tests pass', 'unverified'],
    ],
  );
  assert.deepEqual(task!.review?.rules, [{ rule: 'Only touch documentation', ok: true }]);
  assert.deepEqual(f.workspace.store.get<{ rules?: string[] }>('project', project.id)?.rules, [
    'Only touch documentation',
  ]);
});

test('the trace shows what was said apart from what was checked', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ClaimsCheck, claimsSummary, workflowClaims } = await import('../src/ui/ClaimsCheck.tsx');
  const run = {
    taskOutcome: {
      status: 'completed',
      source: 'executor-report',
      claims: [{ claim: 'Added the timer', evidence: 'timer.test.ts' }, { claim: 'Saved best times' }],
    },
  } as unknown as import('../src/shared/types.ts').RunRecord;
  const unchecked = { review: undefined } as unknown as Workflow;
  assert.equal(claimsSummary(workflowClaims(unchecked, [run]), false), '说完成 2 项 · 1 项给了依据');
  const checked = {
    review: {
      round: 0,
      status: 'passed',
      claims: [
        { claim: 'Added the timer', status: 'verified' },
        { claim: 'Saved best times', status: 'false', note: 'not saved after reload' },
      ],
      rules: [{ rule: 'Engine stays separate', ok: false, note: 'imports ui' }],
    },
  } as unknown as Workflow;
  assert.equal(claimsSummary(workflowClaims(checked, [run]), true), '说完成 2 项 · 检查通过 1 项');
  const html = renderToStaticMarkup(createElement(ClaimsCheck, { workflow: checked, runs: [run] }));
  assert.match(html, /审核逐条核对/);
  assert.match(html, /检查通过<\/span><span class="claim-text" translate="no">Added the timer/);
  assert.match(
    html,
    /不成立<\/span><span class="claim-text" translate="no">Saved best times<small>not saved after reload/,
  );
  assert.match(html, /违反<\/span><span class="claim-text" translate="no">Engine stays separate/);
});

test('graded review findings are parsed and clamped; malformed items are dropped', () => {
  const findings = [
    { severity: 'must', text: `  ${'x'.repeat(400)}  ` },
    { severity: 'should', text: 'Name the helper after what it returns' },
    { severity: 'nit', text: 'Trailing space in the README' },
    { severity: 'blocker', text: 'Unknown severity' },
    { severity: 'must', text: '   ' },
    { severity: 'should' },
    'not an object',
    ...Array.from({ length: 25 }, (_, index) => ({ severity: 'nit', text: `Nit ${index}` })),
  ];
  const parsed = parseReviewVerdict(verdict('redo', 'Two problems', 'Fix them', { findings }))!;
  assert.equal(parsed.findings!.length, 20);
  assert.deepEqual(parsed.findings![0], { severity: 'must', text: 'x'.repeat(300) });
  assert.deepEqual(parsed.findings!.slice(1, 3), [
    { severity: 'should', text: 'Name the helper after what it returns' },
    { severity: 'nit', text: 'Trailing space in the README' },
  ]);
  assert.ok(parsed.findings!.slice(3).every((item) => item.severity === 'nit' && /^Nit \d+$/.test(item.text)));
  assert.equal(parseReviewVerdict(verdict('pass'))!.findings, undefined);
});

test('a redo carries must and should findings to the executor but not nits, and the findings are kept', async (t) => {
  const findings = [
    { severity: 'must', text: 'README still says teh' },
    { severity: 'should', text: 'Also fix the heading case' },
    { severity: 'nit', text: 'Prefer a shorter commit message' },
  ];
  const f = fixture(t, [verdict('redo', 'Typo remains', 'Fix the typo', { findings }), verdict('pass')]);
  const [first, fix] = tasks(await start(f));
  assert.deepEqual(first!.review?.findings, findings);
  assert.match(
    fix!.input.content,
    /需要修改：Fix the typo\n必须改：README still says teh\n建议改：Also fix the heading case\n/,
  );
  assert.doesNotMatch(fix!.input.content, /Prefer a shorter commit message/);
  const reviewer = f.calls.find((call) => call.target.provider === 'claude')!;
  assert.match(reviewer.input.prompt, /"findings":\[\{"severity":"must\|should\|nit"/);
});

test('review notes are grouped by severity and absent without findings', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ClaimsCheck } = await import('../src/ui/ClaimsCheck.tsx');
  const reviewed = (findings?: object[]) =>
    ({ review: { round: 0, status: 'fixing', ...(findings ? { findings } : {}) } }) as unknown as Workflow;
  assert.equal(renderToStaticMarkup(createElement(ClaimsCheck, { workflow: reviewed(), runs: [] })), '');
  const html = renderToStaticMarkup(
    createElement(ClaimsCheck, {
      workflow: reviewed([
        { severity: 'nit', text: 'Shorter name' },
        { severity: 'must', text: 'Typo remains' },
      ]),
      runs: [],
    }),
  );
  assert.match(html, /审核意见/);
  assert.match(html, /必须改<\/span><span class="claim-text" translate="no">Typo remains/);
  assert.match(html, /小问题<\/span><span class="claim-text" translate="no">Shorter name/);
  assert.doesNotMatch(html, /建议改/);
  assert.ok(html.indexOf('Typo remains') < html.indexOf('Shorter name'), 'must comes before nit');
});

test('a pass with a must finding is a redo; should and nit findings do not block a pass', () => {
  const must = parseReviewVerdict(
    verdict('pass', 'Looks fine', '', { findings: [{ severity: 'must', text: 'Typo remains' }] }),
  )!;
  assert.equal(must.verdict, 'redo');
  const soft = parseReviewVerdict(
    verdict('pass', 'Fine', '', {
      findings: [
        { severity: 'should', text: 'Rename it' },
        { severity: 'nit', text: 'Trailing space' },
      ],
    }),
  )!;
  assert.equal(soft.verdict, 'pass');
});
