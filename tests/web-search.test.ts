import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Store } from '../src/server/store.ts';
import { WebSearchService } from '../src/server/web-search.ts';

const key = 'sk-synthetic-search-123456';

test('bilingual search overlaps calls, interleaves and deduplicates origins, and bills both sides', async (t) => {
  const calls: Array<{ query: string; count: number }> = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = setup(t, {
    fetch: (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body);
      if (calls.length === 2) release();
      await gate;
      const side = body.query === '最新研究' ? 'original' : 'english';
      return new Response(
        JSON.stringify({
          results: [
            { title: side, url: `https://example.com/${side}`, summary: side },
            { title: 'Shared', url: 'https://example.com/shared', summary: side },
            { title: 'Outside count', url: `https://example.com/extra-${side}`, summary: '' },
          ],
        }),
      );
    }) as typeof fetch,
  });
  await f.service.update({ key });
  const pending = f.service.search({ query: '最新研究', englishQuery: 'latest research', count: 2 });
  assert.equal(calls.length, 2, 'Both requests must start before either provider response resolves');
  assert.deepEqual(
    calls.map((call) => call.count),
    [2, 2],
  );
  assert.equal(f.service.view().usage.reservedCny, 0.01);
  const result = await pending;
  assert.deepEqual(
    result.results.map((item) => item.url),
    ['https://example.com/original', 'https://example.com/english', 'https://example.com/shared'],
  );
  assert.deepEqual(
    result.results.map((item) => item.origins),
    [['query'], ['englishQuery'], ['query', 'englishQuery']],
  );
  assert.deepEqual(
    result.searches?.map((side) => side.estimatedCostCny),
    [0.005, 0.005],
  );
  assert.equal(result.estimatedCostCny, 0.01);
  assert.equal(f.service.view().usage.requests, 2);
  assert.equal(f.service.view().usage.billableRequests, 2);
  assert.equal(f.service.view().usage.reservedCny, 0);
});

test('bilingual search retains either surviving side and reports the failed side', async (t) => {
  for (const failedQuery of ['最新研究', 'latest research']) {
    const f = setup(t, {
      fetch: (async (_url, init) => {
        const { query } = JSON.parse(String(init?.body));
        return query === failedQuery ? new Response('', { status: 503 }) : fixture();
      }) as typeof fetch,
    });
    await f.service.update({ key });
    const result = await f.service.search({ query: '最新研究', englishQuery: 'latest research' });
    assert.equal(result.results.length, 1);
    assert.deepEqual(result.results[0]!.origins, [failedQuery === '最新研究' ? 'englishQuery' : 'query']);
    assert.match(result.note!, /failed or timed out/);
    assert.equal(result.searches?.find((side) => side.query === failedQuery)?.estimatedCostCny, null);
    assert.equal(result.estimatedCostCny, 0.005);
    assert.equal(f.service.view().usage.requests, 2);
    assert.equal(f.service.view().usage.billableRequests, 1);
    assert.equal(f.service.view().usage.reservedCny, 0);
  }
});

test('English-only and equal translated queries make one call; invalid translations spend nothing', async (t) => {
  const f = setup(t);
  await f.service.update({ key });
  await f.service.search({ query: 'latest research' });
  assert.equal(f.service.view().usage.requests, 1);
  await f.service.search({ query: 'latest research', englishQuery: ' Latest Research ' });
  assert.equal(f.service.view().usage.requests, 2);
  for (const englishQuery of ['', 'x'.repeat(129), 'bad\nquery', 42, '\ud800']) {
    await assert.rejects(f.service.search({ query: '中文', englishQuery: englishQuery as string }), /1 to 128/);
  }
  assert.equal(f.service.view().usage.requests, 2);
});

test('a stalled English side is cancelled within a few seconds without losing original results or its reservation', async (t) => {
  let englishSignal: AbortSignal | undefined;
  const f = setup(t, {
    fetch: (async (_url, init) => {
      const { query } = JSON.parse(String(init?.body));
      if (query === 'latest research') {
        englishSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      }
      return fixture();
    }) as typeof fetch,
  });
  await f.service.update({ key });
  const start = Date.now();
  const result = await f.service.search({ query: '最新研究', englishQuery: 'latest research' });
  assert.ok(Date.now() - start < 5000);
  assert.equal(englishSignal?.aborted, true);
  assert.deepEqual(result.results[0]!.origins, ['query']);
  assert.match(result.note!, /uncertain cost remains reserved/);
  assert.equal(f.service.view().usage.requests, 2);
  assert.equal(f.service.view().usage.billableRequests, 1);
  assert.equal(f.service.view().usage.uncertainRequests, 1);
  assert.equal(f.service.view().usage.reservedCny, 0.005);
});

