import { DOMParser } from '@xmldom/xmldom';
import { runInNewContext } from 'node:vm';
import { pageHelper } from '../../src/electron/web-page-helper.ts';

/** Small deterministic DOM adapter. Geometry is explicit; real layout belongs to the Electron smoke test. */
export function pageFixture(markup: string, setup = '') {
  const doc: any = new DOMParser().parseFromString(`<html><body>${markup}</body></html>`, 'text/html');
  let observer: (records: any[]) => void = () => {};
  const elements = (el: any): any[] =>
    Array.from(el.childNodes ?? []).flatMap((child: any) => (child.nodeType === 1 ? [child, ...elements(child)] : []));
  const matches = (el: any, selectors: string): boolean =>
    selectors.split(',').some((selector) => {
      const s = selector.trim();
      if (s === '*') return true;
      const tag = s.match(/^[a-z][\w-]*/i)?.[0];
      if (tag && tag.toUpperCase() !== el.tagName) return false;
      const id = s.match(/#([\w-]+)/)?.[1];
      if (id && el.getAttribute('id') !== id) return false;
      for (const match of s.matchAll(/\.([\w-]+)/g)) if (!el.classList.includes(match[1])) return false;
      for (const match of s.matchAll(/\[([\w-]+)(?:(\*?=)"([^"]*)"( i)?)?\]/g)) {
        if (!el.hasAttribute(match[1])) return false;
        const value = el.getAttribute(match[1]);
        const actual = match[4] ? value.toLowerCase() : value;
        const expected = match[4] ? match[3]?.toLowerCase() : match[3];
        if (match[2] === '*=' ? !actual.includes(expected) : match[2] === '=' && actual !== expected) return false;
      }
      return true;
    });
  const rendered = (el: any): string => {
    if (el.nodeType === 3) return el.textContent;
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return '';
    if (el.tagName === 'BR') return '\n';
    const text = Array.from(el.childNodes).map(rendered).join('');
    if (el.tagName === 'PRE') return text;
    return /^(DIV|P|LI|UL|OL|H\d|PRE|TR|SECTION|ARTICLE|MAIN)$/.test(el.tagName) ? `\n${text}\n` : text;
  };
  const install = (el: any) => {
    if (el.nodeType !== 1) return;
    el.tagName = el.tagName.toUpperCase();
    Object.defineProperties(el, {
      parentElement: { get: () => (el.parentNode?.nodeType === 1 ? el.parentNode : null), configurable: true },
      children: { get: () => Array.from(el.childNodes).filter((node: any) => node.nodeType === 1), configurable: true },
      classList: { get: () => (el.getAttribute('class') || '').split(/\s+/).filter(Boolean), configurable: true },
      innerText: { get: () => rendered(el), configurable: true },
      isConnected: {
        get: () => {
          let p = el;
          while (p.parentNode) p = p.parentNode;
          return p === doc;
        },
        configurable: true,
      },
    });
    el.contains = (other: any) => {
      for (let p = other; p; p = p.parentNode) if (p === el) return true;
      return false;
    };
    el.closest = (selector: string) => {
      for (let p = el; p?.nodeType === 1; p = p.parentNode) if (matches(p, selector)) return p;
      return null;
    };
    el.querySelectorAll = (selector: string) => elements(el).filter((node) => matches(node, selector));
    el.querySelector = (selector: string) => el.querySelectorAll(selector)[0] ?? null;
    el.getBoundingClientRect = () => {
      const [left, top, width, height] = (el.getAttribute('data-rect') || '300,100,600,80').split(',').map(Number);
      return { left, top, width, height, right: left + width, bottom: top + height };
    };
    el.clientHeight = el.getBoundingClientRect().height;
    el.compareDocumentPosition = (other: any) => (elements(doc).indexOf(el) < elements(doc).indexOf(other) ? 4 : 2);
    for (const child of el.children) install(child);
  };
  install(doc.documentElement);
  doc.body = doc.documentElement.querySelector('body');
  doc.scrollingElement = doc.documentElement;
  doc.querySelectorAll = (s: string) => elements(doc).filter((el) => matches(el, s));
  doc.createTreeWalker = (root: any) => {
    const texts = (el: any): any[] =>
      Array.from(el.childNodes ?? []).flatMap((node: any) => (node.nodeType === 3 ? [node] : texts(node)));
    const nodes = texts(root);
    for (const node of nodes)
      Object.defineProperty(node, 'parentElement', { get: () => node.parentNode, configurable: true });
    let i = 0;
    return { nextNode: () => nodes[i++] ?? null };
  };
  const context: any = {
    document: doc,
    innerWidth: 1000,
    innerHeight: 800,
    URL,
    location: { href: 'https://fixture.test/', pathname: '/' },
    NodeFilter: { SHOW_TEXT: 4 },
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    CSS: { escape: (s: string) => s },
    getComputedStyle: (el: any) => ({
      visibility: 'visible',
      display: el.closest('[hidden]') ? 'none' : 'block',
      opacity: '1',
      overflowY: el.getAttribute('data-scroll') || 'visible',
    }),
    MutationObserver: class {
      constructor(callback: typeof observer) {
        observer = callback;
      }
      observe() {}
      disconnect() {}
    },
  };
  runInNewContext(setup + pageHelper, context);
  const append = (selector: string, html: string) => {
    const parsed = new DOMParser().parseFromString(`<wrapper>${html}</wrapper>`, 'text/html');
    const parent = doc.querySelectorAll(selector)[0];
    const added: any[] = [];
    for (const source of Array.from(parsed.documentElement!.childNodes) as any[]) {
      const node = doc.importNode(source, true);
      parent.appendChild(node);
      install(node);
      added.push(node);
    }
    observer([{ type: 'childList', addedNodes: added }]);
    return added[0];
  };
  const changeText = (selector: string, text: string) => {
    const el = doc.querySelectorAll(selector)[0];
    el.textContent = text;
    observer([{ type: 'characterData', target: { parentElement: el } }]);
  };
  return { bridge: context.__pugportBridge, doc, append, changeText };
}
