import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { grokBotUsageScript, readGrokBotPageUsage } from '../src/electron/grok-bot-usage.ts';

const dashboard = 'https://cursor.com/dashboard/spending';
const secret = 'SYNTHETIC_SECRET_TOKEN';
const email = 'synthetic-private@example.test';
const cookie = 'synthetic-session=PRIVATE_COOKIE';
const safeUsage = { usagePercent: 9, grokPlanLabel: 'SuperGrok' };

function pageFixture({
  body = JSON.stringify(safeUsage),
  status = 200,
  url = dashboard,
  failure,
}: { body?: string; status?: number; url?: string; failure?: Error } = {}) {
  const calls: { url: unknown; options: RequestInit }[] = [];
  const deadlines: number[] = [];
  const signal = { synthetic: true };
  let bodyReads = 0;
  const page = async <T>(code: string): Promise<T> =>
    runInNewContext(code, {
      location: new URL(url),
      AbortSignal: {
        timeout(ms: number) {
          deadlines.push(ms);
          return signal;
        },
      },
      fetch: async (url: unknown, options: RequestInit) => {
        calls.push({ url, options });
        if (failure) throw failure;
        return {
          status,
          ok: status >= 200 && status < 300,
          text: async () => {
            bodyReads++;
            return body;
          },
        };
      },
    }) as Promise<T>;
  return { page, calls, deadlines, signal, bodyReads: () => bodyReads };
}

function assertPrivateDataAbsent(value: unknown) {
  const text = JSON.stringify(value);
  for (const privateValue of [secret, email, cookie]) assert.equal(text.includes(privateValue), false);
}

test('active Grok read sends the original fixed RPC and returns 9% SuperGrok with reset unreported', async () => {
  const fixture = pageFixture();
  const result = await readGrokBotPageUsage(fixture.page, dashboard);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0]!.url, 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus');
  const options = fixture.calls[0]!.options;
  assert.deepEqual(JSON.parse(JSON.stringify(options)), {
    method: 'POST',
    credentials: 'include',
    redirect: 'error',
    cache: 'no-store',
    headers: { 'content-type': 'application/json', 'connect-protocol-version': '1' },
    body: '{}',
    signal: fixture.signal,
  });
  assert.equal(options.signal, fixture.signal);
  assert.deepEqual(fixture.deadlines, [8000]);
  assert.equal(fixture.bodyReads(), 1);
  assert.equal(result.ok, true);
  assert.equal(result.quota?.status, 'known');
  assert.equal(result.quota?.windows.length, 1);
  assert.equal(result.quota?.windows[0]?.usedPercent, 9);
  assert.equal(result.quota?.windows[0]?.resetsAt, null);
  assert.equal(result.quota?.windows[0]?.resetNotReported, true);
  assert.equal(result.quota?.subscription?.label, 'SuperGrok');
  assert.deepEqual(result.grokDiagnostic, {
    code: 'success',
    step: 'parse',
    path: '/dashboard/spending',
    status: 200,
  });
});

test('active page script retains only bounded quota fields, never arbitrary body or account data', async () => {
  const reset = '2026-10-18T08:00:00.000Z';
  const retained = {
    ...safeUsage,
    nextResetTimestampUtc: reset,
    currentPeriodStart: '2026-10-08T08:00:00.000Z',
    cursorPlanName: 'Cursor Pro',
    billingBrand: 'SAND_BILLING_BRAND_CURSOR',
  };
  const fixture = pageFixture({
    body: JSON.stringify({
      ...retained,
      token: secret,
      email,
      cookie,
      body: { privateToken: secret },
    }),
  });
  const raw = await fixture.page<{ outcome: string; status: number; payload: unknown }>(grokBotUsageScript);
  assert.deepEqual(JSON.parse(JSON.stringify(raw)), { outcome: 'success', status: 200, payload: retained });
  assertPrivateDataAbsent(raw);
  const result = await readGrokBotPageUsage(fixture.page, `${dashboard}?token=${secret}#${email}`);
  assert.equal(result.quota?.windows[0]?.resetsAt, reset);
  assertPrivateDataAbsent(result);
  const echoes = pageFixture({
    body: JSON.stringify({
      usagePercent: 9,
      grokPlanLabel: secret,
      cursorPlanName: email,
      billingBrand: cookie,
      nextResetTimestampUtc: secret,
      currentPeriodStart: email,
    }),
  });
  assertPrivateDataAbsent(await echoes.page(grokBotUsageScript));
  assertPrivateDataAbsent(await readGrokBotPageUsage(echoes.page, dashboard));
});

