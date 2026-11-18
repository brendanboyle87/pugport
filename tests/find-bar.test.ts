import assert from 'node:assert/strict';
import test from 'node:test';
import { findNode, uiBundle, uiHarness } from './helpers/ui-harness.ts';
import { textMatches } from '../src/shared/search.ts';

test('find uses literal, case-insensitive non-overlapping matches, including Chinese', () => {
  assert.equal(textMatches('Needle needle NEEDLE', 'needle').length, 3);
  assert.equal(textMatches('查找内容，查找内容', '查找').length, 2);
  assert.deepEqual(textMatches('a+b aab a+b', 'a+b'), [
    { start: 0, end: 3 },
    { start: 8, end: 11 },
  ]);
  assert.deepEqual(textMatches('aaaa', ''), []);
  assert.equal(textMatches('aaaa', 'aa').length, 2);
});

test('mutations batch their rescans without scrolling the active result again', async () => {
  let scrolls = 0;
  let notifyMutation!: () => void;
  const frames: Array<() => void> = [];
  const element = { parentElement: null, closest: () => null, scrollIntoView: () => scrolls++ };
  const node = { textContent: '', parentElement: element };
  const root = { parentElement: null };
  const containerRef = { current: { querySelectorAll: () => [root] } };
  const harness = uiHarness(await uiBundle('src/ui/FindBar.tsx'), {
    HTMLDetailsElement: class {},
    NodeFilter: { SHOW_TEXT: 4, FILTER_REJECT: 2, FILTER_ACCEPT: 1 },
    document: {
      createTreeWalker: () => {
        let first = true;
        return { nextNode: () => (first ? ((first = false), node) : null) };
      },
      createRange: () => ({ startContainer: node, setStart() {}, setEnd() {} }),
    },
    MutationObserver: class {
      constructor(callback: () => void) {
        notifyMutation = callback;
      }
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    cancelAnimationFrame() {},
  });
  const props = { containerRef, conversationId: 'fixture', open: true, onOpenChange() {} };
  const render = () => harness.render('FindBar', props);
  let tree = render();
  findNode(tree, (node) => node.type === 'input')!.props.onChange({ target: { value: 'needle' } });
  tree = render();
  assert.equal(scrolls, 0);
  node.textContent = 'needle needle';
  notifyMutation();
  frames.shift()!();
  tree = render();
  assert.equal(scrolls, 1);
  for (let i = 0; i < 10; i++) notifyMutation();
  assert.equal(frames.length, 1);
  frames.shift()!();
  tree = render();
  assert.equal(scrolls, 1);
  findNode(tree, (node) => node.props.role === 'search')!.props.onKeyDown({
    key: 'Enter',
    nativeEvent: {},
    preventDefault() {},
  });
  render();
  assert.equal(scrolls, 2);
  notifyMutation();
  frames.shift()!();
  render();
  assert.equal(scrolls, 2);
  harness.unmount();
});
