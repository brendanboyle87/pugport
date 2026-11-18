// Parts adapted from Orca (https://github.com/stablyai/orca), MIT License, Copyright (c) 2026 Lovecast Inc.
// See licenses/Orca-MIT.txt.
import { inlineText, markupLimits } from '../shared/markup.ts';
import type { PageElementHit, PagePoint, PageRect } from '../shared/desktop-tools.ts';

export const MARKUP_WORLD_ID = 7311;
export const pageViewportScript = '(() => ({ width: innerWidth, height: innerHeight, title: document.title }))()';

const helpers = String.raw`
  const inline = (text, limit) => Array.from(String(text || '').replace(/\s+/gu, ' ').replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim()).slice(0, limit).join('');
  const excluded = 'script, style, noscript, template, input, textarea, select, option, iframe, [aria-hidden="true"]';
  function readText(root, limit, box) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const parts = [];
    let node, length = 0;
    while ((node = walker.nextNode())) {
      if (!node.parentElement || node.parentElement.closest(excluded)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = Array.from(range.getClientRects());
      if (!rects.some(r => r.width > 0 && r.height > 0 && (!box ||
        r.right > box.x && r.bottom > box.y && r.left < box.x + box.width && r.top < box.y + box.height))) continue;
      const text = inline(node.textContent, limit - length);
      if (text) { parts.push(text); length += text.length + 1; }
      if (length >= limit) break;
    }
    return inline(parts.join(' '), limit);
  }
  function looksHashy(text) {
    return /^[A-Za-z0-9_-]{12,}$/.test(text) && /\d/.test(text) && /[A-Z]/.test(text);
  }
  function selectorPart(el) {
    const tag = el.tagName.toLowerCase();
    const testId = el.getAttribute('data-testid');
    if (testId && testId.length <= 60) return tag + '[data-testid="' + CSS.escape(testId) + '"]';
    if (/^[A-Za-z][\w-]{0,59}$/.test(el.id) && !/\d{3,}/.test(el.id) && !looksHashy(el.id)) return '#' + CSS.escape(el.id);
    const aria = el.getAttribute('aria-label');
    if (aria && aria.length <= 40) return tag + '[aria-label="' + CSS.escape(aria) + '"]';
    const classes = Array.from(el.classList).filter(c => c.length <= 60 && !/[:\[]/.test(c) && !/^css-/i.test(c) && !looksHashy(c)).slice(0, 2);
    return tag + classes.map(c => '.' + CSS.escape(c)).join('');
  }
  function buildSelector(el) {
    const parts = [];
    const unique = selector => { try { return document.querySelectorAll(selector).length === 1; } catch { return false; } };
    for (let current = el; current && current !== document.body && parts.length < 10; current = current.parentElement) {
      let part = selectorPart(current);
      if (!unique([part, ...parts].join(' > ')) && current.parentElement) {
        const siblings = Array.from(current.parentElement.children).filter(s => s.tagName === current.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
      }
      parts.unshift(part);
      if (unique(parts.join(' > '))) break;
    }
    return inline(parts.join(' > ') || el.tagName.toLowerCase(), 300);
  }
`;

export const pageElementScript = (point: PagePoint) => `(() => {
  ${helpers}
  const el = document.elementFromPoint(${point.x}, ${point.y});
  if (!el || el === document.body || el === document.documentElement) return null;
  const tag = inline(el.tagName.toLowerCase(), 40);
  const formy = /^(input|textarea|select|option)$/.test(tag);
  const rect = el.getBoundingClientRect();
  return {
    tag, selector: buildSelector(el), role: inline(el.getAttribute('role'), 40),
    name: inline(el.getAttribute('aria-label') || (tag === 'img' && el.getAttribute('alt')) || el.getAttribute('title') || el.getAttribute('placeholder') || (formy && el.labels?.[0] && readText(el.labels[0], 120)), 120),
    text: formy ? '' : readText(el, 120), frame: tag === 'iframe',
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  };
})()`;

export const pageTextScript = (rect: PageRect) => `(() => {
  ${helpers}
  return document.body ? readText(document.body, 300, ${JSON.stringify(rect)}) : '';
})()`;

const clean = (raw: unknown, limit: number) => (typeof raw === 'string' ? inlineText(raw, limit) : '');
export const cleanPageText = (raw: unknown): string => clean(raw, markupLimits.boxText);
export function cleanPageElement(raw: unknown): PageElementHit | null {
  if (!raw || typeof raw !== 'object') return null;
  const hit = raw as Record<string, unknown>;
  const rect = hit.rect as PageRect | undefined;
  if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return null;
  const bound = (n: number) => Math.min(20000, Math.max(0, n));
  // Clip, don't shift: an element partly scrolled out keeps its visible part in place.
  const x = bound(rect.x),
    y = bound(rect.y);
  return {
    tag: typeof hit.tag === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(hit.tag) ? hit.tag : 'unknown',
    selector: clean(hit.selector, markupLimits.selector),
    role: clean(hit.role, 40),
    name: clean(hit.name, markupLimits.name),
    text: /^(input|textarea|select|option)$/.test(String(hit.tag)) ? '' : clean(hit.text, markupLimits.elementText),
    frame: hit.frame === true,
    rect: { x, y, width: bound(rect.x + rect.width) - x, height: bound(rect.y + rect.height) - y },
  };
}
