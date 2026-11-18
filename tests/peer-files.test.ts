import { memoryRecordStore as memoryStore } from './helpers/record-store.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, readdir, rename, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import fs, { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { Agent, request } from 'node:http';
import promises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { uploadFiles } from '../src/server/devices/file-transfer.ts';
import { safeSegment, maxPeerFileSize } from '../src/shared/peer-files.ts';
import {
  collectReturnFiles,
  downloadsFolder,
  fileBatchCheck,
  openRecordedFile,
  receiveFile,
  stripSendFileLines,
  validateFile,
  validateFiles,
} from '../src/server/node/peer-files.ts';
import { externalTaskRunner } from '../src/server/node/peer-tasks.ts';
import { projectFolderCheck } from '../src/server/node/device-node.ts';
import type { ExternalTasks } from '../src/server/external-tasks.ts';
import { fakeHost } from './helpers/fake-host.ts';
import { temporaryFolder, startPeer } from './helpers/fake-peer.ts';
import { largeFileId, mockFileIds } from './helpers/file-identity.ts';

async function* bytes(text: string) {
  yield Buffer.from(text);
}
const markerPath = (path: string) => path;
test('transfer deadlines scale with size and distinguish idle from total timeouts', async () => {
  const shared = await import('../src/shared/peer-files.ts');
  const files = await import('../src/server/node/peer-files.ts');
  assert.equal(shared.peerTransferLimitMs(2 * 1024 ** 3), 8192000);
  assert.equal(shared.peerTransferLimitMs(1), 1800000);
  const reason = await new Promise<string>((resolve) => {
    const deadline = files.transferDeadline(resolve, 100, 10);
    setTimeout(deadline.close, 30);
  });
  assert.equal(reason, 'total');
  const idle = await new Promise<string>((resolve) => {
    const deadline = files.transferDeadline(resolve, 10, 100);
    setTimeout(deadline.close, 30);
  });
  assert.equal(idle, 'idle');
});
test('upload window bytes have a separate limit and failure', async () => {
  const { uploadByteQuota, maxPeerWindowBytes } = await import('../src/shared/peer-files.ts');
  assert.equal(maxPeerWindowBytes, 4 * 1024 ** 3);
  assert.equal(uploadByteQuota(0, 9, 2, 10), 'window');
  assert.equal(uploadByteQuota(4 * 1024 ** 3, 0, 1, 10), 'batch');
});

test('safe segments block traversal, colon and Windows device names', () => {
  for (const name of ['../', '..', 'a:b', 'CON', 'NUL.txt', 'COM1', 'LPT9.log', '']) {
    const safe = safeSegment(name);
    assert.ok(safe && !safe.startsWith('.'));
    assert.doesNotMatch(safe, /[/:\\]|^(?:CON|NUL|COM1|LPT9)(?:\.|$)/i);
  }
  assert.equal(safeSegment('报告-1.txt'), '报告-1.txt');
});

test('device folders expand home-relative paths on the node without accepting home or root', async (t) => {
  const folder = temporaryFolder(t, 'peer-files-home-');
  await mkdir(join(folder, 'notes'));
  // The folder is in this computer's temporary folder, which macOS keeps below /private (a protected tree).
  const host = fakeHost(process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux', {
    home: folder,
    tmpdir: tmpdir(),
    fs,
  });
  const check = projectFolderCheck(host);
  assert.equal(check('~/notes'), join(folder, 'notes'));
  assert.equal(check('~'), undefined);
  assert.equal(check('~/'), undefined);
  assert.equal(check(host.path.parse(folder).root), undefined);
  const protectedName = process.platform === 'win32' ? '$Recycle.Bin' : '.Trash';
  await mkdir(join(folder, protectedName));
  assert.equal(check(join(folder, protectedName)), undefined);
});

