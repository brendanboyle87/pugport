import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MessageInput } from '../src/shared/types.ts';
import {
  applyTaskJudgment,
  globalReadOnlyTrigger,
  inspectActionIntent,
  resolveOneForAllInput,
} from '../src/server/one-for-all-policy.ts';

const input: MessageInput = {
  content: '',
  mode: 'auto',
  permissionMode: 'workspace-write',
  executionPolicy: 'cli-first',
  verificationCommand: 'npm test',
};
const action = { status: 'accepted', intent: 'action' } as const;

test('questions with stray trailing punctuation remain direct replies', () => {
  for (const suffix of ['、', '，', ',', '~', '～', '、，,~～  ', ')', '）']) {
    const content = `租一张B200的卡，每小时多少美元，我作为个人能租到吗${suffix}`;
    const result = resolveOneForAllInput({ ...input, content });
    assert.equal(result.mode, 'chat', content);
    assert.equal(result.verificationCommand, undefined);
    assert.equal(applyTaskJudgment({ ...input, content }, action).mode, 'chat');
  }
  assert.equal(resolveOneForAllInput({ ...input, content: '修改文件并保存、' }).mode, 'build');
});

test('scoped prohibitions preserve writable tasks and their test command', () => {
  for (const content of [
    `Implement X and add tests. You have explicit write permission.
Do not edit src/shared/i18n/en.json.
node_modules and .runtime are directory junctions: never delete through them.
Do not commit. Do not build or restart the app.`,
    '把登录页改好看，但别动 config 文件',
    '修改登录页，但不要修改 config 文件。',
    '修复 lexer，但不要修改 lexer 的公开接口。',
    '实现功能并新增测试，不要提交，不要推送，不要构建，不要重启，不要部署。',
    "Fix the bug but don't modify the public API.",
    'Fix the bug; do not edit en.json.',
    'Fix the bug; do not write or modify en.json.',
    'Fix the bug; do not edit or delete the files in src/generated.',
    'Fix the bug; do not edit file.ts or code.ts.',
    '修复登录页，不要修改文件.txt。',
    'Fix the bug; do not edit the files in src/generated.',
    'Implement X; do not change the config file; never delete node_modules.',
    'Add tests; do not modify existing tests.',
    'Fix the bug; do not run the build; do not execute the deployment script.',
    'Fix the bug; do not make changes to the public API.',
    '修复登录页，只看不改 config 文件。',
    '修复登录页，不改 config 文件。',
    'Do not edit src/shared/i18n/en.json. Implement X and add tests.',
  ]) {
    assert.equal(inspectActionIntent(content).prohibitsWrite, false, content);
    for (const mode of ['auto', 'build'] as const) {
      for (const result of [
        resolveOneForAllInput({ ...input, content, mode }),
        applyTaskJudgment({ ...input, content, mode }, action),
      ]) {
        assert.equal(result.permissionMode, 'workspace-write', content);
        assert.equal(result.mode, 'build', content);
        assert.equal(result.verificationCommand, input.verificationCommand, content);
      }
      assert.equal(
        resolveOneForAllInput({ ...input, content, mode, permissionMode: 'read-only' }).permissionMode,
        'read-only',
        content,
      );
    }
  }
});

