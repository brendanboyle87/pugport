import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import type { RuntimeTarget } from '../src/shared/types.ts';
import { createGrokAdapter } from '../src/server/adapters/grok.ts';
import { discoverNativeInHelper } from '../src/server/native-discovery-client.ts';
const discoverGrokInHelper = async (...args: Parameters<typeof discoverNativeInHelper>) =>
  (await discoverNativeInHelper(...args)).snapshot;
import {
  spawnTarget,
  terminateProcess,
  shutdownOwnedProcesses,
  windowsTreeKill,
} from '../src/server/adapters/process.ts';

const fixtureSource = `
const fs = require('node:fs');
const [configPath, tracePath, ...args] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const stage = args[0] === '--version' ? 'version' : args[0] === 'models' ? 'models' : args.includes('--deny') ? 'handshake' : 'quota';
fs.appendFileSync(tracePath, JSON.stringify({ pid: process.pid, stage }) + '\\n');
if (stage === 'handshake' && config.rejectHandshake) { console.error('error: unknown option --deny'); process.exit(2); }
if (config.hang === stage || (config.hang === 'metadata' && stage !== 'quota')) {
  process.stdin.resume(); setInterval(() => {}, 1000);
} else if (stage === 'version') console.log('grok 1.0.67');
else if (stage === 'models') {
  if (config.expired) console.error('authentication required');
  console.log('You are logged in with grok.com.\\n - grok-4.7');
} else {
  let buffer = '';
  process.stdin.on('data', chunk => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\\n')) >= 0) {
      const packet = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
      if (packet.method !== 'initialize' && packet.method !== '_x.ai/billing' && packet.method !== '_x.ai/interject') process.exit(12);
      if (packet.method === '_x.ai/interject' && config.unsupported) { console.log(JSON.stringify({ jsonrpc: '2.0', id: packet.id, error: { code: -32601 } })); continue; }
      const result = packet.method === 'initialize' ? { protocolVersion: 1 } : packet.method === '_x.ai/interject' ? {} : {
        config: { creditUsagePercent: config.used, currentPeriod: { type: 'WEEKLY', start: '2026-10-19T00:00:00Z', end: '2026-10-26T00:00:00Z' } }
      };
      console.log(JSON.stringify({ jsonrpc: '2.0', id: packet.id, result }));
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

`;

async function fixture(config: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'grok-discovery-helper-'));
  const script = join(root, 'fixture.cjs');
  const configPath = join(root, 'config.json');
  const tracePath = join(root, 'trace.jsonl');
  await writeFile(script, fixtureSource);
  await writeFile(configPath, JSON.stringify({ used: 12, ...config }));
  const target: RuntimeTarget = {
    id: 'synthetic-grok',
    provider: 'grok',
    label: 'Synthetic Grok',
    command: process.execPath,
    args: [script, configPath, tracePath],
    agentDir: root,
    environment: 'native',
    enabled: true,
  };
  const trace = async () =>
    (await readFile(tracePath, 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { pid: number; stage: string });
  return {
    target,
    root,
    trace,
    set: (value: Record<string, unknown>) => writeFile(configPath, JSON.stringify(value)),
    clean: () => rm(root, { recursive: true, force: true }),
  };
}

async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, 'synthetic discovery did not reach expected stage');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function assertReaped(f: Awaited<ReturnType<typeof fixture>>) {
  const entries = await f.trace();
  assert.ok(entries.length);
  for (const { pid } of entries) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}

test('helper forwards Grok handshake discovery options', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const same = await discoverGrokInHelper(f.target, {
      discovery: { grokHandshake: { lastPassedVersion: '1.0.67' } },
    });
    assert.equal(same.status, 'ready');
    assert.equal((await f.trace()).filter((row) => row.stage === 'handshake').length, 0);
    await discoverGrokInHelper(f.target, {
      discovery: { grokHandshake: { lastPassedVersion: '1.0.67', afterStartupFailure: true } },
    });
    assert.equal((await f.trace()).filter((row) => row.stage === 'handshake').length, 1);
  } finally {
    await f.clean();
  }
});

test('fake Grok rejects handshake flags with a startup diagnostic', { timeout: 30_000 }, async () => {
  const f = await fixture({ rejectHandshake: true });
  try {
    const snapshot = await discoverGrokInHelper(f.target, {
      discovery: { grokHandshake: { lastPassedVersion: '1.0.66' } },
    });
    assert.equal(snapshot.status, 'error');
    assert.match(snapshot.errorDetail ?? '', /unknown option --deny/);
  } finally {
    await f.clean();
  }
});

