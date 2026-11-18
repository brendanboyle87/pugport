import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OwnedBackend } from '../src/electron/backend.ts';
import {
  attachSessionHeader,
  backendRequest,
  setSessionOwner,
  setSessionToken,
} from '../src/electron/session-header.ts';

test('shell injects owner into same-origin requests and backend requests', async () => {
  let listener: any;
  attachSessionHeader(
    {
      webRequest: {
        onBeforeSendHeaders(_filter: any, callback: any) {
          listener = callback;
        },
      },
    },
    'http://127.0.0.1:1',
    () => 'token',
    new Set([1]),
    () => 'owner',
  );
  let result: any;
  listener(
    {
      webContentsId: 1,
      initiatorOrigin: 'http://127.0.0.1:1',
      url: 'http://127.0.0.1:1/api/settings',
      requestHeaders: { 'X-PUGPORT-OWNER': 'old' },
    },
    (value: any) => {
      result = value;
    },
  );
  assert.equal(result.requestHeaders['x-pugport-owner'], 'owner');
  assert.equal(result.requestHeaders['X-PUGPORT-OWNER'], undefined);
  setSessionToken(() => 'token');
  setSessionOwner(() => 'owner');
  await backendRequest('http://127.0.0.1:1', {}, async (_url, init) => {
    assert.equal(new Headers(init?.headers).get('x-pugport-owner'), 'owner');
    return new Response();
  });
  assert.equal(typeof Object.getOwnPropertyDescriptor(OwnedBackend.prototype, 'owner')?.get, 'function');
});
