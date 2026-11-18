import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from '../src/server/platform/test-process.ts';
import type { ChildProcess } from 'node:child_process';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import { OwnedBackend } from '../src/electron/backend.ts';
import { APP_NAME, APP_VERSION } from '../src/shared/identity.ts';
import {
  AccountAuth,
  AccountVault,
  createPkce,
  pkceChallenge,
  startAccountCallback,
  type CallbackListener,
  type Schedule,
} from '../src/electron/account.ts';
import type { AccountMainMessage } from '../src/shared/account-ui.ts';

const config = { url: 'https://synthetic.invalid', publishableKey: 'sb_publishable_synthetic' };
const token = (refresh = 'synthetic-refresh') => ({
  access_token: 'synthetic-access',
  refresh_token: refresh,
  expires_in: 3600,
  user: { id: 'synthetic-user', email: 'synthetic@example.invalid' },
});
function clock() {
  const tasks: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const schedule: Schedule = (fn, ms) => {
    const entry = { fn, ms, cancelled: false };
    tasks.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  return { tasks, schedule };
}
const memoryStorage = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw Error('unused');
  },
  decryptString: () => {
    throw Error('unused');
  },
};
function callbackHarness(occupied = 0) {
  const servers: (EventEmitter & {
    host?: string;
    port?: number;
    closed: boolean;
    request: (url: string) => { status: number; body: string };
  })[] = [];
  const createServer = (handler: (req: IncomingMessage, res: ServerResponse) => void): Server => {
    const server = Object.assign(new EventEmitter(), {
      closed: false,
      host: '',
      port: 0,
      listen(port: number, host: string, ready: () => void) {
        server.host = host;
        server.port = port;
        queueMicrotask(() => {
          if (occupied-- > 0) server.emit('error', Object.assign(new Error('busy'), { code: 'EADDRINUSE' }));
          else ready();
        });
        return server;
      },
      close() {
        server.closed = true;
        return server;
      },
      closeAllConnections() {},
      request(url: string) {
        const result = { status: 0, body: '' };
        handler(
          { url, method: 'GET' } as IncomingMessage,
          {
            writeHead(code: number) {
              result.status = code;
            },
            end(body = '') {
              result.body = body;
            },
          } as unknown as ServerResponse,
        );
        return result;
      },
    });
    servers.push(server);
    return server as unknown as Server;
  };
  return { servers, createServer };
}

test('PKCE matches RFC 7636 appendix B and uses a random valid verifier', () => {
  assert.equal(
    pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  );
  const a = createPkce();
  const b = createPkce();
  assert.match(a.verifier, /^[A-Za-z0-9._~-]{43,128}$/);
  assert.notEqual(a.verifier, b.verifier);
  assert.equal(a.challenge, pkceChallenge(a.verifier));
});

test('callback binds loopback, falls back on busy port and rejects mismatched state', async () => {
  const h = callbackHarness(1);
  const c = clock();
  const listener = await startAccountCallback('synthetic-state', {
    createServer: h.createServer,
    schedule: c.schedule,
  });
  assert.deepEqual(
    h.servers.map((s) => [s.host, s.port]),
    [
      ['127.0.0.1', 38917],
      ['127.0.0.1', 38918],
    ],
  );

  assert.equal(h.servers[1].request('/auth/callback?state=wrong&code=fake').status, 400);
  assert.equal(h.servers[1].closed, false);
  h.servers[1].request('/auth/callback?state=synthetic-state&code=valid');
  assert.equal(await listener.code, 'valid');
  listener.complete!(true);
  assert.ok(c.tasks.every((t) => t.cancelled));
});

test('callback accepts exactly one valid code and closes', async () => {
  const h = callbackHarness();
  const listener = await startAccountCallback('state', { createServer: h.createServer });
  assert.equal(h.servers[0].request('/favicon.ico').status, 404);
  assert.equal(h.servers[0].request('//[').status, 400);
  assert.equal(h.servers[0].closed, false, 'Malformed traffic must not settle or close the pending sign-in');
  const response = h.servers[0].request('/auth/callback?state=state&code=auth-code');
  assert.equal(response.status, 0, 'Browser must wait for token exchange before showing success');
  assert.equal(await listener.code, 'auth-code');
  listener.complete!(true);
  assert.equal(response.status, 200);
  assert.match(response.body, /Signed in/);
  assert.equal(h.servers[0].closed, true);
});

