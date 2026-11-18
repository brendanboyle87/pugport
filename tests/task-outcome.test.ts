import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTaskOutcome, taskOutcomeInstruction } from '../src/server/task-outcome.ts';

test('answer-only delivery with verification caveats is completed in both step kinds', () => {
  for (const kind of ['check', 'deliver'] as const) {
    const instruction = taskOutcomeInstruction(kind);
    assert.match(instruction, /只需要回答、不要求修改文件.*答案已经交付.*应报告 completed/);
    assert.match(instruction, /在答案中明确列出未核实的点/);
    assert.match(instruction, /partial 用于本次要求的工作实际尚未做完/);
  }
});

test('delivery requires a deliverable while checks keep their original scope', () => {
  assert.match(taskOutcomeInstruction('check'), /不要把当前检查\/复核步骤扩大/);
  const delivery = taskOutcomeInstruction('deliver');
  assert.match(delivery, /只核对现状、阅读资料或制定计划不算完成/);
  assert.doesNotMatch(delivery, /不要把当前检查\/复核步骤扩大|若本次只要求查看/);
  assert.match(delivery, /不要为取得 completed 状态执行未被要求的写入、移动、删除或其他变更/);
});

test('recoverable file failures and estimated duration do not instruct the executor to stop authorized work', () => {
  assert.match(taskOutcomeInstruction('check'), /达到预计耗时或单个文件读取\/解码出错，不是自行收尾的理由/);
  assert.match(taskOutcomeInstruction('check'), /先保存已完成批次和待处理清单，隔离坏文件/);
  assert.match(taskOutcomeInstruction('check'), /实际停止原因、还缺哪些工作，以及继续需要什么/);
  assert.match(taskOutcomeInstruction('check'), /遇到原生权限拒绝，不重试被拒绝的操作或绕过限制/);
});

test('the outcome prompt allows a completed review without requiring or inventing file changes', () => {
  assert.match(
    taskOutcomeInstruction('check'),
    /只要求查看、复核、分析、生成内容或给出建议.*交付结果即可报告 completed，不需要修改文件/,
  );
  assert.match(taskOutcomeInstruction('check'), /不要为取得 completed 状态执行未被要求的写入、移动、删除或其他变更/);
  assert.doesNotMatch(taskOutcomeInstruction('check'), /仅完成检查代替实际操作/);

  const parsed = parseTaskOutcome(
    '已复核综合结果，列出了重复项和修改建议。\nCOMBORUNNER_TASK_RESULT: {"status":"completed","summary":"本次复核完成，建议已交付。"}',
  );
  assert.equal(parsed.output, '已复核综合结果，列出了重复项和修改建议。');
  assert.deepEqual(parsed.outcome, {
    status: 'completed',
    source: 'executor-report',
    summary: '本次复核完成，建议已交付。',
  });
});

test('completion follows the explicitly requested current step even when the original goal has later work', () => {
  assert.match(taskOutcomeInstruction('check'), /本次当前步骤明确要求的范围和交付物判断结果/);
  assert.match(taskOutcomeInstruction('check'), /不要把当前检查\/复核步骤扩大为完成原始目标的所有后续修改/);

  const parsed = parseTaskOutcome(
    '原始目标是整理文件，本步骤要求检查重复项。已完成重复项清单，后续整理尚未执行。\nCOMBORUNNER_TASK_RESULT: {"status":"completed","summary":"当前检查步骤完成，重复项清单已交付。"}',
  );
  assert.equal(parsed.outcome.status, 'completed');
  assert.equal(parsed.outcome.source, 'executor-report');
  assert.equal(parsed.outcome.summary, '当前检查步骤完成，重复项清单已交付。');
});

test('a requested write remains unfinished when only planning or inspection was done', () => {
  assert.match(
    taskOutcomeInstruction('check'),
    /明确要求实际写入、修改、移动或删除.*只给出计划、口头承诺或完成检查，仍是 partial 或 blocked/,
  );
  assert.match(taskOutcomeInstruction('check'), /不能自行缩小请求范围/);
  assert.match(taskOutcomeInstruction('check'), /权限、工具或路径问题.*明确指出阻碍和已完成部分/);
  assert.match(taskOutcomeInstruction('check'), /不要把此前记录中的状态当作本次执行结果/);

  for (const [status, summary] of [
    ['partial', '已检查待修改文件并给出计划，要求的写入尚未执行。'],
    ['blocked', '写入因权限限制被拒绝，要求的修改未完成。'],
  ]) {
    const parsed = parseTaskOutcome(
      `本次要求保存修改，操作尚未完成。\nCOMBORUNNER_TASK_RESULT: ${JSON.stringify({ status, summary })}`,
    );
    assert.deepEqual(parsed.outcome, { status, source: 'executor-report', summary });
    assert.equal(parsed.output, '本次要求保存修改，操作尚未完成。');
  }
});

