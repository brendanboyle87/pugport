import { execFileSync as rawExecFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  underTest,
  testDirectory,
  testPath,
  assertTestProcess,
  UnderTestError,
  testProcessArgs,
  testProcessEnv,
} from '../src/server/platform/under-test.ts';
import { electronArgs } from './helpers/electron-app.cjs';
import { fork, execFileSync } from '../src/server/platform/test-process.ts';
import { appDirs } from '../src/server/platform/dirs.ts';
import { spawnTarget, collectProcessOutput, terminateProcess } from '../src/server/adapters/process.ts';
import { resolveDataLocation } from '../src/shared/data-location.ts';
import { backendPort } from '../src/cli/client.ts';
import { postGrokRoutine } from '../src/server/external-agents/grok-routine.ts';
import { fakeHost, fakeFs } from './helpers/fake-host.ts';
import { productionPaths } from './helpers/production-paths.ts';
import { secretsDirectory } from '../src/server/api-providers.ts';
import { promisify } from 'node:util';
import { execFile } from '../src/server/platform/test-process.ts';
import { desktopLaunchPlan, ensureBackend } from '../src/cli/launch.ts';
import { createRequire } from 'node:module';
import { listenForFetch } from './helpers/fetch-port.ts';

test('test entry detection exports a child flag without changing NODE_TEST_CONTEXT', () => {
  const context = process.env.NODE_TEST_CONTEXT;
  assert.equal(underTest(), true);
  assert.equal(process.env.PUGPORT_UNDER_TEST, '1');
  assert.equal(process.env.NODE_TEST_CONTEXT, context);
  for (const detect of [
    () => {
      process.env.NODE_TEST_CONTEXT = '';
    },
    () => {
      process.execArgv = ['--test'];
    },
    () => {
      process.env.PUGPORT_UNDER_TEST = '1';
    },
  ])
    productionPaths(() => {
      detect();
      assert.equal(underTest(), true);
      assert.equal(process.env.PUGPORT_UNDER_TEST, '1');
    });
});

test('user arguments never enable test mode; Electron ignores its argv entirely', () => {
  for (const argv of [
    [process.execPath, 'pugport.js', 'ask', '--', 'node', '--test', 'run'],
    ['PugPort.exe', 'a.test.ts'],
    ['PugPort.exe', 'pugport://x.test.ts'],
  ]) {
    productionPaths(() => {
      process.argv = argv;
      const previous = Object.getOwnPropertyDescriptor(process.versions, 'electron');
      try {
        if (argv[0] === 'PugPort.exe')
          Object.defineProperty(process.versions, 'electron', { value: '44.5.1', configurable: true });
        assert.equal(underTest(), false);
      } finally {
        if (previous) Object.defineProperty(process.versions, 'electron', previous);
        else Reflect.deleteProperty(process.versions, 'electron');
      }
    });
  }
});

test('packaged modules discard inherited test signals, even with a test entry and --test', () => {
  const directory = join(testDirectory(), 'resources', 'app', 'src/server/platform');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'under-test.mjs');
  copyFileSync(join(process.cwd(), 'src/server/platform/under-test.mjs'), file);
  const code = `process.execArgv=['--test'];process.argv=['PugPort.exe','a.test.ts'];
    const {underTest}=await import(${JSON.stringify(pathToFileURL(file).href)});
    console.log(JSON.stringify([underTest(),process.env.PUGPORT_UNDER_TEST,process.env.NODE_TEST_CONTEXT]));`;
  assert.deepEqual(
    JSON.parse(
      rawExecFileSync(process.execPath, ['--input-type=module', '-e', code], {
        env: { ...process.env, NODE_TEST_CONTEXT: 'child-v8', PUGPORT_UNDER_TEST: '1' },
        encoding: 'utf8',
      }),
    ),
    [false, null, null],
  );
});

