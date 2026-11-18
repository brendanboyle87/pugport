import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TaskContinuationProgress,
  fileSafeBridgeTools,
  hasContinuationProgress,
  recordContinuation,
} from '../src/server/task-continuation.ts';
import { readOnlyBridgeToolNames } from '../src/server/agent-bridge.ts';
import type { RunEvent, RunRecord } from '../src/shared/types.ts';

const run = (extra: Partial<RunRecord> = {}): RunRecord => ({
  id: 'run',
  prompt: 'Finish the synthetic task',
  projectPath: '/fixture',
  kind: 'general',
  status: 'failed',
  route: { runtimeId: 'mock', model: 'mock', reasons: [], warnings: [], kind: 'general' },
  startedAt: new Date().toISOString(),
  nativeSessionId: 'session',
  output: 'First batch completed.',
  events: [],
  permissionMode: 'workspace-write',
  error: '任务尚未完成：More batches remain.',
  taskOutcome: { status: 'partial', source: 'executor-report', summary: 'More batches remain.' },
  ...extra,
});
const budget = () => ({ count: 0, reports: new Set<string>(), tools: new Set<string>() });
const tool = (data: Record<string, unknown>): RunEvent => ({ at: new Date().toISOString(), type: 'tool', data });
const completed = (id = 'one') => tool({ itemId: id, kind: 'commandExecution', status: 'completed', exitCode: 0 });

test('same-session terminal progress accepts only explicit settled results and read-only failures', () => {
  for (const [command, expected] of [
    ['rg missing src', true],
    ['rg -m 1 missing src', true],
    ['powershell.exe -Command "rg missing src"', true],
    ["bash -lc 'npm test'", true],
    ['cmd /c "npm run typecheck"', true],
    ['npm run lint', true],
    ['npm test | tail', false],
    ['npm test > result.txt', false],
    ['npm test < input.txt', false],
    ['npm test && git commit -am test', false],
    ['rg missing; Remove-Item data', false],
    ['rg missing\nRemove-Item data', false],
    ['rg missing ' + 'x'.repeat(120) + '; Remove-Item data', false],
    ['git reset --hard', false],
    ['write_file test.txt', false],
    ['node write.js test', false],
    ['npm exec write test', false],
    ['npm run lint -- --fix', false],
    ['git branch -D feature', false],
    ['git diff --output=result.txt', false],
    ['powershell -Command "Get-ChildItem (Remove-Item -Recurse src)"', false],
    ['Get-ChildItem @(Remove-Item src)', false],
    ['rg --pre rm x .', false],
    ['fd . -x rm', false],
    ['git grep -O pattern', false],
    ['git grep --open-files-in-pager=vim pattern', false],
    ['git diff --ext-diff', false],
    ['tree -o out.txt', false],
    ['npx check', false],
    ['npm run lint:fix', false],
    ['npm run test:publish', false],
    ['vitest --update', false],
    ['node --test --test-update-snapshots', false],
    ['eslint -o report.txt src', false],
    ['tsc', false],
    ['tsc --noEmit', true],
    ['grep -R missing src', true],
    ['git status --short', true],
  ] as const) {
    const progress = new TaskContinuationProgress();
    progress.observe(completed());
    progress.observe(tool({ itemId: 'check', kind: 'commandExecution', status: 'inProgress', command }));
    progress.observe(tool({ itemId: 'check', status: 'completed', exitCode: 1 }));
    assert.equal(progress.terminal(run()), expected, command);
    assert.equal(hasContinuationProgress(run(), progress, budget()), expected, command);
    assert.deepEqual(progress.completed(run()), [], 'cross-account proof stays strict');
  }
  for (const status of ['inProgress', 'unknown', 'waiting', 'cancelled', 'interrupted', 'declined', 'rejected']) {
    const progress = new TaskContinuationProgress();
    progress.observe(
      tool({ itemId: 'check', kind: 'commandExecution', command: 'rg missing', status, exitCode: 1, isError: true }),
    );
    assert.equal(progress.terminal(run()), false, status);
  }
  for (const data of [
    { kind: 'nativeToolCall', nativeTool: 'Read', status: 'failed', isError: true },
    { kind: 'commandExecution', command: 'npm test', status: 'failed' },
  ]) {
    const progress = new TaskContinuationProgress();
    progress.observe(tool({ itemId: 'check', ...data }));
    assert.equal(progress.terminal(run()), true);
    assert.equal(hasContinuationProgress(run(), progress, budget()), true, 'no successful write is required');
    progress.observe({ at: '', type: 'approval' });
    assert.equal(progress.terminal(run()), false);
  }
});

