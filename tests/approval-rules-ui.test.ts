import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';
import { createTranslator } from '../src/shared/i18n/index.ts';
import english from '../src/shared/i18n/en.json' with { type: 'json' };
import type { Approval, Conversation } from '../src/shared/types.ts';

const cardCode = await uiBundle('src/ui/App.tsx');
const panelCode = await uiBundle('src/ui/ConversationPanel.tsx');
const approval: Approval = {
  id: 'approval',
  runId: 'run',
  tool: 'Bash',
  description: 'npm test --watch',
  createdAt: '2026-10-14T00:00:00Z',
  key: { tool: 'Bash', command: 'npm test --watch' },
};

test('remember button describes its exact scope and sends approval plus remember', async () => {
  const bridgeCalls: unknown[] = [];
  const h = uiHarness(cardCode, {
    window: {
      comboRunnerDesktop: {
        pickDirectory: async () => null,
        changePermission: async (value: unknown) => {
          bridgeCalls.push(value);
          return true;
        },
      },
    },
  });
  const calls: unknown[] = [];
  const props = {
    approval,
    api: async (...args: unknown[]) => {
      calls.push(args);
    },
    notify() {},
  };
  const tree = h.render('ApprovalCard', props);
  const button = findNode(tree, (node) => node.type === 'button' && node.props['data-approval-remember'] === true);
  assert.ok(button);
  assert.equal(text(button), '本对话中总是允许：命令：npm test --watch');
  assert.equal(button.props.className, 'button tiny quiet approval-remember');
  const actions = findNode(tree, (node) => node.props.className === 'approval-actions');
  assert.equal(
    findNode(actions, (node) => node.props['data-approval-remember']),
    undefined,
  );
  const scope = findNode(button, (node) => node.type === 'code');
  assert.equal(scope?.props.translate, 'no');
  button.props.onClick();
  await nextTurn();
  assert.deepEqual(calls, []);
  assert.equal(
    JSON.stringify(bridgeCalls),
    JSON.stringify([{ kind: 'approval', id: 'approval', allow: true, remember: true }]),
  );
  assert.equal(findNode(h.render('ApprovalCard', props), (node) => node.type === 'button')!.props.disabled, true);
});

test('deny uses HTTP and browser mode disables allow buttons', async () => {
  const calls: unknown[] = [];
  const h = uiHarness(cardCode);
  const tree = h.render('ApprovalCard', { approval, api: async (...args: unknown[]) => calls.push(args), notify() {} });
  const deny = findNode(
    tree,
    (node) =>
      node.type === 'button' && node.props.className === 'button secondary' && !node.props['data-approval-remember'],
  )!;
  const allow = findNode(tree, (node) => node.type === 'button' && node.props.className === 'button primary')!;
  const remember = findNode(tree, (node) => node.type === 'button' && node.props['data-approval-remember'])!;
  assert.equal(allow.props.disabled, true);
  assert.equal(remember.props.disabled, true);
  assert.equal(allow.props.title, '请在 PugPort 桌面窗口中允许');
  assert.equal(remember.props.title, '请在 PugPort 桌面窗口中允许');
  assert.equal(deny.props.disabled, false);
  deny.props.onClick();
  await nextTurn();
  assert.equal(JSON.stringify(calls), JSON.stringify([['/api/approvals/approval', { allow: false }]]));
});

test('a busy desktop permission bridge asks to retry and re-enables the card', async () => {
  const notices: any[] = [];
  const calls: unknown[] = [];
  const h = uiHarness(cardCode, {
    window: {
      comboRunnerDesktop: {
        pickDirectory: async () => null,
        changePermission: async (value: unknown) => {
          calls.push(value);
          return false;
        },
      },
    },
  });
  const props = {
    approval,
    api: async () => {
      throw Error('unexpected HTTP');
    },
    notify: (value: unknown) => notices.push(value),
  };
  findNode(
    h.render('ApprovalCard', props),
    (node) => node.type === 'button' && node.props.className === 'button primary',
  )!.props.onClick();
  await nextTurn();
  assert.equal(
    JSON.stringify(calls),
    JSON.stringify([{ kind: 'approval', id: 'approval', allow: true, remember: false }]),
  );
  assert.equal(notices[0]?.message, '操作没有完成，请重试。');
  assert.equal(
    findNode(
      h.render('ApprovalCard', props),
      (node) => node.type === 'button' && node.props.className === 'button primary',
    )!.props.disabled,
    false,
  );
});

test('file approval scope is visible in the remember button', () => {
  const tree = uiHarness(cardCode).render('ApprovalCard', {
    approval: { ...approval, tool: 'Edit', key: { tool: 'Edit', paths: ['/fixture/a.ts'] } },
    api: async () => {},
    notify() {},
  });
  const button = findNode(tree, (node) => node.type === 'button' && node.props['data-approval-remember'] === true);
  assert.ok(button);
  assert.equal(text(button), '本对话中总是允许：本项目文件夹内的文件修改');
});

test('approval titles name commands and file changes while keeping connector titles as written', () => {
  for (const [tool, label] of [
    ...[
      'Bash',
      'Codex command',
      'Cursor command',
      'Cursor execute',
      'Pi command',
      'Pi · bash · 执行命令',
      'Pi · powershell · 执行命令',
    ].map((tool) => [tool, '运行命令']),
    ...['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Codex file change'].map((tool) => [tool, '修改文件']),
    ['Fixture connector action', 'Fixture connector action'],
    ['Fixture command', 'Fixture command'],
  ]) {
    const tree = uiHarness(cardCode).render('ApprovalCard', {
      approval: { ...approval, tool },
      api: async () => {},
      notify() {},
    });
    const title = findNode(tree, (node) => node.type === 'h3');
    assert.equal(text(title), label);
    assert.equal(title?.props.translate, tool === label ? 'no' : undefined);
    assert.doesNotMatch(text(tree), /2026-10-14|任务 run/);
  }
});