test('whole-message stops narrow remembered permissions in auto and build; embedded stops stay scope notes', () => {
  for (const content of [
    '不要改任何文件',
    '先别改',
    '只看不改',
    '只读',
    "don't change anything",
    'do not make any changes',
    "don't edit the files",
    'read-only',
    'no file changes',
    '先别改任何文件，给我方案；实现登录页。',
    '修改登录页，但不要改任何文件。',
    'Implement X and add tests; do not edit en.json; do not make any changes.',
    "Don't change anything. Fix the bug but don't modify the public API.",
    'Fix the bug; no file changes.',
    'Fix the bug; read-only.',
    'Create a document, but do not write or modify files.',
    'Fix the bug; never edit and delete any files.',
    'Create an example without writing or modifying code.',
  ]) {
    assert.equal(inspectActionIntent(content).prohibitsWrite, true, content);
    assert.equal(inspectActionIntent(content).explicitAction, false, content);
    for (const mode of ['auto', 'build'] as const) {
      for (const result of [
        resolveOneForAllInput({ ...input, content, mode }),
        applyTaskJudgment({ ...input, content, mode }, action),
      ]) {
        assert.equal(
          result.permissionMode,
          mode === 'auto' && globalReadOnlyTrigger(content) ? 'read-only' : 'workspace-write',
          content,
        );
        assert.ok(result.scopeNote || result.readOnlyTrigger, content);
      }
      for (const result of [
        resolveOneForAllInput({ ...input, content, mode, permissionReauthorized: true }),
        applyTaskJudgment({ ...input, content, mode, permissionReauthorized: true }, action),
      ]) {
        assert.equal(result.permissionMode, 'workspace-write', content);
        assert.equal(result.readOnlyTrigger, undefined, content);
        assert.ok(result.scopeNote, content);
      }
    }
  }
});

test('embedded Chinese stop instructions become scope notes while executor preferences remain writable', () => {
  for (const content of [
    '不要改，只查看。',
    '先不要改，只检查分类结果。',
    '只看不改，这次。',
    '你先看看正文，不改。',
    '别改这些文件。',
    '保持只读，先检查。',
    '这次只读模式。',
  ]) {
    assert.equal(inspectActionIntent(content).prohibitsWrite, true, content);
    assert.equal(resolveOneForAllInput({ ...input, content }).permissionMode, 'workspace-write', content);
    assert.equal(applyTaskJudgment({ ...input, content }, action).permissionMode, 'workspace-write', content);
  }
  for (const content of [
    '别改用 Claude，继续修改 README.md。',
    '不要改变执行器，继续整理文件。',
    '检查文档的只读属性，然后更新报告。',
  ]) {
    assert.equal(inspectActionIntent(content).prohibitsWrite, false, content);
    assert.equal(resolveOneForAllInput({ ...input, content }).permissionMode, 'workspace-write', content);
  }
});

test('read-only inspection wording becomes scope notes without confusing descriptive file attributes', () => {
  for (const content of [
    '先只读检查。',
    '本次只读查看文件。',
    '这次只读分析问题。',
    '当前只读审查代码。',
    '暂时只读审核文档。',
    '只读核对现有结果。',
    '本次先只读检查这个目录。',
    '查看任务结果，当前暂时只读核对文件。',
  ]) {
    assert.equal(inspectActionIntent(content).prohibitsWrite, true, content);
    assert.equal(
      resolveOneForAllInput({ ...input, content, mode: 'build' }).permissionMode,
      'workspace-write',
      content,
    );
    assert.equal(applyTaskJudgment({ ...input, content }, action).permissionMode, 'workspace-write', content);
  }
  for (const content of [
    '文件有只读属性，更新检查报告。',
    '读取只读文件，然后生成报告。',
    '检查文档的只读属性，然后更新报告。',
    '实现只读检查功能。',
    '先只读取配置，再修改测试。',
  ]) {
    assert.equal(inspectActionIntent(content).prohibitsWrite, false, content);
    assert.equal(
      resolveOneForAllInput({ ...input, content, mode: 'build' }).permissionMode,
      'workspace-write',
      content,
    );
  }
});

