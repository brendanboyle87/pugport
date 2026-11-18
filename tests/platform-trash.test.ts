import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { systemTrashName } from '../src/shared/trash.ts';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import AdmZip from 'adm-zip';
import { ExtensionHub, extractZip } from '../src/server/extensions.ts';
import { writeMemorySyncHelper } from '../src/server/local-memory.ts';
import type { Host } from '../src/server/platform/host.ts';
import {
  encodeTrashPath,
  freedesktopTrashForTest,
  homeTrash,
  macTrashScript,
  moveToTrash,
  recycleScript,
  trashInfo,
  trashName,
} from '../src/server/platform/trash.ts';
import { fakeFs, fakeHost, recordingRun } from './helpers/fake-host.ts';

/*
 * Trash on macOS and Linux. Only temporary folders are touched: the Linux Trash is a fake home inside a
 * temporary folder, and macOS never runs (osascript is replaced).
 */

test('Windows scripts encode smart quotes safely and keep operation-specific failure messages', async () => {
  const input = 'C:\\Tom’s ‘PugPort’\\input.json';
  const output = 'C:\\Tom’s ‘PugPort’\\output.json';
  const script = recycleScript(input, output);
  assert.doesNotMatch(script, /[‘’]/);
  assert.deepEqual(
    [...script.matchAll(/FromBase64String\('([A-Za-z0-9+/=]*)'\)/g)].map((match) =>
      Buffer.from(match[1]!, 'base64').toString('utf8'),
    ),
    [input, output],
  );
  const module = { exports: {} as typeof import('../src/server/platform/trash.ts') };
  const powershell = { exports: {} as typeof import('../src/server/platform/powershell.ts') };
  const host = fakeHost('win32', {
    tmpdir: 'C:\\Tom’s PugPort',
    fs: fakeFs({ promises: { writeFile: async () => {}, rm: async () => {} } }),
  });
  let calls = 0;
  const context = {
    Buffer,
    setTimeout,
    clearTimeout,
    require: (name: string) => {
      if (name === 'node:crypto') return { randomUUID: () => 'synthetic' };
      if (name === './host.ts') return { currentHost: () => host };
      if (name === './powershell.ts') return powershell.exports;
      if (name === '../../shared/trash.ts') return { systemTrashName };
      assert.equal(name, './test-process.ts');
      return {
        spawn: (_exe: string, args: string[]) => {
          calls++;
          const decoded = Buffer.from(args.at(-1)!, 'base64').toString('utf16le');
          assert.doesNotMatch(decoded, /[‘’]/);
          const stream = () => Object.assign(new EventEmitter(), { setEncoding() {} });
          const child = Object.assign(new EventEmitter(), { stdout: stream(), stderr: stream(), kill() {} });
          queueMicrotask(() => {
            child.stderr.emit('data', 'synthetic denied');
            child.emit('close', 1);
          });
          return child;
        },
      };
    },
  };
  for (const [file, target] of [
    ['powershell', powershell],
    ['trash', module],
  ] as const) {
    const { code } = transformSync(readFileSync(`src/server/platform/${file}.ts`, 'utf8'), {
      loader: 'ts',
      format: 'cjs',
    });
    runInNewContext(code, { ...context, module: target });
  }
  await assert.rejects(
    module.exports.moveToTrash(['C:\\synthetic'], undefined, host),
    /回收站操作未完成：synthetic denied/,
  );
  await assert.rejects(
    powershell.exports.runPowerShell('synthetic', '无法修改 PATH{0}', undefined, 1000, host),
    /无法修改 PATH：synthetic denied/,
  );
  assert.equal(calls, 2);
});

function scratch(t: TestContext) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-trash-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A Linux host whose home is a temporary folder, using this machine's own path rules and file system. */
function linuxIn(root: string, overrides: Partial<Host> = {}): Host {
  return fakeHost('linux', { home: join(root, 'home'), tmpdir: root, path, fs, ...overrides });
}

