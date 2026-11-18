import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import {
  diagnosticBodyLimit,
  diagnosticRequest,
  NetworkDiagnosticRun,
  observeMuseNetwork,
  responseShape,
} from '../src/electron/network-diagnostic.ts';

function fixture(enabled = true) {
  let now = 0;
  let marker = enabled;
  let checks = 0;
  let tick = () => {};
  let cancelled = false;
  const lines: string[] = [];
  const commands: { method: string; params?: object }[] = [];
  const debug = Object.assign(new EventEmitter(), {
    attached: false,
    attaches: 0,
    detaches: 0,
    failAttach: false,
    failEnable: false,
    body: '{"remaining":42}',
    base64Encoded: false,
    bodyRead: undefined as undefined | (() => Promise<{ body: string }>),
    isAttached() {
      return this.attached;
    },
    attach(version: string) {
      assert.equal(version, '1.3');
      if (this.failAttach) throw new Error('synthetic attachment failure');
      this.attached = true;
      this.attaches++;
    },
    detach() {
      this.attached = false;
      this.detaches++;
      debug.emit('detach');
    },
    async sendCommand(method: string, params?: object) {
      commands.push({ method, params });
      if (method === 'Network.enable' && this.failEnable) throw new Error('synthetic enable failure');
      if (method === 'Network.getResponseBody')
        return this.bodyRead?.() ?? { body: this.body, base64Encoded: this.base64Encoded };
      assert.equal(method, 'Network.enable');
      return {};
    },
  });
  const run = new NetworkDiagnosticRun({
    markerExists: () => {
      checks++;
      return marker;
    },
    append: (line) => lines.push(line),
    now: () => now,
  });
  const start = () =>
    observeMuseNetwork({
      run,
      debugger: debug,
      origin: 'https://configured.test',
      currentUrl: () => 'https://app.muse.ai/chat',
      every: (callback) => {
        tick = callback;
        return () => {
          cancelled = true;
        };
      },
    });
  const event = (method: string, params: object) => debug.emit('message', {}, `Network.${method}`, params);
  const request = (
    id = '1',
    url = 'https://app.muse.ai/api/usage?token=URL_SECRET',
    type = 'Fetch',
    postData?: string,
  ) =>
    event('requestWillBeSent', {
      requestId: id,
      type,
      request: {
        url,
        method: postData ? 'POST' : 'GET',
        postData,
        headers: { Authorization: 'HEADER_SECRET', Cookie: 'COOKIE_SECRET' },
      },
    });
  const response = (id = '1', contentType = 'application/json; charset=utf-8') =>
    event('responseReceived', {
      requestId: id,
      response: {
        status: 200,
        headers: { 'Content-Type': contentType, 'Set-Cookie': 'RESPONSE_COOKIE' },
        mimeType: 'application/json',
      },
    });
  const finish = async (id = '1', size = 10) => {
    event('loadingFinished', { requestId: id, encodedDataLength: size });
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    run,
    debug,
    lines,
    commands,
    start,
    request,
    response,
    finish,
    event,
    tick: () => tick(),
    time: (value: number) => {
      now = value;
    },
    marker: (value: boolean) => {
      marker = value;
    },
    checks: () => checks,
    cancelled: () => cancelled,
  };
}

