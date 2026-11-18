import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocalBuildRow } from '../src/ui/LocalBuildRow.tsx';
import { selectStoreModes } from '../src/shared/store-modes.ts';
import type { ConversationModesView, ModLocalBuild } from '../src/shared/conversation-modes.ts';
import type { ModeSourceView } from '../src/shared/mode-source.ts';

const build: ModLocalBuild = { workspaceId: 'a1b2c3d4e5', conversationId: 'chat', conversationTitle: 'Pomodoro Mod' };
const row = (value: ModLocalBuild, edit = true) =>
  renderToStaticMarkup(
    createElement(LocalBuildRow, {
      mode: { id: 'local.pomodoro', version: '0.1.3' },
      build: value,
      ...(edit ? { onEdit() {} } : {}),
      onReveal() {},
      onExport() {},
    }),
  );

test('a local build row names its chat and offers Edit in chat, Reveal folder and Export JSON', () => {
  const html = row(build);
  assert.match(html, /local\.pomodoro/);
  assert.match(html, /0\.1\.3/);
  assert.match(html, /在对话「Pomodoro Mod」中构建/);
  assert.deepEqual(
    [...html.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((match) => match[1]),
    ['在对话中编辑', '打开文件夹', '导出 JSON'],
  );
  assert.match(row({ ...build, conversationTitle: undefined }), /原对话已删除/);
  assert.match(row({ ...build, incognito: true }), /在隐身对话中构建/);
  assert.doesNotMatch(row(build, false), /在对话中编辑/, 'no chat opener, no Edit in chat');
});

test('the Store keeps the local build even when a catalog source has a newer version', () => {
  const local = {
    id: 'local.pomodoro',
    version: '0.1.3',
    title: 'Pomodoro',
    description: 'Synthetic',
    schemaVersion: 2,
    compatible: true,
    localBuild: build,
  } as ConversationModesView['catalog'][number];
  const data: ConversationModesView = {
    catalog: [local],
    installed: [{ modeId: local.id, version: local.version, installedAt: '2026-11-04T00:00:00Z' }],
  };
  const source = {
    config: { enabled: true, repository: 'synthetic/mods' },
    revision: 'rev',
    catalog: [{ ...local, version: '0.2.0', localBuild: undefined }],
  } as unknown as ModeSourceView;
  const selection = selectStoreModes(data, source).get(local.id)!;
  assert.equal(selection.mode.version, '0.2.0');
  assert.equal(selection.updateAvailable, true);
  assert.deepEqual(selection.localBuild, build);
  assert.equal(
    selectStoreModes({ ...data, catalog: [{ ...local, localBuild: undefined }] }).get(local.id)!.localBuild,
    undefined,
  );
});
