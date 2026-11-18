import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  applyCursorEditorUsage,
  cursorEditorUsage,
  fetchCursorUsage,
  parseCursorUsage,
  readCursorEditorSession,
  type CursorUsageIdentity,
} from '../src/server/cursor-usage.ts';
import type { RuntimeSnapshot } from '../src/shared/types.ts';

const scratch = mkdtempSync(join(tmpdir(), 'comborunner-cursor-usage-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A synthetic token: same shape as Cursor's, signed by nobody. */
const token = (claims: Record<string, unknown>) =>
  ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'c2lnbmF0dXJl'].join('.');
function editorDatabase(name: string, values: Record<string, string>) {
  const file = join(scratch, `${name}.vscdb`);
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  for (const [key, value] of Object.entries(values))
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(key, value);
  db.close();
  return file;
}

/** The structure cursor.com returned on the user's machine, with made-up numbers. */
const summary = {
  billingCycleStart: '2026-09-29T17:20:10.000Z',
  billingCycleEnd: '2026-10-29T17:20:10.000Z',
  membershipType: 'pro',
  limitType: 'user',
  isUnlimited: false,
  individualUsage: {
    plan: {
      enabled: true,
      used: 500,
      limit: 2000,
      remaining: 1500,
      breakdown: { included: 500, bonus: 0, total: 500 },
      autoPercentUsed: 12.5,
      apiPercentUsed: 40,
      totalPercentUsed: 25,
    },
    onDemand: { enabled: false, used: 0, limit: null, remaining: null },
  },
  teamUsage: {},
};

test('the usage summary becomes one window per pool, resetting at the end of the billing period', () => {
  const quota = parseCursorUsage(summary, '2026-10-04T00:00:00.000Z');
  assert.equal(quota.status, 'known');
  assert.deepEqual(
    quota.windows.map((window) => [window.label, window.usedPercent, window.resetsAt]),
    [
      ['Cursor Models', 12.5, '2026-10-29T17:20:10.000Z'],
      ['Other Models', 40, '2026-10-29T17:20:10.000Z'],
    ],
  );
  assert.match(quota.note!, /合计已用 25%/);
  // Older shapes without per-pool shares fall back to the plan total; millisecond strings are dates too.
  const total = parseCursorUsage({
    billingCycleEnd: '1793294410000',
    individualUsage: { plan: { used: 1000, limit: 2000 } },
  });
  assert.deepEqual(
    total.windows.map((window) => [window.label, window.usedPercent, window.resetsAt]),
    [['本账期用量', 50, new Date(1793294410000).toISOString()]],
  );
  assert.equal(parseCursorUsage({ isUnlimited: true }).windows.length, 0);
  assert.equal(parseCursorUsage({ isUnlimited: true }).unlimited, true);
  assert.deepEqual(
    quota.windows.map((window) => window.modelPool),
    ['cursor', 'other'],
  );
  // The period start gives routing the real billing-period length.
  assert.deepEqual(
    quota.windows.map((window) => window.periodStartedAt),
    ['2026-09-29T17:20:10.000Z', '2026-09-29T17:20:10.000Z'],
  );
  assert.equal(total.windows[0]!.periodStartedAt, undefined);
  const changed = parseCursorUsage({ something: 'else' });
  assert.equal(changed.status, 'unknown');
  assert.match(changed.note!, /可能已改版/);
  assert.match(
    parseCursorUsage({ ...summary, individualUsage: { ...summary.individualUsage, onDemand: { enabled: true } } })
      .note!,
    /超额按量付费/,
  );
});

test('the editor login is read from its own database, and only while it is valid', async () => {
  const live = token({ sub: 'auth0|user_TEST123', exp: Math.floor(Date.now() / 1000) + 3600 });
  const valid = editorDatabase('valid', {
    'cursorAuth/accessToken': live,
    'cursorAuth/cachedEmail': 'Someone@Example.com',
  });
  assert.deepEqual(await readCursorEditorSession(valid), {
    userId: 'user_TEST123',
    token: live,
    email: 'someone@example.com',
  });
  const expired = editorDatabase('expired', {
    'cursorAuth/accessToken': token({ sub: 'auth0|user_TEST123', exp: Date.now() / 1000 - 60 }),
  });
  assert.equal(await readCursorEditorSession(expired), undefined);
  assert.equal(await readCursorEditorSession(editorDatabase('signed-out', {})), undefined);
  assert.equal(await readCursorEditorSession(join(scratch, 'missing.vscdb')), undefined);
});

test('cursor.com is asked with the session cookie, and failures say what to do instead of guessing', async () => {
  const session = { userId: 'user_TEST123', token: 'a.b.c', email: 'someone@example.com' };
  const seen: string[] = [];
  const replies: Record<string, unknown> = {
    'https://cursor.com/api/usage-summary': {
      ...summary,
      individualUsage: { ...summary.individualUsage, onDemand: { enabled: true, used: 150, limit: 20000 } },
    },
    'https://cursor.com/api/dashboard/get-client-visible-credit-grants': {
      grants: [
        { remainingCents: '2500', totalCents: '2500', expiresAtMs: '1792280776357', displayName: 'Event credits' },
      ],
    },
    'https://cursor.com/api/dashboard/get-credit-grants-balance': {
      hasCreditGrants: true,
      creditBalanceCents: '6500',
      totalCents: '6500',
      usedCents: '0',
    },
    // Stripe's way of keeping account credit: a negative customer balance, in cents.
    'https://cursor.com/api/auth/stripe': { membershipType: 'pro', customerBalance: -4000 },
  };
  const ok = (async (url: string, init: RequestInit) => {
    const cookie = String((init.headers as Record<string, string>).cookie);
    assert.equal(cookie, 'WorkosCursorSessionToken=user_TEST123%3A%3Aa.b.c');
    seen.push(`${init.method ?? 'GET'} ${url}${init.body ? ` ${String(init.body)}` : ''}`);
    return new Response(JSON.stringify(replies[url] ?? {}), { status: replies[url] ? 200 : 404 });
  }) as unknown as typeof fetch;
  const quota = await fetchCursorUsage(session, { fetch: ok });
  assert.equal(quota.status, 'known');
  // Exactly the four read-only addresses, nothing else — never anything that changes billing.
  assert.deepEqual(seen.sort(), [
    'GET https://cursor.com/api/auth/stripe',
    'GET https://cursor.com/api/usage-summary',
    'POST https://cursor.com/api/dashboard/get-client-visible-credit-grants {}',
    'POST https://cursor.com/api/dashboard/get-credit-grants-balance {}',
  ]);
  assert.deepEqual(quota.cursorCredits, {
    accountUsd: 40,
    balanceUsd: 65,
    totalUsd: 65,
    usedUsd: 0,
    grants: [
      { name: 'Event credits', remainingUsd: 25, totalUsd: 25, expiresAt: new Date(1792280776357).toISOString() },
    ],
    onDemand: { enabled: true, limitUsd: 200, usedUsd: 1.5 },
  });
  // Credit reads are extras: when they fail, the usage pools still show.
  const partial = await fetchCursorUsage(session, {
    fetch: (async (url: string) =>
      url.endsWith('usage-summary')
        ? new Response(JSON.stringify(summary), { status: 200 })
        : new Response('{}', { status: 500 })) as unknown as typeof fetch,
  });
  assert.equal(partial.windows.length, 2);
  assert.deepEqual(partial.cursorCredits?.grants, []);
  assert.equal(partial.cursorCredits?.accountUsd, null);
  assert.deepEqual(partial.cursorCredits?.onDemand, { enabled: false, limitUsd: null, usedUsd: 0 });
  const signedOut = await fetchCursorUsage(session, {
    fetch: (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch,
  });
  assert.equal(signedOut.status, 'error');
  assert.match(signedOut.note!, /重新登录/);
  const offline = await fetchCursorUsage(session, {
    fetch: (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch,
  });
  assert.match(offline.note!, /稍后会自动重试/);
  // The login never appears in what the card shows.
  assert.doesNotMatch(JSON.stringify([quota, signedOut, offline]), /a\.b\.c|user_TEST123/);
});

test('nothing is read unless turned on, and another account’s usage is never put on the card', async () => {
  const card = (): RuntimeSnapshot =>
    ({ quota: { status: 'unknown', source: 'x', observedAt: null, windows: [] } }) as unknown as RuntimeSnapshot;
  const session = async () => ({ userId: 'user_TEST123', token: 'a.b.c', email: 'someone@example.com' });
  const fetch = (async () =>
    new Response(JSON.stringify(summary), { status: 200 })) as unknown as typeof globalThis.fetch;
  let reads = 0;
  const counted = async () => {
    reads++;
    return session();
  };
  const off = card();
  await applyCursorEditorUsage(off, { state: 'missing' }, { session: counted, fetch });
  assert.equal(reads, 0);
  assert.equal(off.quota.status, 'unknown');
  cursorEditorUsage.enabled = true;
  try {
    const other = card();
    await applyCursorEditorUsage(other, { state: 'verified', email: 'someone-else@example.com' }, { session, fetch });
    assert.equal(other.quota.windows.length, 0);
    assert.match(other.quota.note!, /账号不同/);
    const same = card();
    await applyCursorEditorUsage(
      same,
      { state: 'verified', email: 'Someone@Example.com', userId: 'user_TEST123' },
      { session, fetch },
    );
    assert.equal(same.quota.status, 'known');
    const noCli = card();
    await applyCursorEditorUsage(noCli, { state: 'missing' }, { session, fetch });
    assert.equal(noCli.quota.windows.length, 2);
    const signedOut = card();
    await applyCursorEditorUsage(signedOut, { state: 'missing' }, { session: async () => undefined, fetch });
    assert.match(signedOut.quota.note!, /没有找到 Cursor 编辑器的有效登录/);
  } finally {
    cursorEditorUsage.enabled = false;
  }
});

const card = (): RuntimeSnapshot =>
  ({ quota: { status: 'unknown', source: 'fixture', observedAt: null, windows: [] } }) as unknown as RuntimeSnapshot;
const fixtureSession = async () => ({
  userId: 'user_FIXTURE',
  token: 'fixture.token.only',
  email: 'same@example.test',
});
const verified: CursorUsageIdentity = { state: 'verified', email: 'same@example.test', userId: 'user_FIXTURE' };
const reply = (url: string | URL | Request) => Response.json(String(url).endsWith('/usage-summary') ? summary : {});

test('missing percentages and zero plan limits stay unknown, and oversized dates cannot break parsing', () => {
  assert.equal(parseCursorUsage({ individualUsage: { plan: { limit: 0, used: 0 } } }).status, 'unknown');
  const partial = parseCursorUsage({ individualUsage: { plan: { autoPercentUsed: 0 } } });
  assert.deepEqual(
    partial.windows.map((window) => window.usedPercent),
    [0, null],
  );
  assert.ok(partial.windows.every((window) => window.resetNotReported === true));
  const malformed = parseCursorUsage({ ...summary, billingCycleEnd: 1e100 });
  assert.ok(malformed.windows.every((window) => window.resetsAt === null && !window.resetNotReported));
  assert.equal(parseCursorUsage({ individualUsage: { plan: { autoPercentUsed: -1 } } }).status, 'unknown');
});

test('unknown CLI identity, missing editor email, and mismatched user IDs never fetch or attach usage', async () => {
  cursorEditorUsage.enabled = true;
  let requests = 0;
  const fetch = (async (url) => {
    requests++;
    return reply(url);
  }) as typeof globalThis.fetch;
  try {
    for (const identity of [{ state: 'unverified' }, { state: 'verified', email: '' }] as CursorUsageIdentity[]) {
      const snapshot = card();
      await applyCursorEditorUsage(snapshot, identity, {
        session: async () => {
          throw new Error('must not read a credential for an unverified CLI');
        },
        fetch,
      });
      assert.equal(snapshot.quota.status, 'unknown');
    }
    for (const session of [
      async () => ({ ...(await fixtureSession()), email: undefined }),
      async () => ({ ...(await fixtureSession()), userId: 'other-user' }),
    ]) {
      const snapshot = card();
      await applyCursorEditorUsage(snapshot, verified, { session, fetch });
      assert.equal(snapshot.quota.status, 'unknown');
      assert.match(snapshot.quota.note!, /账号不同/);
    }
    assert.equal(requests, 0);
  } finally {
    cursorEditorUsage.enabled = false;
  }
});

test('all reads have a shared deadline and stalled optional JSON cannot erase good usage', async () => {
  let calls = 0;
  const quota = await fetchCursorUsage(await fixtureSession(), {
    timeoutMs: 30,
    fetch: (async (url) => {
      calls++;
      if (String(url).endsWith('usage-summary')) return Response.json(summary);
      if (String(url).endsWith('get-client-visible-credit-grants'))
        return Response.json({ grants: [{ displayName: 'fixture', remainingCents: '1', expiresAtMs: 1e100 }] });
      if (String(url).endsWith('stripe')) return new Response('{}', { status: 500 });
      return { ok: true, status: 200, json: () => new Promise(() => {}) } as Response;
    }) as typeof globalThis.fetch,
  });
  assert.equal(calls, 4);
  assert.equal(quota.status, 'known');
  assert.equal(quota.cursorCredits?.balanceUsd, null);
  assert.equal(quota.cursorCredits?.accountUsd, null);
  assert.equal(quota.cursorCredits?.grants[0]?.expiresAt, null);
  assert.match(quota.note!, /部分.*未能读取/);
  const timeout = await fetchCursorUsage(await fixtureSession(), {
    timeoutMs: 30,
    fetch: (() => new Promise(() => {})) as typeof globalThis.fetch,
  });
  assert.equal(timeout.status, 'error');
});

test('in-flight reads are shared, the cache respects router freshness, and errors retry sooner', async () => {
  cursorEditorUsage.enabled = true;
  const previousAge = cursorEditorUsage.maxAgeMs;
  cursorEditorUsage.maxAgeMs = 120_000;
  let time = Date.now(),
    calls = 0,
    fails = false;
  const deps = {
    session: fixtureSession,
    now: () => time,
    fetch: (async (url) => {
      calls++;
      await Promise.resolve();
      return fails ? new Response('{}', { status: 503 }) : reply(url);
    }) as typeof globalThis.fetch,
  };
  try {
    const first = card(),
      second = card();
    await Promise.all([applyCursorEditorUsage(first, verified, deps), applyCursorEditorUsage(second, verified, deps)]);
    assert.equal(calls, 4);
    first.quota.windows[0]!.usedPercent = 99;
    await applyCursorEditorUsage(card(), verified, deps);
    assert.equal(calls, 4);
    assert.equal(second.quota.windows[0]!.usedPercent, 12.5);
    time += 120_000;
    await applyCursorEditorUsage(card(), verified, deps);
    assert.equal(calls, 8);
    fails = true;
    time += 120_000;
    const failed = card();
    await applyCursorEditorUsage(failed, verified, deps);
    assert.equal(failed.quota.status, 'error');
    assert.equal(calls, 12);
    time += 5_000;
    await applyCursorEditorUsage(card(), verified, deps);
    assert.equal(calls, 12);
    fails = false;
    time += 5_001;
    const recovered = card();
    await applyCursorEditorUsage(recovered, verified, deps);
    assert.equal(calls, 16);
    assert.equal(recovered.quota.status, 'known');
    cursorEditorUsage.maxAgeMs = 2_000;
    time += 1_001;
    await applyCursorEditorUsage(card(), verified, deps);
    assert.equal(calls, 20);
  } finally {
    cursorEditorUsage.enabled = false;
    cursorEditorUsage.maxAgeMs = previousAge;
  }
});

test('active and manual refresh shorten the idle cache without inventing a new observation time', async () => {
  const wasEnabled = cursorEditorUsage.enabled;
  const previousAge = cursorEditorUsage.maxAgeMs;
  cursorEditorUsage.enabled = true;
  cursorEditorUsage.maxAgeMs = 180_000;
  let time = Date.now();
  let calls = 0;
  let used = 12.5;
  const deps = {
    session: async () => ({ userId: 'user_FIXTURE', token: 'active.fixture.only', email: verified.email }),
    now: () => time,
    fetch: (async (url) => {
      calls++;
      return String(url).endsWith('/usage-summary')
        ? Response.json({
            ...summary,
            individualUsage: { plan: { ...summary.individualUsage.plan, autoPercentUsed: used } },
          })
        : Response.json({});
    }) as typeof globalThis.fetch,
  };
  try {
    const first = card();
    await applyCursorEditorUsage(first, verified, { ...deps, maxCacheAgeMs: 60_000 });
    time += 16_000;
    used = 20;
    const idle = card();
    await applyCursorEditorUsage(idle, verified, { ...deps, maxCacheAgeMs: 60_000 });
    assert.equal(calls, 4);
    assert.equal(idle.quota.observedAt, first.quota.observedAt);
    const active = card();
    await applyCursorEditorUsage(active, verified, { ...deps, maxCacheAgeMs: 15_000 });
    assert.equal(calls, 8);
    assert.equal(active.quota.windows[0]?.usedPercent, 20);
    assert.equal(active.quota.observedAt, new Date(time).toISOString());
    used = 21;
    const manual = card();
    await applyCursorEditorUsage(manual, verified, { ...deps, maxCacheAgeMs: 0 });
    assert.equal(calls, 12);
    assert.equal(manual.quota.windows[0]?.usedPercent, 21);
  } finally {
    cursorEditorUsage.enabled = wasEnabled;
    cursorEditorUsage.maxAgeMs = previousAge;
  }
});

test('a slow response does not postpone the next active-account observation by another interval', async () => {
  const wasEnabled = cursorEditorUsage.enabled;
  cursorEditorUsage.enabled = true;
  const start = Date.now();
  let time = start;
  let calls = 0;
  const deps = {
    session: async () => ({ userId: 'user_FIXTURE', token: 'slow.fixture.only', email: verified.email }),
    maxCacheAgeMs: 15_000,
    now: () => time,
    fetch: (async (url) => {
      calls++;
      if (String(url).endsWith('/usage-summary')) time += 3_000;
      return reply(url);
    }) as typeof globalThis.fetch,
  };
  try {
    const first = card();
    await applyCursorEditorUsage(first, verified, deps);
    assert.equal(first.quota.observedAt, new Date(start).toISOString());
    time = start + 15_000;
    const next = card();
    await applyCursorEditorUsage(next, verified, deps);
    assert.equal(calls, 8);
    assert.equal(next.quota.observedAt, new Date(start + 15_000).toISOString());
  } finally {
    cursorEditorUsage.enabled = wasEnabled;
  }
});

test('turning off during a read cannot repopulate a card or the cache after turning on again', async () => {
  cursorEditorUsage.enabled = true;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const snapshot = card();
  const pending = applyCursorEditorUsage(snapshot, verified, {
    session: fixtureSession,
    fetch: (() => {
      entered();
      return new Promise(() => {});
    }) as typeof globalThis.fetch,
  });
  await started;
  cursorEditorUsage.enabled = false;
  cursorEditorUsage.enabled = true;
  try {
    await pending;
    assert.equal(snapshot.quota.status, 'unknown');
    let calls = 0;
    const fresh = card();
    await applyCursorEditorUsage(fresh, verified, {
      session: fixtureSession,
      fetch: (async (url) => {
        calls++;
        return reply(url);
      }) as typeof globalThis.fetch,
    });
    assert.equal(calls, 4);
    assert.equal(fresh.quota.status, 'known');
  } finally {
    cursorEditorUsage.enabled = false;
  }
});

test('a numeric CLI account number is a different namespace from the editor login id; the email decides', async () => {
  cursorEditorUsage.enabled = true;
  try {
    const snapshot = card();
    await applyCursorEditorUsage(
      snapshot,
      { state: 'verified', email: 'same@example.test', userId: '200000001' },
      { session: fixtureSession, fetch: (async (url) => reply(url)) as typeof globalThis.fetch },
    );
    assert.equal(snapshot.quota.status, 'known');
    const other = card();
    await applyCursorEditorUsage(
      other,
      { state: 'verified', email: 'other@example.test', userId: '200000001' },
      {
        session: fixtureSession,
        fetch: (async () => assert.fail('no request for another account')) as typeof globalThis.fetch,
      },
    );
    assert.match(other.quota.note!, /账号不同/);
  } finally {
    cursorEditorUsage.enabled = false;
  }
});