test('receive files atomically, with unique names and no final file on mismatched bytes or free-space refusal', async (t) => {
  const folder = temporaryFolder(t, 'peer-files-receive-');
  const first = await receiveFile(bytes('one'), 3, folder, '../a:b.txt');
  const second = await receiveFile(bytes('two'), 3, folder, '../a:b.txt');
  assert.notEqual(first, second);
  assert.equal(await readFile(first, 'utf8'), 'one');
  assert.equal(await readFile(second, 'utf8'), 'two');
  const before = await readdir(folder);
  await assert.rejects(receiveFile(bytes('short'), 6, folder, 'short.txt'), /大小/);
  await assert.rejects(receiveFile(bytes('long'), 1, folder, 'long.txt'), /大小/);
  await assert.rejects(
    receiveFile(bytes('x'), 1, folder, 'space.txt', (async () => ({ bavail: 0, bsize: 4096 })) as never),
    /空间/,
  );
  assert.deepEqual(await readdir(folder), before);
  await assert.rejects(receiveFile(bytes(''), maxPeerFileSize + 1, folder, 'huge'), /2 GiB/);
});

test('batch caps cover count, each size and total bytes', () => {
  assert.throws(() => fileBatchCheck(Array.from({ length: 17 }, () => ({ size: 0 }))), /16/);
  assert.throws(() => fileBatchCheck([{ size: maxPeerFileSize + 1 }]), /2 GiB/);
  assert.throws(() => fileBatchCheck([{ size: maxPeerFileSize }, { size: maxPeerFileSize }, { size: 1 }]), /4 GiB/);
  fileBatchCheck([{ size: maxPeerFileSize }, { size: maxPeerFileSize }]);
});

test('file validation refuses directories, protected files and symlinks to protected files', async (t) => {
  const folder = temporaryFolder(t, 'peer-files-protected-');
  const protectedFolder = join(folder, 'system');
  await mkdir(protectedFolder);
  await writeFile(join(protectedFolder, 'fixture.txt'), 'synthetic');
  const host = fakeHost(process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux', {
    home: folder,
    env: { SystemRoot: protectedFolder },
  });
  // On non-Windows the protected key folder is also entirely synthetic.
  const protectedPath = process.platform === 'win32' ? protectedFolder : join(folder, '.ssh');
  await mkdir(protectedPath, { recursive: true });
  const secret = join(protectedPath, 'fixture.txt');
  await writeFile(secret, 'synthetic');
  await assert.rejects(validateFile(folder), /普通/);
  await assert.rejects(validateFile(secret, host), /受保护/);
  const link = join(folder, 'link');
  await symlink(protectedPath, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(validateFile(join(link, 'fixture.txt'), host), /受保护/);
  await assert.rejects(validateFiles(['relative.txt']), /绝对/);
  await assert.rejects(validateFile('/' + 'x'.repeat(4000)), /4000/);
});

test('recorded file identity detects a same-size replacement', async (t) => {
  const folder = temporaryFolder(t, 'peer-files-swap-');
  const file = join(folder, 'output.txt');
  await writeFile(file, 'one');
  const record = await validateFile(file);
  const handle = await openRecordedFile(record);
  await handle.close();
  await rename(file, join(folder, 'original.txt'));
  await writeFile(file, 'two');
  await assert.rejects(openRecordedFile(record), /改变/);
});

test('recorded file identity preserves high file-ID bits when checking a replacement', async (t) => {
  const folder = temporaryFolder(t, 'peer-files-large-id-');
  const path = join(folder, 'file.txt');
  await writeFile(path, 'synthetic');
  const ids = mockFileIds(t, [[path, largeFileId]]);
  const record = await validateFile(path);
  const handle = await openRecordedFile(record);
  await handle.close();
  ids.set(path, largeFileId + 1n);
  await assert.rejects(openRecordedFile(record), /改变/);
});

