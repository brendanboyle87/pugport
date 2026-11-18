import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { allowTestTool } from '../src/server/platform/under-test.ts';
import { currentHost, type Host } from '../src/server/platform/host.ts';
import {
  downloadMacUpdate,
  fetchMacManifest,
  macInstallArgs,
  macInstallTarget,
  macUpdateFeed,
  MacUpdateFailure,
  unpackMacUpdate,
  verifyMacManifest,
  type MacInstallJob,
} from '../src/server/platform/mac-update.ts';
import { MAC_UPDATE_ROOT, isNewerVersion, type MacUpdateManifest } from '../src/shared/app-update.ts';
import { MacUpdater } from '../src/electron/mac-updater.ts';
import { AppUpdateCheck } from '../src/server/app-update-check.ts';

const mac = process.platform === 'darwin';
const posix = process.platform !== 'win32';
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const otherKey = generateKeyPairSync('ed25519').privateKey;
const feed = { root: MAC_UPDATE_ROOT, arch: 'arm64' as const };
const base = `${MAC_UPDATE_ROOT}/mac/arm64/`;
const darwinHost: Host = { ...currentHost(), platform: 'darwin' };

function manifest(fields: Partial<MacUpdateManifest> & Record<string, unknown> = {}) {
  return {
    version: '0.0.35',
    url: `${base}PugPort-0.0.35-mac-arm64.zip`,
    sha256: 'a'.repeat(64),
    size: 1234,
    releasedAt: '2026-11-14T00:00:00Z',
    ...fields,
  };
}
function signed(value: unknown, key = keys.privateKey) {
  const body = Buffer.from(JSON.stringify(value));
  return { body, signature: sign(null, body, key).toString('base64') + '\n' };
}
function refused(reason: string, run: () => unknown) {
  assert.throws(run, (error) => error instanceof MacUpdateFailure && error.reason === reason);
}
async function rejects(reason: string, run: () => Promise<unknown>) {
  await assert.rejects(run, (error) => error instanceof MacUpdateFailure && error.reason === reason);
}
const verifyAs = (body: Buffer, signature: string, currentVersion = '0.0.34') =>
  verifyMacManifest(body, signature, { feed, currentVersion, publicKey });
function scratch() {
  return fs.mkdtempSync(path.join(tmpdir(), 'pugport-mac-update-'));
}
/** A fetch serving the given files below the feed. */
function serve(files: Record<string, Buffer | string>, seen: string[] = []): typeof fetch {
  return async (input) => {
    const url = String(input);
    seen.push(url);
    const file = files[url] ?? (url.startsWith(base) ? files[url.slice(base.length)] : undefined);
    return file === undefined
      ? new Response('missing', { status: 404 })
      : new Response(typeof file === 'string' ? file : new Uint8Array(file));
  };
}

test('versions compare as plain x.y.z only', () => {
  assert.equal(isNewerVersion('0.0.35', '0.0.34'), true);
  assert.equal(isNewerVersion('0.1.0', '0.0.99'), true);
  assert.equal(isNewerVersion('0.0.34', '0.0.34'), false);
  assert.equal(isNewerVersion('0.0.33', '0.0.34'), false);
  assert.equal(isNewerVersion('0.0.35-beta', '0.0.34'), false);
  assert.equal(isNewerVersion('v0.0.35', '0.0.34'), false);
});

test('a correctly signed manifest for a newer version on the feed is accepted', () => {
  const { body, signature } = signed(manifest({ extra: 'ignored' }));
  assert.deepEqual(verifyAs(body, signature), manifest());
});

test('a signature from another key, a changed byte or a malformed signature is refused', () => {
  const good = signed(manifest());
  refused('manifest', () => verifyAs(good.body, signed(manifest(), otherKey).signature));
  const tampered = Buffer.from(good.body.toString().replace('1234', '1235'));
  refused('manifest', () => verifyAs(tampered, good.signature));
  refused('manifest', () => verifyAs(good.body, ''));
  refused('manifest', () => verifyAs(good.body, 'not base64!'));
  refused('manifest', () => verifyAs(good.body, good.signature.slice(4)));
});

