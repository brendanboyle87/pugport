import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publishSessionToken } from '../src/server/platform/desktop-endpoint.ts';
import { PugPortClient } from '../src/cli/client.ts';

test('executor marker is sent on event streams', async (t) => {
  t.after(publishSessionToken('synthetic', 1));
  const originalFetch = globalThis.fetch;
  const originalFlag = process.env.PUGPORT_EXECUTOR;
  process.env.PUGPORT_EXECUTOR = '1';
  let marker: string | null = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/api/health')) {
      assert.equal(new Headers(init?.headers).get('x-pugport-executor'), '1');
      return Response.json({ ok: true });
    }
    marker = new Headers(init?.headers).get('x-pugport-executor');
    return new Response('');
  };
  try {
    assert.equal(await new PugPortClient(1).health(), true);
    for await (const _event of new PugPortClient(1).events(new AbortController().signal)) {
    }
    assert.equal(marker, '1');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalFlag === undefined) delete process.env.PUGPORT_EXECUTOR;
    else process.env.PUGPORT_EXECUTOR = originalFlag;
  }
});
