import { productionPaths } from './helpers/production-paths.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { test, type TestContext } from 'node:test';
import { secretsDirectory } from '../src/server/api-providers.ts';
import { defaultTargets, findClaudeExecutable, findCursorExecutable, findExecutable } from '../src/server/discovery.ts';
import { extensionsDir } from '../src/server/extensions.ts';
import { journalDirectory, protectedReason } from '../src/server/file-manager.ts';
import { defaultImageFolders, imageIndexDirectory } from '../src/server/image-search.ts';
import { memoryStorageRoot, writeMemorySyncHelper } from '../src/server/local-memory.ts';
import { ProjectVectors } from '../src/server/memory-vectors.ts';
import { recycleScript } from '../src/server/recycle-bin.ts';
import { runtimeRoot } from '../scripts/runtime-paths.mjs';
import { bridgeWording, organizeToolsFor, recycleToolFor } from '../src/server/agent-bridge.ts';
import { piWritableTools } from '../src/server/adapters/pi.ts';
import { windowsTreeKill } from '../src/server/adapters/process.ts';
import { revealCommand } from '../src/server/app-settings.ts';
import { requireDirectExecutable } from '../src/server/native-accounts.ts';
import { appDirs } from '../src/server/platform/dirs.ts';
import { isDirectExecutable, searchDirs } from '../src/server/platform/executables.ts';
import { capabilities } from '../src/server/platform/host.ts';
import { protectedRoots } from '../src/server/platform/protected-roots.ts';
import { restrictDirectory, restrictFile } from '../src/server/platform/secure-file.ts';
import {
  parseServerLock,
  processStartTime,
  serverLockHeld,
  serverLockText,
} from '../src/server/platform/server-lock.ts';
import { availableMemory, onBattery } from '../src/server/platform/system-stats.ts';
import { trashName } from '../src/server/platform/trash.ts';
import { fakeHost, fakeTree, recordingRun } from './helpers/fake-host.ts';

/*
 * Today's Windows outputs, pinned before the folder, discovery and Recycle Bin code moved into
 * src/server/platform/. These must never change: Windows behaviour stays byte-identical.
 */
const windows = { skip: process.platform !== 'win32' };
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** Sets (or, for undefined, removes) environment variables for one test. Windows reads them case-insensitively. */
function environment(t: TestContext, values: Record<string, string | undefined>) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function scratch(t: TestContext) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-windows-pins-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('Windows folders keep their LOCALAPPDATA locations and each caller its own fallback', windows, async (t) => {
  const root = scratch(t);
  const local = join(root, 'Local');
  const home = join(root, 'Home');
  environment(t, {
    LOCALAPPDATA: local,
    USERPROFILE: home,
    COMBORUNNER_SECRETS_DIR: undefined,
    COMBORUNNER_EXTENSIONS_DIR: undefined,
    COMBORUNNER_FILE_MOVES_DIR: undefined,
    COMBORUNNER_MEMORY_DIR: undefined,
    COMBORUNNER_MEMORY_VECTORS_DIR: undefined,
    COMBORUNNER_IMAGE_INDEX_DIR: undefined,
  });
  assert.equal(
    productionPaths(() => imageIndexDirectory()),
    `${local}\\ComboRunner\\image-index`,
  );
  assert.ok(existsSync(`${local}\\ComboRunner\\image-index`));
  await ProjectVectors.open('pin-project');
  assert.ok(existsSync(`${local}\\ComboRunner\\memory-vectors`));
  const identity = sha(join(root, 'data').toLowerCase());
  assert.equal(
    productionPaths(() => memoryStorageRoot(join(root, 'data'))),
    `${local}\\ComboRunner\\memory\\${identity}`,
  );
  productionPaths(() => {
    assert.equal(secretsDirectory(), `${local}\\ComboRunner\\secrets`);
    assert.equal(extensionsDir(), `${local}\\ComboRunner\\extensions`);
    assert.equal(journalDirectory(), `${local}\\ComboRunner\\file-moves`);
  });
  const app = join(root, 'installed', 'resources', 'app');
  assert.equal(runtimeRoot(app), `${local}\\PugPort\\runtime`);

  // Without LOCALAPPDATA every caller keeps the fallback it has always had.
  delete process.env.LOCALAPPDATA;
  assert.equal(
    productionPaths(() => imageIndexDirectory()),
    `${home}\\ComboRunner\\image-index`,
  );
  assert.equal(
    productionPaths(() => memoryStorageRoot(join(root, 'data'))),
    `${home}\\AppData\\Local\\ComboRunner\\memory\\${identity}`,
  );
  productionPaths(() => {
    assert.equal(secretsDirectory(), `${home}\\ComboRunner\\secrets`);
    assert.equal(extensionsDir(), `${home}\\.local\\share\\ComboRunner\\extensions`);
    assert.equal(journalDirectory(), `${home}\\.local\\share\\ComboRunner\\file-moves`);
  });
  assert.equal(runtimeRoot(app), `${home}\\.local\\share\\PugPort\\runtime`);
  process.env.COMBORUNNER_SECRETS_DIR = join(root, 'override');
  assert.equal(secretsDirectory(), join(root, 'override'));
});