for (const status of [401, 403, 429, 500]) {
  test(`active Grok read reports refused ${status} without reading the response body`, async () => {
    const fixture = pageFixture({ status, body: `${secret} ${email} ${cookie}` });
    const result = await readGrokBotPageUsage(fixture.page, dashboard);
    assert.equal(result.ok, false);
    assert.equal(result.quota, undefined);
    assert.deepEqual(result.grokDiagnostic, {
      code: 'refused',
      step: 'request',
      path: '/dashboard/spending',
      status,
    });
    assert.equal(fixture.bodyReads(), 0);
    assertPrivateDataAbsent(result);
  });
}

for (const message of ['NetworkError', 'CORS blocked']) {
  test(`active Grok read reports unreachable on ${message}`, async () => {
    const fixture = pageFixture({ failure: new TypeError(`${message}: ${secret} ${email} ${cookie}`) });
    const result = await readGrokBotPageUsage(fixture.page, dashboard);
    assert.equal(result.ok, false);
    assert.equal(result.quota, undefined);
    assert.deepEqual(result.grokDiagnostic, {
      code: 'unreachable',
      step: 'request',
      path: '/dashboard/spending',
    });
    assert.equal(fixture.bodyReads(), 0);
    assertPrivateDataAbsent(result);
  });
}

for (const [name, body] of [
  ['invalid JSON', `${secret} ${email} ${cookie}`],
  ['oversize response', JSON.stringify({ ...safeUsage, body: 'x'.repeat(131072) })],
  ['unrecognized fields', JSON.stringify({ remaining: 91, plan: 'SuperGrok', token: secret })],
  ['invalid usage', JSON.stringify({ usagePercent: '9', grokPlanLabel: 'SuperGrok' })],
] as const) {
  test(`active Grok read reports no-data for ${name}`, async () => {
    const fixture = pageFixture({ body });
    const result = await readGrokBotPageUsage(fixture.page, dashboard);
    assert.equal(result.ok, false);
    assert.notEqual(result.quota?.status, 'known');
    assert.deepEqual(result.grokDiagnostic, {
      code: 'no-data',
      step: 'parse',
      path: '/dashboard/spending',
      status: 200,
    });
    assertPrivateDataAbsent(result);
  });
}

for (const url of [
  'https://cursor.com/login',
  'https://cursor.com/signin',
  'https://other.example.test/dashboard/spending',
]) {
  test(`active Grok read declines to fetch outside the dashboard (${new URL(url).host}${new URL(url).pathname})`, async () => {
    const fixture = pageFixture({ url });
    const result = await readGrokBotPageUsage(fixture.page, url);
    assert.equal(result.ok, false);
    assert.equal(result.grokDiagnostic?.code, 'login');
    assert.equal(result.grokDiagnostic?.step, 'login');
    assert.equal(result.grokDiagnostic?.status, undefined);
    assert.deepEqual(fixture.calls, []);
    assert.deepEqual(fixture.deadlines, []);
  });
}

test('thrown page errors discard secrets and sanitize diagnostic URLs', async () => {
  const result = await readGrokBotPageUsage(async () => {
    throw new Error(`${secret} ${email} ${cookie}`);
  }, `https://cursor.com/dashboard/${email}?token=${secret}`);
  assert.deepEqual(result, {
    ok: false,
    grokDiagnostic: { code: 'error', step: 'request', path: '/dashboard/…' },
  });
  assertPrivateDataAbsent(result);
});
