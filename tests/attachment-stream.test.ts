import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { fork } from '../src/server/platform/test-process.ts';
import { request } from 'node:http';
import sharp from 'sharp';
import { Store } from '../src/server/store.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { Attachments, attachmentLimits as serverLimits } from '../src/server/attachments.ts';
import { attachmentLimits as uiLimits } from '../src/ui/attachments.ts';
import { attachmentLimits } from '../src/shared/attachments.ts';
import { attachmentDimensions, executorImage } from '../src/server/attachment-image.ts';
import { deleteIncognito } from '../src/server/incognito.ts';
import type { RunEvent, RuntimeTarget } from '../src/shared/types.ts';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'pugport-attachment-stream-'));
  const db = new Store(directory),
    store = new WorkspaceStore(db.db),
    files = new Attachments(directory, store);
  const id = randomUUID();
  store.save('conversation', id, 'project', { id });
  t.after(() => {
    db.close();
    assert.equal(dirname(directory), tmpdir().replace(/[\\/]$/, ''));
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, db, store, files, id };
}
const image = (width = 32, height = 24) =>
  sharp({ create: { width, height, channels: 4, background: '#4b8199aa' } })
    .png()
    .toBuffer();

test('one shared limit definition; history remains 20 MB', () => {
  assert.equal(serverLimits, attachmentLimits);
  assert.equal(uiLimits, attachmentLimits);
  assert.equal(attachmentLimits.fileBytes, 50 * 1024 * 1024);
  assert.equal(attachmentLimits.imageBytes, attachmentLimits.fileBytes);
  assert.equal(attachmentLimits.totalBytes, 200 * 1024 * 1024);
  assert.equal(attachmentLimits.historyBytes, 20 * 1024 * 1024);
  assert.equal(attachmentLimits.count, 8);
  assert.match(
    readFileSync('src/server/workspace.ts', 'utf8'),
    /bytes \+ previous.size > attachmentLimits.historyBytes/,
  );
});

test('streaming saves exact bytes and one hash; get only checks size and bounds text reads', async (t) => {
  const { files, store, id } = fixture(t),
    bytes = await image();
  const saved = await files.saveStream(
    id,
    { name: '截图.png', mimeType: 'image/png' },
    Readable.from([bytes.subarray(0, 5), bytes.subarray(5)]),
  );
  const file = files.get(id, saved.id);
  assert.deepEqual(readFileSync(file.path), bytes);
  assert.equal((store.get('attachment', saved.id) as any).sha256, createHash('sha256').update(bytes).digest('hex'));
  writeFileSync(file.path, Buffer.alloc(bytes.length, 7));
  assert.equal(files.get(id, saved.id).path, file.path, 'same-size content is not re-hashed');
  writeFileSync(file.path, 'changed size');
  assert.throws(() => files.get(id, saved.id), /已变化/);
  const text = Buffer.concat([Buffer.alloc(64 * 1024, 65), Buffer.from([0xff])]);
  const doc = await files.saveStream(id, { name: 'text.txt', mimeType: 'text/plain' }, Readable.from([text]));
  assert.match(files.get(id, doc.id).text!, /^A{6000}\n\[预览已截断/);
});

test('stream stops reading at the limit, rejects empty and invalid images, and removes partial files', async (t) => {
  const { files, id } = fixture(t);
  let pulled = 0;
  const body = Readable.from(
    (async function* () {
      for (let i = 0; i < 100; i++) {
        pulled++;
        yield Buffer.alloc(1024 * 1024);
      }
    })(),
  );
  await assert.rejects(
    files.saveStream(id, { name: 'large.bin', mimeType: '' }, body),
    (error: any) => error.status === 413,
  );
  body.destroy();
  assert.ok(pulled < 55, `read ${pulled} MB before abort`);
  for (const [bytes, message] of [
    [Buffer.alloc(0), /附件为空/],
    [Buffer.from('not an image'), /不是有效的图片/],
  ] as const)
    await assert.rejects(
      files.saveStream(id, { name: 'bad.png', mimeType: 'image/png' }, Readable.from([bytes])),
      message,
    );
  assert.deepEqual(readdirSync(files.directory), []);
});

test('lossy, lossless and extended WebP headers do not leave handles blocking rename or purge on Windows', async (t) => {
  const { files, id } = fixture(t);
  for (const [channels, lossless] of [
    [3, false],
    [3, true],
    [4, false],
  ] as const) {
    const bytes = await sharp({ create: { width: 93, height: 57, channels, background: '#438bad88' } })
      .webp({ lossless })
      .toBuffer();
    const saved = await files.saveStream(
      id,
      { name: 'synthetic.webp', mimeType: 'image/webp' },
      Readable.from([bytes]),
    );
    const resolved = files.get(id, saved.id);
    assert.equal(resolved.width, 93);
    assert.equal(resolved.height, 57);
    await executorImage({ ...resolved, width: undefined, height: undefined }, 'gemini', { emit() {} });
  }
  const zeroChunk = Buffer.from('UNKN\0\0\0\0', 'ascii');
  const vp8x = Buffer.alloc(18);
  vp8x.write('VP8X', 0, 4, 'ascii');
  vp8x.writeUInt32LE(10, 4);
  vp8x.writeUIntLE(92, 12, 3);
  vp8x.writeUIntLE(56, 15, 3);
  const payload = Buffer.concat([...Array.from({ length: 100 }, () => zeroChunk), vp8x]);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 4, 'ascii');
  riff.writeUInt32LE(4 + payload.length, 4);
  riff.write('WEBP', 8, 4, 'ascii');
  const crafted = Buffer.concat([riff, payload]);
  const craftedPath = join(files.directory, 'crafted-chunks.webp');
  writeFileSync(craftedPath, crafted);
  await assert.rejects(attachmentDimensions(craftedPath, 'image/webp'), /runtime-image-input-invalid/);
  rmSync(craftedPath, { force: true });
  await assert.rejects(
    files.saveStream(id, { name: 'crafted.webp', mimeType: 'image/webp' }, Readable.from([crafted])),
    /不是有效的图片/,
  );
  files.removeUnshared(id);
  assert.deepEqual(readdirSync(files.directory), []);
});