test('recorded line contains only allowed metadata, request shape and redacted response values', async () => {
  const f = fixture();
  const stop = f.start();
  const input = {
    email: 'synthetic@example.test',
    token: 'SECRET_TOKEN',
    name: 'Alice',
    date: '2026-10-26T10:20:30Z',
    day: '2026-10-26',
    numeric: '12.5',
    percent: 52,
    enabled: true,
    missing: null,
    invalidDate: '2026-99-99',
    almostNumber: '12abc',
    nested: { name: 'Bob' },
    list: ['one', 2, false, 'FOURTH_SECRET'],
    headers: { Authorization: 'BODY_HEADER_SECRET' },
    cookies: 'BODY_COOKIE_SECRET',
  };
  f.debug.body = JSON.stringify(input);
  f.request(
    '1',
    'https://user:PASS_SECRET@app.muse.ai/api/usage?token=URL_SECRET&email=EMAIL_SECRET#FRAGMENT_SECRET',
    'Fetch',
    JSON.stringify({
      operationName: 'UsageQuery',
      query:
        'query UsageQuery { usage(email: "GRAPH_SECRET", note: "escaped\\\"SECRET") { remaining } } # COMMENT_SECRET',
      variables: input,
    }),
  );
  f.response();
  await f.finish();
  stop();
  assert.equal(f.lines.length, 1);
  const line = JSON.parse(f.lines[0]);
  assert.equal(line.origin, 'https://app.muse.ai');
  assert.equal(line.path, '/api/usage');
  assert.deepEqual(line.queryNames, ['token', 'email']);
  assert.equal(line.status, 200);
  assert.equal(line.contentType, 'application/json');
  assert.equal(line.responseSize, 10);
  assert.equal(line.requestBody.operationName, 'UsageQuery');
  assert.ok(line.requestBody.query.startsWith('query UsageQuery'));
  assert.ok(line.requestBody.keys.some((entry: any) => entry.path.join('.') === 'variables.email'));
  assert.ok(line.requestBody.keys.every((entry: any) => !('value' in entry)));
  const entries = new Map<string, any>(line.responseBody.map((entry: any) => [entry.path.join('.'), entry]));
  for (const key of ['date', 'day', 'numeric', 'percent', 'enabled', 'missing'] as const)
    assert.equal(entries.get(key).value, input[key]);
  for (const key of ['email', 'token', 'name', 'invalidDate', 'almostNumber'] as const)
    assert.equal(entries.get(key).value, `<string len=${input[key].length}>`);
  assert.equal(entries.get('nested.name').value, '<string len=3>');
  assert.equal(entries.get('list').length, 4);
  assert.equal(entries.get('list.0').type, 'string');
  assert.equal(entries.get('list.1').type, 'number');
  assert.equal(entries.get('list.2').type, 'boolean');
  assert.equal(entries.has('list.3'), false);
  for (const secret of [
    'SECRET',
    'Alice',
    'Bob',
    'synthetic@example.test',
    'Cookie',
    'cookies',
    'headers',
    'Authorization',
  ])
    assert.ok(!f.lines[0].includes(secret), secret);
  assert.deepEqual([...new Set(f.commands.map((c) => c.method))], ['Network.enable', 'Network.getResponseBody']);
});

test('GraphQL strips block and unfinished strings before truncation; arbitrary request values are omitted', () => {
  for (const query of [
    'query Q { f(x: """BLOCK_SECRET\nMORE_SECRET""") }',
    'query Q { f(x: """BLOCK_SECRET\\"""MORE_SECRET""") }',
    'query Q { f(x: "UNFINISHED_SECRET',
    'query Q { f(x: "' + 'LONG_SECRET'.repeat(100) + '") }',
  ]) {
    const line = diagnosticRequest(
      {
        url: 'https://muse.ai/graphql',
        method: 'POST',
        postData: JSON.stringify({ query, operationName: 'Q', value: 12345 }),
      },
      'XHR',
      [],
      0,
    )!;
    assert.ok(!JSON.stringify(line).includes('SECRET'));
    assert.ok(!JSON.stringify(line).includes('12345'));
    assert.ok(line.requestBody!.query!.length <= 120);
  }
  const ordinary = diagnosticRequest(
    {
      url: 'https://muse.ai/search',
      method: 'POST',
      postData: JSON.stringify({ operationName: 'Alice', query: 'synthetic@example.test' }),
    },
    'XHR',
    [],
    0,
  )!;
  assert.equal(ordinary.requestBody!.query, undefined);
  assert.equal(ordinary.requestBody!.operationName, undefined);
  const persisted = diagnosticRequest(
    {
      url: 'https://muse.ai/graphql',
      method: 'POST',
      postData: JSON.stringify({
        operationName: 'UsageQuery',
        extensions: { persistedQuery: { sha256Hash: 'HASH_SECRET' } },
      }),
    },
    'Fetch',
    [],
    0,
  )!;
  assert.equal(persisted.requestBody!.operationName, 'UsageQuery');
  assert.ok(!JSON.stringify(persisted).includes('HASH_SECRET'));
});