test('forked children inherit protection even with a replaced environment', async () => {
  const child = fork(join(process.cwd(), 'tests/helpers/guard-child.mjs'), [], {
    env: { PATH: process.env.PATH },
    cwd: testDirectory(),
    execArgv: [],
    silent: true,
  });
  const message = once(child, 'message');
  const closed = once(child, 'close');
  const result = (await message)[0] as { directory: string };
  assert.ok(result.directory.startsWith(testDirectory() + (process.platform === 'win32' ? '\\' : '/')));
  assert.deepEqual({ ...result, directory: undefined }, { test: true, flag: '1', script: true, directory: undefined });
  assert.equal((await closed)[0], 0);
});

test('every detector works in a fresh process, including plain .test entry files', () => {
  const module = pathToFileURL(join(process.cwd(), 'src/server/platform/under-test.ts')).href;
  const code = `import { underTest } from ${JSON.stringify(module)}; console.log(JSON.stringify({test:underTest(),flag:process.env.PUGPORT_UNDER_TEST}));`;
  for (const suffix of ['.test.ts', '.test.mjs', '.test.cjs', '.mjs']) {
    const file = join(testDirectory(), 'detect' + suffix);
    writeFileSync(
      file,
      suffix === '.test.cjs'
        ? `import(${JSON.stringify(module)}).then(({underTest}) => console.log(JSON.stringify({test:underTest(),flag:process.env.PUGPORT_UNDER_TEST})));`
        : code,
    );
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.PUGPORT_UNDER_TEST;
    if (suffix === '.mjs') env.PUGPORT_UNDER_TEST = '1';
    assert.deepEqual(
      JSON.parse(
        rawExecFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), file], { env, encoding: 'utf8' }),
      ),
      { test: true, flag: '1' },
    );
  }
});

test('all default directories are temporary, explicit secrets still win, and fixture bases stay in place', (t) => {
  const dirs = appDirs();
  for (const value of Object.values(dirs)) if (typeof value === 'string') assert.ok(testPath(value), value);
  assert.deepEqual(dirs.legacy, { extensions: [], fileMoves: [] });
  assert.equal(dirname(dirs.memoryBase), dirs.memoryAnchor);
  const override = join(testDirectory(), 'explicit-secrets');
  const previous = process.env.COMBORUNNER_SECRETS_DIR;
  process.env.COMBORUNNER_SECRETS_DIR = override;
  t.after(() => {
    if (previous === undefined) delete process.env.COMBORUNNER_SECRETS_DIR;
    else process.env.COMBORUNNER_SECRETS_DIR = previous;
  });
  assert.equal(secretsDirectory(), override);
  const local = join(testDirectory(), 'Local');
  assert.equal(
    appDirs(fakeHost('win32', { home: testDirectory(), tmpdir: testDirectory(), env: { LOCALAPPDATA: local } }))
      .memoryAnchor,
    local,
  );
});

test('real CLIs and real Node CLI scripts are refused; temporary fake CLIs run', async () => {
  assert.throws(() => assertTestProcess('codex'), UnderTestError);
  assert.throws(() => assertTestProcess(join(process.env.SystemRoot ?? '/usr', 'real-cli.exe')), UnderTestError);
  const target = {
    id: 'fixture',
    provider: 'codex' as const,
    label: 'Fixture',
    environment: 'native' as const,
    enabled: true,
    command: process.execPath,
    args: [join(process.cwd(), 'real-cli.mjs')],
  };
  await assert.rejects(spawnTarget(target, []), /refused CLI script/);
  const script = join(testDirectory(), 'fake.mjs');
  writeFileSync(script, "console.log('synthetic CLI');");
  const child = await spawnTarget({ ...target, args: [script] }, []);
  assert.match((await collectProcessOutput(child, 5000)).stdout, /synthetic CLI/);
  await terminateProcess(child);
  assert.throws(() => execFileSync('codex', ['cloud', 'list']), /refused external CLI/);
  assert.throws(() => promisify(execFile)('codex', ['cloud', 'list']), /refused external CLI/);
  if (process.platform === 'win32') {
    const wrapper = join(testDirectory(), 'fake.cmd');
    writeFileSync(wrapper, '@echo synthetic wrapper\r\n');
    const fake = await spawnTarget({ ...target, command: wrapper, args: [] }, []);
    assert.match((await collectProcessOutput(fake, 5000)).stdout, /synthetic wrapper/);
    await terminateProcess(fake);
  }
});

