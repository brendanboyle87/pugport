import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfirmDialog } from '../src/ui/ConfirmDialog.tsx';
import { webAgentRisk } from '../src/shared/external-agents.ts';
import { findNode, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const options = { title: '开启 Grok Bot？', ...webAgentRisk, action: '开启 Grok Bot' };
let code: string;
before(async () => {
  code = await uiBundle('tests/helpers/confirmation-fixture.ts');
});

test('the app dialog renders an accessible title, four risk points and an action-named button', () => {
  const html = renderToStaticMarkup(createElement(ConfirmDialog, { options, onAnswer() {} }));
  assert.match(html, /role="alertdialog" aria-modal="true" aria-labelledby="[^"]+" aria-describedby="[^"]+"/);
  assert.match(html, /<h2[^>]*>开启 Grok Bot？<\/h2>/);
  assert.equal((html.match(/<li>/g) ?? []).length, 4);
  for (const point of webAgentRisk.points) assert.ok(html.includes(point));
  assert.match(html, /<button[^>]*>开启 Grok Bot<\/button>/);
  assert.match(html, /<button[^>]*>取消<\/button>/);
  assert.match(
    renderToStaticMarkup(createElement(ConfirmDialog, { options: { ...options, tone: 'danger' }, onAnswer() {} })),
    /class="button danger"/,
  );
});

test('Enter leaves the answer to the focused button; Escape cancels and IME Enter is ignored', () => {
  const answers: boolean[] = [];
  const h = uiHarness(code);
  const dialog = h.render('ConfirmDialog', { options, onAnswer: (answer: boolean) => answers.push(answer) });
  const key = (key: string, composing = false) =>
    dialog.props.onKeyDown({ key, nativeEvent: { isComposing: composing }, preventDefault() {}, stopPropagation() {} });
  key('Enter', true);
  assert.deepEqual(answers, []);
  key('Enter');
  assert.deepEqual(answers, [], 'bubbling Enter cannot approve');
  findNode(dialog, (node) => node.type === 'button' && node.props.children === '取消')!.props.onClick();
  findNode(dialog, (node) => node.type === 'button' && node.props.children === options.action)!.props.onClick();
  key('Escape');
  assert.deepEqual(answers, [false, true, false]);
  const target = { getBoundingClientRect: () => ({ left: 10, right: 100, top: 10, bottom: 100 }) };
  dialog.props.onClick({ target, currentTarget: target, clientX: 20, clientY: 20 });
  assert.equal(answers.length, 3, 'padding inside the dialog does not cancel');
  dialog.props.onClick({ target, currentTarget: target, clientX: 5, clientY: 5 });
  assert.equal(answers.at(-1), false, 'backdrop cancels');
  h.unmount();
});

test('promise questions queue and each answer settles only its own question', async () => {
  const h = uiHarness(code);
  const store = h.exports.confirmationStore;
  const first = h.exports.confirmDialog(options);
  const firstId = store.snapshot().id;
  const second = h.exports.confirmDialog({ title: '移除设备？', action: '移除设备' });
  store.resolve(firstId, true);
  const secondId = store.snapshot().id;
  store.resolve(firstId, true);
  assert.equal(store.snapshot().id, secondId, 'stale or duplicate answers are ignored');
  store.resolve(secondId, false);
  assert.deepEqual(await Promise.all([first, second]), [true, false]);
  assert.equal(store.snapshot(), undefined);
});

test('all former renderer callers use the helper and no native confirm, alert or prompt remains', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
    );
  for (const file of files('src/ui').filter((file) => /\.tsx?$/.test(file)))
    assert.doesNotMatch(
      readFileSync(file, 'utf8'),
      /\bwindow\.(confirm|alert|prompt)\s*\(|(?:^|[^.\w])(?:confirm|alert|prompt)\s*\(/m,
      file,
    );
  for (const file of [
    'AgentConnect.tsx',
    'Devices.tsx',
    'Executors.tsx',
    'Extensions.tsx',
    'ExternalAgents.tsx',
    'SideChatHistory.tsx',
    'swarm-switch.ts',
  ])
    assert.match(readFileSync(join('src/ui', file), 'utf8'), /confirmDialog/, file);
});
