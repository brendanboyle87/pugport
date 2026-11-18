import { largeFileId, mockFileIds } from './helpers/file-identity.ts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import {
  grokBillingIdentity,
  parseGrokAutoTopup,
  parseGrokBillingSupplement,
  readGrokAutoTopup,
  readGrokBillingSupplement,
} from '../src/server/grok-billing-supplement.ts';
import type { RuntimeTarget } from '../src/shared/types.ts';

const now = Date.parse('2026-09-27T00:00:00Z');
const period = { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-09-25T03:23:56.847Z', end: '2026-10-02T03:23:56.847Z' };
function varint(value: number | bigint): Buffer {
  let remaining = BigInt(value);
  const bytes: number[] = [];
  do {
    bytes.push(Number(remaining & 127n) | (remaining > 127n ? 128 : 0));
    remaining >>= 7n;
  } while (remaining);
  return Buffer.from(bytes);
}
const scalar = (field: number, value: number | bigint) => Buffer.concat([varint(field * 8), varint(value)]);
const message = (field: number, bytes: Buffer) => Buffer.concat([varint(field * 8 + 2), varint(bytes.length), bytes]);
function stamp(date: string): Buffer {
  const time = Date.parse(date);
  return Buffer.concat([scalar(1, Math.floor(time / 1000)), scalar(2, (time % 1000) * 1e6)]);
}
function frame(flag: number, bytes: Buffer): Buffer {
  const prefix = Buffer.alloc(5);
  prefix[0] = flag;
  prefix.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([prefix, bytes]);
}
const trailer = frame(128, Buffer.from('grpc-status:0\r\n'));
function percent(value: number): Buffer {
  const bytes = Buffer.alloc(5);
  bytes[0] = 13;
  bytes.writeFloatLE(value, 1);
  return bytes;
}
function payload(
  options: { pct?: number; suffix?: Buffer; start?: string; end?: string; type?: number; noStart?: boolean } = {},
): Buffer {
  const current = Buffer.concat([
    scalar(1, options.type ?? 2),
    ...(options.noStart ? [] : [message(2, stamp(options.start ?? period.start))]),
    message(3, stamp(options.end ?? period.end)),
  ]);
  return message(
    1,
    Buffer.concat([
      ...(options.pct === undefined ? [] : [percent(options.pct)]),
      message(8, current),
      options.suffix ?? Buffer.alloc(0),
    ]),
  );
}
const response = (body = payload()) => Buffer.concat([frame(0, body), trailer]);

test('complete successful billing frame distinguishes published percent from implicit zero in the same active period', () => {
  assert.deepEqual(parseGrokBillingSupplement(response(), period, now), { usedPercent: 0, implicitZero: true });
  assert.deepEqual(parseGrokBillingSupplement(response(payload({ pct: 0 })), period, now), {
    usedPercent: 0,
    implicitZero: false,
  });
  assert.deepEqual(parseGrokBillingSupplement(response(payload({ pct: 12.5 })), period, now), {
    usedPercent: 12.5,
    implicitZero: false,
  });
  assert.deepEqual(
    parseGrokBillingSupplement(response(payload({ type: 1 })), { ...period, type: 'USAGE_PERIOD_TYPE_MONTHLY' }, now),
    { usedPercent: 0, implicitZero: true },
  );
  assert.equal(parseGrokBillingSupplement(response(payload({ pct: 101 })), period, now), undefined);
});

test('incomplete, mismatched, future, expired and unrecognized periods cannot supply zero', () => {
  for (const body of [
    payload({ noStart: true }),
    payload({ start: '2026-09-28T00:00:00Z' }),
    payload({ end: '2026-09-26T00:00:00Z' }),
    payload({ type: 3 }),
  ]) {
    assert.equal(parseGrokBillingSupplement(response(body), period, now), undefined);
  }
  assert.equal(parseGrokBillingSupplement(response(), { ...period, end: '2026-10-03T00:00:00Z' }, now), undefined);
  assert.equal(parseGrokBillingSupplement(response(), period, Date.parse(period.end)), undefined);
});

test('framing, trailers, protobuf completeness and unknown byte fields cannot fabricate a healthy zero', () => {
  for (const bytes of [
    Buffer.concat([trailer, frame(0, payload())]),
    Buffer.concat([response(), trailer]),
    Buffer.concat([response(), frame(0, payload())]),
    Buffer.concat([frame(0, payload()), frame(0, payload()), trailer]),
    frame(0, payload()),
    frame(1, payload()),
    Buffer.concat([frame(0, payload()), frame(128, Buffer.from('grpc-status:7\r\n'))]),
    response(payload({ suffix: Buffer.from([0]) })),
    response(payload({ suffix: Buffer.from([13, 0]) })),
    response(payload({ suffix: message(2, Buffer.from([0])) })),
  ]) {
    assert.equal(parseGrokBillingSupplement(bytes, period, now), undefined);
  }
  assert.deepEqual(
    parseGrokBillingSupplement(frame(0, payload()), period, now, '0'),
    { usedPercent: 0, implicitZero: true },
    'HTTP grpc-status zero can complete a unary response without an in-body trailer',
  );
  assert.equal(parseGrokBillingSupplement(response(), period, now, '7'), undefined);
  assert.deepEqual(
    parseGrokBillingSupplement(response(payload({ suffix: message(14, percent(99)) })), period, now),
    { usedPercent: 0, implicitZero: true },
    'unknown bytes are opaque',
  );
  assert.equal(
    parseGrokBillingSupplement(response(payload({ suffix: message(7, percent(1)) })), period, now),
    undefined,
    'known product floats prevent inferring omitted total as zero',
  );
});

function fixture(t: TestContext) {
  // Credential lookup rejects linked ancestors, including macOS's /var alias.
  const temporary = realpathSync.native(tmpdir());
  const directory = mkdtempSync(join(temporary, 'comborunner-grok-billing-'));
  t.after(() => {
    assert.ok(resolve(directory).startsWith(temporary + sep));
    assert.ok(basename(directory).startsWith('comborunner-grok-billing-'));
    rmSync(directory, { recursive: true, force: true });
  });
  const file = join(directory, 'auth.json');
  const auth = {
    main: {
      auth_mode: 'oidc',
      user_id: 'synthetic-user',
      key: 'synthetic-test-token',
      expires_at: '2099-01-01T00:00:00Z',
    },
  };
  writeFileSync(file, JSON.stringify(auth));
  const env = { GROK_HOME: directory };
  const target: RuntimeTarget = {
    id: 'grok-native',
    provider: 'grok',
    label: 'fixture',
    command: join(directory, process.platform === 'win32' ? 'grok.exe' : 'grok'),
    environment: 'native',
    enabled: true,
  };
  const fingerprint = grokBillingIdentity(target, env);
  assert.ok(fingerprint, 'the canonical synthetic profile must have a readable identity');
  return { directory, file, auth, env, target, fingerprint };
}

test('billing refuses a synthetic auth file replaced only in high file-ID bits', async (t) => {
  const f = fixture(t);
  const ids = mockFileIds(t, [[f.file, largeFileId]]);
  const options = {
    env: f.env,
    now: () => now,
    fetch: (async () =>
      new Response(new Uint8Array(response()), {
        headers: { 'content-type': 'application/grpc-web+proto' },
      })) as typeof fetch,
  };
  assert.ok(await readGrokBillingSupplement(f.target, f.fingerprint, period, options));
  ids.opened(f.file, largeFileId + 1n);
  assert.equal(
    await readGrokBillingSupplement(f.target, f.fingerprint, period, {
      ...options,
      fetch: async () => assert.fail('replaced file must not supply a token'),
    }),
    undefined,
  );
});

test('fallback reads only the selected identity, posts to fixed official host and does not write credentials', async (t) => {
  const f = fixture(t),
    before = readFileSync(f.file, 'utf8'),
    environment = { ...f.env };
  let requests = 0;
  const fetcher: typeof fetch = async (url, options) => {
    requests++;
    assert.equal(String(url), 'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig');
    assert.equal(options!.method, 'POST');
    assert.equal(options!.redirect, 'error');
    assert.ok(options!.signal);
    assert.equal(new Headers(options!.headers).get('Authorization'), 'Bearer synthetic-test-token');
    assert.deepEqual(Array.from(options!.body as Uint8Array), [0, 0, 0, 0, 2, 8, 0]);
    return new Response(new Uint8Array(response()), { headers: { 'content-type': 'application/grpc-web+proto' } });
  };
  const result = await readGrokBillingSupplement(f.target, f.fingerprint, period, {
    fetch: fetcher,
    env: f.env,
    now: () => now,
  });
  assert.deepEqual(result, { usedPercent: 0, implicitZero: true });
  assert.equal(requests, 1);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  assert.deepEqual(f.env, environment);
});

test('wrong identity, wrapper, custom arguments, expired or ambiguous credentials make no request', async (t) => {
  const f = fixture(t);
  const fetcher: typeof fetch = async () => {
    assert.fail('No credential may be sent for an unbound target.');
  };
  const deps = { fetch: fetcher, env: f.env, now: () => now };
  for (const target of [
    { ...f.target, command: 'grok' },
    { ...f.target, command: join(f.directory, 'grok.cmd') },
    { ...f.target, args: ['--home', 'other'] },
    { ...f.target, accountFingerprint: 'wrong' },
    { ...f.target, id: 'another-default' },
  ])
    assert.equal(await readGrokBillingSupplement(target, f.fingerprint, period, deps), undefined);
  assert.equal(await readGrokBillingSupplement(f.target, 'wrong', period, deps), undefined);
  writeFileSync(f.file, JSON.stringify({ main: { ...f.auth.main, expires_at: '2000-01-01T00:00:00Z' } }));
  assert.equal(await readGrokBillingSupplement(f.target, f.fingerprint, period, deps), undefined);
  writeFileSync(f.file, JSON.stringify({ ...f.auth, another: { ...f.auth.main, key: 'another-token' } }));
  assert.equal(await readGrokBillingSupplement(f.target, f.fingerprint, period, deps), undefined);
});

test('HTTP errors, oversized bodies, wrong content type and an identity change never supply quota', async (t) => {
  const f = fixture(t);
  for (const fetcher of [
    async () => new Response('private token=not-shown', { status: 401 }),
    async () => new Response('private', { headers: { 'content-type': 'text/html' } }),
    async () =>
      new Response(new Uint8Array(1024 * 1024 + 1), { headers: { 'content-type': 'application/grpc-web+proto' } }),
    async () => {
      throw new Error('private token=not-shown');
    },
    async () => {
      writeFileSync(f.file, JSON.stringify({ main: { ...f.auth.main, user_id: 'changed-user' } }));
      return new Response(new Uint8Array(response()), { headers: { 'content-type': 'application/grpc-web+proto' } });
    },
  ])
    assert.equal(
      await readGrokBillingSupplement(f.target, f.fingerprint, period, {
        fetch: fetcher as typeof fetch,
        env: f.env,
        now: () => now,
      }),
      undefined,
    );
});

test('auto top-up: empty rule is off, enabled rule is on, anything doubtful is unknown', async (t) => {
  const rule = (enabled?: number) =>
    Buffer.concat([frame(0, enabled === undefined ? Buffer.alloc(0) : message(1, scalar(1, enabled))), trailer]);
  assert.equal(parseGrokAutoTopup(rule()), false);
  assert.equal(parseGrokAutoTopup(rule(0)), false);
  assert.equal(parseGrokAutoTopup(rule(1)), true);
  assert.equal(parseGrokAutoTopup(rule(2)), undefined);
  assert.equal(parseGrokAutoTopup(frame(0, Buffer.alloc(0))), undefined, 'no trailer means an incomplete reply');
  assert.equal(
    parseGrokAutoTopup(Buffer.concat([frame(0, Buffer.alloc(0)), frame(128, Buffer.from('grpc-status:7'))])),
    undefined,
  );

  const f = fixture(t);
  const urls: string[] = [];
  const fetcher: typeof fetch = async (url, options) => {
    urls.push(String(url));
    assert.equal(options!.method, 'POST');
    assert.equal(options!.redirect, 'error');
    assert.equal(new Headers(options!.headers).get('Authorization'), 'Bearer synthetic-test-token');
    assert.deepEqual(Array.from(options!.body as Uint8Array), [0, 0, 0, 0, 0]);
    return new Response(new Uint8Array(rule(1)), { headers: { 'content-type': 'application/grpc-web+proto' } });
  };
  assert.equal(await readGrokAutoTopup(f.target, f.fingerprint, { fetch: fetcher, env: f.env }), true);
  assert.deepEqual(urls, ['https://grok.com/grok_api_v2.GrokBuildBilling/GetAutoTopupRule']);
  assert.equal(await readGrokAutoTopup(f.target, 'wrong', { fetch: fetcher, env: f.env }), undefined);
  assert.equal(urls.length, 1, 'a mismatched account sends nothing');
});
