import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { downloadVerifiedFile, validateArchiveEntries, validateArchiveTypes } from '../scripts/model-download.mjs';
import { runtimeDirectories, runtimeRoot } from '../scripts/runtime-paths.mjs';
import { ToolInstallations } from '../src/server/tool-installations.ts';
import { runToolInstaller } from '../src/server/tool-installer.ts';

const scratch = () => mkdtempSync(join(tmpdir(), 'pugport-installer-'));
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
test('packaged downloads live outside the program folder while legacy model locations stay readable', () => {
  // Windows rules (win32 paths on every system); macOS and Linux are in platform-posix.test.ts.
  const app = win32.join(tmpdir(), 'installed', 'resources', 'app');
  const local = win32.join(tmpdir(), 'user-cache');
  assert.equal(runtimeRoot(app, { LOCALAPPDATA: local }, 'win32'), win32.join(local, 'PugPort', 'runtime'));
  assert.deepEqual(runtimeDirectories(app, 'voice', { LOCALAPPDATA: local }, 'win32'), [
    win32.join(local, 'PugPort', 'runtime', 'voice'),
    win32.join(app, '.runtime', 'voice'),
    win32.join(app, '..', 'voice'),
  ]);
  assert.equal(runtimeRoot(join(tmpdir(), 'development'), {}), join(tmpdir(), 'development', '.runtime'));
  assert.throws(() => runtimeRoot(app, { PUGPORT_RUNTIME_DIR: './relative' }), /absolute/);
});

test('failed or interrupted downloads never publish a model; verified retries replace corrupt files', async (t) => {
  const root = scratch();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'model.onnx');
  const broken = (async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('partial'));
          controller.error(new Error('interrupted'));
        },
      }),
    )) as typeof fetch;
  await assert.rejects(
    downloadVerifiedFile(target, ['https://fixture.invalid/model'], hash('correct'), { fetchImpl: broken }),
    /interrupted/,
  );
  assert.equal(existsSync(target), false);
  assert.deepEqual(readdirSync(root), []);
  const response = (async () => new Response('incorrect')) as typeof fetch;
  await assert.rejects(
    downloadVerifiedFile(target, ['https://fixture.invalid/model'], hash('correct'), { fetchImpl: response }),
    /checksum/,
  );
  assert.equal(existsSync(target), false);
  writeFileSync(target, 'old-corrupt');
  await downloadVerifiedFile(target, ['https://fixture.invalid/model'], hash('correct'), {
    fetchImpl: (async () => new Response('correct')) as typeof fetch,
  });
  assert.equal(readFileSync(target, 'utf8'), 'correct');
  assert.deepEqual(readdirSync(root), ['model.onnx']);
});

test('component archives reject absolute paths, traversal and Windows separators', () => {
  validateArchiveEntries(['voice/', 'voice/model.onnx', 'voice/tokens.txt']);
  for (const entry of ['../outside', '/outside', 'C:/outside', 'voice/../../outside', 'voice\\..\\outside'])
    assert.throws(() => validateArchiveEntries([entry]), /Unsafe/);
  validateArchiveTypes('-rw-r--r-- user group 12 Jan 1 model.onnx\ndrwxr-xr-x user group 0 Jan 1 voice/');
  for (const listing of [
    'lrwxr-xr-x user group 2 Jan 1 model.onnx -> /outside',
    'hrw-r--r-- user group 2 Jan 1 model.onnx link to /outside',
  ])
    assert.throws(() => validateArchiveTypes(listing), /Links/);
});

test('safe archive validation accepts the platform tar listing and preserves selected filenames', (t) => {
  const root = scratch();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'voice');
  mkdirSync(source);
  writeFileSync(join(source, 'model.onnx'), 'model');
  writeFileSync(join(source, 'tokens.txt'), 'tokens');
  const archive = join(root, 'model.tar.bz2');
  const tar =
    process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-cjf', archive, '-C', root, 'voice'], { windowsHide: true });
  const entries = execFileSync(tar, ['-tjf', archive], { encoding: 'utf8', windowsHide: true })
    .split(/\r?\n/)
    .filter(Boolean);
  validateArchiveEntries(entries);
  validateArchiveTypes(execFileSync(tar, ['-tvjf', archive], { encoding: 'utf8', windowsHide: true }));
  assert.ok(entries.includes('voice/model.onnx'));
});

test('corrupt installation history is preserved without preventing app startup', (t) => {
  const root = scratch();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'tool-installations.json'), '{broken');
  const manager = new ToolInstallations(root, root, async () => 'Installed');
  assert.deepEqual(manager.list(), []);
  assert.equal(readdirSync(root).filter((name) => name.startsWith('tool-installations.json.corrupt-')).length, 1);
  manager.close();
});