test('trash info follows the freedesktop format: percent-encoded path and local time', () => {
  assert.equal(encodeTrashPath("/home/me/My Files/it's (1)!*.txt"), '/home/me/My%20Files/it%27s%20%281%29%21%2A.txt');
  assert.equal(encodeTrashPath('/home/me/照片/a#b%.jpg'), '/home/me/%E7%85%A7%E7%89%87/a%23b%25.jpg');
  assert.equal(
    trashInfo('/home/me/résumé.pdf', new Date(2026, 9, 11, 9, 5, 3)),
    '[Trash Info]\nPath=/home/me/r%C3%A9sum%C3%A9.pdf\nDeletionDate=2026-10-11T09:05:03\n',
  );
  assert.equal(homeTrash(fakeHost('linux')), '/home/fixture/.local/share/Trash');
  assert.equal(homeTrash(fakeHost('linux', { env: { XDG_DATA_HOME: '/data' } })), '/data/Trash');
  assert.equal(
    homeTrash(fakeHost('linux', { env: { XDG_DATA_HOME: 'relative' } })),
    '/home/fixture/.local/share/Trash',
  );
  assert.equal(trashName(fakeHost('darwin')), '废纸篓');
  assert.equal(trashName(fakeHost('linux')), '回收站');
});

test('Linux moves items into the home Trash with a reserved .trashinfo and never overwrites', async (t) => {
  const root = scratch(t);
  const project = join(root, 'home', 'project');
  mkdirSync(join(project, 'folder'), { recursive: true });
  writeFileSync(join(project, 'a.txt'), 'first');
  writeFileSync(join(project, 'folder', 'inner.txt'), 'inside');
  const host = linuxIn(root);
  const when = new Date(2026, 9, 11, 12, 0, 0);
  const results = await freedesktopTrashForTest(
    [join(project, 'a.txt'), join(project, 'folder')],
    undefined,
    host,
    () => when,
  );
  assert.deepEqual(results, [
    { path: join(project, 'a.txt'), ok: true },
    { path: join(project, 'folder'), ok: true },
  ]);
  const trash = join(root, 'home', '.local', 'share', 'Trash');
  assert.equal(readFileSync(join(trash, 'files', 'a.txt'), 'utf8'), 'first');
  assert.equal(readFileSync(join(trash, 'files', 'folder', 'inner.txt'), 'utf8'), 'inside');
  assert.equal(readFileSync(join(trash, 'info', 'a.txt.trashinfo'), 'utf8'), trashInfo(join(project, 'a.txt'), when));
  assert.ok(existsSync(join(trash, 'info', 'folder.trashinfo')));
  assert.equal(existsSync(join(project, 'a.txt')), false);

  // The same name again gets its own entry; a stray entry without .trashinfo is left alone.
  writeFileSync(join(project, 'a.txt'), 'second');
  writeFileSync(join(trash, 'files', 'b.txt'), 'stray, not ours');
  writeFileSync(join(project, 'b.txt'), 'new b');
  const again = await moveToTrash([join(project, 'a.txt'), join(project, 'b.txt')], undefined, host);
  assert.ok(again.every((result) => result.ok));
  assert.equal(readFileSync(join(trash, 'files', 'a.2.txt'), 'utf8'), 'second');
  assert.equal(readFileSync(join(trash, 'files', 'b.txt'), 'utf8'), 'stray, not ours');
  assert.equal(readFileSync(join(trash, 'files', 'b.2.txt'), 'utf8'), 'new b');
  assert.deepEqual(readdirSync(join(trash, 'info')).sort(), [
    'a.2.txt.trashinfo',
    'a.txt.trashinfo',
    'b.2.txt.trashinfo',
    'folder.trashinfo',
  ]);
});

