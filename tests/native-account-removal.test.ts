import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { Store } from '../src/server/store.ts';
import { Inbox } from '../src/server/inbox.ts';
import { deleteAccountHome } from '../src/server/account-home.ts';
import { recyclablePaths } from '../src/server/recycle-bin.ts';
import type { RunRecord, RuntimeTarget } from '../src/shared/types.ts';

function fixture(t: TestContext, retiredGemini = false, seedSavedData?: (store: Store) => void) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-account-removal-')));
  const home = join(directory, 'home');
  mkdirSync(home);
  const overrides: Record<string, string | undefined> = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home,
    PATH: '',
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
  const data = join(directory, 'synthetic-state');
  const native: RuntimeTarget = {
    id: 'grok-native',
    provider: 'grok',
    label: 'Grok · 本机',
    command: 'never-spawn',
    commandDiscovery: 'fixed',
    environment: 'native',
    enabled: true,
  };
  const expired: RuntimeTarget = {
    ...native,
    id: 'grok-account-b',
    accountId: 'b',
    accountHome: join(data, 'accounts', 'b'),
    label: 'Grok B',
    enabled: false,
  };
  const seed = new Store(data);
  mkdirSync(expired.accountHome!, { recursive: true });
  seed.setConfig('targets', [
    native,
    expired,
    ...(retiredGemini
      ? ([
          { ...native, id: 'gemini-native', provider: 'gemini', command: 'gemini' },
          { ...native, id: 'google-cli-custom', provider: 'pi', command: 'agy' },
          {
            ...expired,
            id: 'gemini-account-old',
            provider: 'gemini',
            accountHome: join(data, 'accounts', 'google-old'),
          },
          {
            ...native,
            id: 'api-google',
            provider: 'pi',
            gateway: 'api',
            apiProvider: 'google',
            commandDiscovery: 'auto',
          },
          {
            ...native,
            id: 'api-gemini-free',
            provider: 'pi',
            gateway: 'api',
            apiProvider: 'gemini-free',
            commandDiscovery: 'auto',
          },
        ] satisfies RuntimeTarget[])
      : []),
  ]);
  if (retiredGemini)
    seed.saveRun({
      id: 'old-gemini-run',
      prompt: 'Gemini history prompt',
      output: 'Gemini history response',
      projectPath: home,
      kind: 'general',
      status: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      route: { runtimeId: 'gemini-native', model: 'gemini-2.5-pro', kind: 'general', reasons: [], warnings: [] },
      account: { id: 'gemini-native', label: 'Gemini', provider: 'gemini' },
      events: [],
    });
  seedSavedData?.(seed);
  seed.close();
  const recycled: Array<{ root: string; paths: unknown }> = [];
  const controller = new Controller(directory, data, {
    nativeLogin: { pending: () => false },
    recycleAccountHome: async (root, paths) => {
      recycled.push({ root, paths });
      const checked = await recyclablePaths(root, paths);
      return { moved: checked.paths, failed: checked.failed };
    },
  });
  clearInterval(controller.timer);
  t.after(async () => {
    try {
      await controller.close();
    } finally {
      for (const [key, value] of Object.entries(previous))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      assert.equal(dirname(directory).toLowerCase(), realpathSync.native(tmpdir()).toLowerCase());
      assert.ok(basename(directory).startsWith('pugport-account-removal-'));
      rmSync(directory, { recursive: true, force: true });
    }
  });
  return { controller, native, expired, recycled, data, home, directory };
}

test('loading drops saved Gemini CLI targets and accounts while preserving Gemini API providers', async (t) => {
  const f = fixture(t, true);
  const check = (controller: Controller) => {
    for (const expected of [f.native, f.expired]) {
      assert.deepEqual(
        controller.targets.find((target) => target.id === expected.id),
        expected,
      );
      assert.deepEqual(
        controller.store.config<RuntimeTarget[]>('targets', []).find((target) => target.id === expected.id),
        expected,
      );
    }
    assert.ok(!controller.targets.some((target) => target.provider === 'gemini' || target.id === 'gemini-native'));
    assert.ok(!controller.store.config<RuntimeTarget[]>('targets', []).some((target) => target.provider === 'gemini'));
    assert.ok(!controller.targets.some((target) => target.id === 'google-cli-custom'));
    const history = controller.store.run('old-gemini-run')!;
    assert.equal(history.prompt, 'Gemini history prompt');
    assert.equal(history.output, 'Gemini history response');
    assert.equal(history.account?.provider, 'gemini');
    for (const id of ['api-google', 'api-gemini-free']) {
      const api = controller.targets.find((target) => target.id === id)!;
      assert.equal(api.provider, 'pi');
      assert.equal(api.gateway, 'api');
      assert.equal(api.enabled, true);
    }
  };
  check(f.controller);
  assert.equal(f.recycled.length, 0);
  const restarted = new Controller(f.directory, f.data, { nativeLogin: { pending: () => false } });
  clearInterval(restarted.timer);
  try {
    check(restarted);
  } finally {
    await restarted.close();
  }
});

