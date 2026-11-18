import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { DOMParser } from '@xmldom/xmldom';
import { buildModSrcDoc } from '../src/shared/mod-client-shim.ts';
import { electronModule } from './helpers/electron-harness.ts';

const nonce = 'a'.repeat(48);

test('srcdoc starts its head with DNS off and never parses author strings in the outer document', () => {
  const attack = '</script></head><head><meta http-equiv="x-dns-prefetch-control" content="on">';
  const srcdoc = buildModSrcDoc({ html: attack, css: attack, js: attack }, nonce);
  assert.ok(srcdoc.startsWith('<!doctype html><html><head><meta http-equiv="x-dns-prefetch-control" content="off">'));
  assert.equal(srcdoc.includes(attack), false);
  assert.equal((srcdoc.match(/<head>/g) ?? []).length, 1);
  assert.equal((srcdoc.match(/<script\b/g) ?? []).length, 1);
  assert.equal((srcdoc.match(/<\/script>/g) ?? []).length, 1);
});

test('srcdoc removes author DNS controls and hint rels before connecting nodes, including nested templates', () => {
  // XML fixtures give Node real attributes/entities and tree mutation, not a Chromium parser/network simulation.
  const html = `<div>
    <meta http-equiv="X-DNS-PREFETCH-CONTROL" content="on" />
    <link id="mixed" rel="alternate DNS-PREFETCH&#9;preconnect&#10;prefetch&#12;prerender&#13;preload modulepreload stylesheet" href="//hint.example.test" />
    <link id="safe" rel="stylesheet" href="data:text/css,body{}" />
    <link id="bare" href="//bare.example.test" />
    <a href="https://anchor.example.test/">anchor</a>
    <textarea id="notes">saved &amp; editable</textarea>
    <svg xmlns="http://www.w3.org/2000/svg"><template /></svg>
    <template><template><meta http-equiv="x-dns-prefetch-control" content="on" /><link rel="dns&#45;prefetch" href="//nested.example.test" /></template></template>
  </div>`;
  let connected: any;
  const styles: any[] = [];
  const scripts: any[] = [];
  const nodes: any[] = [];
  function adapt(root: any) {
    root.querySelectorAll = (selector: string) => {
      const [tag, attribute] = selector.replace(']', '').split('[');
      const found: any[] = [];
      const visit = (parent: any) => {
        for (const child of Array.from(parent.childNodes) as any[]) {
          if (child.nodeType !== 1) continue;
          if (child.tagName === tag && (!attribute || child.hasAttribute(attribute))) found.push(child);
          visit(child);
        }
      };
      visit(root);
      return found;
    };
    for (const child of Array.from(root.childNodes) as any[]) {
      if (child.nodeType !== 1) continue;
      nodes.push(child);
      child.remove = () => {
        assert.equal(connected, undefined, 'policy removal must precede attachment');
        child.parentNode.removeChild(child);
      };
      const setAttribute = child.setAttribute.bind(child);
      child.setAttribute = (...args: any[]) => {
        assert.equal(connected, undefined, 'rel filtering must precede attachment');
        setAttribute(...args);
      };
      if (child.tagName === 'template' && child.namespaceURI !== 'http://www.w3.org/2000/svg') {
        child.content = child.ownerDocument.createDocumentFragment();
        while (child.firstChild) child.content.appendChild(child.firstChild);
        adapt(child.content);
      } else adapt(child);
    }
    return root;
  }
  const template = {
    content: undefined as any,
    set innerHTML(value: string) {
      assert.equal(value, html, 'author input is decoded only inside the inert template');
      this.content = adapt(new DOMParser().parseFromString(value, 'application/xml').documentElement);
    },
  };
  const srcdoc = buildModSrcDoc({ html, css: 'body { color: red }', js: 'globalThis.authorRan = true' }, nonce);
  runInNewContext(srcdoc.match(/<script nonce="[a-f0-9]+">([\s\S]*)<\/script>/)![1]!, {
    window: {},
    addEventListener() {},
    document: {
      createElement: (tag: string) => (tag === 'template' ? template : { tag }),
      getElementById: () => ({ replaceChildren: (value: any) => (connected = value) }),
      head: { append: (value: any) => styles.push(value) },
      body: { append: (value: any) => scripts.push(value) },
    },
  });
  assert.equal(connected, template.content);
  assert.equal(nodes.filter((node) => node.tagName === 'meta' && node.parentNode).length, 0);
  const links = nodes.filter((node) => node.tagName === 'link');
  assert.deepEqual(
    links.map((link) => link.getAttribute('rel')),
    ['alternate stylesheet', 'stylesheet', null, ''],
  );
  assert.equal(nodes.find((node) => node.tagName === 'a').getAttribute('href'), 'https://anchor.example.test/');
  assert.equal(nodes.find((node) => node.tagName === 'textarea').textContent, 'saved & editable');
  assert.equal(styles[0].textContent, 'body { color: red }');
  assert.equal(styles[0].nonce, nonce);
  assert.equal(scripts[0].type, 'module');
  assert.equal(scripts[0].nonce, nonce);
  assert.equal(scripts[0].textContent, 'globalThis.authorRan = true');
});

test('desktop startup disables explicit DNS hints before any window and preserves existing Blink settings', async () => {
  for (const initial of ['', 'imagesEnabled=true,dnsPrefetchingEnabled=true']) {
    const switches = new Map([['blink-settings', initial]]);
    const module = await electronModule('src/electron/shell.ts', {
      app: {
        commandLine: {
          getSwitchValue: (key: string) => switches.get(key) ?? '',
          appendSwitch: (key: string, value: string) => switches.set(key, value),
        },
      },
      BrowserWindow: class {
        constructor() {
          assert.fail('startup policy must not create a window');
        }
      },
    });
    assert.equal(typeof module.createDesktopShell, 'function');
    assert.equal(switches.get('blink-settings'), [initial, 'dnsPrefetchingEnabled=false'].filter(Boolean).join(','));
  }
});
