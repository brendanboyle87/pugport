import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const docs = ['docs/WORK-MODES.md', 'docs/MODS.md', 'docs/FEATURES.md', 'docs/README.md', 'README.md'];
const slug = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');

test('work mode docs link only to files and headings that exist', () => {
  for (const doc of docs) {
    const text = readFileSync(doc, 'utf8');
    for (const [, target] of text.matchAll(/\]\(((?!https?:|mailto:|#)[^)\s]+)\)/g)) {
      const [file, anchor] = target!.split('#');
      const path = resolve(dirname(doc), file!);
      assert.ok(existsSync(path), `${doc} → ${target}`);
      if (anchor && path.endsWith('.md')) {
        const headings = [...readFileSync(path, 'utf8').matchAll(/^#{1,6} (.+)$/gm)].map((match) => slug(match[1]!));
        assert.ok(headings.includes(anchor), `${doc} → ${target}: no heading #${anchor}`);
      }
    }
  }
  for (const doc of ['docs/FEATURES.md', 'docs/README.md', 'README.md', 'docs/MODS.md'])
    assert.match(readFileSync(doc, 'utf8'), /WORK-MODES\.md/, `${doc} points at the work modes guide`);
});

test('the guide names the interface the way the English UI does, and the glossary has the four terms', () => {
  const english = Object.values(JSON.parse(readFileSync(join('src', 'shared', 'i18n', 'en.json'), 'utf8')));
  const guide = readFileSync('docs/WORK-MODES.md', 'utf8');
  for (const label of [
    'Create a Mod',
    'Allow and load',
    'Local build',
    'Edit in chat',
    'Open folder',
    'Export JSON',
    'Reload frame',
    'Send to chat',
    'Manifest valid',
    'Loaded',
    'Mods author',
    'Navigator',
  ]) {
    assert.ok(english.includes(label), `en.json has “${label}”`);
    assert.ok(guide.includes(label), `the guide uses “${label}”`);
  }
  const glossary = readFileSync('docs/ui-glossary.md', 'utf8');
  for (const term of ['Mode chip', 'Mods author', 'Navigator', 'Local build'])
    assert.match(glossary, new RegExp(`\\| ${term} \\|[^\\n]*\\| Approved 2026-11-04 \\|`), term);
});
