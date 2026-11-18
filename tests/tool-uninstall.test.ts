import { EventEmitter } from 'node:events';
import workerThreads from 'node:worker_threads';
import { stopImageSearchWorker } from '../src/server/image-search-client.ts';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import fs from 'node:fs';
import promises from 'node:fs/promises';
import childProcess from 'node:child_process';
import Module, { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { Express, RequestHandler } from 'express';
import { ToolInstallations, toolInstallationRoutes } from '../src/server/tool-installations.ts';
import { installableToolIds, type InstallableToolId } from '../src/shared/tool-installations.ts';
import { transcribe, voiceInUse, voiceModelDirectory } from '../src/server/voice.ts';
import {
  findSimilarImages,
  imageModelDirectory,
  imageSearchInUse,
  imageIndexStatus,
  pauseImageBackground,
  scheduleBackground,
  resetImageIndex,
} from '../src/server/image-search.ts';
import { memoryModelDirectory, scheduleMemoryIndexing, stopMemoryIndexing } from '../src/server/memory-vectors.ts';
import { markitdown, markitdownInUse, readDocument } from '../src/server/local-tools.ts';
import { currentHost } from '../src/server/platform/host.ts';
import type { WorkspaceStore } from '../src/server/workspace-store.ts';

const files: Record<InstallableToolId, string[]> = {
  voice: ['sense-voice/model.int8.onnx', 'sense-voice/tokens.txt'],
  'image-search': ['model.onnx', 'vocab.txt', 'ocr/det.onnx', 'ocr/rec.onnx', 'ocr/keys.txt'],
  'memory-search': ['model.onnx', 'tokenizer.json'],
  markitdown: [process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python', '.pugport-ready'],
};
const detected = {
  voice: voiceModelDirectory,
  'image-search': imageModelDirectory,
  'memory-search': memoryModelDirectory,
  markitdown,
};
function insideTemp(path: string) {
  const rel = relative(tmpdir(), path);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), path);
}
function fixture(t: TestContext, runner?: ConstructorParameters<typeof ToolInstallations>[2]) {
  const base = fs.mkdtempSync(join(tmpdir(), 'pugport-uninstall-'));
  const appRoot = join(base, 'app');
  const runtime = join(base, 'downloads');
  insideTemp(base);
  insideTemp(appRoot);
  insideTemp(runtime);
  fs.mkdirSync(appRoot);
  fs.mkdirSync(runtime);
  const previous = process.env.PUGPORT_RUNTIME_DIR;
  process.env.PUGPORT_RUNTIME_DIR = runtime;
  const manager = new ToolInstallations(appRoot, join(base, 'data'), runner ?? (async () => 'Installed'));
  t.after(() => {
    manager.close();
    stopMemoryIndexing();
    if (previous === undefined) delete process.env.PUGPORT_RUNTIME_DIR;
    else process.env.PUGPORT_RUNTIME_DIR = previous;
    insideTemp(base);
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { base, appRoot, runtime, manager };
}
function install(root: string, tool: InstallableToolId) {
  insideTemp(root);
  for (const file of files[tool]) {
    const path = join(root, tool, file);
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, 'synthetic');
  }
}
function routes(manager: ToolInstallations) {
  const handlers = new Map<string, RequestHandler>();
  const app = {
    get() {},
    post() {},
    delete(path: string, handler: RequestHandler) {
      handlers.set(path, handler);
    },
  } as unknown as Express;
  toolInstallationRoutes(app, manager);
  return async (tool: string) => {
    let status = 200;
    let body: any;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json(value: unknown) {
        body = value;
        return this;
      },
    };
    await handlers.get('/api/tool-installations/:tool')!({ params: { tool } } as never, res as never, (error) => {
      throw error;
    });
    return { status, body };
  };
}

