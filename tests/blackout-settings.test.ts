import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findNode, nextTurn, uiBundle, uiHarness } from './helpers/ui-harness.ts';
import { existsSync, readFileSync } from 'node:fs';

test('general settings read the saved shortcut, keep it after a conflict and toggle from the button', async () => {
  let shortcut = 'Ctrl+Alt+N',
    toggles = 0;
  const writes: string[] = [];
  const harness = uiHarness(await uiBundle('src/ui/AppSettings.tsx'), {
    window: {
      comboRunnerDesktop: {
        pickDirectory: async () => null,
        blackout: async () => {
          toggles++;
        },
        blackoutShortcut: async (value?: string) => {
          if (value !== undefined) writes.push(value);
          const registered = value !== 'Ctrl+Alt+C';
          if (value && registered) shortcut = value;
          return { shortcut, registered };
        },
      },
    },
  });
  const props = {
    state: { app: { version: '0.0.34', commit: 'dev' }, runtimes: [] },
    updateCheck: true,
    updatePending: false,
    onUpdateCheck() {},
    api: async () => ({ paths: { dataDir: 'fixture/data', memoryDir: 'fixture/memory' }, tools: {} }),
    notify() {},
  };
  let tree = harness.render('AppSection', props);
  await nextTurn();
  tree = harness.render('AppSection', props);
  const field = () => findNode(tree, (node) => node.props.id === 'blackout-shortcut')!;
  assert.equal(field().props.value, shortcut);
  field().props.onChange({ target: { value: 'Ctrl+Alt+C' } });
  tree = harness.render('AppSection', props);
  field().props.onBlur();
  await nextTurn();
  tree = harness.render('AppSection', props);
  assert.equal(field().props.value, 'Ctrl+Alt+N');
  field().props.onChange({ target: { value: 'Ctrl+Alt+X' } });
  tree = harness.render('AppSection', props);
  let prevented = false;
  field().props.onKeyDown({
    key: 'Enter',
    preventDefault: () => {
      prevented = true;
    },
  });
  field().props.onBlur();
  await nextTurn();
  tree = harness.render('AppSection', props);
  assert.equal(prevented, true);
  assert.equal(field().props.value, 'Ctrl+Alt+X');
  assert.deepEqual(writes, ['Ctrl+Alt+C', 'Ctrl+Alt+X']);
  findNode(tree, (node) => node.type === 'button' && node.props.children === '立即黑屏')!.props.onClick();
  await nextTurn();
  assert.equal(toggles, 1);
  harness.unmount();
});

test('blackout and shell have no monitor power commands or wiring', () => {
  for (const file of ['blackout.ts', 'shell.ts']) {
    const source = readFileSync(new URL('../src/electron/' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /monitorPower|monitor-power|monitorOff|monitorOn|scheduleOff|SC_MONITORPOWER|0xf170/);
  }
  assert.equal(existsSync(new URL('../src/electron/monitor-power.ts', import.meta.url)), false);
});
