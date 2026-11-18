import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uiBundle, uiHarness } from './helpers/ui-harness.ts';

const code = await uiBundle('src/ui/i18n.ts');
test('pulled locale updates existing text and attributes live and preserves user content', async () => {
  let locale = 'zh-CN';
  const element = {
    nodeType: 1,
    matches: () => false,
    closest: () => null,
    getAttribute: (name: string) => (name === 'title' ? title : null),
    setAttribute: (_name: string, value: string) => {
      title = value;
    },
  };
  let title = '等待另一台电脑';
  const label = { nodeType: 3, nodeValue: '等待另一台电脑', parentElement: element };
  const user = {
    nodeType: 3,
    nodeValue: '等待另一台电脑',
    parentElement: { closest: (selector: string) => (selector.includes('textarea') ? {} : null) },
  };
  let reloads = 0,
    events = 0,
    observed = 0;
  const active = new Set<object>();
  const h = uiHarness(code, {
    localStorage: {
      getItem: () => locale,
      setItem: (_key: string, value: string) => {
        locale = value;
      },
    },
    location: {
      reload: () => {
        reloads++;
      },
    },
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 },
    Event: class {},
    MutationObserver: class {
      observe() {
        observed++;
        active.add(this);
      }
      disconnect() {
        active.delete(this);
      }
    },
    window: {
      dispatchEvent: () => {
        events++;
      },
    },
    document: {
      documentElement: {},
      title: 'PugPort',
      body: element,
      createTreeWalker: () => {
        let i = 0;
        const nodes = [label, user];
        return { nextNode: () => nodes[i++] };
      },
    },
  });
  await h.exports.startInterfaceLanguage();
  assert.equal(observed, 0, 'zh-CN must not attach a DOM observer');
  await h.exports.applyInterfaceLocale('en');
  assert.equal(label.nodeValue, 'Waiting for your other computer');
  assert.equal(title, 'Waiting for your other computer');
  assert.equal(user.nodeValue, '等待另一台电脑');
  await h.exports.applyInterfaceLocale('zh-CN');
  assert.equal(label.nodeValue, '等待另一台电脑');
  assert.equal(title, '等待另一台电脑');
  assert.equal(reloads, 0);
  assert.equal(events, 2);
});
