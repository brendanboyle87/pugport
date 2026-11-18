import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { backoffMs, BankConnections, type BankNotice } from '../src/server/bank-connections.ts';

// A fake Plaid on 127.0.0.1 shaped like Sandbox. No bank, Plaid account or real credential is involved.
const CLIENT = 'synthetic-client-0001';
const SECRET = 'synthetic-sandbox-secret-0002';
const ACCESS = 'access-sandbox-synthetic-0003';
type Call = { path: string; body: Record<string, unknown> };
const tx = (id: string, amount: number, extra: Record<string, unknown> = {}) => ({
  transaction_id: id,
  account_id: 'acc_card',
  date: '2026-10-20',
  name: `Synthetic ${id}`,
  amount,
  iso_currency_code: 'CAD',
  pending: false,
  ...extra,
});

function fakePlaid() {
  const calls: Call[] = [];
  const state = {
    linkFinished: false,
    linkExit: false,
    mutateOnce: false,
    failWith: undefined as undefined | { status: number; code: string; type: string },
    liabilities: 'ok' as 'ok' | 'unsupported',
    updates: [] as { added: unknown[]; modified: unknown[]; removed: unknown[] }[],
  };
  let cursor = 0;
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      const path = req.url ?? '';
      calls.push({ path, body });
      const send = (status: number, value: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (body.client_id !== CLIENT || body.secret !== SECRET)
        return send(400, { error_type: 'INVALID_INPUT', error_code: 'INVALID_API_KEYS', error_message: 'bad keys' });
      if (state.failWith && path !== '/link/token/create' && path !== '/link/token/get')
        return send(state.failWith.status, {
          error_type: state.failWith.type,
          error_code: state.failWith.code,
          error_message: 'synthetic failure',
        });
      switch (path) {
        case '/link/token/create':
          return send(200, {
            link_token: 'link-sandbox-synthetic',
            hosted_link_url: 'https://hosted.plaid.com/link/synthetic',
            expiration: new Date(Date.now() + 4 * 3600_000).toISOString(),
          });
        case '/link/token/get':
          return send(200, {
            link_token: body.link_token,
            link_sessions: state.linkExit
              ? [{ link_session_id: 's1', exit: { status: 'requires_credentials' } }]
              : state.linkFinished
                ? [
                    {
                      link_session_id: 's1',
                      finished_at: new Date().toISOString(),
                      results: {
                        item_add_results: [
                          {
                            public_token: 'public-sandbox-synthetic',
                            institution: { institution_id: 'ins_synthetic', name: 'Synthetic Credit Union' },
                          },
                        ],
                      },
                    },
                  ]
                : [],
          });
        case '/item/public_token/exchange':
          return send(200, { access_token: ACCESS, item_id: 'item_synthetic' });
        case '/accounts/get':
          return send(200, {
            accounts: [
              {
                account_id: 'acc_card',
                name: 'Synthetic Card',
                mask: '0000',
                type: 'credit',
                subtype: 'credit card',
                balances: { current: 410.5, available: null, limit: 2000, iso_currency_code: 'CAD' },
              },
            ],
          });
        case '/transactions/sync': {
          // Each update is served once, in order; the cursor only has to change.
          if (state.mutateOnce && body.cursor) {
            state.mutateOnce = false;
            return send(400, {
              error_type: 'TRANSACTIONS_ERROR',
              error_code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION',
              error_message: 'restart',
            });
          }
          const update = state.updates.shift() ?? { added: [], modified: [], removed: [] };
          return send(200, { ...update, next_cursor: `c${++cursor}`, has_more: state.updates.length > 0 });
        }
        case '/liabilities/get':
          if (state.liabilities === 'unsupported')
            return send(400, {
              error_type: 'ITEM_ERROR',
              error_code: 'PRODUCTS_NOT_SUPPORTED',
              error_message: 'no liabilities',
            });
          return send(200, {
            liabilities: {
              credit: [
                {
                  account_id: 'acc_card',
                  aprs: [{ apr_type: 'purchase_apr', apr_percentage: 20.99 }],
                  is_overdue: null,
                  last_payment_amount: null,
                  last_payment_date: null,
                  last_statement_issue_date: '2026-10-05',
                  last_statement_balance: 380.25,
                  minimum_payment_amount: 10,
                  next_payment_due_date: null,
                },
              ],
            },
          });
        case '/item/remove':
          return send(200, { request_id: 'r' });
        default:
          return send(404, { error_type: 'API_ERROR', error_code: 'NOT_FOUND', error_message: path });
      }
    });
  });
  return { server, calls, state };
}