test('closing incognito during an upload leaves neither a record nor a partial file', async (t) => {
  const { files, store, id } = fixture(t);
  const body = Readable.from(
    (async function* () {
      yield Buffer.from('first chunk');
      store.save('conversation', id, 'project', { id, incognito: true, closedAt: new Date().toISOString() });
      yield Buffer.from('last chunk');
    })(),
  );
  await assert.rejects(files.saveStream(id, { name: 'private.txt', mimeType: 'text/plain' }, body), /隐身对话已关闭/);
  assert.deepEqual(readdirSync(files.directory), []);
  assert.equal(store.list('attachment', id).length, 0);
});

test('one companion serves every byte adapter, respects 8000 px, keeps Codex original, and is purged with incognito', async (t) => {
  const { files, store, id } = fixture(t);
  const original = await files.saveStream(
    id,
    { name: 'wide.png', mimeType: 'image/png' },
    Readable.from([await image(8001, 2)]),
  );
  const events: RunEvent[] = [],
    ctx = {
      emit: (event: RunEvent) => {
        events.push(event);
      },
    };
  let resolved = files.get(id, original.id);
  for (const executor of ['claude', 'gemini', 'cursor', 'grok']) {
    assert.equal(await executorImage(resolved, executor, ctx), undefined);
    assert.match(events.at(-1)!.text!, /没有可用的缩图副本/);
  }
  const forkId = randomUUID();
  store.save('conversation', forkId, 'project', { id: forkId, projectId: 'project', incognito: true });
  const reference = files.copyReference(id, original.id, forkId);
  const companion = await files.saveStream(
    id,
    { name: 'fitted.png', mimeType: 'image/png', originalId: original.id },
    Readable.from([await image()]),
  );
  assert.equal(companion.id, original.id);
  assert.equal(store.list('attachment', id).length, 1);
  resolved = files.get(id, original.id);
  assert.equal(files.get(forkId, reference.id).fitted?.path, resolved.fitted?.path);
  for (const executor of ['claude', 'gemini', 'cursor', 'grok'])
    assert.equal(await executorImage(resolved, executor, ctx), resolved.fitted);
  const small = await files.saveStream(
    id,
    { name: 'small.png', mimeType: 'image/png' },
    Readable.from([await image(8000, 2)]),
  );
  const smallFile = files.get(id, small.id);
  assert.equal(await executorImage(smallFile, 'claude', ctx), smallFile);
  // Metadata is read from the file for older attachments, too.
  assert.equal(
    await executorImage({ ...resolved, width: undefined, height: undefined }, 'claude', ctx),
    resolved.fitted,
  );
  const largePath = join(files.directory, 'large-test.gif');
  writeFileSync(largePath, Buffer.alloc(5 * 1024 * 1024 + 1));
  assert.equal(await executorImage({ ...resolved, path: largePath, mimeType: 'image/gif' }, 'claude', ctx), undefined);
  assert.match(events.at(-1)!.text!, /GIF.*未重新编码/);
  store.save('conversation', id, 'project', { id, projectId: 'project', incognito: true });
  await deleteIncognito(store, files, id, async () => ({ moved: [], failed: [] }));
  assert.equal(existsSync(resolved.path), true, 'shared original survives');
  assert.equal(existsSync(resolved.fitted!.path), true, 'shared companion survives');
  await deleteIncognito(store, files, forkId, async () => ({ moved: [], failed: [] }));
  assert.equal(existsSync(resolved.path), false);
  assert.equal(existsSync(resolved.fitted!.path), false);
});

