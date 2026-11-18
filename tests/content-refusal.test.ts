import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refusedForContent } from '../src/server/content-refusal.ts';
import { applyTaskJudgment } from '../src/server/one-for-all-policy.ts';

const done = (output: string) => ({ status: 'completed' as const, output });

test('a refusal over adult content or usage policy is recognised, in English and Chinese', () => {
  for (const output of [
    "I can't help with creating sexually explicit content.",
    'I’m unable to continue this story because it describes explicit sexual content.',
    '我已经列出了文件夹。\n\n抱歉，我不能协助整理或描述这些色情内容。',
    '这个请求涉及露骨的成人内容，我无法提供。',
    '根据使用政策，我不能继续生成这类内容。',
  ])
    assert.equal(refusedForContent(done(output)), true, output);
  assert.equal(
    refusedForContent({ status: 'failed', output: '', error: 'Request blocked by content_policy filter' }),
    true,
  );
});

test('a refusal because minors are involved never sends the request to another executor', () => {
  for (const output of [
    'Auto mode blocked this action (Targets appear to be sexual videos involving minors).',
    '这些文件标题显示涉及未成年人的色情内容，我不能处理。',
    '标题含少萝的视频不能处理，这违反使用政策。',
  ])
    assert.equal(refusedForContent(done(output)), false, output);
  assert.equal(refusedForContent({ status: 'failed', output: '', error: 'content_policy: minor safety' }), false);
});

test('ordinary failures and answers about such topics are not refusals', () => {
  for (const output of [
    '目前权限是只读，我无法移动或改名这些文件；请把文件权限切换为可写。',
    "I can't move these files: the folder is read-only.",
    '已整理完成：成人教育资料放进了“学习”文件夹。',
    '没有找到相似的图片。',
    '',
  ])
    assert.equal(refusedForContent(done(output)), false, output);
  assert.equal(refusedForContent({ status: 'failed', output: '', error: 'quota-or-rate-limit' }), false);
  assert.equal(refusedForContent({ status: 'running', output: "I can't help with explicit content." }), false);
});

test('the user’s choice of writable files is honoured for an action the word rules miss', () => {
  const input = {
    content: '结合之前的记录，这个脱敏加分类去重，好好去做吧',
    mode: 'auto' as const,
    permissionMode: 'workspace-write' as const,
    executionPolicy: 'cli-first' as const,
  };
  assert.equal(applyTaskJudgment(input, { status: 'accepted', intent: 'action' }).permissionMode, 'workspace-write');
  assert.equal(
    applyTaskJudgment({ ...input, permissionMode: 'read-only' }, { status: 'accepted', intent: 'action' })
      .permissionMode,
    'read-only',
  );
});
