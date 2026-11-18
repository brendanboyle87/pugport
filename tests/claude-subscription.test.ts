import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { test, type TestContext } from 'node:test';
import { readClaudeSubscription, type ClaudeSubscriptionDependencies } from '../src/server/claude-subscription.ts';
import type { RuntimeTarget } from '../src/shared/types.ts';

const target: RuntimeTarget = {
  id: 'claude-native',
  provider: 'claude',
  label: 'Claude',
  environment: 'native',
  command: 'fixture-claude',
  enabled: true,
};
const now = Date.parse('2026-10-05T16:00:00.000Z');
const directory = resolve(tmpdir(), 'pugport-claude-subscription-fixture-not-read');
const auth = {
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'fixture@example.com',
  orgId: 'fixture-organization',
  configDirectory: directory,
  subscriptionType: 'pro',
};
const nativeToken = {
  accessToken: 'fixture-access-token-never-real',
  expiresAt: now + 3600000,
  scopes: ['user:profile', 'user:inference'],
};
const profile = {
  account: { email: 'fixture@example.com' },
  organization: {
    uuid: 'fixture-organization',
    organization_type: 'claude_max',
    rate_limit_tier: 'default_claude_max_20x',
  },
};
function dependencies(overrides: Partial<ClaudeSubscriptionDependencies> = {}): ClaudeSubscriptionDependencies {
  return {
    readCredentials: async () => JSON.stringify({ claudeAiOauth: nativeToken }),
    fetch: async () => Response.json(profile),
    now: () => now,
    timeoutMs: 1000,
    ...overrides,
  };
}

test('fresh account profile replaces stale Pro with verified Max 20x without refreshing credentials', async () => {
  let reads = 0;
  let requests = 0;
  const result = await readClaudeSubscription(
    target,
    auth,
    dependencies({
      readCredentials: async (path, signal) => {
        reads++;
        assert.equal(path, join(directory, '.credentials.json'));
        assert.equal(signal.aborted, false);
        return JSON.stringify({ claudeAiOauth: nativeToken });
      },
      fetch: async (url, options) => {
        requests++;
        assert.equal(url, 'https://api.anthropic.com/api/oauth/profile');
        assert.equal(options?.method, 'GET');
        assert.equal(options?.redirect, 'error');
        assert.equal(new Headers(options?.headers).get('Authorization'), `Bearer ${nativeToken.accessToken}`);
        assert.equal(new Headers(options?.headers).get('Cache-Control'), 'no-cache');
        return Response.json(profile);
      },
    }),
  );
  assert.deepEqual(result, {
    subscription: { label: 'Ultra', source: 'Claude 官方账户资料', observedAt: new Date(now).toISOString() },
  });
  assert.equal(reads, 1);
  assert.equal(requests, 1);
  assert.equal(auth.subscriptionType, 'pro');
});

