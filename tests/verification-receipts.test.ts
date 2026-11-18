import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { VerificationReceipts, type VerificationRequest } from '../src/server/verification-receipts.ts';

type Result = Awaited<ReturnType<VerificationReceipts['verify']>>;
const passed = (command: string): Result => ({ command, status: 'passed', exitCode: 0, output: 'checked' });

async function fixture(
  t: TestContext,
  execute: (request: VerificationRequest, signal: AbortSignal) => Promise<Result>,
  fixtureDirectory?: string,
) {
  const directory = fixtureDirectory ?? join(process.cwd(), '.data', 'verification-fixtures');
  await mkdir(directory, { recursive: true });
  const cwd = await mkdtemp(join(directory, 'check-'));
  await mkdir(join(cwd, 'src'));
  await writeFile(join(cwd, 'package.json'), '{"private":true}');
  await writeFile(join(cwd, 'src', 'main.ts'), 'export const count: number = 1;\n');
  await writeFile(join(cwd, 'tsconfig.json'), '{"compilerOptions":{"types":[]},"include":["src"]}');
  const library = createRequire(join(cwd, 'package.json')).resolve('typescript');
  const compiler = join(dirname(library), 'tsc.js');
  const command = `${process.platform === 'win32' ? '& ' : ''}"${process.execPath}" "${compiler}" --noEmit --incremental false --composite false`;
  const service = new VerificationReceipts(execute);
  t.after(async () => {
    await service.close();
    const runtime = join(cwd, '.runtime');
    if ((await lstat(runtime).catch(() => undefined))?.isSymbolicLink()) await unlink(runtime);
    await rm(cwd, { recursive: true, force: true });
  });
  const request = (values: Partial<VerificationRequest> = {}): VerificationRequest => ({
    command,
    cwd,
    environment: 'native',
    permissionMode: 'read-only',
    authorizationScope: 'synthetic-approved-project',
    approved: () => true,
    signal: new AbortController().signal,
    ...values,
  });
  return { service, cwd, request };
}

