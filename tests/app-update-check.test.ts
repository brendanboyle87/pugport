import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { AppUpdateCheck } from '../src/server/app-update-check.ts';

function fixture(fetcher?: typeof fetch) {
  const db = new DatabaseSync(':memory:');
  const state = { now: 1000, enabled: true, calls: 0, changes: 0 };
  const check = new AppUpdateCheck(
    { db, enabled: () => state.enabled, changed: () => state.changes++ },
    {
      now: () => state.now,
      version: '0.0.34',
      mac: null,
      fetch: async (input, init) => {
        state.calls++;
        assert.equal(input, 'https://api.github.com/repos/pugport/pugport/releases/latest');
        assert.deepEqual(init?.headers, { Accept: 'application/vnd.github+json', 'User-Agent': 'PugPort' });
        assert.ok(init?.signal);
        assert.equal(init?.redirect, 'error');
        assert.equal(db.prepare('SELECT lastCheck FROM app_update_check').get()?.lastCheck, state.now);
        return fetcher
          ? fetcher(input, init)
          : Response.json({
              tag_name: 'v0.0.35',
              html_url: 'https://github.com/pugport/pugport/releases/tag/v0.0.35',
            });
      },
    },
  );
  return { db, state, check };
}

test('checks once a day, records before fetching, and persists the throttle across restart', async () => {
  const f = fixture();
  const pending = f.check.tick();
  assert.equal(f.check.tick(), undefined);
  await pending;
  assert.equal(f.check.update?.version, '0.0.35');
  assert.equal(f.state.changes, 1);
  f.state.now += 24 * 60 * 60_000 - 1;
  assert.equal(f.check.tick(), undefined);
  const restarted = new AppUpdateCheck(
    { db: f.db, enabled: () => true, changed: () => {} },
    {
      now: () => f.state.now,
      mac: null,
      fetch: async () => {
        throw new Error('unexpected request');
      },
    },
  );
  assert.equal(restarted.tick(), undefined);
  f.state.now++;
  await f.check.tick();
  assert.equal(f.state.calls, 2);
  f.db.close();
});

test('disabled checks do not fetch or record a check', () => {
  const f = fixture();
  f.state.enabled = false;
  assert.equal(f.check.tick(), undefined);
  assert.equal(f.state.calls, 0);
  assert.equal(f.db.prepare('SELECT lastCheck FROM app_update_check').get(), undefined);
  f.db.close();
});

test('404, network failure and malformed bodies stay silent and wait 24 hours', async () => {
  for (const fetcher of [
    async () => new Response('', { status: 404 }),
    async () => {
      throw new Error('offline');
    },
    async () => new Response('not json'),
    async () => Response.json(null),
    async () => Response.json({ tag_name: 123, html_url: [] }),
  ] as (typeof fetch)[]) {
    const f = fixture(fetcher);
    await f.check.tick();
    assert.equal(f.check.update, undefined);
    assert.equal(f.state.changes, 0);
    f.state.now += 24 * 60 * 60_000 - 1;
    assert.equal(f.check.tick(), undefined);
    assert.equal(f.state.calls, 1);
    f.db.close();
  }
});

test('accepts only newer plain numeric semver and the repository release URL', async () => {
  for (const [version, url, accepted] of [
    ['v0.0.35', 'https://github.com/pugport/pugport/releases/tag/v0.0.35', true],
    ['0.10.0', 'https://github.com/pugport/pugport/releases/tag/0.10.0', true],
    ['1.0.0', 'https://github.com/pugport/pugport/releases/tag/1.0.0', true],
    ['0.0.34', 'https://github.com/pugport/pugport/releases/tag/0.0.34', false],
    ['0.0.9', 'https://github.com/pugport/pugport/releases/tag/0.0.9', false],
    ['0.0.35-beta', 'https://github.com/pugport/pugport/releases/tag/0.0.35-beta', false],
    ['v0.0.35+build', 'https://github.com/pugport/pugport/releases/tag/x', false],
    ['v0.0.35', 'https://evil.example/pugport/pugport/releases/tag/x', false],
    ['v0.0.35', 'https://github.com/pugport/pugport/releases/../../evil', false],
    ['v0.0.35', 'https://github.com/pugport/pugport/releases-other/x', false],
  ] as const) {
    const f = fixture(async () => Response.json({ tag_name: version, html_url: url }));
    await f.check.tick();
    assert.equal(!!f.check.update, accepted, `${version} ${url}`);
    f.db.close();
  }
});

test('disabling while a request is in flight prevents publishing a notice', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture(async () => {
    await pending;
    return Response.json({ tag_name: '1.0.0', html_url: 'https://github.com/pugport/pugport/releases/tag/1.0.0' });
  });
  const checking = f.check.tick();
  f.state.enabled = false;
  release();
  await checking;
  assert.equal(f.check.update, undefined);
  assert.equal(f.state.changes, 0);
  f.db.close();
});