test(
  'the real HTTP route streams JSON files too and preserves token, Host, Origin and JSON guards',
  { timeout: 45000 },
  async (t) => {
    let phase = 'preparing backend';
    const started = performance.now();
    t.after(() => {
      if (phase !== 'complete')
        t.diagnostic(`Attachment HTTP stopped at ${phase}; elapsed ${Math.round(performance.now() - started)} ms`);
    });
    const directory = mkdtempSync(join(tmpdir(), 'pugport-attachment-http-')),
      data = join(directory, 'data');
    const db = new Store(data),
      store = new WorkspaceStore(db.db),
      id = randomUUID();
    db.setConfig(
      'targets',
      (['codex', 'claude', 'grok', 'pi', 'cursor'] as const).map<RuntimeTarget>((provider) => ({
        id: provider,
        provider,
        label: 'Disabled fixture',
        command: 'unused',
        environment: 'native',
        enabled: false,
        commandDiscovery: 'fixed',
      })),
    );
    writeFileSync(
      join(data, 'external-agents.json'),
      JSON.stringify({ version: 1, agents: { 'grok-bot': { usageEnabled: false } } }),
    );
    store.save('conversation', id, 'project', { id, projectId: 'project' });
    db.close();
    const child = fork(resolve('src/server/main.ts'), [], {
      execArgv: ['--import', 'tsx'],
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        COMBORUNNER_ROOT: directory,
        COMBORUNNER_DATA_DIR: data,
        COMBORUNNER_MEMORY_DIR: join(directory, 'memory'),
        COMBORUNNER_SECRETS_DIR: join(directory, 'secrets'),
        COMBORUNNER_PORT: '0',
        USERPROFILE: directory,
        HOME: directory,
        CODEX_HOME: join(directory, 'codex'),
        APPDATA: join(directory, 'appdata'),
        LOCALAPPDATA: join(directory, 'localappdata'),
        JEV_API_KEY: '',
        TYPESAFE_API_KEY: '',
      },
    });
    let output = '';
    child.stdout!.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr!.on('data', (chunk) => {
      output += chunk;
    });
    const exited = new Promise((done) => child.once('exit', done));
    t.after(async () => {
      if (child.exitCode === null && child.connected) child.send('shutdown');
      const timer = setTimeout(() => child.kill(), 5000);
      await exited;
      clearTimeout(timer);
      assert.equal(dirname(directory), tmpdir().replace(/[\\/]$/, ''));
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    phase = 'waiting for backend ready';
    let token = '';
    let owner = '';
    const port = await new Promise<number>((done, reject) => {
      child.once('error', reject);
      child.once('exit', () => reject(Error(output)));
      child.on('message', (message: any) => {
        if (message.type === 'session') {
          token = message.token ?? '';
          owner = message.owner ?? '';
        }
        if (message.type === 'ready') done(message.port);
      });
    });
    const base = `http://127.0.0.1:${port}`,
      url = `${base}/api/conversations/${id}/attachments`;
    phase = 'reading local session';
    const headers = {
      'x-agent-token': token,
      'x-pugport-owner': owner,
      'content-type': 'application/json',
      'x-attachment-name': encodeURIComponent('测试.json'),
    };
    const post = (body: string, extra = {}, path = url) =>
      fetch(path, { method: 'POST', headers: { ...headers, ...extra }, body });
    phase = 'checking token and Origin guards';
    assert.equal((await post('{}', { 'x-agent-token': '' })).status, 403);
    assert.equal((await post('{}', { origin: 'https://evil.test' })).status, 403);
    phase = 'checking Host guard';
    const foreignHost = await new Promise<number | undefined>((done, reject) => {
      const req = request(url, { method: 'POST', headers: { ...headers, host: 'evil.test' } }, (res) => {
        res.resume();
        done(res.statusCode);
      });
      req.on('error', reject);
      req.end('{}');
    });
    assert.equal(foreignHost, 403);
    phase = 'checking JSON guard';
    assert.equal((await post('x', { 'content-type': 'text/plain' }, base + '/api/conversations')).status, 415);
    phase = 'uploading raw JSON document';
    const saved = await post('{ raw document, not JSON }');
    assert.equal(saved.status, 201);
    const record = (await saved.json()) as { id: string; name: string };
    assert.equal(record.name, '测试.json');
    assert.equal(
      await (
        await fetch(`${url}/${record.id}/content`, { headers: { 'x-agent-token': token, 'x-pugport-owner': owner } })
      ).text(),
      '{ raw document, not JSON }',
    );
    phase = 'checking invalid uploads';
    for (const [body, extra, expected] of [
      ['', {}, /附件为空/],
      ['abc', { 'content-type': 'image/png' }, /不是有效的图片/],
      ['abc', { 'x-attachment-name': '%ZZ' }, /文件名无效/],
    ] as const) {
      const response = await post(body, extra);
      assert.equal(response.status, 400);
      assert.match(((await response.json()) as any).error, expected);
    }
    // Never end the request: 413 must arrive while the client is still uploading.
    phase = 'waiting for early 413 during oversize upload';
    const status = await new Promise<number | undefined>((done, reject) => {
      const req = request(
        url,
        { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream' } },
        (response) => {
          response.resume();
          done(response.statusCode);
          req.destroy();
        },
      );
      req.on('error', (error) => {
        // After a response, this promise is already settled; an earlier reset must fail promptly.
        reject(
          new Error(`Attachment HTTP failed at ${phase}: ${(error as NodeJS.ErrnoException).code ?? 'request error'}`),
        );
      });
      let sent = 0;
      const write = () => {
        while (sent < 51) {
          sent++;
          if (!req.write(Buffer.alloc(1024 * 1024))) {
            req.once('drain', write);
            return;
          }
        }
      };
      write();
    });
    assert.equal(status, 413);
    assert.ok(!readdirSync(join(data, 'attachments')).some((name) => name.endsWith('.tmp')));
    phase = 'complete';
  },
);

test('Claude prefers fitted 4.5 MB originals and all byte adapters cap each request at 20 MB', async (t) => {
  const { files, id } = fixture(t);
  const saved = await files.saveStream(id, { name: 'test.png', mimeType: 'image/png' }, Readable.from([await image()]));
  const original = files.get(id, saved.id);
  const largePath = join(files.directory, 'large.png');
  writeFileSync(largePath, Buffer.alloc(4.5 * 1024 * 1024));
  const large = { ...original, path: largePath, size: 4.5 * 1024 * 1024, fitted: original };
  const events: RunEvent[] = [];
  const ctx = {
    emit: (event: RunEvent) => {
      events.push(event);
    },
  };
  assert.equal(await executorImage(large, 'claude', ctx), original);
  assert.equal(await executorImage({ ...large, fitted: undefined }, 'claude', ctx), undefined);
  writeFileSync(largePath, Buffer.alloc(Math.floor(3.4 * 1024 * 1024)));
  for (const executor of ['claude', 'gemini', 'cursor', 'grok']) {
    const budget = { bytes: 0 };
    let sent = 0;
    for (let i = 0; i < 8; i++) {
      if (await executorImage({ ...large, fitted: undefined }, executor, ctx, budget)) sent++;
    }
    assert.equal(sent, 5);
    assert.ok(budget.bytes <= 20 * 1024 * 1024);
    assert.match(events.at(-1)!.text!, /20 MB.*跳过/);
    const fittedBudget = { bytes: 0 };
    for (let i = 0; i < 8; i++) assert.equal(await executorImage(large, executor, ctx, fittedBudget), original);
  }
});