test('browser callback reports a failed token exchange without showing success', async () => {
  const h = callbackHarness();
  const listener = await startAccountCallback('state', { createServer: h.createServer });
  const response = h.servers[0].request('/auth/callback?state=state&code=auth-code');
  assert.equal(await listener.code, 'auth-code');
  listener.complete!(false);
  assert.equal(response.status, 400);
  assert.match(response.body, /Sign-in failed/);
  assert.equal(h.servers[0].closed, true);
});

test('callback times out at five minutes and cancels cleanly', async () => {
  for (const cancel of [false, true]) {
    const h = callbackHarness();
    const c = clock();
    const listener = await startAccountCallback('state', { createServer: h.createServer, schedule: c.schedule });
    const failure = assert.rejects(listener.code, cancel ? /CANCELLED/ : /TIMED_OUT/);
    assert.equal(c.tasks[0].ms, 300000);
    if (cancel) listener.cancel();
    else c.tasks[0].fn();
    await failure;
    assert.equal(h.servers[0].closed, true);
  }
});

test('safeStorage encrypted round trip uses a private file; unavailable encryption writes nothing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pugport-account-'));
  try {
    const storage = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(Buffer.from(value).map((x) => x ^ 0x55)),
      decryptString: (value: Buffer) =>
        Buffer.from(value)
          .map((x) => x ^ 0x55)
          .toString(),
    };
    const vault = new AccountVault(directory, storage);
    await vault.save({
      userId: 'u',
      email: 'e',
      refreshToken: 'synthetic-secret',
      key: Buffer.alloc(32, 7).toString('base64'),
    });
    const bytes = await readFile(vault.file, 'utf8');
    assert.equal(bytes.includes('synthetic-secret'), false);
    assert.equal((await new AccountVault(directory, storage).load())?.refreshToken, 'synthetic-secret');
    if (process.platform === 'win32') {
      const acl = await promisify(execFile)(
        join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe'),
        [vault.file],
        { windowsHide: true },
      );
      assert.ok(!acl.stdout.includes('(I)'), 'Account ciphertext must not inherit directory permissions');
      assert.equal(acl.stdout.match(/:\(F\)/g)?.length, 2, 'Only owner and SYSTEM have access');
    } else assert.equal((await stat(vault.file)).mode & 0o077, 0);
    await vault.clear();
    await assert.rejects(stat(vault.file), { code: 'ENOENT' });
    const memory = new AccountVault(join(directory, 'memory'), memoryStorage);
    await memory.save({ userId: 'u', email: 'e', refreshToken: 'secret' });
    assert.equal((await memory.load())?.refreshToken, 'secret');
    await assert.rejects(stat(join(directory, 'memory')), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function authHarness(fetcher: typeof fetch, overrides: Partial<ConstructorParameters<typeof AccountAuth>[0]> = {}) {
  const c = clock();
  const messages: AccountMainMessage[] = [];
  const urls: string[] = [];
  const callback = async (): Promise<CallbackListener> => ({
    redirectUrl: 'http://127.0.0.1:38917/auth/callback?state=state',
    code: Promise.resolve('synthetic-code'),
    cancel() {},
  });
  const vault = new AccountVault(join(tmpdir(), 'pugport-memory-only-unused'), memoryStorage);
  const auth = new AccountAuth({
    config,
    vault,
    fetch: fetcher,
    send: (m) => {
      messages.push(m);
    },
    openExternal: async (url) => {
      urls.push(url);
    },
    callback,
    now: () => 1000,
    schedule: c.schedule,
    ...overrides,
  });
  return { auth, vault, messages, urls, ...c };
}

test('exchange uses PKCE, refreshes before expiry, hands off only access token and logout clears secrets', async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const h = authHarness(async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify(token()), { status: 200 });
  });
  await h.auth.signIn();
  const authorize = new URL(h.urls[0]);
  assert.equal(authorize.searchParams.get('provider'), 'google');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 's256');
  assert.equal(requests[0].url, `${config.url}/auth/v1/token?grant_type=pkce`);
  const body = JSON.parse(String(requests[0].init?.body));
  assert.equal(body.auth_code, 'synthetic-code');
  assert.equal(pkceChallenge(body.code_verifier), authorize.searchParams.get('code_challenge'));
  assert.equal(new Headers(requests[0].init?.headers).get('apikey'), config.publishableKey);
  assert.equal(h.tasks.at(-1)?.ms, 3540000);
  assert.equal(JSON.stringify(h.messages).includes('synthetic-refresh'), false);
  await h.auth.refresh();
  assert.equal(requests[1].url, `${config.url}/auth/v1/token?grant_type=refresh_token`);
  await h.auth.signOut();
  assert.equal(requests.at(-1)?.url, `${config.url}/auth/v1/logout?scope=local`);
  assert.equal(await h.vault.load(), undefined);
  assert.equal(h.auth.state.phase, 'signed-out');
});