test('missing fixture descendants retain temporary aliases and reject linked escapes', () => {
  const root = testDirectory();
  const alias = join(root, 'fixture-alias');
  symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(testPath(join(alias, 'not-created', 'fake-cli')), true);
  assert.equal(testPath(join(realpathSync.native(root), 'not-created', 'fake-cli')), true);
  const outside = join(root, 'outside-alias');
  symlinkSync(process.cwd(), outside, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(testPath(join(outside, 'not-created', 'real-cli')), false);
  const dangling = join(root, 'dangling-outside-alias');
  symlinkSync(join(process.cwd(), 'not-created'), dangling, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(testPath(join(dangling, 'real-cli')), false);
});

test('fetch rejects public hosts, live app and redirects; another loopback port works', async (t) => {
  await assert.rejects(
    fetch('https://api2.cursor.sh/automations/webhook/synthetic', { method: 'POST' }),
    UnderTestError,
  );
  await assert.rejects(fetch('http://127.0.0.1:4317/api/session'), UnderTestError);
  await assert.rejects(fetch(new Request('http://localhost:4317/')), UnderTestError);
  await assert.rejects(fetch('http://[::1]:4317/'), UnderTestError);
  // A device node's backend on this computer.
  await assert.rejects(fetch('http://127.0.0.1:4319/api/node/pairing', { method: 'POST' }), UnderTestError);
  const server = createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'https://api2.cursor.sh/' });
      res.end();
    } else res.end('synthetic');
  });
  await listenForFetch(server);
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'synthetic');
  await assert.rejects(fetch(`http://127.0.0.1:${port}/redirect`));
  const result = await postGrokRoutine(
    { url: 'https://api2.cursor.sh/automations/webhook/synthetic', key: 'synthetic-key' },
    'test',
    'synthetic',
  );
  assert.match(result.note!, /PugPort under test: refused network request/);
  assert.equal(
    (
      await postGrokRoutine(
        { url: 'https://api2.cursor.sh/automations/webhook/synthetic', key: 'synthetic-key' },
        'test',
        'synthetic',
        { fetch: async () => new Response('{}', { status: 200 }) },
      )
    ).ok,
    true,
  );
});