test('loading malformed saved commands and args does not crash or remove unrelated targets', (t) => {
  const targets = [
    { command: 42 },
    { command: null },
    { command: {} },
    { command: 'npx', args: '@google/gemini-cli' },
    { command: 'node', args: {} },
    { command: 'node', args: null },
    { command: 'node', args: [null, 42, {}] },
  ].map((fields, index) => ({
    id: `odd-saved-${index}`,
    provider: 'grok',
    label: 'Synthetic',
    environment: 'native',
    enabled: false,
    commandDiscovery: 'fixed',
    ...fields,
  }));
  const f = fixture(t, false, (store) => store.setConfig('targets', targets as unknown as RuntimeTarget[]));
  for (const target of targets)
    assert.deepEqual(
      f.controller.targets.find((saved) => saved.id === target.id),
      target,
    );
});

test('loading removes retired caller permissions and resolves removed CLI notices while preserving other data', async (t) => {
  const f = fixture(t, true, (store) => {
    store.setConfig('settings', { externalCallers: { gemini: 'write', codex: 'read-only', grok: 'write' } });
    const inbox = new Inbox(store.db);
    for (const id of [
      'gemini-native',
      'google-cli-custom',
      'gemini-account-old',
      'previously-removed-google-cli',
      'grok-native',
      'api-google',
    ]) {
      const notice = inbox.raise({
        kind: 'executor-login',
        key: id,
        severity: 'action',
        title: 'Synthetic',
        source: { runtimeId: id },
      });
      if (id === 'gemini-native') {
        // Model an inbox row written before this notice kind was retired.
        store.db
          .prepare('UPDATE inbox_notices SET kind=?,value=? WHERE id=?')
          .run('account-disabled', JSON.stringify({ ...notice, kind: 'account-disabled' }), notice.id);
      }
    }
  });
  const check = (controller: Controller) => {
    const callers = { codex: 'read-only', grok: 'write' };
    assert.deepEqual(controller.settings.externalCallers, callers);
    assert.deepEqual(
      controller.store.config<{ externalCallers: unknown }>('settings', { externalCallers: {} }).externalCallers,
      callers,
    );
    assert.deepEqual(
      controller.inbox
        .list()
        .map((notice) => notice.key)
        .sort(),
      ['api-google', 'grok-native'],
    );
    const retired = controller.inbox
      .list({ all: true })
      .filter((notice) => !['api-google', 'grok-native'].includes(notice.key));
    assert.equal(retired.length, 4);
    assert.ok(retired.every((notice) => notice.resolvedAt));
  };
  check(f.controller);
  const restarted = new Controller(f.directory, f.data, { nativeLogin: { pending: () => false } });
  try {
    check(restarted);
  } finally {
    await restarted.close();
  }
});

test('an expired account can be removed: it leaves the list and its login goes to the Recycle Bin', async (t) => {
  const f = fixture(t);
  const result = await f.controller.removeNativeAccount(f.expired.id);
  assert.deepEqual(result, { ok: true, loginFolderRecycled: true });
  assert.ok(!f.controller.targets.some((target) => target.id === f.expired.id));
  assert.ok(f.controller.targets.some((target) => target.id === f.native.id));
  assert.deepEqual(f.recycled, [{ root: join(f.data, 'accounts'), paths: [f.expired.accountHome] }]);
});

