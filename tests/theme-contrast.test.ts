import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../src/ui/studio.css', import.meta.url), 'utf8');
const luminance = (hex: string) => {
  const rgb = hex.match(/[\da-f]{2}/gi)!.map((part) => {
    const channel = parseInt(part, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
};
const contrast = (a: string, b: string) => {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
for (const [index, theme] of ['light', 'dark'].entries()) {
  const base = Object.fromEntries(
    [...css.split('}')[index]!.matchAll(/--([\w-]+):\s*(#[\da-f]{6})/gi)].map((m) => [m[1], m[2]!]),
  );
  for (const accent of ['blue', 'violet', 'teal', 'pink']) {
    test(`${theme} ${accent}: accent text and white button labels reach AA`, () => {
      const selector = `:root${theme === 'dark' ? "[data-theme='dark']" : ''}[data-accent='${accent}']`;
      const block = css.split('}').find((part) => part.trim().startsWith(selector));
      const tokens = {
        ...base,
        ...Object.fromEntries([...(block ?? '').matchAll(/--([\w-]+):\s*(#[\da-f]{6})/gi)].map((m) => [m[1], m[2]!])),
      };
      if (accent !== 'blue') assert.ok(block, selector);
      for (const background of ['bg-app', 'bg', 'panel', 'sidebar', 'raised'])
        assert.ok(
          contrast(tokens['accent-text']!, tokens[background]!) >= 4.5,
          `${background}: ${contrast(tokens['accent-text']!, tokens[background]!)}`,
        );
      assert.ok(contrast('#ffffff', tokens.accent!) >= 4.5, `button: ${contrast('#ffffff', tokens.accent!)}`);
    });
  }
}
for (const [index, theme] of ['light', 'dark'].entries()) {
  const tokens = Object.fromEntries(
    [...css.split('}')[index]!.matchAll(/--([\w-]+):\s*(#[\da-f]{6})/gi)].map((match) => [match[1], match[2]!]),
  );
  for (const text of ['text', 'muted', 'faint']) {
    for (const background of ['bg', 'panel', 'sidebar', 'raised']) {
      test(`${theme}: --${text} on --${background} reaches 4.5:1`, () => {
        const a = luminance(tokens[text]!);
        const b = luminance(tokens[background]!);
        const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        assert.ok(ratio >= 4.5, `${ratio.toFixed(3)}:1`);
      });
    }
  }
  test(`${theme}: faint stays less prominent than muted`, () => {
    assert.ok(
      theme === 'light'
        ? luminance(tokens.faint!) > luminance(tokens.muted!)
        : luminance(tokens.faint!) < luminance(tokens.muted!),
    );
  });
}

for (const [index, theme] of ['light', 'dark'].entries()) {
  test(`${theme}: active find text reaches 4.5:1 on warning`, () => {
    const tokens = Object.fromEntries(
      [...css.split('}')[index]!.matchAll(/--([\w-]+):\s*(#[\da-f]{6})/gi)].map((match) => [match[1], match[2]!]),
    );
    const a = luminance(tokens.bg!);
    const b = luminance(tokens.warning!);
    assert.ok((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5);
    const search = readFileSync(new URL('../src/ui/search.css', import.meta.url), 'utf8');
    assert.match(search, /::highlight\(conversation-find-active\)\s*\{[^}]*color: var\(--bg\)/);
  });
}