test('origin and resource filters reject lookalikes, subresources and non-HTTP URLs', () => {
  for (const url of [
    'https://app.muse.ai/x',
    'https://muse.ai/x',
    'https://configured.test/x',
    'https://current.test/x',
  ])
    assert.ok(
      diagnosticRequest({ url, method: 'GET' }, 'XHR', ['https://configured.test/', 'https://current.test/chat'], 0),
    );
  for (const url of [
    'https://evil-muse.ai/x',
    'https://muse.ai.evil.test/x',
    'https://other.test/x',
    'file:///x',
    'invalid',
  ])
    assert.equal(diagnosticRequest({ url, method: 'GET' }, 'Fetch', [], 0), undefined);
  for (const type of ['Document', 'Image', 'Script', 'WebSocket'])
    assert.equal(diagnosticRequest({ url: 'https://muse.ai', method: 'GET' }, type, [], 0), undefined);
});

test('gate is off by default, polls at most every ten seconds, and activates an already open observer', () => {
  const f = fixture(false);
  const stop = f.start();
  for (let i = 0; i < 50; i++) {
    f.tick();
    f.run.record({ value: i });
  }
  assert.equal(f.checks(), 1);
  assert.equal(f.debug.attaches, 0);
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.lines, []);
  f.marker(true);
  f.time(9999);
  f.tick();
  assert.equal(f.debug.attaches, 0);
  f.time(10_000);
  f.tick();
  assert.equal(f.debug.attaches, 1);
  f.marker(false);
  f.time(20_000);
  f.tick();
  assert.equal(f.debug.detaches, 1);
  stop();
  assert.equal(f.cancelled(), true);
});

test('line and time budgets persist across marker toggles and observer reopen', async () => {
  const f = fixture();
  let stop = f.start();
  for (let i = 0; i < 305; i++) {
    f.request(String(i));
    f.response(String(i));
    await f.finish(String(i));
  }
  assert.equal(f.lines.length, 300);
  assert.equal(f.debug.attached, false);
  stop();
  f.marker(false);
  f.time(10_000);
  f.tick();
  f.marker(true);
  f.time(20_000);
  stop = f.start();
  assert.equal(f.debug.attaches, 1);
  stop();
  const timed = fixture();
  const close = timed.start();
  timed.time(30 * 60_000 - 1);
  timed.run.record({ before: true });
  timed.time(30 * 60_000);
  timed.tick();
  timed.run.record({ after: true });
  assert.equal(timed.lines.length, 1);
  assert.equal(timed.debug.attached, false);
  close();
  const reopen = timed.start();
  assert.equal(timed.debug.attached, false);
  reopen();
});

test('body caps apply to request, decoded, base64, compressed and transfer sizes; non-JSON is ignored', async () => {
  const huge = JSON.stringify({ text: 'é'.repeat(diagnosticBodyLimit) });
  assert.equal(responseShape(huge, 'application/json', 1), undefined);
  assert.equal(responseShape(Buffer.from(huge).toString('base64'), 'application/json', 1, true), undefined);
  assert.equal(responseShape('{}', 'application/json', diagnosticBodyLimit + 1), undefined);
  assert.equal(responseShape('{}', 'text/html', 2), undefined);
  assert.equal(responseShape('not json', 'application/json', 8), undefined);
  assert.ok(responseShape('{}', 'application/problem+json', 2));
  const exact = '"' + 'a'.repeat(diagnosticBodyLimit - 2) + '"';
  assert.ok(responseShape(exact, 'application/json', diagnosticBodyLimit));
  assert.equal(
    diagnosticRequest({ url: 'https://muse.ai', method: 'POST', postData: huge }, 'XHR', [], 0)!.requestBody,
    undefined,
  );
  for (const mode of ['transfer', 'decoded', 'non-json']) {
    const f = fixture();
    const stop = f.start();
    f.request();
    f.response('1', mode === 'non-json' ? 'text/plain' : 'application/json');
    if (mode === 'decoded') f.event('dataReceived', { requestId: '1', dataLength: diagnosticBodyLimit + 1 });
    await f.finish('1', mode === 'transfer' ? diagnosticBodyLimit + 1 : 20);
    assert.equal(f.commands.filter((c) => c.method === 'Network.getResponseBody').length, 0);
    assert.equal(JSON.parse(f.lines[0]).responseBody, undefined);
    stop();
  }
});