test('offline refresh backs off and retains session; rejected refresh signs out', async () => {
  let mode = 'success';
  const h = authHarness(async () => {
    if (mode === 'offline') throw new TypeError('network offline');
    return mode === 'rejected' ? new Response('{}', { status: 400 }) : new Response(JSON.stringify(token()));
  });
  await h.auth.signIn();
  mode = 'offline';
  await h.auth.refresh();
  assert.equal(h.auth.state.phase, 'signed-in');
  assert.equal(h.tasks.at(-1)?.ms, 1000);
  await h.auth.refresh();
  assert.equal(h.tasks.at(-1)?.ms, 2000);
  mode = 'rejected';
  await h.auth.refresh();
  assert.equal(h.auth.state.phase, 'signed-out');
  assert.equal(h.auth.state.error, 'SESSION_EXPIRED');
  assert.equal((await h.vault.load())?.refreshToken, undefined);
});

test('restore retries offline, then re-hands the session and trusted key to a restarted backend', async () => {
  let offline = true;
  const h = authHarness(async () => {
    if (offline) throw Error('offline');
    return new Response(JSON.stringify(token()));
  });
  await h.vault.save({
    userId: 'synthetic-user',
    email: 'e',
    refreshToken: 'old-refresh',
    key: Buffer.alloc(32, 1).toString('base64'),
    keyId: '123e4567-e89b-42d3-a456-426614174000',
  });
  await h.auth.restore();
  assert.equal(h.auth.state.phase, 'signed-in');
  assert.equal(h.tasks.at(-1)?.ms, 1000);
  offline = false;
  await h.auth.refresh();
  h.messages.length = 0;
  h.auth.handoff();
  assert.deepEqual(
    h.messages.map((m) => m.type),
    ['account-auth', 'account-key', 'account-session', 'account-active'],
  );
  assert.equal(JSON.stringify(h.messages).includes('refresh'), false);
  h.auth.stop();
});

test('sign-out while token exchange is in flight cannot resurrect a session', async () => {
  let resolve!: (response: Response) => void;
  const h = authHarness(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  const signingIn = h.auth.signIn();
  while (!resolve) await new Promise((done) => setImmediate(done));
  await h.auth.signOut();
  resolve(new Response(JSON.stringify(token())));
  await signingIn;
  assert.equal(h.auth.state.phase, 'signed-out');
  assert.equal(await h.vault.load(), undefined);
});

test('cancel during async encryption clears the queued token write and cannot hand off later', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pugport-account-cancel-'));
  let encrypted!: (value: Buffer) => void;
  let plaintext = '';
  try {
    const vault = new AccountVault(directory, {
      isEncryptionAvailable: () => true,
      encryptString: () => {
        throw Error('sync encryption must not run');
      },
      decryptString: (value) => value.toString(),
      encryptStringAsync: (value) => {
        plaintext = value;
        return new Promise((resolve) => {
          encrypted = resolve;
        });
      },
    });
    const h = authHarness(async () => new Response(JSON.stringify(token())), { vault });
    const signingIn = h.auth.signIn();
    while (!encrypted) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.auth.state.phase, 'signing-in');
    h.auth.cancel();
    encrypted(Buffer.from(plaintext));
    await signingIn;
    assert.equal(await vault.load(), undefined);
    await assert.rejects(stat(vault.file), { code: 'ENOENT' });
    h.messages.length = 0;
    h.auth.handoff();
    assert.equal(
      h.messages.some((message) => message.type === 'account-session' || message.type === 'account-key'),
      false,
    );
    assert.equal(h.auth.state.phase, 'signed-out');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unconfigured account performs no fetch, callback or disk access', async () => {
  const h = authHarness(
    async () => {
      assert.fail('unexpected fetch');
    },
    { config: { url: '', publishableKey: '' } },
  );
  await h.auth.restore();
  await h.auth.signIn();
  h.auth.handoff();
  assert.deepEqual(h.messages, []);
  assert.deepEqual(h.urls, []);
  assert.equal(await h.vault.load(), undefined);
});