test('bilingual failures and cancellation do not return a successful tool result', async (t) => {
  const f = setup(t, { fetch: (async () => new Response('', { status: 503 })) as typeof fetch });
  await f.service.update({ key });
  await assert.rejects(f.service.search({ query: '研究', englishQuery: 'research' }), /Both search queries failed/);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(f.service.search({ query: '研究', englishQuery: 'research' }, { signal: abort.signal }));
  assert.equal(f.service.view().usage.requests, 2);
});
const fixture = () =>
  new Response(
    JSON.stringify({
      results: [
        { title: '<b>Example</b>', url: 'https://example.com/page', summary: 'Useful facts', date: '2026-10-24' },
      ],
    }),
    { status: 200 },
  );
function setup(t: { after: (fn: () => void) => void }, deps: ConstructorParameters<typeof WebSearchService>[1] = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pugport-web-search-'));
  const saved = new Map<string, unknown>();
  const store = {
    config<T>(name: string, fallback: T): T {
      return structuredClone((saved.has(name) ? saved.get(name) : fallback) as T);
    },
    setConfig(name: string, value: unknown) {
      saved.set(name, structuredClone(value));
    },
  } as Pick<Store, 'config' | 'setConfig'>;
  // Test writer avoids Windows ACL helpers; production secure writing is tested separately below.
  const options = {
    secretsDir: dir,
    fetch: (async () => fixture()) as typeof fetch,
    writePrivate: async (file: string, value: string) => {
      writeFileSync(file, value);
    },
    ...deps,
  };
  const service = new WebSearchService(store, options);
  t.after(() => {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { service, dir, saved, store, options };
}
test('separate key, disabled defaults, settings restart, and private save failure is atomic', async (t) => {
  const f = setup(t);
  writeFileSync(join(f.dir, 'api-deepseek.key'), 'sk-model-only-1234');
  assert.equal(f.service.available(), false);
  assert.equal(f.service.view().monthlyLimitCny, 5);
  assert.equal(f.service.view().configured, false);
  await assert.rejects(f.service.search({ query: 'anything' }), /disabled/);
  assert.equal((await f.service.update({ key, enabled: false })).enabled, false);
  assert.equal(readFileSync(join(f.dir, 'web-search-deepseek.key'), 'utf8'), key);
  await f.service.update({ enabled: true, monthlyLimitCny: 0.01 });
  const restarted = new WebSearchService(f.store, f.options);
  t.after(() => restarted.close());
  assert.equal(restarted.available(), true);
  assert.equal(restarted.view().monthlyLimitCny, 0.01);
  assert.doesNotMatch(JSON.stringify([...f.saved]) + JSON.stringify(restarted.view()), /sk-/);
  for (const input of [
    { key: 'bad key' },
    { key, clearKey: true },
    { monthlyLimitCny: -1 },
    { monthlyLimitCny: 0.0001 },
    { key: 'abc\r\nInjected' },
  ])
    await assert.rejects(f.service.update(input));
  assert.equal(f.service.available(), true);
  const failed = new WebSearchService(f.store, {
    ...f.options,
    writePrivate: async () => {
      throw new Error(key);
    },
  });
  t.after(() => failed.close());
  await assert.rejects(failed.update({ key: 'sk-replacement-987654' }), (error: Error) => !error.message.includes(key));
  assert.equal(readFileSync(join(f.dir, 'web-search-deepseek.key'), 'utf8'), key);
  assert.equal(failed.available(), true);
  await f.service.update({ clearKey: true });
  assert.equal(f.service.view().configured, false);
  assert.equal(f.service.view().enabled, false);
  assert.equal(new WebSearchService(f.store, f.options).view().configured, false);
});

test('real private writer saves synthetic key with independent filename', async (t) => {
  const f = setup(t);
  const service = new WebSearchService(f.store, { secretsDir: f.dir });
  t.after(() => service.close());
  assert.equal((await service.update({ key })).configured, true);
  assert.equal(readFileSync(join(f.dir, 'web-search-deepseek.key'), 'utf8'), key);
});

test('search uses fixed official endpoint and bounded sanitized results; fetch shares billing', async (t) => {
  const calls: { url: string; body: any; headers: any }[] = [];
  const f = setup(t, {
    fetch: (async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers });
      assert.equal(init?.redirect, 'manual');
      return calls.length === 1
        ? new Response(
            JSON.stringify({
              results: Array.from({ length: 10 }, (_, n) => ({
                title: '<b>Title</b>',
                url: `https://example.com/${n}`,
                summary: 'x'.repeat(3000),
                date: '2026-10-24',
              })),
            }),
          )
        : new Response(JSON.stringify({ title: '<b>Page</b>', content: 'x'.repeat(40000) }));
    }) as typeof fetch,
  });
  await f.service.update({ key });
  const result = await f.service.search({ query: '中文🦄', count: 10 });
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/tools/search');
  assert.deepEqual(calls[0].body, { query: '中文🦄', count: 10, need_content: false });
  assert.equal(calls[0].headers.Authorization, `Bearer ${key}`);
  assert.equal(result.results[0].title, 'Title');
  assert.equal(result.results[0].date, '2026-10-24');
  assert.equal(
    result.results.reduce((sum, item) => sum + item.summary.length, 0),
    16000,
  );
  assert.equal(result.truncated, true);
  const page = await f.service.fetchPage('https://example.com/a');
  assert.equal(calls[1].url, 'https://api.deepseek.com/v1/tools/fetch');
  assert.deepEqual(calls[1].body, { url: 'https://example.com/a' });
  assert.equal(page.content.length, 32000);
  assert.equal(page.truncated, true);
  assert.equal(page.title, 'Page');
  assert.equal(f.service.view().usage.billableRequests, 2);
  assert.equal(f.service.view().usage.estimatedCostCny, 0.01);
  assert.equal(f.service.view().usage.reservedCny, 0);
});