test('non-temporary location files are never inspected; temporary roots retain production behavior', () => {
  const root = process.cwd();
  const location = resolveDataLocation({
    root,
    env: {},
    fs: fakeFs({
      statSync: (file: string) => {
        if (file.includes('.data')) throw new Error('must not inspect location file');
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
    }),
  });
  assert.equal(location.source, 'under-test');
  assert.ok(testPath(location.dataDir));
  assert.throws(() => backendPort({}), /refused default port 4317/);
  assert.equal(backendPort({ PUGPORT_PORT: '54321' }), 54321);
  const fixture = join(testDirectory(), 'location-fixture');
  mkdirSync(join(fixture, '.data'), { recursive: true });
  writeFileSync(join(fixture, '.data', 'data-location.json'), '{');
  assert.throws(() => resolveDataLocation({ root: fixture, env: {} }), /expected JSON/);
});

test('desktop launch strips test variables and cannot start the real development app', async () => {
  const plan = desktopLaunchPlan(process.cwd(), {
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      PUGPORT_UNDER_TEST: '1',
      NODE_TEST_CONTEXT: 'child-v8',
    },
  });
  assert.ok(plan);
  assert.equal(plan.env.PUGPORT_UNDER_TEST, undefined);
  assert.equal(plan.env.NODE_TEST_CONTEXT, undefined);
  assert.equal(plan.env.ELECTRON_RUN_AS_NODE, undefined);
  await assert.rejects(ensureBackend({ health: async () => false } as never), /refused external CLI/);
  const electron = createRequire(import.meta.url)('electron') as string;
  const fake = join(testDirectory(), 'renderer.cjs');
  writeFileSync(fake, '');
  assert.equal(assertTestProcess(electron, [fake]), electron);
  assert.equal(assertTestProcess(electron, electronArgs(fake)), electron);
  // The checkout is the real app even when it sits under the temp folder.
  assert.throws(() => assertTestProcess(electron, [process.cwd()]), UnderTestError);
  assert.throws(() => assertTestProcess(electron, electronArgs(process.cwd())), UnderTestError);
  assert.equal(testPath(join(process.cwd(), 'src', 'electron', 'main.ts')), false);
  assert.throws(() => assertTestProcess(join(dirname(electron), 'untrusted.exe'), [fake]), UnderTestError);
  // Code under test that starts Electron itself goes through the loader too, so a broken app never opens a dialog.
  assert.deepEqual(testProcessArgs(electron, [fake, 'x']), electronArgs(fake, 'x'));
  assert.deepEqual(testProcessArgs(electron, electronArgs(fake)), electronArgs(fake));
  assert.deepEqual(testProcessArgs(process.execPath, [fake]), [fake]);
  // Node mode opens no app, so its scripts run unchanged.
  assert.deepEqual(testProcessArgs(electron, ['-e', '1'], { ELECTRON_RUN_AS_NODE: '1' }), ['-e', '1']);
});

test('git uses the installed binary with isolated configuration even when options are omitted', () => {
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        'console.log(JSON.stringify([process.env.PUGPORT_UNDER_TEST,process.env.PUGPORT_TEST_DIRECTORY]))',
      ],
      { encoding: 'utf8' },
    ),
  );
  assert.equal(result[0], '1');
  assert.equal(result[1], testDirectory());
  assert.equal(execFileSync('git', ['config', '--global', '--list'], { encoding: 'utf8' }), '');
  assert.equal(execFileSync('git', ['config', '--global', '--list']).toString(), '');
  const gitEnv = testProcessEnv(assertTestProcess('git'), {
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'user.name',
    GIT_CONFIG_VALUE_0: 'synthetic',
  });
  assert.equal(gitEnv.GIT_OPTIONAL_LOCKS, '0');
  assert.equal(gitEnv.GIT_TERMINAL_PROMPT, '0');
  assert.equal(gitEnv.GIT_CONFIG_COUNT, undefined);
  assert.equal(gitEnv.GIT_CONFIG_KEY_0, undefined);
  assert.equal(gitEnv.GIT_CONFIG_VALUE_0, undefined);
  assert.equal(gitEnv.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(gitEnv.GIT_CONFIG_GLOBAL, join(testDirectory(), 'git-config'));
  const supplied = join(testDirectory(), 'inherited-git-config');
  writeFileSync(supplied, '[user]\nname = synthetic inherited user\n');
  assert.equal(
    execFileSync('git', ['config', '--global', '--list'], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: supplied, GIT_CONFIG_NOSYSTEM: '0' },
      encoding: 'utf8',
    }),
    '',
  );
  if (process.platform === 'win32') {
    for (const name of ['taskkill.exe', 'icacls.exe', 'whoami.exe', 'tar.exe']) {
      const file = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', name);
      assert.equal(assertTestProcess(file), file);
      assert.throws(() => assertTestProcess(join(process.cwd(), name)), UnderTestError);
    }
  }
});

