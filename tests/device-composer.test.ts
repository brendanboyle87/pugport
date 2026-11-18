import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { ComposerSession, draftFromHistory } from '../src/ui/composer-session.ts';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

let code: string;
before(async () => {
  code = await uiBundle('src/ui/Workspace.tsx');
});
const stamp = '2026-10-20T12:00:00Z';
const conversation = { id: 'chat', projectId: 'project', title: 'Synthetic chat', createdAt: stamp, updatedAt: stamp };

async function composer(allowWrite: boolean | undefined = undefined, folder = '', readOnly = false) {
  const bodies: any[] = [];
  const session = new ComposerSession();
  session.changeDraft('conversation:chat', () => ({
    content: '@test-device Inspect synthetic files',
    attachments: [],
    deviceFolder: folder,
    called: [{ kind: 'device', id: 'device:synthetic-device', name: 'test-device' }],
  }));
  const h = uiHarness(code, {
    localStorage: {
      getItem: () => JSON.stringify({ permission: readOnly ? 'read-only' : 'workspace-write' }),
      setItem() {},
    },
  });
  const props = {
    state: {
      app: { name: 'Fixture', version: 'test', platform: 'win32', dataDir: 'synthetic' },
      projects: [],
      conversations: [conversation],
      runs: [],
      workflows: [],
      conversationMessages: [],
      targets: [],
      runtimes: [],
      approvals: [],
      plugins: [],
      settings: { toolApprovalMode: 'auto', executionPolicy: 'cli-first' },
    },
    api: async (path: string, body: any) => {
      if (path === '/api/devices')
        return {
          devices: [
            {
              id: 'synthetic-device',
              name: 'test-device',
              address: 'test-device',
              pairedAt: stamp,
              online: true,
              allowWrite,
              folders: Array.from({ length: 12 }, (_, i) => `/home/test/project-${i}`),
            },
          ],
        };
      if (path.endsWith('/messages')) {
        bodies.push(body);
        return {
          message: { id: 'sent', conversationId: 'chat', role: 'user', content: body.content, createdAt: stamp },
        };
      }
      return { messages: [] };
    },
    conversation,
    composerSession: session,
    notify() {},
    onConversation() {},
    onAddProject() {},
    onMemory() {},
    onInspect() {},
  };
  const render = () => h.render('ConversationWorkspace', props);
  const node = (check: Parameters<typeof findNode>[1]) => {
    const result = findNode(render(), check);
    assert.ok(result);
    return result;
  };
  render();
  await nextTurn();
  render();
  await nextTurn();
  return {
    h,
    bodies,
    render,
    node,
    session,
    permission: () =>
      findNode(render(), (value) => value.type === 'button' && value.props['aria-label'] === '文件权限'),
    permissionToggle: () => {
      const plus = node((value) => value.props['aria-label'] === '添加和更多');
      if (!plus.props['aria-expanded']) plus.props.onClick();
      return node((value) => value.props.role === 'menuitemcheckbox' && text(value) === '只读');
    },
    async send() {
      node((value) => value.type === 'form' && value.props.className.includes('conversation-composer')).props.onSubmit({
        preventDefault() {},
      });
      await nextTurn();
      await nextTurn();
      assert.equal(bodies.length, 1);
      return bodies[0];
    },
  };
}

test('a device folder is optional, offers ten recent folders and blank permits auto writes', async () => {
  const view = await composer();
  assert.equal(view.permission()!.props.children, '可写入');
  assert.equal(view.permissionToggle().props.disabled, false);
  assert.equal(view.permissionToggle().props['aria-checked'], false);
  const folder = view.node((node) => node.props['aria-label'] === '设备上的文件夹');
  assert.equal(folder.props.placeholder, '文件夹（可不填）');
  const list = view.node((node) => node.type === 'datalist');
  assert.equal(list.props.children.length, 10);
  folder.props.onChange({ target: { value: '~/synthetic project' } });
  assert.equal(view.session.getSnapshot().drafts['conversation:chat']!.deviceFolder, '~/synthetic project');
  assert.equal(view.permission()!.props.children, '可写入');
  assert.equal(view.permissionToggle().props.disabled, false);
  folder.props.onChange({ target: { value: '  ' } });
  const body = await view.send();
  assert.equal(body.mode, 'auto');
  assert.equal(body.permissionMode, 'workspace-write');
  assert.equal(body.explicitWrite, true);
  assert.equal(body.deviceFolder, undefined);
  view.h.unmount();
});

test('folder plus write access is sent, remote writes off overrides it, unknown remains compatible', async () => {
  for (const allowWrite of [true, false, undefined]) {
    const view = await composer(allowWrite, '~/synthetic project');
    assert.equal(view.permissionToggle().props.disabled, allowWrite === false);
    assert.equal(view.permissionToggle().props['aria-checked'], allowWrite === false);
    if (allowWrite === false) {
      assert.equal(view.permission()!.props.disabled, true);
      assert.match(text(view.render()), /这台设备已关闭写入/);
    } else assert.equal(view.permission()!.props.children, '可写入');
    const body = await view.send();
    assert.equal(body.deviceFolder, '~/synthetic project');
    assert.equal(body.explicitWrite, allowWrite !== false);
    assert.equal(body.permissionMode, allowWrite === false ? 'read-only' : 'workspace-write');
    view.h.unmount();
  }
});