async function isolatedCompilerFixture(
  t: TestContext,
  execute: (request: VerificationRequest, signal: AbortSignal) => Promise<Result>,
) {
  const isolated = await mkdtemp(join(tmpdir(), 'pugport-runtime-verifier-'));
  const require = createRequire(import.meta.url);
  const nativePackage = `@typescript/typescript-${process.platform}-${process.arch}`;
  const packages = [
    { source: dirname(dirname(require.resolve('typescript'))), target: join(isolated, 'node_modules', 'typescript') },
    {
      source: dirname(require.resolve(`${nativePackage}/package.json`)),
      target: join(isolated, 'node_modules', nativePackage),
    },
  ];
  // Parallel smoke checks may brand shared dependencies; reuse assertions need unchanged compiler roots.
  for (const item of packages) await cp(item.source, item.target, { recursive: true, dereference: true });
  const created = await fixture(t, execute, isolated);
  t.after(async () => {
    assert.ok(resolve(isolated).startsWith(resolve(tmpdir()) + sep));
    await rm(isolated, { recursive: true, force: true });
  });
  return created;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

async function until(condition: () => boolean) {
  const end = Date.now() + 8000;
  while (!condition() && Date.now() < end) await delay(10);
  assert.ok(condition(), 'expected verification work to start');
}

test('same snapshot has one in-flight check and one reusable host receipt', async (t) => {
  let calls = 0;
  const gate = deferred<void>();
  t.after(() => gate.resolve());
  const { service, request } = await fixture(t, async (input) => {
    calls++;
    await gate.promise;
    return passed(input.command);
  });
  const first = service.verify(request());
  const second = service.verify(request());
  await until(() => calls > 0);
  await delay(30);
  assert.equal(calls, 1);
  gate.resolve();
  const results = await Promise.all([first, second]);
  assert.equal(results[0].receipt?.stable, true);
  assert.equal(results[0].receipt?.id, results[1].receipt?.id);
  assert.deepEqual(results.map((result) => result.receipt?.reused).sort(), [false, true]);
  const cached = await service.verify(request());
  assert.equal(cached.receipt?.reused, true);
  assert.equal(cached.receipt?.id, results[0].receipt?.id);
  assert.equal(calls, 1);
  assert.ok(cached.receipt?.snapshot);
});

test('tracked-style edits, untracked inputs, config and environment changes invalidate reuse', async (t) => {
  let calls = 0;
  const { service, cwd, request } = await fixture(t, async (input) => {
    calls++;
    return passed(input.command);
  });
  await service.verify(request());
  await writeFile(join(cwd, 'src', 'main.ts'), 'export const count: number = 2;\n');
  await service.verify(request());
  assert.equal(calls, 2);
  await writeFile(join(cwd, 'src', 'untracked.ts'), 'export const extra = true;\n');
  await service.verify(request());
  assert.equal(calls, 3);
  await writeFile(join(cwd, 'tsconfig.json'), '{"compilerOptions":{"types":[],"strict":true},"include":["src"]}');
  await service.verify(request());
  assert.equal(calls, 4);
  const old = process.env.PUGPORT_SYNTHETIC_VERIFICATION;
  try {
    process.env.PUGPORT_SYNTHETIC_VERIFICATION = 'changed';
    await service.verify(request());
    assert.equal(calls, 5);
  } finally {
    if (old === undefined) delete process.env.PUGPORT_SYNTHETIC_VERIFICATION;
    else process.env.PUGPORT_SYNTHETIC_VERIFICATION = old;
  }
});

test('approval is checked before snapshot/execution and before sharing a completed check', async (t) => {
  let calls = 0;
  const { service, request } = await fixture(t, async (input) => {
    calls++;
    return passed(input.command);
  });
  assert.equal((await service.verify(request({ approved: () => false }))).status, 'skipped');
  assert.equal(calls, 0);
  await service.verify(request());
  assert.equal((await service.verify(request({ approved: () => false }))).status, 'skipped');
  assert.equal(calls, 1);
});

test('failed checks and arbitrary npm scripts execute again rather than becoming success cache', async (t) => {
  let calls = 0;
  const { service, request } = await fixture(t, async (input) => {
    calls++;
    return { ...passed(input.command), status: 'failed', exitCode: 1 };
  });
  await service.verify(request());
  await service.verify(request());
  assert.equal(calls, 2);
  await service.verify(request({ command: 'npm run typecheck' }));
  await service.verify(request({ command: 'npm run typecheck' }));
  assert.equal(calls, 4);
});

test('one cancelled consumer leaves another consumer running; all cancelled consumers stop the flight', async (t) => {
  let calls = 0;
  let stopped = 0;
  const gate = deferred<void>();
  t.after(() => gate.resolve());
  const { service, request } = await fixture(t, async (input, signal) => {
    calls++;
    await Promise.race([
      gate.promise,
      new Promise<void>((done) =>
        signal.addEventListener(
          'abort',
          () => {
            stopped++;
            done();
          },
          { once: true },
        ),
      ),
    ]);
    return signal.aborted ? { ...passed(input.command), status: 'cancelled', exitCode: null } : passed(input.command);
  });
  const firstSignal = new AbortController();
  const secondSignal = new AbortController();
  const first = service.verify(request({ signal: firstSignal.signal }));
  const second = service.verify(request({ signal: secondSignal.signal }));
  await until(() => calls === 1);
  await delay(30);
  firstSignal.abort();
  assert.equal((await first).status, 'cancelled');
  assert.equal(stopped, 0);
  secondSignal.abort();
  assert.equal((await second).status, 'cancelled');
  await until(() => stopped === 1);
  gate.resolve();
  const next = await service.verify(request());
  assert.equal(next.receipt?.reused, false);
  assert.equal(calls, 2);
});

test('a surviving consumer receives success after another cancels', async (t) => {
  let calls = 0;
  const gate = deferred<void>();
  t.after(() => gate.resolve());
  const { service, request } = await fixture(t, async (input) => {
    calls++;
    await gate.promise;
    return passed(input.command);
  });
  const abort = new AbortController();
  const first = service.verify(request({ signal: abort.signal }));
  const second = service.verify(request());
  await until(() => calls === 1);
  await delay(30);
  abort.abort();
  assert.equal((await first).status, 'cancelled');
  gate.resolve();
  assert.equal((await second).status, 'passed');
  assert.equal(calls, 1);
});

test('permission and authorization scopes cannot share a receipt', async (t) => {
  let calls = 0;
  const { service, request } = await fixture(t, async (input) => {
    calls++;
    return passed(input.command);
  });
  const first = await service.verify(request());
  const writable = await service.verify(request({ permissionMode: 'workspace-write' }));
  const otherScope = await service.verify(request({ authorizationScope: 'other-approved-project' }));
  assert.equal(calls, 3);
  assert.notEqual(first.receipt?.id, writable.receipt?.id);
  assert.notEqual(first.receipt?.id, otherScope.receipt?.id);
});

test('a file changed and restored during a check prevents overlap and cached-result reuse', async (t) => {
  let calls = 0;
  const gate = deferred<void>();
  t.after(() => gate.resolve());
  const { service, cwd, request } = await fixture(t, async (input) => {
    calls++;
    if (calls === 1) await gate.promise;
    return passed(input.command);
  });
  const first = service.verify(request());
  await until(() => calls === 1);
  const path = join(cwd, 'src', 'main.ts');
  const source = await readFile(path, 'utf8');
  await writeFile(path, 'export const changed = true;\n');
  await writeFile(path, source);
  const second = await service.verify(request());
  assert.equal(calls, 2);
  assert.equal(second.receipt?.reused, false);
  gate.resolve();
  assert.equal((await first).receipt?.stable, false);
});

test('external config closure disables reuse and still executes approved checks', async (t) => {
  let calls = 0;
  const { service, cwd, request } = await fixture(t, async (input) => {
    calls++;
    return passed(input.command);
  });
  const outside = join(dirname(cwd), `outside-${Date.now()}.json`);
  await writeFile(outside, '{"compilerOptions":{"strict":true}}');
  t.after(() => rm(outside, { force: true }));
  await writeFile(join(cwd, 'tsconfig.json'), JSON.stringify({ extends: outside, include: ['src'] }));
  const first = await service.verify(request());
  const second = await service.verify(request());
  assert.equal(first.receipt?.snapshot, undefined);
  assert.equal(second.receipt?.reused, false);
  assert.equal(calls, 2);
});

test('a resolved dependency edit invalidates the receipt without scanning every installed package', async (t) => {
  let calls = 0;
  const { service, cwd, request } = await fixture(t, async (input) => {
    calls++;
    return passed(input.command);
  });
  const dependency = join(cwd, 'node_modules', '@types', 'synthetic');
  await mkdir(dependency, { recursive: true });
  await writeFile(join(dependency, 'index.d.ts'), 'declare const synthetic: number;\n');
  await writeFile(join(cwd, 'tsconfig.json'), '{"compilerOptions":{"types":["synthetic"]},"include":["src"]}');
  const first = await service.verify(request());
  assert.ok(first.receipt?.snapshot);
  await writeFile(join(dependency, 'index.d.ts'), 'declare const synthetic: string;\n');
  const next = await service.verify(request());
  assert.equal(calls, 2);
  assert.notEqual(first.receipt?.snapshot, next.receipt?.snapshot);
  assert.equal(next.receipt?.reused, false);
});

test('cancelled executions and cancelled-before-start consumers never publish successful receipts', async (t) => {
  let calls = 0;
  const { service, request } = await fixture(t, async (input) => {
    calls++;
    return { ...passed(input.command), status: 'cancelled', exitCode: null };
  });
  const abort = new AbortController();
  abort.abort();
  assert.equal((await service.verify(request({ signal: abort.signal }))).status, 'cancelled');
  assert.equal(calls, 0);
  await service.verify(request());
  await service.verify(request());
  assert.equal(calls, 2);
});

test('closing the host during snapshot discovery prevents late verification launches', async (t) => {
  let calls = 0;
  const { service, request } = await fixture(t, async (input) => {
    calls++;
    return passed(input.command);
  });
  const pending = service.verify(request());
  await service.close();
  assert.equal((await pending).status, 'cancelled');
  assert.equal(calls, 0);
  assert.equal((await service.verify(request())).status, 'cancelled');
});

test('an Electron host can share a real Node compiler through a managed runtime junction', async (t) => {
  let calls = 0;
  const { service, cwd, request } = await isolatedCompilerFixture(t, async (input) => {
    calls++;
    return passed(input.command);
  });
  const nodePath = process.execPath;
  const runtime = join(cwd, '.runtime');
  await symlink(dirname(nodePath), runtime, process.platform === 'win32' ? 'junction' : 'dir');
  const input = request();
  input.command = input.command.replace(nodePath, join(runtime, process.platform === 'win32' ? 'node.exe' : 'node'));
  try {
    process.execPath = join(cwd, 'synthetic-electron.exe');
    const first = await service.verify(input);
    const second = await service.verify(request({ command: input.command }));
    assert.ok(first.receipt?.snapshot);
    assert.equal(first.receipt?.stable, true);
    assert.equal(second.receipt?.reused, true);
    assert.equal(calls, 1);
  } finally {
    process.execPath = nodePath;
  }
});

test('a real local compiler check is executed once and the second check reuses its scoped receipt', async (t) => {
  let calls = 0;
  const compile = (cwd: string, signal?: AbortSignal) => {
    const compiler = join(dirname(createRequire(join(cwd, 'package.json')).resolve('typescript')), 'tsc.js');
    return promisify(execFile)(
      process.execPath,
      [compiler, '--noEmit', '--incremental', 'false', '--composite', 'false'],
      {
        cwd,
        signal,
        windowsHide: true,
        timeout: 8000,
      },
    );
  };
  const { service, cwd, request } = await isolatedCompilerFixture(t, async (input, signal) => {
    calls++;
    const result = await compile(input.cwd, signal);
    return { ...passed(input.command), output: result.stdout + result.stderr };
  });
  const compiler = join(dirname(createRequire(join(cwd, 'package.json')).resolve('typescript')), 'tsc.js');
  const baselineMs: number[] = [];
  for (let index = 0; index < 2; index++) {
    const start = performance.now();
    await compile(cwd);
    baselineMs.push(performance.now() - start);
  }
  let start = performance.now();
  const first = await service.verify(request());
  const firstMs = performance.now() - start;
  start = performance.now();
  const second = await service.verify(request());
  const reusedMs = performance.now() - start;
  t.diagnostic(
    JSON.stringify({
      compiler,
      first: {
        status: first.status,
        stable: first.receipt?.stable,
        snapshot: first.receipt?.snapshot,
        reused: first.receipt?.reused,
      },
      second: {
        status: second.status,
        stable: second.receipt?.stable,
        snapshot: second.receipt?.snapshot,
        reused: second.receipt?.reused,
      },
      calls,
    }),
  );
  assert.equal(first.status, 'passed');
  assert.equal(first.receipt?.stable, true);
  assert.equal(second.receipt?.id, first.receipt?.id);
  assert.equal(second.receipt?.reused, true);
  assert.equal(calls, 1);
  t.diagnostic(
    JSON.stringify({
      baselineMs,
      baselineTotalMs: baselineMs.reduce((a, b) => a + b, 0),
      firstMs,
      reusedMs,
      sharedTotalMs: firstMs + reusedMs,
      snapshotMs: first.receipt?.snapshotDurationMs,
      compilerExecutions: calls,
    }),
  );
});
