import { saveAttachment } from './helpers/attachments.ts';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Attachments, attachmentContext } from '../src/server/attachments.ts';
import { Store } from '../src/server/store.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { route } from '../src/server/routing.ts';
import { deleteIncognito } from '../src/server/incognito.ts';
import type { RuntimeSnapshot, Settings } from '../src/shared/types.ts';
import { Readable } from 'node:stream';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l2kAAAAASUVORK5CYII=';
function fixture(t: TestContext) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'comborunner-attachments-'))),
    db = new Store(dir),
    store = new WorkspaceStore(db.db),
    files = new Attachments(dir, store),
    conversationId = randomUUID();
  store.save('conversation', conversationId, 'project', { id: conversationId });
  t.after(() => {
    db.close();
    assert.ok(resolve(dir).startsWith(realpathSync.native(tmpdir()) + sep));
    rmSync(dir, { recursive: true, force: true });
  });
  return { files, store, conversationId, dir };
}
test('an upload finishing after project removal cannot leave a new private attachment', async (t) => {
  const { files, store, conversationId, dir } = fixture(t);
  const projectId = randomUUID();
  store.save('project', projectId, projectId, { id: projectId });
  store.save('conversation', conversationId, projectId, { id: conversationId, projectId });
  let release!: () => void;
  let started!: () => void;
  const firstChunk = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const body = Readable.from(
    (async function* () {
      started();
      yield Buffer.from('synthetic first chunk');
      await held;
      yield Buffer.from('last chunk');
    })(),
  );
  const uploading = files.saveStream(conversationId, { name: 'late.txt', mimeType: 'text/plain' }, body);
  await firstChunk;
  store.save('project', projectId, projectId, { id: projectId, removedAt: '2026-10-25' });
  release();
  await assert.rejects(uploading, /已移除/);
  assert.equal(store.list('attachment', conversationId).length, 0);
  assert.deepEqual(readdirSync(join(dir, 'attachments')), []);
});

test('two held uploads remain busy until both have removed their private temporary files', async (t) => {
  const { files, store, conversationId, dir } = fixture(t);
  const projectId = randomUUID();
  store.save('project', projectId, projectId, { id: projectId });
  store.save('conversation', conversationId, projectId, { id: conversationId, projectId });
  const heldUpload = () => {
    let release!: () => void, enter!: () => void;
    const started = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const body = Readable.from(
      (async function* () {
        enter();
        yield Buffer.from('private bytes');
        await held;
        yield Buffer.from('end');
      })(),
    );
    const pending = files.saveStream(conversationId, { name: 'held.txt', mimeType: 'text/plain' }, body);
    return { started, release: () => release(), pending };
  };
  const one = heldUpload(),
    two = heldUpload();
  await Promise.all([one.started, two.started]);
  assert.throws(() => files.assertIdle([conversationId]), /上传未结束/);
  store.save('project', projectId, projectId, { id: projectId, removedAt: '2026-10-25' });
  one.release();
  await assert.rejects(one.pending, /已移除/);
  assert.throws(() => files.assertIdle([conversationId]), /上传未结束/);
  two.release();
  await assert.rejects(two.pending, /已移除/);
  assert.doesNotThrow(() => files.assertIdle([conversationId]));
  assert.equal(store.list('attachment-upload', conversationId).length, 0);
  assert.deepEqual(readdirSync(join(dir, 'attachments')), []);
});
test('attachments retain real image bytes and file previews, without exposing paths in public metadata', async (t) => {
  const { files, conversationId } = fixture(t);
  const image = await saveAttachment(files, conversationId, {
    name: '截图.png',
    mimeType: 'image/png',
    dataBase64: png,
  });
  assert.equal(image.kind, 'image');
  assert.equal(image.mimeType, 'image/png');
  assert.equal('path' in image, false);
  const file = await saveAttachment(files, conversationId, {
    name: 'spec.md',
    mimeType: 'text/markdown',
    dataBase64: Buffer.from('Task text').toString('base64'),
  });
  const resolved = files.resolve(conversationId, [image.id, file.id]);
  assert.equal(resolved[1]!.text, 'Task text');
  assert.equal(resolved[0]!.size, Buffer.from(png, 'base64').length);
  assert.match(attachmentContext(resolved), /不构成额外授权/);
  assert.match(attachmentContext(resolved), /spec.md/);
  assert.equal(files.resolve(conversationId, []).length, 0);
});