test('removed component records are ignored while voice history is kept without a corrupt rename', (t) => {
  const root = scratch();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'tool-installations.json');
  const now = '2026-10-14T00:00:00.000Z';
  const jobs = ['everything', 'embeddinggemma', 'voice'].map((tool) => ({
    id: `synthetic-${tool}`,
    tool,
    status: 'completed',
    phase: 'completed',
    message: 'Synthetic installation history',
    startedAt: now,
    updatedAt: now,
    finishedAt: now,
  }));
  writeFileSync(file, JSON.stringify(jobs));
  const manager = new ToolInstallations(root, root, async () => {
    assert.fail('loading history must not run an installer');
  });
  t.after(() => manager.close());
  assert.deepEqual(manager.list(), [jobs[2]]);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), [jobs[2]]);
  assert.deepEqual(readdirSync(root), ['tool-installations.json']);
});

test('failed status writes do not leave phantom running jobs or stop app shutdown', async (t) => {
  const root = scratch();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let runs = 0;
  const manager = new ToolInstallations(root, root, async (_tool, progress) => {
    runs++;
    mkdirSync(join(root, 'tool-installations.json.tmp'));
    progress({ phase: 'verifying', message: 'Checking' });
    return 'Installed';
  });
  const temporary = join(root, 'tool-installations.json.tmp');
  mkdirSync(temporary);
  assert.throws(() => manager.start('voice'));
  assert.deepEqual(manager.list(), []);
  assert.equal(runs, 0);
  rmSync(temporary, { recursive: true });
  const job = manager.start('voice');
  assert.equal((await manager.wait(job.id))?.status, 'completed');
  assert.doesNotThrow(() => manager.close());
});

test('installation jobs survive reloads, share one running task, and a retry gets a new attempt', async (t) => {
  const root = scratch();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let runs = 0;
  let finish!: () => void;
  const manager = new ToolInstallations(root, root, async (_tool, progress) => {
    runs++;
    progress({ phase: 'downloading', message: 'Downloading fixture', receivedBytes: 1, totalBytes: 3 });
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return 'Installed';
  });
  const job = manager.start('voice');
  assert.equal(manager.start('voice').id, job.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs, 1);
  const restored = new ToolInstallations(root, root, async () => 'Retry completed');
  assert.equal(restored.list()[0]?.status, 'interrupted');
  const retry = restored.start('voice');
  assert.notEqual(retry.id, job.id);
  assert.equal((await restored.wait(retry.id))?.status, 'completed');
  manager.close();
  finish();
  await manager.wait(job.id);
  assert.equal(manager.list()[0]?.status, 'interrupted');
});

test('real fixture installer process is single-flight and zero exit without files is not success', async (t) => {
  const root = scratch();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  writeFileSync(
    join(root, 'scripts', 'setup-voice.mjs'),
    "import{mkdirSync,writeFileSync,appendFileSync}from'node:fs';import{join}from'node:path';appendFileSync('runs.txt','run\\n');await new Promise(r=>setTimeout(r,150));let p=join(process.env.PUGPORT_RUNTIME_DIR,'voice','sense-voice');mkdirSync(p,{recursive:true});writeFileSync(join(p,'model.int8.onnx'),'model');writeFileSync(join(p,'tokens.txt'),'tokens');",
  );
  const one = runToolInstaller(root, 'voice');
  const two = runToolInstaller(root, 'voice');
  assert.equal(one, two);
  await Promise.all([one, two]);
  assert.equal(readFileSync(join(root, 'runs.txt'), 'utf8'), 'run\n');
  writeFileSync(join(root, 'scripts', 'setup-memory-search.mjs'), "console.log('Nothing installed');");
  await assert.rejects(runToolInstaller(root, 'memory-search'), /不完整/);
});

