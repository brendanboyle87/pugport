import { productionPaths } from './helpers/production-paths.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeWording, organizeToolsFor, recycleToolFor } from '../src/server/agent-bridge.ts';
import { piWritableTools } from '../src/server/adapters/pi.ts';
import { revealCommand } from '../src/server/app-settings.ts';
import { protectedReason } from '../src/server/file-manager.ts';
import { defaultImageFolders } from '../src/server/image-search.ts';
import { requireDirectExecutable } from '../src/server/native-accounts.ts';
import { appDirs, parseUserDirs, userFolders } from '../src/server/platform/dirs.ts';
import { cliEnvironment, findExecutable, isDirectExecutable, searchDirs } from '../src/server/platform/executables.ts';
import { capabilities } from '../src/server/platform/host.ts';
import { protectedInside, protectionKey } from '../src/server/platform/protected-roots.ts';
import { restrictDirectory, restrictFile } from '../src/server/platform/secure-file.ts';
import {
  parseServerLock,
  processStartTime,
  serverLockHeld,
  serverLockText,
} from '../src/server/platform/server-lock.ts';
import { loginShellPath, parseLoginShellPath } from '../src/server/platform/shell-env.ts';
import {
  availableMemory,
  gpuPercent,
  onBattery,
  parseIoreg,
  parseMeminfo,
  parseNvidiaSmi,
  parsePmset,
  parsePowerSupplies,
  parseVmStat,
} from '../src/server/platform/system-stats.ts';
import { runtimeDirectories, runtimeRoot, userRuntimeRoot } from '../scripts/runtime-paths.mjs';
import { fakeFs, fakeHost, fakeTree, recordingRun } from './helpers/fake-host.ts';

/* macOS and Linux branches, run on every system through fake hosts (POSIX paths via host.path). */

const GB = 1024 ** 3;

test('macOS keeps app data in Application Support and caches in Library/Caches', () => {
  const root = '/Users/fixture/Library/Application Support/PugPort';
  assert.deepEqual(
    productionPaths(() => appDirs(fakeHost('darwin', { env: { LOCALAPPDATA: '/ignored' } }))),
    {
      secrets: `${root}/secrets`,
      memoryAnchor: '/Users/fixture/Library/Application Support',
      memoryBase: root,
      vectors: `${root}/memory-vectors`,
      imageIndex: `${root}/image-index`,
      everything: `${root}/everything`,
      extensions: `${root}/extensions`,
      fileMoves: `${root}/file-moves`,
      runtime: `${root}/runtime`,
      cache: '/Users/fixture/Library/Caches/PugPort',
      userConfig: '/Users/fixture/Library/Application Support',
      legacy: { extensions: [], fileMoves: [] },
    },
  );
});

test('Linux follows XDG folders and still reads the old ~/.local/share/ComboRunner records', () => {
  const root = '/home/fixture/.local/share/pugport';
  const old = '/home/fixture/.local/share/ComboRunner';
  assert.deepEqual(
    productionPaths(() => appDirs(fakeHost('linux'))),
    {
      secrets: `${root}/secrets`,
      memoryAnchor: '/home/fixture/.local/share',
      memoryBase: root,
      vectors: `${root}/memory-vectors`,
      imageIndex: `${root}/image-index`,
      everything: `${root}/everything`,
      extensions: `${root}/extensions`,
      fileMoves: `${root}/file-moves`,
      runtime: `${root}/runtime`,
      cache: '/home/fixture/.cache/pugport',
      userConfig: '/home/fixture/.config',
      legacy: { extensions: [`${old}/extensions`], fileMoves: [`${old}/file-moves`] },
    },
  );
  const xdg = productionPaths(() =>
    appDirs(
      fakeHost('linux', { env: { XDG_DATA_HOME: '/data/user', XDG_CACHE_HOME: '/cache', XDG_CONFIG_HOME: '/conf' } }),
    ),
  );
  assert.equal(xdg.secrets, '/data/user/pugport/secrets');
  assert.equal(xdg.memoryAnchor, '/data/user');
  assert.equal(xdg.runtime, '/data/user/pugport/runtime');
  assert.equal(xdg.cache, '/cache/pugport');
  assert.equal(xdg.userConfig, '/conf');
  assert.deepEqual(xdg.legacy.extensions, [`${old}/extensions`], 'the old folder never moved with XDG_DATA_HOME');
  // Relative XDG values are invalid by the specification and ignored.
  const relative = productionPaths(() =>
    appDirs(fakeHost('linux', { env: { XDG_DATA_HOME: 'data', XDG_CACHE_HOME: './cache' } })),
  );
  assert.equal(relative.secrets, `${root}/secrets`);
  assert.equal(relative.cache, '/home/fixture/.cache/pugport');
});

