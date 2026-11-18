import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, toNamespacedPath } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { defaultHindsightSettings } from '../src/shared/hindsight.ts';
import { HindsightRuntime, hindsightDatabaseUrl, type HindsightRuntimeHost } from '../src/server/hindsight-runtime.ts';

function fixture(ready: boolean | 'manual' = true) {
  const stateDir = mkdtempSync(join(tmpdir(), 'pugport-hindsight-runtime-'));
  const settings = {
    ...defaultHindsightSettings,
    enabled: true,
    pythonExecutable: join(stateDir, 'python.exe'),
    runtimeId: 'managed',
    projectIds: ['project'],
  };
  const spawned: { args: string[]; options: Record<string, unknown>; config?: Record<string, unknown> }[] = [];
  const memory = { bytes: 8 * 1024 ** 3 };
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null,
    kill() {
      this.exitCode = 1;
      child.emit('exit', 1);
      return true;
    },
  });
  const runtime = new HindsightRuntime({
    stateDir,
    pg0InstancesDir: join(stateDir, 'synthetic-pg0-instances'),
    scriptPath: join(stateDir, 'hindsight-service.py'),
    getSettings: () => settings,
    controller: { targets: [] } as unknown as HindsightRuntimeHost['controller'],
    startupTimeoutMs: 100,
    freeMemory: () => memory.bytes,
    memoryCheckIntervalMs: 5,
    spawn: ((_command: string, args: string[], options: Record<string, unknown>) => {
      const capture = { args, options, config: undefined as Record<string, unknown> | undefined };
      spawned.push(capture);
      child.stdin.on('data', (chunk: Buffer) => {
        if (chunk.toString().trim() === 'stop') {
          child.exitCode = 0;
          queueMicrotask(() => child.emit('exit', 0));
          return;
        }
        capture.config = JSON.parse(chunk.toString());
        if (ready === true) queueMicrotask(() => child.stdout.write('PUGPORT_HINDSIGHT_READY 1.1.0\n'));
        else if (ready === false)
          queueMicrotask(() => {
            child.exitCode = 1;
            child.emit('exit', 1);
          });
      });
      return child;
    }) as unknown as HindsightRuntimeHost['spawn'],
  });
  return {
    runtime,
    settings,
    stateDir,
    spawned,
    memory,
    child,
    async close() {
      await runtime.stop();
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

test('optional runtime stays disabled and never starts an unconfigured Python executable', async () => {
  const f = fixture();
  try {
    f.settings.enabled = false;
    await f.runtime.start();
    assert.deepEqual(f.runtime.status(), { state: 'disabled' });
    assert.equal(f.runtime.endpoint(), null);
    f.settings.enabled = true;
    f.settings.pythonExecutable = 'python';
    await f.runtime.start();
    assert.equal(f.runtime.status().state, 'unavailable');
    assert.equal(f.spawned.length, 0);
  } finally {
    await f.close();
  }
});

test('low host memory defers the optional service without spawning or creating a database', async () => {
  const f = fixture();
  try {
    f.memory.bytes = 2 * 1024 ** 3;
    await f.runtime.start();
    assert.equal(f.spawned.length, 0);
    assert.match(f.runtime.status().detail ?? '', /memory is low/);
    assert.throws(() => statSync(join(f.stateDir, 'database.json')), { code: 'ENOENT' });
    f.memory.bytes = 8 * 1024 ** 3;
    await f.runtime.start();
    assert.equal(f.spawned.length, 1);
    assert.ok(f.runtime.endpoint());
  } finally {
    await f.close();
  }
});

for (const phase of ['startup', 'ready'] as const) {
  test(`memory pressure stops the optional service during ${phase} and preserves the reason`, async () => {
    const f = fixture(phase === 'ready' ? true : 'manual');
    try {
      const starting = f.runtime.start();
      if (phase === 'ready') await starting;
      else while (!f.spawned.length) await new Promise((resolve) => setTimeout(resolve, 1));
      f.memory.bytes = 512 * 1024 ** 2;
      const deadline = Date.now() + 2000;
      while (f.child.exitCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
      await starting;
      assert.equal(f.child.exitCode, 0);
      assert.equal(f.runtime.endpoint(), null);
      assert.equal(f.runtime.status().state, 'unavailable');
      assert.match(f.runtime.status().detail ?? '', /memory is low/);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(f.spawned.length, 1, 'pressure does not trigger an automatic restart loop');
    } finally {
      await f.close();
    }
  });
}

test('owned runtime uses a hidden isolated process and only in-process ephemeral credentials', async () => {
  const f = fixture();
  try {
    await Promise.all([f.runtime.start(), f.runtime.start()]);
    assert.equal(f.spawned.length, 1);
    assert.deepEqual(f.runtime.status(), { state: 'ready', version: '1.1.0' });
    const { args, options, config } = f.spawned[0];
    assert.deepEqual(args.slice(0, 4), ['-I', '-X', 'utf8', '-u']);
    assert.equal(options.windowsHide, true);
    assert.equal(options.shell, false);
    const env = options.env as Record<string, string>;
    assert.equal(env.HOME, join(f.stateDir, 'home'));
    assert.equal(env.USERPROFILE, env.HOME);
    assert.equal(
      Object.keys(env).some((key) => /HINDSIGHT|API_KEY|TOKEN/.test(key)),
      false,
    );
    assert.match(String(config?.bridgeUrl), /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    assert.equal(String(config?.bridgeToken).length, 64);
    assert.equal(String(config?.token).length, 64);
    assert.notEqual(config?.token, config?.bridgeToken);
    assert.equal(JSON.stringify(f.runtime.status()).includes(String(config?.token)), false);
    assert.equal(f.runtime.endpoint()?.token, config?.token);
    const identity = JSON.parse(readFileSync(join(f.stateDir, 'database.json'), 'utf8'));
    assert.match(String(config?.databaseUrl), /^pg0:\/\/pugport_[a-f0-9]{16}:[a-f0-9]{64}@pugport-[a-f0-9]{32}$/);
    assert.equal(JSON.stringify(options).includes(identity.password), false);
    assert.equal(JSON.stringify(args).includes(identity.password), false);
    assert.equal(JSON.stringify(f.runtime.status()).includes(identity.password), false);
    await f.runtime.stop();
    assert.equal(f.runtime.endpoint(), null);
    assert.equal(f.child.exitCode, 0);
  } finally {
    await f.close();
  }
});

test('database credentials persist privately and a missing identity never replaces an existing database', async () => {
  const f = fixture();
  try {
    const directory = join(f.stateDir, 'synthetic-pg0-instances');
    const first = await hindsightDatabaseUrl(f.stateDir, directory);
    assert.equal(await hindsightDatabaseUrl(f.stateDir, directory), first);
    assert.doesNotMatch(first, /hindsight:hindsight/);
    const identity = JSON.parse(readFileSync(join(f.stateDir, 'database.json'), 'utf8'));
    assert.equal(readFileSync(join(f.stateDir, 'database-instance'), 'utf8'), identity.instance);
    unlinkSync(join(f.stateDir, 'database.json'));
    await assert.rejects(hindsightDatabaseUrl(f.stateDir, directory), /saved database identity/);
  } finally {
    await f.close();
  }
});

test(
  'Windows extended paths retain the same private database identity',
  { skip: process.platform !== 'win32' },
  async () => {
    const f = fixture();
    try {
      const directory = join(f.stateDir, 'synthetic-pg0-instances');
      const first = await hindsightDatabaseUrl(f.stateDir, directory);
      const extended = toNamespacedPath(f.stateDir);
      assert.equal(await hindsightDatabaseUrl(extended, toNamespacedPath(directory)), first);
      assert.equal(statSync(join(extended, 'database.json')).ino, statSync(join(f.stateDir, 'database.json')).ino);
      assert.equal(
        readFileSync(join(extended, 'database-instance'), 'utf8'),
        readFileSync(join(f.stateDir, 'database-instance'), 'utf8'),
      );
    } finally {
      await f.close();
    }
  },
);

test('failed startup is optional and does not expose child diagnostics or endpoints', async () => {
  const f = fixture(false);
  try {
    await f.runtime.start();
    assert.equal(f.runtime.status().state, 'unavailable');
    assert.equal(f.runtime.endpoint(), null);
    await assert.rejects(
      f.runtime.withJob({ projectId: 'project', projectPath: f.stateDir }, async () => {}),
      /not ready/,
    );
  } finally {
    await f.close();
  }
});

test('disable hides a running endpoint immediately; stopping a pending start cannot launch later', async () => {
  const f = fixture();
  try {
    const pending = f.runtime.start();
    await f.runtime.stop();
    await pending;
    assert.equal(f.spawned.length, 0);
    await f.runtime.start();
    assert.ok(f.runtime.endpoint());
    f.settings.enabled = false;
    assert.equal(f.runtime.endpoint(), null);
    assert.equal(f.runtime.status().state, 'disabled');
  } finally {
    await f.close();
  }
});

test('stop settles the old startup before a settings restart can reuse its promise', async () => {
  const f = fixture('manual');
  try {
    let settled = false;
    const starting = f.runtime.start().then(() => {
      settled = true;
    });
    while (!f.spawned.length) await new Promise((resolve) => setTimeout(resolve, 1));
    await f.runtime.stop();
    assert.equal(settled, true);
    assert.equal(f.runtime.endpoint(), null);
    await starting;
  } finally {
    await f.close();
  }
});