async function fixture(t: TestContext) {
  const plaid = fakePlaid();
  await new Promise<void>((resolve) => plaid.server.listen(0, '127.0.0.1', resolve));
  const dir = await mkdtemp(join(tmpdir(), 'bank-connections-'));
  const notices: BankNotice[] = [];
  let now = Date.parse('2026-10-30T12:00:00Z');
  const file = join(dir, 'bank-connections.private.json');
  const bank = new BankConnections({
    file,
    db: new DatabaseSync(':memory:'),
    baseUrl: `http://127.0.0.1:${(plaid.server.address() as AddressInfo).port}`,
    now: () => now,
    notice: (notice) => notices.push(notice),
    pollMs: 60_000,
  });
  t.after(async () => {
    bank.stop();
    plaid.server.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { bank, plaid, notices, file, advance: (ms: number) => (now += ms) };
}
async function connected(t: TestContext) {
  const f = await fixture(t);
  await f.bank.saveSettings({ clientId: CLIENT, environment: 'sandbox', sandboxSecret: SECRET });
  const session = await f.bank.startLink({ modId: 'example.finance' });
  assert.equal(session.status, 'waiting');
  assert.equal((await f.bank.pollLink(session.id))?.status, 'waiting');
  f.plaid.state.linkFinished = true;
  const done = await f.bank.pollLink(session.id);
  assert.equal(done?.status, 'connected');
  const id = done!.connectionId!;
  // The exchange starts a first sync; wait for it.
  await f.bank.sync(id);
  return { ...f, id };
}

test('keys and access tokens stay in the private file; views carry neither', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.bank.settings()).configured, false);
  await assert.rejects(f.bank.startLink({}), { code: 'E_NOT_CONFIGURED' });
  const settings = await f.bank.saveSettings({ clientId: CLIENT, environment: 'sandbox', sandboxSecret: SECRET });
  assert.deepEqual(settings, {
    configured: true,
    environment: 'sandbox',
    clientIdEnding: '0001',
    sandboxSecret: true,
    productionSecret: false,
  });
  // A blank secret keeps the saved one.
  assert.equal((await f.bank.saveSettings({ environment: 'sandbox' })).sandboxSecret, true);
  const session = await f.bank.startLink({ modId: 'example.finance' });
  const create = f.plaid.calls.find((call) => call.path === '/link/token/create')!.body;
  assert.deepEqual(create.products, ['transactions']);
  assert.deepEqual(create.optional_products, ['liabilities']);
  assert.deepEqual(create.country_codes, ['US', 'CA']);
  assert.deepEqual(create.hosted_link, {});
  assert.match(String((create.user as { client_user_id: string }).client_user_id), /^pugport-[a-f0-9]{24}$/);
  f.plaid.state.linkFinished = true;
  const done = await f.bank.pollLink(session.id);
  await f.bank.sync(done!.connectionId!);
  const views = JSON.stringify([
    await f.bank.list(),
    await f.bank.listFor('example.finance'),
    f.bank.linkSession(session.id),
  ]);
  for (const secret of [SECRET, ACCESS, 'item_synthetic', 'public-sandbox-synthetic'])
    assert.equal(views.includes(secret), false);
  const stored = await readFile(f.file, 'utf8');
  assert.ok(stored.includes(ACCESS) && stored.includes(SECRET));
});

test('Link grants the requesting Mod only; sync is idempotent and a change feed', async (t) => {
  const f = await connected(t);
  assert.deepEqual(
    (await f.bank.listFor('example.finance')).map((item) => item.institution?.name),
    ['Synthetic Credit Union'],
  );
  assert.deepEqual(await f.bank.listFor('example.other'), []);
  await assert.rejects(f.bank.accounts('example.other', f.id), { code: 'E_UNAVAILABLE' });
  const accounts = await f.bank.accounts('example.finance', f.id);
  assert.deepEqual(accounts[0]!.balances, { current: 410.5, limit: 2000 });

  f.plaid.state.updates = [
    { added: [tx('t1', 25), tx('t2', -100)], modified: [], removed: [] },
    { added: [tx('t3', 7.5, { pending: true })], modified: [], removed: [] },
  ];
  // A mutation during paging restarts the whole update from its first cursor.
  f.plaid.state.mutateOnce = true;
  await f.bank.sync(f.id);
  assert.equal(f.plaid.state.mutateOnce, false);
  let feed = await f.bank.transactions('example.finance', { connectionId: f.id });
  assert.deepEqual(
    feed.changes.map((change) => change.transaction.id),
    ['t1', 't2', 't3'],
  );
  assert.equal(f.notices.filter((n) => n.kind === 'new-data').length, 1);

  // The same data again adds nothing to the feed.
  const cursor = feed.cursor;
  f.plaid.state.updates = [{ added: [tx('t1', 25), tx('t2', -100)], modified: [], removed: [] }];
  await f.bank.sync(f.id);
  assert.deepEqual((await f.bank.transactions('example.finance', { connectionId: f.id, cursor })).changes, []);

  // A modified amount and a withdrawn pending transaction appear once each after the cursor.
  f.plaid.state.updates = [
    { added: [], modified: [tx('t1', 26)], removed: [{ transaction_id: 't3' }, { transaction_id: 'unknown' }] },
  ];
  await f.bank.sync(f.id);
  feed = await f.bank.transactions('example.finance', { connectionId: f.id, cursor });
  assert.deepEqual(
    feed.changes.map((change) => [change.transaction.id, change.removed]),
    [
      ['t1', false],
      ['t3', true],
    ],
  );
  assert.equal(feed.hasMore, false);
  const paged = await f.bank.transactions('example.finance', { connectionId: f.id, limit: 2 });
  assert.equal(paged.hasMore, true);
  await assert.rejects(f.bank.transactions('example.finance', { connectionId: f.id, cursor: 'bad' }), {
    code: 'E_INVALID',
  });
});

