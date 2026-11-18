import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Store } from '../src/server/store.ts';
import { WebSearchService } from '../src/server/web-search.ts';
import { pageTextFromHtml, readPublicPage } from '../src/server/web-page-reader.ts';

const publicLookup = async () => [{ address: '93.184.216.34' }];
const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const article = `<html><head><title>Agents &amp; async</title><style>p{}</style></head><body>
  <nav>Home Pricing</nav>
  <article><h1>Agents are going async</h1><p>${'Long running work. '.repeat(20)}</p><script>alert(1)</script></article>
  <footer>Footer links</footer></body></html>`;

test('the main text is read from the article, without navigation, scripts or footers', () => {
  const page = pageTextFromHtml(article);
  assert.equal(page.title, 'Agents & async');
  assert.match(page.content, /^Agents are going async\nLong running work/);
  assert.doesNotMatch(page.content, /Home Pricing|alert|Footer links/);
});

test('entities decode once, and a short article falls back to the whole page', () => {
  const page = pageTextFromHtml('<body><article>x</article><p>A &amp;lt; B &#20013;&#x6587;</p></body>');
  assert.match(page.content, /A &lt; B 中文/);
  assert.match(page.content, /^x/);
});

for (const address of [
  '10.0.0.1',
  '127.0.0.1',
  '192.168.1.5',
  '169.254.169.254',
  '::1',
  'fd00::1',
  '::ffff:10.0.0.1',
]) {
  test(`a host resolving to ${address} is refused before any request`, async () => {
    let calls = 0;
    await assert.rejects(
      readPublicPage('https://rebind.example.com/', {
        lookup: async () => [{ address: '93.184.216.34' }, { address }],
        fetch: (async () => {
          calls++;
          return html(article);
        }) as typeof fetch,
      }),
      /not public/,
    );
    assert.equal(calls, 0);
  });
}

test('every redirect is checked, and a redirect to a private address is refused', async () => {
  const seen: string[] = [];
  await assert.rejects(
    readPublicPage('https://example.com/a', {
      lookup: publicLookup,
      fetch: (async (url: string) => {
        seen.push(String(url));
        return new Response('', { status: 302, headers: { location: 'http://192.168.1.1/admin' } });
      }) as typeof fetch,
    }),
    /not public/,
  );
  assert.deepEqual(seen, ['https://example.com/a']);
});

test('a public redirect is followed and reports the final address', async () => {
  const page = await readPublicPage('https://example.com/a', {
    lookup: publicLookup,
    fetch: (async (url: string) =>
      String(url).endsWith('/a')
        ? new Response('', { status: 301, headers: { location: '/b' } })
        : html(article)) as typeof fetch,
  });
  assert.equal(page.url, 'https://example.com/b');
});

test('endless redirects, error pages, binaries and empty pages each say why', async () => {
  const run = (response: () => Response) =>
    readPublicPage('https://example.com/', { lookup: publicLookup, fetch: (async () => response()) as typeof fetch });
  await assert.rejects(
    run(() => new Response('', { status: 302, headers: { location: '/again' } })),
    /too many/,
  );
  await assert.rejects(
    run(() => new Response('no', { status: 403 })),
    /HTTP 403/,
  );
  await assert.rejects(
    run(() => new Response('%PDF', { headers: { 'content-type': 'application/pdf' } })),
    /not readable/,
  );
  await assert.rejects(
    run(() => html('<html><body><script>app()</script></body></html>')),
    /no readable text/,
  );
});

test('transport errors never reach the caller in their own words', async () => {
  await assert.rejects(
    readPublicPage('https://example.com/', {
      lookup: publicLookup,
      fetch: (async () => {
        throw new TypeError('connect failed at C:/private/path token=abc');
      }) as typeof fetch,
    }),
    (error: Error) => error.message === 'Page could not be reached.',
  );
});

test('long pages are capped and marked truncated', async () => {
  const page = await readPublicPage('https://example.com/', {
    lookup: publicLookup,
    fetch: (async () => new Response('x'.repeat(40000), { headers: { 'content-type': 'text/plain' } })) as typeof fetch,
  });
  assert.equal(page.content.length, 32000);
  assert.equal(page.truncated, true);
});

function service(t: import('node:test').TestContext, fetchImpl: typeof fetch) {
  const directory = mkdtempSync(join(tmpdir(), 'pugport-page-reader-'));
  const config = new Map<string, unknown>();
  const store = {
    config: <T>(key: string, fallback: T) => (config.has(key) ? (config.get(key) as T) : fallback),
    setConfig: (key: string, value: unknown) => void config.set(key, value),
  } as unknown as Pick<Store, 'config' | 'setConfig'>;
  const web = new WebSearchService(store, {
    secretsDir: directory,
    fetch: fetchImpl,
    lookup: publicLookup,
    writePrivate: undefined,
  });
  t.after(() => {
    web.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return web;
}
const providerUrl = (url: unknown) => String(url).startsWith('https://api.deepseek.com/');

test('when the provider cannot be reached the page is read directly, free', async (t) => {
  const web = service(t, (async (url: string) => {
    if (providerUrl(url)) throw new TypeError('fetch failed');
    return html(article);
  }) as typeof fetch);
  await web.update({ key: 'sk-synthetic-search-123456' });
  const page = await web.fetchPage('https://www.example.com/blog/post');
  assert.equal(page.title, 'Agents & async');
  assert.equal(page.estimatedCostCny, 0);
  assert.match(page.content, /Long running work/);
});

test('when both routes fail the error names both, and a cancelled task does not try the second', async (t) => {
  let direct = 0;
  const web = service(t, (async (url: string) => {
    if (providerUrl(url)) return new Response('', { status: 503 });
    direct++;
    return new Response('', { status: 404 });
  }) as typeof fetch);
  await web.update({ key: 'sk-synthetic-search-123456' });
  await assert.rejects(
    web.fetchPage('https://www.example.com/x'),
    /Search provider: .*Direct read: Page answered HTTP 404/,
  );
  assert.equal(direct, 1);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(web.fetchPage('https://www.example.com/x', { signal: cancelled.signal }));
  assert.equal(direct, 1);
});

test('with search switched off nothing is read directly', async (t) => {
  let calls = 0;
  const web = service(t, (async () => {
    calls++;
    return html(article);
  }) as typeof fetch);
  await assert.rejects(web.fetchPage('https://www.example.com/x'), /disabled|missing/);
  assert.equal(calls, 0);
});