test('fake older Grok stays ready without steer', { timeout: 30_000 }, async () => {
  const f = await fixture({ unsupported: true });
  try {
    const snapshot = await discoverGrokInHelper(f.target, {
      discovery: { grokHandshake: { lastPassedVersion: '1.0.66' } },
    });
    assert.equal(snapshot.status, 'ready');
    assert.equal(snapshot.capabilities.steer, false);
  } finally {
    await f.clean();
  }
});

test(
  'production Grok discovery delegates metadata/quota to one owned helper and reads fresh state',
  { skip: process.platform !== 'win32', timeout: 40_000 },
  async () => {
    const f = await fixture();
    const original = childProcess.spawn;
    const mainSpawns: { command: string; args: readonly string[]; pid?: number }[] = [];
    childProcess.spawn = ((...args: Parameters<typeof original>) => {
      const child = original(...args);
      mainSpawns.push({ command: args[0], args: Array.isArray(args[1]) ? args[1] : [], pid: child.pid });
      return child;
    }) as typeof original;
    syncBuiltinESMExports();
    let beats = 0;
    const heartbeat = setInterval(() => beats++, 10);
    try {
      const adapter = createGrokAdapter();
      const first = await adapter.discover(f.target);
      assert.equal(first.status, 'ready');
      assert.equal(first.quota.windows[0]?.usedPercent, 12);
      assert.equal(first.version, '1.0.67');
      assert.equal(first.accounting?.mode, 'subscription');
      const [helper, ...cleanup] = mainSpawns;
      assert.ok(helper?.pid);
      assert.equal(helper.args[0], '-e');
      assert.match(helper.args[1]!, /native-discovery-helper/);
      for (const child of cleanup)
        assert.deepEqual({ file: child.command, args: child.args }, windowsTreeKill(helper.pid));
      assert.ok(beats > 2, 'main thread must remain responsive during discovery');
      await assertReaped(f);
      await f.set({ used: 71 });
      const second = await adapter.discover({ ...f.target, id: 'current-target', label: 'Current target' });
      assert.equal(second.id, 'current-target');
      assert.equal(second.label, 'Current target');
      assert.equal(second.quota.windows[0]?.usedPercent, 71);
      await f.set({ expired: true });
      const expired = await adapter.discover(f.target);
      assert.equal(expired.status, 'auth-required');
      assert.equal(expired.quota.status, 'unknown');
      assert.equal((await f.trace()).filter((row) => row.stage === 'quota').length, 2);
      await assertReaped(f);
    } finally {
      clearInterval(heartbeat);
      childProcess.spawn = original;
      syncBuiltinESMExports();
      await f.clean();
    }
  },
);

test(
  'discovery timeout reaps metadata CLI processes and cannot launch a late quota probe',
  { timeout: 25_000 },
  async () => {
    const f = await fixture({ hang: 'metadata' });
    try {
      await assert.rejects(discoverGrokInHelper(f.target, { timeoutMs: 6000 }), /runtime-timeout/);
      await assertReaped(f);
      assert.equal(
        (await f.trace()).some((row) => row.stage === 'quota'),
        false,
      );
    } finally {
      await f.clean();
    }
  },
);

test('an immediate timeout cancels helper startup without a late metadata launch', { timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    await assert.rejects(discoverGrokInHelper(f.target, { timeoutMs: 1 }), /runtime-timeout/);
    assert.equal((await f.trace()).length, 0);
  } finally {
    await f.clean();
  }
});

test('helper startup consumes the same timeout budget and cannot dispatch after that budget', async () => {
  const original = childProcess.spawn;
  let requests = 0;
  const child = Object.assign(new EventEmitter(), {
    // A started child always has a process id; macOS and Linux stop it through its process group, which needs one.
    // This id is above every system's process limit, so the group check finds no process to signal.
    pid: 2 ** 31 - 1,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null,
  });
  child.stdin.on('data', () => {
    requests++;
    child.stdout.write(JSON.stringify({ snapshot: { id: 'budget-fixture', provider: 'grok' } }) + '\n');
  });
  child.stdin.once('finish', () => {
    child.exitCode = 0;
    child.emit('close', 0);
  });
  childProcess.spawn = (() => {
    setTimeout(() => child.emit('spawn'), 25);
    return child;
  }) as unknown as typeof original;
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      discoverGrokInHelper(
        {
          id: 'budget-fixture',
          provider: 'grok',
          label: 'Synthetic',
          command: process.execPath,
          environment: 'native',
          enabled: true,
        },
        { timeoutMs: 1 },
      ),
      /runtime-timeout/,
    );
    assert.equal(requests, 0);
    assert.equal(child.exitCode, 0, 'cleanup is still awaited before the timeout is returned');
  } finally {
    childProcess.spawn = original;
    syncBuiltinESMExports();
  }
});