test('return markers are whole lines across every step, even after the reply limit, and untrusted tasks cannot send', async (t) => {
  const folder = temporaryFolder(t, 'peer-files-marker-');
  const paths = [join(folder, 'first.txt'), join(folder, 'second.txt')];
  for (const path of paths) await writeFile(path, 'synthetic');
  const outputs = [
    `Step 1\nPUGPORT_SEND_FILE: ${markerPath(paths[0]!)}\n`,
    `${'x'.repeat(200_001)}\nPUGPORT_SEND_FILE: ${markerPath(paths[1]!)}\r\n`,
  ];
  const { files } = await collectReturnFiles(outputs, false);
  assert.equal(files.length, 2);
  assert.deepEqual(
    files.map((f) => f.name),
    ['first.txt', 'second.txt'],
  );
  assert.deepEqual(await collectReturnFiles(outputs, true), { files: [], refused: [] });
  assert.equal(stripSendFileLines('before\nPUGPORT_SEND_FILE: /a\r\nafter\n'), 'before\nafter');
  // The answer usually ends with its file lines after a blank line: nothing blank is left behind.
  assert.equal(stripSendFileLines('Done.\n\nPUGPORT_SEND_FILE: /a\n\nPUGPORT_SEND_FILE: /b\n'), 'Done.');
  assert.equal(stripSendFileLines('one\n\nPUGPORT_SEND_FILE: /a\n\ntwo'), 'one\n\ntwo');
  assert.equal(stripSendFileLines('kept\n\n\n\nas written\n'), 'kept\n\n\n\nas written\n');
  assert.equal(stripSendFileLines('quoted PUGPORT_SEND_FILE: /a'), 'quoted PUGPORT_SEND_FILE: /a');
  assert.deepEqual(await collectReturnFiles(['PUGPORT_SEND_FILE: relative'], false), { files: [], refused: [] });
});

test('peer request ids dedupe concurrent dispatches and survive runner recreation', async () => {
  const store = memoryStore();
  let calls = 0;
  let submitted: unknown;
  const tasks = {
    dispatch: async (input: unknown) => {
      calls++;
      submitted = input;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { taskId: 'task-1', status: 'queued' };
    },
  } as unknown as ExternalTasks;
  const input = {
    task: 'synthetic',
    write: true,
    untrusted: false,
    projectPath: '/fixture',
    requestId: 'retry-1',
    caller: 'Desk',
  };
  const runner = externalTaskRunner(tasks, store);
  const replies = await Promise.all([runner.dispatch(input, 'peer-1'), runner.dispatch(input, 'peer-1')]);
  assert.deepEqual(replies[0], replies[1]);
  assert.equal(calls, 1);
  assert.equal((submitted as { source: string }).source, 'device');
  await externalTaskRunner(tasks, store).dispatch(input, 'peer-1');
  assert.equal(calls, 1);
  await runner.dispatch(input, 'peer-2');
  assert.equal(calls, 2, 'request ids are scoped to their peer');
});

test('a failed dispatch reservation can be retried but an uncertain reservation cannot', async () => {
  const store = memoryStore();
  let calls = 0;
  const tasks = {
    dispatch: async () => {
      calls++;
      throw new Error('synthetic interruption');
    },
  } as unknown as ExternalTasks;
  const input = {
    task: 'x',
    write: true,
    untrusted: false,
    projectPath: '/fixture',
    requestId: 'crash-1',
    caller: 'Desk',
  };
  await assert.rejects(externalTaskRunner(tasks, store).dispatch(input, 'peer-1'), /synthetic interruption/);
  await assert.rejects(externalTaskRunner(tasks, store).dispatch(input, 'peer-1'), /synthetic interruption/);
  assert.equal(calls, 2);
  store.save('peer-request', 'peer-1:crash-1', 'peer-1', { status: 'dispatching' });
  await assert.rejects(externalTaskRunner(tasks, store).dispatch(input, 'peer-1'), /uncertain|不确定/);
  assert.equal(calls, 2);
});

test('receive removes only stale partial files in the destination folder', async (t) => {
  const folder = temporaryFolder(t, 'peer-files-stale-');
  for (const name of ['.pugport-old.part', '.pugport-new.part', 'keep.part']) await writeFile(join(folder, name), 'x');
  const old = new Date(Date.now() - 2 * 86400_000);
  await utimes(join(folder, '.pugport-old.part'), old, old);
  await utimes(join(folder, 'keep.part'), old, old);
  await receiveFile(bytes('x'), 1, folder, 'output.txt');
  assert.deepEqual((await readdir(folder)).sort(), ['.pugport-new.part', 'keep.part', 'output.txt'].sort());
});

