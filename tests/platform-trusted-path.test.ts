import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { trustedDirectory } from '../src/server/platform/trusted-path.ts';
import { fakeFs, fakeHost } from './helpers/fake-host.ts';

/**
 * A POSIX file system with the given folders and links. `realpathSync` resolves every component, like the real
 * one, and records each call so a test can see that nothing below the given directory was resolved.
 */
function posixTree(folders: string[], links: Record<string, string>) {
  const calls: string[] = [];
  const realpathSync = (path: string) => {
    calls.push(path);
    let resolved = '/';
    for (const part of path.split('/').filter(Boolean)) {
      let next = resolved === '/' ? `/${part}` : `${resolved}/${part}`;
      for (let hops = 0; links[next] !== undefined; hops++) {
        if (hops > 8) throw Object.assign(new Error('ELOOP'), { code: 'ELOOP' });
        next = links[next]!;
      }
      if (!folders.includes(next)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      resolved = next;
    }
    return resolved;
  };
  return { calls, fs: fakeFs({ realpathSync }) };
}

const macTemp = [
  '/private',
  '/private/var',
  '/private/var/folders',
  '/private/var/folders/fx',
  '/private/var/folders/fx/T',
];

test('macOS resolves /var above a temporary directory and keeps the directory itself literal', () => {
  const tree = posixTree([...macTemp, '/private/var/folders/fx/T/data'], { '/var': '/private/var' });
  const host = fakeHost('darwin', { fs: tree.fs });
  assert.equal(trustedDirectory('/var/folders/fx/T/data', host), '/private/var/folders/fx/T/data');
  assert.deepEqual(tree.calls, ['/var/folders/fx/T'], 'only the parent is resolved');
});

test('macOS never follows a link at the directory itself', () => {
  // The given directory is a link to somewhere else: its name is kept, so the caller's lstat/realpath check sees it.
  const tree = posixTree([...macTemp, '/private/var/folders/fx/T/elsewhere'], {
    '/var': '/private/var',
    '/private/var/folders/fx/T/data': '/private/var/folders/fx/T/elsewhere',
  });
  const host = fakeHost('darwin', { fs: tree.fs });
  assert.equal(trustedDirectory('/var/folders/fx/T/data', host), '/private/var/folders/fx/T/data');
});

test('missing folders above the directory are appended as written', () => {
  const tree = posixTree(macTemp, { '/var': '/private/var', '/tmp': '/private/tmp' });
  const host = fakeHost('darwin', { fs: tree.fs });
  assert.equal(
    trustedDirectory('/var/folders/fx/T/new/deeper/data', host),
    '/private/var/folders/fx/T/new/deeper/data',
  );
  assert.equal(trustedDirectory('/nowhere/data', host), '/nowhere/data');
});

test('a relative directory and redundant separators resolve before the parent is read', () => {
  const tree = posixTree([...macTemp], { '/var': '/private/var' });
  const host = fakeHost('darwin', { fs: tree.fs });
  assert.equal(trustedDirectory('/var/folders//fx/./T/../T/data/', host), '/private/var/folders/fx/T/data');
  assert.equal(trustedDirectory('/', host), '/');
});

test('Linux resolves a linked /home above a data folder', () => {
  const tree = posixTree(['/var', '/var/home', '/var/home/fixture', '/var/home/fixture/.local'], {
    '/home': '/var/home',
  });
  const host = fakeHost('linux', { fs: tree.fs });
  assert.equal(trustedDirectory('/home/fixture/.local/share', host), '/var/home/fixture/.local/share');
  assert.equal(trustedDirectory('/tmp/data', fakeHost('linux', { fs: posixTree(['/tmp'], {}).fs })), '/tmp/data');
});

test('Windows returns the directory unchanged without reading the file system', () => {
  const host = fakeHost('win32'); // emptyFs: any file-system call would throw
  for (const directory of [
    'C:\\Users\\fixture\\AppData\\Local\\Temp\\data',
    'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\data',
    'relative\\data',
    '\\\\server\\share\\data',
  ])
    assert.equal(trustedDirectory(directory, host), directory);
});

test('file-system errors other than a missing folder are not hidden', () => {
  const denied = fakeFs({
    realpathSync: () => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    },
  });
  assert.throws(() => trustedDirectory('/locked/data', fakeHost('darwin', { fs: denied })), /EACCES/);
});

test('on this computer, a link inside the given directory survives and the temporary folder is resolved', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'pugport-trusted-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const real = realpathSync(base);
  mkdirSync(join(base, 'target'));
  symlinkSync(join(base, 'target'), join(base, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const expected = process.platform === 'win32' ? join(base, 'linked') : join(real, 'linked');
  assert.equal(trustedDirectory(join(base, 'linked')), expected);
  assert.notEqual(realpathSync(trustedDirectory(join(base, 'linked'))), trustedDirectory(join(base, 'linked')));
});