test(
  'helper rejects an expired request before metadata even while parent stdin stays open',
  { timeout: 15_000 },
  async () => {
    const f = await fixture();
    const entry = new URL('../src/server/native-discovery-helper.ts', import.meta.url).href;
    const helper = await spawnTarget(
      { ...f.target, args: [] },
      [
        '-e',
        `import('tsx/esm/api').then(({tsImport}) => tsImport(${JSON.stringify(entry)}, ${JSON.stringify(import.meta.url)}))`,
      ],
      { cwd: fileURLToPath(new URL('..', import.meta.url)) },
    );
    let timer: NodeJS.Timeout | undefined;
    try {
      const reply = new Promise<{ error?: string }>((resolve, reject) => {
        let buffer = '';
        timer = setTimeout(() => reject(new Error('helper reply missing')), 10_000);
        helper.stdout.setEncoding('utf8');
        helper.stdout.on('data', (chunk) => {
          buffer += chunk;
          const newline = buffer.indexOf('\n');
          if (newline >= 0) resolve(JSON.parse(buffer.slice(0, newline)));
        });
        helper.once('error', reject);
        helper.stderr.resume();
      });
      helper.stdin.write(JSON.stringify({ target: f.target, expiresAt: Date.now() - 1 }) + '\n');
      assert.equal((await reply).error, 'runtime-timeout');
      assert.equal((await f.trace()).length, 0);
    } finally {
      clearTimeout(timer);
      await terminateProcess(helper);
      assert.ok(helper.exitCode !== null || helper.signalCode !== null);
      for (const { pid } of await f.trace()) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      await f.clean();
    }
  },
);

test(
  'bundled helper loads from the installed directory even when the caller cwd is a user project',
  { timeout: 25_000 },
  async () => {
    const appRoot = await mkdtemp(join(fileURLToPath(new URL('.', import.meta.url)), '.grok-helper-dist-'));
    const f = await fixture({ used: 43 });
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
      process.chdir(f.root);
      const bundled = await import(pathToFileURL(join(appRoot, 'dist', 'server', 'native-discovery-client.js')).href);
      const { snapshot } = await bundled.discoverNativeInHelper(f.target);
      assert.equal(snapshot.status, 'ready');
      assert.equal(snapshot.quota.windows[0]?.usedPercent, 43);
      await assertReaped(f);
    } finally {
      process.chdir(cwd);
      await f.clean();
      await rm(appRoot, { recursive: true, force: true });
    }
  },
);

test('helper discovery errors retain sanitized snapshot semantics', { timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    const snapshot = await discoverGrokInHelper({ ...f.target, command: join(f.root, 'missing-grok.exe') });
    assert.equal(snapshot.status, 'missing');
    assert.equal(snapshot.installed, false);
    assert.equal(snapshot.note, 'runtime-not-found');
    assert.equal((await f.trace()).length, 0);
  } finally {
    await f.clean();
  }
});

test(
  'application shutdown waits for metadata and quota helpers and blocks later discovery',
  { timeout: 30_000 },
  async () => {
    const metadata = await fixture({ hang: 'metadata' });
    const quota = await fixture({ hang: 'quota' });
    const pending = [discoverGrokInHelper(metadata.target), discoverGrokInHelper(quota.target)];
    const rejected = Promise.all(
      pending.map((job) => assert.rejects(job, /operation-cancelled|runtime-process-closed/)),
    );
    try {
      await waitFor(
        async () => (await metadata.trace()).length === 2 && (await quota.trace()).some((row) => row.stage === 'quota'),
      );
      await shutdownOwnedProcesses();
      await rejected;
      await assertReaped(metadata);
      await assertReaped(quota);
      assert.equal(
        (await metadata.trace()).some((row) => row.stage === 'quota'),
        false,
      );
      await assert.rejects(discoverGrokInHelper(quota.target), /operation-cancelled/);
    } finally {
      await metadata.clean();
      await quota.clean();
    }
  },
);
