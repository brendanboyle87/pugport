import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findNode, uiBundle, uiHarness, type UiNode } from './helpers/ui-harness.ts';

const code = uiBundle('src/ui/Workspace.tsx');
const stamp = '2026-10-29T12:00:00Z';
const text = (node: unknown): string =>
  typeof node === 'string' || typeof node === 'number'
    ? String(node)
    : Array.isArray(node)
      ? node.map(text).join('')
      : node && typeof node === 'object'
        ? text((node as UiNode).props?.children)
        : '';

test('all composers use a short placeholder and keep mention and search hints first in the add menu', async () => {
  for (const scope of ['chat', 'project', 'swarm']) {
    const h = uiHarness(await code);
    const project = {
      id: 'project',
      path: 'C:/Fixture',
      name: 'Fixture',
      scope: scope === 'chat' ? 'chat' : undefined,
    };
    const conversation = {
      id: 'chat',
      projectId: project.id,
      title: 'Fixture',
      createdAt: stamp,
      updatedAt: stamp,
      ...(scope === 'swarm' ? { swarm: { members: [] } } : {}),
    };
    const render = () =>
      h.render('ConversationWorkspace', {
        project,
        conversation,
        state: {
          app: { name: 'Fixture', version: 'test', platform: 'win32' },
          projects: [project],
          conversations: [conversation],
          runs: [],
          workflows: [],
          conversationMessages: [],
          targets: [],
          runtimes: [],
          approvals: [],
          plugins: [],
          settings: {},
        },
        api: async () => ({}),
        notify() {},
        onConversation() {},
        onAddProject() {},
        onMemory() {},
        onInspect() {},
      });
    try {
      assert.equal(
        findNode(render(), (node) => node.props.id === 'conversation-input')?.props.placeholder,
        '想做什么？',
      );
      findNode(render(), (node) => node.props['aria-label'] === '添加和更多')!.props.onClick();
      const menu = findNode(render(), (node) => node.props.className === 'composer-menu')!;
      assert.ok(menu);
      const first = menu.props.children[0];
      assert.equal(first.props.className, 'composer-menu-hint');
      assert.equal(text(first), '@ 叫角色或执行器 · @@ 叫设备或 Bot · /search 联网搜索');
      assert.ok(findNode(menu, (node) => node.props.role === 'menuitem' && text(node).includes('添加文件或图片')));
    } finally {
      h.unmount();
    }
  }
});