test('same-session terminal progress needs reported tools and refuses sandbox-limited failures', () => {
  const none = new TaskContinuationProgress();
  assert.equal(none.terminal(run({ hadToolActivity: false })), true, 'a turn with no tools at all ended');
  assert.equal(none.terminal(run({ hadToolActivity: true })), false, 'unreported tool activity is not proof');
  const limited = new TaskContinuationProgress();
  limited.observe(tool({ itemId: 'rm', kind: 'commandExecution', status: 'inProgress', command: 'node clean.js' }));
  limited.observe(
    tool({ itemId: 'rm', status: 'failed', exitCode: 1, output: 'EPERM: operation not permitted, symlink' }),
  );
  assert.equal(limited.terminal(run()), false, 'a write the sandbox refused may have done part of its work');
});

test('same-session eligibility follows structured status, never summary wording', () => {
  const blocked = [
    '缺少 API 凭据',
    '没有密钥',
    '未配置令牌',
    '缺少登录',
    'not logged in',
    'not authenticated',
    'missing credentials',
    'missing api key',
    'missing token',
    '需要主人决定用哪个方案',
    '删除旧数据前需要你先确认',
    '需要你来决定',
    '需要用户手动确认',
    '未登录',
    '登录已过期',
    '需要重新登录',
    'requires user approval',
    'login required',
    'token expired',
    '需要用户确认',
    '需要你选择',
    '需要主人批准',
    '等用户确认',
    '等待主人确认',
    "needs the owner's decision",
    'need user confirmation',
    'needs owner approval',
    '方案待你拍板',
    '请先选择目标账号',
  ];
  const allowed = [
    '没有被权限拒绝',
    '不需要用户确认',
    '无需主人批准',
    '并不需要你选择',
    '没有缺少凭据',
    'does not need user confirmation',
  ];
  for (const status of ['partial', 'blocked'] as const)
    for (const summary of [...blocked, ...allowed]) {
      const progress = new TaskContinuationProgress();
      progress.observe(completed());
      assert.equal(
        hasContinuationProgress(
          run({ taskOutcome: { source: 'executor-report', status, summary } }),
          progress,
          budget(),
        ),
        // A blocked report is the executor naming a real obstacle: it never continues on its own.
        status === 'partial',
        `${status}: ${summary}`,
      );
    }
});

test('same-session eligibility retains run, output, verification and error gates', () => {
  const progress = new TaskContinuationProgress();
  progress.observe(completed());
  for (const patch of [
    { status: 'completed' },
    { errorCode: 'runtime-timeout' },
    { nativeSessionId: undefined },
    { output: '' },
    { error: '原生工具拒绝原因' },
    { taskOutcome: { status: 'partial', source: 'missing-report' } },
    { taskOutcome: { status: 'partial', source: 'executor-report', summary: ' ' } },
    { verification: { status: 'failed' } },
  ] as Partial<RunRecord>[])
    assert.equal(hasContinuationProgress(run(patch), progress, budget()), false, JSON.stringify(patch));
});