test('Linux refuses items on another file system instead of copying and deleting them', async (t) => {
  const root = scratch(t);
  const project = join(root, 'home', 'project');
  mkdirSync(project, { recursive: true });
  const item = join(project, 'on-usb.txt');
  writeFileSync(item, 'keep me');
  const elsewhere = new Proxy(fs, {
    get(target, name: string) {
      if (name !== 'promises') return Reflect.get(target, name);
      return new Proxy(target.promises, {
        get(inner, call: string) {
          if (call !== 'lstat') return Reflect.get(inner, call);
          return async (file: string) => {
            const info = await inner.lstat(file);
            return file === item ? Object.assign(info, { dev: info.dev + 1 }) : info;
          };
        },
      });
    },
  });
  const [result] = await moveToTrash([item], undefined, linuxIn(root, { fs: elsewhere }));
  assert.equal(result!.ok, false);
  assert.match(result!.reason!, /不在主文件夹所在的磁盘上/);
  assert.equal(readFileSync(item, 'utf8'), 'keep me');
  assert.deepEqual(readdirSync(join(root, 'home', '.local', 'share', 'Trash', 'info')), []);

  const missing = await moveToTrash([join(project, 'gone.txt')], undefined, linuxIn(root));
  assert.deepEqual(missing, [{ path: join(project, 'gone.txt'), ok: false, reason: '不存在' }]);
  const controller = new AbortController();
  controller.abort();
  const cancelled = await moveToTrash([item], controller.signal, linuxIn(root));
  assert.deepEqual(cancelled, [{ path: item, ok: false, reason: '已取消' }]);
  assert.ok(existsSync(item));
});

test('macOS hands the paths to NSFileManager trashItemAtURL through osascript, never removeItem', async (t) => {
  assert.match(macTrashScript, /ObjC\.import\('Foundation'\)/);
  assert.match(macTrashScript, /trashItemAtURLResultingItemURLError/);
  assert.doesNotMatch(macTrashScript, /removeItem|unlink|rm -/);
  const root = scratch(t);
  let input = '';
  const recorded = recordingRun((_file, args) => {
    input = args.at(-1)!;
    const paths = JSON.parse(readFileSync(input, 'utf8')) as string[];
    assert.deepEqual(paths, ['/Users/fixture/a.txt', '/Volumes/NAS/b.txt']);
    assert.equal(statSync(input).isFile(), true);
    return JSON.stringify([
      { path: paths[0], ok: true },
      { path: paths[1], ok: false, reason: '' },
    ]);
  });
  const host = fakeHost('darwin', { tmpdir: root, path, fs, run: recorded.run });
  const results = await moveToTrash(['/Users/fixture/a.txt', '/Volumes/NAS/b.txt'], undefined, host);
  assert.deepEqual(results, [
    { path: '/Users/fixture/a.txt', ok: true },
    { path: '/Volumes/NAS/b.txt', ok: false, reason: '未能移到废纸篓' },
  ]);
  assert.equal(recorded.calls[0]!.file, '/usr/bin/osascript');
  assert.deepEqual(recorded.calls[0]!.args.slice(0, 3), ['-l', 'JavaScript', '-e']);
  assert.equal(recorded.calls[0]!.args[3], macTrashScript);
  assert.equal(existsSync(input), false, 'the list of paths is removed afterwards');
  const broken = fakeHost('darwin', { tmpdir: root, path, fs, run: () => ({ stdout: 'not json', stderr: '' }) });
  await assert.rejects(moveToTrash(['/x'], undefined, broken), /废纸篓操作未完成/);
  await assert.rejects(moveToTrash(['/x'], undefined, { ...fakeHost('linux'), platform: 'freebsd' }), /不支持/);
});

test('POSIX memory sync helper is a single-quoted sh script', (t) => {
  const root = scratch(t);
  const project = join(root, 'project');
  mkdirSync(project);
  const id = '12345678-1234-4234-8234-123456789abc';
  const linux = fakeHost('linux');
  writeMemorySyncHelper(project, "/opt/it's node/node", '/opt/app/cli.js', join(root, 'data $HOME'), id, linux);
  const file = join(project, '.comborunner', 'sync-memory.sh');
  const text = readFileSync(file, 'utf8');
  assert.equal(
    text,
    [
      '#!/bin/sh',
      'ELECTRON_RUN_AS_NODE=1',
      `COMBORUNNER_DATA_DIR='${path.resolve(join(root, 'data $HOME'))}'`,
      'export ELECTRON_RUN_AS_NODE COMBORUNNER_DATA_DIR',
      `exec '/opt/it'\\''s node/node' '/opt/app/cli.js' '${id}'`,
      '',
    ].join('\n'),
  );
  // Created as 0755 (minus the umask): always executable by its owner.
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o700, 0o700);
  assert.equal(existsSync(join(project, '.comborunner', 'sync-memory.cmd')), false);
  for (const bad of ['line\nbreak', 'nul\0byte'])
    assert.throws(() => writeMemorySyncHelper(project, bad, '/opt/app/cli.js', root, id, linux), /不安全/);
  assert.throws(() => writeMemorySyncHelper(project, '/node', '/cli.js', root, 'not-a-uuid', linux), /不安全/);
  assert.equal(readFileSync(file, 'utf8'), text);
});

