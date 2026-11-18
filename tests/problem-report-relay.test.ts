import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  createProblemReportHandler,
  reportFingerprint,
  reportHash,
} from '../supabase/functions/_shared/problem-report.ts';

const secret = 'ab'.repeat(32);
test('fingerprints prefer task failures and latest log errors while normalizing transient details', async () => {
  assert.notEqual(
    await reportFingerprint({ task: { error: 'Error: HTTP 401 request failed' } }),
    await reportFingerprint({ task: { error: 'Error: HTTP 500 request failed' } }),
  );
  const errors = 'Error: old shared failure\n at old (old.ts:1)\nError: newest failure\n at latest (latest.ts:2)';
  assert.equal(
    await reportFingerprint({ errors }),
    await reportFingerprint({ errors: 'Error: newest failure\n at latest (latest.ts:2)' }),
  );
  assert.notEqual(
    await reportFingerprint({ errors, task: { error: 'Error: network unavailable' } }),
    await reportFingerprint({ errors, task: { error: 'Error: invalid schema' } }),
  );
  assert.equal(
    await reportFingerprint({ errors, task: { error: 'Error: network unavailable' } }),
    await reportFingerprint({ task: { error: 'Error: network unavailable' } }),
  );
  assert.equal(
    await reportFingerprint({
      errors:
        '2026-11-03T12:00:00.123Z Error: request 123 abcdef123456 failed at /home/alice/file.ts\n at run (/home/alice/file.ts:123:2)',
    }),
    await reportFingerprint({
      errors:
        '2026-11-04T15:04:02.456Z Error: request 456 fedcba654321 failed at /home/bob/other.ts\n at run (/home/bob/other.ts:456:7)',
    }),
  );
});

test('secret replay returns the original id and global quota rejects only new reports', async () => {
  const saved = new Map<string, string>();
  const handler = createProblemReportHandler({
    url: 'https://fake.invalid',
    serviceKey: 'fake',
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (saved.has(body.p_secret_hash)) return response(saved.get(body.p_secret_hash));
      if (saved.size >= 300) return response({ message: 'RATE_LIMIT' }, 400);
      const id = `PP-${1000 + saved.size}`;
      saved.set(body.p_secret_hash, id);
      return response(id);
    },
  });
  for (let i = 0; i < 300; i++) {
    const value = i.toString(16).padStart(64, '0');
    assert.equal(
      (
        await handler(
          request('', { ...payload, installId: `synthetic-install-${i}` }, false, {
            'x-report-secret': value,
            'x-forwarded-for': `192.0.2.${i}`,
          }),
        )
      ).status,
      201,
    );
  }
  assert.equal((await handler(request('', payload, false, { 'x-report-secret': 'ff'.repeat(32) }))).status, 429);
  const retry = await handler(request('', payload, false, { 'x-report-secret': '0'.repeat(64) }));
  assert.deepEqual(await retry.json(), { id: 'PP-1000', secret: '0'.repeat(64) });
  assert.equal(saved.size, 300);
  const sql = await readFile(new URL('../supabase/migrations/0007_problem_reports.sql', import.meta.url), 'utf8');
  assert.match(sql, /create unique index[^;]+\(secret_hash\)/);
  assert.match(sql, /on conflict \(secret_hash\) do update[\s\S]*returning id into report_id/);
  assert.ok(sql.indexOf('if found then return report_id') < sql.indexOf('>= 5'));
  assert.ok(sql.indexOf('pg_advisory_xact_lock') < sql.indexOf('if found then return report_id'));
  assert.match(sql, /where created_at > now\(\)-interval '1 hour'\) >= 300/);
});