for (const status of ['failed', 'interrupted', 'inProgress'])
  for (const name of ['github_create_pull_request', 'github_list_issues'])
    test(`GitHub continuation uses the actual read-only tool list: ${name} ${status}`, () => {
      const progress = new TaskContinuationProgress(['github_list_issues']);
      progress.observe(completed());
      progress.observe(tool({ itemId: 'github', kind: 'mcpToolCall', server: 'pugport', tool: name, status }));
      const read = name === 'github_list_issues';
      assert.equal(progress.unconfirmedChanges(run()), !read);
      assert.equal(hasContinuationProgress(run(), progress, budget()), read && status === 'failed');
      assert.equal(progress.handoffState(run()).safe, read && status !== 'inProgress');
    });

test('without a GitHub connection even an unknown read tool is conservatively a write', () => {
  const progress = new TaskContinuationProgress();
  progress.observe(completed());
  progress.observe(
    tool({ itemId: 'github', kind: 'mcpToolCall', server: 'pugport', tool: 'github_list_issues', status: 'failed' }),
  );
  assert.equal(hasContinuationProgress(run(), progress, budget()), false);
  assert.equal(progress.unconfirmedChanges(run()), true);
});

test('continuation needs settled results but does not require a successful tool', () => {
  const progress = new TaskContinuationProgress();
  assert.equal(hasContinuationProgress(run(), progress, budget()), true);
  progress.observe(tool({ itemId: 'one', kind: 'commandExecution', status: 'inProgress' }));
  assert.equal(hasContinuationProgress(run(), progress, budget()), false);
  progress.observe(tool({ itemId: 'one', kind: 'commandExecution', status: 'completed' }));
  assert.equal(hasContinuationProgress(run(), progress, budget()), false, 'missing exit code is not success');
  progress.observe(completed());
  assert.equal(hasContinuationProgress(run(), progress, budget()), true);
});

test('handoff requires terminal native outcomes even for read-only errors and distinguishes safe text from unverified write claims', () => {
  const empty = new TaskContinuationProgress();
  assert.equal(empty.handoffState(run({ permissionMode: 'read-only', hadToolActivity: false })).safe, true);
  assert.equal(empty.handoffState(run({ hadToolActivity: false })).blockedReason, 'missing-checkpoint');
  assert.equal(
    empty.handoffState(run({ permissionMode: 'read-only', hadToolActivity: true })).blockedReason,
    'missing-checkpoint',
  );
  const progress = new TaskContinuationProgress();
  progress.observe(
    tool({
      itemId: 'read',
      kind: 'mcpToolCall',
      server: 'pugport',
      tool: 'read_document',
      status: 'inProgress',
      isError: true,
    }),
  );
  const pending = progress.handoffState(run({ permissionMode: 'read-only' }));
  assert.equal(pending.safe, false, 'an error flag is not a terminal outcome');
  assert.deepEqual(pending.unconfirmedTools, [{ id: 'read', status: 'inProgress' }]);
  progress.observe(
    tool({ itemId: 'read', kind: 'mcpToolCall', server: 'pugport', tool: 'read_document', status: 'failed' }),
  );
  assert.equal(progress.handoffState(run({ permissionMode: 'read-only' })).safe, true);
  progress.observe({ at: '', type: 'status', data: { decision: 'deny' } });
  assert.equal(progress.handoffState(run({ permissionMode: 'read-only' })).blockedReason, 'untrusted-progress');
});

test('host audit supplements neither poison native progress nor prove tool completion', () => {
  const audit = tool({ hostAudit: true, tool: 'organize_files', journal: 'synthetic-journal', moved: 1 });
  const progress = new TaskContinuationProgress();
  progress.observe(audit);
  assert.equal(hasContinuationProgress(run(), progress, budget()), true);
  progress.observe(tool({ itemId: 'native-mcp', kind: 'mcpToolCall', status: 'inProgress' }));
  progress.observe(audit);
  assert.equal(hasContinuationProgress(run(), progress, budget()), false);
  progress.observe(tool({ itemId: 'native-mcp', kind: 'mcpToolCall', status: 'completed' }));
  assert.equal(hasContinuationProgress(run(), progress, budget()), true);
  progress.observe(tool({ tool: 'organize_files', journal: 'unknown-origin' }));
  assert.equal(hasContinuationProgress(run(), progress, budget()), false);

  const denied = new TaskContinuationProgress();
  denied.observe(completed());
  denied.observe(tool({ hostAudit: true, executionBlocked: true }));
  assert.equal(hasContinuationProgress(run(), denied, budget()), false);
});

