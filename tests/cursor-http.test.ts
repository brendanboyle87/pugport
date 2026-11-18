import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { fork, type ChildProcess } from '../src/server/platform/test-process.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { AppState, RuntimeSnapshot, RuntimeTarget } from '../src/shared/types.ts';
import type { ManualResetNote } from '../src/shared/manual-reset.ts';
import { Store } from '../src/server/store.ts';

// The server is a forked tsx process that discovers a Node CLI fixture. Its isolated TEMP gives tsx a cold compile
// cache, so on a busy machine startup alone can exceed a minute, and discovery, shutdown and each request can also take
// far longer than usual. Every wait below ends on the awaited event; this guard only ends a genuine hang.
const GUARD_MS = 120_000;

test(
  'Cursor HTTP manual snapshots bind fresh CLI identities without inference or cached-GET probes',
  { timeout: 5 * GUARD_MS },
  async (t) => {
    const sourceRoot = resolve(import.meta.dirname, '..');
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'cursor-http-test-')));
    const appRoot = join(directory, 'app'),
      dataDir = join(directory, '.data');
    const cli = join(directory, 'mock-cursor.mjs'),
      identityFile = join(directory, 'identity.json'),
      log = join(directory, 'calls.jsonl');
    let child: ChildProcess | undefined;
    let exited: Promise<number | null> | undefined;
    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        let timer: NodeJS.Timeout | undefined;
        if (child.connected) {
          child.send('shutdown');
          await Promise.race([
            exited,
            new Promise<void>((done) => {
              timer = setTimeout(done, GUARD_MS);
            }),
          ]);
          clearTimeout(timer);
        }
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
          await Promise.race([
            exited,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('Synthetic HTTP server did not exit')), GUARD_MS);
            }),
          ]);
          clearTimeout(timer);
        }
      }
      const absolute = resolve(directory),
        temp = realpathSync.native(tmpdir());
      assert.ok(absolute.startsWith(temp + sep) && basename(absolute).startsWith('cursor-http-test-'));
      assert.ok(resolve(dataDir).startsWith(absolute + sep));
      assert.notEqual(resolve(dataDir), resolve(sourceRoot, '.data'));
      rmSync(absolute, { recursive: true, force: true });
    });
    mkdirSync(appRoot);
    writeFileSync(identityFile, JSON.stringify({ userId: 'synthetic-cursor-a', email: 'synthetic-a@example.test' }));
    writeFileSync(
      cli,
      `
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync } from 'node:fs';
const identityFile = ${JSON.stringify(identityFile)}, log = ${JSON.stringify(log)};
// Discovery launches ACP with its execution flags (\`--model auto --mode ask acp\`).
const action = process.argv.at(-1) === 'acp' ? 'acp' : process.argv[2];
const record = row => appendFileSync(log, JSON.stringify(row) + '\\n');
record({ action });
// captureTarget closes stdin after attaching output/close listeners. Honor that metadata-only handshake
// so this tiny fixture cannot finish before a Windows subprocess observer is attached.
if (action !== 'acp') await new Promise(done => { process.stdin.once('end', done); process.stdin.resume(); });
if (action === 'status') {
  const identity = JSON.parse(readFileSync(identityFile, 'utf8'));
  record({ action: 'status-result', userId: identity.userId });
  await new Promise(done => process.stdout.write(JSON.stringify({ isAuthenticated: true, status: 'authenticated', userInfo: identity }) + '\\n', done));
  process.exit(0);
}
if (action === 'about') { const identity = JSON.parse(readFileSync(identityFile, 'utf8')); await new Promise(done => process.stdout.write(JSON.stringify({ cliVersion: '2026.10.03-fixture', subscriptionTier: 'Pro', userEmail: identity.email }) + '\\n', done)); process.exit(0); }
if (action === 'models') { await new Promise(done => process.stdout.write('auto - Auto (default)\\nfixture-model - Synthetic Cursor Model\\n', done)); process.exit(0); }
if (action !== 'acp') { record({ forbidden: action }); process.exit(50); }
const input = createInterface({ input: process.stdin });
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
input.on('line', line => {
  const request = JSON.parse(line);
  record({ method: request.method });
  if (request.method === 'initialize') return send({ id: request.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: {} } } });
  // This legacy peer has no parameter catalog. Discovery may probe support but must never create a session.
  if (request.method === 'cursor/list_available_models') return send({ id: request.id, error: { code: -32601, message: 'Method not found' } });
  record({ forbidden: request.method });
  send({ id: request.id, error: { code: -32000, message: 'Synthetic metadata-only fixture forbids sessions and inference.' } });
});
input.on('close', () => process.exit(0));
`,
    );
    const targets: RuntimeTarget[] = [
      {
        id: 'cursor-native',
        provider: 'cursor',
        label: 'Synthetic Cursor',
        command: process.execPath,
        args: [cli],
        environment: 'native',
        enabled: true,
        commandDiscovery: 'fixed',
      },
      {
        id: 'gemini-native',
        provider: 'gemini',
        label: 'Disabled synthetic Gemini',
        command: 'unused',
        environment: 'native',
        enabled: false,
        commandDiscovery: 'fixed',
      },
      {
        id: 'pi-local',
        provider: 'pi',
        label: 'Disabled synthetic Pi',
        command: 'unused',
        environment: 'native',
        enabled: false,
        commandDiscovery: 'fixed',
      },
    ];
    const store = new Store(dataDir);
    try {
      store.setConfig('targets', targets);
      store.setConfig('settings', {
        refreshSeconds: 600,
        architectureProvider: 'cursor',
        designProvider: 'cursor',
        routineProvider: 'cursor',
        defaultProjectPath: directory,
      });
    } finally {
      store.close();
    }
    // Empty temp app/home paths prevent sourceRoot's bundled Everything or any real provider profile from
    // being discovered, stopped at shutdown, or read. Only the Node protocol fixture above is executable.
    child = fork(join(sourceRoot, 'src', 'server', 'main.ts'), [], {
      cwd: sourceRoot,
      execArgv: ['--import', 'tsx'],
      windowsHide: true,
      env: {
        PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
        PATHEXT: process.env.PATHEXT,
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        ComSpec: process.env.ComSpec,
        TEMP: directory,
        TMP: directory,
        USERPROFILE: directory,
        HOME: directory,
        APPDATA: join(directory, 'roaming'),
        LOCALAPPDATA: join(directory, 'local'),
        CODEX_HOME: join(directory, 'codex'),
        CLAUDE_CONFIG_DIR: join(directory, 'claude'),
        COMBORUNNER_ROOT: appRoot,
        COMBORUNNER_DATA_DIR: dataDir,
        COMBORUNNER_MEMORY_DIR: join(directory, 'private-memory'),
        COMBORUNNER_IMAGE_INDEX_DIR: join(directory, 'image-index'),
        COMBORUNNER_IMAGE_BACKGROUND: '0',
        COMBORUNNER_PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output = (output + chunk).slice(-4000);
    });
    child.stderr?.on('data', (chunk) => {
      output = (output + chunk).slice(-4000);
    });
    exited = new Promise((done) => child!.once('exit', done));
    let token = '';
    let owner = '';
    const port = await new Promise<number>((done, reject) => {
      const server = child!;
      const startedAt = Date.now();
      const diagnostic = () =>
        `elapsed=${Date.now() - startedAt}ms pid=${server.pid ?? 'unassigned'} exit=${server.exitCode} signal=${server.signalCode}; output=${output || '(none)'}`;
      const cleanup = () => {
        clearTimeout(timer);
        server.off('error', onError);
        server.off('exit', onExit);
        server.off('message', onMessage);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(new Error(`Synthetic server startup failed: ${diagnostic()}`, { cause: error }));
      };
      const onExit = (code: number | null) => {
        cleanup();
        reject(new Error(`Synthetic server exited ${code}: ${diagnostic()}`));
      };
      const onMessage = (message: unknown) => {
        const value = message as {
          type?: string;
          token?: string;
          owner?: string;
          port?: number;
          dataDir?: string;
          error?: string;
        };
        if (value.type === 'session') {
          token = value.token ?? '';
          owner = value.owner ?? '';
        }
        if (value.type === 'fatal') return onError(new Error(value.error || 'Synthetic server fatal error'));
        if (value.type === 'ready' && value.port) {
          cleanup();
          try {
            assert.equal(value.dataDir, dataDir);
            done(value.port);
          } catch (error) {
            reject(error);
          }
        }
      };
      // A cold tsx/server import can take long beside other integration tests on Windows. This bound covers
      // startup only; all metadata, identity and inference assertions still run below.
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Synthetic server startup timed out: ${diagnostic()}`));
      }, GUARD_MS);
      server.once('error', onError);
      server.once('exit', onExit);
      server.on('message', onMessage);
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    const request = async <T>(
      path: string,
      body?: unknown,
      method = body === undefined ? 'GET' : 'POST',
      expectedStatus = 200,
    ) => {
      const response = await fetch(baseUrl + path, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-agent-token': token, 'x-pugport-owner': owner },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(GUARD_MS),
      }).catch((error) => {
        throw new Error(
          `${method} ${path} (${body && typeof body === 'object' ? Object.keys(body).join(',') : ''}) failed: ${String(error)}; synthetic calls=${existsSync(log) ? readFileSync(log, 'utf8') : '(none)'}; server=${output}`,
        );
      });
      const value = await response.json();
      assert.equal(response.status, expectedStatus, JSON.stringify(value));
      return value as T;
    };
    const state = () => request<AppState>('/api/state');
    const calls = () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map(
              (line) => JSON.parse(line) as { action?: string; method?: string; forbidden?: string; userId?: string },
            )
        : [];
    const statusCount = () => calls().filter((row) => row.action === 'status').length;
    const hash = (id: string) =>
      createHash('sha256')
        .update(JSON.stringify(['cursor', 'user_id', id]))
        .digest('hex');
    const hashA = hash('synthetic-cursor-a'),
      hashB = hash('synthetic-cursor-b');
    let initial: AppState | undefined;
    for (const end = Date.now() + GUARD_MS; Date.now() < end;) {
      const current = await state();
      if (!current.refreshing && current.runtimes.some((row) => row.id === 'cursor-native' && row.status === 'ready')) {
        initial = current;
        break;
      }
      await new Promise((done) => setTimeout(done, 30));
    }
    assert.ok(initial, `Synthetic metadata discovery failed: ${output}`);
    const snapshot = (value: AppState): RuntimeSnapshot => value.runtimes.find((row) => row.id === 'cursor-native')!;
    assert.equal(snapshot(initial).subscription?.label, 'Pro');
    assert.equal(snapshot(initial).accountFingerprint, hashA);
    assert.deepEqual(
      snapshot(initial).models.map((model) => model.id),
      ['auto', 'fixture-model'],
    );
    assert.equal(snapshot(initial).quota.status, 'unknown');
    assert.deepEqual(snapshot(initial).quota.windows, []);
    assert.equal(initial.runtimes.length, 1, 'no real provider metadata may be discovered');
    const endpoint = '/api/manual-resets/cursor-native';
    const probes = statusCount();
    assert.deepEqual(await request<ManualResetNote[]>(endpoint), []);
    await state();
    assert.deepEqual(await request<ManualResetNote[]>(endpoint), []);
    assert.equal(statusCount(), probes, 'GET views must consume cached metadata only');

    const credit = {
      kind: 'subscription-credit',
      creditPool: 'event',
      label: 'Synthetic activity credit',
      count: null,
      remainingUsd: 25,
      totalUsd: 25,
      expiresOn: '2020-01-01',
      expiresAt: null,
      expiryPrecision: 'estimated',
      status: 'available',
      source: 'Synthetic dashboard observation',
      observedAt: '2020-01-01T12:00:00.000Z',
      note: '',
      expectedAccountFingerprint: hashA,
    };
    const first = await request<ManualResetNote[]>(endpoint, credit);
    assert.equal(statusCount(), probes + 1, 'POST independently verifies current CLI status');
    const activity = first[0]!;
    assert.equal(activity.accountFingerprint, hashA);
    assert.equal(activity.provider, 'cursor');
    assert.equal(activity.identityStatus, 'matched');
    assert.equal(activity.remainingUsd, 25, 'a passed estimated date never clears a manually observed balance');
    assert.equal(activity.expiryPrecision, 'estimated');
    assert.equal('expectedAccountFingerprint' in activity, false);
    const usage = {
      kind: 'subscription-usage',
      label: 'Synthetic billing pools',
      count: null,
      expiresOn: null,
      expiresAt: null,
      status: 'available',
      source: 'Synthetic dashboard observation',
      observedAt: credit.observedAt,
      note: '',
      expectedAccountFingerprint: hashA,
      subscriptionUsage: {
        cycleResetsOn: '2026-10-29',
        cycleResetsAt: null,
        cycleResetPrecision: 'date',
        onDemandEnabled: false,
        pools: [
          { id: 'cursor-models', usedPercent: 0 },
          { id: 'other-models', usedPercent: 0 },
        ],
      },
    };
    const notes = await request<ManualResetNote[]>(endpoint, usage);
    assert.equal(notes.length, 2);
    assert.ok(notes.every((row) => row.accountFingerprint === hashA && row.identityStatus === 'matched'));
    assert.deepEqual(
      notes.find((row) => row.kind === 'subscription-usage')!.subscriptionUsage,
      usage.subscriptionUsage,
    );
    for (const injected of [{ accountFingerprint: hashB }, { provider: 'cursor' }, { identityStatus: 'matched' }]) {
      const failure = await request<{ error: string }>(endpoint, { ...credit, ...injected }, 'POST', 400);
      assert.match(failure.error, new RegExp(Object.keys(injected)[0]!), JSON.stringify(calls()));
    }
    assert.match(
      (await request<{ error: string }>(endpoint, { ...credit, expectedAccountFingerprint: hashB }, 'POST', 400)).error,
      /身份已更改/,
    );
    const { expectedAccountFingerprint: _assertion, ...missingAssertion } = credit;
    await request(endpoint, missingAssertion, 'POST', 400);
    assert.equal((await request<ManualResetNote[]>(endpoint)).length, 2);

    writeFileSync(identityFile, JSON.stringify({ userId: 'synthetic-cursor-b', email: 'synthetic-b@example.test' }));
    assert.equal(
      snapshot(await state()).accountFingerprint,
      hashA,
      'fixture identity changes independently of the cached snapshot',
    );
    const beforeCachedGet = statusCount();
    assert.ok((await request<ManualResetNote[]>(endpoint)).every((row) => row.identityStatus === 'matched'));
    assert.equal(statusCount(), beforeCachedGet);
    await request(endpoint, { ...credit, id: activity.id, remainingUsd: 20 }, 'POST', 400);
    await request(`${endpoint}/${activity.id}`, { expectedAccountFingerprint: hashA }, 'DELETE', 400);
    assert.equal(
      statusCount(),
      beforeCachedGet + 2,
      'both writes reject stale cached identities by reading fresh status',
    );
    const retained = await request<ManualResetNote[]>(endpoint);
    assert.equal(retained.length, 2);
    assert.equal(retained.find((row) => row.id === activity.id)!.remainingUsd, 25);
    assert.equal(snapshot(await state()).accountFingerprint, hashA);

    const refreshed = await request<AppState>('/api/refresh', {});
    assert.equal(snapshot(refreshed).accountFingerprint, hashB);
    const prior = await request<ManualResetNote[]>(endpoint);
    assert.ok(prior.every((row) => row.identityStatus === 'different' && row.accountFingerprint === hashA));
    assert.equal(prior.find((row) => row.id === activity.id)!.remainingUsd, 25);
    const current = await request<ManualResetNote[]>(endpoint, {
      ...credit,
      label: 'Synthetic B account credit',
      creditPool: 'account',
      remainingUsd: 40,
      totalUsd: 40,
      expectedAccountFingerprint: hashB,
      expiryPrecision: 'unknown',
      expiresOn: null,
    });
    assert.equal(current.length, 3);
    const newNote = current.find((row) => row.label === 'Synthetic B account credit')!;
    assert.equal(newNote.accountFingerprint, hashB);
    assert.equal(newNote.identityStatus, 'matched');
    assert.ok(current.filter((row) => row.id !== newNote.id).every((row) => row.identityStatus === 'different'));
    await request(`${endpoint}/${newNote.id}`, { expectedAccountFingerprint: hashA }, 'DELETE', 400);
    const removed = await request<ManualResetNote[]>(
      `${endpoint}/${newNote.id}`,
      { expectedAccountFingerprint: hashB },
      'DELETE',
    );
    assert.equal(removed.length, 2);
    const final = await state();
    assert.equal(final.runs.length, 0);
    assert.deepEqual(snapshot(final).quota.windows, [], 'manual pools never become automatically routable quota');
    assert.ok(calls().some((row) => row.method === 'initialize'));
    assert.deepEqual(
      calls().filter((row) => row.forbidden !== undefined),
      [],
      'no session/new, session/load, prompt or other inference method may run',
    );
  },
);
