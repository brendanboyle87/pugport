import { productionPaths } from './helpers/production-paths.ts';
import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as fixtureFs from 'node:fs/promises';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { after, test } from 'node:test';
import {
  findDuplicates,
  canonicalProtectedReason,
  formatBytes,
  organizeFiles,
  protectedReason,
  summarizeFolder,
  undoOrganize,
} from '../src/server/file-manager.ts';
import { dateRange, exifCaptureTime, inRange, parseExifDate } from '../src/server/photo-date.ts';
import { electronModule } from './helpers/electron-harness.ts';
import { currentHost } from '../src/server/platform/host.ts';
import { appDirs } from '../src/server/platform/dirs.ts';
import { fakeHost } from './helpers/fake-host.ts';

// Normalize Windows short TEMP paths without resolving the aliases each test creates below.
const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'comborunner-files-')));
const fixtureHome = join(scratch, 'home');
mkdirSync(fixtureHome);
const homeKeys = [
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'GROK_HOME',
  'GEMINI_CLI_HOME',
  'COMBORUNNER_DATA_DIR',
  'AGENT_STUDIO_DATA_DIR',
];
const previousHome = homeKeys.map((key) => [key, process.env[key]] as const);
for (const key of homeKeys) delete process.env[key];
process.env.HOME = process.env.USERPROFILE = fixtureHome;
after(() => {
  for (const [key, value] of previousHome)
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});
process.env.COMBORUNNER_FILE_MOVES_DIR = join(scratch, 'journals');
after(() => rmSync(scratch, { recursive: true, force: true }));
// An app folder without Everything: listings walk the folder.
const appRoot = join(scratch, 'app');
mkdirSync(appRoot);

test('file protection follows source location files outside the repo', () => {
  const root = mkdtempSync(join(scratch, 'relocated-app-'));
  const target = mkdtempSync(join(scratch, 'relocated-data-'));
  writeFileSync(join(target, 'studio.sqlite'), 'synthetic');
  mkdirSync(join(root, '.data'));
  writeFileSync(join(root, '.data/data-location.json'), JSON.stringify({ dataDir: target }));
  assert.match(
    productionPaths(() =>
      protectedReason(join(target, 'accounts.json'), 'from', root, currentHost(), { allowedRoots: [scratch] }),
    )!,
    /应用数据/,
  );
});