test('an older extension list is read until the first save and never written or cleaned up', async (t) => {
  const root = scratch(t);
  const legacy = join(root, 'ComboRunner', 'extensions');
  const skill = join(legacy, 'skills', 'translator');
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: translator\n---\n');
  const before = JSON.stringify({
    version: 1,
    items: [
      {
        kind: 'skill',
        id: 'skill-translator',
        name: 'translator',
        description: 'Translate',
        path: skill,
        source: skill,
        managed: true,
        enabled: true,
        installedAt: '2026-10-01T00:00:00.000Z',
      },
    ],
  });
  writeFileSync(join(legacy, 'extensions.json'), before);
  const current = join(root, 'pugport', 'extensions');
  const hub = new ExtensionHub(current, [legacy]);
  assert.deepEqual(
    hub.list().map((item) => item.id),
    ['skill-translator'],
  );
  await hub.setEnabled('skill-translator', false);
  assert.equal(readFileSync(join(legacy, 'extensions.json'), 'utf8'), before);
  assert.equal(JSON.parse(readFileSync(join(current, 'extensions.json'), 'utf8')).items[0].enabled, false);
  await hub.remove('skill-translator');
  assert.ok(existsSync(join(skill, 'SKILL.md')), 'a folder outside the current extensions folder is never deleted');
  assert.deepEqual(new ExtensionHub(current, [legacy]).list(), [], 'the current list wins once it exists');
});

test('zip archives unpack in Node, refusing escaping paths and skipping links', async (t) => {
  const root = scratch(t);
  const archive = new AdmZip();
  archive.addFile('skills/translator/SKILL.md', Buffer.from('---\nname: translator\n---\nTranslate.'));
  archive.addFile('skills/translator/notes/a.txt', Buffer.from('notes'));
  archive.addFile('skills/link', Buffer.from('/etc/passwd'));
  archive.getEntry('skills/link')!.attr = (0o120777 << 16) >>> 0;
  archive.addFile('skills/relative-link', Buffer.from('../../outside'));
  archive.getEntry('skills/relative-link')!.attr = (0o120777 << 16) >>> 0;
  archive.addFile('skills/pipe', Buffer.from('not a regular file'));
  archive.getEntry('skills/pipe')!.attr = (0o010644 << 16) >>> 0;
  const good = join(root, 'good.zip');
  archive.writeZip(good);
  const into = join(root, 'out');
  mkdirSync(into);
  await extractZip(good, into);
  assert.equal(readFileSync(join(into, 'skills', 'translator', 'notes', 'a.txt'), 'utf8'), 'notes');
  assert.match(readFileSync(join(into, 'skills', 'translator', 'SKILL.md'), 'utf8'), /translator/);
  assert.equal(existsSync(join(into, 'skills', 'link')), false);
  assert.deepEqual(readdirSync(join(into, 'skills')), ['translator'], 'no file or dangling link is created');
  assert.deepEqual(readdirSync(root).sort(), ['good.zip', 'out'], 'nothing is written outside the extraction root');

  for (const name of ['../escape.txt', '/absolute.txt', 'C:/drive.txt', 'a/../../escape.txt']) {
    const evil = new AdmZip();
    evil.addFile('placeholder.txt', Buffer.from('x'));
    evil.getEntry('placeholder.txt')!.entryName = name;
    const file = join(root, 'evil.zip');
    evil.writeZip(file);
    const target = join(root, `evil-${readdirSync(root).length}`);
    mkdirSync(target);
    await assert.rejects(extractZip(file, target), /不安全的路径/, name);
    assert.deepEqual(existsSync(target) ? readdirSync(target) : [], []);
  }
  assert.equal(existsSync(join(root, 'escape.txt')), false);
});
