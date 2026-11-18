import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SearchResults } from '../src/ui/SearchDialog.tsx';
import { searchSnippet } from '../src/shared/search.ts';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const result = {
  conversationId: 'c',
  messageId: 'm',
  title: 'Synthetic conversation',
  createdAt: '2026-10-01T12:00:00Z',
  snippet: searchSnippet('<script>needle</script>', 'needle'),
};

test('search results render title, marked snippet and time without interpreting message HTML', () => {
  const html = renderToStaticMarkup(
    createElement(SearchResults, { results: [result], active: 0, onSelect() {}, onActive() {} }),
  );
  assert.match(html, /Synthetic conversation/);
  assert.match(html, /<mark>needle<\/mark>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /dateTime="2026-10-01T12:00:00Z"/);
  assert.match(html, /aria-selected="true"/);
});

test('search dialog fetches results, ignores stale requests, and Enter opens the selected message', async () => {
  const timers: Array<() => void> = [];
  const h = uiHarness(await uiBundle('src/ui/SearchDialog.tsx'), {
    setTimeout: (fn: () => void, ms: number) => {
      assert.equal(ms, 300);
      timers.push(fn);
      return timers.length;
    },
    clearTimeout() {},
  });
  const requests: Array<{ url: string; resolve: (value: unknown) => void }> = [];
  const opened: unknown[] = [];
  let closed = 0;
  const props = {
    api: (url: string) => new Promise((resolve) => requests.push({ url, resolve })),
    onSelect: async (value: unknown) => {
      opened.push(value);
    },
    onClose: () => closed++,
  };
  const render = () => h.render('SearchDialog', props);
  let tree = render();
  assert.doesNotMatch(text(tree), /最多显示 50 条结果/);
  const input = () => findNode(tree, (node) => node.type === 'input')!;
  input().props.onChange({ target: { value: 'n' } });
  tree = render();
  assert.equal(timers.length, 0);
  input().props.onChange({ target: { value: 'old' } });
  tree = render();
  timers.shift()!();
  input().props.onChange({ target: { value: 'needle' } });
  tree = render();
  timers.shift()!();
  requests[1].resolve([result]);
  await nextTurn();
  tree = render();
  requests[0].resolve([{ ...result, title: 'stale' }]);
  await nextTurn();
  tree = render();
  const list = findNode(tree, (node) => node.props.results !== undefined)!;
  assert.equal(list.props.results[0].title, 'Synthetic conversation');
  assert.equal(requests[1].url, '/api/search?q=needle&limit=50');
  input().props.onKeyDown({ key: 'Enter', nativeEvent: {}, preventDefault() {} });
  await nextTurn();
  assert.equal(opened[0], result);
  assert.equal(closed, 1);
  h.unmount();
});

test('pop-out branch selection works before the branch appears in the live snapshot', async () => {
  const conversation = {
    id: 'original',
    projectId: 'project',
    title: 'Fixture',
    createdAt: '2026-10-14T00:00:00Z',
    updatedAt: '2026-10-14T00:00:00Z',
  };
  const state = {
    app: { version: 'test' },
    settings: {},
    projects: [{ id: 'project', name: 'Fixture', path: 'C:/Fixture' }],
    conversations: [conversation],
    workflows: [],
    runs: [],
    targets: [],
    runtimes: [],
    approvals: [],
    plugins: [],
  };
  const h = uiHarness(await uiBundle('src/ui/Studio.tsx', true), {
    location: { search: '?view=conversation&id=original' },
    __backend: { state, api: async () => ({}), reload: async () => {}, connection: 'connected', error: '' },
  });
  const pane = () =>
    findNode(
      h.render('default'),
      (node) => typeof node.props.onConversation === 'function' && node.props.conversation,
    )!;
  assert.equal(pane().props.conversation.id, 'original');
  pane().props.onConversation({ ...conversation, id: 'forked' });
  assert.equal(pane().props.conversation.id, 'forked');
  h.unmount();
});