test('an unmapped native error blocks the checkpoint used by both technical and visual handoff', () => {
  const progress = new TaskContinuationProgress();
  progress.observe({
    at: '',
    type: 'status',
    data: { source: 'native', kind: 'protocol-unmapped', relayBlocked: true },
  });
  for (let i = 0; i < 1200; i++) progress.observe({ at: '', type: 'text', text: 'fixture progress' });
  for (const errorCode of ['runtime-request-failed', 'runtime-image-input-unavailable', 'quota-or-rate-limit']) {
    const failed = run({ output: '', permissionMode: 'read-only', error: errorCode, errorCode });
    assert.equal(progress.handoffState(failed).safe, false, errorCode);
    assert.equal(progress.handoffState(failed).blockedReason, 'untrusted-progress');
    assert.equal(hasContinuationProgress(failed, progress, budget()), false);
  }
});

test('native denials and uncertain failures cannot disappear behind a truncated text log', () => {
  for (const blocked of [
    { type: 'status', data: { decision: 'deny' } },
    { type: 'error', data: { executionBlocked: true, reason: 'permission' } },
    { type: 'status', data: { steeringPhase: 'failed' } },
    { type: 'approval' },
    { type: 'error', text: 'runtime-request-failed' },
  ] as Partial<RunEvent>[]) {
    const progress = new TaskContinuationProgress();
    progress.observe({ at: new Date().toISOString(), type: 'status', ...blocked });
    for (let i = 0; i < 1200; i++) progress.observe({ at: '', type: 'text', text: 'progress' });
    progress.observe(completed());
    progress.observe({ at: '', type: 'error', text: run().error });
    assert.equal(hasContinuationProgress(run(), progress, budget()), false);
  }
});

test('read-only failures can be isolated, but writable shell failures and nonzero exit codes cannot', () => {
  for (const failure of [
    { itemId: 'bad', kind: 'commandExecution', status: 'failed' },
    { itemId: 'bad', kind: 'commandExecution', status: 'completed', exitCode: 1 },
  ]) {
    const progress = new TaskContinuationProgress();
    progress.observe(completed());
    progress.observe(tool(failure));
    assert.equal(hasContinuationProgress(run(), progress, budget()), false);
    assert.equal(hasContinuationProgress(run({ permissionMode: 'read-only' }), progress, budget()), true);
  }
  for (const name of ['read_document', 'git', 'github_list_issues'])
    for (const server of ['pugport', 'untrusted']) {
      const progress = new TaskContinuationProgress(['github_list_issues']);
      progress.observe(completed());
      progress.observe(tool({ itemId: 'bad', kind: 'mcpToolCall', server, tool: name, status: 'failed', exitCode: 1 }));
      assert.equal(hasContinuationProgress(run(), progress, budget()), server === 'pugport');
    }
});