test('a folderless device stays read-only in chat mode', async () => {
  const view = await composer(true);
  view.node((node) => node.props['aria-label'] === '调度选项').props.onClick();
  const advancedControl = view.node(
    (node) => node.props.className?.startsWith('chip-more') && node.props['aria-expanded'] !== undefined,
  );
  if (!advancedControl.props['aria-expanded']) advancedControl.props.onClick();
  view.node((node) => node.props.ariaLabel === '任务理解方式').props.onChange('chat');
  assert.equal(text(view.permission()), '只读');
  const body = await view.send();
  assert.equal(body.mode, 'chat');
  assert.equal(body.permissionMode, 'read-only');
  assert.equal(body.explicitWrite, false);
  view.h.unmount();
});

test('build mode permits folderless writes and the shared read-only switch still wins', async () => {
  const view = await composer(true);
  view.node((node) => node.props['aria-label'] === '调度选项').props.onClick();
  const advancedControl = view.node(
    (node) => node.props.className?.startsWith('chip-more') && node.props['aria-expanded'] !== undefined,
  );
  if (!advancedControl.props['aria-expanded']) advancedControl.props.onClick();
  view.node((node) => node.props.ariaLabel === '任务理解方式').props.onChange('build');
  assert.equal(view.permission()!.props.children, '可写入');
  const body = await view.send();
  assert.equal(body.mode, 'build');
  assert.equal(body.explicitWrite, true);
  assert.equal(body.permissionMode, 'workspace-write');
  view.h.unmount();
  const readOnlyView = await composer(true, '', true);
  readOnlyView.node((node) => node.props['aria-label'] === '调度选项').props.onClick();
  const readOnlyAdvancedControl = readOnlyView.node(
    (node) => node.props.className?.startsWith('chip-more') && node.props['aria-expanded'] !== undefined,
  );
  if (!readOnlyAdvancedControl.props['aria-expanded']) readOnlyAdvancedControl.props.onClick();
  readOnlyView.node((node) => node.props.ariaLabel === '任务理解方式').props.onChange('build');
  assert.equal(text(readOnlyView.permission()), '只读');
  const readOnlyBody = await readOnlyView.send();
  assert.equal(readOnlyBody.mode, 'build');
  assert.equal(readOnlyBody.explicitWrite, false);
  assert.equal(readOnlyBody.permissionMode, 'read-only');
  readOnlyView.h.unmount();
});

test('folderless writes can be switched off and devices with writes disabled stay read-only', async () => {
  const view = await composer(true);
  view.permissionToggle().props.onClick();
  assert.equal(text(view.permission()), '只读');
  const body = await view.send();
  assert.equal(body.explicitWrite, false);
  assert.equal(body.permissionMode, 'read-only');
  view.h.unmount();
  const disabled = await composer(false);
  assert.equal(disabled.permission()!.props.disabled, true);
  assert.equal(disabled.permissionToggle().props.disabled, true);
  assert.equal(disabled.permissionToggle().props['aria-checked'], true);
  assert.match(text(disabled.render()), /这台设备已关闭写入/);
  assert.equal((await disabled.send()).explicitWrite, false);
  disabled.h.unmount();
});

test('a device restored from read-only history uses the current composer permissions', async () => {
  const view = await composer(true);
  view.session.changeDraft('conversation:chat', () => ({
    ...draftFromHistory(
      [
        { id: 'old-user', conversationId: 'chat', role: 'user', content: 'Inspect', createdAt: stamp },
        {
          id: 'old-answer',
          conversationId: 'chat',
          role: 'assistant',
          content: 'Done',
          createdAt: stamp,
          workflowId: 'old-task',
          device: { id: 'synthetic-device', name: 'test-device' },
        },
      ],
      [
        {
          id: 'old-task',
          conversationId: 'chat',
          userMessageId: 'old-user',
          finalMessageId: 'old-answer',
          status: 'completed',
          input: { deviceId: 'synthetic-device', permissionMode: 'read-only' },
        } as any,
      ],
    ),
    content: 'Install synthetic software',
  }));
  assert.equal(view.permission()!.props.children, '可写入');
  const body = await view.send();
  assert.equal(body.deviceId, 'synthetic-device');
  assert.equal(body.deviceFolder, undefined);
  assert.equal(body.permissionMode, 'workspace-write');
  assert.equal(body.explicitWrite, true);
  view.h.unmount();
});

test('received files remain normal clickable paths when the device task fails', () => {
  const h = uiHarness(code);
  const details = 'synthetic failure\n\nReceived from test-device: <C:/synthetic/partial.txt>';
  const tree = h.render('SystemNoticeView', { notice: { text: '本轮未完成', details } });
  const summary = findNode(
    tree,
    (node) => typeof node.type === 'function' && node.props.text?.startsWith('Received from'),
  );
  assert.ok(summary);
  assert.ok(
    findNode(summary.type(summary.props), (node) => node.props['data-local-path'] === 'C:/synthetic/partial.txt'),
  );
  assert.equal(text(findNode(tree, (node) => node.type === 'pre')), details);
  h.unmount();
});

test('a sticky device retains its remote folder and write choice on the punctuation follow-up', async () => {
  const view = await composer(true, '~/synthetic project');
  await view.send();
  const draft = view.session.getSnapshot().drafts['conversation:chat']!;
  assert.equal(draft.called?.[0]?.id, 'device:synthetic-device');
  assert.equal(draft.deviceFolder, '~/synthetic project');
  view.node((node) => node.props.id === 'conversation-input').props.onChange({ target: { value: '现在呢？' } });
  view
    .node((node) => node.type === 'form' && node.props.className.includes('conversation-composer'))
    .props.onSubmit({ preventDefault() {} });
  await nextTurn();
  assert.equal(view.bodies[1].deviceId, 'synthetic-device');
  assert.equal(view.bodies[1].deviceFolder, '~/synthetic project');
  assert.equal(view.bodies[1].explicitWrite, true);
  view.h.unmount();
  view.session.dispose();
});
