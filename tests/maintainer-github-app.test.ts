import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { appFiles, appJwt, GitHubAppAuth } from '../src/server/maintainer/github-app.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const start = Date.UTC(2026, 9, 28);
const minute = 60_000;

async function fixture(t: TestContext, config: unknown = { appId: '123', installationId: '456' }) {
  const root = tmpdir();
  const dir = await mkdtemp(join(root, 'github-app-test-'));
  t.after(async () => {
    assert.ok(dir.startsWith(`${root}${sep}`));
    await rm(dir, { recursive: true, force: true });
  });
  const files = appFiles(dir);
  if (config !== null) {
    await writeFile(files.config, JSON.stringify(config));
    await writeFile(files.key, pem, { mode: 0o600 });
    if (process.platform !== 'win32') await chmod(files.key, 0o600);
  }
  let now = start;
  let repository: string | undefined = 'o/r';
  const calls: { url: string; init: RequestInit }[] = [];
  let respond = async (_url: string, _init: RequestInit): Promise<Response> =>
    Response.json({ token: `synthetic-token-${calls.length}`, expires_at: new Date(now + 60 * minute).toISOString() });
  const auth = new GitHubAppAuth({
    dir,
    repository: () => repository,
    now: () => now,
    fetch: async (input, init) => {
      const url = String(input);
      calls.push({ url, init: init! });
      return respond(url, init!);
    },
  });
  return {
    auth,
    files,
    calls,
    clock: (value: number) => {
      now = value;
    },
    repository: (value: string | undefined) => {
      repository = value;
    },
    respond: (value: typeof respond) => {
      respond = value;
    },
  };
}

test('appJwt signs an RS256 JWT with the expected claims', () => {
  const jwt = appJwt('123', pem, start + 123);
  const [header, payload, signature] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header!, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(payload!, 'base64url').toString()), {
    iss: '123',
    iat: start / 1000 - 60,
    exp: start / 1000 + 540,
  });
  assert.ok(createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicKey, signature!, 'base64url'));
  assert.throws(() => appJwt('123', 'invalid key'), { message: 'github-app.pem must contain a valid RSA private key' });
});

test('missing files are unconfigured and files can be installed without restarting', async (t) => {
  const f = await fixture(t, null);
  for (const step of ['none', 'config']) {
    if (step === 'config') await writeFile(f.files.config, JSON.stringify({ appId: '123', installationId: '456' }));
    assert.equal(await f.auth.configured(), false);
    assert.equal(await f.auth.token(), undefined);
    assert.equal(await f.auth.botLogin(), undefined);
    assert.equal(await f.auth.problem(), undefined);
  }
  assert.equal(f.calls.length, 0);
  await writeFile(f.files.key, pem, { mode: 0o600 });
  assert.equal(await f.auth.configured(), true);
  assert.equal(await f.auth.token(), 'synthetic-token-1');
});

for (const config of [
  { appId: 'bad' },
  { appId: '123', extra: true },
  { appId: '123', installationId: '../456' },
  { appId: '1234567890123' },
]) {
  test(`invalid config is rejected: ${JSON.stringify(config)}`, async (t) => {
    const f = await fixture(t, config);
    assert.equal(await f.auth.configured(), true);
    assert.match((await f.auth.problem())!, /github-app.json/);
    assert.equal(await f.auth.token(), undefined);
    assert.equal(f.calls.length, 0);
  });
}

test('POSIX rejects a private key readable by other users', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX file permissions are not supported on Windows');
  const f = await fixture(t);
  await chmod(f.files.key, 0o644);
  assert.equal(await f.auth.problem(), 'github-app.pem must be readable only by you (chmod 600)');
  assert.equal(await f.auth.token(), undefined);
  assert.equal(f.calls.length, 0);
});

for (const kind of ['directory', 'large', 'invalid', 'broken-block']) {
  test(`rejects ${kind} PEM without a request`, async (t) => {
    const f = await fixture(t);
    if (kind === 'directory') {
      await rm(f.files.key);
      await mkdir(f.files.key);
    } else
      await writeFile(
        f.files.key,
        kind === 'large'
          ? 'x'.repeat(16 * 1024 + 1)
          : kind === 'invalid'
            ? 'not a key'
            : '-----BEGIN PRIVATE KEY-----\ninvalid\n-----END PRIVATE KEY-----',
      );
    assert.equal(await f.auth.token(), undefined);
    assert.match((await f.auth.problem())!, /github-app.pem/);
    assert.equal(f.calls.length, 0);
  });
}