test('permission and capability prose cannot turn a structured partial into blocked', () => {
  const summaries = [
    '已找到重复文件，当前只读权限无法回收。',
    '当前只读模式，不能修改或删除文件。',
    '权限不足，回收尚未执行。',
    '缺少写入权限，剩余目录无法移动。',
    '临时写入被策略拒绝。',
    '抽帧写入曾被策略拒绝，当前无只读画面对比工具。',
    '当前没有工具完成后续画面对比。',
    '不具备视频解码能力，无法完成剩余检查。',
    '所需工具当前不可用。',
    'The current session is read-only and cannot recycle these files.',
    'Cannot write the extracted frames because the sandbox is read-only.',
    'Permission denied while recycling the remaining directories.',
    'Insufficient write permissions; the remaining files are unchanged.',
    'Auto mode blocked this action.',
    'Temporary frame writes were rejected by the policy.',
    'No read-only video comparison tool is available.',
    'I do not have the required capability.',
    'The required tools are unavailable.',
  ];
  for (const summary of summaries) {
    const progress = new TaskContinuationProgress();
    progress.observe(
      tool({ itemId: 'scan', kind: 'mcpToolCall', server: 'pugport', tool: 'find_duplicates', status: 'completed' }),
    );
    assert.equal(
      hasContinuationProgress(
        run({ taskOutcome: { status: 'partial', source: 'executor-report', summary } }),
        progress,
        budget(),
      ),
      true,
      summary,
    );
  }
});

test('time budgets, isolated bad files and ordinary read-only progress remain resumable', () => {
  const summaries = [
    '本轮时间耗尽，已处理第一批，剩余文件待检查。',
    '已超过预计时间，保存了待处理清单。',
    '单个视频解码失败，已跳过损坏文件，其余视频尚待检查。',
    '部分文件格式不支持，其他文件继续处理。',
    '当前只读检查已完成一半，剩余目录尚未扫描。',
    '临时写入未被策略拒绝，第一批完成，剩余待处理。',
    '尚未使用工具检查第二批文件。',
    'The time budget was exhausted; further batches remain.',
    'One file failed to decode; it was isolated and other files remain.',
    'Read-only inspection is halfway done; the remaining folders still need scanning.',
    'The operation was not blocked by the policy; additional batches remain.',
  ];
  for (const summary of summaries) {
    const progress = new TaskContinuationProgress();
    progress.observe(completed());
    assert.equal(
      hasContinuationProgress(
        run({ taskOutcome: { status: 'partial', source: 'executor-report', summary } }),
        progress,
        budget(),
      ),
      true,
      summary,
    );
  }
  const progress = new TaskContinuationProgress();
  progress.observe(completed());
  assert.equal(
    hasContinuationProgress(
      run({ output: 'Earlier context: frame writes were rejected by the policy.' }),
      progress,
      budget(),
    ),
    true,
    'historical prose outside the current outcome summary is not a current blocker',
  );
});

test('a seen report stops continuation; new tool IDs are optional and two continuations is the limit', () => {
  const progress = new TaskContinuationProgress();
  progress.observe(completed());
  const state = budget();
  assert.equal(hasContinuationProgress(run(), progress, state), true);
  recordContinuation(run(), progress, state);
  assert.equal(hasContinuationProgress(run(), progress, state), false);
  const next = run({ taskOutcome: { status: 'partial', source: 'executor-report', summary: 'One batch remains.' } });
  assert.equal(hasContinuationProgress(next, progress, state), true);
  progress.observe(completed('two'));
  assert.equal(hasContinuationProgress(next, progress, state), true);
  recordContinuation(next, progress, state);
  progress.observe(completed('three'));
  assert.equal(
    hasContinuationProgress(
      run({ taskOutcome: { status: 'partial', source: 'executor-report', summary: 'Last item.' } }),
      progress,
      state,
    ),
    false,
  );
});

test('excessive event identities disable continuation without interrupting the original run', () => {
  const progress = new TaskContinuationProgress();
  for (let i = 0; i < 4097; i++) progress.observe(completed(String(i)));
  assert.equal(hasContinuationProgress(run(), progress, budget()), false);
  const errors = new TaskContinuationProgress();
  errors.observe(completed());
  for (let i = 0; i < 17; i++) errors.observe({ at: '', type: 'error', text: `error-${i}` });
  assert.equal(hasContinuationProgress(run(), errors, budget()), false);
});