test('private login folders outside the project refuse recycle, move and new destinations', async () => {
  const home = tree('private-home', {
    '.codex/auth.json': 'synthetic',
    '.ssh/key': 'synthetic',
    '.claude/config.json': 'synthetic',
    '.claude.json': 'synthetic',
    '.agents/skills/example/SKILL.md': 'synthetic',
    '.aws/config': 'synthetic',
    '.azure/config': 'synthetic',
    '.kube/config': 'synthetic',
    '.docker/config.json': 'synthetic',
    '.gnupg/key': 'synthetic',
    '.config/gh/hosts.yml': 'synthetic',
    '.git-credentials': 'synthetic',
    'custom-codex/auth.json': 'synthetic',
    'custom-claude/config.json': 'synthetic',
    'input.txt': 'ordinary',
  });
  const project = tree('private-project', { 'file.txt': 'synthetic' });
  const api = await electronModule(
    'src/server/file-manager.ts',
    {},
    {
      process: {
        platform: process.platform,
        env: { CODEX_HOME: join(home, 'custom-codex'), CLAUDE_CONFIG_DIR: join(home, 'custom-claude') },
        cwd: () => project,
      },
    },
    {
      'node:os': `export const homedir=()=>${JSON.stringify(home)}; export const tmpdir=()=>${JSON.stringify(scratch)};`,
      './recycle-bin.ts': `export const maxRecyclePaths=200; export async function moveToRecycleBin() { throw new Error('must not reach trash'); }`,
    },
  );
  for (const name of [
    '.codex',
    '.claude',
    '.agents',
    '.ssh',
    '.aws',
    '.azure',
    '.kube',
    '.docker',
    '.gnupg',
    '.config/gh',
    '.git-credentials',
    'custom-codex',
    'custom-claude',
  ]) {
    const folder = join(home, name);
    for (const args of [
      { recycle: [folder] },
      { moves: [{ from: folder, to: join(project, name) }] },
      { moves: [{ from: join(home, 'input.txt'), to: join(folder, 'new.txt') }] },
    ]) {
      const result = await api.organizeFiles(args, { recycle: true, allowedRoots: [project] });
      assert.equal(result.receipt.succeeded, 0);
      assert.equal(result.receipt.failed, 1);
      assert.match(result.text, /应用数据或账号文件夹/);
      assert.equal(existsSync(folder), true);
    }
    if (name === '.git-credentials') continue;
    const alias = join(home, `alias-${name.replaceAll('/', '-')}`);
    symlinkSync(folder, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.match(
      await api.canonicalProtectedReason(alias, 'from', undefined, undefined, { allowedRoots: [project] }),
      /应用数据或账号文件夹/,
    );
  }
  const result = await api.organizeFiles(
    { moves: [{ from: join(home, 'input.txt'), to: join(home, '.claude.json') }] },
    { recycle: true, allowedRoots: [project] },
  );
  assert.equal(result.receipt.succeeded, 0);
});

test('organize refuses UNC sources, destinations and recycle before filesystem access outside allowed roots', async () => {
  const project = tree('unc-project', { 'input.txt': 'synthetic' });
  const api = await electronModule(
    'src/server/file-manager.ts',
    {},
    {
      fixtureFs,
    },
    {
      'node:fs/promises': `
      export const { cp, link, mkdir, open, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } = globalThis.fixtureFs;
      export const lstat = (path) => {
        if (path.charCodeAt(0) === 92) throw new Error('must not inspect UNC');
        return globalThis.fixtureFs.lstat(path);
      };
      export const realpath = (path) => {
        if (path.charCodeAt(0) === 92) throw new Error('must not resolve UNC');
        return globalThis.fixtureFs.realpath(path);
      };
    `,
    },
  );
  for (const path of [String.raw`\\nas\share\file.txt`, String.raw`\\localhost\C$\fixture\file.txt`]) {
    for (const args of [
      { moves: [{ from: path, to: join(project, 'output.txt') }] },
      { moves: [{ from: join(project, 'input.txt'), to: path }] },
      { recycle: [path] },
    ]) {
      const result = await api.organizeFiles(args, { recycle: true, allowedRoots: [project] });
      assert.equal(result.receipt.succeeded, 0);
      assert.equal(result.receipt.failed, 1);
      assert.match(result.text, process.platform === 'win32' ? /网络路径不在当前项目目录内/ : /完整路径/);
    }
    const host = fakeHost('win32');
    assert.equal(
      protectedReason(path, 'from', undefined, host, { allowedRoots: [host.path.dirname(path)] }),
      undefined,
    );
    assert.match(protectedReason(path, 'from', undefined, host, { allowedRoots: [path + '-other'] })!, /网络路径/);
  }
});

function tree(name: string, files: Record<string, string | Buffer>) {
  const root = join(scratch, name);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

test('a folder summary counts by type and shows what takes the space', async () => {
  const root = tree('summary', {
    'photos/a.jpg': Buffer.alloc(5000),
    'photos/b.png': Buffer.alloc(3000),
    'setup.exe': Buffer.alloc(20000),
    'notes/plan.docx': Buffer.alloc(1000),
    'old.zip': Buffer.alloc(100),
  });
  const twoYearsAgo = Date.now() / 1000 - 2 * 365 * 86_400;
  utimesSync(join(root, 'old.zip'), twoYearsAgo, twoYearsAgo);
  const text = await summarizeFolder({ folder: root });
  assert.match(text, /共 5 个文件/);
  assert.match(text, /- 安装程序：1 个，19\.5 KB[\s\S]*- 图片：2 个，7\.8 KB/);
  assert.match(text, /photos：2 个文件/);
  assert.match(text, /setup\.exe（19\.5 KB/);
  assert.match(text, /一年以上没改动过的文件：1 个/);
  await assert.rejects(summarizeFolder({ folder: 'relative' }), /完整路径/);
  assert.equal(formatBytes(1536), '1.5 KB');
});

test('duplicates are confirmed byte by byte, and the oldest copy is kept', async () => {
  const same = Buffer.alloc(200 * 1024, 7);
  const sameEnds = Buffer.alloc(200 * 1024, 7);
  sameEnds[100 * 1024] = 1; // Same size, same first and last 64 KB, different middle.
  const root = tree('dupes', {
    'downloads/clip.mp4': same,
    'sorted/blogger/clip.mp4': same,
    'sorted/other/clip copy.mp4': same,
    'sorted/near.mp4': sameEnds,
    'small/a.txt': 'tiny',
    'small/b.txt': 'tiny',
  });
  const old = Date.now() / 1000 - 86_400;
  utimesSync(join(root, 'sorted', 'blogger', 'clip.mp4'), old, old);
  const text = await findDuplicates({ folders: [root] });
  assert.match(text, /找到 1 组/);
  assert.match(text, /- 保留：.*blogger.clip\.mp4/);
  assert.equal((text.match(/- 副本/g) ?? []).length, 2);
  assert.doesNotMatch(text, /near\.mp4|a\.txt/);
  assert.match(text, /400\.0 KB|400 KB/);
  const images = await findDuplicates({ folders: [root], kind: 'images' });
  assert.match(images, /没有找到/);
});

test('tidying moves and renames with a record, never overwrites, and undo puts everything back', async () => {
  const root = tree('tidy', {
    'inbox/one.jpg': 'one',
    'inbox/two.mp4': 'two',
    'inbox/notes.txt': 'notes',
    'sorted/photos/one.jpg': 'an older one',
  });
  const result = await organizeFiles(
    {
      moves: [
        { from: join(root, 'inbox', 'one.jpg'), to: join(root, 'sorted', 'photos') + sep },
        { from: join(root, 'inbox', 'two.mp4'), to: join(root, 'sorted', 'videos', '2024') + sep },
        { from: join(root, 'inbox', 'notes.txt'), to: join(root, 'inbox', 'renamed.txt') },
        { from: join(root, 'inbox', 'missing.txt'), to: join(root, 'x') + sep },
        { from: join(root, 'inbox'), to: join(root, 'inbox', 'inside') + sep },
      ],
    },
    { conversationId: 'c1', recycle: false },
  );
  assert.match(result.text, /已移动或改名 3 项/);
  assert.match(result.text, /missing\.txt：不存在/);
  assert.match(result.text, /不能移到它自己里面/);
  // The existing photo is kept; the new one gets a free name.
  assert.equal(readFileSync(join(root, 'sorted', 'photos', 'one.jpg'), 'utf8'), 'an older one');
  assert.equal(readFileSync(join(root, 'sorted', 'photos', 'one (2).jpg'), 'utf8'), 'one');
  assert.ok(existsSync(join(root, 'sorted', 'videos', '2024', 'two.mp4')));
  assert.ok(existsSync(join(root, 'inbox', 'renamed.txt')));
  await assert.rejects(
    organizeFiles({ recycle: [join(root, 'inbox', 'renamed.txt')] }, { recycle: false }),
    /不能删除文件/,
  );

  const undone = await undoOrganize({}, { conversationId: 'c1' });
  assert.match(undone, /移回 3 项/);
  assert.equal(readFileSync(join(root, 'inbox', 'one.jpg'), 'utf8'), 'one');
  assert.ok(existsSync(join(root, 'inbox', 'two.mp4')));
  assert.ok(existsSync(join(root, 'inbox', 'notes.txt')));
  // Folders the tidy-up made are gone again; the ones that were there stay.
  assert.equal(existsSync(join(root, 'sorted', 'videos')), false);
  assert.ok(existsSync(join(root, 'sorted', 'photos', 'one.jpg')));
  assert.match(await undoOrganize({ id: result.journal!.id }, {}), /已经.*撤销过/);
  await assert.rejects(undoOrganize({}, { conversationId: 'c1' }), /没有可以撤销/);
});

test('system folders, app data and the user’s main folders themselves cannot be moved', () => {
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    const host = fakeHost(platform);
    const system = platform === 'win32' ? 'C:\\Windows' : platform === 'darwin' ? '/System' : '/usr';
    const appData = platform === 'win32' ? 'AppData' : platform === 'darwin' ? 'Library' : '.config';
    assert.match(protectedReason(host.path.join(system, 'protected-file'), 'from', undefined, host)!, /系统/);
    assert.match(protectedReason(host.path.join(host.home, appData, 'fixture'), 'to', undefined, host)!, /应用数据/);
  }
  assert.match(protectedReason(join(homedir(), 'Downloads'), 'from')!, /系统文件夹本身/);
  assert.match(protectedReason(homedir(), 'from')!, /整个磁盘或用户文件夹/);
  assert.equal(protectedReason(join(homedir(), 'Downloads', 'a.zip'), 'from'), undefined);
  assert.equal(protectedReason(join(homedir(), 'Pictures'), 'to'), undefined);
  assert.match(protectedReason(join(scratch, 'app', 'x'), 'from', appRoot)!, /应用/);
});

test('project exemptions only bypass the app root, retaining data, account, Git and system protections', async () => {
  const app = tree('project-exemption', { 'repo/file.txt': 'synthetic', '.claude/worktrees/x/file.txt': 'synthetic' });
  const host = currentHost();
  for (const project of [join(app, 'repo'), join(app, '.claude', 'worktrees', 'x')]) {
    const options = { allowedRoots: [project], dataDir: join(project, 'private-accounts') };
    const file = join(project, 'file.txt');
    assert.match(protectedReason(file, 'from', app)!, /应用/);
    assert.equal(protectedReason(file, 'from', app, host, options), undefined);
    assert.equal(await canonicalProtectedReason(file, 'from', app, undefined, options), undefined);
    for (const name of ['.data/accounts', '.git', 'private-accounts/secrets']) {
      const folder = join(project, name);
      mkdirSync(folder, { recursive: true });
      assert.match((await canonicalProtectedReason(folder, 'from', app, undefined, options))!, /应用|Git/);
    }
    assert.match((await canonicalProtectedReason(project, 'from', app, undefined, options))!, /应用|Git|链接/);
    assert.match(protectedReason(join(app, 'outside.txt'), 'from', app, host, options)!, /应用/);
    assert.equal(protectedReason(join(scratch, 'ordinary.txt'), 'from', app, host, options), undefined);
    const outsideGit = join(scratch, 'outside-project', '.git', 'config');
    assert.equal(protectedReason(outsideGit, 'from', app, host, options), protectedReason(outsideGit, 'from', app));
  }
  const fakeHost = {
    ...host,
    env: { ...host.env, LOCALAPPDATA: join(app, 'local'), CODEX_HOME: join(app, 'account-home') },
  };
  for (const folder of [appDirs(fakeHost).secrets, fakeHost.env.CODEX_HOME]) {
    assert.match(
      protectedReason(join(folder, 'file.txt'), 'from', app, fakeHost, { allowedRoots: [app] })!,
      /应用数据或账号/,
    );
  }
  const system =
    process.platform === 'win32'
      ? process.env.SystemRoot || 'C:\\Windows'
      : process.platform === 'darwin'
        ? '/System'
        : '/usr';
  assert.match(
    protectedReason(join(system, 'System32', 'x.dll'), 'from', system, host, { allowedRoots: [system] })!,
    /系统/,
  );
});

test('project exemptions refuse synthetic leaf, parent and contained junctions without resolving their targets', async () => {
  const project = tree('project-exemption-links', { 'physical/file.txt': 'synthetic' });
  const folder = join(project, 'with-link');
  mkdirSync(folder);
  const link = join(folder, '.runtime');
  mkdirSync(link);
  const mocks = {
    'node:fs/promises': `const fs = globalThis.fixtureFs;
      export const cp=fs.cp,link=fs.link,lstat=fs.lstat,mkdir=fs.mkdir,open=fs.open,readdir=fs.readdir,readFile=fs.readFile,realpath=fs.realpath,rename=fs.rename,rm=fs.rm,rmdir=fs.rmdir,stat=fs.stat,unlink=fs.unlink,writeFile=fs.writeFile;`,
  };
  const globals = {
    fixtureFs: {
      ...fixtureFs,
      lstat: async (path: string) => (path === link ? { isSymbolicLink: () => true } : fixtureFs.lstat(path)),
      realpath: async (path: string) => {
        assert.ok(path !== link && !path.startsWith(link + sep), 'never resolve a junction target');
        return fixtureFs.realpath(path);
      },
    },
  };
  const api = await electronModule('src/server/file-manager.ts', {}, globals, mocks);
  const recycle = await electronModule('src/server/recycle-bin.ts', {}, globals, mocks);
  for (const path of [link, join(link, 'file.txt'), folder])
    assert.match(
      (await api.canonicalProtectedReason(path, 'from', project, undefined, { allowedRoots: [project] }))!,
      /链接或目录联接/,
    );
  for (const path of [link, folder]) {
    const result = await recycle.recyclablePaths(project, [path]);
    assert.equal(result.paths.length, 0);
    assert.match(result.failed[0].reason, /链接或目录联接/);
  }
});

test('concurrent tidy calls preserve same-name files, and both journals can be undone', async () => {
  const root = tree('concurrent', { 'a/report.txt': 'first', 'b/report.txt': 'second' });
  const results = await Promise.all(
    ['a', 'b'].map((name) =>
      organizeFiles(
        { moves: [{ from: join(root, name, 'report.txt'), to: join(root, 'out', 'report.txt') }] },
        { recycle: false },
      ),
    ),
  );
  assert.equal(new Set(results.map((r) => r.journal!.moves[0]!.to)).size, 2);
  assert.deepEqual(
    results.map((r) => readFileSync(r.journal!.moves[0]!.to, 'utf8')),
    ['first', 'second'],
  );
  await Promise.all(results.map((r) => undoOrganize({ id: r.journal!.id }, {})));
  assert.equal(readFileSync(join(root, 'a', 'report.txt'), 'utf8'), 'first');
  assert.equal(readFileSync(join(root, 'b', 'report.txt'), 'utf8'), 'second');
});

test('protected physical paths are blocked through intermediate junctions, including new targets and recycling', async () => {
  const root = tree('junction-guard', { 'protected/secret.txt': 'safe', 'in/input.txt': 'input' });
  const protectedRoot = join(root, 'protected');
  const alias = join(root, 'alias');
  symlinkSync(protectedRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await organizeFiles(
    {
      moves: [
        { from: join(alias, 'secret.txt'), to: join(root, 'leak.txt') },
        { from: join(root, 'in', 'input.txt'), to: join(alias, 'new', 'input.txt') },
      ],
      recycle: [join(alias, 'secret.txt')],
    },
    { appRoot: protectedRoot, recycle: true },
  );
  assert.match(result.text, /没有改动任何文件[\s\S]*没有处理的 3 项/);
  assert.equal(readFileSync(join(protectedRoot, 'secret.txt'), 'utf8'), 'safe');
  assert.ok(existsSync(join(root, 'in', 'input.txt')));
  assert.equal(existsSync(join(protectedRoot, 'new')), false);
  assert.match((await canonicalProtectedReason(join(protectedRoot, 'secret.txt'), 'from', alias))!, /应用数据/);
});

test('junction moves record physical paths while undo still checks aliases in legacy journals', async () => {
  const root = tree('junction-undo', { 'physical/input.txt': 'input', 'protected/sentinel.txt': 'safe' });
  const physical = join(root, 'physical');
  const alias = join(root, 'alias');
  const protectedRoot = join(root, 'protected');
  symlinkSync(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await organizeFiles(
    { moves: [{ from: join(alias, 'input.txt'), to: join(root, 'out', 'nested', 'input.txt') }] },
    { appRoot: protectedRoot, recycle: false },
  );
  assert.equal(result.journal!.moves.length, 1);
  assert.equal(result.journal!.moves[0]!.from, join(physical, 'input.txt'));
  // A new journal restores the physical original even if the caller's alias subsequently changes.
  unlinkSync(alias);
  symlinkSync(protectedRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const undone = await undoOrganize({ id: result.journal!.id }, { appRoot: protectedRoot });
  assert.match(undone, /移回 1 项/);
  assert.equal(existsSync(join(protectedRoot, 'input.txt')), false);
  assert.equal(readFileSync(join(physical, 'input.txt'), 'utf8'), 'input');

  // Old journals may still contain lexical aliases; their protection checks remain in force.
  const journal = result.journal!;
  mkdirSync(join(root, 'out', 'nested'), { recursive: true });
  writeFileSync(join(root, 'out', 'nested', 'input.txt'), 'legacy replay');
  journal.moves = [{ from: join(alias, 'input.txt'), to: join(root, 'out', 'nested', 'input.txt') }];
  journal.created = [join(alias, 'empty')];
  delete journal.undoneAt;
  mkdirSync(join(protectedRoot, 'empty'));
  writeFileSync(join(scratch, 'journals', `${journal.id}.json`), JSON.stringify(journal));
  assert.match(await undoOrganize({ id: journal.id }, { appRoot: protectedRoot }), /移回 0 项[\s\S]*应用数据/);
  assert.equal(readFileSync(join(root, 'out', 'nested', 'input.txt'), 'utf8'), 'legacy replay');
  assert.ok(existsSync(join(protectedRoot, 'empty')), 'undo cleanup also guards physical paths');
});

test('moving and undoing a leaf directory link preserves the link and never moves its target', async () => {
  const root = tree('leaf-link', { 'physical/input.txt': 'ordinary synthetic' });
  const physical = join(root, 'physical'),
    leaf = join(root, 'leaf'),
    renamed = join(root, 'renamed-link');
  symlinkSync(physical, leaf, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await organizeFiles({ moves: [{ from: leaf, to: renamed }] }, { recycle: false });
  assert.equal(result.journal!.moves[0]!.from, leaf);
  assert.equal(lstatSync(renamed).isSymbolicLink(), true);
  assert.equal(existsSync(leaf), false);
  assert.equal(readFileSync(join(physical, 'input.txt'), 'utf8'), 'ordinary synthetic');
  assert.match(await undoOrganize({ id: result.journal!.id }, {}), /移回 1 项/);
  assert.equal(lstatSync(leaf).isSymbolicLink(), true);
  assert.equal(existsSync(renamed), false);
  assert.equal(readFileSync(join(physical, 'input.txt'), 'utf8'), 'ordinary synthetic');
});

test('recycling a leaf directory link refuses it before passing its target to the native helper', async () => {
  const root = tree('recycle-leaf-link', { 'physical/input.txt': 'ordinary synthetic' });
  const physical = join(root, 'physical'),
    leaf = join(root, 'shortcut');
  symlinkSync(physical, leaf, process.platform === 'win32' ? 'junction' : 'dir');
  let calls = 0;
  const api = await electronModule(
    'src/server/file-manager.ts',
    {},
    {
      fixtureRecycle: () => {
        calls++;
        return { moved: [], failed: [] };
      },
    },
    {
      './recycle-bin.ts':
        'export const maxRecyclePaths=200; export const moveToRecycleBin=(...args)=>globalThis.fixtureRecycle(...args);',
    },
  );
  const result = await api.organizeFiles({ recycle: [leaf] }, { recycle: true });
  assert.equal(calls, 0);
  assert.equal(result.journal, undefined);
  assert.match(result.text, /链接或目录联接/);
  assert.equal(lstatSync(leaf).isSymbolicLink(), true);
  assert.equal(readFileSync(join(physical, 'input.txt'), 'utf8'), 'ordinary synthetic');
});

test('pinned paths normalize dot segments before choosing the source name and destination parent', async () => {
  const root = tree('normalized-move', { 'source/input.txt': 'ordinary synthetic', 'target/keep.txt': 'keep' });
  const result = await organizeFiles(
    { moves: [{ from: `${join(root, 'source')}${sep}unused${sep}..`, to: `${join(root, 'target')}${sep}.` }] },
    { recycle: false },
  );
  assert.equal(result.journal!.moves[0]!.from, join(root, 'source'));
  assert.equal(result.journal!.moves[0]!.to, join(root, 'target', 'source'));
  assert.equal(readFileSync(join(root, 'target', 'source', 'input.txt'), 'utf8'), 'ordinary synthetic');
  assert.match(await undoOrganize({ id: result.journal!.id }, {}), /移回 1 项/);
  assert.equal(readFileSync(join(root, 'source', 'input.txt'), 'utf8'), 'ordinary synthetic');
});

/** Pure in-memory paths: these aliases never touch Windows junctions or the real Recycle Bin. */
async function aliasMutationFixture() {
  const root = resolve(tmpdir(), 'virtual-comborunner-files'),
    ordinary = join(root, 'ordinary'),
    out = join(root, 'out'),
    protectedRoot = join(root, 'protected-app'),
    sourceAlias = join(root, 'source-alias'),
    targetAlias = join(root, 'target-alias'),
    journal = join(root, 'journals');
  const dirs = new Set([parse(root).root, root, ordinary, out, protectedRoot]);
  const files = new Map([
    [join(ordinary, 'input.txt'), 'ordinary synthetic'],
    [join(protectedRoot, 'input.txt'), 'protected synthetic'],
    [join(out, 'input.txt'), 'older synthetic'],
  ]);
  const aliases = new Map([
    [sourceAlias, ordinary],
    [targetAlias, out],
  ]);
  const effects: Array<{ kind: string; from?: string; to?: string; paths?: string[] }> = [];
  let hook: (kind: string, path: string) => void = () => {};
  const retarget = () => {
    aliases.set(sourceAlias, protectedRoot);
    aliases.set(targetAlias, protectedRoot);
  };
  const physical = (path: string) => {
    path = resolve(path);
    for (const [alias, target] of aliases)
      if (path === alias || path.startsWith(alias + sep)) return resolve(target, path.slice(alias.length + 1));
    return path;
  };
  const missing = () => Object.assign(new Error('synthetic missing'), { code: 'ENOENT' });
  const info = async (path: string) => {
    hook('stat', path);
    const actual = physical(path);
    if (!dirs.has(actual) && !files.has(actual)) throw missing();
    return { isDirectory: () => dirs.has(actual), isFile: () => files.has(actual), isSymbolicLink: () => false };
  };
  const mockFs = {
    stat: info,
    lstat: info,
    realpath: async (path: string) => {
      const actual = physical(path);
      if (!dirs.has(actual) && !files.has(actual)) throw missing();
      return actual;
    },
    link: async (from: string, to: string) => {
      effects.push({ kind: 'link', from, to });
      from = physical(from);
      to = physical(to);
      assert.ok(files.has(from));
      assert.equal(files.has(to), false);
      files.set(to, files.get(from)!);
    },
    unlink: async (path: string) => {
      assert.ok(files.delete(physical(path)));
    },
    mkdir: async (path: string) => {
      hook('mkdir', path);
      dirs.add(physical(path));
      effects.push({ kind: 'mkdir', to: path });
    },
    rmdir: async (path: string) => {
      dirs.delete(physical(path));
    },
    writeFile: async (path: string, text: string) => {
      files.set(physical(path), text);
    },
    rename: async (from: string, to: string) => {
      const contents = files.get(physical(from));
      if (contents === undefined) throw missing();
      files.set(physical(to), contents);
      files.delete(physical(from));
    },
    readFile: async (path: string) => {
      const value = files.get(physical(path));
      if (value === undefined) throw missing();
      return value;
    },
    readdir: async (path: string) =>
      [...files.keys()]
        .filter((file) => dirname(file) === physical(path))
        .map((file) => file.slice(dirname(file).length + 1)),
  };
  const api = await electronModule(
    'src/server/file-manager.ts',
    {},
    {
      fixtureFs: mockFs,
      fixtureRecycle: async (parent: string, paths: string[]) => {
        assert.ok(paths.length <= 200, 'the native Recycle Bin helper accepts at most 200 paths');
        retarget();
        effects.push({ kind: 'recycle', from: parent, paths });
        for (const path of paths) assert.ok(files.delete(physical(path)));
        return { moved: paths, failed: [] };
      },
      process: { platform: process.platform, env: { COMBORUNNER_FILE_MOVES_DIR: journal }, cwd: () => root },
    },
    {
      'node:fs/promises': `const fs = globalThis.fixtureFs;
      export const cp=fs.cp,link=fs.link,lstat=fs.lstat,mkdir=fs.mkdir,open=fs.open,readdir=fs.readdir,readFile=fs.readFile,realpath=fs.realpath,rename=fs.rename,rm=fs.rm,rmdir=fs.rmdir,stat=fs.stat,unlink=fs.unlink,writeFile=fs.writeFile;`,
      'node:os': `export const homedir=()=>${JSON.stringify(join(root, 'home'))}; export const tmpdir=()=>${JSON.stringify(join(root, 'temp'))};`,
      './local-tools.ts': 'export const skippedFoldersBelow=()=>[];',
      './recycle-bin.ts':
        'export const maxRecyclePaths=200; export const moveToRecycleBin=(...args)=>globalThis.fixtureRecycle(...args);',
    },
  );
  return {
    api,
    root,
    ordinary,
    out,
    protectedRoot,
    sourceAlias,
    targetAlias,
    files,
    dirs,
    effects,
    retarget,
    resetAliases: () => {
      aliases.set(sourceAlias, ordinary);
      aliases.set(targetAlias, out);
    },
    setHook: (value: typeof hook) => {
      hook = value;
    },
  };
}

test('large recycle requests are split into native batches without dropping files or the journal', async () => {
  const f = await aliasMutationFixture();
  const paths = Array.from({ length: 401 }, (_, index) => join(f.ordinary, `batch-${index}.txt`));
  for (const path of paths) f.files.set(path, 'synthetic');
  const result = await f.api.organizeFiles({ recycle: paths }, { appRoot: f.protectedRoot, recycle: true });
  assert.deepEqual(
    f.effects.filter((effect) => effect.kind === 'recycle').map((effect) => effect.paths!.length),
    [200, 200, 1],
  );
  assert.deepEqual(Array.from(result.journal.recycled), paths);
  assert.ok(paths.every((path) => !f.files.has(path)));
  assert.equal(f.files.get(join(f.protectedRoot, 'input.txt')), 'protected synthetic');
  assert.match(result.text, /移到回收站 401 项/);
  assert.doesNotMatch(result.text, /没有处理/);
});

test('captured physical paths survive alias retargeting during name reservation and undo mkdir', async () => {
  const f = await aliasMutationFixture();
  let swapped = false;
  f.setHook((kind, path) => {
    if (!swapped && kind === 'stat' && path === join(f.out, 'input.txt')) {
      swapped = true;
      f.retarget();
    }
  });
  const result = await f.api.organizeFiles(
    { moves: [{ from: join(f.sourceAlias, 'input.txt'), to: f.targetAlias }] },
    { appRoot: f.protectedRoot, recycle: false },
  );
  assert.equal(swapped, true);
  assert.equal(f.files.get(join(f.out, 'input (2).txt')), 'ordinary synthetic');
  assert.equal(f.files.get(join(f.protectedRoot, 'input.txt')), 'protected synthetic');
  assert.deepEqual(JSON.parse(JSON.stringify(result.journal.moves)), [
    { from: join(f.ordinary, 'input.txt'), to: join(f.out, 'input (2).txt') },
  ]);
  // Legacy journals can contain aliases too; pin both paths before the undo's first mutation.
  f.resetAliases();
  f.files.set(
    join(f.root, 'journals', `${result.journal.id}.json`),
    JSON.stringify({
      ...result.journal,
      moves: [{ from: join(f.sourceAlias, 'input.txt'), to: join(f.targetAlias, 'input (2).txt') }],
    }),
  );
  f.setHook((kind) => {
    if (kind === 'mkdir') f.retarget();
  });
  assert.match(await f.api.undoOrganize({ id: result.journal.id }, { appRoot: f.protectedRoot }), /移回 1 项/);
  assert.equal(f.files.get(join(f.ordinary, 'input.txt')), 'ordinary synthetic');
  assert.equal(f.files.get(join(f.protectedRoot, 'input.txt')), 'protected synthetic');
});

test('folder creation and recycling use captured physical parents after lexical aliases change', async () => {
  const f = await aliasMutationFixture();
  f.setHook((kind) => {
    if (kind === 'mkdir') f.retarget();
  });
  const moved = await f.api.organizeFiles(
    { moves: [{ from: join(f.sourceAlias, 'input.txt'), to: join(f.targetAlias, 'new', 'input.txt') }] },
    { appRoot: f.protectedRoot, recycle: false },
  );
  assert.equal(f.files.get(join(f.out, 'new', 'input.txt')), 'ordinary synthetic');
  assert.equal(f.dirs.has(join(f.protectedRoot, 'new')), false);
  assert.ok(Array.from(moved.journal.created).includes(join(f.out, 'new')));
  const recycled = await aliasMutationFixture();
  const result = await recycled.api.organizeFiles(
    { recycle: [join(recycled.sourceAlias, 'input.txt')] },
    { appRoot: recycled.protectedRoot, recycle: true },
  );
  const effect = recycled.effects.find((item) => item.kind === 'recycle')!;
  assert.equal(effect.from, recycled.ordinary);
  assert.deepEqual(Array.from(effect.paths!), [join(recycled.ordinary, 'input.txt')]);
  assert.deepEqual(Array.from(result.journal.recycled), [join(recycled.ordinary, 'input.txt')]);
  assert.equal(recycled.files.get(join(recycled.protectedRoot, 'input.txt')), 'protected synthetic');
});

test('moving or recycling a containing directory cannot carry a protected app subtree with it', async () => {
  const root = tree('junction-ancestor', {
    'physical/container/app/sentinel.txt': 'safe',
    'physical/container/user.txt': 'user',
  });
  const app = join(root, 'physical', 'container', 'app');
  const alias = join(root, 'alias');
  symlinkSync(join(root, 'physical'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const source of [join(root, 'physical', 'container'), join(alias, 'container')]) {
    const result = await organizeFiles(
      { moves: [{ from: source, to: join(root, 'out') }], recycle: [source] },
      { appRoot: app, recycle: true },
    );
    assert.equal(result.journal, undefined);
    assert.match(result.text, /没有处理的 2 项/);
    assert.equal(readFileSync(join(app, 'sentinel.txt'), 'utf8'), 'safe');
  }
  // Adding an ordinary file to a containing directory remains permitted.
  const allowed = await organizeFiles(
    { moves: [{ from: join(root, 'physical', 'container', 'user.txt'), to: join(root, 'physical', 'renamed.txt') }] },
    { appRoot: app, recycle: false },
  );
  assert.equal(allowed.journal!.moves.length, 1);
  assert.equal(readFileSync(join(app, 'sentinel.txt'), 'utf8'), 'safe');
});

test('a dot-prefixed child folder remains inside the protected physical app tree', async () => {
  const root = tree('junction-dot-child', {
    'app/..private/sentinel.txt': 'safe',
    'input.txt': 'input',
    'out/replay.txt': 'replay',
  });
  const app = join(root, 'app');
  const alias = join(root, 'alias');
  symlinkSync(app, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await organizeFiles(
    {
      moves: [
        { from: join(alias, '..private', 'sentinel.txt'), to: join(root, 'leak.txt') },
        { from: join(root, 'input.txt'), to: join(alias, '..private', 'new', 'input.txt') },
      ],
      recycle: [join(alias, '..private', 'sentinel.txt')],
    },
    { appRoot: app, recycle: true },
  );
  assert.equal(result.journal, undefined);
  assert.match(result.text, /没有处理的 3 项/);
  assert.equal(readFileSync(join(app, '..private', 'sentinel.txt'), 'utf8'), 'safe');
  assert.equal(existsSync(join(app, '..private', 'new')), false);
  const journal = {
    id: 'dot-replay',
    at: new Date().toISOString(),
    moves: [{ from: join(alias, '..private', 'missing.txt'), to: join(root, 'out', 'replay.txt') }],
    recycled: [],
    created: [],
  };
  writeFileSync(join(scratch, 'journals', `${journal.id}.json`), JSON.stringify(journal));
  assert.match(await undoOrganize({ id: journal.id }, { appRoot: app }), /移回 0 项[\s\S]*应用数据/);
  assert.equal(existsSync(join(app, '..private', 'missing.txt')), false);
});

/** A minimal little-endian EXIF block with DateTimeOriginal in the Exif sub-directory. */
function exifBlock(date: string) {
  const buffer = Buffer.alloc(80);
  buffer.write('Exif\0\0', 0, 'latin1');
  const t = 6;
  buffer.write('II', t, 'latin1');
  buffer.writeUInt16LE(42, t + 2);
  buffer.writeUInt32LE(8, t + 4); // IFD0 at 8
  buffer.writeUInt16LE(1, t + 8); // one entry
  buffer.writeUInt16LE(0x8769, t + 10); // Exif pointer
  buffer.writeUInt16LE(4, t + 12);
  buffer.writeUInt32LE(1, t + 14);
  buffer.writeUInt32LE(26, t + 18); // Exif IFD at 26
  buffer.writeUInt16LE(1, t + 26);
  buffer.writeUInt16LE(0x9003, t + 28);
  buffer.writeUInt16LE(2, t + 30); // ASCII
  buffer.writeUInt32LE(20, t + 32);
  buffer.writeUInt32LE(44, t + 36); // value at 44
  buffer.write(`${date}\0`, t + 44, 'latin1');
  return buffer;
}

test('photo capture dates come from EXIF, and date ranges cover whole years, months or days', () => {
  const taken = exifCaptureTime(exifBlock('2024:07:15 18:30:05'))!;
  assert.equal(taken, Math.floor(new Date(2024, 6, 15, 18, 30, 5).getTime() / 1000));
  assert.equal(exifCaptureTime(exifBlock('0000:00:00 00:00:00')), undefined);
  assert.equal(exifCaptureTime(Buffer.from('not exif at all')), undefined);
  assert.equal(parseExifDate('2099:01:01 00:00:00'), undefined, 'a camera clock set in the future');

  const year = dateRange('2024', undefined)!;
  assert.ok(inRange(taken, year));
  assert.equal(year.label, '2024 以后');
  const july = dateRange('2024-07', '2024-07')!;
  assert.equal(july.label, '2024-07');
  assert.ok(inRange(taken, july));
  assert.ok(!inRange(taken, dateRange('2024-07-16', '2024-12')!));
  assert.ok(inRange(taken, dateRange(undefined, '2024/7/15')!), 'the last day counts in full');
  assert.equal(dateRange(undefined, ''), undefined);
  assert.throws(() => dateRange('last year', undefined), /2024-07/);
  assert.throws(() => dateRange('2024-12', '2024-01'), /晚于/);
});