test('token uses required headers and reuses the cache until less than ten minutes remain', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.auth.token(), 'synthetic-token-1');
  const { url, init } = f.calls[0]!;
  assert.equal(url, 'https://api.github.com/app/installations/456/access_tokens');
  assert.equal(init.method, 'POST');
  assert.equal(init.body, '{}');
  assert.equal(init.redirect, 'error');
  assert.deepEqual(init.headers, {
    Authorization: `Bearer ${appJwt('123', pem, start)}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  });
  assert.ok(init.signal instanceof AbortSignal);
  f.clock(start + 49 * minute);
  assert.equal(await f.auth.token(), 'synthetic-token-1');
  f.clock(start + 50 * minute);
  assert.equal(await f.auth.token(), 'synthetic-token-1');
  f.clock(start + 50 * minute + 1);
  assert.equal(await f.auth.token(), 'synthetic-token-2');
  assert.equal(f.calls.length, 2);
  f.auth.forget();
  assert.equal(await f.auth.token(), 'synthetic-token-3');
  assert.equal(await f.auth.problem(), undefined);
});

test('expiry comes from expires_at and configuration is reread on refresh', async (t) => {
  const f = await fixture(t);
  f.respond(async () =>
    Response.json({ token: 'short-lived', expires_at: new Date(start + 20 * minute).toISOString() }),
  );
  assert.equal(await f.auth.token(), 'short-lived');
  f.clock(start + 9 * minute);
  assert.equal(await f.auth.token(), 'short-lived');
  assert.equal(f.calls.length, 1);
  await writeFile(f.files.config, JSON.stringify({ appId: '124', installationId: '457' }));
  f.clock(start + 11 * minute);
  assert.equal(await f.auth.token(), 'short-lived');
  assert.equal(f.calls[1]!.url, 'https://api.github.com/app/installations/457/access_tokens');
  assert.equal(
    new Headers(f.calls[1]!.init.headers).get('Authorization'),
    `Bearer ${appJwt('124', pem, start + 11 * minute)}`,
  );
});

test('discovers and caches installation id, scoped to the repository', async (t) => {
  const f = await fixture(t, { appId: '123' });
  f.respond(async (url) =>
    url.endsWith('/installation')
      ? Response.json({ id: 789 })
      : Response.json({ token: 'discovered-token', expires_at: new Date(start + 120 * minute).toISOString() }),
  );
  assert.equal(await f.auth.token(), 'discovered-token');
  assert.equal(f.calls[0]!.url, 'https://api.github.com/repos/o/r/installation');
  assert.equal(f.calls[0]!.init.method, 'GET');
  assert.equal(f.calls[1]!.url, 'https://api.github.com/app/installations/789/access_tokens');
  f.auth.forget();
  await f.auth.token();
  assert.equal(f.calls.length, 3);
  f.repository('o/another');
  await f.auth.token();
  assert.equal(f.calls[3]!.url, 'https://api.github.com/repos/o/another/installation');
});

test('installation 404 reports the validated repository', async (t) => {
  const f = await fixture(t, { appId: '123' });
  f.respond(async () => new Response(pem, { status: 404 }));
  assert.equal(await f.auth.token(), undefined);
  assert.equal(await f.auth.problem(), 'The GitHub App is not installed on o/r');
});

test('invalid repositories cannot reach fetch', async (t) => {
  const f = await fixture(t, { appId: '123' });
  for (const repository of [
    undefined,
    'o/.',
    'o/..',
    '../r',
    'o/r/extra',
    'o/r?x=1',
    '-o/r',
    `${'a'.repeat(40)}/r`,
    `o/${'r'.repeat(101)}`,
  ]) {
    f.repository(repository);
    assert.equal(await f.auth.token(), undefined);
    assert.equal(await f.auth.problem(), 'A valid GitHub repository is required');
  }
  assert.equal(f.calls.length, 0);
});

for (const status of [401, 403]) {
  test(`${status} forgets a still-valid token without exposing echoed credentials`, async (t) => {
    const f = await fixture(t);
    const token = await f.auth.token();
    f.clock(start + 51 * minute);
    const jwt = appJwt('123', pem, start + 51 * minute);
    f.respond(async () => new Response(`${pem}\n${jwt}\n${token}`, { status }));
    assert.equal(await f.auth.token(), undefined);
    const problem = await f.auth.problem();
    assert.equal(problem, 'GitHub rejected the App key (wrong App ID or key)');
    for (const secret of [pem, jwt, token!]) assert.equal(problem!.includes(secret), false);
    f.clock(start + minute);
    f.respond(async () => {
      throw new Error(`${pem}\n${jwt}\n${token}`);
    });
    assert.equal(await f.auth.token(), undefined);
    assert.equal(await f.auth.problem(), 'Could not reach GitHub');
    assert.equal(f.calls.length, 3);
  });
}

test('network failure retains only an unexpired cached token', async (t) => {
  const f = await fixture(t);
  const token = await f.auth.token();
  f.respond(async () => {
    throw new Error(`${pem} ${token}`);
  });
  f.clock(start + 51 * minute);
  assert.equal(await f.auth.token(), token);
  assert.equal(await f.auth.problem(), 'Could not reach GitHub');
  f.clock(start + 60 * minute);
  assert.equal(await f.auth.token(), undefined);
  assert.equal(await f.auth.problem(), 'Could not reach GitHub');
});

test('invalid token responses never leak their payload', async (t) => {
  const f = await fixture(t);
  for (const payload of [
    { token: pem, expires_at: 'invalid' },
    { token: 'expired', expires_at: new Date(start).toISOString() },
    { expires_at: new Date(start + minute).toISOString() },
  ]) {
    f.respond(async () => Response.json(payload));
    assert.equal(await f.auth.token(), undefined);
    assert.equal(await f.auth.problem(), 'Invalid GitHub App response');
  }
});

test('botLogin uses GET /app with the JWT and caches the login', async (t) => {
  const f = await fixture(t);
  f.respond(async () => Response.json({ slug: 'pugport-maintainer' }));
  assert.equal(await f.auth.botLogin(), 'pugport-maintainer[bot]');
  assert.equal(await f.auth.botLogin(), 'pugport-maintainer[bot]');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.url, 'https://api.github.com/app');
  assert.equal(f.calls[0]!.init.method, 'GET');
  assert.equal(new Headers(f.calls[0]!.init.headers).get('Authorization'), `Bearer ${appJwt('123', pem, start)}`);
});

test('caller abort is combined with the timeout signal and does not expose its reason', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  f.respond(async (_url, init) => {
    assert.notEqual(init.signal, controller.signal);
    return new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      controller.abort(new Error(pem));
    });
  });
  assert.equal(await f.auth.token(controller.signal), undefined);
  assert.equal(f.calls[0]!.init.signal!.aborted, true);
  assert.equal(await f.auth.problem(), 'Could not reach GitHub');
  assert.equal(await f.auth.token(controller.signal), undefined);
  assert.equal(f.calls.length, 1);
});

test('file validation recovers after correction without a network request', async (t) => {
  const f = await fixture(t, { appId: 'bad' });
  assert.match((await f.auth.problem())!, /github-app.json/);
  await writeFile(f.files.config, JSON.stringify({ appId: '123', installationId: '456' }));
  assert.equal(await f.auth.problem(), undefined);
  await writeFile(f.files.key, privateKey.export({ type: 'pkcs1', format: 'pem' }));
  assert.equal(await f.auth.problem(), undefined);
  assert.equal(f.calls.length, 0);
});

test('RS256 rejects an EC private key with a safe error', () => {
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
  const ecPem = key.export({ type: 'pkcs8', format: 'pem' }).toString();
  assert.throws(() => appJwt('123', ecPem), { message: 'github-app.pem must contain a valid RSA private key' });
});

test('network fallback cannot return a token from a different App or installation', async (t) => {
  for (const config of [
    { appId: '124', installationId: '456' },
    { appId: '123', installationId: '457' },
  ]) {
    const f = await fixture(t);
    await f.auth.token();
    f.clock(start + 51 * minute);
    await writeFile(f.files.config, JSON.stringify(config));
    f.respond(async () => {
      throw new Error('offline');
    });
    assert.equal(await f.auth.token(), undefined);
    assert.equal(await f.auth.problem(), 'Could not reach GitHub');
  }
});

test('15 second timeout aborts fetch without a real timer or network', async (t) => {
  const f = await fixture(t);
  const timeout = new AbortController();
  const mock = t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    assert.equal(milliseconds, 15_000);
    return timeout.signal;
  });
  f.respond(
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        timeout.abort(new Error(pem));
      }),
  );
  assert.equal(await f.auth.token(), undefined);
  assert.equal(await f.auth.problem(), 'Could not reach GitHub');
  assert.equal(mock.mock.callCount(), 1);
});

test('network failure while reading the response body retains a valid token', async (t) => {
  const f = await fixture(t);
  const token = await f.auth.token();
  f.clock(start + 51 * minute);
  f.respond(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error(`${pem} ${token}`));
          },
        }),
      ),
  );
  assert.equal(await f.auth.token(), token);
  assert.equal(await f.auth.problem(), 'Could not reach GitHub');
});