test('approvals without a key never render the remember button', () => {
  for (const tool of ['Codex permissions', 'Codex command', 'Cursor command', 'Pi command', '创建邮件草稿']) {
    const h = uiHarness(cardCode);
    const tree = h.render('ApprovalCard', {
      approval: { ...approval, tool, key: undefined },
      api: async () => {},
      notify() {},
    });
    assert.equal(
      findNode(tree, (node) => node.type === 'button' && node.props['data-approval-remember'] === true),
      undefined,
    );
  }
});

test('conversation rules list removes by DELETE and restores the button after a failed request', async () => {
  const h = uiHarness(panelCode);
  const calls: unknown[] = [],
    notices: unknown[] = [];
  const conversation = {
    id: 'one',
    approvalRules: [{ id: 'rule', tool: 'Bash', command: 'git status' }],
  } as Conversation;
  const props = {
    conversation,
    api: async (...args: unknown[]) => {
      calls.push(args);
      throw Error('Fixture failure');
    },
    notify: (notice: unknown) => notices.push(notice),
  };
  const tree = h.render('ApprovalRules', props);
  assert.ok(findNode(tree, (node) => node.props['aria-label'] === '已允许的操作'));
  findNode(tree, (node) => node.type === 'button')!.props.onClick();
  await nextTurn();
  assert.equal(
    JSON.stringify(calls),
    JSON.stringify([['/api/conversations/one/approval-rules/rule', undefined, 'DELETE']]),
  );
  assert.equal(notices.length, 1);
  assert.equal(findNode(h.render('ApprovalRules', props), (node) => node.type === 'button')!.props.disabled, false);
  assert.equal(h.render('ApprovalRules', { ...props, conversation: { ...conversation, approvalRules: [] } }), null);
});

test('an English approval card translates each description line on its own', () => {
  const description = '仓库：o/r\n远程：origin\n不会强制推送；推送后会回读远程分支核对。';
  const tree = uiHarness(cardCode).render('ApprovalCard', {
    approval: { ...approval, tool: '推送分支到远程', description, key: undefined },
    api: async () => {},
    notify() {},
  });
  const paragraph = findNode(
    tree,
    (node) => node.type === 'p' && node.props.id === `approval-description-${approval.id}`,
  );
  assert.ok(paragraph);
  const lines = description.split('\n');
  const spans = paragraph.props.children as Array<{ type: string; props: { children: string } }>;
  assert.equal(spans.length, lines.length);
  const translate = createTranslator(english);
  for (const [index, line] of lines.entries()) {
    assert.equal(spans[index]?.type, 'span');
    assert.equal(spans[index]?.props.children, line);
    const translated = translate(line);
    assert.equal(typeof translated, 'string', line);
    assert.doesNotMatch(translated ?? '', /[㐀-鿿]/, line);
  }
});

test('approval description lines stay on their own line', () => {
  const css = readFileSync(new URL('../src/ui/studio.css', import.meta.url), 'utf8');
  assert.match(css, /\.approval-content p > span\s*\{[^}]*display:\s*block/);
});

test('approval preview and arbitrary tool text are protected from translation', () => {
  const tree = uiHarness(cardCode).render('ApprovalCard', {
    approval: { ...approval, tool: '设置', description: '设置\n任务已完成', key: undefined },
    api: async () => {},
    notify() {},
  });
  const title = findNode(tree, (node) => node.type === 'h3');
  const paragraph = findNode(
    tree,
    (node) => node.type === 'p' && node.props.id === `approval-description-${approval.id}`,
  );
  assert.equal(title?.props.translate, 'no');
  assert.ok(paragraph);
  for (const line of paragraph.props.children as Array<{ props: { translate: string } }>)
    assert.equal(line.props.translate, 'no');
});

test('English merge and pull request cards translate each line', () => {
  const description = [
    '仓库：o/r',
    'main ← feature（提交 abc）',
    '标题：Fix the gate',
    '正文前几行：',
    '│ hello',
    '草稿：否',
    'PR #7：Fix the gate',
    '检查：1 通过，0 失败，2 未完成',
    '评审：APPROVED',
  ].join('\n');
  const tree = uiHarness(cardCode).render('ApprovalCard', {
    approval: { ...approval, tool: '合并 Pull Request', description, key: undefined },
    api: async () => {},
    notify() {},
  });
  const paragraph = findNode(
    tree,
    (node) => node.type === 'p' && node.props.id === `approval-description-${approval.id}`,
  );
  assert.ok(paragraph);
  const lines = description.split('\n');
  const spans = paragraph.props.children as Array<{ type: string; props: { children: string } }>;
  assert.equal(spans.length, lines.length);
  const translate = createTranslator(english);
  for (const [index, line] of lines.entries()) {
    assert.equal(spans[index]?.type, 'span');
    if (!/[㐀-鿿]/.test(line)) continue;
    const translated = translate(line);
    assert.equal(typeof translated, 'string', line);
    assert.doesNotMatch(translated ?? '', /[㐀-鿿]/, line);
  }
});