test('query, count and private/local URL validation happens without any request', async (t) => {
  let calls = 0;
  const f = setup(t, {
    fetch: (async () => {
      calls++;
      return fixture();
    }) as typeof fetch,
  });
  await f.service.update({ key });
  for (const query of ['', 'x'.repeat(129), 'abc\0secret', '\ud800']) await assert.rejects(f.service.search({ query }));
  for (const count of [0, 11, 1.1, NaN]) await assert.rejects(f.service.search({ query: 'x', count }));
  for (const url of [
    'file:///etc/passwd',
    'ftp://example.com',
    'https://user:pass@example.com',
    'http://localhost',
    'http://a.local',
    'http://a.internal',
    'http://127.1',
    'http://2130706433',
    'http://0x7f000001',
    'http://10.0.0.1',
    'http://172.16.1.1',
    'http://192.168.1.1',
    'http://169.254.169.254',
    'http://100.64.0.1',
    'http://[::1]',
    'http://[::ffff:127.0.0.1]',
    'http://[fd00::1]',
    'http://[fe80::1]',
  ])
    await assert.rejects(f.service.fetchPage(url), /public/);
  assert.equal(calls, 0);
  assert.equal(f.service.view().usage.requests, 0);
  assert.equal((await f.service.search({ query: '🦄'.repeat(128) })).results.length, 1);
});

test('reserve before await prevents concurrent budget overshoot and reservations survive restart/month change', async (t) => {
  let resolve!: (response: Response) => void;
  let calls = 0;
  let now = Date.parse('2026-10-24T12:00:00Z');
  const f = setup(t, {
    now: () => now,
    fetch: (() => {
      calls++;
      return new Promise<Response>((done) => {
        resolve = done;
      });
    }) as typeof fetch,
  });
  await f.service.update({ key, monthlyLimitCny: 0.005 });
  const first = f.service.search({ query: 'one' });
  assert.equal(f.service.view().usage.uncertainRequests, 1);
  await assert.rejects(f.service.search({ query: 'two' }), /budget/);
  assert.equal(calls, 1);
  const restarted = new WebSearchService(f.store, f.options);
  t.after(() => restarted.close());
  await assert.rejects(restarted.search({ query: 'three' }), /budget/);
  now = Date.parse('2026-11-01T12:00:00Z');
  assert.equal(restarted.view().usage.uncertainRequests, 1);
  assert.equal(restarted.view().usage.reservedCny, 0.005);
  await assert.rejects(restarted.search({ query: 'new month still reserved' }), /budget/);
  await assert.rejects(f.service.search({ query: 'live month rollover' }), /budget/);
  assert.equal(calls, 1);
  resolve(fixture());
  await first;
});

