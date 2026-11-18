import { test, type TestContext } from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import type { RuntimeTarget } from '../src/shared/types.ts';
import { createClaudeAdapter } from '../src/server/adapters/claude.ts';
import { createCodexAdapter } from '../src/server/adapters/codex.ts';
import { createCursorAdapter } from '../src/server/adapters/cursor.ts';
import {
  captureTarget,
  spawnTarget,
  shutdownOwnedProcesses,
  terminateProcess,
  windowsTreeKill,
} from '../src/server/adapters/process.ts';
import { discoverNativeInHelper, nativeDiscoveryRuntime } from '../src/server/native-discovery-client.ts';
import { cursorEditorUsage, cursorStateDatabase } from '../src/server/cursor-usage.ts';

const fixtureSource = String.raw`
const fs = require('node:fs');
const [provider, trace, configPath, ...args] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
// Cursor discovery launches ACP with its execution flags, so the subcommand is the last argument.
fs.appendFileSync(trace, JSON.stringify({ pid: process.pid, stage: args.at(-1) === 'acp' ? 'acp' : args[0] }) + '\n');
const identity = { status: 'authenticated', isAuthenticated: true, userInfo: { userId: 'user_fixture', email: 'fixture@example.test' } };
const send = value => console.log(JSON.stringify(value));
if (config.hang === args[0]) { process.stdin.resume(); setInterval(() => {}, 1000); }
else if (provider === 'claude' && args[0] === 'auth') send({ loggedIn: true, authMethod: 'claudeAi', apiProvider: 'firstParty', email: 'fixture@example.test', orgId: 'fixture-org', subscriptionType: 'pro' });
else if (provider === 'cursor' && args[0] === 'status') send(identity);
else if (args[0] === 'about') send({ cliVersion: '2026.10.01', subscriptionTier: 'Pro', userEmail: 'fixture@example.test' });
else if (args[0] === 'models') console.log('Available models\n\nauto - Auto (default)\ncomposer-2.5 - Composer 2.5\n');
else {
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const packet = JSON.parse(line);
    const method = provider === 'claude' ? packet.request?.subtype : packet.method;
    if (provider === 'codex') {
      fs.appendFileSync(trace, JSON.stringify({ pid: process.pid, stage: 'rpc', method, refreshToken: packet.params?.refreshToken }) + '\n');
      if (method === 'initialized') return;
      if (!['initialize', 'account/read', 'model/list', 'account/rateLimits/read'].includes(method)) process.exit(14);
      if (config.authError && method.startsWith('account/')) {
        send({ id: packet.id, error: { code: 401, message: 'authentication required' } });
        return;
      }
      const result = method === 'account/read'
        ? { account: { type: 'chatgpt', planType: 'plus' }, requiresOpenaiAuth: false }
        : method === 'model/list'
          ? { data: [{ id: 'gpt-fixture', model: 'gpt-fixture', displayName: 'Fixture', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], defaultReasoningEffort: 'medium' }] }
          : method === 'account/rateLimits/read'
            ? { accountId: 'fixture-account', rateLimitsByLimitId: { codex: { primary: { usedPercent: config.used ?? 12, windowDurationMins: 300, resetsAt: 4102444800 } } } }
            : {};
      send({ id: packet.id, result });
    } else if (provider === 'claude') {
      if (!['initialize', 'list_models', 'get_usage'].includes(method)) process.exit(12);
      const response = method === 'get_usage'
        ? { rate_limits_available: true, rate_limits: { five_hour: { utilization: config.used ?? 12, resets_at: '2099-01-01T00:00:00Z' } } }
        : { models: [{ value: 'sonnet', displayName: 'Sonnet' }] };
      send({ type: 'control_response', response: { request_id: packet.request_id, subtype: 'success', response } });
    } else if (method === 'initialize') send({ jsonrpc: '2.0', id: packet.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    else if (method === 'cursor/list_available_models') send(config.modern
      ? { jsonrpc: '2.0', id: packet.id, result: { models: [{ value: 'composer-2.5', name: 'Composer 2.5', configOptions: [] }] } }
      : { jsonrpc: '2.0', id: packet.id, error: { code: -32601, message: 'unsupported method' } });
    else if (packet.id !== undefined) process.exit(13);
  }).on('close', () => process.exit(0));
}
`;