test('a built-in card leaves PugPort without touching any file, and a restart does not bring it back', async (t) => {
  const f = fixture(t);
  // Cursor is outside the legacy known-provider list, so its removal survives restart.
  assert.ok(f.controller.targets.some((target) => target.id === 'cursor-native'));
  const cliFiles = [join(f.home, 'grok', 'auth.json'), join(f.home, '.cursor', 'auth.json')];
  for (const file of cliFiles) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{"synthetic":true}');
  }
  f.controller.store.setConfig('connectionTests', { [f.native.id]: { ok: false } });
  f.controller.store.setConfig('manualResetNotes', { [f.native.id]: [{ note: 'synthetic' }] });
  f.controller.store.db
    .prepare('INSERT INTO native_account_health(health_key,runtime_id,value) VALUES(?,?,?)')
    .run('built-in-key', f.native.id, '{}');
  for (const id of [f.native.id, 'cursor-native'])
    assert.deepEqual(await f.controller.removeNativeAccount(id), { ok: true, builtIn: true });
  for (const file of cliFiles) assert.equal(readFileSync(file, 'utf8'), '{"synthetic":true}');
  assert.deepEqual(f.controller.store.config('connectionTests', {}), {});
  assert.deepEqual(f.controller.store.config('manualResetNotes', {}), {});
  assert.equal(
    f.controller.store.db.prepare('SELECT COUNT(*) AS n FROM native_account_health WHERE runtime_id=?').get(f.native.id)
      ?.n,
    0,
  );
  assert.equal(f.recycled.length, 0);
  assert.ok(f.controller.targets.some((target) => target.id === f.expired.id));
  const restarted = new Controller(f.directory, f.data, { nativeLogin: { pending: () => false } });
  clearInterval(restarted.timer);
  try {
    assert.ok(!restarted.targets.some((target) => target.id === f.native.id || target.id === 'cursor-native'));
  } finally {
    await restarted.close();
  }
});

test('an account in use is kept until its task ends', async (t) => {
  const f = fixture(t);
  for (const id of [f.expired.id, f.native.id]) {
    const run = { id: 'busy', route: { runtimeId: id } } as RunRecord;
    f.controller.active.set(run.id, { run, abort: new AbortController(), project: 'C:/fixture' });
    await assert.rejects(f.controller.removeNativeAccount(id), /请先结束正在使用它的任务/);
    assert.ok(f.controller.targets.some((target) => target.id === id));
    f.controller.active.delete(run.id);
  }
  assert.equal(f.recycled.length, 0, 'nothing is moved while the account is still needed');
});

test('clearing an account for good deletes its own login folder and what PugPort remembered about it', async (t) => {
  const f = fixture(t);
  mkdirSync(f.expired.accountHome!, { recursive: true });
  writeFileSync(join(f.expired.accountHome!, 'auth.json'), '{"synthetic":true}');
  f.controller.store.setConfig('connectionTests', { [f.expired.id]: { ok: false }, [f.native.id]: { ok: true } });
  f.controller.store.setConfig('manualResetNotes', { [f.expired.id]: [{ note: 'synthetic' }] });
  f.controller.store.db
    .prepare('INSERT INTO native_account_health(health_key,runtime_id,value) VALUES(?,?,?)')
    .run('synthetic-key', f.expired.id, '{}');
  const result = await f.controller.removeNativeAccount(f.expired.id, 'purge');
  assert.deepEqual(result, { ok: true, loginFolderDeleted: true });
  assert.equal(existsSync(f.expired.accountHome!), false);
  assert.equal(f.recycled.length, 0, 'clearing deletes rather than recycles');
  assert.deepEqual(Object.keys(f.controller.store.config('connectionTests', {})), [f.native.id]);
  assert.deepEqual(f.controller.store.config('manualResetNotes', {}), {});
  assert.equal(
    f.controller.store.db
      .prepare('SELECT COUNT(*) AS n FROM native_account_health WHERE runtime_id=?')
      .get(f.expired.id)?.n,
    0,
  );
});

test('permanent deletion only ever touches a folder directly inside the accounts directory', async (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-account-home-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const accounts = join(root, 'accounts');
  const inside = join(accounts, 'a');
  const nested = join(accounts, 'a', 'deeper');
  const outside = join(root, 'elsewhere');
  for (const folder of [nested, outside]) mkdirSync(folder, { recursive: true });
  assert.equal(await deleteAccountHome(accounts, outside), false);
  assert.equal(await deleteAccountHome(accounts, nested), false);
  assert.equal(await deleteAccountHome(accounts, accounts), false);
  assert.equal(existsSync(outside) && existsSync(nested), true);
  assert.equal(await deleteAccountHome(accounts, inside), true);
  assert.equal(existsSync(inside), false);
});