test('MarkItDown installer locks every package to wheel SHA-256 digests and aborts on hash mismatch', async (t) => {
  const root = scratch();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { cleanPipEnv, installMarkitdown, markitdownPipArguments, markitdownRequirements } = (await import(
    pathToFileURL(join(import.meta.dirname, '..', 'scripts', 'setup-markitdown.mjs')).href
  )) as {
    cleanPipEnv: (base?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
    installMarkitdown: (options?: {
      root?: string;
      venv?: string;
      venvPython?: string;
      run?: (command: string, args: string[]) => { status: number | null; stdout: string; stderr: string };
      spawnPip?: (command: string, args: string[]) => { status: number | null };
    }) => void;
    markitdownPipArguments: (requirementsPath: string) => string[];
    markitdownRequirements: string;
  };
  assert.equal(typeof markitdownRequirements, 'string');
  assert.match(
    markitdownRequirements,
    /cryptography==46\.0\.5; sys_platform == "darwin" and platform_machine == "x86_64"/,
  );
  assert.match(
    markitdownRequirements,
    /cryptography==50\.0\.2; sys_platform != "darwin" or platform_machine != "x86_64"/,
  );
  assert.match(markitdownRequirements, /4e81d95e5bafc2d6e34e4bed780e53e4d5b9a2f928573428aa4d35fbec1eb0de/);
  assert.match(markitdownRequirements, /0ec5f09541743261e66e291b4a0cbf0fb2997aeaab6d9e9c740b9dba1b58d1c2/);
  const blocks = markitdownRequirements
    .trim()
    .split(/\n(?=[A-Za-z0-9_.-]+==)/)
    .map((block) => block.trim())
    .filter(Boolean);
  assert.ok(blocks.length >= 40, 'all direct and transitive packages must be locked');
  const names = new Set<string>();
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((line) => line.replace(/\\$/, '').trim());
    const match = /^([A-Za-z0-9_.-]+)==[^\s;]+/.exec(lines[0] ?? '');
    assert.ok(match, `unpinned requirement line: ${lines[0]}`);
    names.add(match[1]!.toLowerCase().replace(/[-_.]+/g, '-'));
    const hashes = lines.slice(1);
    assert.ok(hashes.length >= 1, `missing hashes for ${lines[0]}`);
    for (const digest of hashes) assert.match(digest, /^--hash=sha256:[a-f0-9]{64}$/);
  }
  for (const expected of [
    'markitdown',
    'beautifulsoup4',
    'charset-normalizer',
    'defusedxml',
    'magika',
    'markdownify',
    'requests',
    'lxml',
    'mammoth',
    'olefile',
    'openpyxl',
    'pandas',
    'pdfminer-six',
    'pdfplumber',
    'python-pptx',
    'xlrd',
    'onnxruntime',
    'cryptography',
    'pillow',
    'pypdfium2',
  ])
    assert.ok(names.has(expected), `missing locked dependency ${expected}`);

  const args = markitdownPipArguments('/tmp/requirements.txt');
  assert.ok(!args.includes('--isolated'));
  assert.ok(!args.includes('--index-url'));
  assert.ok(args.includes('--require-hashes'));
  assert.ok(args.includes('--no-deps'));
  assert.ok(args.includes('--only-binary'));
  assert.ok(args.includes(':all:'));

  const env = cleanPipEnv({
    PATH: process.env.PATH,
    PIP_INDEX_URL: 'https://evil.invalid/simple',
    PIP_EXTRA_INDEX_URL: 'https://evil.invalid/extra',
    PIP_CONFIG_FILE: '/tmp/evil.conf',
    REQUESTS_CA_BUNDLE: '/tmp/company-ca.pem',
    PYTHONPATH: '/tmp/evil',
  });
  assert.equal(env.PIP_INDEX_URL, 'https://evil.invalid/simple');
  assert.equal(env.PIP_EXTRA_INDEX_URL, 'https://evil.invalid/extra');
  assert.equal(env.PIP_CONFIG_FILE, '/tmp/evil.conf');
  assert.equal(env.REQUESTS_CA_BUNDLE, '/tmp/company-ca.pem');
  assert.equal(env.PYTHONPATH, undefined);

  const venv = join(root, 'markitdown');
  const venvPython = join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  mkdirSync(join(venv, process.platform === 'win32' ? 'Scripts' : 'bin'), { recursive: true });
  writeFileSync(venvPython, 'synthetic');
  writeFileSync(join(venv, '.pugport-ready'), 'stale');
  let executedMarkitdown = false;
  let capturedPipArgs: string[] = [];
  let requirementsSnapshot = '';
  assert.throws(() =>
    installMarkitdown({
      root,
      venv,
      venvPython,
      run(_command, cmdArgs) {
        if (cmdArgs[0] === '-m' && cmdArgs[1] === 'markitdown') executedMarkitdown = true;
        return { status: 0, stdout: '', stderr: '' };
      },
      spawnPip(_command, pipArgs) {
        capturedPipArgs = pipArgs;
        const reqIndex = pipArgs.indexOf('-r');
        if (reqIndex !== -1 && pipArgs[reqIndex + 1]) {
          requirementsSnapshot = readFileSync(pipArgs[reqIndex + 1]!, 'utf8');
        }
        return { status: 1 };
      },
    }),
  );
  assert.ok(capturedPipArgs.includes('--require-hashes'));
  assert.ok(capturedPipArgs.includes('--no-deps'));
  assert.match(requirementsSnapshot, /markitdown==0\.1\.8/);
  assert.equal(executedMarkitdown, false, 'failed hash verification must never execute markitdown');
  assert.equal(existsSync(join(venv, '.pugport-ready')), false, 'ready marker must not remain after failed install');
});