test('admin lists at most 100 newest summaries with one signing batch and fetches diagnostics only on demand', async () => {
  const rows = Array.from({ length: 800 }, (_, i) => ({
    id: `PP-${1800 - i}`,
    created_at: String(1800 - i),
    diagnostics: { secret: 'detail-only' },
  }));
  const calls: URL[] = [];
  let signing = 0;
  const handler = createProblemReportHandler(
    {
      url: 'https://fake.invalid',
      serviceKey: 'fake',
      ownerUserId: 'owner',
      fetch: async (input, init) => {
        const url = new URL(String(input));
        calls.push(url);
        if (url.pathname === '/auth/v1/user') return response({ id: 'owner' });
        if (url.pathname === '/rest/v1/problem_reports') {
          if (url.searchParams.has('id')) {
            assert.equal(url.searchParams.get('id'), 'eq.PP-1800');
            return response([rows[0]]);
          }
          assert.equal(url.searchParams.get('limit'), '100');
          assert.equal(url.searchParams.get('order'), 'created_at.desc,id.desc');
          assert.doesNotMatch(url.searchParams.get('select')!, /diagnostics/);
          return response(rows.slice(0, 100));
        }
        if (url.pathname === '/rest/v1/problem_report_files') {
          assert.equal(url.searchParams.get('limit'), '400');
          return response(
            url.searchParams
              .get('report_id')!
              .slice(4, -1)
              .split(',')
              .flatMap((id) => Array.from({ length: 4 }, (_, i) => ({ report_id: id, path: `${id}/${i}.jpg` }))),
          );
        }
        if (url.pathname === '/storage/v1/object/sign/problem-report-files') {
          signing++;
          const body = JSON.parse(String(init?.body));
          assert.equal(body.expiresIn, 600);
          return response(
            body.paths.map((path: string) => ({
              path,
              signedURL: '/object/sign/problem-report-files/' + path + '?token=fake',
            })),
          );
        }
        throw Error('Unexpected fake URL');
      },
    },
    true,
  );
  const headers = { authorization: 'Bearer fake' };
  const listing = await (await handler(request('', undefined, true, headers))).json();
  assert.equal(listing.reports.length, 100);
  assert.equal(listing.reports[0].id, 'PP-1800');
  assert.ok(listing.reports.every((row: any) => !('diagnostics' in row) && row.images.length === 4));
  assert.equal(signing, 1);
  assert.equal(calls.length, 4);
  const detail = await (await handler(request('/PP-1800', undefined, true, headers))).json();
  assert.deepEqual(detail.report.diagnostics, { secret: 'detail-only' });
  assert.equal(signing, 2);
});
test('fingerprints ignore CLI status and conversation errors', async () => {
  const environment = { clis: [{ status: 'error' }] };
  const first = await reportFingerprint({ environment, errors: 'Error: first' });
  const second = await reportFingerprint({ environment, errors: 'Error: second' });
  assert.notEqual(first, second);
  assert.equal(await reportFingerprint({ environment, conversation: 'Error: unrelated' }), null);
  assert.equal(await reportFingerprint({ environment, task: { steps: [{ error: 'Error: first' }] } }), first);
});
const payload = {
  installId: 'synthetic-install-123',
  version: '0.0.test',
  os: 'test-os',
  description: 'Synthetic failure',
  diagnostics: { errors: ['Error: synthetic\n    at example (app.ts:1:1)'] },
};
const jpeg = `data:image/jpeg;base64,${Buffer.from([255, 216, 255, 217]).toString('base64')}`;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function request(path = '', body?: unknown, admin = false, headers: Record<string, string> = {}) {
  return new Request(`https://relay.invalid/functions/v1/report-problem${admin ? '-admin' : ''}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      ...(body && !admin && !path ? { 'x-report-secret': secret } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function harness(admin = false) {
  const calls: { path: string; init: RequestInit; body: any }[] = [];
  const slots = new Set<string>();
  let owner = true;
  let limited = false;
  const fetcher: typeof fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname + new URL(String(url)).search;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    calls.push({ path, init, body });
    if (path === '/auth/v1/user') return response({ id: owner ? 'owner-id' : 'other-id' });
    if (path.endsWith('/rpc/create_problem_report'))
      return limited ? response({ message: 'RATE_LIMIT' }, 400) : response('PP-1234');
    if (path.endsWith('/rpc/reserve_problem_report_files')) {
      const next = new Set([...slots, ...body.p_paths]);
      if (next.size > 4) return response({ message: 'IMAGE_LIMIT' }, 400);
      next.forEach((path) => slots.add(path));
      return new Response(null, { status: 204 });
    }
    if (path.includes('/storage/v1/object/sign/'))
      return response(
        body.paths.map((path: string) => ({
          path,
          signedURL: '/object/sign/problem-report-files/' + path + '?token=synthetic',
        })),
      );
    if (path.includes('/storage/v1/object/')) return response({ Key: 'synthetic' });
    if (path.startsWith('/rest/v1/problem_report_files'))
      return init.method === 'PATCH'
        ? new Response(null, { status: 204 })
        : response([{ report_id: 'PP-1234', path: 'PP-1234/a.jpg' }]);
    if (path.startsWith('/rest/v1/problem_reports?status='))
      return response([
        {
          id: 'PP-1234',
          description: 'Synthetic',
          version: 'test',
          os: 'test',
          status: 'new',
          diagnostics: {},
          duplicate_of: null,
        },
        { id: 'PP-1235', description: 'Same', status: 'new', duplicate_of: 'PP-1234' },
      ]);
    if (path.startsWith('/rest/v1/problem_reports')) {
      if (init.method === 'PATCH') return response([{ id: 'PP-1234' }]);
      if (path.includes('id=eq.PP-1000')) return response([{ status: 'fixed', fixed_in: '1.2.3' }]);
      if (path.includes('secret_hash=eq.'))
        return response([{ id: 'PP-1234', status: 'new', fixed_in: null, duplicate_of: 'PP-1000' }]);
      if (path.includes('id=eq.PP-1234'))
        return response([{ id: 'PP-1234', diagnostics: { errors: 'Synthetic detail' } }]);
    }
    throw new Error(`Unexpected fake request: ${path}`);
  };
  const handler = createProblemReportHandler(
    { url: 'https://database.invalid', serviceKey: 'synthetic-service-key', ownerUserId: 'owner-id', fetch: fetcher },
    admin,
  );
  return {
    handler,
    calls,
    slots,
    nonOwner: () => {
      owner = false;
    },
    limit: () => {
      limited = true;
    },
  };
}

test('relay creates hashed identity/secret and stable error fingerprints using fake fetch only', async () => {
  const { handler, calls } = harness();
  const result = await handler(request('', payload, false, { 'x-forwarded-for': '192.0.2.1' }));
  assert.equal(result.status, 201);
  const receipt = await result.json();
  assert.equal(receipt.id, 'PP-1234');
  assert.match(receipt.secret, /^[0-9a-f]{64}$/);
  assert.equal(calls[0].body.p_secret_hash, await reportHash(receipt.secret));
  assert.equal(calls[0].body.p_install_hash, await reportHash(payload.installId));
  assert.equal(calls[0].body.p_ip_hash, await reportHash('192.0.2.1'));
  assert.equal(calls[0].body.p_fingerprint, await reportFingerprint(payload.diagnostics));
  assert.deepEqual(JSON.parse(calls[0].body.p_diagnostics), payload.diagnostics);
  assert.equal(await reportFingerprint({ errors: [] }), null);
  assert.equal(
    await reportFingerprint({ errors: ['Error: same\n at fn (x:1)', 'other'] }),
    await reportFingerprint({ errors: ['Error: same\n at fn (x:1)'] }),
  );
});

test('diagnostic size measures exactly the same UTF-8 JSON bytes at relay and database boundary', async () => {
  const fake = harness();
  const diagnostics = { error: 'x'.repeat(204800 - Buffer.byteLength(JSON.stringify({ error: '' }))) };
  assert.equal((await fake.handler(request('', { ...payload, diagnostics }))).status, 201);
  assert.equal(Buffer.byteLength(fake.calls[0].body.p_diagnostics), 204800);
  diagnostics.error += 'x';
  assert.equal((await fake.handler(request('', { ...payload, diagnostics }))).status, 413);
  assert.equal(fake.calls.length, 1);
});

test('relay rejects oversized descriptions, UTF-8 diagnostics and invalid images before storage', async () => {
  const { handler, calls } = harness();
  assert.equal((await handler(request('', { ...payload, description: 'x'.repeat(4001) }))).status, 400);
  assert.equal((await handler(request('', { ...payload, diagnostics: { error: '界'.repeat(70000) } }))).status, 413);
  assert.equal(calls.length, 0);
  const headers = { 'x-report-secret': secret };
  assert.equal(
    (await handler(request('/PP-1234/files', { images: Array(5).fill({ dataUrl: jpeg }) }, false, headers))).status,
    400,
  );
  assert.equal(
    (await handler(request('/PP-1234/files', { images: [{ dataUrl: 'data:image/jpeg;base64,YWJj' }] }, false, headers)))
      .status,
    400,
  );
  const huge = Buffer.alloc(1048577, 255);
  huge[1] = 216;
  assert.equal(
    (
      await handler(
        request(
          '/PP-1234/files',
          { images: [{ dataUrl: `data:image/jpeg;base64,${huge.toString('base64')}` }] },
          false,
          headers,
        ),
      )
    ).status,
    413,
  );
  assert.equal(calls.filter((call) => call.path.includes('/storage/')).length, 0);
});

test('relay returns plain JSON quota errors and does not expose backend errors', async () => {
  const fake = harness();
  fake.limit();
  const result = await fake.handler(request('', payload));
  assert.equal(result.status, 429);
  assert.deepEqual(await result.json(), { error: 'Too many reports' });
});

test('image retries use identical reserved paths and cumulative upload quota is enforced', async () => {
  const fake = harness();
  const headers = { 'x-report-secret': secret };
  const body = { images: [{ dataUrl: jpeg }] };
  assert.equal((await fake.handler(request('/PP-1234/files', body, false, headers))).status, 200);
  assert.equal((await fake.handler(request('/PP-1234/files', body, false, headers))).status, 200);
  assert.equal(fake.slots.size, 1);
  for (let i = 1; i <= 4; i++) {
    const dataUrl = `data:image/jpeg;base64,${Buffer.from([255, 216, 255, i]).toString('base64')}`;
    assert.equal(
      (await fake.handler(request('/PP-1234/files', { images: [{ dataUrl }] }, false, headers))).status,
      i < 4 ? 200 : 400,
    );
  }
  assert.equal(fake.slots.size, 4);
});

test('status requires report secret and duplicate customers inherit the original fix', async () => {
  const fake = harness();
  assert.equal((await fake.handler(request('/PP-1234/status'))).status, 404);
  assert.equal(fake.calls.length, 0);
  const result = await fake.handler(request('/PP-1234/status', undefined, false, { 'x-report-secret': secret }));
  assert.deepEqual(await result.json(), { status: 'fixed', fixedIn: '1.2.3' });
});

test('admin authenticates JWT then owner, returns ten-minute signed images and writes status', async () => {
  const fake = harness(true);
  assert.equal((await fake.handler(request('', undefined, true))).status, 401);
  assert.equal(fake.calls.length, 0);
  const headers = { authorization: 'Bearer synthetic-user-jwt' };
  const result = await fake.handler(request('', undefined, true, headers));
  const { reports } = await result.json();
  assert.equal(reports[0].duplicateCount, 1);
  assert.match(reports[0].images[0], /^https:\/\/database.invalid\/storage\/v1\/object\/sign/);
  assert.equal(fake.calls.find((call) => call.path.includes('/object/sign/'))?.body.expiresIn, 600);
  assert.equal((fake.calls[0].init.headers as Record<string, string>).authorization, headers.authorization);
  assert.equal(
    (await fake.handler(request('/PP-1234/status', { status: 'fixed', fixedIn: '' }, true, headers))).status,
    400,
  );
  assert.equal(
    (await fake.handler(request('/PP-1234/status', { status: 'fixed', fixedIn: '1.2.3' }, true, headers))).status,
    200,
  );
  assert.deepEqual(fake.calls.at(-1)?.body, { status: 'fixed', fixed_in: '1.2.3' });
  fake.nonOwner();
  const before = fake.calls.length;
  assert.equal((await fake.handler(request('', undefined, true, headers))).status, 403);
  assert.equal(fake.calls.length, before + 1);
});

test('without OWNER_USER_ID, only accounts listed in problem_report_admins may read reports', async () => {
  const admin = '0b6f2c1e-1111-4222-8333-944455556666';
  for (const [id, allowed] of [
    [admin, true],
    ['7d0c9e2a-1111-4222-8333-944455556666', false],
  ] as const) {
    const handler = createProblemReportHandler(
      {
        url: 'https://fake.invalid',
        serviceKey: 'fake',
        fetch: async (input) => {
          const url = new URL(String(input));
          if (url.pathname === '/auth/v1/user') return response({ id });
          if (url.pathname === '/rest/v1/problem_report_admins')
            return response(url.searchParams.get('user_id') === `eq.${admin}` ? [{ user_id: admin }] : []);
          if (url.pathname === '/rest/v1/problem_reports') return response([]);
          return response([]);
        },
      },
      true,
    );
    const status = (await handler(request('', undefined, true, { authorization: 'Bearer synthetic' }))).status;
    assert.equal(status, allowed ? 200 : 403);
  }
});