test('the same or an older version is not offered', () => {
  for (const version of ['0.0.34', '0.0.33', '0.0.35.1', 'latest']) {
    const { body, signature } = signed(manifest({ version }));
    refused('not-newer', () => verifyAs(body, signature));
  }
});

test('an archive outside this feed and architecture is refused even when signed', () => {
  for (const url of [
    'https://evil.example/mac/arm64/PugPort-0.0.35-mac-arm64.zip',
    'https://download.pugport.com.evil.example/mac/arm64/PugPort.zip',
    'http://download.pugport.com/mac/arm64/PugPort-0.0.35-mac-arm64.zip',
    `${MAC_UPDATE_ROOT}/mac/x64/PugPort-0.0.35-mac-x64.zip`,
    `${MAC_UPDATE_ROOT}/mac/arm64/../x64/PugPort.zip`,
    `${MAC_UPDATE_ROOT}/mac/arm64/%2e%2e/x64/PugPort.zip`,
    `${MAC_UPDATE_ROOT}/mac/arm64/sub/PugPort.zip`,
    `${MAC_UPDATE_ROOT}/mac/arm64/PugPort.zip?x=1`,
    `${MAC_UPDATE_ROOT}/mac/arm64/PugPort.dmg`,
    `https://user@download.pugport.com/mac/arm64/PugPort.zip`,
  ]) {
    const { body, signature } = signed(manifest({ url }));
    refused('manifest', () => verifyAs(body, signature));
  }
});

test('missing or malformed fields are refused', () => {
  for (const fields of [
    { sha256: 'A'.repeat(64) },
    { sha256: 'a'.repeat(63) },
    { size: 0 },
    { size: 1.5 },
    { size: 2 * 1024 * 1024 * 1024 },
    { size: '1234' },
    { releasedAt: 'soon' },
    { url: undefined },
  ]) {
    const { body, signature } = signed(manifest(fields as Partial<MacUpdateManifest>));
    refused('manifest', () => verifyAs(body, signature));
  }
  const array = signed([manifest()]);
  refused('manifest', () => verifyAs(array.body, array.signature));
});

test('the feed exists only on a Mac, and only a source checkout may point it at a loopback server', () => {
  const env = { PUGPORT_UPDATE_ROOT: 'http://127.0.0.1:8123' };
  assert.equal(macUpdateFeed({ packaged: true, arch: 'arm64' }, { ...darwinHost, platform: 'win32' }), undefined);
  assert.equal(macUpdateFeed({ packaged: true, arch: 'ia32' }, darwinHost), undefined);
  assert.deepEqual(macUpdateFeed({ packaged: true, env, arch: 'x64' }, darwinHost), {
    root: MAC_UPDATE_ROOT,
    arch: 'x64',
  });
  assert.deepEqual(macUpdateFeed({ packaged: false, env, arch: 'arm64' }, darwinHost), {
    root: 'http://127.0.0.1:8123',
    arch: 'arm64',
  });
  for (const root of ['https://evil.example', 'http://localhost:8123', 'http://127.0.0.1:8123/x', 'http://10.0.0.1:80'])
    assert.equal(
      macUpdateFeed({ packaged: false, env: { PUGPORT_UPDATE_ROOT: root }, arch: 'arm64' }, darwinHost)?.root,
      MAC_UPDATE_ROOT,
    );
});

test('the manifest and its signature are read from the architecture folder', async () => {
  const { body, signature } = signed(manifest());
  const seen: string[] = [];
  const result = await fetchMacManifest(feed, {
    currentVersion: '0.0.34',
    publicKey,
    fetch: serve({ 'latest.json': body, 'latest.json.sig': signature }, seen),
  });
  assert.equal(result.version, '0.0.35');
  assert.deepEqual(seen.sort(), [`${base}latest.json`, `${base}latest.json.sig`]);
  await rejects('manifest', () =>
    fetchMacManifest(feed, { currentVersion: '0.0.34', publicKey, fetch: serve({ 'latest.json': body }) }),
  );
  await rejects('manifest', () =>
    fetchMacManifest(feed, {
      currentVersion: '0.0.34',
      publicKey,
      fetch: serve({ 'latest.json': Buffer.alloc(70 * 1024, 32), 'latest.json.sig': signature }),
    }),
  );
  await rejects('network', () =>
    fetchMacManifest(feed, {
      currentVersion: '0.0.34',
      publicKey,
      fetch: async () => {
        throw new TypeError('offline');
      },
    }),
  );
});