test('existing debugger, attach/enable failures are silent and never detach another owner', async () => {
  for (const mode of ['existing', 'attach', 'enable']) {
    const f = fixture();
    f.debug.attached = mode === 'existing';
    f.debug.failAttach = mode === 'attach';
    f.debug.failEnable = mode === 'enable';
    const stop = f.start();
    await Promise.resolve();
    stop();
    assert.equal(f.debug.detaches, mode === 'enable' ? 1 : 0);
    assert.deepEqual(f.lines, []);
  }
});

test('closing/removing marker/external detach discards outstanding body reads and listeners', async () => {
  for (const mode of ['close', 'marker', 'external']) {
    const f = fixture();
    const stop = f.start();
    let resolve!: (value: { body: string }) => void;
    f.debug.bodyRead = () =>
      new Promise((done) => {
        resolve = done;
      });
    f.request();
    f.response();
    f.event('loadingFinished', { requestId: '1', encodedDataLength: 10 });
    if (mode === 'close') stop();
    if (mode === 'marker') {
      f.marker(false);
      f.time(10_000);
      f.tick();
    }
    if (mode === 'external') {
      f.debug.attached = false;
      f.debug.emit('detach');
    }
    resolve({ body: '{"value":5}' });
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(f.lines, []);
    assert.equal(f.debug.listenerCount('message'), 0);
    assert.equal(f.debug.detaches, mode === 'external' ? 0 : 1);
    stop();
  }
});

test('disallowed redirects clear prior request state and body failures still record metadata', async () => {
  const f = fixture();
  const stop = f.start();
  f.request();
  f.request('1', 'https://third-party.test/x');
  f.response();
  await f.finish();
  assert.equal(f.lines.length, 0);
  f.request('2');
  f.response('2');
  f.debug.bodyRead = async () => {
    throw new Error('synthetic missing body');
  };
  await f.finish('2');
  assert.equal(f.lines.length, 1);
  assert.equal(JSON.parse(f.lines[0]).responseBody, undefined);
  stop();
});

test('redirect hops record only the allowed request and sanitized response metadata', async () => {
  const f = fixture();
  const stop = f.start();
  f.request();
  f.event('requestWillBeSent', {
    requestId: '1',
    type: 'Fetch',
    request: { url: 'https://third-party.test/?secret=SECRET', method: 'GET' },
    redirectResponse: {
      status: 302,
      encodedDataLength: 99,
      headers: { location: 'https://third-party.test/?secret=SECRET', 'Set-Cookie': 'COOKIE_SECRET' },
      mimeType: 'text/html',
    },
  });
  f.response();
  await f.finish();
  assert.equal(f.lines.length, 1);
  assert.equal(JSON.parse(f.lines[0]).status, 302);
  assert.equal(JSON.parse(f.lines[0]).responseSize, 99);
  assert.ok(!f.lines[0].includes('SECRET'));
  assert.deepEqual(
    f.commands.map((c) => c.method),
    ['Network.enable'],
  );
  stop();
});

test('server action (text/x-component) rows are parsed with the same redaction', () => {
  const body = [
    '0:{"a":"$@1","b":["$","div",null,{}]}',
    '1:{"usedPercent":53,"resetsAt":"$D2026-10-28T04:00:00.000Z","plan":"free","email":"a@b.c","left":"25800000000"}',
    '2:I["123",[],"x"]',
    'not a row',
  ].join('\n');
  const entries = responseShape(body, 'text/x-component; charset=utf-8', body.length) ?? [];
  const value = (key: string) => entries.find((e) => e.path.join('.') === `row:1.${key}`)?.value;
  assert.equal(value('usedPercent'), 53);
  assert.equal(value('resetsAt'), '$D2026-10-28T04:00:00.000Z');
  assert.equal(value('left'), '25800000000');
  assert.equal(value('plan'), '<string len=4>');
  const text = JSON.stringify(entries);
  assert.ok(!text.includes('a@b.c') && !text.includes('free') && !text.includes('div'));
  assert.equal(responseShape('garbage', 'text/x-component', 7), undefined);
});