test('packaged runtime downloads go to the platform user folder', () => {
  const app = '/Applications/PugPort.app/Contents/Resources/app';
  assert.equal(
    runtimeRoot(app, { HOME: '/Users/me' }, 'darwin'),
    '/Users/me/Library/Application Support/PugPort/runtime',
  );
  assert.equal(
    runtimeRoot('/opt/pugport/resources/app', { HOME: '/home/me' }, 'linux'),
    '/home/me/.local/share/pugport/runtime',
  );
  assert.equal(
    runtimeRoot('/opt/pugport/resources/app', { HOME: '/home/me', XDG_DATA_HOME: '/srv/data' }, 'linux'),
    '/srv/data/pugport/runtime',
  );
  assert.equal(runtimeRoot('/home/me/pugport', {}, 'linux'), '/home/me/pugport/.runtime');
  assert.deepEqual(runtimeDirectories('/opt/pugport/resources/app', 'voice', { HOME: '/home/me' }, 'linux'), [
    '/home/me/.local/share/pugport/runtime/voice',
    '/opt/pugport/resources/app/.runtime/voice',
    '/opt/pugport/resources/voice',
  ]);
  assert.equal(
    userRuntimeRoot({}, 'linux', '/home/x'),
    productionPaths(() => appDirs(fakeHost('linux', { home: '/home/x' }))).runtime,
  );
});

test('user folders: fixed English names on macOS, xdg-user-dirs (possibly localized) on Linux', () => {
  assert.equal(userFolders(fakeHost('darwin')).videos, '/Users/fixture/Movies');
  assert.equal(userFolders(fakeHost('win32')).videos, 'C:\\Users\\fixture\\Videos');
  const text = [
    '# This file is written by xdg-user-dirs-update',
    'XDG_DESKTOP_DIR="$HOME/桌面"',
    'XDG_DOWNLOAD_DIR="$HOME/下载"',
    'XDG_PICTURES_DIR="/media/photos"',
    'XDG_TEMPLATES_DIR="$HOME/"',
    'XDG_VIDEOS_DIR="relative"',
  ].join('\n');
  const linux = fakeHost('linux');
  assert.deepEqual(parseUserDirs(text, linux), {
    desktop: '/home/fixture/桌面',
    downloads: '/home/fixture/下载',
    pictures: '/media/photos',
  });
  const folders = productionPaths(() =>
    userFolders(
      fakeHost('linux', {
        fs: fakeFs({
          readFileSync: (path: string) => {
            assert.equal(path, '/home/fixture/.config/user-dirs.dirs');
            return text;
          },
        }),
      }),
    ),
  );
  assert.equal(folders.pictures, '/media/photos');
  assert.equal(folders.videos, '/home/fixture/Videos');
  assert.equal(folders.templates, '/home/fixture/Templates', 'a folder turned off falls back to the default name');
  assert.equal(userFolders(linux).downloads, '/home/fixture/Downloads', 'without the file, English defaults');
});

