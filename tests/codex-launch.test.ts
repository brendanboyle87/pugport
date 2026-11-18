import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  agentBridgeTokenVariable,
  codexExecutionEnvironment,
  createCodexAdapter,
} from '../src/server/adapters/codex.ts';
import { captureTarget } from '../src/server/adapters/process.ts';
import { nativeAccountEnvironment } from '../src/server/native-accounts.ts';
import type { ExecuteContext, RuntimeTarget } from '../src/shared/types.ts';

const target: RuntimeTarget = {
  id: 'codex-fixture',
  provider: 'codex',
  label: 'Offline fixture',
  command: process.execPath,
  environment: 'native',
  enabled: true,
};

test('Codex environment preserves launch variables and redirects every spelling of temp without mutating its source', () => {
  const source = {
    SystemRoot: 'system-root',
    ComSpec: 'command-shell',
    Path: 'runtime-path',
    PATHEXT: '.EXE;.CMD',
    USERPROFILE: 'user-home',
    TEMP: 'old-temp',
    Temp: 'duplicate-temp',
    tmp: 'old-tmp',
    TMPDIR: 'old-tmpdir',
  };
  const original = { ...source };
  const env = codexExecutionEnvironment(source, 'private-temp', 'synthetic-bridge-token');
  for (const key of ['SystemRoot', 'ComSpec', 'Path', 'PATHEXT', 'USERPROFILE'] as const)
    assert.equal(env[key], source[key]);
  assert.deepEqual(Object.fromEntries(Object.entries(env).filter(([key]) => /^(TEMP|TMP|TMPDIR)$/i.test(key))), {
    TEMP: 'private-temp',
    TMP: 'private-temp',
    TMPDIR: 'private-temp',
  });
  assert.equal(env[agentBridgeTokenVariable], 'synthetic-bridge-token');
  assert.deepEqual(source, original);
  assert.deepEqual(codexExecutionEnvironment(source), source, 'read-only runs do not redirect temp');
});