test('concurrency cap and revoking key, disabling, replacing key or closing aborts active requests', async (t) => {
  for (const action of ['clear', 'disable', 'replace', 'close']) {
    const f = setup(t, { fetch: (async () => new Promise<Response>(() => {})) as typeof fetch });
    await f.service.update({ key });
    const pending = Array.from({ length: 4 }, (_, i) => f.service.search({ query: String(i) }));
    const caught = Promise.all(pending.map((promise) => assert.rejects(promise, /cancelled/)));
    await assert.rejects(f.service.search({ query: 'fifth' }), /Too many/);
    if (action === 'clear') await f.service.update({ clearKey: true });
    if (action === 'disable') await f.service.update({ enabled: false });
    if (action === 'replace') await f.service.update({ key: 'sk-new-synthetic-key' });
    if (action === 'close') f.service.close();
    await caught;
    assert.equal(f.service.view().usage.uncertainRequests, 4);
    assert.equal(f.service.view().usage.reservedCny, 0.02);
  }
});

test('known HTTP errors and empty outcomes release reservations without retries', async (t) => {
  const responses = [
    new Response(key, { status: 401 }),
    new Response(key, { status: 429 }),
    new Response(key, { status: 503 }),
    new Response('', { status: 302 }),
    new Response('{"results":[]}'),
    new Response('{"content":"  "}'),
    // An empty provider answer falls through to the direct read, which costs nothing.
    new Response('plain page text', { headers: { 'content-type': 'text/plain' } }),
  ];
  let calls = 0;
  const f = setup(t, {
    lookup: async () => [{ address: '93.184.216.34' }],
    fetch: (async () => {
      calls++;
      return responses.shift()!;
    }) as typeof fetch,
  });
  await f.service.update({ key, monthlyLimitCny: 0.005 });
  for (let i = 0; i < 4; i++)
    await assert.rejects(f.service.search({ query: 'x' }), (error: Error) => !error.message.includes(key));
  assert.equal((await f.service.search({ query: 'x' })).estimatedCostCny, 0);
  assert.equal((await f.service.fetchPage('https://example.com')).estimatedCostCny, 0);
  assert.equal(calls, 7);
  assert.deepEqual(f.service.view().usage, {
    requests: 6,
    billableRequests: 0,
    uncertainRequests: 0,
    estimatedCostCny: 0,
    reservedCny: 0,
  });
  const month = Object.values(f.saved.get('webSearchUsage') as Record<string, any>)[0];
  assert.equal(month.noResults, 2);
  assert.equal(month.errors, 4);
});

test('transport, malformed response, response-size and timeout uncertainty retain reservations', async (t) => {
  const failing = [
    (async () => {
      throw new Error(`network ${key}`);
    }) as typeof fetch,
    (async () => new Response('not json')) as typeof fetch,
    (async () => new Response('{"error":"unexpected"}')) as typeof fetch,
    (async () => new Response('x', { headers: { 'content-length': String(1024 * 1024 + 1) } })) as typeof fetch,
    (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024 + 1));
            controller.close();
          },
        }),
      )) as typeof fetch,
    (async () => new Promise<Response>(() => {})) as typeof fetch,
  ];
  for (const fetch of failing) {
    const f = setup(t, { fetch, timeoutMs: 15 });
    await f.service.update({ key });
    await assert.rejects(f.service.search({ query: 'x' }), (error: Error) => !error.message.includes(key));
    assert.equal(f.service.view().usage.billableRequests, 0);
    assert.equal(f.service.view().usage.uncertainRequests, 1);
    assert.equal(f.service.view().usage.reservedCny, 0.005);
  }
});

