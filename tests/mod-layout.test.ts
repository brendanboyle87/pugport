import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModManifestV2 } from '../src/shared/mods-manifest.ts';
import { resolveModLayout, modChatPlacement } from '../src/ui/mods/mod-layout.ts';

const manifest: ModManifestV2 = {
  schemaVersion: 2,
  id: 'test.slots',
  version: '1.0.0',
  title: 'Slots',
  description: 'Synthetic',
  contributions: {
    mainView: { kind: 'web', entry: 'main' },
    rightPanel: { kind: 'web', entry: 'right' },
    sidebarPanel: { kind: 'web', entry: 'sidebar' },
  },
};
test('mainView owns the workspace and suppresses mounted companion slots; hiding restores chat', () => {
  const visible = resolveModLayout(manifest, false, false);
  assert.equal(visible.main, 'mod');
  assert.equal(visible.right, 'none');
  for (const slot of ['mainView', 'rightPanel', 'sidebarPanel'] as const) {
    assert.deepEqual(visible[slot], { mounted: true, visible: slot === 'mainView' });
    assert.deepEqual(resolveModLayout(manifest, true, false)[slot], { mounted: true, visible: false });
  }
  assert.equal(resolveModLayout(manifest, true, false).main, 'chat');
  assert.equal(resolveModLayout(manifest, true, false).right, 'none');
});
test('workspace suppresses a side chat; legacy companion panels still yield to a side chat', () => {
  for (const hidden of [false, true]) {
    const layout = resolveModLayout(manifest, hidden, true);
    assert.equal(layout.right, hidden ? 'sideChat' : 'none');
    assert.deepEqual(layout.rightPanel, { mounted: true, visible: false });
    assert.equal(layout.mainView.visible, !hidden);
    assert.equal(layout.sidebarPanel.visible, false);
    assert.equal(resolveModLayout(manifest, hidden, false).rightPanel.visible, false);
  }
  const legacy = {
    ...manifest,
    contributions: {
      rightPanel: manifest.contributions!.rightPanel,
      sidebarPanel: manifest.contributions!.sidebarPanel,
    },
  };
  assert.equal(resolveModLayout(legacy, false, true).right, 'sideChat');
  assert.equal(resolveModLayout(legacy, false, true).sidebarPanel.visible, true);
  assert.equal(resolveModLayout(legacy, false, false).rightPanel.visible, true);
});
test('no contribution, absent manifest and empty form keep ordinary chat layout', () => {
  for (const value of [
    undefined,
    null,
    { ...manifest, contributions: {} },
    { ...manifest, contributions: { rightPanel: { kind: 'form' as const, form: { fields: [], actions: [] } } } },
  ]) {
    const layout = resolveModLayout(value, false, false);
    assert.equal(layout.hasSurface, false);
    assert.equal(layout.main, 'chat');
    assert.equal(layout.right, 'none');
    assert.deepEqual(layout.sidebarPanel, { mounted: false, visible: false });
  }
});
test('normalized v1 form remains a right panel, never replaces history', () => {
  const value: ModManifestV2 = {
    ...manifest,
    contributions: { rightPanel: { kind: 'form', form: { markdown: 'Notes', fields: [], actions: [] } } },
  };
  const layout = resolveModLayout(value, false, false);
  assert.equal(layout.hasSurface, true);
  assert.equal(layout.main, 'chat');
  assert.deepEqual(layout.rightPanel, { mounted: true, visible: true });
});
test('first pane owns one set in each window, including an independent pop-out', () => {
  const windows = [['a', 'b', 'a'], ['a']];
  for (const panes of windows) {
    const layouts = panes.map((id, index) => resolveModLayout(manifest, false, false, panes.indexOf(id) === index));
    assert.equal(layouts.filter((layout, index) => panes[index] === 'a' && layout.mainView.mounted).length, 1);
  }
  const secondary = resolveModLayout(manifest, false, false, false);
  assert.equal(secondary.main, 'chat');
  for (const slot of ['mainView', 'rightPanel', 'sidebarPanel'] as const)
    assert.deepEqual(secondary[slot], { mounted: false, visible: false });
  assert.equal(
    resolveModLayout(manifest, false, false, true).mainView.mounted,
    true,
    'pane ownership transfer mounts its own instance',
  );
});

test('drawer sits beside only when the measured body leaves 640px for the Mod', () => {
  assert.equal(modChatPlacement(1032, 1280), 'beside');
  assert.equal(modChatPlacement(760, 760), 'over');
  assert.equal(modChatPlacement(1020, 1000), 'beside');
  assert.equal(modChatPlacement(1019, 1000), 'over');
  assert.equal(modChatPlacement(1060, 2560), 'beside');
  assert.equal(modChatPlacement(1059, 2560), 'over');
});
