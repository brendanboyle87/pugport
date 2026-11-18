import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslator } from '../src/shared/i18n/index.ts';
import english from '../src/shared/i18n/en.json' with { type: 'json' };
import { uiBundle, uiHarness } from './helpers/ui-harness.ts';

test('management and composer copy uses concise English with complete quota templates', () => {
  const translate = createTranslator(english);
  assert.equal(translate('想做什么？'), 'Ask anything');
  assert.equal(translate('剩余 33%'), '33% left');
  assert.equal(translate('等待设备上报'), 'Waiting for devices to report');
  assert.equal(translate('API 密钥'), 'API key');
  assert.equal(translate('添加 API 密钥'), 'Add API key');
  assert.equal(
    translate('@ 叫角色或执行器 · @@ 叫设备或 Bot · /search 联网搜索'),
    '@ roles or executors · @@ devices or Bots · /search the web',
  );
});

test('switch messages and named controls translate through the real English catalog', () => {
  const translate = createTranslator(english);
  for (const [source, expected] of [
    ['自动插话：已开启', english['自动插话']],
    ['自动插话：已关闭', english['自动插话']],
    ['关闭 Codex A', 'Codex A'],
    ['停用 github', 'github'],
    ['启用 Codex A', 'Codex A'],
    ['开启 Codex A', 'Codex A'],
    ['展开 Synthetic', 'Synthetic'],
    ['收起 Synthetic', 'Synthetic'],
    ['Grok 进行中 52%', '52%'],
    ['旧记录局部索引  4', '4'],
    ['最早 10/15 14:30 开始', '10/15 14:30'],
    ['最晚 10/15 14:30 完成（尽量，不保证）', '10/15 14:30'],
  ]) {
    const translated = translate(source);
    assert.ok(translated, source);
    assert.doesNotMatch(translated, /[㐀-鿿]/, source);
    assert.ok(translated.includes(expected), translated);
  }
});

test('textarea attributes translate while values, child text and protected ancestors stay as written', async () => {
  const placeholder = '想做什么？';
  const child = { nodeType: 3, nodeValue: '设置', parentElement: undefined as unknown };
  const makeTextarea = (protectedSelf = false, protectedParent = false) => {
    const attrs: Record<string, string> = { placeholder, title: '设置', 'aria-label': '设置' };
    return {
      nodeType: 1,
      tagName: 'TEXTAREA',
      value: '设置',
      parentElement: {
        closest: (selector: string) => (protectedParent && selector.includes('textarea') ? {} : null),
      },
      closest: (selector: string) => (selector.includes('textarea') ? {} : null),
      matches: () => false,
      getAttribute: (name: string) => (name === 'translate' ? (protectedSelf ? 'no' : null) : attrs[name]),
      setAttribute: (name: string, value: string) => {
        attrs[name] = value;
      },
      attrs,
    };
  };
  const textarea = makeTextarea();
  child.parentElement = textarea;
  const protectedSelf = makeTextarea(true);
  const protectedParent = makeTextarea(false, true);
  const nodes = [textarea, child, protectedSelf, protectedParent];
  const harness = uiHarness(await uiBundle('src/ui/i18n.ts'), {
    localStorage: { getItem: () => 'en' },
    document: {
      documentElement: {},
      title: 'PugPort',
      body: { nodeType: 1, closest: () => null, matches: () => false, getAttribute: () => null },
      createTreeWalker: () => {
        let i = 0;
        return { nextNode: () => nodes[i++] };
      },
    },
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 },
    MutationObserver: class {
      observe() {}
    },
  });
  await harness.exports.startInterfaceLanguage();
  assert.equal(textarea.attrs.placeholder, english[placeholder]);
  assert.equal(textarea.attrs.title, english['设置']);
  assert.equal(textarea.attrs['aria-label'], english['设置']);
  assert.equal(textarea.value, '设置');
  assert.equal(child.nodeValue, '设置');
  for (const item of [protectedSelf, protectedParent]) {
    assert.equal(item.attrs.placeholder, placeholder);
    assert.equal(item.attrs.title, '设置');
    assert.equal(item.attrs['aria-label'], '设置');
    assert.equal(item.value, '设置');
  }
});

test('Extensions navigation and removal actions use the approved English copy', () => {
  const translate = createTranslator(english);
  for (const [source, expected] of [
    ['连接与服务', 'Connections'],
    ['外部服务', 'Services'],
    ['服务', 'Service'],
    ['开始设置', 'Set up'],
    ['重新打开', 'Turn back on'],
    ['更多操作：Synthetic', 'More actions for Synthetic'],
    ['删除技能「Synthetic」？', 'Delete skill “Synthetic”?'],
    ['从 PugPort 移除「Synthetic」？', 'Remove “Synthetic” from PugPort?'],
    ['原文件夹留在原处。', 'The original folder stays where it is.'],
    ['在 Codex 里已关闭', 'Turned off in Codex'],
  ])
    assert.equal(translate(source), expected, source);
});
