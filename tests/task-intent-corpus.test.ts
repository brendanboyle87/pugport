import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectActionIntent, resolveOneForAllInput } from '../src/server/one-for-all-policy.ts';
import { requestsFileChanges } from '../src/server/task-file-outcome.ts';
import type { MessageInput } from '../src/shared/types.ts';

const corpus = {
  write: [
    '按下面几点改 Mod 的 ui/panel.js 和 panel.css，改完重新打包',
    '修 ui/panel.js，重新打包 Mod',
    '重做 panel.css',
    '按以下要求更新 ui/panel.js',
    '先修 panel.css，然后重新打包',
    '他说：只读，不要改任何文件。改 panel.css。',
    'Rewrite ui/panel.js and repackage the Mod.',
    'Could you rewrite panel.css and repackage the Mod?',
    'Update panel.css; do not change user settings.',
    '改 ui/panel.js。引用：“只读，不要改任何文件”。不要改用户设置。',
    '注意事项：只读文件不要改。修改 ui/panel.js 并重新打包。',
    'Fix panel.css. They said: "read-only, do not change anything".',
    '改 panel.css。\n> 只读，不要改任何文件\n改完重新打包。',
    'Update panel.css.\n```text\nread-only, do not change anything\n```',
  ],
  readOnly: ['只读', '不要改任何文件', 'read-only please', "don't change anything", '本次要求：“只读”'],
  ambiguous: ['继续', '现在呢？', 'Continue', 'What next?'],
};
const input: MessageInput = {
  content: '',
  mode: 'auto',
  permissionMode: 'workspace-write',
  explicitWrite: true,
  executionPolicy: 'cli-first',
};

for (const [kind, messages] of Object.entries(corpus)) {
  test(`follow-up corpus: ${kind}`, () => {
    for (const content of messages) {
      const intent = inspectActionIntent(content);
      if (kind === 'write') {
        assert.equal(intent.explicitAction, true, content);
        assert.equal(intent.prohibitsWrite, false, content);
        assert.equal(requestsFileChanges(content, true), true, content);
      }
      for (const handling of [undefined, 'reply', 'task'] as const) {
        const result = resolveOneForAllInput({
          ...input,
          content,
          routeDecision: handling ? { handling, writes: handling === 'task', plan: false, web: false } : undefined,
        });
        assert.equal(result.permissionMode, 'workspace-write', content);
        if (kind === 'readOnly') {
          assert.ok(result.scopeNote, content);
          assert.equal(
            resolveOneForAllInput({ ...input, content, explicitWrite: false }).permissionMode,
            'read-only',
            content,
          );
        }
        if (kind === 'write') assert.equal(result.mode, 'build', content);
        assert.equal(
          resolveOneForAllInput({ ...input, content, permissionMode: 'read-only' }).permissionMode,
          'read-only',
        );
      }
    }
  });
}

test('adopted quoted requirements still constrain the current action', () => {
  for (const content of [
    'Review panel.css; do not run or edit any files.',
    'Review panel.css; do not execute or write files.',
    '本次只读检查文件，不要修改代码。',
    '请按下面要求执行：\n> 本次只读，不要改任何文件',
    'Follow the following instructions:\n> read-only please',
    '本次要求：\n```text\n不要改任何文件\n```',
  ]) {
    assert.equal(inspectActionIntent(content).prohibitsWrite, true, content);
    assert.equal(resolveOneForAllInput({ ...input, content }).permissionMode, 'workspace-write', content);
    const result = resolveOneForAllInput({
      ...input,
      content,
      routeDecision: { handling: 'task', writes: true, plan: false, web: false },
    });
    assert.equal(result.permissionMode, 'workspace-write', content);
    assert.ok(result.scopeNote, content);
  }
});

test('command restrictions do not erase separately authorized file changes', () => {
  for (const content of ['改 panel.js，不要运行命令', 'Update panel.css; do not run commands.']) {
    const result = resolveOneForAllInput({
      ...input,
      content,
      routeDecision: { handling: 'reply', writes: false, plan: false, web: false },
    });
    assert.equal(result.permissionMode, 'workspace-write', content);
    assert.equal(result.mode, 'build', content);
    assert.equal(result.routeDecision?.writes, true, content);
    assert.ok(result.scopeNote, content);
  }
});

test('whole-clause stops narrow ungranted tasks while explicit grants keep scope notes', () => {
  for (const separator of ['，', '。', '；', ',', ';', '\n']) {
    for (const explicitWrite of [false, true]) {
      const result = resolveOneForAllInput({
        ...input,
        content: `不要改任何文件${separator}检查项目`,
        explicitWrite,
        routeDecision: { handling: 'task', writes: true, plan: false, web: false },
      });
      assert.equal(result.permissionMode, explicitWrite ? 'workspace-write' : 'read-only');
      assert.ok(explicitWrite ? result.scopeNote : result.readOnlyTrigger);
    }
  }
});
