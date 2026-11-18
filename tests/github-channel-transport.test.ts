import assert from 'node:assert/strict';
import test from 'node:test';
import { githubChannelTransport } from '../src/server/github-channel-transport.ts';
import type { Gh } from '../src/server/maintainer/gh.ts';

function fixture() {
  const calls: Array<{ identity: string; args: string[]; input?: string }> = [];
  let response =
    'HTTP/2.0 200 OK\r\nX-RateLimit-Remaining: 17\r\nX-RateLimit-Reset: 1800000000\r\nContent-Type: application/json\r\n\r\n{"id":42}';
  let code = 0;
  const fake = (identity: string): Gh => ({
    run: async (args, options) => {
      calls.push({ identity, args, input: options?.input });
      return { code, stdout: response, stderr: code ? 'synthetic HTTP error' : '' };
    },
    text: async () => {
      throw new Error('Unexpected text transport');
    },
    json: async () => {
      throw new Error('Unexpected JSON transport');
    },
  });
  return {
    calls,
    transport: githubChannelTransport(fake('owner'), fake('app')),
    respond: (value: string, exitCode = 0) => {
      response = value;
      code = exitCode;
    },
  };
}

test('GitHub channel transport parses included CRLF headers and defaults to owner identity', async () => {
  const f = fixture();
  const response = await f.transport('user');
  assert.deepEqual(response.data, { id: 42 });
  assert.equal(response.headers['x-ratelimit-remaining'], '17');
  assert.equal(response.headers['x-ratelimit-reset'], '1800000000');
  assert.equal(response.identity, 'owner');
  assert.equal(response.status, 200);
  assert.deepEqual(f.calls, [
    { identity: 'owner', args: ['api', '--include', '--method', 'GET', 'user'], input: undefined },
  ]);
});

test('GitHub channel receipt writes select App identity and pass JSON only through stdin', async () => {
  const f = fixture();
  const body = { body: 'Synthetic "quote"\n— PugPort' };
  await f.transport('repos/synthetic/project/issues/12/comments', { identity: 'app', method: 'POST', body });
  await f.transport('repos/synthetic/project/issues/comments/42', { identity: 'owner', method: 'PATCH', body });
  assert.deepEqual(
    f.calls.map((c) => c.identity),
    ['app', 'owner'],
  );
  assert.deepEqual(f.calls[0].args, [
    'api',
    '--include',
    '--method',
    'POST',
    'repos/synthetic/project/issues/12/comments',
    '--input',
    '-',
  ]);
  assert.equal(f.calls[0].input, JSON.stringify(body));
  assert.equal(f.calls[1].args[3], 'PATCH');
  assert.equal(f.calls[0].args.includes(body.body), false);
});

test('GitHub channel transport handles LF and empty responses and rejects missing headers', async () => {
  const f = fixture();
  f.respond('HTTP/2.0 204 No Content\nX-RateLimit-Remaining: 0\n\n');
  assert.deepEqual(await f.transport('repos/synthetic/project'), {
    status: 204,
    data: null,
    headers: { 'x-ratelimit-remaining': '0' },
    identity: 'owner',
  });
  f.respond('{"id":42}');
  await assert.rejects(f.transport('user'), /Missing GitHub response headers/);
  f.respond('HTTP/2.0 200 OK\n\nnot-json');
  await assert.rejects(f.transport('user'), SyntaxError);
});

test('GitHub channel transport rejects unrelated paths before calling either fake Gh', async () => {
  const f = fixture();
  await assert.rejects(f.transport('https://example.invalid/repos/a/b'), /Invalid GitHub channel path/);
  await assert.rejects(f.transport('orgs/synthetic'), /Invalid GitHub channel path/);
  await assert.rejects(f.transport('userXXX'), /Invalid GitHub channel path/);
  assert.equal(f.calls.length, 0);
});

test('GitHub HTTP errors retain rate headers even when gh exits nonzero', async () => {
  const f = fixture();
  f.respond(
    'HTTP/2.0 429 Too Many Requests\r\nX-RateLimit-Remaining: 0\r\nRetry-After: 120\r\n\r\n{"message":"synthetic rate limit"}',
    1,
  );
  const limited = await f.transport('user');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['retry-after'], '120');
  assert.equal(limited.headers['x-ratelimit-remaining'], '0');
  assert.deepEqual(limited.data, { message: 'synthetic rate limit' });
  f.respond('HTTP/2.0 404 Not Found\nX-RateLimit-Remaining: 17\n\n{"message":"synthetic missing"}', 1);
  const missing = await f.transport('repos/synthetic/project');
  assert.equal(missing.status, 404);
  assert.equal(missing.headers['x-ratelimit-remaining'], '17');
});

test('transport rejects invalid HTTP status lines and unexplained CLI failure', async () => {
  const f = fixture();
  f.respond('not-http\nX-RateLimit-Remaining: 1\n\n{}', 1);
  await assert.rejects(f.transport('user'), /Invalid GitHub HTTP status/);
  f.respond('HTTP/2.0 200 OK\n\n{}', 1);
  await assert.rejects(f.transport('user'), /CLI failed/);
});