test('one refused return file does not discard a valid file and names the failure', async (t) => {
  const folder = temporaryFolder(t, 'peer-files-partial-');
  const good = join(folder, 'good.txt');
  await writeFile(good, 'synthetic');
  const output = `answer\nPUGPORT_SEND_FILE: ${markerPath(good)}\nPUGPORT_SEND_FILE: ${markerPath(join(folder, 'missing.txt'))}`;
  const tasks = {
    result: async () => ({ status: 'completed', result: output }),
    fullOutputs: () => [output],
  } as unknown as ExternalTasks;
  const result = await externalTaskRunner(tasks, memoryStore()).result('task', 0);
  assert.equal(result?.files?.length, 1);
  assert.equal(result?.files?.[0]?.name, 'good.txt');
  assert.match(result!.result!, /missing.txt: /);
  assert.doesNotMatch(result!.result!, /PUGPORT_SEND_FILE/);
});

test('macOS permission refusals name the file and explain Full Disk Access for the node', async (t) => {
  const folder = temporaryFolder(t, 'peer-files-tcc-');
  const path = join(folder, 'Desktop-example.txt');
  await writeFile(path, 'synthetic');
  const record = await validateFile(path);
  const host = fakeHost('darwin');
  t.mock.method(promises, 'open', async () => {
    throw Object.assign(new Error('denied'), { code: 'EPERM' });
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(openRecordedFile(record, host), (error: Error) => {
    assert.ok(error.message.includes(path));
    assert.match(error.message, /macOS.*系统设置 → 隐私与安全性 → 完全磁盘访问权限/);
    assert.ok(error.message.includes(process.execPath), 'allow the running binary, not a bundled symlink');
    return true;
  });
  t.mock.method(promises, 'realpath', async () => {
    throw Object.assign(new Error('denied'), { code: 'EACCES' });
  });
  syncBuiltinESMExports();
  await assert.rejects(validateFile(path, host), /macOS.*Desktop-example.txt/);
});

test('final reply file markers are collected even when absent from run events', async (t) => {
  const folder = temporaryFolder(t, 'peer-files-final-');
  const path = join(folder, 'final.txt');
  await writeFile(path, 'synthetic');
  const tasks = {
    result: async () => ({ status: 'completed', result: `PUGPORT_SEND_FILE: ${path}` }),
    fullOutputs: () => ['Earlier text.'],
  } as unknown as ExternalTasks;
  const result = await externalTaskRunner(tasks, memoryStore()).result('task', 0);
  assert.equal(result?.files?.[0]?.name, 'final.txt');
  assert.doesNotMatch(result!.result!, /PUGPORT_SEND_FILE/);
});

test('transfer refusals include bounded JSON errors and older upload routes show the full update command', async (t) => {
  const folder = temporaryFolder(t, 'peer-files-refusal-');
  const path = join(folder, 'file.txt');
  await writeFile(path, 'synthetic');
  const files = await validateFiles([path]);
  for (const status of [404, 415, 403]) {
    let reads = 0;
    let cancelled = false;
    const connection = {
      address: { host: '127.0.0.1', port: 1234 },
      token: 'synthetic',
      name: 'fixture-box',
      fetch: async () =>
        new Response(
          new ReadableStream(
            {
              pull(controller) {
                if (reads++ === 0) controller.enqueue(Buffer.from('{"error":"synthetic refusal"}'));
                else controller.close();
              },
              cancel() {
                cancelled = true;
              },
            },
            { highWaterMark: 0 },
          ),
          { status },
        ),
    };
    await assert.rejects(uploadFiles(connection, files), (error: Error) => {
      assert.match(error.message, /synthetic refusal/);
      if (status !== 403) assert.match(error.message, /fixture-box.*pugport node add <ssh target> --now/);
      return true;
    });
    assert.ok(reads <= 2);
    // An oversized error must stop reading, even if the peer never ends its stream.
    connection.fetch = async () =>
      new Response(
        new ReadableStream(
          {
            pull(controller) {
              reads++;
              controller.enqueue(Buffer.alloc(1024, 120));
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
        { status },
      );
    reads = 0;
    await assert.rejects(uploadFiles(connection, files));
    assert.equal(reads, 1);
    assert.ok(cancelled);
  }
});

test('SSE outlives the ordinary request deadline', async (t) => {
  const peer = await paired(t, { requestTimeoutMs: 50, eventPollMs: 10 });
  const created = await peer.runner.dispatch(
    { task: 'x', write: false, untrusted: false, caller: 'Desk' },
    peer.registry.list()[0]!.id,
  );
  const response = await fetch(`${peer.url}/peer/v1/tasks/${created.taskId}/events`, { headers: peer.headers });
  const body = response.text();
  const settled = body.then(
    (text) => ({ text }),
    (error: unknown) => ({ error }),
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  peer.finish(created.taskId, 'done');
  const result = await settled;
  assert.ok('text' in result);
  assert.match(result.text!, /event: result/);
});

test('an unauthorized upload closes the request after sending its 401', async (t) => {
  const peer = await paired(t);
  await new Promise<void>((resolve, reject) => {
    const agent = new Agent({ keepAlive: true });
    t.after(() => agent.destroy());
    const req = request(`${peer.url}/peer/v1/files?name=x&size=100`, {
      method: 'PUT',
      agent,
      headers: { 'content-length': '100', 'content-type': 'application/octet-stream' },
    });
    t.after(() => req.destroy());
    const timer = setTimeout(() => reject(new Error('unauthorized upload stayed open')), 1000);
    req.on('response', (res) => {
      assert.equal(res.statusCode, 401);
      res.resume();
    });
    req.on('socket', (socket) => {
      socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    req.on('error', reject);
    req.flushHeaders();
  });
});

test('settled results validate return files once and strip markers before reply truncation', async (t) => {
  const folder = temporaryFolder(t, 'peer-files-results-');
  const path = join(folder, 'result.txt');
  await writeFile(path, 'synthetic');
  let scans = 0;
  const output = `PUGPORT_SEND_FILE: ${markerPath(path)}\n${'x'.repeat(220_000)}`;
  const tasks = {
    dispatch: async () => ({ taskId: 'task-1', status: 'queued' }),
    result: async () => ({ status: 'completed', result: output }),
    fullOutputs: () => {
      scans++;
      return [output];
    },
  } as unknown as ExternalTasks;
  const store = memoryStore();
  const runner = externalTaskRunner(tasks, store);
  await runner.dispatch({ task: 'x', write: false, untrusted: false, caller: 'Desk' }, 'peer-1');
  const result = await runner.result('task-1', 0);
  assert.equal(result?.files?.length, 1);
  assert.equal(result?.result?.length, 200_000);
  assert.doesNotMatch(result!.result!, /PUGPORT_SEND_FILE/);
  await unlink(path);
  assert.deepEqual(await externalTaskRunner(tasks, store).result('task-1', 0), result);
  assert.equal(scans, 1, 'polls do not revalidate or reread files');
  assert.ok(runner.file!('task-1', result!.files![0]!.id));
});

test('continuing a blocked task refreshes its cached answer and return files once', async (t) => {
  const folder = temporaryFolder(t, 'peer-files-continue-');
  const path = join(folder, 'continued.txt');
  await writeFile(path, 'synthetic');
  let continued = false;
  let scans = 0;
  const tasks = {
    find: () => ({ id: continued ? 'successor' : 'original', input: {} }),
    result: async () =>
      continued ? { status: 'completed', result: 'new answer' } : { status: 'blocked', error: 'needs input' },
    fullOutputs: () => {
      scans++;
      return continued ? [`PUGPORT_SEND_FILE: ${path}`] : [];
    },
  } as unknown as ExternalTasks;
  const store = memoryStore();
  const runner = externalTaskRunner(tasks, store);
  assert.equal((await runner.result('original', 0))?.status, 'blocked');
  continued = true;
  const result = await runner.result('original', 0);
  assert.equal(result?.status, 'completed');
  assert.equal(result?.result, 'new answer');
  assert.equal(result?.files?.[0]?.name, 'continued.txt');
  await externalTaskRunner(tasks, store).result('original', 0);
  assert.equal(scans, 2);
});

test('legacy task records still obey the workflow untrusted restriction', async () => {
  const store = memoryStore();
  store.save('peer-task', 'old-task', 'peer-1', { peerId: 'peer-1' });
  const tasks = {
    result: async () => ({ status: 'completed', result: 'PUGPORT_SEND_FILE: /synthetic\nanswer' }),
    find: () => ({ input: { untrustedContent: true } }),
    fullOutputs: () => ['PUGPORT_SEND_FILE: /synthetic'],
  } as unknown as ExternalTasks;
  const result = await externalTaskRunner(tasks, store).result('old-task', 0);
  assert.equal(result?.result, 'answer');
  assert.equal(result?.files, undefined);
});

async function paired(t: Parameters<typeof startPeer>[0], options: Parameters<typeof startPeer>[1] = {}) {
  const peer = await startPeer(t, options);
  const paired = await peer.registry.pair(peer.registry.createCode().code, 'Desk');
  assert.equal(typeof paired, 'object');
  if (typeof paired !== 'object') throw new Error('pairing failed');
  return { ...peer, headers: { authorization: `Bearer ${paired.token}` } };
}

test('writes default on, legacy allow-write zero is ignored and new read-only opt-out refuses', async (t) => {
  const previous = { legacy: process.env.PUGPORT_PEER_ALLOW_WRITE, readOnly: process.env.PUGPORT_PEER_READ_ONLY };
  t.after(() => {
    for (const [key, value] of [
      ['PUGPORT_PEER_ALLOW_WRITE', previous.legacy],
      ['PUGPORT_PEER_READ_ONLY', previous.readOnly],
    ]) {
      if (value === undefined) delete process.env[key!];
      else process.env[key!] = value;
    }
  });
  process.env.PUGPORT_PEER_ALLOW_WRITE = '0';
  delete process.env.PUGPORT_PEER_READ_ONLY;
  const peer = await paired(t, {
    allowWrite: process.env.PUGPORT_PEER_READ_ONLY !== '1',
    projectFolder: (path) => (path === '/fixture' ? path : undefined),
  });
  const post = () =>
    fetch(`${peer.url}/peer/v1/tasks`, {
      method: 'POST',
      headers: { ...peer.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'synthetic', projectPath: '/fixture', write: true }),
    });
  assert.equal((await post()).status, 201);
  assert.equal((await (await fetch(`${peer.url}/peer/v1/info`, { headers: peer.headers })).json()).allowWrite, true);
  process.env.PUGPORT_PEER_READ_ONLY = '1';
  const readOnly = await paired(t, {
    allowWrite: process.env.PUGPORT_PEER_READ_ONLY !== '1',
    projectFolder: (path) => path,
  });
  assert.equal(
    (
      await fetch(`${readOnly.url}/peer/v1/tasks`, {
        method: 'POST',
        headers: { ...readOnly.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ task: 'x', projectPath: '/fixture', write: true }),
      })
    ).status,
    400,
  );
  assert.equal(
    (await (await fetch(`${readOnly.url}/peer/v1/info`, { headers: readOnly.headers })).json()).allowWrite,
    false,
  );
});

test('raw authenticated upload bypasses JSON parser, sanitizes paths and gives repeat uploads unique names', async (t) => {
  const peer = await paired(t);
  // macOS keeps temporary files in /var/folders/…/T (really /private/var/…), named neither Temp nor tmp.
  assert.ok(
    /Temp|tmp/i.test(downloadsFolder()) || downloadsFolder().startsWith(realpathSync(tmpdir()) + sep),
    'never the real Downloads',
  );
  const upload = (id: string, body = 'abc', size = body.length, extra = {}) =>
    fetch(
      `${peer.url}/peer/v1/files?${new URLSearchParams({ name: '../CON:a.txt', size: String(size), requestId: id })}`,
      { method: 'PUT', headers: { ...peer.headers, 'content-type': 'application/octet-stream', ...extra }, body },
    );
  assert.equal((await upload('origin-0', 'abc', 3, { origin: 'https://fixture.invalid' })).status, 403);
  const first = await upload('batch-0');
  assert.equal(first.status, 200);
  const saved = (await first.json()).path;
  assert.equal(await readFile(saved, 'utf8'), 'abc');
  assert.match(saved, /from-Desk/);
  assert.notEqual((await (await upload('batch-0')).json()).path, saved);
  assert.match(saved, /PugPort[\\/]Received[\\/]from-Desk/);
  assert.ok(!saved.startsWith(downloadsFolder()));
  assert.equal((await upload('mismatch-0', 'abc', 4)).status, 400);
  for (let index = 1; index < 16; index++) assert.equal((await upload(`batch-${index}`, '', 0)).status, 200);
  assert.equal((await upload('batch-16', '', 0)).status, 200);
});

test('non-transfer deadline remains, while a slow steady transfer outlives that deadline', async (t) => {
  const peer = await paired(t, { requestTimeoutMs: 60, transferIdleMs: 80 });
  const created = await (
    await fetch(`${peer.url}/peer/v1/tasks`, {
      method: 'POST',
      headers: { ...peer.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'x' }),
    })
  ).json();
  await assert.rejects(fetch(`${peer.url}/peer/v1/tasks/${created.taskId}/result?wait=5`, { headers: peer.headers }));
  async function* steady() {
    for (let n = 0; n < 5; n++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      yield Buffer.from('a');
    }
  }
  const reply = await fetch(`${peer.url}/peer/v1/files?name=steady.txt&size=5&requestId=steady-0`, {
    method: 'PUT',
    headers: { ...peer.headers, 'content-type': 'application/octet-stream' },
    body: steady() as unknown as BodyInit,
    duplex: 'half',
  } as RequestInit);
  assert.equal(reply.status, 200);
  assert.equal((await stat((await reply.json()).path)).size, 5);
});

test('download route enforces task ownership and refuses file replacement after validation', async (t) => {
  const folder = temporaryFolder(t, 'peer-files-download-');
  const file = join(folder, 'artifact.txt');
  await writeFile(file, 'one');
  const record = await validateFile(file);
  const peer = await paired(t);
  const created = await peer.runner.dispatch(
    { task: 'x', write: false, untrusted: false, caller: 'Desk' },
    peer.registry.list()[0]!.id,
  );
  peer.runner.file = (taskId, fileId) => (taskId === created.taskId && fileId === record.id ? record : undefined);
  const url = `${peer.url}/peer/v1/tasks/${created.taskId}/files/${record.id}`;
  assert.equal((await fetch(url)).status, 401);
  const other = await peer.registry.pair(peer.registry.createCode().code, 'Laptop');
  assert.equal(typeof other, 'object');
  if (typeof other !== 'object') throw new Error('pair failed');
  assert.equal((await fetch(url, { headers: { authorization: `Bearer ${other.token}` } })).status, 404);
  assert.equal(await (await fetch(url, { headers: peer.headers })).text(), 'one');
  assert.equal((await fetch(url.replace(record.id, 'missing'), { headers: peer.headers })).status, 404);
  await rename(file, join(folder, 'old.txt'));
  await writeFile(file, 'two');
  assert.equal((await fetch(url, { headers: peer.headers })).status, 400);
});

test('unmatched file-shaped requests still have the ordinary body deadline', async (t) => {
  const peer = await paired(t, { requestTimeoutMs: 40 });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('request escaped its deadline')), 1000);
    const req = request(`${peer.url}/peer/v1/tasks/fixture/files/fixture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '100' },
    });
    t.after(() => req.destroy());
    req.on('error', () => {
      clearTimeout(timer);
      resolve();
    });
    req.flushHeaders();
  });
});

test('peer uploads enforce batch and per-peer quotas, concurrency caps, total deadlines, atomic space reserve, and abort cleanup', async (t) => {
  const folder = temporaryFolder(t, 'peer-files-reserve-');
  const reserve = 2 * 1024 ** 3;
  const available = (async () => ({ bavail: reserve + 100, bsize: 1 })) as never;
  let releaseFirst!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  async function* held(text: string) {
    yield Buffer.from(text);
    await gate;
  }
  const firstReceive = receiveFile(held('a'.repeat(80)), 80, folder, 'first.txt', available);
  await new Promise((resolve) => setTimeout(resolve, 25));
  await assert.rejects(
    receiveFile(bytes('b'.repeat(80)), 80, folder, 'second.txt', available),
    /可用空间不足/,
    'concurrent transfer must not spend the same 2 GiB reserve',
  );
  releaseFirst();
  assert.equal((await stat(await firstReceive)).size, 80);

  const abortFolder = temporaryFolder(t, 'peer-files-abort-');
  const controller = new AbortController();
  async function* stalled() {
    yield Buffer.from('part');
    await new Promise(() => {});
  }
  const abortedReceive = receiveFile(stalled(), 10, abortFolder, 'aborted.txt', undefined, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 25));
  controller.abort(new Error('synthetic abort'));
  await assert.rejects(abortedReceive, /synthetic abort/);
  assert.deepEqual(await readdir(abortFolder), [], 'aborted receive cleans up its .part file');

  const peer = await paired(t, {
    transferIdleMs: 80,
    transferMaxMs: 90,
    maxConcurrentTransfersPerPeer: 2,
    maxUploadFilesPerPeer: 20,
    maxUploadBytesPerPeer: 50,
  });
  const upload = (id: string, body = 'a', size = body.length) =>
    fetch(`${peer.url}/peer/v1/files?${new URLSearchParams({ name: 'item.txt', size: String(size), requestId: id })}`, {
      method: 'PUT',
      headers: { ...peer.headers, 'content-type': 'application/octet-stream' },
      body,
    });

  for (let index = 0; index < 16; index++) assert.equal((await upload('same-batch', 'a', 1)).status, 200);
  const seventeenth = await upload('same-batch', 'a', 1);
  assert.equal(seventeenth.status, 400);
  assert.match((await seventeenth.json()).error, /16 个文件/);

  const overBytes = await upload('bytes-batch', 'x'.repeat(40), 40);
  assert.equal(overBytes.status, 429);
  assert.match((await overBytes.json()).error, /10 分钟/);

  for (let index = 0; index < 4; index++) assert.equal((await upload(`extra-${index}`, 'a', 1)).status, 200);
  const overPeerCount = await upload('extra-4', 'a', 1);
  assert.equal(overPeerCount.status, 429);

  const peer2 = await paired(t, {
    transferIdleMs: 80,
    transferMaxMs: 90,
    maxConcurrentTransfersPerPeer: 2,
  });
  let releaseHold!: () => void;
  const hold = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  const slowStream = () =>
    (async function* () {
      yield Buffer.from('a');
      await hold;
      yield Buffer.from('b');
    })();
  const putSlow = (id: string) =>
    fetch(`${peer2.url}/peer/v1/files?name=concurrent.txt&size=2&requestId=${id}`, {
      method: 'PUT',
      headers: { ...peer2.headers, 'content-type': 'application/octet-stream' },
      body: slowStream() as unknown as BodyInit,
      duplex: 'half',
    } as RequestInit);
  const inFlight1 = putSlow('c-1');
  const inFlight2 = putSlow('c-2');
  await new Promise((resolve) => setTimeout(resolve, 30));
  const thirdConcurrent = await fetch(`${peer2.url}/peer/v1/files?name=concurrent.txt&size=1&requestId=c-3`, {
    method: 'PUT',
    headers: { ...peer2.headers, 'content-type': 'application/octet-stream' },
    body: 'x',
  });
  assert.equal(thirdConcurrent.status, 429);
  releaseHold();
  assert.equal((await inFlight1).status, 200);
  assert.equal((await inFlight2).status, 200);

  async function* endlessSteady() {
    for (let n = 0; n < 10; n++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      yield Buffer.from('a');
    }
  }
  await assert.rejects(
    fetch(`${peer2.url}/peer/v1/files?name=deadline.txt&size=10&requestId=deadline-1`, {
      method: 'PUT',
      headers: { ...peer2.headers, 'content-type': 'application/octet-stream' },
      body: endlessSteady() as unknown as BodyInit,
      duplex: 'half',
    } as RequestInit),
  );
});
