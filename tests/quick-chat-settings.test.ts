import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_QUICK_CHAT_SETTINGS, type QuickChatSettings } from '../src/shared/quick-chat.ts';
import { findNode, nextTurn, uiBundle, uiHarness } from './helpers/ui-harness.ts';

test('quick chat settings load, save all fields and retain previous shortcut on conflict', async () => {
  let saved = { ...DEFAULT_QUICK_CHAT_SETTINGS };
  const writes: QuickChatSettings[] = [];
  const bridge = {
    pickDirectory: async () => null,
    quickChatSettings: async (value?: QuickChatSettings) => {
      if (value) writes.push(value);
      const registered = value?.shortcut !== 'Ctrl+Alt+B';
      if (value && registered) saved = { ...value };
      return { ...saved, registered: registered && saved.enabled };
    },
  };
  const harness = uiHarness(await uiBundle('src/ui/QuickChatSettings.tsx'));
  const render = () => harness.render('QuickChatSettingsSection', { bridge });
  let tree = render();
  await nextTurn();
  tree = render();
  const field = (id: string) => findNode(tree, (node) => node.props.id === id)!;
  assert.equal(field('quick-chat-enabled').props.checked, true);
  assert.equal(field('quick-chat-shortcut').props.value, 'Ctrl+Alt+Space');
  field('quick-chat-shortcut').props.onChange({ target: { value: 'Ctrl+Alt+B' } });
  tree = render();
  field('quick-chat-shortcut').props.onKeyDown({ key: 'Enter', preventDefault() {} });
  field('quick-chat-shortcut').props.onBlur();
  await nextTurn();
  tree = render();
  assert.equal(writes.length, 1);
  assert.equal(field('quick-chat-shortcut').props.value, 'Ctrl+Alt+Space');
  assert.ok(findNode(tree, (node) => node.props.role === 'alert'));
  field('quick-chat-shortcut').props.onChange({ target: { value: 'Ctrl+Alt+N' } });
  tree = render();
  field('quick-chat-shortcut').props.onBlur();
  await nextTurn();
  tree = render();
  field('quick-chat-target').props.onChange({ target: { value: 'last' } });
  await nextTurn();
  tree = render();
  field('quick-chat-enabled').props.onChange({ target: { checked: false } });
  await nextTurn();
  tree = render();
  assert.equal(saved.shortcut, 'Ctrl+Alt+N');
  assert.equal(saved.target, 'last');
  assert.equal(saved.enabled, false);
  assert.equal(field('quick-chat-shortcut').props.disabled, true);
  harness.unmount();
});

test('a shortcut taken by another app mounts expanded after the first read', async () => {
  const bridge = {
    pickDirectory: async () => null,
    quickChatSettings: async () => ({ ...DEFAULT_QUICK_CHAT_SETTINGS, registered: false }),
  };
  const harness = uiHarness(await uiBundle('src/ui/QuickChatSettings.tsx'));
  assert.equal(harness.render('QuickChatSettingsSection', { bridge }), null);
  await nextTurn();
  const tree = harness.render('QuickChatSettingsSection', { bridge });
  assert.equal(tree.props.status, '需要检查');
  assert.equal(tree.props.defaultExpanded, true);
  const row = uiHarness(await uiBundle('src/ui/SettingsRow.tsx'));
  let mounted = row.render('SettingsRow', tree.props);
  assert.equal(findNode(mounted, (node) => node.props.className === 'settings-row-details')!.props.hidden, false);
  findNode(mounted, (node) => node.type === 'button' && 'aria-expanded' in node.props)!.props.onClick();
  mounted = row.render('SettingsRow', { ...tree.props, defaultExpanded: false });
  assert.equal(findNode(mounted, (node) => node.props.className === 'settings-row-details')!.props.hidden, true);
  mounted = row.render('SettingsRow', tree.props);
  assert.equal(findNode(mounted, (node) => node.props.className === 'settings-row-details')!.props.hidden, true);
  row.unmount();
  const alert = findNode(tree, (node) => node.props.role === 'alert');
  assert.ok(alert);
  assert.match(JSON.stringify(alert.props.children), /已被其他应用占用/);
  harness.unmount();
});