async function fixture(provider: 'claude' | 'codex' | 'cursor', config: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'native-discovery-fixture-'));
  const script = join(root, 'fixture.cjs');
  const tracePath = join(root, 'trace.jsonl');
  const configPath = join(root, 'config.json');
  await writeFile(script, fixtureSource);
  await writeFile(configPath, JSON.stringify(config));
  const target: RuntimeTarget = {
    id: `synthetic-${provider}`,
    provider,
    label: `Synthetic ${provider}`,
    command: process.execPath,
    args: [script, provider, tracePath, configPath],
    environment: 'native',
    enabled: true,
  };
  return {
    target,
    root,
    trace: async () =>
      (await readFile(tracePath, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { pid: number; stage: string; method?: string; refreshToken?: boolean }),
    set: (value: Record<string, unknown>) => writeFile(configPath, JSON.stringify(value)),
    clean: () => rm(root, { recursive: true, force: true }),
  };
}

test('Electron metadata uses installed Windows Node while Node hosts and missing bundles keep their runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-runtime-fixture-'));
  try {
    assert.equal(nativeDiscoveryRuntime(root, 'win32', true), process.execPath);
    const installed = join(root, '.runtime', 'node.exe');
    await mkdir(dirname(installed));
    await writeFile(installed, 'not executed: selection fixture');
    assert.equal(nativeDiscoveryRuntime(root, 'win32', true), installed);
    assert.equal(nativeDiscoveryRuntime(root, 'win32', false), process.execPath);
    assert.equal(nativeDiscoveryRuntime(root, 'darwin', true), process.execPath);
    assert.equal(nativeDiscoveryRuntime(root, 'linux', true), process.execPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const provider of ['claude', 'codex', 'cursor'] as const)
  test(
    `Windows default ${provider} discovery uses one owned helper`,
    { skip: process.platform !== 'win32', timeout: 30_000 },
    async () => {
      const f = await fixture(provider);
      const original = childProcess.spawn;
      const starts: { command: string; args: readonly string[]; pid?: number }[] = [];
      childProcess.spawn = ((...args: Parameters<typeof original>) => {
        const child = original(...args);
        starts.push({ command: args[0], args: Array.isArray(args[1]) ? args[1] : [], pid: child.pid });
        return child;
      }) as typeof original;
      syncBuiltinESMExports();
      try {
        const adapter =
          provider === 'claude'
            ? createClaudeAdapter()
            : provider === 'codex'
              ? createCodexAdapter()
              : createCursorAdapter();
        const result = await adapter.discover(f.target);
        assert.equal(result.status, 'ready');
        assert.equal(result.provider, provider);
        assert.equal(result.id, f.target.id);
        if (provider !== 'codex') assert.ok(result.accountFingerprint);
        assert.ok(result.models.length);
        assertHelperLaunches(starts);
        for (const { pid } of await f.trace()) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      } finally {
        childProcess.spawn = original;
        syncBuiltinESMExports();
        await f.clean();
      }
    },
  );

function assertHelperLaunches(starts: { command: string; args: readonly string[]; pid?: number }[]) {
  const [helper, ...cleanup] = starts;
  assert.ok(helper?.pid, 'the parent must launch an owned helper');
  assert.equal(helper.command, nativeDiscoveryRuntime(fileURLToPath(new URL('..', import.meta.url))));
  assert.equal(helper.args.length, 2);
  assert.equal(helper.args[0], '-e');
  assert.match(helper.args[1]!, /native-discovery-helper/);
  // Whole-tree cleanup is legitimate; no provider command or unrelated PID may run in the parent.
  const expected = windowsTreeKill(helper.pid);
  for (const child of cleanup) assert.deepEqual({ file: child.command, args: child.args }, expected);
}

test('parent launch assertion accepts only cleanup of its helper, never metadata or unrelated tree kills', () => {
  const helper = {
    command: nativeDiscoveryRuntime(fileURLToPath(new URL('..', import.meta.url))),
    args: ['-e', 'native-discovery-helper'],
    pid: 1234,
  };
  const cleanup = windowsTreeKill(helper.pid);
  assertHelperLaunches([helper, { command: cleanup.file, args: cleanup.args, pid: 5678 }]);
  assert.throws(() => assertHelperLaunches([helper, { command: process.execPath, args: ['app-server'], pid: 5678 }]));
  const unrelated = windowsTreeKill(4321);
  assert.throws(() => assertHelperLaunches([helper, { command: unrelated.file, args: unrelated.args, pid: 5678 }]));
  assert.throws(() => assertHelperLaunches([helper, helper]));
});

test(
  'Codex metadata helper preserves quota and target identity without starting a turn',
  { timeout: 15_000 },
  async () => {
    const f = await fixture('codex');
    try {
      const direct = await createCodexAdapter({ spawn: spawnTarget }).discover(f.target);
      const { snapshot } = await discoverNativeInHelper(f.target);
      assert.equal(snapshot.id, f.target.id);
      assert.equal(snapshot.provider, 'codex');
      assert.equal(snapshot.status, 'ready');
      assert.equal(snapshot.authMode, 'chatgpt');
      assert.deepEqual(snapshot.models, direct.models);
      assert.deepEqual(snapshot.quota.windows, direct.quota.windows);
      assert.equal(snapshot.quota.windows[0]?.usedPercent, 12);
      assert.equal(snapshot.quota.source, direct.quota.source);
      assert.equal(
        snapshot.accountFingerprint,
        direct.accountFingerprint,
        'discovery does not invent account identity',
      );
      const trace = await f.trace();
      assert.equal(
        trace.filter((row) => row.stage === 'app-server').length,
        2,
        'one CLI per explicit/default discovery',
      );
      assert.deepEqual([...new Set(trace.flatMap((row) => row.method ?? []))].sort(), [
        'account/rateLimits/read',
        'account/read',
        'initialize',
        'initialized',
        'model/list',
      ]);
      assert.ok(trace.filter((row) => row.method === 'account/read').every((row) => row.refreshToken === false));
      for (const { pid } of trace) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    } finally {
      await f.clean();
    }
  },
);

test('Codex metadata helper retains authentication failure without starting a turn', { timeout: 15_000 }, async () => {
  const f = await fixture('codex', { authError: true });
  try {
    const { snapshot } = await discoverNativeInHelper(f.target);
    assert.equal(snapshot.status, 'auth-required');
    assert.equal(snapshot.quota.status, 'unknown');
    assert.equal(snapshot.id, f.target.id);
    const trace = await f.trace();
    assert.ok(trace.every((row) => !/^(?:thread|turn)\//.test(row.method ?? '')));
    for (const { pid } of trace) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    await f.clean();
  }
});

test('Codex metadata helper timeout reaps its pending app-server', { timeout: 30_000 }, async () => {
  const f = await fixture('codex', { hang: 'app-server' });
  try {
    await assert.rejects(discoverNativeInHelper(f.target, { timeoutMs: 10_000 }), /runtime-timeout/);
    const trace = await f.trace();
    assert.equal(trace.length, 1);
    assert.equal(trace[0]?.stage, 'app-server');
    for (const { pid } of trace) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    await f.clean();
  }
});

for (const provider of ['claude', 'cursor'] as const)
  test(`${provider} injected dependencies retain direct discovery`, { timeout: 20_000 }, async () => {
    const f = await fixture(provider);
    let captures = 0;
    const capture: typeof captureTarget = (...args) => {
      captures++;
      return captureTarget(...args);
    };
    try {
      const adapter = provider === 'claude' ? createClaudeAdapter({ capture }) : createCursorAdapter({ capture });
      const snapshot = await adapter.discover(f.target);
      assert.equal(snapshot.status, 'ready');
      assert.equal(captures, provider === 'claude' ? 2 : 4);
      for (const { pid } of await f.trace()) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    } finally {
      await f.clean();
    }
  });

test(
  'Cursor dashboard remains in parent with its cache and freshness options',
  { skip: process.platform !== 'win32', timeout: 30_000 },
  async (t) =>
    withHelperScope(t, async (helpers) => {
      const f = await fixture('cursor');
      const originalAppData = process.env.APPDATA;
      const originalFetch = globalThis.fetch;
      const enabled = cursorEditorUsage.enabled;
      let reads = 0;
      let environmentRestored = false;
      const restoreEnvironment = () => {
        if (environmentRestored) return;
        environmentRestored = true;
        globalThis.fetch = originalFetch;
        if (originalAppData === undefined) delete process.env.APPDATA;
        else process.env.APPDATA = originalAppData;
        cursorEditorUsage.enabled = enabled;
      };
      try {
        t.signal.throwIfAborted();
        t.signal.addEventListener('abort', restoreEnvironment, { once: true });
        t.after(restoreEnvironment);
        process.env.APPDATA = f.root;
        const file = cursorStateDatabase();
        await mkdir(dirname(file), { recursive: true });
        t.signal.throwIfAborted();
        const db = new DatabaseSync(file);
        db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
        const token = [
          'e30',
          Buffer.from(JSON.stringify({ sub: 'user_fixture', exp: 4_000_000_000 })).toString('base64url'),
          'c2ln',
        ].join('.');
        db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('cursorAuth/accessToken', token);
        db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('cursorAuth/cachedEmail', 'fixture@example.test');
        db.close();
        cursorEditorUsage.enabled = true;
        globalThis.fetch = async () => {
          reads++;
          return Response.json({
            billingCycleEnd: '2099-01-01T00:00:00Z',
            individualUsage: { plan: { used: 25, limit: 100 } },
          });
        };
        const metadata = await helpers.run(() => discoverNativeInHelper(f.target));
        const adapter = createCursorAdapter();
        // Each enrichment still crosses a new native-helper boundary. The provider
        // metadata was verified once; repeated provider subprocesses add no cache assertion.
        const discover = (options: Parameters<typeof adapter.discover>[1]) =>
          helpers.spoof(metadata, () => adapter.discover(f.target, options));
        const first = await discover({ quotaMaxAgeMs: 60_000 });
        assert.equal(first.quota.windows[0]?.usedPercent, 25);
        assert.equal(reads, 4, 'the parent, with its configured fetch and enabled setting, reads dashboard endpoints');
        const second = await discover({ quotaMaxAgeMs: 60_000 });
        assert.equal(second.quota.observedAt, first.quota.observedAt);
        assert.equal(reads, 4, 'a new metadata helper must not clear the parent dashboard cache');
        await discover({ quotaMaxAgeMs: 0 });
        assert.equal(reads, 8, 'an explicit fresh read must still bypass the cache');
        const verification = metadata.snapshot.cursorVerifiedIdentity!;
        const reference = (await helpers.spoof(
          {
            snapshot: { ...metadata.snapshot, status: 'error', note: 'runtime-timeout' },
            usageIdentity: { state: 'reference', verification },
          },
          () =>
            adapter.discover(f.target, {
              quotaMaxAgeMs: 0,
              cursorVerifiedIdentity: verification,
              cursorLastKnownQuota: first.quota,
            }),
        )) as typeof first;
        assert.equal(reference.quota.status, 'unknown');
        assert.equal(reference.lastKnownQuota?.observedAt, first.quota.observedAt);
        assert.equal(reads, 8, 'the supplied prior identity and quota remain display-only references in the parent');
      } finally {
        restoreEnvironment();
        t.signal.removeEventListener('abort', restoreEnvironment);
        await f.clean();
      }
    }),
);

type HelperScope = {
  run<T>(action: () => Promise<T>): Promise<T>;
  spoof<T>(reply: unknown, action: () => Promise<T>): Promise<T>;
};

// Node's test timeout does not stop the async body. Scope interception to this
// action, restore it synchronously on abort, and reap only helpers it started.
async function withHelperScope<T>(t: TestContext, action: (scope: HelperScope) => Promise<T>): Promise<T> {
  t.signal.throwIfAborted();
  const context = new AsyncLocalStorage<{ reply?: unknown }>();
  const original = childProcess.spawn;
  const children = new Set<ChildProcessWithoutNullStreams>();
  const entry = JSON.stringify(new URL('../src/server/native-discovery-helper.ts', import.meta.url).href);
  let active = true;
  let cleanup: Promise<void> | undefined;
  const intercept = ((...args: Parameters<typeof original>) => {
    const current = context.getStore();
    const argv = args[1];
    const helper =
      resolve(args[0]) === resolve(process.execPath) &&
      Array.isArray(argv) &&
      argv.length === 2 &&
      argv[0] === '-e' &&
      typeof argv[1] === 'string' &&
      argv[1].includes(entry) &&
      argv[1].includes('tsx/esm/api');
    if (!current || !helper) return original(...args);
    t.signal.throwIfAborted();
    if (!active) throw new Error('test-helper-scope-closed');
    const child = original(
      args[0],
      'reply' in current
        ? [
            '-e',
            "process.stdin.once('data', () => console.log(" +
              JSON.stringify(JSON.stringify(current.reply)) +
              ")); process.stdin.on('end', () => process.exit(0));",
          ]
        : argv,
      args[2] ?? {},
    ) as ChildProcessWithoutNullStreams;
    children.add(child);
    return child;
  }) as typeof original;
  const restore = () => {
    active = false;
    if (childProcess.spawn === intercept) {
      childProcess.spawn = original;
      syncBuiltinESMExports();
    }
  };
  const close = () => {
    restore();
    return (cleanup ??= Promise.all(
      [...children].map(async (child) => {
        await terminateProcess(child);
        assert.ok(child.exitCode !== null || child.signalCode !== null, 'the scoped helper must exit');
      }),
    ).then(() => undefined));
  };
  const onAbort = () => {
    void close().catch(() => {});
  };
  const step = async <R>(state: { reply?: unknown }, operation: () => Promise<R>): Promise<R> => {
    t.signal.throwIfAborted();
    if (!active) throw new Error('test-helper-scope-closed');
    const result = await context.run(state, operation);
    t.signal.throwIfAborted();
    return result;
  };
  try {
    childProcess.spawn = intercept;
    syncBuiltinESMExports();
    t.signal.addEventListener('abort', onAbort, { once: true });
    t.after(close);
    return await action({
      run: (operation) => step({}, operation),
      spoof: (reply, operation) => step({ reply }, operation),
    });
  } finally {
    t.signal.removeEventListener('abort', onAbort);
    try {
      await close();
    } finally {
      context.disable();
    }
  }
}

test('helper replies cannot substitute another target or provider', { timeout: 15_000 }, async (t) =>
  withHelperScope(t, async (helpers) => {
    const f = await fixture('claude');
    try {
      for (const changed of [
        { id: 'other-target', provider: 'claude' },
        { id: f.target.id, provider: 'cursor' },
      ])
        await helpers.spoof({ snapshot: changed }, () =>
          assert.rejects(discoverNativeInHelper(f.target), /runtime-protocol-incompatible/),
        );
      assert.equal((await f.trace()).length, 0);
    } finally {
      await f.clean();
    }
  }),
);

test(
  'Cursor helper identity must match the verified snapshot before dashboard enrichment',
  // One real Cursor metadata helper plus four independently spawned forged replies.
  { skip: process.platform !== 'win32', timeout: 30_000 },
  async (t) =>
    withHelperScope(t, async (helpers) => {
      const f = await fixture('cursor');
      try {
        const result = await helpers.run(() => discoverNativeInHelper(f.target));
        assert.equal(result.usageIdentity?.state, 'verified');
        for (const usageIdentity of [
          undefined,
          { state: 'missing' },
          { state: 'verified', email: 'another@example.test', userId: 'user_fixture' },
          { state: 'reference', verification: result.snapshot.cursorVerifiedIdentity },
        ])
          await helpers.spoof({ ...result, usageIdentity }, () =>
            assert.rejects(createCursorAdapter().discover(f.target), /runtime-protocol-incompatible/),
          );
      } finally {
        await f.clean();
      }
    }),
);

test('modern Cursor discovery reads the ACP catalog without spawning legacy models', { timeout: 45_000 }, async () => {
  const f = await fixture('cursor', { modern: true });
  try {
    const { snapshot } = await discoverNativeInHelper(f.target);
    assert.equal(snapshot.status, 'ready');
    assert.deepEqual(
      snapshot.models.map((model) => model.id),
      ['composer-2.5'],
    );
    assert.deepEqual((await f.trace()).map((row) => row.stage).sort(), ['about', 'acp', 'status', 'status']);
  } finally {
    await f.clean();
  }
});

test(
  'bundled native helper discovers Claude, Codex and Cursor from the installed directory',
  { timeout: 90_000 },
  async () => {
    const appRoot = await mkdtemp(join(fileURLToPath(new URL('.', import.meta.url)), '.native-helper-dist-'));
    const cwd = process.cwd();
    try {
      await build({
        entryPoints: ['src/server/native-discovery-client.ts', 'src/server/native-discovery-helper.ts'],
        absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
        bundle: true,
        platform: 'node',
        format: 'esm',
        packages: 'external',
        target: 'node24',
        outdir: join(appRoot, 'dist', 'server'),
      });
      const bundled = await import(pathToFileURL(join(appRoot, 'dist', 'server', 'native-discovery-client.js')).href);
      for (const provider of ['claude', 'codex', 'cursor'] as const) {
        const f = await fixture(provider);
        try {
          process.chdir(f.root);
          const { snapshot, usageIdentity } = await bundled.discoverNativeInHelper(f.target);
          assert.equal(snapshot.status, 'ready');
          assert.equal(snapshot.provider, provider);
          assert.equal(snapshot.id, f.target.id);
          if (provider === 'cursor') assert.equal(usageIdentity.state, 'verified');
          else assert.equal(snapshot.quota.windows[0]?.usedPercent, 12);
          for (const { pid } of await f.trace()) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
        } finally {
          process.chdir(cwd);
          await f.clean();
        }
      }
    } finally {
      process.chdir(cwd);
      await rm(appRoot, { recursive: true, force: true });
    }
  },
);

test('native helper timeout reaps a pending Claude metadata process', { timeout: 30_000 }, async () => {
  const f = await fixture('claude', { hang: 'auth' });
  try {
    await assert.rejects(discoverNativeInHelper(f.target, { timeoutMs: 10_000 }), /runtime-timeout/);
    const trace = await f.trace();
    assert.ok(trace.length);
    assert.ok(
      trace.every((row) => row.stage === 'auth'),
      'shutdown must close the gate before late control/usage startup',
    );
    for (const { pid } of trace) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    await f.clean();
  }
});

test(
  'application shutdown drains native helpers and prevents a late Cursor ACP launch',
  { timeout: 20_000 },
  async () => {
    const f = await fixture('cursor', { hang: 'status' });
    const pending = discoverNativeInHelper(f.target);
    const rejected = assert.rejects(pending, /operation-cancelled|runtime-process-closed/);
    try {
      const deadline = Date.now() + 10_000;
      while (!(await f.trace()).some((row) => row.stage === 'status')) {
        assert.ok(Date.now() < deadline);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await shutdownOwnedProcesses();
      await rejected;
      const trace = await f.trace();
      assert.ok(trace.every((row) => row.stage !== 'acp'));
      for (const { pid } of trace) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      await assert.rejects(discoverNativeInHelper(f.target), /operation-cancelled/);
    } finally {
      await f.clean();
    }
  },
);
