import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConversationMessage, RunRecord, Workflow } from '../src/shared/types.ts';
import { failureNotice, noticeMessage, systemNoticeText } from '../src/shared/system-notices.ts';
import { createTranslator } from '../src/shared/i18n/index.ts';
import englishCatalog from '../src/shared/i18n/en.json' with { type: 'json' };

const outcome = (status: 'completed' | 'blocked', summary: string, claims: string[]) =>
  ({
    status,
    source: 'executor-report',
    summary,
    claims: claims.map((claim) => ({ claim, evidence: `${claim}.md` })),
  }) as RunRecord['taskOutcome'];

const runs = [
  { id: 'plan-run', workflowId: 'task' },
  {
    id: 'inventory',
    workflowId: 'task',
    stepId: 'step1',
    taskOutcome: outcome('completed', 'Listed three synthetic projects and their notices.', [
      'Listed folders',
      'Read LICENSE',
    ]),
  },
  {
    id: 'cleanup',
    workflowId: 'task',
    stepId: 'step2',
    status: 'failed',
    taskOutcome: outcome('blocked', 'Stopped: the synthetic licenses require keeping the notices.', [
      'Changed nothing',
    ]),
  },
] as RunRecord[];

const task = {
  id: 'task',
  conversationId: 'conversation',
  status: 'blocked',
  input: {},
  error: '任务尚未完成：Stopped: the synthetic licenses require keeping the notices.',
  runIds: runs.map((run) => run.id),
  plan: [
    { id: 'step1', title: 'Inventory', status: 'completed', runIds: ['inventory'] },
    { id: 'step2', title: 'Remove notices', status: 'failed', runIds: ['cleanup'] },
    { id: 'step3', title: 'Write the letter', status: 'pending', runIds: [] },
  ],
} as unknown as Workflow;

test('each step keeps its own list and summary; a later step never replaces an earlier one', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ClaimsCheck, StepReport, stepClaims, stepSummary } = await import('../src/ui/ClaimsCheck.tsx');
  assert.deepEqual(
    stepClaims(task, task.plan[0]!, runs).map((item) => item.claim),
    ['Listed folders', 'Read LICENSE'],
  );
  assert.deepEqual(
    stepClaims(task, task.plan[1]!, runs).map((item) => item.claim),
    ['Changed nothing'],
  );
  assert.equal(stepSummary(task.plan[0]!, runs), 'Listed three synthetic projects and their notices.');
  assert.equal(stepSummary(task.plan[2]!, runs), undefined);
  // With a plan, the task-level box no longer shows only the last step's list.
  assert.equal(renderToStaticMarkup(createElement(ClaimsCheck, { workflow: task, runs })), '');
  const first = renderToStaticMarkup(
    createElement(StepReport, { workflow: task, step: task.plan[0]!, runs, open: false }),
  );
  assert.match(first, /class="step-summary" translate="no">Listed three synthetic projects/);
  assert.match(first, /<details class="claims-check step-claims">/);
  assert.match(first, /执行器说完成了 2 项/);
  assert.match(first, /Read LICENSE/);
  const latest = renderToStaticMarkup(
    createElement(StepReport, { workflow: task, step: task.plan[1]!, runs, open: true }),
  );
  assert.match(latest, /<details class="claims-check step-claims" open="">/);
  assert.equal(
    renderToStaticMarkup(createElement(StepReport, { workflow: task, step: task.plan[2]!, runs, open: false })),
    '',
  );
});

test('a stop notice says which step stopped and quotes the executor apart from PugPort text', () => {
  const notice = failureNotice(task, runs);
  assert.equal(notice.text, systemNoticeText.incomplete);
  assert.deepEqual(notice.stop, {
    step: 2,
    title: 'Remove notices',
    reason: 'Stopped: the synthetic licenses require keeping the notices.',
  });
  assert.equal(
    createTranslator(englishCatalog)('停在第 {0} 步：{1}'.replace('{0}', '2').replace('{1}', 'Remove notices')),
    'Stopped at step 2: Remove notices',
  );
  // One step: no step number. A blocked run still keeps a non-executor summary; cancellation does not.
  assert.deepEqual(failureNotice({ ...task, plan: [task.plan[1]!] }, runs).stop, {
    reason: 'Stopped: the synthetic licenses require keeping the notices.',
  });
  assert.equal(failureNotice({ ...task, status: 'cancelled' }, runs).stop, undefined);
  const missing = runs.map((run) =>
    run.id === 'cleanup' ? { ...run, taskOutcome: { ...run.taskOutcome!, source: 'missing-report' as const } } : run,
  );
  assert.equal(
    failureNotice({ ...task, plan: [task.plan[1]!] }, missing).stop?.reason,
    'Stopped: the synthetic licenses require keeping the notices.',
  );
});

test('a stop notice saved before this gains the step and reason when shown, without changing the saved one', () => {
  const saved: ConversationMessage = {
    id: 'final',
    conversationId: 'conversation',
    workflowId: 'task',
    role: 'assistant',
    content: systemNoticeText.incomplete,
    createdAt: '2026-10-22T19:42:40Z',
    replyIdentity: { automatic: true, kind: 'system', runs: [] },
    systemNotice: { text: systemNoticeText.incomplete, details: task.error },
  };
  const owner = { ...task, finalMessageId: saved.id };
  const shown = noticeMessage(saved, owner, runs);
  assert.equal(shown.systemNotice?.stop?.step, 2);
  assert.equal(shown.systemNotice?.details, task.error);
  assert.equal(saved.systemNotice?.stop, undefined);
  for (const other of [
    { ...owner, finalMessageId: 'another' },
    { ...owner, status: 'completed' as const },
    { ...owner, conversationId: 'foreign' },
  ])
    assert.equal(noticeMessage(saved, other, runs), saved);
});

test('review findings belong only to the report the reviewer received, not identical claims in earlier steps', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { StepReport, stepClaims } = await import('../src/ui/ClaimsCheck.tsx');
  const repeated = runs.map((run) =>
    run.taskOutcome ? { ...run, taskOutcome: { ...run.taskOutcome, claims: [{ claim: 'Checked files' }] } } : run,
  );
  const reviewed = {
    ...task,
    review: { round: 0, status: 'passed', claims: [{ claim: 'Checked files', status: 'verified' }] },
  } as Workflow;
  assert.equal(stepClaims(reviewed, task.plan[0]!, repeated)[0]?.status, undefined);
  assert.equal(stepClaims(reviewed, task.plan[1]!, repeated)[0]?.status, 'verified');
  const earlier = renderToStaticMarkup(
    createElement(StepReport, { workflow: reviewed, step: task.plan[0]!, runs: repeated, open: false }),
  );
  assert.match(earlier, /未经审核/);
  assert.doesNotMatch(earlier, /审核逐条核对|检查通过/);
});

test('a failure before the next executor starts points to the active step, not the previous result', () => {
  const nextStep = { ...task, activeStepId: 'step3', error: 'No executor available' };
  assert.deepEqual(failureNotice(nextStep, runs).stop, { step: 3, title: 'Write the letter' });
});