test('Windows executable search keeps its order: PATH, home folders, WindowsApps, npm', windows, (t) => {
  const root = scratch(t);
  const local = join(root, 'Local');
  const roaming = join(root, 'Roaming');
  const home = join(root, 'Home');
  const onPath = join(root, 'on path');
  environment(t, { LOCALAPPDATA: local, APPDATA: roaming, USERPROFILE: home, PATH: `"${onPath}"` });
  const put = (file: string) => {
    mkdirSync(win32.dirname(file), { recursive: true });
    writeFileSync(file, 'Synthetic executable fixture; never run.');
    return file;
  };
  const name = 'pugport-pin-tool';
  const locations = [
    onPath,
    join(home, '.local', 'bin'),
    join(home, '.grok', 'bin'),
    join(home, 'bin'),
    join(local, 'Microsoft', 'WindowsApps'),
    join(roaming, 'npm'),
  ];
  assert.equal(findExecutable(name), undefined);
  // Fill from the last location backwards: each new file must win over the ones after it.
  for (const location of [...locations].reverse()) {
    const file = put(join(location, `${name}.cmd`));
    assert.equal(findExecutable(name), file, location);
  }
  // Within one folder: .exe, .cmd, .bat, then no extension.
  put(join(onPath, `${name}.exe`));
  assert.equal(findExecutable(name), join(onPath, `${name}.exe`));

  assert.equal(findClaudeExecutable(), undefined);
  const npmClaude = put(join(roaming, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
  assert.equal(findClaudeExecutable(), npmClaude);
  const official = put(join(home, '.local', 'bin', 'claude.exe'));
  assert.equal(findClaudeExecutable(), official);

  assert.equal(findCursorExecutable(), undefined);
  const cursorCmd = put(join(local, 'cursor-agent', 'cursor-agent.cmd'));
  assert.equal(findCursorExecutable(), cursorCmd);
  const cursorExe = put(join(local, 'cursor-agent', 'cursor-agent.exe'));
  assert.equal(findCursorExecutable(), cursorExe);

  const older = put(join(local, 'OpenAI', 'Codex', 'bin', 'faa963e871dd422c', 'codex.exe'));
  const newer = put(join(local, 'OpenAI', 'Codex', 'bin', 'c6fe824d725f02d7', 'codex.exe'));
  utimesSync(older, new Date('2026-01-02T00:00:00Z'), new Date('2026-01-02T00:00:00Z'));
  utimesSync(newer, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
  assert.equal(defaultTargets().find((target) => target.id === 'codex-native')!.command, older);
});

test('Windows Recycle Bin script is unchanged', windows, () => {
  const script = recycleScript('C:\\Temp\\comborunner-recycle-in.json', 'C:\\Temp\\comborunner-recycle-out.json');
  // The one-click PATH change switched path values to base64; Recycle Bin logic is unchanged.
  assert.equal(sha(script), '1374bcc847c662cb972e582ebe31b654e56ad87ebfa8386a2cccc0e8984a55b7');
});

test('Windows protected folders and the temporary-folder exception are unchanged', windows, (t) => {
  const home = 'C:\\Users\\fixture';
  environment(t, {
    USERPROFILE: home,
    SystemRoot: 'C:\\Windows',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    ProgramData: 'C:\\ProgramData',
  });
  const system = '系统、程序或应用数据文件夹，不能整理';
  const cases: [string, 'from' | 'to', string | undefined][] = [
    ['C:\\Windows\\System32\\drivers', 'from', system],
    ['c:\\windows', 'to', system],
    ['C:\\Program Files\\App\\a.exe', 'from', system],
    ['C:\\Program Files (x86)', 'to', system],
    ['C:\\ProgramData\\x', 'from', system],
    [`${home}\\AppData\\Roaming\\x`, 'from', system],
    [`${home}\\AppData`, 'to', system],
    [`${home}\\AppData\\Local\\Temp\\unpacked`, 'from', undefined],
    [`${home}\\AppData\\Local\\Temp`, 'from', system],
    ['D:\\$Recycle.Bin\\S-1-5', 'from', '系统文件夹，不能整理'],
    ['E:\\System Volume Information', 'to', '系统文件夹，不能整理'],
    ['C:\\', 'from', '不能移动整个磁盘或用户文件夹'],
    [home, 'from', '不能移动整个磁盘或用户文件夹'],
    [home, 'to', undefined],
    [`${home}\\Downloads`, 'from', '不能移动这个系统文件夹本身'],
    [`${home}\\OneDrive`, 'from', '不能移动这个系统文件夹本身'],
    [`${home}\\Movies`, 'from', undefined],
    [`${home}\\Downloads`, 'to', undefined],
    [`${home}\\Downloads\\a.txt`, 'from', undefined],
    ['D:\\Photos\\2024', 'from', undefined],
  ];
  for (const [path, role, reason] of cases) assert.equal(protectedReason(path, role), reason, `${role} ${path}`);
  const app = 'D:\\Apps\\PugPort';
  assert.equal(protectedReason(`${app}\\resources`, 'to', app), system);
  assert.equal(protectedReason('D:\\Apps', 'from', app), system);
  assert.equal(protectedReason('D:\\Apps', 'to', app), undefined);
});

test('Windows default picture folders are the home and OneDrive library folders', windows, (t) => {
  const home = scratch(t);
  for (const name of [
    'Pictures',
    'Downloads',
    'Videos',
    'Movies',
    join('OneDrive', 'Pictures'),
    join('OneDrive', 'Desktop'),
  ])
    mkdirSync(join(home, name), { recursive: true });
  assert.deepEqual(defaultImageFolders(home).sort(), [
    join(home, 'Downloads'),
    join(home, 'OneDrive', 'Desktop'),
    join(home, 'OneDrive', 'Pictures'),
    join(home, 'Pictures'),
    join(home, 'Videos'),
  ]);
});

/* ---- The same Windows values through a fake Windows host, so every CI system checks them. ---- */

test('appDirs on Windows reproduces every historical folder and fallback', () => {
  const local = 'C:\\Users\\fixture\\AppData\\Local';
  assert.deepEqual(
    productionPaths(() =>
      appDirs(fakeHost('win32', { env: { LOCALAPPDATA: local, APPDATA: 'C:\\Users\\fixture\\AppData\\Roaming' } })),
    ),
    {
      secrets: `${local}\\ComboRunner\\secrets`,
      memoryAnchor: local,
      memoryBase: `${local}\\ComboRunner`,
      vectors: `${local}\\ComboRunner\\memory-vectors`,
      imageIndex: `${local}\\ComboRunner\\image-index`,
      everything: `${local}\\ComboRunner\\everything`,
      extensions: `${local}\\ComboRunner\\extensions`,
      fileMoves: `${local}\\ComboRunner\\file-moves`,
      runtime: `${local}\\PugPort\\runtime`,
      cache: `${local}\\PugPort\\Cache`,
      userConfig: 'C:\\Users\\fixture\\AppData\\Roaming',
      legacy: { extensions: [], fileMoves: [] },
    },
  );
  const home = 'C:\\Users\\fixture';
  assert.deepEqual(
    productionPaths(() => appDirs(fakeHost('win32'))),
    {
      secrets: `${home}\\ComboRunner\\secrets`,
      memoryAnchor: `${home}\\AppData\\Local`,
      memoryBase: `${home}\\AppData\\Local\\ComboRunner`,
      vectors: `${home}\\ComboRunner\\memory-vectors`,
      imageIndex: `${home}\\ComboRunner\\image-index`,
      everything: `${home}\\ComboRunner\\everything`,
      extensions: `${home}\\.local\\share\\ComboRunner\\extensions`,
      fileMoves: `${home}\\.local\\share\\ComboRunner\\file-moves`,
      runtime: `${home}\\.local\\share\\PugPort\\runtime`,
      cache: undefined,
      userConfig: `${home}\\AppData\\Roaming`,
      legacy: { extensions: [], fileMoves: [] },
    },
  );
});

test('Windows search folders, executable rules and taskkill arguments are unchanged', () => {
  const home = 'C:\\Users\\fixture';
  const host = fakeHost('win32', {
    env: { LOCALAPPDATA: `${home}\\AppData\\Local`, APPDATA: `${home}\\AppData\\Roaming` },
  });
  assert.deepEqual(searchDirs(host), [
    `${home}\\.local\\bin`,
    `${home}\\.grok\\bin`,
    `${home}\\bin`,
    `${home}\\AppData\\Local\\Microsoft\\WindowsApps`,
    `${home}\\AppData\\Roaming\\npm`,
  ]);
  // Without the variables the old relative spellings stay (they never match anything).
  assert.deepEqual(searchDirs(fakeHost('win32')).slice(3), ['Microsoft\\WindowsApps', 'npm']);
  const tree = fakeTree({
    'C:\\Tools\\codex.exe': 'file',
    'C:\\Tools\\codex.cmd': 'file',
    'C:\\Tools\\dir.exe': 'dir',
  });
  const windowsTree = fakeHost('win32', { fs: tree });
  assert.equal(isDirectExecutable('C:\\Tools\\codex.exe', windowsTree), true);
  for (const path of ['C:\\Tools\\codex.cmd', 'C:\\Tools\\dir.exe', 'C:\\Tools\\missing.exe', 'codex.exe'])
    assert.equal(isDirectExecutable(path, windowsTree), false, path);
  assert.equal(requireDirectExecutable('C:\\Tools\\codex.exe', windowsTree), 'C:\\Tools\\codex.exe');
  assert.throws(() => requireDirectExecutable('C:\\Tools\\codex.cmd', windowsTree), /包装脚本/);
  assert.throws(() => requireDirectExecutable('C:\\Tools\\missing.exe', windowsTree), /找不到/);
  assert.deepEqual(windowsTreeKill(4242, 'C:\\Windows'), {
    file: join('C:\\Windows', 'System32', 'taskkill.exe'),
    args: ['/pid', '4242', '/t', '/f'],
  });
});

test('Windows secrets keep the same whoami and icacls calls', async () => {
  const sid = 'S-1-5-21-1111-2222-3333-1001';
  const recorded = recordingRun((file) => (file.endsWith('whoami.exe') ? `"pc\\fixture","${sid}"\r\n` : ''));
  const host = fakeHost('win32', { env: { SystemRoot: 'C:\\Windows' }, run: recorded.run });
  await restrictFile('C:\\Data\\private-config.tmp', { timeoutMs: 1234 }, host);
  await restrictDirectory('C:\\Data\\accounts', {}, host);
  const system = 'C:\\Windows\\System32';
  const fast = { windowsHide: true, timeout: 1234 };
  const usual = { windowsHide: true, timeout: 5000 };
  // The folder's current list is read first (to a random temporary file) and written only when it differs.
  const read = recorded.calls[4]!;
  assert.match(String(read.args[2]), /^C:\\Users\\fixture\\AppData\\Local\\Temp\\pugport-acl-[0-9a-f-]{36}\.txt$/);
  assert.deepEqual(recorded.calls, [
    { file: `${system}\\whoami.exe`, args: ['/user', '/fo', 'csv', '/nh'], options: fast },
    { file: `${system}\\icacls.exe`, args: ['C:\\Data\\private-config.tmp', '/reset'], options: fast },
    {
      file: `${system}\\icacls.exe`,
      args: ['C:\\Data\\private-config.tmp', '/inheritance:r', '/grant:r', `*${sid}:(F)`, '*S-1-5-18:(F)'],
      options: fast,
    },
    { file: `${system}\\whoami.exe`, args: ['/user', '/fo', 'csv', '/nh'], options: usual },
    { file: `${system}\\icacls.exe`, args: ['C:\\Data\\accounts', '/save', read.args[2]], options: usual },
    {
      file: `${system}\\icacls.exe`,
      args: ['C:\\Data\\accounts', '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)(F)`, '*S-1-5-18:(OI)(CI)(F)'],
      options: usual,
    },
  ]);
  const noUser = fakeHost('win32', { run: () => ({ stdout: 'no identity', stderr: '' }) });
  await assert.rejects(restrictFile('C:\\x', {}, noUser), /missing user identity/);
});

test('Windows battery, memory, lock file, Pi tools, reveal and protected roots are unchanged', async () => {
  const recorded = recordingRun(() => 'False\r\n');
  const host = fakeHost('win32', { run: recorded.run, freemem: () => 1234 });
  assert.equal(await onBattery(host), true);
  assert.deepEqual(recorded.calls, [
    {
      file: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus -ErrorAction SilentlyContinue | Select-Object -First 1).PowerOnline',
      ],
      options: { timeout: 15_000, windowsHide: true },
    },
  ]);
  assert.equal(await onBattery(fakeHost('win32', { run: () => ({ stdout: 'True', stderr: '' }) })), false);
  assert.equal(await onBattery(fakeHost('win32')), false, 'a failed reading is never "on battery"');
  assert.equal(availableMemory(host), 1234, 'os.freemem() is already the available figure on Windows');

  assert.match(serverLockText(4242, fakeHost('win32')), /^4242\n\d+$/);
  assert.deepEqual(parseServerLock('4242', fakeHost('win32')), { pid: 4242 });
  assert.equal(
    serverLockHeld('4242', fakeHost('win32'), () => true),
    true,
  );
  assert.equal(
    serverLockHeld('4242', fakeHost('win32'), () => false),
    false,
  );
  assert.equal(
    serverLockHeld('not a pid', fakeHost('win32'), () => true),
    false,
  );

  assert.deepEqual(piWritableTools(fakeHost('win32')), [
    'read',
    'grep',
    'find',
    'ls',
    'edit',
    'write',
    'bash',
    'powershell',
  ]);
  assert.deepEqual(revealCommand('C:\\a b\\c.txt', false, fakeHost('win32')), {
    command: 'explorer.exe',
    args: ['/select,"C:\\a b\\c.txt"'],
  });
  assert.deepEqual(revealCommand('C:\\a b', true, fakeHost('win32')), { command: 'explorer.exe', args: ['"C:\\a b"'] });

  const roots = protectedRoots(fakeHost('win32', { env: { SystemRoot: 'D:\\Win' } }));
  assert.deepEqual(roots.system, [
    'D:\\Win',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'C:\\ProgramData',
    'C:\\Users\\fixture\\AppData',
  ]);
  assert.deepEqual(roots.allowedInside, ['C:\\Users\\fixture\\AppData\\Local\\Temp']);
  assert.deepEqual(
    roots.main,
    ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Videos', 'Music', 'OneDrive'].map(
      (name) => `C:\\Users\\fixture\\${name}`,
    ),
  );
  assert.equal(capabilities(fakeHost('win32')).trash, true);
  assert.equal(trashName(fakeHost('win32')), '回收站');
});

test('Windows tool text for the Recycle Bin, organizing and example paths is unchanged', () => {
  const words = bridgeWording(fakeHost('win32'));
  // Hash of the recycle_files and organize_files definitions as first released; the wording must not drift.
  assert.equal(
    sha(JSON.stringify([recycleToolFor(words), organizeToolsFor(words)])),
    '0b662971c5c6c1961d073ae0b216baee6ef5645a95edbb142da6c669f2e62752',
  );
  assert.equal(words.folderExample, 'C:\\Users\\名字\\Downloads');
  assert.equal(words.pageExample, 'file:///C:/site/index.html');
  assert.equal(words.moveToSystemTrash, '移到 Windows 回收站');
  assert.equal(words.trash, '回收站');
});

test('Windows memory sync helper is still a .cmd file', windows, (t) => {
  const root = scratch(t);
  const project = join(root, 'project');
  mkdirSync(project);
  const id = '12345678-1234-4234-8234-123456789abc';
  writeMemorySyncHelper(project, 'C:\\node.exe', 'C:\\app\\cli.js', join(root, 'data'), id);
  assert.equal(existsSync(join(project, '.comborunner', 'sync-memory.cmd')), true);
  assert.equal(existsSync(join(project, '.comborunner', 'sync-memory.sh')), false);
});

test('Windows server locks write without spawning and compare Unix ms without terminating any process', (t) => {
  t.mock.method(Date, 'now', () => 1_792_166_410_000);
  t.mock.method(process, 'uptime', () => 10);
  let birth = '1792166400000';
  let queries = 0;
  const host = fakeHost('win32', {
    runSync: (file, args, options) => {
      queries++;
      assert.equal(file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
      assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
      const script = Buffer.from(args[3]!, 'base64').toString('utf16le');
      assert.match(script, /Get-CimInstance Win32_Process -Filter 'ProcessId=4242' -Property CreationDate/);
      assert.match(script, /\[DateTimeOffset\]::new\(\$p.CreationDate\).ToUnixTimeMilliseconds\(\)/);
      assert.doesNotMatch(script, /Kill|Stop-Process/i);
      assert.equal(options?.windowsHide, true);
      assert.equal(options?.timeout, 5000);
      return birth + '\r\n';
    },
  });
  const lock = serverLockText(4242, host);
  assert.equal(queries, 0, 'Writing our own lock must not query PowerShell');
  assert.equal(lock, '4242\n1792166400000');
  assert.deepEqual(parseServerLock(lock, host), { pid: 4242, started: birth });
  assert.equal(
    serverLockHeld(lock, host, () => true),
    true,
  );
  for (const offset of [-5000, 3000, 5000]) {
    birth = String(1_792_166_400_000 + offset);
    assert.equal(
      serverLockHeld(lock, host, () => true),
      true,
      'Within 5 seconds stays held',
    );
  }
  birth = '1792166410000';
  assert.equal(
    serverLockHeld(lock, host, () => true),
    false,
    'A recycled PID does not own the old lock',
  );
  const before = queries;
  assert.equal(
    serverLockHeld(lock, host, () => false),
    false,
  );
  assert.equal(
    serverLockHeld('4242', host, () => true),
    true,
    'Legacy PID-only locks keep their behavior',
  );
  assert.equal(queries, before, 'Dead PIDs and legacy locks must not query PowerShell');
  assert.equal(
    serverLockHeld(lock, fakeHost('win32'), () => true),
    true,
    'Unknown identity stays conservative',
  );
  birth = 'invalid';
  assert.equal(processStartTime(4242, host), undefined);
  assert.equal(
    serverLockHeld(lock, host, () => true),
    true,
    'Invalid CIM output stays held',
  );
  assert.equal(
    serverLockHeld('4242\ninvalid', host, () => true),
    true,
  );
  birth = '1792166410000';
  assert.equal(
    serverLockHeld('4242\ninvalid', host, () => true),
    true,
    'Invalid stored time stays held',
  );
  assert.equal(processStartTime(0, host), undefined);
});
