import assert from 'node:assert/strict';
import { type ChildProcess, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import {
  createNativeAccount,
  defaultNativeAccountFingerprint,
  launchAccountLogin,
  nativeAccountCursorLogin,
  nativeAccountEnvironment,
  nativeAccountFingerprint,
} from '../src/server/native-accounts.ts';
import { claudeAccountFingerprint, claudeAdapter } from '../src/server/adapters/claude.ts';
import { createCursorAdapter, cursorAccountFingerprint, cursorAdapter } from '../src/server/adapters/cursor.ts';
import { captureTarget } from '../src/server/adapters/process.ts';
import { readClaudeSubscription } from '../src/server/claude-subscription.ts';
import {
  applyCursorEditorUsage,
  cursorDashboardSource,
  cursorEditorUsage,
  readCursorCliSession,
} from '../src/server/cursor-usage.ts';
import { Controller } from '../src/server/controller.ts';
import { Store } from '../src/server/store.ts';
import { Workspace } from '../src/server/workspace.ts';
import { TaskJudge } from '../src/server/task-judgment.ts';
import type { ExecuteContext, MessageInput, RuntimeSnapshot, RuntimeTarget, Workflow } from '../src/shared/types.ts';

// Synthetic data and temporary folders only: no CLI login, model call or network request happens here.
const windows = process.platform === 'win32';
const defaults = mkdtempSync(join(tmpdir(), 'pugport-claude-defaults-'));
const originalConfig = process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CONFIG_DIR = join(defaults, 'claude');
after(() => {
  if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalConfig;
  assert.ok(realpathSync.native(defaults).startsWith(realpathSync.native(tmpdir()) + sep));
  rmSync(defaults, { recursive: true, force: true });
});
const claudeBase: RuntimeTarget = {
  id: 'claude-native',
  provider: 'claude',
  label: 'Claude',
  command: process.execPath,
  environment: 'native',
  enabled: true,
};
const cursorBase: RuntimeTarget = { ...claudeBase, id: 'cursor-native', provider: 'cursor', label: 'Cursor' };
const status = (email: string, orgId: string) => ({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email,
  orgId,
  subscriptionType: 'max',
});
const jwt = (claims: Record<string, unknown>) =>
  [{ alg: 'fixture-only' }, claims, 'fixture-not-a-signature']
    .map((part) => Buffer.from(typeof part === 'string' ? part : JSON.stringify(part)).toString('base64url'))
    .join('.');

function directory(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'pugport-claude-cursor-'));
  t.after(() => {
    const absolute = resolve(root);
    assert.ok(realpathSync.native(absolute).startsWith(realpathSync.native(tmpdir()) + sep));
    assert.ok(basename(absolute).startsWith('pugport-claude-cursor-'));
    rmSync(absolute, { recursive: true, force: true });
  });
  return realpathSync.native(root);
}
function write(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}
function claudeProfile(home: string, email: string, organization: string, extra: Record<string, unknown> = {}) {
  write(join(home, '.credentials.json'), { claudeAiOauth: { accessToken: 'fixture-access-token' } });
  write(join(home, '.claude.json'), {
    numStartups: 3,
    oauthAccount: { accountUuid: 'fixture-account', emailAddress: email, organizationUuid: organization },
    ...extra,
  });
}
function cursorProfile(home: string, authInfo: Record<string, unknown>, token = 'fixture-access-token') {
  write(join(home, 'AppData', 'Roaming', 'Cursor', 'auth.json'), { accessToken: token, refreshToken: 'fixture' });
  write(join(home, '.cursor', 'cli-config.json'), { version: 1, authInfo });
}
function decodedLoginScript(args: string[]) {
  const helper = Buffer.from(args.at(-1)!, 'base64').toString('utf16le');
  const encoded = /'-EncodedCommand', '([A-Za-z0-9+/=]+)'/.exec(helper)![1]!;
  return Buffer.from(encoded, 'base64').toString('utf16le');
}

