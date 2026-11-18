import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { findNode, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

test('UI date calls specify the interface locale, except the separately owned Workspace', () => {
  for (const file of readdirSync('src/ui').filter((name) => /\.tsx?$/.test(name) && name !== 'Workspace.tsx')) {
    const source = readFileSync(`src/ui/${file}`, 'utf8');
    assert.doesNotMatch(source, /toLocale(?:Time|Date)?String\(\s*['"]zh-CN['"]/, file);
    assert.doesNotMatch(source, /new Date\([^\n]*?\)\.toLocale(?:Time|Date)?String\(\s*(?:\)|undefined)/, file);
  }
});

for (const locale of ['zh-CN', 'zh-TW', 'en-US']) {
  test(`dates use pinned UI locale ${locale} regardless of OS language`, async () => {
    const h = uiHarness(await uiBundle('src/ui/ParticipantReply.tsx'), {
      localStorage: { getItem: () => locale, setItem() {} },
      navigator: { languages: [locale], language: locale },
    });
    const at = '2026-10-28T17:23:00Z';
    const tree = h.render('ParticipantHeading', { name: 'Synthetic', at });
    assert.equal(
      text(findNode(tree, (node) => node.type === 'time')),
      new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }),
    );
  });
}
