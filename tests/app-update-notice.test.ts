import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppUpdateNotice } from '../src/ui/AppUpdateNotice.tsx';
import { findNode, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const render = (update?: { version: string; url: string; mac?: true }) =>
  renderToStaticMarkup(createElement(AppUpdateNotice, { update }));

test('source link, ready restart, waiting, settings and dismissal use the same quiet notice', async () => {
  let listener: ((update: unknown) => void) | undefined;
  let restarts = 0;
  const storage = new Map<string, string>();
  const harness = uiHarness(await uiBundle('src/ui/AppUpdateNotice.tsx'), {
    window: {
      comboRunnerDesktop: {
        pickDirectory: async () => null,
        onAppUpdate: (next: typeof listener) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
        restartToUpdate: async () => {
          restarts++;
        },
      },
    },
    localStorage: {
      getItem: (key: string) => storage.get(key),
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
  const source = { version: '0.0.35', url: 'https://example.test/release' };
  let tree = harness.render('AppUpdateNotice', { update: source });
  assert.equal(findNode(tree, (n) => n.type === 'a')?.props.href, source.url);
  listener?.({ version: '0.0.36', status: 'ready' });
  tree = harness.render('AppUpdateNotice');
  assert.match(text(tree), /PugPort 0.0.36 已准备好/);
  findNode(tree, (n) => n.props.className === 'app-update-action')!.props.onClick();
  assert.equal(restarts, 1);
  listener?.({ version: '0.0.36', status: 'waiting' });
  tree = harness.render('AppUpdateNotice');
  assert.match(text(tree), /任务结束后更新到 PugPort 0.0.36/);
  assert.equal(
    findNode(tree, (n) => n.props.className === 'app-update-action'),
    undefined,
  );
  assert.equal(harness.render('AppUpdateNotice', { enabled: false }), null);
  tree = harness.render('AppUpdateNotice');
  findNode(tree, (n) => n.props.className === 'icon-button')!.props.onClick();
  assert.equal(harness.render('AppUpdateNotice'), null);
  assert.equal(storage.get('pugport-dismissed-app-update'), '0.0.36');
  listener?.({ version: '0.0.37', status: 'ready' });
  assert.match(text(harness.render('AppUpdateNotice')), /0.0.37/);
  harness.unmount();
  assert.equal(listener, undefined);
});

test('the release notice without a Mac feed keeps its original markup', () => {
  const html = render({ version: '0.0.35', url: 'https://github.com/pugport/pugport/releases/tag/v0.0.35' });
  assert.match(
    html,
    /^<div class="ui-update-notice app-update-notice" role="status"><span>PugPort 0\.0\.35 已可用<\/span><span aria-hidden="true"> · <\/span><a href="https:\/\/github\.com\/pugport\/pugport\/releases\/tag\/v0\.0\.35" target="_blank" rel="noreferrer">更新说明<\/a><button type="button" class="icon-button" aria-label="关闭更新提醒"><svg[^]*<\/svg><\/button><\/div>$/,
  );
  assert.equal(render(undefined), '');
});

test('a Mac update without the desktop updater offers only the download link', () => {
  const html = render({
    version: '0.0.35',
    url: 'https://download.pugport.com/mac/arm64/PugPort-0.0.35-mac-arm64.zip',
    mac: true,
  });
  assert.match(html, /PugPort 0\.0\.35 已可用/);
  assert.match(
    html,
    /href="https:\/\/download\.pugport\.com\/mac\/arm64\/PugPort-0\.0\.35-mac-arm64\.zip"[^>]*>下载新版本</,
  );
  assert.doesNotMatch(html, /升级|重启/);
});

test('a Mac feed entry keeps the one-click notice when the Windows updater channel answers nothing', async () => {
  const harness = uiHarness(await uiBundle('src/ui/AppUpdateNotice.tsx'), {
    window: {
      comboRunnerDesktop: {
        pickDirectory: async () => null,
        // On a Mac the Windows channel is registered but has no updater behind it.
        onAppUpdate: (listener: (update: unknown) => void) => {
          listener(undefined);
          return () => {};
        },
        appUpdate: {
          status: async () => ({ installable: true, phase: 'idle' }),
          download: async () => ({ installable: true, phase: 'downloading' }),
          install: async () => true,
          onStatus: () => () => {},
        },
      },
    },
    localStorage: { getItem: () => null, setItem: () => {} },
  });
  const update = {
    version: '0.0.40',
    url: 'https://download.pugport.com/mac/arm64/PugPort-0.0.40-mac-arm64.zip',
    mac: true,
  };
  harness.render('AppUpdateNotice', { update });
  await new Promise((done) => setTimeout(done, 0));
  const tree = harness.render('AppUpdateNotice', { update });
  assert.match(text(tree), /PugPort 0.0.40 已可用/);
  assert.equal(
    findNode(tree, (n) => n.props.className === 'app-update-action'),
    undefined,
  );
  assert.ok(findNode(tree, (n) => n.type === 'button' && text(n) === '升级'));
  harness.unmount();
});
