import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocalMemoryControls } from '../src/ui/Workspace.tsx';
import type { LocalMemorySettings } from '../src/shared/types.ts';

const settings: LocalMemorySettings = {
  exportEnabled: true,
  cliEnabled: false,
  dataDirectory: 'C:/User/OneDrive/PugPort/.data',
  archiveDirectory: 'C:/User/OneDrive/PugPort/.data/memory/project-a',
  projectDirectory: 'D:/Team project/.comborunner',
  files: [],
  warnings: [],
};
const actions = { onExport() {}, onCli() {}, onCleanup() {} };
const render = (value = settings, extra: { saving?: boolean; exportEnabled?: boolean; cliEnabled?: boolean } = {}) =>
  renderToStaticMarkup(
    createElement(LocalMemoryControls, {
      ...actions,
      settings: value,
      saving: false,
      exportEnabled: value.exportEnabled,
      cliEnabled: value.cliEnabled,
      ...extra,
    }),
  );

test('project CLI enrollment is off by default and privacy disclosure includes exact local paths', () => {
  const html = render();
  assert.match(html, /^<details class="target-advanced"><summary>高级设置：本地历史与 CLI 记忆<\/summary>/);
  assert.doesNotMatch(html.match(/^<details[^>]*>/)?.[0] ?? '', /\bopen\b/);
  const checkboxes = html.match(/<input[^>]+>/g) ?? [];
  assert.equal(checkboxes.length, 2);
  assert.match(checkboxes[0] ?? '', /checked/);
  assert.doesNotMatch(checkboxes[1] ?? '', /checked/);
  assert.match(html, /为此项目启用 CLI 记忆/);
  assert.match(html, /默认关闭/);
  assert.match(html, /让 CLI 能查到以前的对话/);
  assert.match(html, /完整历史以明文/);
  assert.match(html, /已有记录保留/);
  assert.match(html, /OneDrive、Dropbox/);
  assert.match(html, /会同步到云端/);
  assert.match(html, /会产生 Git\s*改动/);
  for (const path of [settings.dataDirectory, settings.archiveDirectory, settings.projectDirectory])
    assert.ok(html.includes(path));
  assert.doesNotMatch(html, /仅保存在此设备|只在本设备|清理旧 CLI/);
});

test('explicit action results show changed files, legacy cleanup and blocked-cleanup warnings safely', () => {
  const html = render({
    ...settings,
    files: ['D:/Team project/AGENTS.md', 'D:\\Team project\\.claude\\rules\\comborunner-local-memory.md'],
    legacyFiles: ['D:/Team project/CLAUDE.md'],
    warnings: ['Unknown user-edited block <script>unsafe()</script> left untouched.'],
  });
  assert.match(html, /本次修改的指引文件/);
  assert.match(html, /项目记忆对所有执行器通用/);
  assert.match(html, /AGENTS\.md<\/code><small[^>]*> · 供 Grok、Codex、Cursor 读取/);
  assert.match(html, /comborunner-local-memory\.md<\/code><small[^>]*> · 供 Claude Code 读取/);
  assert.match(html, /D:\/Team project\/AGENTS\.md/);
  assert.match(html, /D:\/Team project\/CLAUDE\.md/);
  assert.match(html, /清理旧 CLI 指引并关闭/);
  assert.match(html, /role="status"/);
  assert.match(html, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('disabling file exports disables CLI enrollment without describing SQLite deletion', () => {
  const html = render(settings, { exportEnabled: false, cliEnabled: false });
  const checkboxes = html.match(/<input[^>]+>/g) ?? [];
  assert.doesNotMatch(checkboxes[0] ?? '', /checked/);
  assert.match(checkboxes[1] ?? '', /disabled/);
  assert.match(html, /关闭只停止更新/);
  assert.match(render(settings, { saving: true }), /<fieldset[^>]+disabled/);
});
