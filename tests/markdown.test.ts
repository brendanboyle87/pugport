import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fileLabel, localPathOf, renderMarkdown, type MarkdownOptions } from '../src/ui/markdown.tsx';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const html = (text: string, options?: MarkdownOptions) =>
  renderToStaticMarkup(createElement(Fragment, null, ...renderMarkdown(text, options)));

test('inline UNC paths take precedence over escaped backslashes in any reply', () => {
  const path = String.raw`\\nas\photos`;
  const out = html(`Open ${path} now`);
  assert.ok(out.includes(`data-local-path="${path}"`), out);
  assert.ok(out.includes(`>${path}</span>`), out);
});

test('escaped backslashes without a UNC host and share stay plain text with project context', () => {
  for (const [source, expected] of [
    [String.raw`use \\n for a newline`, String.raw`use \n for a newline`],
    [String.raw`Ctrl+\\`, 'Ctrl+\\'],
    [String.raw`(\\d+)`, String.raw`(\d+)`],
  ]) {
    assert.equal(html(source!, { relativePaths: true }), `<p>${expected}</p>`);
  }
});

test('replies render headings, emphasis, lists and code without raw markers', () => {
  const out = html(
    '## 结论\n\n**Grok 4.7** 由 *xAI* 发布，用 `grok` 命令。\n\n- 第一\n- 第二\n  - 子项\n1. 甲\n2. 乙\n\n```ts\nconst a = 1;\n```',
  );
  assert.match(out, /<h3>结论<\/h3>/);
  assert.match(out, /<strong>Grok 4.7<\/strong>/);
  assert.match(out, /<em>xAI<\/em>/);
  assert.match(out, /<code>grok<\/code>/);
  assert.match(out, /<ul><li>第一<\/li><li>第二<ul><li>子项<\/li><\/ul><\/li><\/ul>/);
  assert.match(out, /<ol><li>甲<\/li><li>乙<\/li><\/ol>/);
  assert.match(out, /<div class="message-code-head"><span>ts<\/span><button[^>]*class="button tiny quiet"/);
  assert.match(out, /<\/button><\/div><pre><code>const a = 1;<\/code><\/pre>/);
  assert.doesNotMatch(out, /\*\*|##/);
});

test('unlabelled code fences leave the header label empty and escape code', () => {
  const out = html('```\n<script>unsafe()</script>\n```');
  assert.match(out, /message-code-head"><span><\/span><button/);
  assert.match(out, /<code>&lt;script&gt;unsafe\(\)&lt;\/script&gt;<\/code>/);
  assert.doesNotMatch(out, /代码|<script>/);
});

test('code copy writes the exact body and resets its confirmation after two seconds', async () => {
  const writes: string[] = [];
  let reset: (() => void) | undefined;
  const h = uiHarness(await uiBundle('src/ui/markdown.tsx'), {
    navigator: { clipboard: { writeText: async (value: string) => writes.push(value) } },
    setTimeout: (fn: () => void, ms: number) => {
      assert.equal(ms, 2000);
      reset = fn;
      return 1;
    },
  });
  const props = { language: 'ts', text: 'const a = "<原文>";\n' };
  let tree = h.render('CodeBlock', props);
  findNode(tree, (node) => node.type === 'button')!.props.onClick();
  await nextTurn();
  assert.deepEqual(writes, [props.text]);
  tree = h.render('CodeBlock', props);
  assert.match(text(tree), /已复制/);
  reset!();
  assert.doesNotMatch(text(h.render('CodeBlock', props)), /已复制/);
  h.unmount();
});

test('a comparison table renders as a table with bold links', () => {
  const out = html(
    '**代表性产品对比**\n\n| 产品 | 路由机制 |\n|---|---|\n| **[Cursor Router](https://prod.cursor.com/help/models-and-usage/cursor-router)** | ML 分类器 |\n| **[RouteLLM](https://github.com/lm-sys/RouteLLM)** | 阈值 |',
  );
  assert.match(out, /<p><strong>代表性产品对比<\/strong><\/p>/);
  assert.match(out, /<table><thead><tr><th[^>]*>产品<\/th><th[^>]*>路由机制<\/th><\/tr><\/thead>/);
  assert.match(
    out,
    /<td[^>]*><strong><a href="https:\/\/prod.cursor.com\/help\/models-and-usage\/cursor-router" target="_blank" rel="noreferrer"[^>]*>Cursor Router<\/a><\/strong><\/td>/,
  );
  assert.equal((out.match(/<tr>/g) ?? []).length, 3);
  assert.doesNotMatch(out, /\|---/);
});

test('tables of up to six rows stay fully visible without reading controls', () => {
  const out = html(
    '| 文件 | 大小 |\n|---|---:|\n' + Array.from({ length: 6 }, (_, i) => `| file${i}.ts | ${i} |`).join('\n'),
  );
  assert.equal((out.match(/<tr>/g) ?? []).length, 7);
  assert.doesNotMatch(out, /md-table-preview|data-collapsed|展开全部|在侧栏阅读/);
  assert.match(out, /<th[^>]*scope="col"[^>]*>文件<\/th>/);
  assert.match(out, /<td[^>]*text-align:right[^>]*>5<\/td>/);
});

test('long tables render in full and retain safe, clickable cells and the reading pane control', () => {
  const rows = Array.from({ length: 35 }, (_, i) =>
    i === 34
      ? '| [最后文件](<C:/fixture/files/final.ts:12>) | <script>bad()</script> |'
      : `| \`docs/file${i}.ts\` | ${i} |`,
  );
  const out = html('| 文件 | 内容 |\n|---|---|\n' + rows.join('\n'), { relativePaths: true });
  assert.match(out, /data-row-count="35"/);
  assert.doesNotMatch(out, /md-table-preview|data-collapsed|显示前 5 行|展开全部|收起/);
  assert.match(out, /共 35 行/);
  assert.match(out, /aria-haspopup="dialog" aria-expanded="false"[^>]*>在侧栏阅读<\/button>/);
  assert.equal((out.match(/<tr>/g) ?? []).length, 36);
  assert.match(out, /data-local-path="C:\/fixture\/files\/final.ts">最后文件<\/span>/);
  assert.match(out, /data-relative-path="docs\/file20.ts"/);
  assert.match(out, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(out, /role="dialog"|<script>/);
});

test('local file links become compact file names; bare URLs are shortened; no markup is injected', () => {
  const out = html(
    '见 [分类规则](<C:/Users/me/PugPort/server/routing.ts:19>) 和 (<C:/Users/me/PugPort/server/controller.ts:32>)，文档 https://docs.litellm.ai/docs/routing 。<script>alert(1)</script>',
  );
  assert.match(
    out,
    /<span class="file-ref" role="button" tabindex="0" title="C:\/Users\/me\/PugPort\/server\/routing.ts:19\n点击打开所在文件夹" data-local-path="C:\/Users\/me\/PugPort\/server\/routing.ts">分类规则<\/span>/,
  );
  // A path written as code opens in Explorer on click; other code stays plain.
  assert.match(
    html('结果在 `D:\\迅雷下载\\图片` 和 `npm test`'),
    /<code class="path-ref" role="button" tabindex="0" data-local-path="D:\\迅雷下载\\图片" title="点击在文件夹中打开">D:\\迅雷下载\\图片<\/code> 和 <code>npm test<\/code>/,
  );
  assert.equal(localPathOf('file:///C:/a/b.ts:12:3'), 'C:/a/b.ts');
  assert.equal(localPathOf('src/a.ts'), undefined);
  assert.match(out, /<span class="file-ref"[^>]*>controller.ts:32<\/span>/);
  assert.match(out, /<a href="https:\/\/docs.litellm.ai\/docs\/routing"[^>]*>docs.litellm.ai\/docs\/routing<\/a>/);
  assert.match(out, /&lt;script&gt;/);
  assert.equal(fileLabel('C:\\a\\b\\workspace.ts:131'), 'workspace.ts:131');
  // A javascript: link is never clickable.
  assert.doesNotMatch(html('[x](javascript:alert(1))'), /href/);
});

test('dropping a conversation splits beside a pane, replaces it, or moves it; dividers keep a minimum width', async () => {
  const { dropIntoPanes, resizePanes } = await import('../src/ui/SplitView.tsx');
  assert.deepEqual(dropIntoPanes(['a'], 'b', { index: 0, mode: 'after' }), ['a', 'b']);
  assert.deepEqual(dropIntoPanes(['a', 'b'], 'c', { index: 1, mode: 'before' }), ['a', 'c', 'b']);
  assert.deepEqual(dropIntoPanes(['a', 'b'], 'c', { index: 1, mode: 'replace' }), ['a', 'c']);
  assert.deepEqual(dropIntoPanes(['a', 'b'], 'b', { index: 0, mode: 'before' }), ['b', 'a']);
  assert.deepEqual(dropIntoPanes([''], 'a', { index: 0, mode: 'after' }), ['a']);
  // Four panes is the limit: a fifth replaces the pane it is dropped on.
  assert.deepEqual(dropIntoPanes(['a', 'b', 'c', 'd'], 'e', { index: 3, mode: 'after' }), ['a', 'b', 'c', 'e']);
  assert.deepEqual(resizePanes([1, 1], 0, 0.5), [1.5, 0.5]);
  assert.deepEqual(resizePanes([1, 1], 0, 5), [1.76, 0.24]);
});

test('relative paths become clickable only next to a full path they can be resolved against', () => {
  const withBase = html(
    '最高分是 `D:\\图\\03\\125.jpg`，同夹里的 `1.jpg` 和 `汪熙妍\\图片\\20.jpg` 也不是；命令是 `npm test`。',
  );
  assert.match(withBase, /<code class="path-ref"[^>]*data-relative-path="1.jpg"/);
  assert.match(withBase, /data-relative-path="汪熙妍\\图片\\20.jpg"/);
  assert.match(withBase, /<code>npm test<\/code>/);
  assert.doesNotMatch(html('改一下 `1.jpg`'), /data-relative-path/);
});

test('project context enables folder names and filenames in tables without inventing links for numbers or commands', () => {
  const out = html(
    '| 处理 | 结果 |\n|---|---|\n| 新图片 | 292 张进 `图片`，编号 `101` 到 `392` |\n| 新视频 | 在 `正片`：`素材 80.avi`，短的在 `短视频`：`素材 89` |\n| 程序 | `npm test`、`workflowId`、`git checkout src/a.ts` |',
    { relativePaths: true },
  );
  for (const name of ['图片', '正片', '短视频', '素材 80.avi', '素材 89']) {
    assert.ok(out.includes(`data-relative-path="${name}"`), name);
  }
  for (const code of ['101', '392', 'npm test', 'workflowId', 'git checkout src/a.ts']) {
    assert.ok(out.includes(`<code>${code}</code>`), code);
  }
  assert.equal((out.match(/role="button" tabindex="0"/g) ?? []).length, 5);
  assert.doesNotMatch(html('`图片` 和 `素材 89`'), /data-relative-path/);
});

test('explicit absolute and relative Markdown links preserve labels and encoded file URLs resolve correctly', () => {
  const out = html(
    '| 内容 | 位置 |\n|---|---|\n| 图片 | [图片](<D:/资料/项目 图片>) |\n| 文件 | [在文件夹中显示](<file:///D:/%E8%B5%84%E6%96%99/%E5%9B%BE%20%E7%89%87.jpg>) |\n| 相对 | [正片](<正片/素材 80.avi>) |',
    { relativePaths: true },
  );
  assert.match(out, /data-local-path="D:\/资料\/项目 图片">图片<\/span>/);
  assert.match(out, /data-local-path="D:\/资料\/图 片.jpg">在文件夹中显示<\/span>/);
  assert.match(out, /data-relative-path="正片\/素材 80.avi">正片<\/span>/);
  assert.match(html('[文档](docs)', { relativePaths: true }), /data-relative-path="docs">文档<\/span>/);
  assert.equal(localPathOf('file:///D:/%E8%B5%84%E6%96%99/100%25%20done.jpg'), 'D:/资料/100% done.jpg');
  assert.equal(localPathOf('file://server/share/a%20b.jpg'), '\\\\server\\share\\a b.jpg');
  assert.equal(fileLabel('file:///D:/%E8%B5%84%E6%96%99/%E5%9B%BE%20%E7%89%87.jpg'), '图 片.jpg');
  for (const value of [
    'file:///D:/%broken.jpg',
    'file:///D:/a%00.jpg',
    'javascript:alert(1)',
    'data:text/plain,test',
  ]) {
    assert.equal(localPathOf(value), undefined, value);
    assert.doesNotMatch(
      html(`[test](<${value}>)`, { relativePaths: true }),
      /data-local-path|data-relative-path|href=/,
    );
  }
});

test('Mac absolute paths and file URLs open local files with spaces and Unicode', () => {
  const path = '/Users/fixture/项目 图片/result.txt';
  assert.equal(localPathOf(path + ':12:3'), path);
  assert.equal(localPathOf('file:///Users/fixture/%E9%A1%B9%E7%9B%AE%20%E5%9B%BE%E7%89%87/result.txt'), path);
  assert.equal(fileLabel('/Users/fixture/back\\slash.txt'), 'back\\slash.txt');
  assert.equal(localPathOf('/Users/fixture/report?*.txt'), '/Users/fixture/report?*.txt');
  assert.equal(localPathOf('file:///Users/fixture/report%3F%2A%22.txt'), '/Users/fixture/report?*".txt');
  assert.match(html('[文件](</Users/fixture/report?*.txt>)'), /data-local-path="\/Users\/fixture\/report\?\*\.txt"/);
  assert.match(html('[文件](<file:///Users/fixture/report%3F%2A%22.txt>)'), /report\?\*&quot;\.txt/);
  assert.equal(localPathOf('C:/fixture/report?.txt'), undefined);
  for (const source of [`[打开文件](<${path}:12>)`, '`' + path + '`', `<${path}>`, path])
    assert.ok(html(source).includes(`data-local-path="${path}"`), source);
  assert.match(html('目录 `/Users/fixture/项目`，文件 `result.txt`'), /data-relative-path="result.txt"/);
  for (const value of ['//example.com/path', 'file:///Users/fixture/%broken', '/Users/fixture/a\u0000.txt'])
    assert.equal(localPathOf(value), undefined, value);
  assert.doesNotMatch(html('```sh\n/usr/bin/env node\n```'), /data-local-path/);
});

test('bare Windows paths stop at delimiters and retain surrounding Chinese text', () => {
  const out = html('结果在 D:\\资料\\图片，已经完成。文件 C:/out/a.jpg. 下一项在（D:\\视频）；继续。根目录 D:\\ 。');
  assert.match(out, /data-local-path="D:\\资料\\图片">D:\\资料\\图片<\/span>，已经完成。/);
  assert.match(out, /data-local-path="C:\/out\/a.jpg">C:\/out\/a.jpg<\/span>\. 下一项/);
  assert.match(out, /data-local-path="D:\\视频">D:\\视频<\/span>）；继续。/);
  assert.match(out, /data-local-path="D:\\">D:\\<\/span>/);
  assert.match(
    html("见 'D:\\图片\\a.jpg'. 已完成。"),
    /data-local-path="D:\\图片\\a.jpg">D:\\图片\\a.jpg<\/span>&#x27;\. 已完成。/,
  );
  assert.doesNotMatch(out, /data-local-path="[^\"]*(?:已经完成|下一项|继续)/);
  assert.doesNotMatch(html('```txt\nD:\\资料\\图片\n```'), /data-local-path/);
});

test('relative path context survives nested blockquotes and never leaks between renders', () => {
  const contextual = '目录 `D:\\资料`\n\n> 说明\n>\n> **`图片`**\n\n之后 `1.jpg`\n\n- `正片`\n  - *`素材 80.avi`*';
  const out = html(contextual);
  for (const path of ['图片', '1.jpg', '正片', '素材 80.avi']) assert.ok(out.includes(`data-relative-path="${path}"`));
  assert.doesNotMatch(html('`图片` 和 `1.jpg`'), /data-relative-path/);
  assert.doesNotMatch(html(contextual, { relativePaths: false }), /data-relative-path/);
  const first = renderMarkdown('`图片`', { relativePaths: true });
  const second = renderMarkdown('`图片`', { relativePaths: false });
  assert.match(renderToStaticMarkup(createElement(Fragment, null, ...first)), /data-relative-path/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(Fragment, null, ...second)), /data-relative-path/);
});

test('standalone pasted Windows paths retain spaces and parentheses instead of linking a missing prefix', () => {
  const folder = 'C:\\Users\\example\\Documents\\Altium Designer 25(64bit)';
  const file = folder + '.zip';
  const out = html(`${folder}\n${file}\n\n- ${folder}\n- ${file}`);
  assert.equal(out.split(`data-local-path="${folder}"`).length - 1, 2);
  assert.equal(out.split(`data-local-path="${file}"`).length - 1, 2);
  assert.doesNotMatch(out, /data-local-path="[^\"]*\\Altium"/);
  assert.doesNotMatch(html('```txt\n' + folder + '\n```'), /data-local-path/);
});
