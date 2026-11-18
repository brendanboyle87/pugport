import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  attachSessionHeader,
  backendRequest,
  setSessionOwner,
  setSessionToken,
} from '../src/electron/session-header.ts';

test('only owned same-origin requests receive the current token', async () => {
  let listener: Function = () => {};
  let filter: unknown;
  const session = {
    webRequest: {
      onBeforeSendHeaders(value: unknown, callback: Function) {
        filter = value;
        listener = callback;
      },
    },
  };
  let token: string | undefined = 'first';
  const origin = 'http://127.0.0.1:4317';
  attachSessionHeader(
    session,
    origin,
    () => token,
    new Set([1]),
    () => 'owner',
  );
  assert.deepEqual(filter, { urls: [origin + '/*'] });
  const run = (details: Record<string, unknown>) => {
    let calls = 0;
    let result: any;
    listener(
      {
        webContentsId: 1,
        initiatorOrigin: origin,
        url: origin + '/api/state',
        requestHeaders: { Accept: 'x', 'X-Agent-Token': 'stale', 'X-Pugport-Owner': 'stale-owner' },
        ...details,
      },
      (value: unknown) => {
        calls++;
        result = value;
      },
    );
    assert.equal(calls, 1);
    assert.deepEqual(Object.keys(result), ['requestHeaders']);
    return result.requestHeaders;
  };
  assert.deepEqual(run({}), { Accept: 'x', 'x-agent-token': 'first', 'x-pugport-owner': 'owner' });
  for (const details of [
    { webContentsId: 2 },
    { initiatorOrigin: 'https://evil.test' },
    { initiatorOrigin: undefined },
    { url: 'http://127.0.0.1:9222/x' },
  ])
    assert.equal(run(details)['X-Agent-Token'], 'stale');
  token = undefined;
  assert.equal(run({})['X-Agent-Token'], 'stale');
  token = 'second';
  assert.equal(run({})['x-agent-token'], 'second');
  setSessionToken(() => token);
  setSessionOwner(() => 'owner');
  let init: RequestInit | undefined;
  await backendRequest(origin, { headers: { Accept: 'x' } }, async (_url, options) => {
    init = options;
    return new Response();
  });
  assert.deepEqual(init?.headers, { Accept: 'x', 'x-agent-token': 'second', 'x-pugport-owner': 'owner' });
  setSessionToken(() => undefined);
  setSessionOwner(() => undefined);
});
