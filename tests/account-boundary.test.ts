import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Express, Request, Response } from 'express';
import { accountRoutes } from '../src/server/account-routes.ts';
import { AccountService } from '../src/server/account-service.ts';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { MemorySyncRemote } from '../src/server/account-sync-remote.ts';

test('handoff HTTP routes reject every caller, including an authenticated owner', async () => {
  const handlers: Array<{ method: string; path: string | RegExp; run: Function }> = [];
  const app = Object.fromEntries(
    ['get', 'post', 'use'].map((method) => [
      method,
      (path: string | RegExp, run: Function) => handlers.push({ method, path, run }),
    ]),
  ) as unknown as Express;
  accountRoutes(app, {
    view: () => ({ configured: true, auth: { phase: 'signed-in', email: 'test@example.invalid' } }),
  } as AccountService);
  const internal = handlers.find((h) => h.method === 'use')!;
  for (const headers of [{}, { authorization: 'Bearer renderer' }, { 'x-pugport-owner': 'owner' }]) {
    let status = 0;
    let body: unknown;
    const res = {
      status: (code: number) => {
        status = code;
        return res;
      },
      json: (value: unknown) => {
        body = value;
      },
    };
    await internal.run({ headers } as Request, res as unknown as Response);
    assert.equal(status, 403);
    assert.deepEqual(body, { error: 'MAIN_PROCESS_ONLY' });
  }
  assert.ok(!handlers.some((h) => typeof h.path === 'string' && /session|key\/provide/.test(h.path)));
});

test('preload and public account contracts expose no token or data-key operation', () => {
  const preload = readFileSync(new URL('../src/electron/preload.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(preload, /refreshToken|dataKey|account-session|account-key|account-persist-key/);
  const contract = readFileSync(new URL('../src/shared/account-ui.ts', import.meta.url), 'utf8').split(
    'export type AccountSession',
  )[0];
  assert.doesNotMatch(contract, /refreshToken|accessToken|dataKey|code_verifier/);
  const routes = readFileSync(new URL('../src/server/account-routes.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(routes, /refreshToken|accessToken|dataKey|handleMainMessage/);
});

test('stale confirmations cannot act on another signed-in session', async () => {
  const db = new DatabaseSync(':memory:');
  const service = new AccountService({
    workspace: new WorkspaceStore(db, { recoverInterrupted: false }),
    directory: tmpdir(),
    desktop: true,
    config: { url: 'https://synthetic.invalid', publishableKey: 'sb_publishable_test' },
    remote: (session) => new MemorySyncRemote(undefined, session.userId),
  });
  const session = (userId: string) =>
    service.handleMainMessage({
      type: 'account-session',
      session: {
        userId,
        email: `${userId}@example.invalid`,
        accessToken: 'synthetic',
        expiresAt: Date.now() + 3600000,
      },
    });
  try {
    await session('first');
    const stale = service.view().sessionId;
    await session('first');
    assert.equal(service.view().sessionId, stale, 'token refresh preserves confirmation identity');
    await session('second');
    assert.notEqual(service.view().sessionId, stale);
    let calls = 0;
    service.merge = service.deleteCloud = async () => {
      ++calls;
      return service.view();
    };
    const routes = new Map<string, Function>();
    const app = {
      use() {},
      get() {},
      post(path: string, run: Function) {
        routes.set(path, run);
      },
    } as unknown as Express;
    accountRoutes(app, service);
    assert.deepEqual(
      [...routes.keys()],
      ['sign-in', 'cancel', 'sign-out', 'merge', 'delete-cloud'].map((path) => `/api/account/${path}`),
    );
    for (const path of ['merge', 'delete-cloud']) {
      let status = 0;
      let body: unknown;
      const res = {
        status(code: number) {
          status = code;
          return res;
        },
        json(value: unknown) {
          body = value;
        },
      };
      await routes.get(`/api/account/${path}`)!(
        { body: { sessionId: stale, confirmed: true, allowAccountChange: true } },
        res,
      );
      assert.equal(status, 400, path);
      assert.deepEqual(body, { error: 'ACCOUNT_SESSION_CHANGED' }, path);
    }
    assert.equal(calls, 0);
    service.assertSession(service.view().sessionId);
    await service.handleMainMessage({ type: 'account-clear' });
    assert.equal(service.view().sessionId, undefined);
    assert.throws(() => service.assertSession(stale), /ACCOUNT_SESSION_CHANGED/);
  } finally {
    await service.close();
    db.close();
  }
});
