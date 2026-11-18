import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fictionContext, novelRequest, writingRequest } from '../src/shared/fiction.ts';

test('explicit chapter writing keeps its intent when the plot mentions software', () => {
  for (const text of [
    '续写第三章，人物是一位程序员。',
    '续写第三章：人物是一位程序员。',
    '润色第二章，保留对白里的登录失败提示。',
    '润色第二章:保留对白里的登录提示。',
    '重写第三章的对白。她提到测试失败，但不想告诉同事。',
    '改写这段小说，人物按下按钮以后发现权限不足。',
  ]) {
    assert.equal(writingRequest(text), true, text);
    assert.equal(novelRequest(text), true, text);
    assert.equal(fictionContext({}, {}, text), true, text);
  }
});

test('a review with technical plot details offers fiction tools without starting a writing test', () => {
  const text = '审核第三章的对白，人物说登录失败这一句自然吗？';
  assert.equal(writingRequest(text), false);
  assert.equal(novelRequest(text), true);
  assert.equal(fictionContext({}, {}, text), true);
});

test('software tasks using fiction words still do not become novel tasks', () => {
  for (const text of [
    '修改小说管理页面的登录 bug',
    '帮我写登录场景的测试',
    '重写角色权限组件',
    '审核小说管理接口的代码',
    '修改小说管理页面，增加一个章节按钮',
    '写个脚本清理日志',
  ]) {
    assert.equal(writingRequest(text), false, text);
    assert.equal(novelRequest(text), false, text);
    assert.equal(fictionContext({}, {}, text), false, text);
  }
});