test('a download must match the declared size and SHA-256', async () => {
  const dir = scratch();
  try {
    const data = Buffer.from('pretend zip archive');
    const sha256 = createHash('sha256').update(data).digest('hex');
    const ok = manifest({ size: data.length, sha256 });
    const progress: number[] = [];
    await downloadMacUpdate(ok, path.join(dir, 'ok.zip'), {
      fetch: serve({ [ok.url]: data }),
      onProgress: (received) => progress.push(received),
    });
    assert.deepEqual(fs.readFileSync(path.join(dir, 'ok.zip')), data);
    assert.equal(progress.at(-1), data.length);
    await rejects('checksum', () =>
      downloadMacUpdate({ ...ok, sha256: 'b'.repeat(64) }, path.join(dir, 'bad-sha.zip'), {
        fetch: serve({ [ok.url]: data }),
      }),
    );
    await rejects('download', () =>
      downloadMacUpdate({ ...ok, size: data.length - 1 }, path.join(dir, 'too-big.zip'), {
        fetch: serve({ [ok.url]: data }),
      }),
    );
    await rejects('download', () =>
      downloadMacUpdate({ ...ok, size: data.length + 1 }, path.join(dir, 'short.zip'), {
        fetch: async () => new Response(new Blob([data]).stream()),
      }),
    );
    await rejects('download', () => downloadMacUpdate(ok, path.join(dir, 'missing.zip'), { fetch: serve({}) }));
    // An existing file is never overwritten.
    await assert.rejects(() => downloadMacUpdate(ok, path.join(dir, 'ok.zip'), { fetch: serve({ [ok.url]: data }) }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A host whose ditto lays out `name` with the given Info.plist version; codesign passes unless told otherwise. */
function packageHost(name: string, version: string, codesign = true) {
  const calls: string[][] = [];
  const host: Host = {
    ...darwinHost,
    run: async (file, args) => {
      calls.push([file, ...args]);
      if (file === '/usr/bin/ditto') fs.mkdirSync(path.join(args.at(-1)!, name, 'Contents'), { recursive: true });
      if (file === '/usr/bin/plutil') return { stdout: `${version}\n`, stderr: '' };
      if (file === '/usr/bin/codesign' && !codesign) throw new Error('invalid signature');
      return { stdout: '', stderr: '' };
    },
  };
  return { host, calls };
}

test('the archive must hold exactly PugPort.app with the manifest version and a valid signature', async () => {
  const dir = scratch();
  try {
    const cases: Array<[string, string, boolean, string | undefined]> = [
      ['PugPort.app', '0.0.35', true, undefined],
      ['Other.app', '0.0.35', true, 'package'],
      ['PugPort.app', '0.0.34', true, 'package'],
      ['PugPort.app', '0.0.35', false, 'package'],
    ];
    for (const [index, [name, version, codesign, reason]] of cases.entries()) {
      const target = path.join(dir, String(index));
      fs.mkdirSync(target);
      const { host, calls } = packageHost(name, version, codesign);
      const run = () => unpackMacUpdate(path.join(dir, 'u.zip'), target, '0.0.35', host);
      if (reason) await rejects(reason, run);
      else {
        assert.equal(await run(), path.join(target, 'PugPort.app'));
        assert.deepEqual(calls[0], ['/usr/bin/ditto', '-x', '-k', path.join(dir, 'u.zip'), target]);
        assert.deepEqual(calls.at(-1), [
          '/usr/bin/codesign',
          '--verify',
          '--deep',
          '--strict',
          path.join(target, 'PugPort.app'),
        ]);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A minimal ad-hoc signed bundle, zipped the way the release script does. */
function bundle(dir: string, name: string, version: string) {
  const app = path.join(dir, name);
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.copyFileSync('/usr/bin/true', path.join(app, 'Contents', 'MacOS', 'PugPort'));
  fs.writeFileSync(
    path.join(app, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>PugPort</string>
<key>CFBundleIdentifier</key><string>com.pugport.test</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>`,
  );
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', app], { stdio: 'ignore' });
  return app;
}

test('real ditto, plutil and codesign accept a signed bundle and refuse a modified one', { skip: !mac }, async () => {
  for (const tool of ['/usr/bin/ditto', '/usr/bin/plutil', '/usr/bin/codesign']) allowTestTool(tool);
  const dir = scratch();
  try {
    const app = bundle(path.join(dir), 'PugPort.app', '0.0.35');
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, path.join(dir, 'good.zip')]);
    fs.mkdirSync(path.join(dir, 'good'));
    assert.equal(
      await unpackMacUpdate(path.join(dir, 'good.zip'), path.join(dir, 'good'), '0.0.35'),
      path.join(dir, 'good', 'PugPort.app'),
    );
    fs.mkdirSync(path.join(dir, 'version'));
    await rejects('package', () => unpackMacUpdate(path.join(dir, 'good.zip'), path.join(dir, 'version'), '0.0.36'));
    fs.appendFileSync(path.join(app, 'Contents', 'MacOS', 'PugPort'), 'tampered');
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, path.join(dir, 'bad.zip')]);
    fs.mkdirSync(path.join(dir, 'bad'));
    await rejects('package', () => unpackMacUpdate(path.join(dir, 'bad.zip'), path.join(dir, 'bad'), '0.0.35'));
    const renamed = bundle(path.join(dir, 'renamed'), 'PugPort Beta.app', '0.0.35');
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', renamed, path.join(dir, 'renamed.zip')]);
    fs.mkdirSync(path.join(dir, 'renamed-out'));
    await rejects('package', () =>
      unpackMacUpdate(path.join(dir, 'renamed.zip'), path.join(dir, 'renamed-out'), '0.0.35'),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('one-click install needs the packaged app in a writable folder', { skip: !posix }, () => {
  const dir = scratch();
  try {
    const app = path.join(dir, 'Applications', 'PugPort.app');
    const exec = path.join(app, 'Contents', 'MacOS', 'PugPort');
    fs.mkdirSync(path.dirname(exec), { recursive: true });
    assert.equal(macInstallTarget({ packaged: true, execPath: exec }, darwinHost), app);
    assert.equal(macInstallTarget({ packaged: false, execPath: exec }, darwinHost), undefined);
    assert.equal(macInstallTarget({ packaged: true, execPath: exec }, { ...darwinHost, platform: 'win32' }), undefined);
    assert.equal(
      macInstallTarget(
        { packaged: true, execPath: path.join(dir, 'node_modules', 'electron', 'dist', 'Electron') },
        darwinHost,
      ),
      undefined,
    );
    if (process.getuid?.() !== 0) {
      fs.chmodSync(path.dirname(app), 0o555);
      assert.equal(macInstallTarget({ packaged: true, execPath: exec }, darwinHost), undefined);
      fs.chmodSync(path.dirname(app), 0o755);
      fs.chmodSync(app, 0o555);
      assert.equal(macInstallTarget({ packaged: true, execPath: exec }, darwinHost), undefined);
      fs.chmodSync(app, 0o755);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installer arguments are passed as an array and forward only the data-location variables', () => {
  const args = macInstallArgs({
    pid: 42,
    target: '/Applications/PugPort.app',
    staged: '/data/updates/staging/app/PugPort.app',
    work: '/data/updates/staging',
    log: '/data/updates/install.log',
    env: { COMBORUNNER_DATA_DIR: '/x y/$(evil)', PATH: '/bin', SECRET: 'no' },
  });
  assert.equal(args[0], '-c');
  assert.deepEqual(args.slice(2), [
    'pugport-update',
    '42',
    '/Applications/PugPort.app',
    '/data/updates/staging/app/PugPort.app',
    '/data/updates/staging',
    '/data/updates/install.log',
    '/usr/bin/open',
    '--env',
    'COMBORUNNER_DATA_DIR=/x y/$(evil)',
  ]);
});

/** Runs the real installer script with `echo` in place of `open`, so the log names the bundle it would open. */
async function runInstaller(job: Omit<MacInstallJob, 'pid'>, pid: number) {
  allowTestTool('/bin/sh');
  const child = spawn('/bin/sh', macInstallArgs({ ...job, pid, opener: '/bin/echo' }), { stdio: 'ignore' });
  const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
  return { code, log: fs.readFileSync(job.log, 'utf8') };
}
function fakeApp(at: string, marker: string) {
  fs.mkdirSync(path.join(at, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(at, 'Contents', 'marker'), marker);
}
const marker = (app: string) => fs.readFileSync(path.join(app, 'Contents', 'marker'), 'utf8');

test('the installer waits for the app, swaps the bundle, cleans up and opens the new one', { skip: !mac }, async () => {
  const dir = scratch();
  try {
    const target = path.join(dir, 'Applications', 'PugPort.app');
    const work = path.join(dir, 'data', 'updates', 'staging');
    const staged = path.join(work, 'app', 'PugPort.app');
    fakeApp(target, 'old');
    fakeApp(staged, 'new');
    const app = spawn('/bin/sleep', ['0.6'], { stdio: 'ignore' });
    const exited = new Promise((resolve) => app.on('exit', resolve));
    const started = Date.now();
    const log = path.join(dir, 'data', 'updates', 'install.log');
    const result = await runInstaller({ target, staged, work, log }, app.pid!);
    await exited;
    assert.equal(result.code, 0, result.log);
    assert.ok(Date.now() - started >= 500, 'waited for the app to exit');
    assert.equal(marker(target), 'new');
    assert.equal(fs.existsSync(work), false);
    assert.deepEqual(
      fs.readdirSync(path.dirname(target)).filter((name) => name !== 'PugPort.app'),
      [],
    );
    assert.match(result.log, /update: installed\n.*PugPort\.app\n$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'the installer keeps or restores the current app when a step fails',
  { skip: !mac || process.getuid?.() === 0 },
  async () => {
    const dir = scratch();
    try {
      const apps = path.join(dir, 'Applications');
      const target = path.join(apps, 'PugPort.app');
      const work = path.join(dir, 'updates', 'staging');
      const log = path.join(dir, 'install.log');
      fs.mkdirSync(path.dirname(log), { recursive: true });
      fakeApp(target, 'old');
      // The staged copy is gone: nothing changes and the current app reopens.
      let result = await runInstaller({ target, staged: path.join(work, 'missing.app'), work, log }, 999_999);
      assert.equal(result.code, 1);
      assert.equal(marker(target), 'old');
      assert.match(result.log, /copy failed; keeping the current app\n.*PugPort\.app\n$/);
      assert.deepEqual(fs.readdirSync(apps), ['PugPort.app']);
      // The folder turns read-only after the check: the old bundle cannot move, so it stays and reopens.
      const staged = path.join(work, 'app', 'PugPort.app');
      fakeApp(staged, 'new');
      fs.chmodSync(target, 0o555);
      fs.chmodSync(apps, 0o555);
      result = await runInstaller({ target, staged, work, log }, 999_999);
      fs.chmodSync(apps, 0o755);
      fs.chmodSync(target, 0o755);
      assert.equal(result.code, 1);
      assert.equal(marker(target), 'old');
      assert.deepEqual(fs.readdirSync(apps), ['PugPort.app']);
    } finally {
      fs.chmodSync(path.join(dir, 'Applications'), 0o755);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

function updater(options: { installable?: boolean; quit?: boolean; data?: Buffer; sha256?: string; version?: string }) {
  const dir = scratch();
  const data = options.data ?? Buffer.from('zip bytes');
  const value = manifest({
    size: data.length,
    sha256: options.sha256 ?? createHash('sha256').update(data).digest('hex'),
  });
  const { body, signature } = signed(value);
  const statuses: string[] = [];
  const launched: MacInstallJob[] = [];
  const seen: string[] = [];
  let quits = 0;
  const { host } = packageHost('PugPort.app', options.version ?? '0.0.35');
  const target = path.join(dir, 'Applications', 'PugPort.app');
  const instance = new MacUpdater({
    feed,
    currentVersion: '0.0.34',
    updatesDir: path.join(dir, 'updates'),
    target: () => (options.installable === false ? undefined : target),
    quit: async () => {
      quits++;
      return options.quit !== false;
    },
    launch: (job) => launched.push(job),
    changed: (status) => statuses.push(status.phase + (status.error ? `:${status.error}` : '')),
    fetch: serve({ 'latest.json': body, 'latest.json.sig': signature, [value.url]: data }, seen),
    host,
    publicKey,
    pid: 4321,
    env: {},
  });
  return { dir, instance, statuses, launched, seen, target, quits: () => quits };
}

test('the updater downloads, verifies and installs only after the normal quit goes ahead', async () => {
  const f = updater({});
  try {
    assert.equal(await f.instance.install(), false, 'nothing to install yet');
    await f.instance.download();
    assert.equal(f.instance.state.phase, 'ready');
    assert.equal(f.instance.state.version, '0.0.35');
    assert.deepEqual([...new Set(f.statuses)], ['downloading', 'verifying', 'ready']);
    assert.equal(await f.instance.install(), true);
    assert.equal(f.quits(), 1);
    assert.equal(f.launched.length, 1);
    assert.deepEqual(f.launched[0], {
      pid: 4321,
      target: f.target,
      staged: path.join(f.dir, 'updates', 'staging', 'app', 'PugPort.app'),
      work: path.join(f.dir, 'updates', 'staging'),
      log: path.join(f.dir, 'updates', 'install.log'),
      env: {},
    });
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a cancelled quit keeps the update ready and starts no installer', async () => {
  const f = updater({ quit: false });
  try {
    await f.instance.download();
    assert.equal(await f.instance.install(), false);
    assert.equal(f.instance.state.phase, 'ready');
    assert.equal(f.launched.length, 0);
    // The next start discards the unused download.
    const staging = path.join(f.dir, 'updates', 'staging');
    assert.equal(fs.existsSync(staging), true);
    new MacUpdater({
      feed,
      currentVersion: '0.0.34',
      updatesDir: path.join(f.dir, 'updates'),
      target: () => undefined,
      quit: async () => false,
      launch: () => {},
      changed: () => {},
    });
    assert.equal(fs.existsSync(staging), false);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('the updater refuses without a writable packaged app, a wrong checksum or a wrong bundle version', async () => {
  const unwritable = updater({ installable: false });
  const checksum = updater({ sha256: 'c'.repeat(64) });
  const version = updater({ version: '0.0.36' });
  try {
    await unwritable.instance.download();
    assert.deepEqual(unwritable.instance.state, { installable: false, phase: 'error', error: 'install' });
    assert.deepEqual(unwritable.seen, [], 'nothing is fetched');
    await checksum.instance.download();
    assert.equal(checksum.instance.state.error, 'checksum');
    assert.equal(fs.existsSync(path.join(checksum.dir, 'updates', 'staging')), false);
    await version.instance.download();
    assert.equal(version.instance.state.error, 'package');
    for (const f of [unwritable, checksum, version]) {
      assert.equal(await f.instance.install(), false);
      assert.equal(f.launched.length, 0);
    }
  } finally {
    for (const f of [unwritable, checksum, version]) fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('the Mac update check offers only a verified newer manifest', async () => {
  const run = async (fetcher: typeof fetch, version = '0.0.34') => {
    const db = new DatabaseSync(':memory:');
    let changes = 0;
    const check = new AppUpdateCheck(
      { db, enabled: () => true, changed: () => changes++ },
      { now: () => 1, version, fetch: fetcher, mac: feed, publicKey },
    );
    await check.tick();
    db.close();
    return { update: check.update, changes };
  };
  const good = signed(manifest());
  assert.deepEqual(await run(serve({ 'latest.json': good.body, 'latest.json.sig': good.signature })), {
    update: { version: '0.0.35', url: manifest().url, mac: true },
    changes: 1,
  });
  const forged = signed(manifest(), otherKey);
  for (const fetcher of [
    serve({ 'latest.json': good.body, 'latest.json.sig': forged.signature }),
    serve({ 'latest.json': good.body }),
    serve({}),
  ])
    assert.deepEqual(await run(fetcher), { update: undefined, changes: 0 });
  assert.deepEqual(await run(serve({ 'latest.json': good.body, 'latest.json.sig': good.signature }), '0.0.35'), {
    update: undefined,
    changes: 0,
  });
});