test('caller cancellation before sending costs nothing; during response reading remains uncertain', async (t) => {
  const f = setup(t, {
    fetch: (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{'));
          },
        }),
      )) as typeof fetch,
  });
  await f.service.update({ key });
  const before = new AbortController();
  before.abort();
  await assert.rejects(f.service.search({ query: 'x' }, { signal: before.signal }), /cancelled/);
  assert.equal(f.service.view().usage.requests, 0);
  const during = new AbortController();
  const pending = f.service.search({ query: 'x' }, { signal: during.signal });
  during.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(f.service.view().usage.uncertainRequests, 1);
});

test('shutdown waits for aborted request accounting before the store closes', async (t) => {
  const f = setup(t, { fetch: (async () => new Promise<Response>(() => {})) as typeof fetch });
  await f.service.update({ key });
  const pending = f.service.search({ query: 'x' });
  const caught = assert.rejects(pending, /cancelled/);
  await f.service.close();
  const snapshot = JSON.stringify([...f.saved]);
  await caught;
  assert.equal(JSON.stringify([...f.saved]), snapshot);
  assert.equal(f.service.available(), false);
  assert.equal(Object.values(f.saved.get('webSearchUsage') as Record<string, any>)[0].errors, 1);
});

test('reservation persistence failure prevents the network call and does not consume budget', async (t) => {
  let calls = 0;
  const f = setup(t, {
    fetch: (async () => {
      calls++;
      return fixture();
    }) as typeof fetch,
  });
  await f.service.update({ key });
  f.store.setConfig = () => {
    throw new Error('disk full');
  };
  await assert.rejects(f.service.search({ query: 'x' }), /reserve search budget/);
  assert.equal(calls, 0);
  assert.equal(f.service.view().usage.requests, 0);
  assert.equal(f.service.view().usage.reservedCny, 0);
});

test('corrupt persisted settings and usage fail closed without crashing or overwriting evidence', async (t) => {
  let calls = 0;
  const f = setup(t, {
    fetch: (async () => {
      calls++;
      return fixture();
    }) as typeof fetch,
  });
  await f.service.update({ key });
  const settings = { enabled: true, limitMilli: 5000 };
  const month = { requests: 1, billableRequests: 0, uncertainRequests: 1, reservedMilli: 5, errors: 1, noResults: 0 };
  const corruptions: [string, unknown][] = [
    ['webSearchSettings', null],
    ['webSearchSettings', { ...settings, limitMilli: null }],
    ['webSearchSettings', { ...settings, limitMilli: NaN }],
    ['webSearchSettings', { ...settings, limitMilli: Infinity }],
    ['webSearchSettings', { ...settings, limitMilli: -1 }],
    ['webSearchSettings', { ...settings, enabled: 'true' }],
    ['webSearchUsage', null],
    ['webSearchUsage', []],
    ['webSearchUsage', { '2026-10': null }],
    ['webSearchUsage', { '2026-99': month }],
    ['webSearchUsage', { '2026-10': { ...month, requests: -1 } }],
    ['webSearchUsage', { '2026-10': { ...month, reservedMilli: NaN } }],
    ['webSearchUsage', { '2026-10': { ...month, reservedMilli: null } }],
    ['webSearchUsage', { '2026-10': { ...month, uncertainRequests: Infinity } }],
    ['webSearchUsage', { '2026-10': { ...month, reservedMilli: 0 } }],
    ['webSearchUsage', { '2026-10': { ...month, requests: 0 } }],
    ['webSearchUsage', { '2026-10': { ...month, noResults: undefined } }],
  ];
  for (const [name, value] of corruptions) {
    f.saved.set('webSearchSettings', settings);
    f.saved.set('webSearchUsage', { '2026-10': month });
    f.saved.set(name, value);
    const original = structuredClone([...f.saved]);
    const service = new WebSearchService(f.store, f.options);
    assert.equal(service.available(), false);
    assert.doesNotThrow(() => service.view());
    assert.equal(service.view().enabled, false);
    await assert.rejects(service.search({ query: 'x' }), /repair local configuration/);
    await assert.rejects(service.update({ enabled: true, monthlyLimitCny: 5 }), /repair local configuration/);
    assert.deepEqual([...f.saved], original);
    await service.close();
  }
  f.store.config = () => {
    throw new SyntaxError('malformed JSON');
  };
  const invalidJson = new WebSearchService(f.store, f.options);
  assert.equal(invalidJson.available(), false);
  assert.doesNotThrow(() => invalidJson.view());
  await invalidJson.close();
  assert.equal(calls, 0);
});
