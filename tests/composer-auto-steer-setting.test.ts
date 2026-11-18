import assert from 'node:assert/strict';
import test from 'node:test';
import { findNode, nextTurn, uiBundle, uiHarness } from './helpers/ui-harness.ts';

test('auto-steer is checked by default and the settings switch persists an explicit off choice', async () => {
  const harness = uiHarness(await uiBundle('src/ui/App.tsx'));
  const writes: any[] = [];
  const props: any = {
    category: 'conversation',
    state: { app: { version: 'test', platform: 'win32' }, targets: [], runtimes: [], runs: [], settings: {} },
    api: async (path: string, body: any, method: string) => {
      writes.push({ path, body: structuredClone(body), method });
    },
    reload: async () => {},
    notify() {},
  };
  const checkbox = () =>
    findNode(harness.render('SettingsPage', props), (node) => node.props['aria-label'] === '自动插话')!;
  assert.equal(checkbox().props.checked, true);
  checkbox().props.onChange({ target: { checked: false } });
  await nextTurn();
  assert.equal(checkbox().props.checked, false);
  assert.deepEqual(writes, [{ path: '/api/settings', body: { steerOnSend: false }, method: 'PATCH' }]);
  harness.unmount();
  const reopened = uiHarness(await uiBundle('src/ui/App.tsx'));
  props.state.settings.steerOnSend = false;
  assert.equal(
    findNode(reopened.render('SettingsPage', props), (node) => node.props['aria-label'] === '自动插话')?.props.checked,
    false,
  );
  reopened.unmount();
});

test('send shortcut defaults to Enter and persists Ctrl+Enter immediately', async () => {
  const harness = uiHarness(await uiBundle('src/ui/App.tsx'));
  const writes: any[] = [];
  const props: any = {
    category: 'conversation',
    state: { app: { version: 'test', platform: 'win32' }, targets: [], runtimes: [], runs: [], settings: {} },
    api: async (path: string, body: any, method: string) => {
      writes.push({ path, body: structuredClone(body), method });
    },
    reload: async () => {},
    notify() {},
  };
  const select = () =>
    findNode(harness.render('SettingsPage', props), (node) => node.props['aria-label'] === '发送快捷键')!;
  assert.equal(select().props.value, 'enter');
  select().props.onChange({ target: { value: 'ctrl-enter' } });
  await nextTurn();
  assert.equal(select().props.value, 'ctrl-enter');
  assert.deepEqual(writes, [{ path: '/api/settings', body: { composerSendKey: 'ctrl-enter' }, method: 'PATCH' }]);
  props.state.app.platform = 'darwin';
  const macOption = findNode(
    harness.render('SettingsPage', props),
    (node) => node.type === 'option' && node.props.value === 'ctrl-enter',
  );
  assert.equal(macOption?.props.children, 'Cmd+Enter');
  harness.unmount();
});