test('Codex runs never inherit OpenAI key variables, so image generation stays on the subscription', async () => {
  const keys = {
    OPENAI_API_KEY: 'sk-synthetic',
    openai_api_key: 'sk-synthetic-lower',
    CODEX_API_KEY: 'sk-synthetic-codex',
  };
  const source = { Path: 'C:\Windows', OPENAI_ORG_ID: 'org-synthetic', ...keys };
  const env = codexExecutionEnvironment(source, undefined, 'synthetic-bridge-token');
  for (const key of Object.keys(keys)) assert.equal(env[key], undefined, key);
  assert.equal(env.Path, source.Path);
  assert.equal(env.OPENAI_ORG_ID, 'org-synthetic', 'only key variables are removed');
  assert.equal(source.OPENAI_API_KEY, 'sk-synthetic', 'the caller environment is not changed');
  // The CLI's own saved login (no PugPort account) drops them at spawn time too; isolated accounts already did.
  for (const key of Object.keys(keys)) assert.equal(nativeAccountEnvironment(target, source)[key], undefined, key);
  // Other providers are unaffected by this rule.
  const claude = nativeAccountEnvironment({ ...target, id: 'claude-fixture', provider: 'claude' }, source);
  assert.equal(claude.OPENAI_API_KEY, 'sk-synthetic');

  // The adapter's real launch path hands Codex an environment without the key, even when the host has one.
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-synthetic-host';
  let launched: NodeJS.ProcessEnv | undefined;
  try {
    const adapter = createCodexAdapter({
      sandboxStatus: async () => ({ available: false, reason: 'sdk-missing', message: '沙箱组件未安装' }),
      spawn: async (_target, _args, options) => {
        launched = options?.env;
        throw Object.assign(new Error('synthetic launch stop'), { code: 'EPERM' });
      },
    });
    await assert.rejects(
      adapter.execute({
        target,
        input: {
          projectPath: process.cwd(),
          prompt: 'synthetic',
          kind: 'general',
          permissionMode: 'read-only',
          imageGeneration: { outputDir: tmpdir(), prompt: 'synthetic', edit: false },
        },
        route: { runtimeId: target.id, model: 'fixture', kind: 'general', reasons: [], warnings: [] },
        approvalMode: 'auto',
        signal: new AbortController().signal,
        emit: () => {},
        approve: async () => assert.fail('no approval'),
      }),
      /synthetic launch stop/,
    );
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
  assert.ok(launched, 'Codex was launched');
  assert.equal(
    Object.keys(launched).some((key) => /^OPENAI_API_KEY$/i.test(key)),
    false,
  );
});

test('Codex launch environment can run a fake executor, Node test worker and tsx from the worktree', async (t) => {
  const tempRoot = await realpath(tmpdir());
  const directory = await mkdtemp(join(tempRoot, 'pugport-codex-launch-test-'));
  t.after(async () => {
    assert.equal(dirname(directory), tempRoot);
    await rm(directory, { recursive: true, force: true });
  });
  const temporary = join(directory, 'temp');
  const accountId = '00000000-0000-4000-8000-000000000001';
  const accountHome = join(directory, 'accounts', accountId);
  await mkdir(temporary);
  await mkdir(accountHome, { recursive: true });
  // No account configuration or credential files are created or read.
  const source = { ...process.env };
  // The real host is not a node:test worker. Do not inherit its private IPC reporter into the nested runner.
  delete source.NODE_TEST_CONTEXT;
  const env = nativeAccountEnvironment(
    { ...target, id: `codex-account-${accountId}`, accountId, accountHome },
    codexExecutionEnvironment(source, temporary, 'synthetic-bridge-token'),
  );
  assert.equal(env.CODEX_HOME, accountHome);
  for (const key of ['SystemRoot', 'ComSpec', 'Path', 'PATH', 'PATHEXT'])
    assert.ok(env[key] === source[key], `${key} must survive account isolation`);
  assert.equal(env.TEMP, temporary);
  assert.equal(env.TMP, temporary);
  assert.equal(env.TMPDIR, temporary);
  assert.equal(env[agentBridgeTokenVariable], 'synthetic-bridge-token');
  const worker = join(directory, 'worker.test.ts');
  await writeFile(
    worker,
    `import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('grandchild can use its task temp folder', () => {
  const value: string = 'child-ok';
  assert.equal(tmpdir(), process.env.TMPDIR);
  const file = join(tmpdir(), 'synthetic.txt');
  writeFileSync(file, value);
  assert.equal(readFileSync(file, 'utf8'), value);
  unlinkSync(file);
});
`,
  );
  const executor = join(directory, 'executor.mjs');
  await writeFile(
    executor,
    `import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', process.argv[2]], {
  cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 30000, windowsHide: true,
});
if (result.error) throw result.error;
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
`,
  );
  const result = await captureTarget(target, [executor, worker], { cwd: process.cwd(), env, timeoutMs: 40000 });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /grandchild can use its task temp folder/);
});

test('failed Codex launch cleans its private temp folder without retrying with broader permissions', async () => {
  let temporary: string | undefined;
  let launches = 0;
  const adapter = createCodexAdapter({
    sandboxStatus: async () => ({ available: false, reason: 'sdk-missing', message: '沙箱组件未安装' }),
    spawn: async (_target, args, options) => {
      launches++;
      temporary = options?.env?.TMPDIR;
      assert.ok(temporary && existsSync(temporary));
      assert.equal(options?.env?.TEMP, temporary);
      assert.equal(options?.env?.TMP, temporary);
      assert.ok(!args.some((arg) => /danger|unelevated/.test(arg)));
      throw Object.assign(new Error('synthetic sandbox launch failure'), { code: 'EPERM' });
    },
  });
  const ctx: ExecuteContext = {
    target,
    input: { projectPath: process.cwd(), prompt: 'synthetic', kind: 'general', permissionMode: 'workspace-write' },
    route: { runtimeId: target.id, model: 'fixture', kind: 'general', reasons: [], warnings: [] },
    approvalMode: 'auto',
    signal: new AbortController().signal,
    emit: () => {},
    approve: async () => assert.fail('no elevation approval'),
  };
  await assert.rejects(adapter.execute(ctx), /synthetic sandbox launch failure/);
  assert.equal(launches, 1);
  assert.ok(temporary);
  assert.equal(existsSync(temporary), false);
});