test('Chinese compound words containing 别 do not silently revoke write permission', () => {
  for (const content of [
    '请按各条引用后的要求分别处理。',
    '这些文件需要个别处理。',
    '对损坏文件进行特别处理，其他的继续整理。',
    '请特别修改 README.md 中的安装步骤。',
    '按级别处理这些记录。',
    '根据类别修改文件名。',
    '按组别移动文件。',
    '这些是要分别改的文件。',
    '识别处理结果后，更新报告。',
    '鉴别处理结果后，更新报告。',
    '按类别处理这些文件。',
    '根据区别处理各项需求。',
    '这些分别处理，但先别移动文件。',
  ]) {
    assert.equal(inspectActionIntent(content).prohibitsWrite, false, content);
    for (const mode of ['auto', 'build'] as const) {
      assert.equal(resolveOneForAllInput({ ...input, content, mode }).permissionMode, 'workspace-write', content);
      assert.equal(applyTaskJudgment({ ...input, content, mode }, action).permissionMode, 'workspace-write', content);
      assert.equal(
        resolveOneForAllInput({ ...input, content, mode, permissionMode: 'read-only' }).permissionMode,
        'read-only',
        content,
      );
    }
  }
  for (const content of [
    '别处理这些文件。',
    '你别处理这些文件。',
    '先别处理这些文件。',
    '请别处理这些文件。',
    '千万别处理这些文件。',
    '别再改这些文件。',
    '先别改。',
    '不要改。',
    '这个文件别修改。',
    '这两份有区别，别处理。',
    '这些分别处理，但先别改动文件。',
    '请特别注意：别改文件。',
    '分别不要改这些文件。',
  ]) {
    assert.equal(inspectActionIntent(content).prohibitsWrite, true, content);
    assert.equal(
      resolveOneForAllInput({ ...input, content, mode: 'build' }).permissionMode,
      'workspace-write',
      content,
    );
  }
});

test('embedded no-execution instructions keep automatic and manual build permissions', () => {
  for (const content of [
    'Create a plan for changing authentication; do not make any edits.',
    '生成一份改动计划，暂时不要动任何文件',
    'Fix this button, but do not change files yet.',
    'Implement this feature without making any code changes.',
    'Create the migration, but do not run commands.',
    '请修复这个问题，不过先别动代码',
    '创建配置示例，不做任何修改',
  ]) {
    assert.equal(inspectActionIntent(content).prohibitsWrite, true, content);
    for (const mode of ['auto', 'build'] as const) {
      for (const result of [
        resolveOneForAllInput({ ...input, content, mode }),
        applyTaskJudgment({ ...input, content, mode }, action),
      ]) {
        assert.equal(
          result.permissionMode,
          mode === 'auto' && mode === 'auto' && globalReadOnlyTrigger(content) ? 'read-only' : 'workspace-write',
          content,
        );
        assert.ok(result.scopeNote || result.readOnlyTrigger, content);
        assert.equal(result.mode, mode === 'auto' ? 'chat' : 'build', content);
      }
    }
  }
});

test('a prose plan keeps the permission cap while its scope controls persistence', () => {
  for (const content of [
    'Create a plan for the authentication change.',
    'Write an implementation plan.',
    '生成一份改动计划',
    '请制定一个实施方案',
  ]) {
    assert.equal(inspectActionIntent(content).prohibitsWrite, true, content);
    assert.equal(applyTaskJudgment({ ...input, content }, action).permissionMode, 'workspace-write', content);
  }
  for (const content of [
    'Write a plan to PLAN.md',
    'Create PLAN.md',
    'Create an implementation plan in docs/PLAN.md.',
    '生成一份改动计划，保存到 PLAN.md',
    'Build a plan editor.',
    'Create a plan editor.',
    'Implement the plan feature.',
    '修改计划列表组件',
    '创建一个计划编辑器',
    'Create a plan and then implement the feature.',
  ]) {
    assert.equal(inspectActionIntent(content).prohibitsWrite, false, content);
    assert.equal(resolveOneForAllInput({ ...input, content }).permissionMode, 'workspace-write', content);
  }
});