test('registered protocol is a one-shot PKCE fallback only after all five loopback ports are unavailable', async () => {
  const loopback = callbackHarness(5);
  let exchanges = 0;
  const h = authHarness(
    async () => {
      exchanges++;
      return new Response(JSON.stringify(token()));
    },
    {
      protocolAvailable: () => true,
      callback: (state) => startAccountCallback(state, { createServer: loopback.createServer }),
    },
  );
  const pending = h.auth.signIn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loopback.servers.length, 5);
  const authorize = new URL(h.urls[0]);
  const redirect = new URL(authorize.searchParams.get('redirect_to')!);
  assert.equal(redirect.protocol, 'pugport:');
  assert.equal(redirect.host, 'auth');
  assert.equal(redirect.pathname, '/callback');
  assert.ok(redirect.searchParams.get('state'));
  assert.equal(h.auth.handleUrl('https://outside.invalid/auth/callback?state=wrong&code=fake'), false);
  assert.equal(h.auth.handleUrl('pugport://auth.evil/callback?state=wrong&code=fake'), false);
  assert.equal(h.auth.handleUrl('pugport://user@auth/callback?state=wrong&code=fake'), false);
  redirect.searchParams.set('code', 'synthetic-code');
  assert.equal(h.auth.handleUrl(redirect.href), true);
  assert.equal(h.auth.handleUrl(redirect.href), false);
  await pending;
  assert.equal(exchanges, 1);
  assert.equal(h.auth.state.phase, 'signed-in');
  h.auth.stop();
});

test('protocol fallback rejects state mismatch, timeout and cancelled or late links without a session', async () => {
  for (const outcome of ['state', 'timeout', 'cancel', 'stop'] as const) {
    const c = clock();
    const h = authHarness(
      async () => {
        assert.fail('Invalid or cancelled callback must not exchange a token');
      },
      {
        protocolAvailable: () => true,
        callback: async () => {
          throw Error('NO_CALLBACK_PORT');
        },
        schedule: c.schedule,
      },
    );
    const pending = h.auth.signIn();
    await new Promise((resolve) => setImmediate(resolve));
    const redirect = new URL(new URL(h.urls[0]).searchParams.get('redirect_to')!);
    redirect.searchParams.set('code', 'synthetic-code');
    const valid = redirect.href;
    if (outcome === 'state') {
      redirect.searchParams.set('state', 'wrong');
      assert.equal(h.auth.handleUrl(redirect.href), false);
      assert.equal(h.auth.state.phase, 'signing-in');
      c.tasks[0].fn();
    } else if (outcome === 'timeout') {
      assert.equal(c.tasks[0].ms, 300000);
      c.tasks[0].fn();
    } else if (outcome === 'stop') h.auth.stop();
    else h.auth.cancel();
    await pending;
    assert.equal(h.auth.handleUrl(valid), false);
    h.messages.length = 0;
    h.auth.handoff();
    assert.equal(
      h.messages.some((message) => message.type === 'account-session' || message.type === 'account-key'),
      false,
    );
    assert.equal(await h.vault.load(), undefined);
    if (outcome !== 'stop') assert.equal(h.auth.state.phase, 'signed-out');
  }
});

test('unregistered builds report unavailable callback ports and successful loopback never uses protocol fallback', async () => {
  const unavailable = authHarness(
    async () => {
      assert.fail('unexpected fetch');
    },
    {
      protocolAvailable: () => false,
      callback: async () => {
        throw Error('NO_CALLBACK_PORT');
      },
    },
  );
  await unavailable.auth.signIn();
  assert.equal(unavailable.auth.state.error, 'NO_CALLBACK_PORT');
  assert.deepEqual(unavailable.urls, []);
  const loopback = authHarness(async () => new Response(JSON.stringify(token())), {
    protocolAvailable: () => {
      assert.fail('Primary loopback callback succeeded');
    },
  });
  await loopback.auth.signIn();
  assert.equal(new URL(new URL(loopback.urls[0]).searchParams.get('redirect_to')!).protocol, 'http:');
  loopback.auth.stop();
});