for (const tool of installableToolIds) {
  test(`DELETE ${tool} removes only the user's component and detects remaining legacy copies`, async (t) => {
    const f = fixture(t);
    install(f.runtime, tool);
    const sibling = tool === 'voice' ? 'memory-search' : 'voice';
    install(f.runtime, sibling);
    install(f.base, tool);
    install(join(f.appRoot, '.runtime'), tool);
    const remove = routes(f.manager);
    const result = await remove(tool);
    assert.equal(result.status, 409);
    assert.match(result.body.error, /旧版便携副本/);
    assert.ok(result.body.error.includes(dirname(detected[tool](f.appRoot)!)));
    assert.equal(fs.existsSync(join(f.runtime, tool)), false);
    assert.ok(detected[sibling](f.appRoot));
    for (const file of files[tool]) {
      assert.equal(fs.readFileSync(join(f.base, tool, file), 'utf8'), 'synthetic');
      assert.equal(fs.readFileSync(join(f.appRoot, '.runtime', tool, file), 'utf8'), 'synthetic');
    }
    assert.ok(detected[tool](f.appRoot), 'legacy copy remains detected');
    const legacy = await remove(tool);
    assert.equal(legacy.status, 409);
    assert.match(legacy.body.error, /旧版便携副本/);
  });
  test(`removing ${tool} immediately clears module readiness and allows reinstall`, async (t) => {
    const f = fixture(t, async (id) => {
      install(f.runtime, id);
      return 'Installed';
    });
    install(f.runtime, tool);
    assert.ok(detected[tool](f.appRoot));
    const pending = f.manager.remove(tool);
    assert.equal(detected[tool](f.appRoot), undefined);
    await pending;
    const job = f.manager.start(tool);
    assert.equal((await f.manager.wait(job.id))?.status, 'completed');
    assert.ok(detected[tool](f.appRoot));
  });
}

test('install and removal exclude each other and concurrent removes are refused', async (t) => {
  let finish!: () => void;
  const f = fixture(t, async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return 'Installed';
  });
  install(f.runtime, 'voice');
  const job = f.manager.start('voice');
  assert.equal((await routes(f.manager)('voice')).status, 409);
  assert.ok(voiceModelDirectory(f.appRoot));
  finish();
  await f.manager.wait(job.id);
  const remove = f.manager.remove('voice');
  assert.throws(() => f.manager.start('voice'), /正在卸载/);
  await assert.rejects(f.manager.remove('voice'), /正在卸载/);
  await remove;
});

test('unknown tools and traversal are rejected with 400', async (t) => {
  const f = fixture(t);
  for (const id of ['unknown', '..', '../voice', 'VOICE', 'voice/other', ''])
    assert.equal((await routes(f.manager)(id)).status, 400);
  assert.deepEqual(fs.readdirSync(f.runtime), []);
});

test('an incomplete download does not misreport a legacy-only installation as uninstalled', async (t) => {
  const f = fixture(t);
  install(f.base, 'voice');
  fs.mkdirSync(join(f.runtime, 'voice'));
  const result = await routes(f.manager)('voice');
  assert.equal(result.status, 409);
  assert.match(result.body.error, /旧版便携副本/);
  assert.ok(voiceModelDirectory(f.appRoot));
});

for (const code of ['EBUSY', 'EPERM', 'ENOTEMPTY']) {
  test(`${code} returns 409 with the directory after readiness is cleared; retry succeeds`, async (t) => {
    const f = fixture(t);
    install(f.runtime, 'memory-search');
    const dir = join(f.runtime, 'memory-search');
    const original = promises.rm;
    const mock = t.mock.method(
      promises,
      'rm',
      async (path: Parameters<typeof promises.rm>[0], options: Parameters<typeof promises.rm>[1]) => {
        if (path === dir) {
          assert.deepEqual(options, { recursive: true, force: true, maxRetries: 3 });
          throw Object.assign(Error('Synthetic lock'), { code });
        }
        return original(path, options);
      },
    );
    syncBuiltinESMExports();
    try {
      const result = await routes(f.manager)('memory-search');
      assert.equal(result.status, 409);
      assert.ok(result.body.error.includes(dir));
      assert.ok(result.body.error.includes(code));
      assert.match(result.body.error, /组件已停用.*退出 PugPort 后可以手动删除这个文件夹/);
      assert.equal(memoryModelDirectory(f.appRoot), undefined);
    } finally {
      mock.mock.restore();
      syncBuiltinESMExports();
    }
    assert.deepEqual(await f.manager.remove('memory-search'), { removed: true });
  });
}