test('Claude accounts get distinct empty folders, no extra arguments and only their own config folder', async (t) => {
  const root = directory(t);
  const first = await createNativeAccount(root, claudeBase, 'Claude B');
  const second = await createNativeAccount(root, claudeBase, 'Claude C');
  assert.notEqual(first.accountHome, second.accountHome);
  for (const target of [first, second]) {
    assert.equal(target.id, `claude-account-${target.accountId}`);
    assert.equal(target.accountHome, join(root, 'accounts', target.accountId!));
    assert.deepEqual(target.args, []);
    assert.equal(target.enabled, false);
    assert.deepEqual(readdirSync(target.accountHome!), []);
    assert.equal(nativeAccountFingerprint(target), undefined);
  }
  const source = {
    Path: 'system-path',
    USERPROFILE: 'system-user',
    APPDATA: 'system-roaming',
    CLAUDE_CONFIG_DIR: 'default-claude',
    CLAUDE_CODE_OAUTH_TOKEN: 'fixture-token',
    CLAUDE_CODE_GIT_BASH_PATH: 'C:\\fixture\\bash.exe',
    ANTHROPIC_API_KEY: 'fixture-key',
    anthropic_base_url: 'fixture-endpoint',
    CURSOR_API_KEY: 'fixture-key',
    OPENAI_API_KEY: 'fixture-key',
    GROK_HOME: 'default-grok',
  };
  const before = { ...source };
  assert.deepEqual(nativeAccountEnvironment(first, source), {
    Path: 'system-path',
    USERPROFILE: 'system-user',
    APPDATA: 'system-roaming',
    CLAUDE_CODE_GIT_BASH_PATH: 'C:\\fixture\\bash.exe',
    CLAUDE_CONFIG_DIR: first.accountHome,
  });
  assert.deepEqual(source, before);
  assert.deepEqual(nativeAccountEnvironment(claudeBase, source), before, 'the existing Claude login is unchanged');
  assert.throws(
    () => nativeAccountEnvironment({ ...first, id: `codex-account-${first.accountId}` }, source),
    /目录无效/,
  );
  assert.equal(defaultNativeAccountFingerprint(claudeBase, { USERPROFILE: root, HOME: root }), undefined);
});

test('a Claude account identity comes from its own record and matches the CLI auth status fingerprint', async (t) => {
  const root = directory(t);
  const first = await createNativeAccount(root, claudeBase, 'Claude B');
  const second = await createNativeAccount(root, claudeBase, 'Claude C');
  // A large project history must not hide the account record (the credential limit is 256 KB).
  const projects = { history: 'x'.repeat(400 * 1024) };
  claudeProfile(first.accountHome!, ' One@Example.Invalid ', 'org-fixture-1', { projects });
  const expected = claudeAccountFingerprint(status('one@example.invalid', 'org-fixture-1'));
  assert.match(expected!, /^[0-9a-f]{64}$/);
  assert.equal(nativeAccountFingerprint(first), expected);
  claudeProfile(second.accountHome!, 'one@example.invalid', 'org-fixture-1');
  assert.equal(nativeAccountFingerprint(second), expected, 'the same account in two folders is one identity');
  claudeProfile(second.accountHome!, 'one@example.invalid', 'org-fixture-2');
  assert.notEqual(nativeAccountFingerprint(second), expected, 'another organization is another quota pool');
  const record = readFileSync(join(first.accountHome!, '.claude.json'), 'utf8');
  for (const change of [
    () => claudeProfile(second.accountHome!, 'one@example.invalid', 'org-1', { primaryApiKey: 'fixture-api-key' }),
    () => write(join(second.accountHome!, '.claude.json'), { numStartups: 1 }),
    () => write(join(second.accountHome!, '.claude.json'), { oauthAccount: { emailAddress: 'not-an-address' } }),
    () => write(join(second.accountHome!, '.claude.json'), '{broken'),
  ]) {
    change();
    assert.equal(nativeAccountFingerprint(second), undefined);
  }
  if (process.platform !== 'darwin') {
    claudeProfile(second.accountHome!, 'one@example.invalid', 'org-fixture-1');
    unlinkSync(join(second.accountHome!, '.credentials.json'));
    assert.equal(nativeAccountFingerprint(second), undefined, 'a signed-out folder has no identity');
  }
  claudeProfile(second.accountHome!, 'one@example.invalid', 'org-fixture-1');
  const external = join(root, 'external-profile.json');
  writeFileSync(external, readFileSync(join(second.accountHome!, '.claude.json')));
  unlinkSync(join(second.accountHome!, '.claude.json'));
  linkSync(external, join(second.accountHome!, '.claude.json'));
  assert.equal(nativeAccountFingerprint(second), undefined, 'a hard-linked record is refused');
  assert.equal(readFileSync(join(first.accountHome!, '.claude.json'), 'utf8'), record, 'reading never writes');
});