test('credit liabilities keep unknown fields absent; unsupported institutions are not a failure', async (t) => {
  const f = await connected(t);
  assert.deepEqual(await f.bank.liabilities('example.finance', f.id), [
    {
      accountId: 'acc_card',
      lastStatementIssueDate: '2026-10-05',
      lastStatementBalance: 380.25,
      minimumPaymentAmount: 10,
      aprs: [{ type: 'purchase_apr', percentage: 20.99 }],
    },
  ]);
  f.plaid.state.liabilities = 'unsupported';
  await f.bank.sync(f.id);
  assert.equal((await f.bank.status('example.finance', f.id)).status, 'connected');
});

test('a failed sync keeps data and time, backs off, and asks for reauth when the bank needs it', async (t) => {
  const f = await connected(t);
  f.plaid.state.updates = [{ added: [tx('t1', 25)], modified: [], removed: [] }];
  await f.bank.sync(f.id);
  const before = await f.bank.status('example.finance', f.id);
  f.advance(60_000);
  f.plaid.state.failWith = { status: 500, code: 'INTERNAL_SERVER_ERROR', type: 'API_ERROR' };
  await f.bank.sync(f.id);
  const failed = await f.bank.status('example.finance', f.id);
  assert.equal(failed.status, 'error');
  assert.equal(failed.lastSyncedAt, before.lastSyncedAt);
  assert.equal(Date.parse(failed.nextSyncAt!) - Date.parse(failed.lastAttemptAt!), backoffMs(1));
  assert.equal((await f.bank.transactions('example.finance', { connectionId: f.id })).changes.length, 1);
  assert.equal(backoffMs(2), 2 * backoffMs(1));
  assert.equal(backoffMs(20), 6 * 3600_000);

  f.plaid.state.failWith = { status: 400, code: 'ITEM_LOGIN_REQUIRED', type: 'ITEM_ERROR' };
  await f.bank.sync(f.id);
  assert.equal((await f.bank.status('example.finance', f.id)).status, 'reauth_required');
  assert.deepEqual(f.notices.at(-1), { kind: 'reauth', connectionId: f.id, institution: 'Synthetic Credit Union' });
  // Due syncs skip a connection that waits for the user.
  const calls = f.plaid.calls.length;
  f.advance(7 * 3600_000);
  await f.bank.syncDue();
  assert.equal(f.plaid.calls.length, calls);

  // Update mode sends the access token and no products; success clears the notice and syncs again.
  f.plaid.state.failWith = undefined;
  f.plaid.state.linkFinished = false;
  const session = await f.bank.startLink({ modId: 'example.finance', reconnect: f.id });
  const create = f.plaid.calls.filter((call) => call.path === '/link/token/create').at(-1)!.body;
  assert.equal(create.access_token, ACCESS);
  assert.equal(create.products, undefined);
  f.plaid.state.linkFinished = true;
  assert.equal((await f.bank.pollLink(session.id))?.status, 'connected');
  await f.bank.sync(f.id);
  assert.equal((await f.bank.status('example.finance', f.id)).status, 'connected');
  assert.ok(f.notices.some((n) => n.kind === 'resolved' && n.connectionId === f.id));
});

test('a cancelled Link adds nothing; removing a connection tells Plaid and clears the cache', async (t) => {
  const f = await connected(t);
  f.plaid.state.linkFinished = false;
  f.plaid.state.linkExit = true;
  const session = await f.bank.startLink({ modId: 'example.finance' });
  assert.equal((await f.bank.pollLink(session.id))?.status, 'cancelled');
  assert.equal((await f.bank.list()).length, 1);
  await f.bank.share(f.id, 'example.other', true);
  assert.equal((await f.bank.listFor('example.other')).length, 1);
  await f.bank.share(f.id, 'example.other', false);
  assert.equal((await f.bank.listFor('example.other')).length, 0);
  await f.bank.remove(f.id);
  assert.equal(f.plaid.calls.at(-1)!.path, '/item/remove');
  assert.deepEqual(await f.bank.list(), []);
  await assert.rejects(f.bank.accounts(undefined, f.id), { code: 'E_UNAVAILABLE' });
  assert.equal((await readFile(f.file, 'utf8')).includes(ACCESS), false);
});
