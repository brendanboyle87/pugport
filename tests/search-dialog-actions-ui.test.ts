import assert from 'node:assert/strict';
import test from 'node:test';
import { findNode, uiBundle, uiHarness } from './helpers/ui-harness.ts';

test('search native dialog cancellation calls the owner close handler once', async () => {
  const h = uiHarness(await uiBundle('src/ui/SearchDialog.tsx'));
  let closed = 0;
  const tree = h.render('SearchDialog', {
    api: async () => [],
    onSelect: async () => {},
    onClose: () => closed++,
  });
  let prevented = false;
  const dialog = findNode(tree, (node) => node.type === 'dialog')!;
  dialog.props.onCancel({
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, true, 'React owns removal after the native cancel event');
  assert.equal(closed, 1);
  h.unmount();
});

test('search close button and backdrop dismiss while clicks inside the dialog do not', async () => {
  const h = uiHarness(await uiBundle('src/ui/SearchDialog.tsx'));
  let closed = 0;
  const tree = h.render('SearchDialog', {
    api: async () => [],
    onSelect: async () => {},
    onClose: () => closed++,
  });
  const dialog = findNode(tree, (node) => node.type === 'dialog')!;
  const target = {};
  dialog.props.onClick({ target: {}, currentTarget: target });
  assert.equal(closed, 0);
  dialog.props.onClick({ target, currentTarget: target });
  assert.equal(closed, 1);
  findNode(tree, (node) => node.props['aria-label'] === '关闭搜索')!.props.onClick();
  assert.equal(closed, 2);
  h.unmount();
});
