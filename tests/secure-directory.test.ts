import assert from 'node:assert/strict';
import { test } from 'node:test';
import { restrictDirectory } from '../src/server/platform/secure-file.ts';
import { fakeFs, fakeHost } from './helpers/fake-host.ts';

const folder = 'C:\\fixture\\private';
const grants = [folder, '/inheritance:r', '/grant:r', '*S-1-5-21-123:(OI)(CI)(F)', '*S-1-5-18:(OI)(CI)(F)'];
// Reading the current list (`/save`) is not a write: the cases below are about the write.
const reads = (args: readonly string[]) => args.includes('/save');

for (const command of ['whoami.exe', 'icacls.exe']) {
  test(`directory ACL retries a timed-out ${command} and still applies both private grants`, async () => {
    const calls: { file: string; args: readonly string[]; timeout?: number }[] = [];
    let attempts = 0;
    const host = fakeHost('win32', {
      run(file, args, options) {
        if (reads(args)) return { stdout: '', stderr: '' };
        calls.push({ file, args, timeout: options?.timeout });
        if (file.endsWith(command) && ++attempts === 1)
          throw Object.assign(new Error('synthetic timeout'), { killed: true, signal: 'SIGTERM' });
        return { stdout: file.endsWith('whoami.exe') ? 'S-1-5-21-123' : '', stderr: '' };
      },
    });
    await restrictDirectory(folder, { timeoutMs: 7 }, host);
    assert.deepEqual(
      calls.filter((call) => call.file.endsWith(command)).map((call) => call.timeout),
      [7, 14],
    );
    assert.deepEqual(calls.at(-1)?.args, grants);
  });
}

test('directory ACL resource-busy retries are bounded and never report success on exhaustion', async () => {
  const timeouts: (number | undefined)[] = [];
  const failure = Object.assign(new Error('synthetic busy'), { code: 'EBUSY' });
  const host = fakeHost('win32', {
    run(file, args, options) {
      if (file.endsWith('whoami.exe')) return { stdout: 'S-1-5-21-123', stderr: '' };
      if (reads(args)) return { stdout: '', stderr: '' };
      timeouts.push(options?.timeout);
      throw failure;
    },
  });
  await assert.rejects(restrictDirectory(folder, {}, host), (error) => error === failure);
  assert.deepEqual(timeouts, [5000, 10000, 15000]);
  // A failed attempt is not remembered: the next launch tries again.
  await assert.rejects(restrictDirectory(folder, {}, host), (error) => error === failure);
  assert.equal(timeouts.length, 6);
});

test('directory ACL permanent failures and missing identity fail closed without retries', async () => {
  for (const code of ['EACCES', 'ENOENT', 1]) {
    let attempts = 0;
    const failure = Object.assign(new Error('synthetic denial'), { code });
    const host = fakeHost('win32', {
      run(file, args) {
        if (file.endsWith('whoami.exe')) return { stdout: 'S-1-5-21-123', stderr: '' };
        if (reads(args)) return { stdout: '', stderr: '' };
        attempts++;
        throw failure;
      },
    });
    await assert.rejects(restrictDirectory(folder, {}, host), (error) => error === failure);
    assert.equal(attempts, 1);
  }
  let calls = 0;
  const host = fakeHost('win32', {
    run() {
      calls++;
      return { stdout: '', stderr: '' };
    },
  });
  await assert.rejects(restrictDirectory(folder, {}, host), /missing user identity/);
  assert.equal(calls, 1);
});

/** A Windows host whose folder has the given saved list; `writes` counts the times the list was written. */
function hostWithList(sddl: string | Error) {
  const seen = { commands: 0, writes: 0, removed: [] as string[], saved: '' };
  const host = fakeHost('win32', {
    fs: fakeFs({
      promises: {
        readFile: async (file: string) => {
          assert.equal(file, seen.saved);
          if (sddl instanceof Error) throw sddl;
          return Buffer.from(`private\r\n${sddl}\r\n`, 'utf16le');
        },
        rm: async (file: string) => void seen.removed.push(file),
      },
    }),
    run(file, args) {
      seen.commands++;
      if (file.endsWith('whoami.exe')) return { stdout: '"fixture\\owner","S-1-5-21-123"', stderr: '' };
      if (reads(args)) seen.saved = String(args.at(-1));
      else {
        assert.deepEqual(args, grants);
        seen.writes++;
      }
      return { stdout: '', stderr: '' };
    },
  });
  return { host, seen };
}

test('a folder that is already private is read, not rewritten, and looked at once per run', async () => {
  for (const sddl of [
    'D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;S-1-5-21-123)',
    'D:P(A;OICI;FA;;;S-1-5-21-123)(A;OICI;FA;;;S-1-5-18)',
  ]) {
    const { host, seen } = hostWithList(sddl);
    await restrictDirectory(folder, {}, host);
    assert.equal(seen.writes, 0, sddl);
    assert.equal(seen.commands, 2, sddl);
    assert.match(seen.saved, /^C:\\Users\\fixture\\AppData\\Local\\Temp\\pugport-acl-[0-9a-f-]{36}\.txt$/);
    assert.deepEqual(seen.removed, [seen.saved]);
    // The same folder again, in any letter case, costs nothing; another folder is still checked.
    await restrictDirectory(folder.toUpperCase(), {}, host);
    assert.equal(seen.commands, 2, sddl);
    await restrictDirectory('C:\\fixture\\other', {}, host).catch(() => undefined);
    assert.equal(seen.commands > 2, true, sddl);
  }
});

test('any other list, or one that cannot be read, is rewritten', async () => {
  for (const sddl of [
    // Inherits from its parent.
    'D:AI(A;OICI;FA;;;SY)(A;OICI;FA;;;S-1-5-21-123)',
    // Someone else can read it.
    'D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;S-1-5-21-123)(A;OICI;0x1200a9;;;BU)',
    // Another user in place of this one.
    'D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;S-1-5-21-999)',
    // Not passed on to its contents.
    'D:PAI(A;;FA;;;SY)(A;;FA;;;S-1-5-21-123)',
    // SYSTEM is missing.
    'D:PAI(A;OICI;FA;;;S-1-5-21-123)',
    // An inherited copy of the right entries.
    'D:PAI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;S-1-5-21-123)',
    'D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;S-1-5-21-123)S:AI(ML;;NW;;;LW)',
    '',
    Object.assign(new Error('synthetic missing file'), { code: 'ENOENT' }),
  ]) {
    const { host, seen } = hostWithList(sddl);
    await restrictDirectory(folder, {}, host);
    assert.equal(seen.writes, 1, String(sddl));
    // Written once, then remembered.
    await restrictDirectory(folder, {}, host);
    assert.equal(seen.writes, 1, String(sddl));
  }
});