test('every bridge tool that declares itself read-only counts as file-safe, so its failure never blocks a continuation', () => {
  assert.ok(readOnlyBridgeToolNames.length > 5);
  for (const name of readOnlyBridgeToolNames) assert.ok(fileSafeBridgeTools.has(name), `${name} is missing`);
  for (const name of ['recycle_files', 'organize_files', 'undo_organize', 'manage_conversations'])
    assert.equal(fileSafeBridgeTools.has(name), false);
  // A failed lookup of a sub-task result (as seen live) is not an unconfirmed write.
  const progress = new TaskContinuationProgress();
  progress.observe(completed());
  progress.observe(
    tool({
      toolCallId: 'lookup',
      kind: 'mcpToolCall',
      server: 'pugport',
      tool: 'get_result',
      status: 'failed',
      isError: true,
    }),
  );
  assert.equal(progress.unconfirmedChanges(run()), false);
  assert.deepEqual(progress.handoffState(run()).unconfirmedTools, []);
});

test('conversation metadata failures are safe to continue, but pending, denied or mutating calls are not', () => {
  for (const name of ['list_conversations', 'manage_conversations']) {
    const progress = new TaskContinuationProgress();
    progress.observe(completed());
    progress.observe(
      tool({ itemId: 'conversations', kind: 'mcpToolCall', server: 'pugport', tool: name, status: 'inProgress' }),
    );
    assert.equal(hasContinuationProgress(run(), progress, budget()), false);
    assert.equal(progress.handoffState(run()).safe, false);
    progress.observe(tool({ itemId: 'conversations', status: 'failed', isError: true }));
    const readOnly = name === 'list_conversations';
    assert.equal(progress.unconfirmedChanges(run()), !readOnly);
    assert.equal(hasContinuationProgress(run(), progress, budget()), readOnly);
    assert.equal(progress.handoffState(run()).safe, readOnly);
    progress.observe({ at: '', type: 'status', data: { decision: 'deny' } });
    assert.equal(hasContinuationProgress(run(), progress, budget()), false);
    assert.equal(progress.handoffState(run()).blockedReason, 'untrusted-progress');
  }
});

test('environment-failed commands are not unconfirmed writes; real failures remain strict', () => {
  for (const output of ['listen EACCES', 'EPERM: junction']) {
    const progress = new TaskContinuationProgress();
    progress.observe(tool({ itemId: 'write', kind: 'fileChange', status: 'completed' }));
    progress.observe(
      tool({ itemId: 'check', kind: 'commandExecution', input: { command: 'npm test' }, status: 'inProgress' }),
    );
    progress.observe(tool({ itemId: 'check', status: 'failed', exitCode: 1, output }));
    assert.equal(progress.unconfirmedChanges(run()), false);
    assert.deepEqual(progress.handoffState(run()).unconfirmedTools, []);
    assert.equal(progress.handoffState(run()).safe, true);
    assert.deepEqual(progress.completed(run()), ['write']);
    for (const data of [
      { itemId: 'bad', kind: 'fileChange', status: 'failed', output },
      { itemId: 'bad', kind: 'fileChange', status: 'inProgress', output },
      { itemId: 'bad', kind: 'commandExecution', status: 'failed', output: 'unknown error' },
      { itemId: 'bad', kind: 'commandExecution', status: 'inProgress', output },
    ]) {
      const strict = new TaskContinuationProgress();
      strict.observe(tool(data));
      assert.equal(strict.unconfirmedChanges(run()), true);
      assert.equal(strict.handoffState(run({ errorCode: 'quota-or-rate-limit' })).safe, false);
    }
  }
});

test('later identical command success settles an earlier failure, not the reverse or another command', () => {
  const progress = new TaskContinuationProgress();
  const command = (id: string, cmd: string, exitCode: number) =>
    tool({ itemId: id, kind: 'commandExecution', input: { cmd }, status: 'completed', exitCode });
  progress.observe(command('fail', 'npm test', 1));
  progress.observe(command('other', 'npm test --other', 0));
  assert.equal(progress.unconfirmedChanges(run()), true);
  progress.observe(command('pass', '  npm test\r\n', 0));
  assert.equal(progress.unconfirmedChanges(run()), false);
  assert.equal(progress.handoffState(run()).safe, true);
  progress.observe(command('last', 'npm test', 1));
  assert.equal(progress.unconfirmedChanges(run()), true);
  assert.equal(progress.handoffState(run()).safe, false);
});