test('an accepted action with writable files builds unless asked as a question or forbidding changes', () => {
  for (const content of [
    'How do I update the database?',
    'How do I update the file and delete the old file?',
    'How do I update the file, then delete the old file?',
    '怎么创建一个网页？',
    '修改这个字段有什么影响？',
    'Write access should remain disabled. Explain why.',
  ]) {
    const result = applyTaskJudgment({ ...input, content }, action);
    // Asked as a question: a direct reply. The permission stays the user's unless the message forbids changes.
    assert.equal(result.mode, 'chat', content);
    assert.equal(result.permissionMode, 'workspace-write', content);
  }
  for (const content of ['I need you to fix the button.', '我希望你修复这个按钮', '分析问题，然后修复这个按钮']) {
    assert.equal(resolveOneForAllInput({ ...input, content }).mode, 'build', content);
    assert.equal(inspectActionIntent(content).explicitAction, true, content);
    const result = applyTaskJudgment({ ...input, content }, action);
    assert.equal(result.mode, 'build', content);
    assert.equal(result.permissionMode, 'workspace-write', content);
  }
  // Spoken, roundabout requests the word rules miss: the user's choice of writable files decides.
  for (const content of [
    'The button is broken.',
    '这个按钮坏了',
    '结合之前的记录，这个脱敏加分类去重，好好去做吧',
    '同时你那个给我这个看一看这个呃所有的重复的，然后分好类',
  ]) {
    const result = applyTaskJudgment({ ...input, content }, action);
    assert.equal(result.mode, 'build', content);
    assert.equal(result.permissionMode, 'workspace-write', content);
  }
});

test('judgment respects original read-only permission and manual modes', () => {
  for (const content of ['Fix README.md', 'I need you to fix the button.']) {
    const result = applyTaskJudgment({ ...input, content, permissionMode: 'read-only' }, action);
    assert.equal(result.permissionMode, 'read-only');
    assert.equal(result.verificationCommand, undefined);
  }
  assert.equal(applyTaskJudgment({ ...input, content: 'Fix README.md', mode: 'chat' }, action).mode, 'chat');
  const manualBuild = applyTaskJudgment(
    { ...input, content: 'Fix README.md', mode: 'build' },
    { status: 'accepted', intent: 'question' },
  );
  // A manual mode is the user's own choice, permission included.
  assert.equal(manualBuild.mode, 'build');
  assert.equal(manualBuild.permissionMode, 'workspace-write');
});

test('unaccepted, uncertain and invalid judgments use the deterministic local fallback', () => {
  for (const judgment of [
    { status: 'fallback', intent: 'action' },
    { status: 'error', intent: 'action' },
    { status: 'accepted', intent: 'uncertain' },
    { status: 'accepted' },
  ] as const) {
    for (const content of ['I need you to fix the button.', 'Fix README.md', 'Write an implementation plan.']) {
      assert.deepEqual(
        applyTaskJudgment({ ...input, content }, judgment),
        resolveOneForAllInput({ ...input, content }),
      );
    }
  }
  const question = applyTaskJudgment(
    { ...input, content: 'Fix README.md' },
    { status: 'accepted', intent: 'question' },
  );
  // The judgment sees the message without the conversation: it shapes the reply, the permission stays.
  assert.equal(question.mode, 'chat');
  assert.equal(question.permissionMode, 'workspace-write');
  assert.equal(question.verificationCommand, undefined);
  for (const content of ['可以去分类了吗？', '现在呢？', '处理啊？权限应该好了吧']) {
    const result = applyTaskJudgment({ ...input, content }, { status: 'accepted' });
    assert.equal(result.permissionMode, 'workspace-write', content);
  }
});

test('with quotes, permission follows the user’s own words, never the quote wrapper or the quoted text', async () => {
  const { quotedContent } = await import('../src/shared/quotes.ts');
  const quotes = [
    { text: 'D:\a\图片\tD:\b\图片\t不要改动这些文件', note: '这个我已经手动移动了，你去去重吧' },
    { text: 'D:\c', note: '合并去重吧' },
  ];
  const content = quotedContent('', quotes);
  const intentText = quotes.map((quote) => quote.note).join('\n');
  const result = applyTaskJudgment({ ...input, content, intentText }, { status: 'accepted' });
  assert.equal(result.permissionMode, 'workspace-write');
  // Even without intentText, embedded quote text cannot narrow permission.
  assert.equal(resolveOneForAllInput({ ...input, content }).permissionMode, 'workspace-write');
  // A whole-message automatic stop still narrows it.
  assert.equal(resolveOneForAllInput({ ...input, content, intentText: '只看不改' }).permissionMode, 'read-only');
});