test('default picture folders follow each platform', () => {
  const mac = fakeHost('darwin', {
    fs: fakeTree({ '/Users/fixture/Pictures': 'dir', '/Users/fixture/Movies': 'dir', '/Users/fixture/Videos': 'dir' }),
  });
  assert.deepEqual(defaultImageFolders(undefined, mac).sort(), ['/Users/fixture/Movies', '/Users/fixture/Pictures']);
  const linux = fakeHost('linux', {
    fs: fakeTree({
      '/home/fixture/Pictures': 'dir',
      '/home/fixture/Pictures/2024': 'dir',
      '/home/fixture/Downloads': 'dir',
    }),
  });
  assert.deepEqual(defaultImageFolders(undefined, linux).sort(), ['/home/fixture/Downloads', '/home/fixture/Pictures']);
});

test('macOS and Linux search Homebrew, npm, volta, bun, the newest nvm and snap folders', () => {
  const mac = fakeHost('darwin', {
    fs: fakeFs({
      readFileSync: (path: string) => {
        if (path === '/Users/fixture/.npmrc') return 'registry=https://registry.example\nprefix = ~/.npm-packages\n';
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      readdirSync: (path: string) => {
        assert.equal(path, '/Users/fixture/.nvm/versions/node');
        return ['v18.20.0', 'v22.11.0', 'v20.1.0', 'system'];
      },
    }),
  });
  assert.deepEqual(searchDirs(mac), [
    '/Users/fixture/.local/bin',
    '/Users/fixture/.grok/bin',
    '/Users/fixture/bin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/Users/fixture/.npm-packages/bin',
    '/Users/fixture/.npm-global/bin',
    '/Users/fixture/.volta/bin',
    '/Users/fixture/.bun/bin',
    '/Users/fixture/.nvm/versions/node/v22.11.0/bin',
  ]);
  assert.deepEqual(searchDirs(fakeHost('linux', { env: { NPM_CONFIG_PREFIX: '/opt/npm' } })), [
    '/home/fixture/.local/bin',
    '/home/fixture/.grok/bin',
    '/home/fixture/bin',
    '/usr/local/bin',
    '/opt/npm/bin',
    '/home/fixture/.npm-global/bin',
    '/home/fixture/.volta/bin',
    '/home/fixture/.bun/bin',
    '/snap/bin',
    '/home/linuxbrew/.linuxbrew/bin',
    '/home/fixture/.linuxbrew/bin',
  ]);
});

test('macOS adds the login shell PATH once, after PATH and before the fixed folders', () => {
  const calls: { file: string; args: readonly string[] }[] = [];
  const mac = fakeHost('darwin', {
    env: { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' },
    runSync: (file, args) => {
      calls.push({ file, args });
      return 'Last login: today\n__PUGPORT_PATH__/opt/homebrew/bin:/Users/fixture/.cargo/bin:relative:/usr/bin__PUGPORT_PATH__\n';
    },
  });
  assert.deepEqual(loginShellPath(mac), ['/opt/homebrew/bin', '/Users/fixture/.cargo/bin', '/usr/bin']);
  assert.deepEqual(loginShellPath(mac), ['/opt/homebrew/bin', '/Users/fixture/.cargo/bin', '/usr/bin']);
  assert.equal(calls.length, 1, 'asked once per process');
  assert.equal(calls[0]!.file, '/bin/zsh');
  assert.equal(calls[0]!.args[0], '-ilc');
  assert.ok(searchDirs(mac).indexOf('/Users/fixture/.cargo/bin') < searchDirs(mac).indexOf('/usr/local/bin'));
  const failing = fakeHost('darwin', {
    env: { SHELL: 'zsh' },
    runSync: () => {
      throw new Error('timed out');
    },
  });
  assert.deepEqual(loginShellPath(failing), []);
  let linuxCalls = 0;
  const linux = fakeHost('linux', {
    runSync: () => {
      linuxCalls++;
      return '';
    },
  });
  assert.deepEqual(loginShellPath(linux), []);
  assert.equal(linuxCalls, 0, 'Linux services set PATH in their unit');
  assert.deepEqual(parseLoginShellPath('no marker here', mac), []);
});

test('a CLI also sees its own folder and the search folders after PATH, so `#!/usr/bin/env node` finds node', () => {
  const mac = fakeHost('darwin', { runSync: () => '' });
  const finder = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: '/Users/fixture' };
  const env = cliEnvironment('/Users/fixture/tools/codex', finder, mac);
  assert.deepEqual(env.PATH!.split(':'), [
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    '/Users/fixture/tools',
    '/Users/fixture/.local/bin',
    '/Users/fixture/.grok/bin',
    '/Users/fixture/bin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/Users/fixture/.npm-global/bin',
    '/Users/fixture/.volta/bin',
    '/Users/fixture/.bun/bin',
  ]);
  assert.equal(env.HOME, '/Users/fixture');
  assert.equal(finder.PATH, '/usr/bin:/bin:/usr/sbin:/sbin', 'the given environment is not changed');
  // Homebrew's folder is already in the search folders: listed once.
  const brew = cliEnvironment('/opt/homebrew/bin/codex', {}, mac).PATH!.split(':');
  assert.equal(brew[0], '/opt/homebrew/bin');
  assert.equal(brew.filter((dir) => dir === '/opt/homebrew/bin').length, 1);
  const linux = cliEnvironment('/home/fixture/.npm-global/bin/gemini', { PATH: '/usr/bin' }, fakeHost('linux'));
  assert.deepEqual(linux.PATH!.split(':').slice(0, 3), [
    '/usr/bin',
    '/home/fixture/.npm-global/bin',
    '/home/fixture/.local/bin',
  ]);
  const windows = { Path: 'C:\\Windows\\System32' };
  assert.equal(cliEnvironment('C:\\tools\\codex.exe', windows, fakeHost('win32')), windows);
});

test('POSIX discovery accepts linked executables but not wrappers, folders or files without X', () => {
  const fs = fakeTree({
    '/opt/homebrew/bin/codex': { link: '/opt/homebrew/Caskroom/codex/1.0/codex' },
    '/opt/homebrew/Caskroom/codex/1.0/codex': 'exec',
    '/usr/local/bin/plain': 'file',
    '/usr/local/bin/tool.cmd': 'exec',
    '/usr/local/bin/folder': 'dir',
    '/usr/local/bin/broken': { link: '/nowhere' },
  });
  const mac = fakeHost('darwin', { fs, env: { PATH: '/usr/bin' } });
  assert.equal(isDirectExecutable('/opt/homebrew/bin/codex', mac), true);
  for (const path of [
    '/usr/local/bin/plain',
    '/usr/local/bin/tool.cmd',
    '/usr/local/bin/folder',
    '/usr/local/bin/broken',
    'opt/homebrew/bin/codex',
    '/usr/local/bin/x\ny',
  ])
    assert.equal(isDirectExecutable(path, mac), false, path);
  assert.equal(requireDirectExecutable('/opt/homebrew/bin/codex', mac), '/opt/homebrew/bin/codex');
  assert.throws(() => requireDirectExecutable('/usr/local/bin/tool.cmd', mac), /包装脚本/);
  assert.throws(() => requireDirectExecutable('/usr/local/bin/plain', mac), /找不到/);
  assert.throws(() => requireDirectExecutable('codex', mac), /包装脚本/);
  // Found after PATH misses, in a fixed folder; the result keeps the link's own path.
  assert.equal(findExecutable('codex', mac), '/opt/homebrew/bin/codex');
  assert.equal(findExecutable('missing', mac), undefined);
});

test('POSIX secrets are 0600 files and 0700 folders, checked through the open descriptor', async () => {
  const handle = (mode: number, uid = 501, kind: 'file' | 'dir' = 'file') => {
    const changes: number[] = [];
    let closed = false;
    return {
      changes,
      get closed() {
        return closed;
      },
      chmod: async (value: number) => {
        changes.push(value);
      },
      stat: async () => ({ uid, mode, isFile: () => kind === 'file', isDirectory: () => kind === 'dir' }),
      close: async () => {
        closed = true;
      },
    };
  };
  const linux = fakeHost('linux');
  const good = handle(0o100600);
  await restrictFile('/x', { handle: good as never }, linux);
  assert.deepEqual(good.changes, [0o600]);
  await assert.rejects(restrictFile('/x', { handle: handle(0o100644) as never }, linux), /owner-only/);
  await assert.rejects(restrictFile('/x', { handle: handle(0o100600, 0) as never }, linux), /owner-only/);

  const opened: { path: string; flags: number }[] = [];
  const folder = handle(0o40700, 501, 'dir');
  const host = fakeHost('darwin', {
    fs: fakeFs({
      promises: {
        open: async (path: string, flags: number) => {
          opened.push({ path, flags });
          return folder;
        },
      },
    }),
  });
  await restrictDirectory('/Users/fixture/data/accounts', {}, host);
  assert.deepEqual(folder.changes, [0o700]);
  assert.equal(folder.closed, true);
  assert.equal(opened[0]!.path, '/Users/fixture/data/accounts');
  const { constants } = await import('node:fs');
  if (constants.O_NOFOLLOW) assert.ok(opened[0]!.flags & constants.O_NOFOLLOW, 'a link is never followed');
  const notFolder = handle(0o100600, 501, 'file');
  const fileHost = fakeHost('linux', { fs: fakeFs({ promises: { open: async () => notFolder } }) });
  await assert.rejects(restrictDirectory('/x', {}, fileHost), /not a directory/);
  assert.equal(notFolder.closed, true);
});

test('memory, battery and GPU parsers read captured macOS and Linux output', () => {
  const vmStat = [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                               10000.',
    'Pages active:                            200000.',
    'Pages inactive:                          150000.',
    'Pages speculative:                         5000.',
    'Pages throttled:                              0.',
    'Pages wired down:                        100000.',
    'Pages purgeable:                           2000.',
    '"Translation faults":                 123456789.',
  ].join('\n');
  assert.equal(parseVmStat(vmStat), (10000 + 150000 + 5000 + 2000) * 16384);
  assert.equal(parseVmStat('Pages free: 10.'), undefined, 'no page size, no reading');
  assert.equal(
    parseMeminfo('MemTotal:       16318684 kB\nMemFree:          912345 kB\nMemAvailable:    8123456 kB\n'),
    8123456 * 1024,
  );
  assert.equal(parseMeminfo('MemTotal: 1 kB\nMemFree: 1 kB\n'), undefined);
  assert.equal(parsePmset("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t80%; discharging"), true);
  assert.equal(parsePmset("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged"), false);
  assert.equal(parsePmset(''), false);
  assert.equal(
    parsePowerSupplies([
      { type: 'Mains\n', online: '0\n' },
      { type: 'Battery', status: 'Discharging\n' },
    ]),
    true,
  );
  assert.equal(
    parsePowerSupplies([
      { type: 'Mains', online: '1' },
      { type: 'Battery', status: 'Discharging' },
    ]),
    false,
  );
  assert.equal(
    parsePowerSupplies([
      { type: 'USB', online: '1' },
      { type: 'Battery', status: 'Charging' },
    ]),
    false,
  );
  assert.equal(parsePowerSupplies([]), false, 'a desktop has no battery');
  assert.equal(
    parseIoreg(
      '| "PerformanceStatistics" = {"In use system memory"=123,"Device Utilization %"=37,"Renderer Utilization %"=30}\n' +
        '| "PerformanceStatistics" = {"Device Utilization %"=52}',
    ),
    52,
  );
  assert.equal(parseIoreg('no accelerator'), undefined);
  assert.equal(parseNvidiaSmi('35\n71\n'), 71);
  assert.equal(parseNvidiaSmi('[N/A]\n[Not Supported]\n'), undefined);
});

test('available memory: vm_stat on macOS (cached briefly), MemAvailable on Linux', () => {
  let reads = 0;
  const mac = fakeHost('darwin', {
    totalmem: () => 16 * GB,
    runSync: (file) => {
      reads++;
      assert.equal(file, '/usr/bin/vm_stat');
      return 'Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 1000.\nPages inactive: 3000.\n';
    },
  });
  assert.equal(availableMemory(mac), 4000 * 4096);
  assert.equal(availableMemory(mac), 4000 * 4096);
  assert.equal(reads, 1);
  assert.equal(availableMemory(fakeHost('darwin')), undefined, 'no vm_stat, no made-up figure');
  const linux = fakeHost('linux', {
    freemem: () => 1,
    fs: fakeFs({ readFileSync: () => 'MemTotal: 100 kB\nMemAvailable:    50 kB\n' }),
  });
  assert.equal(availableMemory(linux), 50 * 1024);
  assert.equal(availableMemory(fakeHost('linux', { freemem: () => 7 })), 7, 'without /proc, os.freemem()');
});

test('battery and GPU readings run the platform tools and treat failures as no reading', async () => {
  const pmset = recordingRun(() => "Now drawing from 'Battery Power'\n");
  assert.equal(await onBattery(fakeHost('darwin', { run: pmset.run })), true);
  assert.deepEqual(pmset.calls[0]!.args, ['-g', 'batt']);
  assert.equal(pmset.calls[0]!.file, '/usr/bin/pmset');
  assert.equal(await onBattery(fakeHost('darwin')), false);
  const files: Record<string, string> = {
    '/sys/class/power_supply/AC/type': 'Mains\n',
    '/sys/class/power_supply/AC/online': '0\n',
    '/sys/class/power_supply/BAT0/type': 'Battery\n',
    '/sys/class/power_supply/BAT0/status': 'Discharging\n',
  };
  const laptop = fakeHost('linux', {
    fs: fakeFs({
      readdirSync: () => ['AC', 'BAT0'],
      readFileSync: (path: string) => {
        if (files[path] === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return files[path];
      },
    }),
  });
  assert.equal(await onBattery(laptop), true);
  assert.equal(await onBattery(fakeHost('linux')), false, 'no power_supply folder: a server');
  const ioreg = recordingRun(() => '"PerformanceStatistics" = {"Device Utilization %"=12}');
  assert.equal(await gpuPercent(fakeHost('darwin', { run: ioreg.run })), 12);
  assert.equal(ioreg.calls[0]!.file, '/usr/sbin/ioreg');
  const smi = recordingRun(() => '5\n9\n');
  assert.equal(await gpuPercent(fakeHost('linux', { run: smi.run })), 9);
  assert.deepEqual(smi.calls[0]!.args, [
    '--query-gpu=utilization.gpu,name,memory.used,memory.total',
    '--format=csv,noheader,nounits',
  ]);
  assert.equal(await gpuPercent(fakeHost('linux')), undefined, 'no NVIDIA tool: unavailable, not zero');
});

test('macOS protects its system, app-data and key folders, ignoring letter case', () => {
  const mac = fakeHost('darwin');
  const system = '系统、程序或应用数据文件夹，不能整理';
  const cases: [string, 'from' | 'to', string | undefined][] = [
    ['/System/Library/CoreServices', 'from', system],
    ['/system/library', 'to', system],
    ['/Library/LaunchDaemons/x.plist', 'from', system],
    ['/Applications/Safari.app', 'from', system],
    ['/usr/local/bin/node', 'from', system],
    ['/opt/homebrew/bin', 'to', system],
    ['/private/etc/hosts', 'from', system],
    // /etc/hosts itself is caught by its real location, /private/etc/hosts (canonical check in file-manager).
    ['/Users/fixture/Library/Preferences/x.plist', 'from', system],
    ['/Users/fixture/library', 'to', system],
    ['/Users/fixture/.ssh/id_ed25519', 'from', system],
    ['/Users/fixture/.config/gh', 'from', system],
    ['/var/folders/fx/fixture/T/unpacked', 'from', undefined],
    ['/Users/fixture/.Trash/old.txt', 'from', '系统文件夹，不能整理'],
    ['/Volumes/USB/.Trashes/501', 'from', '系统文件夹，不能整理'],
    ['/', 'from', '不能移动整个磁盘或用户文件夹'],
    ['/Users/fixture', 'from', '不能移动整个磁盘或用户文件夹'],
    ['/Users/fixture/Movies', 'from', '不能移动这个系统文件夹本身'],
    ['/Users/fixture/applications', 'from', '不能移动这个系统文件夹本身'],
    ['/Users/fixture/Downloads/a.dmg', 'from', undefined],
    ['/Users/fixture/Downloads', 'to', undefined],
    ['/Volumes/USB/photos', 'from', undefined],
  ];
  for (const [path, role, reason] of cases)
    assert.equal(protectedReason(path, role, undefined, mac), reason, `${role} ${path}`);
  assert.equal(protectedReason('/Apps/PugPort.app/Contents', 'to', '/Apps/PugPort.app', mac), system);
  assert.equal(protectionKey('/Users/A', mac), '/users/a');
  // TMPDIR's real spelling is below /private, which is otherwise protected.
  assert.equal(protectedReason('/private/var/folders/fx/fixture/T/x', 'from', undefined, mac), system);
  const real = fakeHost('darwin', {
    fs: fakeFs({ realpathSync: (path: string) => (path === '/var/folders/fx/fixture/T' ? `/private${path}` : path) }),
  });
  assert.equal(protectedReason('/private/var/folders/fx/fixture/T/x', 'from', undefined, real), undefined);
  assert.equal(protectedReason('/private/var/db/x', 'from', undefined, real), system);
});

test('Linux protects the system tree, dot folders and localized main folders, with case sensitivity', () => {
  const linux = fakeHost('linux', {
    fs: fakeFs({ readFileSync: () => 'XDG_PICTURES_DIR="$HOME/图片"\nXDG_DOWNLOAD_DIR="$HOME/下载"\n' }),
  });
  const system = '系统、程序或应用数据文件夹，不能整理';
  const cases: [string, 'from' | 'to', string | undefined][] = [
    ['/etc/passwd', 'from', system],
    ['/usr/bin', 'to', system],
    ['/boot/vmlinuz', 'from', system],
    ['/proc/1/environ', 'from', system],
    ['/sys/class', 'from', system],
    ['/lib64/ld.so', 'from', system],
    ['/var/log/syslog', 'from', system],
    ['/snap/core/1', 'from', system],
    ['/home/fixture/.config/pugport', 'from', system],
    ['/home/fixture/.local/share/Trash/files/x', 'from', system],
    ['/home/fixture/.cache/thumbnails', 'from', system],
    ['/home/fixture/.ssh/authorized_keys', 'to', system],
    ['/media/fixture/disk/.Trash-1000/files/x', 'from', '系统文件夹，不能整理'],
    ['/tmp/unpacked/x', 'from', undefined],
    ['/ETC', 'from', undefined],
    ['/home/fixture/图片', 'from', '不能移动这个系统文件夹本身'],
    ['/home/fixture/Pictures', 'from', '不能移动这个系统文件夹本身'],
    ['/home/fixture/下载/a.iso', 'from', undefined],
    ['/home/fixture', 'from', '不能移动整个磁盘或用户文件夹'],
    ['/mnt/data/photos', 'from', undefined],
  ];
  for (const [path, role, reason] of cases)
    assert.equal(protectedReason(path, role, undefined, linux), reason, `${role} ${path}`);
  assert.equal(protectedInside('/usr/..x', '/usr', linux), true, 'a name starting with ".." is still inside');
  assert.equal(protectedInside('/usr', '/usr', linux), false);
  assert.equal(protectedInside('/usrx', '/usr', linux), false);
});

test('lock files on macOS and Linux record the start time, so a reused PID does not block startup', () => {
  const runs: { file: string; args: readonly string[]; env?: NodeJS.ProcessEnv }[] = [];
  let started = 'Sat Oct 10 09:00:00 2026';
  const linux = fakeHost('linux', {
    runSync: (file, args, options) => {
      runs.push({ file, args, ...(options?.env ? { env: options.env } : {}) });
      return `${started}\n`;
    },
  });
  const text = serverLockText(4242, linux);
  assert.equal(text, '4242\nSat Oct 10 09:00:00 2026');
  assert.deepEqual(runs[0]!.args, ['-o', 'lstart=', '-p', '4242']);
  assert.equal(runs[0]!.env?.LC_ALL, 'C');
  assert.deepEqual(parseServerLock(text, linux), { pid: 4242, started: 'Sat Oct 10 09:00:00 2026' });
  assert.equal(
    serverLockHeld(text, linux, () => true),
    true,
  );
  started = 'Sun Oct 11 08:00:00 2026';
  assert.equal(
    serverLockHeld(text, linux, () => true),
    false,
    'same PID, another process',
  );
  assert.equal(
    serverLockHeld(text, linux, () => false),
    false,
  );
  assert.equal(
    serverLockHeld('4242', linux, () => true),
    true,
    'an older lock without a start time',
  );
  const noPs = fakeHost('darwin');
  assert.equal(processStartTime(4242, noPs), undefined);
  assert.equal(
    serverLockHeld(text, noPs, () => true),
    true,
    'unknown start time: stay careful',
  );
  assert.equal(serverLockText(4242, noPs), '4242');
});

for (const platform of ['linux', 'darwin'] as const)
  test(`backend local-time lock remains held under a non-UTC TZ on ${platform}`, () => {
    const localStart = 'Thu Oct 29 07:00:00 2026';
    const host = fakeHost(platform, {
      env: { TZ: 'EST5' },
      runSync: (_file, _args, options) =>
        options?.env?.TZ === 'UTC0' ? 'Thu Oct 29 12:00:00 2026\n' : `${localStart}\n`,
    });
    const oldLock = `4242\n${localStart}`;
    assert.equal(
      serverLockHeld(oldLock, host, () => true),
      true,
    );
    assert.equal(serverLockText(4242, host), oldLock);
    assert.equal(host.env.TZ, 'EST5');
  });

test('copy, tools and capabilities name each platform correctly', () => {
  const mac = bridgeWording(fakeHost('darwin'));
  const linux = bridgeWording(fakeHost('linux'));
  assert.equal(mac.trash, '废纸篓');
  assert.equal(mac.moveToSystemTrash, '移到废纸篓');
  assert.equal(mac.folderExample, '/Users/名字/Downloads');
  assert.equal(linux.folderExample, '/home/名字/Downloads');
  assert.equal(linux.pageExample, 'file:///home/名字/site/index.html');
  const recycle = recycleToolFor(mac);
  assert.match(recycle.description, /移到废纸篓（可恢复/);
  assert.doesNotMatch(recycle.description, /Windows|回收站/);
  assert.equal(recycle.annotations.title, '移到废纸篓');
  const organize = organizeToolsFor(linux)[0]!;
  assert.match(organize.inputSchema.properties.moves!.description, /to 以 \/ 结尾/);
  assert.match(organize.description, /移到回收站（recycle/);
  assert.deepEqual(piWritableTools(fakeHost('darwin')), ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash']);
  assert.deepEqual(piWritableTools(fakeHost('linux')), ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash']);
  assert.deepEqual(revealCommand('/Users/me/a.txt', false, fakeHost('darwin')), {
    command: 'open',
    args: ['-R', '/Users/me/a.txt'],
  });
  assert.deepEqual(revealCommand('/Users/me', true, fakeHost('darwin')), { command: 'open', args: ['/Users/me'] });
  assert.deepEqual(revealCommand('/home/me/a.txt', false, fakeHost('linux')), {
    command: 'xdg-open',
    args: ['/home/me'],
  });
  assert.deepEqual(capabilities(fakeHost('darwin')), {
    trash: true,
    accountLogin: true,
    gpu: true,
    shortcuts: true,
  });
  assert.equal(capabilities(fakeHost('linux')).trash, true);
  assert.equal(capabilities({ ...fakeHost('linux'), platform: 'freebsd' }).trash, false);
});