test('component and voice directory links are unlinked without deleting their targets', async (t) => {
  const f = fixture(t);
  const outside = join(f.base, 'outside');
  install(outside, 'voice');
  const link = join(f.runtime, 'voice');
  fs.symlinkSync(join(outside, 'voice'), link, process.platform === 'win32' ? 'junction' : 'dir');
  await f.manager.remove('voice');
  assert.equal(fs.existsSync(link), false);
  assert.equal(fs.readFileSync(join(outside, 'voice', 'sense-voice', 'tokens.txt'), 'utf8'), 'synthetic');
  fs.mkdirSync(link);
  fs.symlinkSync(
    join(outside, 'voice', 'sense-voice'),
    join(link, 'sense-voice'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await f.manager.remove('voice');
  assert.equal(fs.readFileSync(join(outside, 'voice', 'sense-voice', 'tokens.txt'), 'utf8'), 'synthetic');
});

test('active MarkItDown conversion refuses removal and failure releases the busy count', async (t) => {
  const f = fixture(t);
  install(f.runtime, 'markitdown');
  const file = join(f.appRoot, 'sample.pdf');
  fs.writeFileSync(file, 'synthetic');
  let finish!: (error: Error | null, stdout: string, stderr: string) => void;
  const mock = t.mock.method(childProcess, 'execFile', (...args: any[]) => {
    finish = args.at(-1);
    return {} as childProcess.ChildProcess;
  });
  syncBuiltinESMExports();
  try {
    for (const fail of [false, true]) {
      const reading = readDocument({ path: file }, f.appRoot, f.appRoot);
      const settled = fail ? assert.rejects(reading, /Synthetic conversion failure/) : reading;
      for (let i = 0; i < 100 && !markitdownInUse(); i++) await new Promise((r) => setTimeout(r, 5));
      assert.equal(markitdownInUse(), true);
      assert.equal((await routes(f.manager)('markitdown')).status, 409);
      assert.ok(markitdown(f.appRoot));
      finish(fail ? Error('Synthetic conversion failure') : null, 'converted', '');
      await settled;
      assert.equal(markitdownInUse(), false);
    }
    await f.manager.remove('markitdown');
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('memory indexing can be scheduled again after removal and reinstall in the same process', async (t) => {
  const f = fixture(t, async (tool) => {
    install(f.runtime, tool);
    scheduleMemoryIndexing(f.appRoot, {} as WorkspaceStore, 10_000);
    return 'Installed';
  });
  install(f.runtime, 'memory-search');
  const delays: number[] = [];
  const timer = t.mock.method(globalThis, 'setTimeout', ((_callback: unknown, delay: number) => {
    delays.push(delay);
    return { unref() {} };
  }) as typeof setTimeout);
  const clear = t.mock.method(globalThis, 'clearTimeout', () => {});
  const previous = process.env.COMBORUNNER_MEMORY_BACKGROUND;
  delete process.env.COMBORUNNER_MEMORY_BACKGROUND;
  try {
    scheduleMemoryIndexing(f.appRoot, {} as WorkspaceStore, 120_000);
    await f.manager.remove('memory-search');
    scheduleMemoryIndexing(f.appRoot, {} as WorkspaceStore);
    assert.deepEqual(delays, [120_000]);
    const job = f.manager.start('memory-search');
    await f.manager.wait(job.id);
    assert.deepEqual(delays, [120_000, 10_000]);
    assert.equal(clear.mock.calls.length, 1);
  } finally {
    stopMemoryIndexing();
    timer.mock.restore();
    clear.mock.restore();
    if (previous === undefined) delete process.env.COMBORUNNER_MEMORY_BACKGROUND;
    else process.env.COMBORUNNER_MEMORY_BACKGROUND = previous;
  }
});

test('voice refuses removal during inference and reloads its recognizer after reinstall', async (t) => {
  const f = fixture(t, async (tool) => {
    install(f.runtime, tool);
    return 'Installed';
  });
  install(f.runtime, 'voice');
  let loads = 0;
  let finish!: (result: { text: string }) => void;
  const createRequire = Module.createRequire;
  const mock = t.mock.method(Module, 'createRequire', (filename: Parameters<typeof createRequire>[0]) => {
    const require = createRequire(filename);
    return Object.assign(
      (id: string) =>
        id === 'sherpa-onnx-node'
          ? {
              OfflineRecognizer: {
                async createAsync() {
                  loads++;
                  return {
                    createStream: () => ({ acceptWaveform() {} }),
                    decodeAsync: () =>
                      new Promise<{ text: string }>((resolve) => {
                        finish = resolve;
                      }),
                  };
                },
              },
            }
          : require(id),
      require,
    );
  });
  syncBuiltinESMExports();
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const reading = transcribe(f.appRoot, new Float32Array([0]));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(voiceInUse(), true);
      assert.equal((await routes(f.manager)('voice')).status, 409);
      assert.equal(loads, attempt);
      finish({ text: 'synthetic' });
      assert.equal(await reading, 'synthetic');
      assert.equal(voiceInUse(), false);
      await f.manager.remove('voice');
      const job = f.manager.start('voice');
      await f.manager.wait(job.id);
    }
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('an active image search refuses removal without stopping the shared worker', async (t) => {
  const f = fixture(t);
  install(f.runtime, 'image-search');
  const previous = process.env.COMBORUNNER_IMAGE_INDEX_DIR;
  process.env.COMBORUNNER_IMAGE_INDEX_DIR = join(f.base, 'image-index');
  resetImageIndex();
  const workers = mockImageWorker(t);
  try {
    const search = findSimilarImages({ from: '2026-01-01', to: '2026-01-02', folders: [f.appRoot] }, f.appRoot);
    await until(() => workers.requests.some((request) => request.job.params));
    assert.equal(imageSearchInUse(), true);
    assert.equal((await routes(f.manager)('image-search')).status, 409);
    assert.ok(imageModelDirectory(f.appRoot));
    assert.equal(workers.stopped, 0, 'refused uninstall leaves the worker running');
    assert.equal(workers.aborts.length, 0);
    const request = workers.requests.find((request) => request.job.params)!;
    workers.reply(request.id, {
      params: request.job.params,
      total: 0,
      analyzed: 0,
      remaining: 0,
      checked: 0,
      unchecked: 0,
      same: [],
      near: [],
      sources: [],
      similar: [],
      texts: [],
      unread: 0,
    });
    await search;
    assert.equal(imageSearchInUse(), false);
    await f.manager.remove('image-search');
    assert.equal(imageModelDirectory(f.appRoot), undefined);
  } finally {
    await stopImageSearchWorker();
    workers.restore();
    resetImageIndex();
    if (previous === undefined) delete process.env.COMBORUNNER_IMAGE_INDEX_DIR;
    else process.env.COMBORUNNER_IMAGE_INDEX_DIR = previous;
  }
});

for (const linked of ['app', 'runtime', 'component'] as const) {
  test(`default dev uninstall refuses a linked ${linked} directory and preserves every target file`, async (t) => {
    const f = fixture(t);
    delete process.env.PUGPORT_RUNTIME_DIR;
    const shared = join(f.base, 'shared');
    const targetRuntime = linked === 'app' ? join(shared, '.runtime') : shared;
    for (const tool of installableToolIds) install(targetRuntime, tool);
    fs.writeFileSync(join(targetRuntime, 'owner-file.txt'), 'owner data');
    const root = join(f.appRoot, '.runtime');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    if (linked === 'app') {
      insideTemp(f.appRoot);
      fs.rmdirSync(f.appRoot);
      fs.symlinkSync(shared, f.appRoot, linkType);
    } else if (linked === 'runtime') fs.symlinkSync(shared, root, linkType);
    else {
      fs.mkdirSync(root);
      for (const tool of installableToolIds) fs.symlinkSync(join(shared, tool), join(root, tool), linkType);
    }
    for (const tool of installableToolIds) {
      const result = await routes(f.manager)(tool);
      assert.equal(result.status, 409);
      assert.match(result.body.error, /开发副本.*共用/);
      assert.ok(detected[tool](f.appRoot));
    }
    for (const tool of installableToolIds)
      for (const file of files[tool])
        assert.equal(fs.readFileSync(join(targetRuntime, tool, file), 'utf8'), 'synthetic');
    assert.equal(fs.readFileSync(join(targetRuntime, 'owner-file.txt'), 'utf8'), 'owner data');
  });
}

test('an explicit runtime override may use a linked root', async (t) => {
  const f = fixture(t);
  install(f.runtime, 'voice');
  const root = join(f.appRoot, '.runtime');
  fs.symlinkSync(f.runtime, root, process.platform === 'win32' ? 'junction' : 'dir');
  process.env.PUGPORT_RUNTIME_DIR = root;
  assert.deepEqual(await routes(f.manager)('voice'), { status: 200, body: { removed: true } });
  assert.equal(fs.existsSync(join(f.runtime, 'voice')), false);
  assert.ok(fs.lstatSync(root).isSymbolicLink());
});

test('failed readiness removal keeps memory indexing scheduled and the component usable', async (t) => {
  const f = fixture(t);
  install(f.runtime, 'memory-search');
  const previous = process.env.COMBORUNNER_MEMORY_BACKGROUND;
  delete process.env.COMBORUNNER_MEMORY_BACKGROUND;
  const timer = t.mock.method(globalThis, 'setTimeout', (() => ({ unref() {} })) as unknown as typeof setTimeout);
  const clear = t.mock.method(globalThis, 'clearTimeout', () => {});
  const original = fs.rmSync;
  const removal = t.mock.method(fs, 'rmSync', (path: fs.PathLike, options?: fs.RmOptions) => {
    if (path === join(f.runtime, 'memory-search', 'tokenizer.json'))
      throw Object.assign(Error('Synthetic readiness lock'), { code: 'EPERM' });
    return original(path, options);
  });
  syncBuiltinESMExports();
  try {
    scheduleMemoryIndexing(f.appRoot, {} as WorkspaceStore, 120_000);
    const result = await routes(f.manager)('memory-search');
    assert.equal(result.status, 409);
    assert.doesNotMatch(result.body.error, /组件已停用/);
    assert.ok(memoryModelDirectory(f.appRoot));
    assert.equal(clear.mock.calls.length, 0);
    removal.mock.restore();
    syncBuiltinESMExports();
    await f.manager.remove('memory-search');
    assert.equal(clear.mock.calls.length, 1);
  } finally {
    stopMemoryIndexing();
    removal.mock.restore();
    timer.mock.restore();
    clear.mock.restore();
    syncBuiltinESMExports();
    if (previous === undefined) delete process.env.COMBORUNNER_MEMORY_BACKGROUND;
    else process.env.COMBORUNNER_MEMORY_BACKGROUND = previous;
  }
});

test('uninstall pauses an active image indexing pass without rescheduling; reinstall can schedule again', async (t) => {
  const f = fixture(t);
  install(f.runtime, 'image-search');
  const previousIndex = process.env.COMBORUNNER_IMAGE_INDEX_DIR;
  const previousBackground = process.env.COMBORUNNER_IMAGE_BACKGROUND;
  process.env.COMBORUNNER_IMAGE_INDEX_DIR = join(f.base, 'image-index');
  delete process.env.COMBORUNNER_IMAGE_BACKGROUND;
  fs.mkdirSync(process.env.COMBORUNNER_IMAGE_INDEX_DIR);
  fs.writeFileSync(
    join(process.env.COMBORUNNER_IMAGE_INDEX_DIR, 'index.json'),
    JSON.stringify({ version: 1, entries: [], folders: [f.appRoot] }),
  );
  fs.writeFileSync(join(process.env.COMBORUNNER_IMAGE_INDEX_DIR, 'vectors.bin'), '');
  resetImageIndex();
  const workers = mockImageWorker(t);
  t.mock.method(currentHost(), 'run', async () => ({ stdout: 'True', stderr: '' }));
  const delays: number[] = [];
  let tick!: () => void;
  const timer = t.mock.method(globalThis, 'setTimeout', ((callback: () => void, delay: number) => {
    if (delay !== 30_000 && delay !== 30 * 60_000) {
      delays.push(delay);
      tick = callback;
    }
    return { unref() {}, refresh() {} };
  }) as typeof setTimeout);
  const clear = t.mock.method(globalThis, 'clearTimeout', () => {});
  try {
    scheduleBackground(f.appRoot, 10_000);
    tick();
    await until(() => workers.requests.length > 0);
    const request = workers.requests[0]!;
    assert.equal(request.job.params, undefined, 'background indexing was dispatched');
    assert.equal(imageIndexStatus(f.appRoot).working, true);
    assert.equal(imageSearchInUse(), false);
    assert.deepEqual(await routes(f.manager)('image-search'), { status: 200, body: { removed: true } });
    assert.deepEqual(workers.aborts, [request.id], 'pause reaches the active worker job');
    scheduleBackground(f.appRoot);
    assert.deepEqual(delays, [10_000], 'uninstalled component cannot reschedule');
    install(f.runtime, 'image-search');
    scheduleBackground(f.appRoot, 20_000);
    assert.deepEqual(delays, [10_000], 'reinstall waits for the cancelled worker');
    workers.reply(request.id, 600_000);
    await until(() => !imageIndexStatus(f.appRoot).working);
    assert.deepEqual(delays, [10_000, 20_000]);
    tick();
    await until(() => workers.requests.filter((r) => !r.job.statusOnly).length === 2);
    const resumed = workers.requests.filter((r) => !r.job.statusOnly)[1]!;
    pauseImageBackground();
    workers.reply(resumed.id);
    await until(() => !imageIndexStatus(f.appRoot).working);
  } finally {
    pauseImageBackground();
    await stopImageSearchWorker();
    workers.restore();
    timer.mock.restore();
    clear.mock.restore();
    syncBuiltinESMExports();
    resetImageIndex();
    if (previousIndex === undefined) delete process.env.COMBORUNNER_IMAGE_INDEX_DIR;
    else process.env.COMBORUNNER_IMAGE_INDEX_DIR = previousIndex;
    if (previousBackground === undefined) delete process.env.COMBORUNNER_IMAGE_BACKGROUND;
    else process.env.COMBORUNNER_IMAGE_BACKGROUND = previousBackground;
  }
});

for (const reinstall of [false, true])
  test(`uninstall during the image background battery query prevents the pass from starting (reinstall=${reinstall})`, async (t) => {
    const f = fixture(t);
    install(f.runtime, 'image-search');
    const previous = process.env.COMBORUNNER_IMAGE_BACKGROUND;
    const previousIndex = process.env.COMBORUNNER_IMAGE_INDEX_DIR;
    const indexDir = join(f.base, 'battery-race-index');
    process.env.COMBORUNNER_IMAGE_INDEX_DIR = indexDir;
    resetImageIndex();
    const workers = mockImageWorker(t);
    delete process.env.COMBORUNNER_IMAGE_BACKGROUND;
    // Expire the cached power reading from the preceding background pass.
    const now = Date.now();
    const clock = t.mock.method(Date, 'now', () => now + (reinstall ? 360_000 : 180_000));
    let tick!: () => void;
    const timer = t.mock.method(globalThis, 'setTimeout', ((callback: () => void) => {
      tick = callback;
      return { unref() {} };
    }) as unknown as typeof setTimeout);
    let finish: ((value: { stdout: string; stderr: string }) => void) | undefined;
    const power = t.mock.method(
      currentHost(),
      'run',
      () =>
        new Promise<{ stdout: string; stderr: string }>((resolve) => {
          finish = resolve;
        }),
    );
    let listings = 0;
    const child = t.mock.method(childProcess, 'execFile', (...args: any[]) => {
      if ((args[1] as string[]).includes('--files')) {
        listings++;
        args.at(-1)(null, '', '');
      }
      return {} as childProcess.ChildProcess;
    });
    const abort = t.mock.method(AbortController.prototype, 'abort');
    syncBuiltinESMExports();
    try {
      scheduleBackground(f.appRoot, 10_000);
      tick();
      if (process.platform === 'win32' || process.platform === 'darwin')
        assert.ok(finish, 'the battery query is pending');
      const removal = routes(f.manager)('image-search');
      assert.equal(imageModelDirectory(f.appRoot), undefined);
      assert.equal(abort.mock.calls.length, 0, 'no controller exists yet');
      assert.equal((await removal).status, 200);
      if (reinstall) {
        install(f.runtime, 'image-search');
        scheduleBackground(f.appRoot, 20_000);
      }
      finish?.({ stdout: 'True', stderr: '' });
      await new Promise((r) => setImmediate(r));
      assert.equal(workers.requests.length, 0, 'cancelled power check never dispatches a worker job');
      assert.equal(listings, 0, 'no picture listing starts after uninstall');
      assert.equal(fs.existsSync(indexDir), false, 'no background index is opened after uninstall');
      assert.equal(timer.mock.calls.length, reinstall ? 2 : 1, 'only an explicit reinstall schedules a new pass');
      assert.equal(imageSearchInUse(), false);
    } finally {
      pauseImageBackground();
      await stopImageSearchWorker();
      workers.restore();
      clock.mock.restore();
      timer.mock.restore();
      power.mock.restore();
      child.mock.restore();
      abort.mock.restore();
      syncBuiltinESMExports();
      resetImageIndex();
      if (previousIndex === undefined) delete process.env.COMBORUNNER_IMAGE_INDEX_DIR;
      else process.env.COMBORUNNER_IMAGE_INDEX_DIR = previousIndex;
      if (previous === undefined) delete process.env.COMBORUNNER_IMAGE_BACKGROUND;
      else process.env.COMBORUNNER_IMAGE_BACKGROUND = previous;
    }
  });

async function until(ready: () => boolean) {
  for (let i = 0; i < 100 && !ready(); i++) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(ready(), 'worker lifecycle reached the expected state');
}
function mockImageWorker(t: TestContext) {
  type Request = { id: number; job: { params?: unknown; statusOnly?: boolean } };
  const requests: Request[] = [];
  const aborts: number[] = [];
  let stopped = 0;
  let current: FakeWorker;
  class FakeWorker extends EventEmitter {
    ref() {}
    unref() {}
    async terminate() {
      stopped++;
      return 0;
    }
    postMessage(message: Request | { id: number; abort: boolean }) {
      if ('job' in message) {
        requests.push(message);
        if (message.job.statusOnly)
          setImmediate(() => this.emit('message', { id: message.id, status: { analyzed: 0 } }));
      } else if (message.abort) aborts.push(message.id);
    }
  }
  const mock = t.mock.method(workerThreads, 'Worker', function () {
    return (current = new FakeWorker());
  } as unknown as typeof workerThreads.Worker);
  syncBuiltinESMExports();
  return {
    requests,
    aborts,
    get stopped() {
      return stopped;
    },
    reply(id: number, outcome?: unknown) {
      current.emit('message', { id, outcome });
    },
    restore() {
      mock.mock.restore();
      syncBuiltinESMExports();
    },
  };
}