test('safeStorage uses async APIs, including Electron decryption result objects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pugport-account-async-'));
  try {
    const storage = {
      isEncryptionAvailable: () => true,
      encryptString: () => {
        throw Error('sync encryption must not run');
      },
      decryptString: () => {
        throw Error('sync decryption must not run');
      },
      encryptStringAsync: async (value: string) => Buffer.from(value),
      decryptStringAsync: async (value: Buffer) => ({ result: value.toString(), shouldReEncrypt: false }),
    };
    await new AccountVault(directory, storage).save({ userId: 'u', email: 'e', refreshToken: 'synthetic' });
    assert.equal((await new AccountVault(directory, storage).load())?.userId, 'u');
    const unsafe = new AccountVault(join(directory, 'unsafe'), {
      ...storage,
      getSelectedStorageBackend: () => 'basic_text',
    });
    await unsafe.save({ userId: 'u', email: 'e', refreshToken: 'synthetic' });
    assert.equal(unsafe.memoryOnly, true);
    await assert.rejects(stat(join(directory, 'unsafe')), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('refresh timer runs automatically and only accepts trusted keys for its current user', async () => {
  let requests = 0;
  const h = authHarness(async () => {
    requests++;
    return new Response(JSON.stringify(token()));
  });
  await h.auth.signIn();
  h.tasks.at(-1)!.fn();
  await h.auth.refresh();
  assert.equal(requests, 2);
  const key = Buffer.alloc(32, 3).toString('base64');
  await h.auth.handle({ type: 'account-persist-key', userId: 'wrong-user', key });
  assert.equal((await h.vault.load())?.key, undefined);
  await h.auth.handle({
    type: 'account-persist-key',
    userId: 'synthetic-user',
    key,
    keyId: '123e4567-e89b-42d3-a456-426614174000',
  });
  assert.equal((await h.vault.load())?.key, key);
  await h.auth.handle({ type: 'account-persist-key', userId: 'synthetic-user' });
  assert.equal((await h.vault.load())?.key, undefined);
  h.auth.stop();
});

test('cancelling while the loopback server starts cancels the late listener without opening a browser', async () => {
  let resolve!: (listener: CallbackListener) => void;
  let cancelled = false;
  const h = authHarness(
    async () => {
      assert.fail('unexpected exchange');
    },
    {
      callback: () =>
        new Promise((done) => {
          resolve = done;
        }),
    },
  );
  const pending = h.auth.signIn();
  h.auth.cancel();
  resolve({
    redirectUrl: 'http://127.0.0.1:38917/auth/callback',
    code: Promise.resolve('unused'),
    cancel() {
      cancelled = true;
    },
  });
  await pending;
  assert.equal(cancelled, true);
  assert.deepEqual(h.urls, []);
  assert.equal(h.auth.state.phase, 'signed-out');
});

test('account handoff is limited to the ready owned child and stops after child exit', async () => {
  const child = Object.assign(new EventEmitter(), {
    connected: true,
    exitCode: null as number | null,
    signalCode: null,
    pid: 90001,
    stdout: { resume() {} },
    stderr: { resume() {} },
    send(message: unknown, callback?: (error: Error | null) => void) {
      sent.push(message);
      callback?.(null);
    },
  });
  const sent: unknown[] = [];
  const received: unknown[] = [];
  const backend = new OwnedBackend({
    root: '.',
    dataDir: 'synthetic-account-directory',
    port: 4317,
    restartLimit: 0,
    launch: () => child as unknown as ChildProcess,
    healthFetch: async () => {
      throw Error('synthetic offline');
    },
    accountMessage: (message) => {
      received.push(message);
    },
    terminate: async () => {},
  });
  const message = {
    type: 'account-key' as const,
    userId: 'u',
    key: Buffer.alloc(32).toString('base64'),
    keyId: '123e4567-e89b-42d3-a456-426614174000',
  };
  backend.sendAccount(message);
  assert.deepEqual(sent, []);
  const pending = backend.start();
  child.emit('message', { type: 'account-action', action: 'sign-in' });
  assert.deepEqual(received, []);
  child.emit('message', {
    type: 'ready',
    name: APP_NAME,
    version: APP_VERSION,
    port: 4317,
    dataDir: 'synthetic-account-directory',
  });
  await pending;
  backend.sendAccount(message);
  assert.deepEqual(sent, [message]);
  child.emit('message', { type: 'account-action', action: 'sign-in' });
  assert.equal(received.length, 1);
  const stopping = backend.stop();
  child.emit('message', { type: 'shutdown-complete' });
  child.connected = false;
  child.exitCode = 0;
  child.emit('exit', 0, null);
  await stopping;
  backend.sendAccount(message);
  child.emit('message', { type: 'account-action', action: 'sign-in' });
  assert.equal(received.length, 1);
  assert.equal(sent.filter((value) => (value as { type: string }).type === 'account-key').length, 1);
});

test('rejected refresh retains trusted key identity and same-user sign-in reuses it', async () => {
  let rejected = false;
  const h = authHarness(async () =>
    rejected ? new Response('{}', { status: 400 }) : new Response(JSON.stringify(token())),
  );
  await h.auth.signIn();
  const key = Buffer.alloc(32, 7).toString('base64');
  const keyId = '123e4567-e89b-42d3-a456-426614174000';
  await h.auth.handle({ type: 'account-persist-key', userId: 'synthetic-user', key, keyId });
  rejected = true;
  await h.auth.refresh();
  assert.deepEqual(await h.vault.load(), { userId: 'synthetic-user', email: 'synthetic@example.invalid', key, keyId });
  await h.auth.handle({
    type: 'account-persist-key',
    userId: 'synthetic-user',
    key: Buffer.alloc(32, 8).toString('base64'),
    keyId: '123e4567-e89b-42d3-a456-426614174001',
  });
  assert.equal(h.auth.state.phase, 'signed-out', 'Late key persistence cannot resurrect an expired session');
  assert.equal((await h.vault.load())?.keyId, keyId);
  rejected = false;
  await h.auth.signIn();
  assert.equal((await h.vault.load())?.keyId, keyId);
  assert.ok(h.messages.some((m) => m.type === 'account-key' && m.key === key && m.keyId === keyId));
  h.auth.stop();
});

test('vault construction never queries keychain and async availability is preferred', async () => {
  let checks = 0;
  const vault = new AccountVault(join(tmpdir(), 'synthetic-no-vault'), {
    ...memoryStorage,
    isEncryptionAvailable() {
      assert.fail('synchronous keychain query');
    },
    async isAsyncEncryptionAvailable() {
      checks++;
      return false;
    },
  });
  assert.equal(checks, 0);
  await vault.load();
  await vault.save({ userId: 'u', email: 'e', refreshToken: 'synthetic' });
  assert.ok(checks >= 1);
  assert.equal(vault.memoryOnly, true);
});

test('without a saved sign-in the OS keyring is never asked', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pugport-account-keyring-'));
  try {
    const untouched = {
      isEncryptionAvailable: (): boolean => assert.fail('keyring asked'),
      isAsyncEncryptionAvailable: (): Promise<boolean> => assert.fail('keyring asked'),
      encryptString: (): Buffer => assert.fail('keyring asked'),
      decryptString: (): string => assert.fail('keyring asked'),
    };
    const vault = new AccountVault(directory, untouched);
    assert.equal(await vault.load(), undefined);
    assert.equal(vault.keyringBusy, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an unanswered keyring request is reported until it settles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pugport-account-keyring-'));
  try {
    let answer!: (value: boolean) => void;
    const vault = new AccountVault(directory, {
      isEncryptionAvailable: () => true,
      isAsyncEncryptionAvailable: () => new Promise<boolean>((resolve) => (answer = resolve)),
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString(),
    });
    await writeFile(vault.file, Buffer.from('{}').toString('base64'));
    const loading = vault.load();
    while (!answer) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(vault.keyringBusy, true);
    answer(true);
    assert.equal(await loading, undefined);
    assert.equal(vault.keyringBusy, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