test('Claude plan reading follows the account folder its CLI reports', async (t) => {
  const root = directory(t);
  const account = await createNativeAccount(root, claudeBase, 'Claude B');
  const paths: string[] = [];
  const result = await readClaudeSubscription(
    account,
    { ...status('b@example.invalid', 'org-b'), configDirectory: account.accountHome },
    {
      readCredentials: async (path) => {
        paths.push(path);
        return JSON.stringify({
          claudeAiOauth: { accessToken: 'fixture-access', expiresAt: Date.now() + 3_600_000, scopes: ['user:profile'] },
        });
      },
      fetch: async () =>
        new Response(
          JSON.stringify({
            account: { email: 'b@example.invalid' },
            organization: { uuid: 'org-b', organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    },
  );
  assert.deepEqual(paths, [join(account.accountHome!, '.credentials.json')]);
  assert.equal(result.subscription?.label, 'Ultra');
});

test('a process started for a managed account sees only its own folders', async (t) => {
  const root = directory(t);
  const script =
    'const e=process.env;console.log(JSON.stringify({claude:e.CLAUDE_CONFIG_DIR,cursor:e.CURSOR_CONFIG_DIR,appData:e.APPDATA,store:e.AGENT_CLI_CREDENTIAL_STORE,key:e.ANTHROPIC_API_KEY??null,cursorKey:e.CURSOR_API_KEY??null}))';
  const env = { ...process.env, ANTHROPIC_API_KEY: 'fixture-key', CURSOR_API_KEY: 'fixture-key' };
  const claude = await createNativeAccount(root, claudeBase, 'Claude B');
  const seen = JSON.parse((await captureTarget(claude, ['-e', script], { env, timeoutMs: 60_000 })).stdout);
  assert.equal(seen.claude, claude.accountHome);
  assert.equal(seen.key, null);
  assert.equal(seen.cursorKey, null);
  if (!windows) return;
  const cursor = await createNativeAccount(root, cursorBase, 'Cursor B');
  const observed = JSON.parse((await captureTarget(cursor, ['-e', script], { env, timeoutMs: 60_000 })).stdout);
  assert.equal(observed.appData, join(cursor.accountHome!, 'AppData', 'Roaming'));
  assert.equal(observed.cursor, join(cursor.accountHome!, '.cursor'));
  assert.equal(observed.store, 'file');
  assert.equal(observed.claude, undefined);
  assert.equal(observed.cursorKey, null);
});

test('the automatic native Claude entry uses its saved login without inherited API or gateway credentials', async () => {
  const target = { ...claudeBase, commandDiscovery: 'auto' as const };
  const overrides = {
    ANTHROPIC_AUTH_TOKEN: 'fixture-gateway-token',
    ANTHROPIC_API_KEY: 'fixture-api-key',
    CLAUDE_CODE_OAUTH_TOKEN: 'fixture-other-account',
    anthropic_base_url: 'https://fixture-gateway.invalid',
    ANTHROPIC_CUSTOM_HEADERS: 'Authorization: fixture-credential',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_VERTEX: '1',
    CLAUDE_CODE_USE_FOUNDRY: '1',
    ANTHROPIC_PROFILE: 'other-profile',
    ANTHROPIC_FEDERATION_RULE_ID: 'other-rule',
    ANTHROPIC_ORGANIZATION_ID: 'other-organization',
  };
  const source = {
    ...process.env,
    ...overrides,
    CLAUDE_CONFIG_DIR: join(defaults, 'claude'),
    CLAUDE_CODE_GIT_BASH_PATH: 'fixture-bash',
    ANTHROPIC_MODEL: 'fixture-model',
    OPENAI_API_KEY: 'fixture-other-provider',
  };
  const before = { ...source };
  const env = nativeAccountEnvironment(target, source);
  for (const key of Object.keys(overrides)) assert.equal(env[key], undefined, key);
  for (const key of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_GIT_BASH_PATH', 'ANTHROPIC_MODEL', 'OPENAI_API_KEY'])
    assert.equal(env[key], source[key as keyof typeof source], key);
  assert.deepEqual(source, before, 'the parent process environment is never changed');

  // Verify the actual process path used by both discovery and execution; only booleans leave the fixture.
  const script = `console.log(JSON.stringify({overrides:${JSON.stringify(Object.keys(overrides))}.some(k=>k in process.env),config:process.env.CLAUDE_CONFIG_DIR===${JSON.stringify(source.CLAUDE_CONFIG_DIR)},bash:process.env.CLAUDE_CODE_GIT_BASH_PATH==='fixture-bash'}))`;
  const observed = JSON.parse((await captureTarget(target, ['-e', script], { env: source })).stdout);
  assert.deepEqual(observed, { overrides: false, config: true, bash: true });

  for (const custom of [
    { ...target, commandDiscovery: 'fixed' as const },
    { ...target, accountingMode: 'usage' as const },
    { ...target, gateway: 'api' as const },
    { ...target, id: 'claude-custom' },
    { ...target, args: ['custom-launcher'] },
    { ...target, provider: 'grok' as const, id: 'grok-native' },
  ])
    assert.deepEqual(nativeAccountEnvironment(custom, source), before, 'custom authentication remains explicit');
});

test(
  'a Cursor account moves only its login and CLI config, pinning the tools that use APPDATA',
  { skip: !windows },
  async (t) => {
    const root = directory(t);
    const target = await createNativeAccount(root, { ...cursorBase, accountingMode: 'subscription' }, 'Cursor B');
    assert.equal(target.id, `cursor-account-${target.accountId}`);
    assert.deepEqual(target.args, []);
    assert.deepEqual(readdirSync(target.accountHome!), []);
    assert.equal(target.accountingMode, 'subscription', 'counted like the existing Cursor card');
    const source = {
      Path: 'system-path',
      USERPROFILE: 'C:\\Users\\fixture',
      LOCALAPPDATA: 'C:\\Users\\fixture\\AppData\\Local',
      AppData: 'C:\\Users\\fixture\\AppData\\Roaming',
      GH_CONFIG_DIR: 'C:\\custom\\gh',
      agent_cli_credential_store: 'memory',
      CURSOR_API_KEY: 'fixture-key',
      CURSOR_CONFIG_DIR: 'C:\\Users\\fixture\\.cursor',
      Cursor_Auth_Token: 'fixture-token',
      ANTHROPIC_API_KEY: 'fixture-key',
    };
    const before = { ...source };
    assert.deepEqual(nativeAccountEnvironment(target, source), {
      Path: 'system-path',
      USERPROFILE: 'C:\\Users\\fixture',
      LOCALAPPDATA: 'C:\\Users\\fixture\\AppData\\Local',
      GH_CONFIG_DIR: 'C:\\custom\\gh',
      CURSOR_CONFIG_DIR: join(target.accountHome!, '.cursor'),
      AGENT_CLI_CREDENTIAL_STORE: 'file',
      NPM_CONFIG_PREFIX: 'C:\\Users\\fixture\\AppData\\Roaming\\npm',
      PYTHONUSERBASE: 'C:\\Users\\fixture\\AppData\\Roaming\\Python',
      APPDATA: join(target.accountHome!, 'AppData', 'Roaming'),
    });
    assert.deepEqual(source, before);
    assert.deepEqual(nativeAccountEnvironment(cursorBase, source), before, 'the existing Cursor login is unchanged');
    assert.equal(
      nativeAccountCursorLogin(target),
      join(target.accountHome!, 'AppData', 'Roaming', 'Cursor', 'auth.json'),
    );
    assert.throws(() => nativeAccountCursorLogin({ ...target, provider: 'claude' }));
  },
);

test(
  'a Cursor account identity needs its own login file and matches cursor-agent status',
  { skip: !windows },
  async (t) => {
    const root = directory(t);
    const first = await createNativeAccount(root, cursorBase, 'Cursor B');
    const second = await createNativeAccount(root, cursorBase, 'Cursor C');
    cursorProfile(first.accountHome!, { userId: 987654, email: 'B@Example.Test', displayName: 'Fixture' });
    const expected = cursorAccountFingerprint({
      status: 'authenticated',
      isAuthenticated: true,
      userInfo: { userId: 987654, email: 'b@example.test' },
    });
    assert.equal(nativeAccountFingerprint(first), expected);
    cursorProfile(second.accountHome!, { userId: '987654', email: 'renamed@example.test' });
    assert.equal(nativeAccountFingerprint(second), expected, 'the account id, not the email, is the identity');
    cursorProfile(second.accountHome!, { email: 'Only@Example.Test' });
    assert.equal(
      nativeAccountFingerprint(second),
      cursorAccountFingerprint({ isAuthenticated: true, userInfo: { email: 'only@example.test' } }),
    );
    for (const authInfo of [{}, { userId: Number.MAX_SAFE_INTEGER + 1 }, { email: 'not-an-address' }]) {
      cursorProfile(second.accountHome!, authInfo);
      assert.equal(nativeAccountFingerprint(second), undefined);
    }
    cursorProfile(second.accountHome!, { userId: 42 });
    unlinkSync(join(second.accountHome!, 'AppData', 'Roaming', 'Cursor', 'auth.json'));
    assert.equal(nativeAccountFingerprint(second), undefined, 'a cached account without a login is not an identity');
  },
);

test(
  'Cursor accounts accept only the official launcher, and each CLI signs in with its own command',
  { skip: !windows },
  async (t) => {
    const root = directory(t);
    const previous = process.env.LOCALAPPDATA;
    t.after(() => {
      if (previous === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = previous;
    });
    process.env.LOCALAPPDATA = join(root, 'local');
    const launcher = join(root, 'local', 'cursor-agent', 'cursor-agent.cmd');
    write(launcher, '@echo off\r\n');
    write(join(root, 'elsewhere', 'cursor-agent.cmd'), '@echo off\r\n');
    const data = join(root, 'data');
    mkdirSync(data);
    await assert.rejects(
      createNativeAccount(data, { ...cursorBase, command: join(root, 'elsewhere', 'cursor-agent.cmd') }, 'Other'),
      /包装脚本/,
    );
    await assert.rejects(createNativeAccount(data, { ...claudeBase, command: launcher }, 'Claude'), /包装脚本/);
    const cursor = await createNativeAccount(data, { ...cursorBase, command: launcher }, 'Cursor B');
    assert.equal(cursor.command, launcher);
    const claude = await createNativeAccount(data, claudeBase, 'Claude B');
    for (const [target, expected] of [
      [claude, "'auth' 'login' '--claudeai'"],
      [cursor, `'${launcher}' 'login'`],
    ] as const) {
      let invocation: { args: string[]; options: SpawnOptions } | undefined;
      await launchAccountLogin(target, (_command, args, options) => {
        invocation = { args, options };
        const child = new EventEmitter() as ChildProcess;
        queueMicrotask(() => child.emit('close', 0));
        return child;
      });
      const script = decodedLoginScript(invocation!.args);
      assert.ok(script.includes(expected), expected);
      assert.ok(!script.includes('--device-auth'));
      assert.ok(!script.includes('logout'));
      assert.equal(invocation!.options.cwd, target.accountHome);
      if (target.provider === 'claude') assert.equal(invocation!.options.env!.CLAUDE_CONFIG_DIR, target.accountHome);
      else {
        assert.equal(invocation!.options.env!.APPDATA, join(target.accountHome!, 'AppData', 'Roaming'));
        assert.equal(invocation!.options.env!.CURSOR_CONFIG_DIR, join(target.accountHome!, '.cursor'));
      }
    }
  },
);

test(
  'a second Cursor account reads usage with its own login, never the editor login',
  { skip: !windows },
  async (t) => {
    const root = directory(t);
    const account = await createNativeAccount(root, cursorBase, 'Cursor B');
    const token = jwt({ sub: 'auth0|user_fixture_b', exp: Math.floor(Date.now() / 1000) + 3600 });
    cursorProfile(account.accountHome!, { userId: 2468 }, token);
    let options: Parameters<typeof applyCursorEditorUsage>[2];
    const adapter = createCursorAdapter({
      capture: async () => {
        throw new Error('runtime-not-found');
      },
      spawn: async () => {
        throw new Error('runtime-not-found');
      },
      usage: async (_snapshot, _identity, value) => {
        options = value;
      },
    });
    await adapter.discover(account);
    assert.equal(options?.accountLogin, true);
    const session = await options!.session!();
    assert.equal(session?.userId, 'user_fixture_b');
    assert.equal(session?.email, undefined);
    await adapter.discover({ ...cursorBase, command: join(root, 'missing-cursor-agent.exe') });
    assert.equal(options?.session, undefined, 'the existing login keeps reading the editor');
    assert.equal(options?.accountLogin, undefined);

    const cookies: string[] = [];
    const snapshot = {
      quota: { status: 'unknown', source: 'fixture', observedAt: null, windows: [] },
    } as unknown as RuntimeSnapshot;
    const enabled = cursorEditorUsage.enabled;
    cursorEditorUsage.enabled = true;
    t.after(() => {
      cursorEditorUsage.enabled = enabled;
    });
    await applyCursorEditorUsage(
      snapshot,
      { state: 'verified', email: 'b@example.test', userId: '2468' },
      {
        session: () => readCursorCliSession(nativeAccountCursorLogin(account)),
        accountLogin: true,
        fetch: (async (url: string, init: RequestInit) => {
          cookies.push(String((init.headers as Record<string, string>).cookie));
          const body = /usage-summary/.test(url)
            ? {
                billingCycleEnd: Date.now() + 86_400_000,
                individualUsage: { plan: { autoPercentUsed: 12, apiPercentUsed: 30 } },
              }
            : {};
          return { ok: true, status: 200, json: async () => body };
        }) as unknown as typeof fetch,
      },
    );
    assert.equal(snapshot.quota.status, 'known');
    assert.deepEqual(
      snapshot.quota.windows.map((window) => [window.id, window.usedPercent]),
      [
        ['cursor-auto', 12],
        ['cursor-api', 30],
      ],
    );
    assert.match(snapshot.quota.source, /此账号的 Cursor 登录/);
    assert.ok(cursorDashboardSource(snapshot.quota.source), 'turning usage reading off clears this reading too');
    assert.ok(cursorDashboardSource('Cursor 编辑器登录 · cursor.com 用量'));
    assert.ok(!cursorDashboardSource('Cursor CLI'));
    assert.ok(
      cookies.length > 0 &&
        cookies.every((cookie) => cookie === `WorkosCursorSessionToken=user_fixture_b%3A%3A${token}`),
    );
    write(nativeAccountCursorLogin(account), { refreshToken: 'fixture' });
    assert.equal(await readCursorCliSession(nativeAccountCursorLogin(account)), undefined);
  },
);

function observed(target: RuntimeTarget, fingerprint: string | undefined, used = 10): RuntimeSnapshot {
  return {
    id: target.id,
    label: target.label,
    provider: target.provider,
    environment: 'native',
    accountFingerprint: fingerprint,
    installed: true,
    status: 'ready',
    models: [{ id: 'model-fixture', label: 'Synthetic model', efforts: ['low', 'high'] }],
    quota: {
      status: 'known',
      source: 'Synthetic observation',
      observedAt: new Date().toISOString(),
      windows: [
        {
          id: 'week',
          label: 'Synthetic week',
          usedPercent: used,
          resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
      ],
    },
    accounting: { mode: 'subscription', source: 'Synthetic subscription' },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: new Date().toISOString(),
  };
}

/** The existing login A plus one managed account B of the same provider, with injected identities. */
function controllerFixture(t: TestContext, provider: 'claude' | 'cursor', identities: { a?: string; b?: string }) {
  // One cleanup hook closes, in order, whatever uses the folder and only then removes it.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-claude-cursor-'))),
    home = join(root, 'home'),
    dataDir = join(root, 'data');
  const closeFirst: Array<() => Promise<void>> = [];
  mkdirSync(home, { recursive: true });
  const overrides: Record<string, string | undefined> = {
    HOME: home,
    USERPROFILE: home,
    PATH: '',
    APPDATA: join(home, 'roaming'),
    LOCALAPPDATA: join(home, 'local'),
    XDG_CONFIG_HOME: home,
    CODEX_HOME: join(home, 'codex'),
    GROK_HOME: join(home, 'grok'),
    CLAUDE_CONFIG_DIR: join(home, 'claude'),
    JEV_API_KEY: undefined,
    TYPESAFE_API_KEY: undefined,
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  assert.equal(resolve(homedir()), resolve(home), 'the fixture must never read the real home');
  const a: RuntimeTarget = {
    id: `${provider}-native`,
    provider,
    label: 'Synthetic A',
    command: 'never-spawned',
    commandDiscovery: 'fixed',
    environment: 'native',
    enabled: true,
  };
  const b: RuntimeTarget = {
    ...a,
    id: `${provider}-account-fixture`,
    label: 'Synthetic B',
    enabled: false,
    accountId: 'fixture-profile',
    accountHome: join(dataDir, 'accounts', 'fixture-profile'),
  };
  const seed = new Store(dataDir);
  seed.setConfig('targets', [a, b]);
  seed.close();
  const recorded = new Map<string, string | undefined>([[b.id, identities.b]]);
  const reported = new Map<string, string | undefined>([
    [a.id, identities.a],
    [b.id, identities.b],
  ]);
  const adapter = provider === 'claude' ? claudeAdapter : cursorAdapter;
  t.mock.method(adapter, 'discover', async (target: RuntimeTarget) => observed(target, reported.get(target.id)));
  const controller = new Controller(root, dataDir, {
    readAccountIdentity: (target) => recorded.get(target.id),
    taskJudge: new TaskJudge({
      credential: () => undefined,
      fetch: async () => {
        throw new Error('No network in these fixtures');
      },
    }),
    nativeLogin: { pending: () => false },
  });
  clearInterval(controller.timer);
  controller.snapshots = [observed(a, identities.a, 60), observed(b, identities.b)];
  t.after(async () => {
    try {
      for (const close of closeFirst) await close();
      await controller.close();
    } finally {
      for (const [key, value] of Object.entries(previous))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      assert.ok(resolve(root).startsWith(realpathSync.native(tmpdir()) + sep));
      assert.ok(basename(root).startsWith('pugport-claude-cursor-'));
      rmSync(root, { recursive: true, force: true });
    }
  });
  return {
    controller,
    a,
    b,
    recorded,
    reported,
    closeFirst,
    account: () => controller.targets.find((x) => x.id === b.id)!,
  };
}

for (const provider of ['claude', 'cursor'] as const)
  test(`a second ${provider} login into the default account stays disabled and is marked as the same account`, async (t) => {
    const f = controllerFixture(t, provider, { a: 'identity-a', b: 'identity-a' });
    await f.controller.checkNativeAccount(f.b.id);
    assert.equal(f.account().enabled, false);
    const view = f.controller.nativeAccounts();
    assert.equal(
      view.providers.find((item) => item.id === provider)?.supported,
      windows || (provider === 'claude' && process.platform === 'darwin'),
    );
    const listed = view.accounts.find((item) => item.runtimeId === f.a.id);
    assert.equal(listed?.managed, false, 'the existing login is listed but never managed');
    assert.equal(listed?.identityKnown, true);
    assert.equal(view.accounts.find((item) => item.runtimeId === f.b.id)?.duplicateOf, f.a.id);
    f.recorded.set(f.b.id, 'identity-b');
    f.reported.set(f.b.id, 'identity-b');
    await f.controller.checkNativeAccount(f.b.id);
    assert.equal(f.account().enabled, true);
    assert.equal(f.account().accountFingerprint, 'identity-b');
    assert.equal(
      f.controller.nativeAccounts().accounts.find((item) => item.runtimeId === f.b.id)?.duplicateOf,
      undefined,
    );
  });

for (const provider of ['claude', 'cursor'] as const)
  test(`a second ${provider} account whose CLI reports another login than its folder is not trusted`, async (t) => {
    const f = controllerFixture(t, provider, { a: 'identity-a', b: 'identity-b' });
    f.reported.set(f.b.id, 'identity-other');
    await f.controller.checkNativeAccount(f.b.id);
    assert.equal(f.account().enabled, false);
    assert.equal(f.account().accountFingerprint, undefined);
    const snapshot = f.controller.snapshots.find((item) => item.id === f.b.id)!;
    assert.notEqual(snapshot.status, 'ready');
    assert.equal(snapshot.accountFingerprint, undefined);
    assert.deepEqual(snapshot.quota.windows, [], 'no quota is shown for an unconfirmed login');
    assert.throws(() => f.controller.updateTarget(f.b.id, { enabled: true }), /请先登录/);
  });

/** Relay through the real workspace: execution is a stub that fails or answers, nothing is spawned. */
function relayFixture(
  t: TestContext,
  fail: (target: RuntimeTarget) => string | undefined,
  used: { a: number; b: number },
) {
  const f = controllerFixture(t, 'claude', { a: 'identity-a', b: 'identity-b' });
  const b = f.account();
  b.enabled = true;
  b.accountFingerprint = 'identity-b';
  Object.assign(f.controller.settings, {
    decisionMode: 'auto',
    taskJudgment: 'local',
    preferNative: true,
    architectureProvider: 'claude',
    routineProvider: 'claude',
    designProvider: 'claude',
  });
  f.controller.snapshots = [observed(f.a, 'identity-a', used.a), observed(b, 'identity-b', used.b)];
  t.mock.method(f.controller, 'refresh', async () => {});
  const calls: ExecuteContext[] = [];
  t.mock.method(claudeAdapter, 'execute', async (context: ExecuteContext) => {
    calls.push(context);
    const error = fail(context.target);
    if (error) throw new Error(error);
    return { output: 'Synthetic answer' };
  });
  const workspace = new Workspace(f.controller, { autoTick: false, retryMs: 20 });
  f.closeFirst.push(() => workspace.close());
  return { ...f, workspace, calls };
}
const message: MessageInput = {
  content: 'Explain this implementation choice.',
  mode: 'chat',
  provider: 'claude',
  model: 'model-fixture',
  effort: 'high',
  permissionMode: 'read-only',
  executionPolicy: 'cli-only',
};
async function finish(workspace: Workspace) {
  const conversation = await workspace.createGeneralConversation();
  const { workflow } = await workspace.send(conversation.id, message);
  const deadline = Date.now() + 30_000;
  const done = () =>
    ['completed', 'blocked', 'cancelled', 'failed'].includes(
      workspace.store.get<Workflow>('workflow', workflow.id)!.status,
    );
  while (!done() && Date.now() < deadline) {
    await workspace.tickQueue();
    await new Promise((settle) => setTimeout(settle, 5));
  }
  return workspace.store.get<Workflow>('workflow', workflow.id)!;
}

test('Claude quota on the existing login relays to the second account with the same model and effort', async (t) => {
  const f = relayFixture(t, (target) => (target.id === 'claude-native' ? 'quota-or-rate-limit' : undefined), {
    a: 10,
    b: 40,
  });
  const workflow = await finish(f.workspace);
  assert.equal(workflow.status, 'completed');
  assert.deepEqual(
    f.calls.map((call) => call.target.id),
    ['claude-native', f.b.id],
  );
  assert.ok(f.calls.every((call) => call.route.model === 'model-fixture' && call.route.effort === 'high'));
  const [first, second] = workflow.runIds.map((id) => f.controller.store.run(id)!);
  assert.equal(first!.errorCode, 'quota-or-rate-limit');
  assert.deepEqual(second!.relay, { fromRunId: first!.id, fromRuntimeId: 'claude-native', reason: 'quota' });
  assert.equal(second!.account?.fingerprint, 'identity-b');
});

test('a signed-out second Claude account hands the task back to the existing login', async (t) => {
  const f = relayFixture(t, (target) => (target.id === 'claude-native' ? undefined : 'authentication-required'), {
    a: 40,
    b: 10,
  });
  const workflow = await finish(f.workspace);
  assert.equal(workflow.status, 'completed');
  assert.deepEqual(
    f.calls.map((call) => call.target.id),
    [f.b.id, 'claude-native'],
  );
  const [, second] = workflow.runIds.map((id) => f.controller.store.run(id)!);
  assert.equal(second!.relay?.reason, 'authentication');
  assert.ok(f.calls.every((call) => call.route.model === 'model-fixture' && call.route.effort === 'high'));
});