test('profile names and Max 5x are supported without inferring multiplier from usage', async () => {
  for (const [fields, label] of [
    [{ organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_5x' }, 'Max'],
    [{ organization_type: 'claude_max', plan_display_name: 'Max (20x)' }, 'Ultra'],
    [{ organization_type: 'claude_ultra', plan_display_name: 'Claude Ultra' }, 'Ultra'],
    [{ organization_type: 'claude_max' }, 'Max'],
    [{ organization_type: 'claude_team', plan_display_name: 'Claude Team Premium' }, 'Team Premium'],
    [{ organization_type: 'claude_pro', plan_display_name: '<img src=x>' }, 'Pro'],
    [{ organization_type: 'claude_pro', plan_display_name: 'Max (20x)' }, 'Pro'],
  ] as const) {
    const result = await readClaudeSubscription(
      target,
      auth,
      dependencies({
        fetch: async () => Response.json({ ...profile, organization: { uuid: auth.orgId, ...fields } }),
      }),
    );
    assert.equal(result.subscription?.label, label);
  }
});

test('unsupported targets and unverified identities never read credentials or make requests', async () => {
  const deps = dependencies({
    readCredentials: async () => assert.fail('must not read'),
    fetch: async () => assert.fail('must not fetch'),
  });
  for (const row of [
    { ...target, provider: 'codex' as const },
    { ...target, environment: 'wsl' as const },
    { ...target, gateway: 'api' as const },
  ])
    assert.equal((await readClaudeSubscription(row, auth, deps)).subscription, undefined);
  for (const row of [
    { ...auth, loggedIn: false },
    { ...auth, authMethod: 'api_key' },
    { ...auth, apiProvider: 'gateway' },
    { ...auth, email: '' },
    { ...auth, orgId: '' },
    { ...auth, configDirectory: undefined },
    { ...auth, configDirectory: 'relative-profile' },
  ])
    assert.equal((await readClaudeSubscription(target, row, deps)).subscription, undefined);
});

test('account email and organization must both match the native CLI identity', async () => {
  for (const row of [
    { ...profile, account: { email: 'other@example.com' } },
    { ...profile, organization: { ...profile.organization, uuid: 'other-organization' } },
    { organization: profile.organization },
  ]) {
    const result = await readClaudeSubscription(target, auth, dependencies({ fetch: async () => Response.json(row) }));
    assert.equal(result.subscription, undefined);
    assert.match(result.note!, /不一致/);
  }
  const result = await readClaudeSubscription(target, { ...auth, email: ' Fixture@Example.com ' }, dependencies());
  assert.equal(result.subscription?.label, 'Ultra');
});

test('unavailable, expired, scopeless and oversized credentials do not trigger network access', async () => {
  for (const value of [
    '{}',
    'not json',
    JSON.stringify({ claudeAiOauth: { ...nativeToken, accessToken: '' } }),
    JSON.stringify({ claudeAiOauth: { ...nativeToken, expiresAt: now } }),
    JSON.stringify({ claudeAiOauth: { ...nativeToken, scopes: ['user:inference'] } }),
    JSON.stringify({ claudeAiOauth: { ...nativeToken, accessToken: 'line\nbreak' } }),
    ' '.repeat(256 * 1024 + 1),
  ]) {
    const result = await readClaudeSubscription(
      target,
      auth,
      dependencies({
        readCredentials: async () => value,
        fetch: async () => assert.fail('must not fetch'),
      }),
    );
    assert.equal(result.subscription, undefined);
    assert.ok(result.note);
  }
  const missing = await readClaudeSubscription(
    target,
    auth,
    dependencies({
      readCredentials: async () => {
        throw new Error('credential-manager-only');
      },
      fetch: async () => assert.fail('must not fetch'),
    }),
  );
  assert.match(missing.note!, /系统凭据库/);
});

test('HTTP errors, redirects, network diagnostics and bad profile bodies never expose credentials', async () => {
  for (const fetch of [
    async () => new Response(nativeToken.accessToken, { status: 401 }),
    async () => new Response(nativeToken.accessToken, { status: 403 }),
    async () => new Response(nativeToken.accessToken, { status: 429 }),
    async () =>
      new Response(nativeToken.accessToken, { status: 302, headers: { Location: 'https://example.invalid' } }),
    async () => new Response(nativeToken.accessToken, { status: 200 }),
    async () => {
      throw new Error(`network Authorization: Bearer ${nativeToken.accessToken}`);
    },
  ]) {
    const result = await readClaudeSubscription(target, auth, dependencies({ fetch }));
    assert.equal(result.subscription, undefined);
    assert.ok(result.note);
    assert.equal(JSON.stringify(result).includes(nativeToken.accessToken), false);
  }
});

test('oversized streamed and declared profile bodies are rejected and cancelled', async () => {
  for (const declared of [false, true]) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(256 * 1024 + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const result = await readClaudeSubscription(
      target,
      auth,
      dependencies({
        fetch: async () =>
          new Response(body, { headers: declared ? { 'content-length': String(256 * 1024 + 1) } : {} }),
      }),
    );
    assert.equal(result.subscription, undefined);
    assert.equal(cancelled, true);
  }
});

test('ten-second overall deadline also bounds stalled credential reads without a late network request', async () => {
  let release!: (value: string) => void;
  let signal: AbortSignal | undefined;
  let requests = 0;
  const result = await readClaudeSubscription(
    target,
    auth,
    dependencies({
      timeoutMs: 15,
      readCredentials: async (_path, currentSignal) => {
        signal = currentSignal;
        return new Promise<string>((resolve) => {
          release = resolve;
        });
      },
      fetch: async () => {
        requests++;
        return Response.json(profile);
      },
    }),
  );
  assert.equal(result.subscription, undefined);
  assert.equal(signal?.aborted, true);
  release(JSON.stringify({ claudeAiOauth: nativeToken }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 0);
});

test('deadline aborts a stalled profile body and releases its stream', async () => {
  let cancelled = false;
  const result = await readClaudeSubscription(
    target,
    auth,
    dependencies({
      timeoutMs: 15,
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        ),
    }),
  );
  assert.equal(result.subscription, undefined);
  assert.equal(cancelled, true);
});

async function fixtureDirectory(t: TestContext): Promise<string> {
  // macOS exposes its temporary directory through /var -> /private/var. The real
  // credential reader deliberately rejects aliased ancestors, so create the test
  // profile below the physical root rather than weakening that production check.
  const temporary = await realpath(tmpdir());
  const path = await mkdtemp(join(temporary, 'pugport-claude-subscription-'));
  t.after(async () => {
    const full = resolve(path);
    assert.ok(full.startsWith(temporary + sep));
    assert.ok(basename(full).startsWith('pugport-claude-subscription-'));
    await rm(full, { force: true, recursive: true });
  });
  return path;
}

test('default credential reader uses only the explicit temporary CLI profile', async (t) => {
  const path = await fixtureDirectory(t);
  const file = join(path, '.credentials.json');
  await writeFile(file, JSON.stringify({ claudeAiOauth: nativeToken }));
  const deps = dependencies();
  const { readCredentials: _read, ...safeDependencies } = deps;
  // Windows hosted runners can supply TEMP through RUNNER~1. Both that explicit
  // spelling and the native resolver's long spelling identify the same profile.
  const directories = new Set([path, await realpath(path)]);
  if (process.platform === 'win32') directories.add(join(tmpdir(), basename(path)));
  for (const configDirectory of directories) {
    const result = await readClaudeSubscription(target, { ...auth, configDirectory }, safeDependencies);
    assert.equal(result.subscription?.label, 'Ultra', result.note ?? 'the explicit profile must be readable');
  }
});

test('linked credential files are not followed into another profile', async (t) => {
  const path = await fixtureDirectory(t);
  const original = join(path, 'other-account.json');
  await writeFile(original, JSON.stringify({ claudeAiOauth: nativeToken }));
  try {
    await symlink(original, join(path, '.credentials.json'), 'file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('file symlink permission unavailable');
      return;
    }
    throw error;
  }
  const result = await readClaudeSubscription(
    target,
    { ...auth, configDirectory: path },
    {
      now: () => now,
      fetch: async () => assert.fail('must not fetch'),
    },
  );
  assert.equal(result.subscription, undefined);
});

test('linked configuration directories are rejected before credential lookup', async (t) => {
  const path = await fixtureDirectory(t);
  const original = join(path, 'original');
  const alias = join(path, 'alias');
  await mkdir(original);
  await writeFile(join(original, '.credentials.json'), JSON.stringify({ claudeAiOauth: nativeToken }));
  await symlink(original, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await readClaudeSubscription(
    target,
    { ...auth, configDirectory: alias },
    {
      now: () => now,
      fetch: async () => assert.fail('must not fetch'),
    },
  );
  assert.equal(result.subscription, undefined);
  assert.ok(result.note);
});

test('a linked ancestor cannot alias an otherwise ordinary configuration directory', async (t) => {
  const path = await fixtureDirectory(t);
  const original = join(path, 'original');
  const config = join(original, 'profile');
  const alias = join(path, 'alias');
  await mkdir(config, { recursive: true });
  await writeFile(join(config, '.credentials.json'), JSON.stringify({ claudeAiOauth: nativeToken }));
  await symlink(original, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await readClaudeSubscription(
    target,
    { ...auth, configDirectory: join(alias, 'profile') },
    {
      now: () => now,
      fetch: async () => assert.fail('must not fetch'),
    },
  );
  assert.equal(result.subscription, undefined);
  assert.ok(result.note);
});
