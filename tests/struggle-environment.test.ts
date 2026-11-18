import assert from 'node:assert/strict';
import { test } from 'node:test';
import { environmentFailure } from '../src/server/workspace.ts';

// Prose cannot classify an environment failure; only host outcome and adapter error codes can.
test('sandbox, permission and unverified results do not count as an executor struggling', () => {
  const partial = (summary: string) => ({
    taskOutcome: { status: 'partial' as const, source: 'executor-report' as const, summary },
  });
  for (const run of [
    { taskOutcome: { status: 'unverified' as const, source: 'file-receipts' as const } },
    { taskOutcome: { status: 'blocked' as const, source: 'native-permission' as const } },
    { errorCode: 'runtime-permission-or-sandbox-error' },
  ])
    assert.equal(environmentFailure(run), true, JSON.stringify(run));
  for (const run of [
    partial('仅完成技能工具说明；技能测试被临时文件重命名 EPERM 阻碍。'),
    partial('创建依赖 junction 遭系统拒绝，需解决写入权限。'),
    partial('此前 git init 遭权限拒绝，按要求未重试。'),
    { error: 'Error: EACCES: permission denied, open .git/index.lock' },
    partial('完成 Codex 错误详情及一项回归测试；其余指定实现、测试、文档和最终检查尚未完成。'),
    { error: 'runtime-timeout' },
    {},
  ])
    assert.equal(environmentFailure(run), false, JSON.stringify(run));
});