test('a failed write command later rerun successfully does not stop same-session continuation', () => {
  const progress = new TaskContinuationProgress();
  progress.observe(tool({ itemId: 'first', kind: 'commandExecution', status: 'inProgress', command: 'node build.js' }));
  progress.observe(tool({ itemId: 'first', status: 'completed', exitCode: 1 }));
  assert.equal(progress.terminal(run()), false);
  progress.observe(tool({ itemId: 'again', kind: 'commandExecution', status: 'inProgress', command: 'node build.js' }));
  progress.observe(tool({ itemId: 'again', status: 'completed', exitCode: 0 }));
  assert.equal(progress.terminal(run()), true);
});

test('a later successful write of the same path retires the earlier file failure', () => {
  const progress = new TaskContinuationProgress();
  const write = (id: string, path: string, status: string) =>
    tool({ itemId: id, kind: 'fileChange', status, input: { changes: [{ path }] } });
  progress.observe(write('fail', 'result.txt', 'failed'));
  assert.equal(progress.unconfirmedChanges(run()), true);
  progress.observe(write('ok', 'result.txt', 'completed'));
  assert.equal(progress.unconfirmedChanges(run()), false);
  assert.deepEqual(progress.completed(run()), ['ok']);
  assert.equal(progress.terminal(run()), true, 'a retired write failure does not stop same-session continuation');
  const missing = new TaskContinuationProgress();
  missing.observe(tool({ itemId: 'bad', kind: 'fileChange', status: 'failed' }));
  missing.observe(write('other', 'result.txt', 'completed'));
  assert.equal(missing.unconfirmedChanges(run()), true);
  assert.equal(missing.terminal(run()), false);
  const shell = new TaskContinuationProgress();
  shell.observe(tool({ itemId: 'cmd', kind: 'commandExecution', status: 'failed', output: 'nope' }));
  shell.observe(write('file', 'result.txt', 'completed'));
  assert.equal(shell.unconfirmedChanges(run()), true);
});

test('tool-reported partial continues settled writes but reporting alone is not read progress', () => {
  const record = run({ taskOutcome: { status: 'partial', source: 'executor-tool', summary: 'More work remains' } });
  const progress = new TaskContinuationProgress();
  progress.observe(
    tool({ itemId: 'report', kind: 'mcpToolCall', server: 'pugport', tool: 'report_outcome', status: 'completed' }),
  );
  assert.equal(hasContinuationProgress(record, progress, budget()), true);
  assert.equal(hasContinuationProgress({ ...record, permissionMode: 'read-only' }, progress, budget()), false);
  progress.observe(completed('real-work'));
  assert.equal(hasContinuationProgress({ ...record, permissionMode: 'read-only' }, progress, budget()), true);
  for (const status of ['blocked', 'failed', 'dropped'] as const)
    assert.equal(
      hasContinuationProgress({ ...record, taskOutcome: { ...record.taskOutcome!, status } }, progress, budget()),
      false,
    );
});

test('host-proven unexecuted Pi command permits handoff but uncertain tools still block it', () => {
  const p = new TaskContinuationProgress();
  p.observe(tool({ toolCallId: 'denied', tool: 'powershell', status: 'inProgress' }));
  p.observe(tool({ toolCallId: 'denied', tool: 'powershell', status: 'failed', commandNotExecuted: true }));
  assert.equal(p.handoffState(run()).safe, true);
  p.observe(tool({ toolCallId: 'other', tool: 'write', status: 'inProgress' }));
  assert.equal(p.handoffState(run()).safe, false);
});
