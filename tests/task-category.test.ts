import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskCategory } from '../src/server/task-category.ts';
import type { RunInput } from '../src/shared/types.ts';

test('ordinary prose stays writing when it mentions software or a JSON index', () => {
  for (const prompt of ['写一篇介绍 Docker container 的博客存成 docker.md', '写第三章并更新 index.json'])
    assert.equal(taskCategory({ prompt, permissionMode: 'workspace-write', mode: 'build' }).id, 'writing', prompt);
});

test('local classification follows the priority table and defaults conservatively', () => {
  for (const [prompt, expected] of [
    ['看 shot.png 图片中的代码', 'vision'],
    ['翻译成人内容', 'adult'],
    ['翻译第三章', 'translation'],
    ['续写第三章', 'writing'],
    ['重构 parser.ts 的函数', 'code'],
    ['研究历史资料', 'research'],
    ['你好', 'other'],
  ])
    assert.equal(taskCategory({ prompt: prompt! }).id, expected);
  assert.equal(taskCategory({ prompt: '看看这个项目', mode: 'build', projectPath: 'fixture' }).confidence, 'low');
  assert.equal(taskCategory({ prompt: '你好' }).confidence, 'low');
  const image = {
    id: 'fixture',
    name: 'image.png',
    path: 'unused',
    mimeType: 'image/png',
    kind: 'image' as const,
    size: 1,
  };
  assert.equal(taskCategory({ prompt: '成人内容', attachments: [image] }).id, 'vision');
});
test('research keywords take priority over everyday Chinese verbs', () => {
  const category = taskCategory({ prompt: '调研怎样实现财务自由' });
  assert.equal(category.id, 'research');
  assert.equal(category.confidence, 'high');
});

test('everyday Chinese verbs alone are only low-confidence code signals', () => {
  for (const prompt of ['怎样实现财务自由', '如何修复和朋友的关系', '帮我修复这张老照片', '学习编程']) {
    const category = taskCategory({ prompt });
    assert.equal(category.id, 'code', prompt);
    assert.equal(category.confidence, 'low', prompt);
  }
  for (const prompt of ['实现一个排序函数', '修复 src/app.ts 的报错', '实现 src/app.ts']) {
    const category = taskCategory({ prompt });
    assert.equal(category.id, 'code', prompt);
    assert.equal(category.confidence, 'high', prompt);
  }
});

test('custom keywords, adult inheritance and low-confidence Jev adult signals', () => {
  const categories = [{ id: 'custom:finance', label: '财务', keywords: ['invoice'] }];
  assert.equal(taskCategory({ prompt: 'translate invoice', categories }).id, 'custom:finance');
  assert.equal(
    taskCategory({ prompt: 'check a function', parentCategory: { id: 'adult', confidence: 'high', reason: '' } }).id,
    'adult',
  );
  const judgment = { status: 'fallback', content: 'adult' } as RunInput['taskJudgment'];
  assert.deepEqual(taskCategory({ prompt: 'a passage', taskJudgment: judgment }), {
    id: 'adult',
    confidence: 'low',
    reason: '历史成人内容信号',
  });
  assert.equal(
    taskCategory({ prompt: 'check a function', parentCategory: { id: 'writing', confidence: 'high', reason: '' } }).id,
    'code',
  );
});

test('software images and Latin keyword fragments do not trigger unrelated routing categories', () => {
  for (const prompt of [
    'Investigate a Docker image build failure',
    'Implement container image caching',
    '修复这个 Docker image 的启动问题',
  ])
    assert.equal(taskCategory({ prompt }).id, 'code', prompt);
  assert.equal(taskCategory({ prompt: 'Describe this screenshot of a Docker image build error' }).id, 'code');
  assert.equal(taskCategory({ prompt: 'Describe this screenshot: build-error.png' }).id, 'vision');
  const categories = [{ id: 'custom:review', label: 'Review', keywords: ['review', 'root cause'] }];
  assert.equal(taskCategory({ prompt: 'Fix the preview component', categories }).id, 'other');
  assert.equal(taskCategory({ prompt: 'Review this function', categories }).id, 'custom:review');
  assert.equal(taskCategory({ prompt: 'root causes vary', categories }).id, 'other');
  assert.equal(taskCategory({ prompt: 'Find the root cause', categories }).id, 'custom:review');
});

test('the word 截图 without an image attachment is not vision; an attached image still is', () => {
  const image = {
    id: 'shot',
    name: 'shot.png',
    path: 'unused',
    mimeType: 'image/png',
    kind: 'image' as const,
    size: 1,
  };
  for (const prompt of [
    '可写任务：把截图按钮改成圆角，改 src/ui/Tray.tsx',
    '截图功能怎么用',
    'Add a screenshot button',
  ])
    assert.notEqual(taskCategory({ prompt, permissionMode: 'workspace-write' }).id, 'vision', prompt);
  assert.equal(taskCategory({ prompt: '看看这张截图哪里不对', attachments: [image] }).id, 'vision');
  assert.equal(
    taskCategory({ prompt: '把截图里的报错修掉', attachments: [image], permissionMode: 'workspace-write' }).id,
    'vision',
  );
});

test('English UI strings in a code write task are code; real translation requests stay translation', () => {
  for (const prompt of [
    "给 en.json 配英文文案 'Black out now' 并改 Tray.tsx",
    '把新增文案翻译成英文写进 src/shared/i18n/en.json',
    'Translate the new labels and implement them in Tray.tsx',
  ])
    assert.equal(taskCategory({ prompt, permissionMode: 'workspace-write', mode: 'build' }).id, 'code', prompt);
  for (const prompt of [
    'Translate the new labels and implement them in Tray.tsx',
    '修改 Tray.tsx 并把按钮文案翻译成英文',
  ])
    assert.equal(taskCategory({ prompt, permissionMode: 'workspace-write', mode: 'chat' }).id, 'code', prompt);
  for (const [prompt, input] of [
    ['翻译第三章', { permissionMode: 'workspace-write', mode: 'build' }],
    ['把 README 翻译成英文', { permissionMode: 'workspace-write', mode: 'build' }],
    ['把 en.json 里的文案翻译成英文', { permissionMode: 'read-only', mode: 'chat' }],
    ['Translate the labels in Tray.tsx', { permissionMode: 'workspace-write', mode: 'chat' }],
  ] as const)
    assert.equal(taskCategory({ prompt, ...input }).id, 'translation', prompt);
});