test('locked cleanup does not change the exit status; a killed child stays under its parent root', () => {
  const module = pathToFileURL(join(process.cwd(), 'src/server/platform/under-test.mjs')).href;
  const code = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    import {testDirectory} from ${JSON.stringify(module)};
    console.log(testDirectory());fs.rmSync=()=>{throw Error('synthetic Windows lock');};syncBuiltinESMExports();`;
  const locked = rawExecFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' }).trim();
  assert.ok(existsSync(locked));
  rmSync(locked, { recursive: true, force: true });
  const wrapper = pathToFileURL(join(process.cwd(), 'src/server/platform/test-process.ts')).href;
  const parentCode = `import {testDirectory} from ${JSON.stringify(module)};
    import {spawn} from ${JSON.stringify(wrapper)};
    const root=testDirectory();console.log(root);
    const child=spawn(process.execPath,['--input-type=module','-e',
      ${JSON.stringify(`import {testDirectory} from ${JSON.stringify(module)};console.log(testDirectory());setInterval(()=>{},1000);`)}]);
    child.stdout.once('data',()=>child.kill('SIGKILL'));`;
  const env = { ...process.env };
  delete env.PUGPORT_TEST_DIRECTORY;
  const parent = rawExecFileSync(
    process.execPath,
    ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', parentCode],
    { env, encoding: 'utf8', timeout: 15000 },
  ).trim();
  assert.equal(existsSync(parent), false);
});

test('backend refuses missing and live ports before loading any data', () => {
  for (const port of [undefined, '4317']) {
    const env = { ...process.env };
    delete env.COMBORUNNER_PORT;
    delete env.AGENT_STUDIO_PORT;
    if (port) env.COMBORUNNER_PORT = port;
    assert.throws(
      () =>
        rawExecFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), 'src/server/main.ts'], {
          env,
          encoding: 'utf8',
          stdio: 'pipe',
        }),
      /backend requires an explicit port|unsafe backend port/,
    );
  }
});

test('stale roots with dead owners are removed; live owners and recent roots survive', () => {
  const dead = 2147483647;
  assert.throws(() => process.kill(dead, 0), { code: 'ESRCH' });
  const stale = join(tmpdir(), `pugport-test-${dead}-stale-${process.pid}`);
  const recent = join(tmpdir(), `pugport-test-${dead}-recent-${process.pid}`);
  const live = join(tmpdir(), `pugport-test-${process.pid}-live`);
  for (const dir of [stale, recent, live]) mkdirSync(dir, { recursive: true });
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  for (const dir of [stale, live]) utimesSync(dir, old, old);
  try {
    const env = { ...process.env };
    delete env.PUGPORT_TEST_DIRECTORY;
    const module = pathToFileURL(join(process.cwd(), 'src/server/platform/under-test.mjs')).href;
    rawExecFileSync(
      process.execPath,
      ['--input-type=module', '-e', `import {testDirectory} from ${JSON.stringify(module)};testDirectory();`],
      { env },
    );
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(recent), true);
    assert.equal(existsSync(live), true);
  } finally {
    for (const dir of [stale, recent, live]) rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy roots expire after 24 hours but pugport-test-memory is never removed', () => {
  const temp = join(testDirectory(), 'sweep-fixture');
  const stale = join(temp, 'pugport-test-ABCDEF');
  const recent = join(temp, 'pugport-test-UVWXYZ');
  const memory = join(temp, 'pugport-test-memory');
  for (const dir of [stale, recent, memory]) mkdirSync(dir, { recursive: true });
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  for (const dir of [stale, memory]) utimesSync(dir, old, old);
  const module = pathToFileURL(join(process.cwd(), 'src/server/platform/under-test.mjs')).href;
  rawExecFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(module)});`], {
    env: { ...process.env, TMP: temp, TEMP: temp, TMPDIR: temp, PUGPORT_UNDER_TEST: '1' },
  });
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(recent), true);
  assert.equal(existsSync(memory), true);
});