test(
  'incognito close refuses uploads while recycling and removes all private attachment bytes',
  { timeout: 5000 },
  async (t) => {
    const { files, store, conversationId, dir } = fixture(t);
    const projectId = randomUUID(),
      path = join(dir, 'workspaces', randomUUID());
    mkdirSync(path, { recursive: true });
    store.save('project', projectId, projectId, { id: projectId, path, scope: 'chat' });
    store.save('conversation', conversationId, projectId, { id: conversationId, projectId, incognito: true });
    const upload = {
      name: 'private.txt',
      mimeType: 'text/plain',
      dataBase64: Buffer.from('SYNTHETIC_PRIVATE').toString('base64'),
    };
    const original = await saveAttachment(files, conversationId, upload);
    const originalPath = files.get(conversationId, original.id).path;
    store.save('conversation', conversationId, projectId, {
      id: conversationId,
      projectId,
      incognito: true,
      closedAt: '2026-10-14',
    });
    let release!: () => void, started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const closing = deleteIncognito(store, files, conversationId, async () => {
      started();
      await wait;
      rmSync(path, { recursive: true });
      return { moved: [path], failed: [] };
    });
    await ready;
    try {
      await assert.rejects(() => saveAttachment(files, conversationId, upload), /隐身对话已关闭。/);
    } finally {
      release();
      await closing;
    }
    assert.equal(store.get('conversation', conversationId), undefined);
    assert.equal(store.get('attachment', original.id), undefined);
    assert.equal(existsSync(originalPath), false);
    assert.deepEqual(readdirSync(files.directory), []);
  },
);
test('attachments reject cross-conversation access, tampering and renderer paths', async (t) => {
  const { files, store, conversationId } = fixture(t),
    other = randomUUID();
  store.save('conversation', other, 'project', { id: other });
  const file = await saveAttachment(files, conversationId, {
    name: 'text.txt',
    mimeType: 'text/plain',
    dataBase64: Buffer.from('abc').toString('base64'),
  });
  assert.throws(() => files.get(other, file.id), /当前对话/);
  await assert.rejects(
    () => saveAttachment(files, conversationId, { name: '../auth.json', mimeType: 'text/plain', dataBase64: 'YWJj' }),
    /文件名/,
  );
  assert.throws(() => files.get(conversationId, '../../auth.json'), /不存在/);
  assert.throws(() => files.resolve(conversationId, [file.id, file.id]), /不能重复/);
  writeFileSync(files.get(conversationId, file.id).path, 'longer');
  assert.throws(() => files.get(conversationId, file.id), /已变化/);
});
test('attachments keep unsupported images as files and reject corrupt encoding, excessive sizes and attachment count', async (t) => {
  const { files, conversationId } = fixture(t);
  const svg = await saveAttachment(files, conversationId, {
    name: 'bad.svg',
    mimeType: 'image/svg+xml',
    dataBase64: Buffer.from('<svg/>').toString('base64'),
  });
  assert.equal(svg.kind, 'file');
  assert.equal(svg.mimeType, 'application/octet-stream');
  assert.match(attachmentContext(files.resolve(conversationId, [svg.id])), /bad.svg/);
  await assert.rejects(
    () => saveAttachment(files, conversationId, { name: 'bad.txt', mimeType: 'text/plain', dataBase64: '' }),
    /附件为空/,
  );
  await assert.rejects(
    () =>
      saveAttachment(files, conversationId, {
        name: 'large.bin',
        mimeType: '',
        dataBase64: Buffer.alloc(50 * 1024 * 1024 + 1).toString('base64'),
      }),
    /过大|50 MB/,
  );
  assert.throws(
    () =>
      files.resolve(
        conversationId,
        Array.from({ length: 9 }, () => randomUUID()),
      ),
    /最多 8/,
  );
});
test('images use a connected vision channel while an explicit executor pin is never replaced', async (t) => {
  const { files, conversationId } = fixture(t),
    file = await saveAttachment(files, conversationId, { name: 'image.png', mimeType: 'image/png', dataBase64: png });
  const settings: Settings = {
    refreshSeconds: 60,
    reservePercent: 10,
    maxQuotaAgeSeconds: 180,
    preferCli: true,
    designProvider: 'grok',
    architectureProvider: 'grok',
    routineProvider: 'grok',
    unknownQuotaPolicy: 'allow',
    defaultProjectPath: '.',
    maxConcurrentRuns: 1,
  };
  const snapshots: RuntimeSnapshot[] = (['grok', 'codex'] as const).map((provider) => ({
    id: provider,
    provider,
    label: provider,
    environment: 'native',
    installed: true,
    status: 'ready',
    models: [{ id: 'fixture', label: 'fixture', efforts: [] }],
    accounting: { mode: 'usage', source: 'fixture' },
    quota: { status: 'unknown', source: 'fixture', observedAt: null, windows: [] },
    capabilities: { execute: true, resume: true, cancel: true, approvals: false },
    refreshedAt: new Date().toISOString(),
  }));
  const input = {
    prompt: 'Describe the image',
    projectPath: '.',
    kind: 'general' as const,
    attachments: files.resolve(conversationId, [file.id]),
  };
  assert.equal(route(input, snapshots, settings, new Set()).runtimeId, 'codex');
  for (const pin of [{ runtimeId: 'grok' }, { provider: 'grok' as const }])
    assert.throws(() => route({ ...input, ...pin }, snapshots, settings, new Set()), /不会自动替换已指定的执行器/);
  const grok = snapshots.find((snapshot) => snapshot.provider === 'grok')!;
  grok.capabilities.imageInput = true;
  const direct = route({ ...input, runtimeId: 'grok', model: 'fixture' }, snapshots, settings, new Set());
  assert.equal(direct.runtimeId, 'grok');
  assert.equal(direct.model, 'fixture');
  assert.ok(!direct.warnings.some((warning) => /改用|不能看图/.test(warning)));
  assert.equal(route({ ...input, provider: 'grok' }, snapshots, settings, new Set()).runtimeId, 'grok');
  // Without the picture the pin holds.
  assert.equal(
    route({ ...input, attachments: [], runtimeId: 'grok' }, snapshots, settings, new Set()).runtimeId,
    'grok',
  );
});