test('a final outcome report is stripped, preserving the actual assistant answer and cause', () => {
  const parsed = parseTaskOutcome(
    'The move did not run.\nCOMBORUNNER_TASK_RESULT: {"status":"blocked","summary":"The source path is missing."}\n',
  );
  assert.equal(parsed.output, 'The move did not run.');
  assert.deepEqual(parsed.outcome, {
    status: 'blocked',
    source: 'executor-report',
    summary: 'The source path is missing.',
  });
});

test('plain prose, quoted historical markers, malformed and nonfinal reports are not completion proof', () => {
  for (const output of [
    'The previous attempt did not move anything. This one succeeded.',
    'A quote COMBORUNNER_TASK_RESULT: {"status":"completed"}',
    'COMBORUNNER_TASK_RESULT: {"status":"completed"}\nMore work is needed.',
    'COMBORUNNER_TASK_RESULT: {"status":["completed"]}',
    'COMBORUNNER_TASK_RESULT: {"status":"success"}',
    'COMBORUNNER_TASK_RESULT: bad json',
  ]) {
    const parsed = parseTaskOutcome(output);
    assert.equal(parsed.output, output);
    assert.equal(parsed.outcome.status, 'unverified');
  }
});

test('report statuses are self reports and sensitive summary assignments are redacted', () => {
  for (const status of ['completed', 'partial', 'blocked']) {
    const parsed = parseTaskOutcome(
      `Answer\nCOMBORUNNER_TASK_RESULT: ${JSON.stringify({ status, summary: 'token=sensitive-value; missing report' })}`,
    );
    assert.equal(parsed.outcome.status, status);
    assert.equal(parsed.outcome.source, 'executor-report');
    assert.ok(!parsed.outcome.summary?.includes('sensitive-value'));
  }
});

test('claims come with their evidence, trimmed and capped', () => {
  const { outcome } = parseTaskOutcome(
    `Done.\nCOMBORUNNER_TASK_RESULT: ${JSON.stringify({
      status: 'completed',
      summary: 'ok',
      claims: [
        { claim: ' Added tests ', evidence: ' npm test: 12 passed ' },
        { claim: 'Updated docs', evidence: '' },
        { claim: '', evidence: 'ignored' },
        { nonsense: true },
      ],
    })}`,
  );
  assert.deepEqual(outcome.claims, [
    { claim: 'Added tests', evidence: 'npm test: 12 passed' },
    { claim: 'Updated docs' },
  ]);
});

test('claims keep a reported verified flag and omit it when unreported', () => {
  assert.match(taskOutcomeInstruction('check'), /"verified":true\|false/);
  assert.match(
    taskOutcomeInstruction('check'),
    /每条 claims 标注 "verified"：本次实际运行过测试、命令或检查核实的写 true/,
  );
  assert.match(taskOutcomeInstruction('check'), /未标注按未验证对待，不要把未验证的写成 true/);
  const { outcome } = parseTaskOutcome(
    `Done.\nCOMBORUNNER_TASK_RESULT: ${JSON.stringify({
      status: 'completed',
      claims: [
        { claim: 'Ran the suite', evidence: 'npm test: 12 passed', verified: true },
        { claim: 'Only reasoned', verified: false },
        { claim: 'No flag given', evidence: 'none' },
        { claim: 'Wrong flag type', verified: 'yes' },
      ],
    })}`,
  );
  assert.deepEqual(outcome.claims, [
    { claim: 'Ran the suite', evidence: 'npm test: 12 passed', verified: true },
    { claim: 'Only reasoned', verified: false },
    { claim: 'No flag given', evidence: 'none' },
    { claim: 'Wrong flag type' },
  ]);
});

test('structured file paths survive parsing without inferring them from free-text claims', () => {
  const { outcome } = parseTaskOutcome(
    'Answer.\nCOMBORUNNER_TASK_RESULT: ' +
      JSON.stringify({
        status: 'completed',
        claims: [
          { claim: 'Updated a.ts', files: [' a.ts ', '', null, 2] },
          { claim: 'Explained a.ts', files: 'a.ts' },
          { claim: 'Updated b.ts', verified: true },
        ],
      }),
  );
  assert.deepEqual(outcome.claims, [
    { claim: 'Updated a.ts', files: ['a.ts'] },
    { claim: 'Explained a.ts' },
    { claim: 'Updated b.ts', verified: true },
  ]);
});
