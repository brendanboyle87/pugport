import assert from 'node:assert/strict';
import test from 'node:test';
import { findNode, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const bundle = await uiBundle('src/ui/LayaFirstUseNotice.tsx');

test('the first-use notice stays dismissed after remount and opens the sharing setting', () => {
  for (const action of ['dismiss', 'settings']) {
    const storage = new Map<string, string>();
    const opened: unknown[][] = [];
    const h = uiHarness(bundle, {
      localStorage: {
        getItem: (key: string) => storage.get(key),
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
    const render = () => h.render('LayaFirstUseNotice', { onOpenSettings: (...args: unknown[]) => opened.push(args) });
    assert.match(text(render()), /提问和路由结果/);
    const button = findNode(
      render(),
      (node) =>
        node.type === 'button' &&
        (action === 'dismiss' ? node.props['aria-label'] === '关闭路由数据提示' : text(node) === '设置'),
    );
    assert.ok(button);
    button.props.onClick();
    assert.equal(render(), null);
    h.remount();
    assert.equal(render(), null);
    assert.deepEqual(opened, action === 'settings' ? [['routing', 'settings-laya-sharing']] : []);
    h.unmount();
  }
});

test('unavailable preference storage does not prevent dismissing the notice', () => {
  const h = uiHarness(bundle, {
    localStorage: {
      getItem() {
        throw Error('storage unavailable');
      },
      setItem() {
        throw Error('storage unavailable');
      },
    },
  });
  const render = () => h.render('LayaFirstUseNotice', { onOpenSettings() {} });
  const button = findNode(render(), (node) => node.props['aria-label'] === '关闭路由数据提示');
  assert.ok(button);
  button.props.onClick();
  assert.equal(render(), null);
  h.unmount();
});
