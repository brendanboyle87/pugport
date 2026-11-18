import { largeFileId, mockFileIds } from './helpers/file-identity.ts';
import assert from 'node:assert/strict';
import { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test, type TestContext } from 'node:test';
import { mirrorAccountSharedConfig, accountSharedConfigNote } from '../src/server/account-shared-config.ts';
import { sanitizeCodexConfig } from '../src/server/account-config-toml.ts';
import { createNativeAccount, launchAccountLogin } from '../src/server/native-accounts.ts';
import { deleteAccountHome, recycleAccountHome } from '../src/server/account-home.ts';
import { captureTarget } from '../src/server/adapters/process.ts';
import type { RuntimeTarget } from '../src/shared/types.ts';

function fixture(t: TestContext, provider: 'claude' | 'codex' = 'claude') {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-shared-config-')));
  const source = join(root, 'default');
  mkdirSync(source);
  const overrides = { CLAUDE_CONFIG_DIR: source, CODEX_HOME: source };
  const previous = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
  Object.assign(process.env, overrides);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    assert.ok(resolve(root).startsWith(realpathSync.native(tmpdir()) + sep));
    assert.ok(root.includes('pugport-shared-config-'));
    rmSync(root, { recursive: true, force: true });
  });
  const base: RuntimeTarget = {
    id: `${provider}-native`,
    provider,
    label: provider,
    command: process.execPath,
    environment: 'native',
    enabled: true,
  };
  const write = (name: string, content: string) => writeFileSync(join(source, name), content);
  const extension = (name: string) => {
    mkdirSync(join(source, name));
    writeFileSync(join(source, name, 'keep.txt'), 'default extension');
  };
  return { root, source, write, extension, create: () => createNativeAccount(root, base, '测试账号') };
}

test('shared configuration refuses opened files with a different high-bit ID', async (t) => {
  const f = fixture(t);
  f.write('CLAUDE.md', 'synthetic shared instruction');
  const source = join(f.source, 'CLAUDE.md');
  const ids = mockFileIds(t, [[source, largeFileId]]);
  ids.opened(source, largeFileId + 1n);
  const target = await f.create();
  assert.equal(existsSync(join(target.accountHome!, 'CLAUDE.md')), false);
  assert.match(accountSharedConfigNote(target)!, /CLAUDE.md 同步失败/);
  ids.opened(source, largeFileId);
  await mirrorAccountSharedConfig(target);
  assert.equal(readFileSync(join(target.accountHome!, 'CLAUDE.md'), 'utf8'), 'synthetic shared instruction');
});

test('Claude creation mirrors only the allowlist, filters credentials, and repeated concurrent mirrors are idempotent', async (t) => {
  const f = fixture(t);
  f.write('CLAUDE.md', '推送前询问用户');
  f.write(
    'settings.json',
    JSON.stringify({
      permissions: { ask: ['Bash(git push:*)'] },
      model: 'test-model',
      apiKeyHelper: 'secret-helper',
      awsAuthRefresh: 'secret-helper',
      awsCredentialExport: 'secret-helper',
      otelHeadersHelper: 'secret-helper',
      forceLoginOrgUUID: 'secret-identity',
      forceLoginMethod: 'secret-login',
      env: {
        SAFE: 'yes',
        SOME_KEY: 'secret-env',
        token: 'secret-env',
        CLIENT_SECRET: 'secret-env',
        PASSWORD: 'secret-env',
      },
    }),
  );
  for (const name of ['skills', 'agents', 'commands', 'plugins', 'output-styles']) f.extension(name);
  for (const name of ['.credentials.json', '.claude.json', 'auth.json', 'history.jsonl']) f.write(name, 'never copy');
  for (const name of ['projects', 'sessions', 'cache', 'logs']) f.extension(name);
  const target = await f.create();
  const home = target.accountHome!;
  assert.equal(readFileSync(join(home, 'CLAUDE.md'), 'utf8'), '推送前询问用户');
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')), {
    permissions: { ask: ['Bash(git push:*)'] },
    model: 'test-model',
    env: { SAFE: 'yes' },
  });
  assert.deepEqual(
    readdirSync(home).sort(),
    [
      '.pugport-shared-config.json',
      'CLAUDE.md',
      'settings.json',
      'skills',
      'agents',
      'commands',
      'plugins',
      'output-styles',
    ].sort(),
  );
  for (const name of ['skills', 'agents', 'commands', 'plugins', 'output-styles']) {
    assert.ok(lstatSync(join(home, name)).isSymbolicLink());
    assert.equal(realpathSync(join(home, name)), realpathSync(join(f.source, name)));
  }
  const times = ['CLAUDE.md', 'settings.json', '.pugport-shared-config.json'].map(
    (name) => statSync(join(home, name)).mtimeMs,
  );
  await Promise.all([mirrorAccountSharedConfig(target), mirrorAccountSharedConfig({ ...target })]);
  assert.deepEqual(
    ['CLAUDE.md', 'settings.json', '.pugport-shared-config.json'].map((name) => statSync(join(home, name)).mtimeMs),
    times,
  );
  assert.equal(accountSharedConfigNote(target), undefined);
});

test('Codex keeps model preferences and instructions but strips auth, MCP env and bearer values in every table form', async (t) => {
  const f = fixture(t, 'codex');
  f.write('AGENTS.md', 'personal rules');
  f.extension('skills');
  f.extension('prompts');
  f.write(
    'config.toml',
    `model = "fixture-model"
model_reasoning_effort = "high"
model_max_output_tokens = 4096
cli_auth_credentials_store = "secret-auth"
forced_login_method = "secret-auth"
forced_chatgpt_workspace_id = "secret-workspace"
api_key = "secret-key"
mcp_servers.inline = { command = "tool", env = { PUBLIC = "secret-env" }, bearer_token = "secret-bearer" }
[mcp_servers.standard]
command = "tool"
args = ["one", "two"]
env = { OPENAI_API_KEY = "secret-env", PUBLIC = "secret-env" }
bearer_token = """secret-multiline
more-secret"""
http_headers = { Authorization = "secret-header" }
[mcp_servers.standard.env]
PUBLIC = "secret-env"
[mcp_servers."quoted".env]
PUBLIC = "secret-env"
[mcp_servers.dotted]
env.PUBLIC = "secret-env"
"bearer_token" = 'secret-bearer'
command = 'tool'
[model_providers.fixture]
name = "provider"
env_key = "secret-env-name"
experimental_bearer_token = "secret-token"
[shell_environment_policy.set]
AWS_ACCESS_KEY_ID = "secret-key"
[profiles.careful]
model_reasoning_effort = "xhigh"
`,
  );
  f.write('auth.json', 'never copy');
  f.extension('sessions');
  const target = await f.create();
  const result = readFileSync(join(target.accountHome!, 'config.toml'), 'utf8');
  assert.ok(!result.includes('secret'), result);
  assert.match(result, /fixture-model/);
  assert.match(result, /model_max_output_tokens.*4096/);
  assert.match(result, /model_reasoning_effort.*high/);
  assert.match(result, /xhigh/);
  assert.match(result, /command.*tool/);
  assert.equal(readFileSync(join(target.accountHome!, 'AGENTS.md'), 'utf8'), 'personal rules');
  assert.ok(lstatSync(join(target.accountHome!, 'prompts')).isSymbolicLink());
  assert.ok(!existsSync(join(target.accountHome!, 'auth.json')));
  assert.ok(!existsSync(join(target.accountHome!, 'sessions')));
});

test('TOML filtering handles escaped keys, nested inline tables, arrays and multiline preferences without line-based leaks', () => {
  const result = sanitizeCodexConfig(String.raw`model = 'test'
mcp_servers = { tool = { command = 'tool', env = { X = 'secret' }, "bearer_\u0074oken" = 'secret' } }
developer_instructions = """Keep this
[not_a_table]
instruction"""
[profiles.a]
model = "a"
[mcp_servers.tokenizer]
command = "tool"
bearer_token = "secret"
[[skills.config]]
path = 'skill-one'
enabled = true
`);
  assert.ok(!result.includes('secret'));
  assert.match(result, /not_a_table/);
  assert.match(result, /tokenizer/);
  assert.match(result, /\[\["skills"\."config"\]\]/);
  assert.throws(() => sanitizeCodexConfig('model = "unterminated'));
  assert.throws(() => sanitizeCodexConfig('model = not valid TOML'));
});

test('source changes refresh on launch, while manually edited copies stay intact across launches', async (t) => {
  const f = fixture(t);
  f.write('CLAUDE.md', 'first');
  const target = await f.create();
  f.write('CLAUDE.md', 'second');
  utimesSync(join(f.source, 'CLAUDE.md'), 1, 1);
  const readRule = `console.log(require('node:fs').readFileSync(require('node:path').join(process.env.CLAUDE_CONFIG_DIR, 'CLAUDE.md'), 'utf8'))`;
  assert.equal((await captureTarget(target, ['-e', readRule])).stdout.trim(), 'second');
  writeFileSync(join(target.accountHome!, 'CLAUDE.md'), 'manual edit');
  f.write('CLAUDE.md', 'third');
  assert.equal((await captureTarget(target, ['-e', readRule])).stdout.trim(), 'manual edit');
  assert.match(accountSharedConfigNote(target)!, /手动修改.*保留/);
  assert.equal(readFileSync(join(f.source, 'CLAUDE.md'), 'utf8'), 'third');
  assert.ok(!readdirSync(target.accountHome!).some((name) => name.endsWith('.tmp')));
});

test('existing real directories and unowned links are kept; only our own links can be retargeted', async (t) => {
  const f = fixture(t);
  const target = await f.create();
  const home = target.accountHome!;
  mkdirSync(join(home, 'skills'));
  writeFileSync(join(home, 'skills', 'mine'), 'personal');
  f.extension('skills');
  f.extension('plugins');
  f.extension('agents');
  symlinkSync(join(f.source, 'agents'), join(home, 'agents'), process.platform === 'win32' ? 'junction' : 'dir');
  await mirrorAccountSharedConfig(target);
  assert.ok(!lstatSync(join(home, 'skills')).isSymbolicLink());
  assert.equal(readFileSync(join(home, 'skills', 'mine'), 'utf8'), 'personal');
  assert.match(accountSharedConfigNote(target)!, /已有内容.*保留/);
  const other = join(f.root, 'other-default');
  mkdirSync(other);
  mkdirSync(join(other, 'plugins'));
  mkdirSync(join(other, 'agents'));
  await mirrorAccountSharedConfig(target, { ...process.env, CLAUDE_CONFIG_DIR: other });
  assert.equal(realpathSync(join(home, 'plugins')), realpathSync(join(other, 'plugins')));
  assert.equal(realpathSync(join(home, 'agents')), realpathSync(join(f.source, 'agents')));
});

test('invalid configuration and an unreadable ledger never block creation or a real synthetic process launch', async (t) => {
  const f = fixture(t, 'codex');
  f.write('config.toml', 'model = "unterminated');
  const target = await f.create();
  assert.match(accountSharedConfigNote(target)!, /同步失败/);
  assert.ok(!existsSync(join(target.accountHome!, 'config.toml')));
  writeFileSync(join(target.accountHome!, '.pugport-shared-config.json'), '{broken');
  const output = await captureTarget({ ...target, args: [] }, ['-e', 'console.log("launched")']);
  assert.equal(output.stdout.trim(), 'launched');
  assert.match(accountSharedConfigNote(target)!, /同步失败.*仍可启动/);
});

test(
  'login synchronizes before invoking its launcher and continues after a mirror failure',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const f = fixture(t);
    f.write('CLAUDE.md', 'first');
    const target = await f.create();
    f.write('CLAUDE.md', 'before login');
    f.write('settings.json', '{broken');
    const result = await launchAccountLogin(target, () => {
      assert.equal(readFileSync(join(target.accountHome!, 'CLAUDE.md'), 'utf8'), 'before login');
      const child = new EventEmitter() as ChildProcess;
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });
    assert.deepEqual(result, { opened: true });
    assert.match(accountSharedConfigNote(target)!, /settings.json 同步失败/);
  },
);

for (const mode of ['purge', 'recycle'] as const) {
  test(`${mode} detaches extension links and nested user links before deletion, leaving default contents intact`, async (t) => {
    const f = fixture(t);
    f.extension('skills');
    f.extension('plugins');
    const target = await f.create();
    const home = target.accountHome!;
    mkdirSync(join(home, 'nested'));
    symlinkSync(f.source, join(home, 'nested', 'external'), process.platform === 'win32' ? 'junction' : 'dir');
    symlinkSync(join(f.root, 'missing'), join(home, 'broken'), process.platform === 'win32' ? 'junction' : 'dir');
    const accounts = join(f.root, 'accounts');
    let calls = 0;
    const refreshing = mirrorAccountSharedConfig(target);
    const removed =
      mode === 'purge'
        ? await deleteAccountHome(accounts, home)
        : await recycleAccountHome(accounts, home, async (_root, requested) => {
            calls++;
            assert.deepEqual(requested, [home]);
            assert.ok(!existsSync(join(home, 'skills')));
            assert.ok(!existsSync(join(home, 'plugins')));
            assert.deepEqual(readdirSync(join(home, 'nested')), []);
            assert.ok(!readdirSync(home).includes('broken'));
            renameSync(home, join(f.root, 'fake-recycle-bin'));
            return { moved: [home], failed: [] };
          });
    await refreshing;
    assert.equal(removed, true);
    assert.equal(calls, mode === 'recycle' ? 1 : 0);
    assert.ok(!existsSync(home));
    for (const name of ['skills', 'plugins'])
      assert.equal(readFileSync(join(f.source, name, 'keep.txt'), 'utf8'), 'default extension');
  });
}

test('removal rejects a linked account root or a folder outside accounts before calling the recycler', async (t) => {
  const f = fixture(t);
  f.extension('skills');
  const accounts = join(f.root, 'accounts');
  mkdirSync(accounts);
  const link = join(accounts, 'linked');
  symlinkSync(f.source, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await deleteAccountHome(accounts, link), false);
  assert.equal(await deleteAccountHome(accounts, f.source), false);
  assert.equal(
    await recycleAccountHome(accounts, link, async () => {
      throw new Error('must not be called');
    }),
    false,
  );
  assert.equal(readFileSync(join(f.source, 'skills', 'keep.txt'), 'utf8'), 'default extension');
  const linkedAccounts = join(f.root, 'linked-accounts');
  symlinkSync(f.source, linkedAccounts, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await deleteAccountHome(linkedAccounts, join(linkedAccounts, 'skills')), false);
  assert.equal(readFileSync(join(f.source, 'skills', 'keep.txt'), 'utf8'), 'default extension');
});

test('linked source files are rejected and pre-existing account files are never adopted over different content', async (t) => {
  const f = fixture(t);
  const target = await f.create();
  f.write('auth.json', 'synthetic secret');
  linkSync(join(f.source, 'auth.json'), join(f.source, 'CLAUDE.md'));
  f.write('settings.json', '{"model":"default"}');
  writeFileSync(join(target.accountHome!, 'settings.json'), '{"model":"personal"}');
  await mirrorAccountSharedConfig(target);
  assert.ok(!existsSync(join(target.accountHome!, 'CLAUDE.md')));
  assert.equal(readFileSync(join(target.accountHome!, 'settings.json'), 'utf8'), '{"model":"personal"}');
  assert.match(accountSharedConfigNote(target)!, /同步失败/);
});

test('Claude accounts share each project memory by link; own notes are kept and removal leaves the default intact', async (t) => {
  const f = fixture(t);
  const memory = (root: string, project: string) => join(root, 'projects', project, 'memory');
  const target = await f.create();
  const home = target.accountHome!;
  // Before sharing existed, the account made an empty memory folder for repo-c and wrote its own notes for repo-d.
  mkdirSync(memory(home, 'repo-c'), { recursive: true });
  mkdirSync(memory(home, 'repo-d'), { recursive: true });
  writeFileSync(join(memory(home, 'repo-d'), 'MEMORY.md'), 'account notes');
  for (const project of ['repo-a', 'repo-c', 'repo-d']) {
    mkdirSync(memory(f.source, project), { recursive: true });
    writeFileSync(join(memory(f.source, project), 'MEMORY.md'), `default notes for ${project}`);
  }
  mkdirSync(join(f.source, 'projects', 'repo-b'));
  writeFileSync(join(f.source, 'projects', 'repo-b', 'session.jsonl'), 'never shared');
  // A stray file sorted first (macOS leaves .DS_Store) must not stop the other projects.
  writeFileSync(join(f.source, 'projects', '.DS_Store'), 'finder');
  await mirrorAccountSharedConfig(target);
  for (const project of ['repo-a', 'repo-c']) {
    assert.ok(lstatSync(memory(home, project)).isSymbolicLink());
    assert.equal(readFileSync(join(memory(home, project), 'MEMORY.md'), 'utf8'), `default notes for ${project}`);
  }
  // One copy: what the account writes is what every other account reads.
  writeFileSync(join(memory(home, 'repo-a'), 'new.md'), 'written by the account');
  assert.equal(readFileSync(join(memory(f.source, 'repo-a'), 'new.md'), 'utf8'), 'written by the account');
  assert.ok(!lstatSync(memory(home, 'repo-d')).isSymbolicLink());
  assert.equal(readFileSync(join(memory(home, 'repo-d'), 'MEMORY.md'), 'utf8'), 'account notes');
  assert.equal(readFileSync(join(memory(f.source, 'repo-d'), 'MEMORY.md'), 'utf8'), 'default notes for repo-d');
  assert.match(accountSharedConfigNote(target)!, /项目记忆已有内容，已保留/);
  assert.ok(!existsSync(join(home, 'projects', 'repo-b')));
  // A correct link the ledger lost (its write failed) is adopted, not reported as the account's own notes.
  const ledgerFile = join(home, '.pugport-shared-config.json');
  const ledger = JSON.parse(readFileSync(ledgerFile, 'utf8'));
  delete ledger.links['projects/repo-a/memory'];
  writeFileSync(ledgerFile, JSON.stringify(ledger));
  await mirrorAccountSharedConfig(target);
  assert.equal(
    JSON.parse(readFileSync(ledgerFile, 'utf8')).links['projects/repo-a/memory'],
    memory(f.source, 'repo-a'),
  );
  // A default folder that is gone stops being linked.
  rmSync(memory(f.source, 'repo-c'), { recursive: true });
  await mirrorAccountSharedConfig(target);
  assert.ok(!existsSync(memory(home, 'repo-c')));
  assert.ok(lstatSync(memory(home, 'repo-a')).isSymbolicLink());
  assert.equal(await deleteAccountHome(join(f.root, 'accounts'), home), true);
  assert.ok(!existsSync(home));
  assert.equal(readFileSync(join(memory(f.source, 'repo-a'), 'MEMORY.md'), 'utf8'), 'default notes for repo-a');
  assert.equal(readFileSync(join(memory(f.source, 'repo-a'), 'new.md'), 'utf8'), 'written by the account');
});

test('a linked projects folder in the account is refused and Codex accounts get no project memory', async (t) => {
  const f = fixture(t);
  const target = await f.create();
  const home = target.accountHome!;
  mkdirSync(join(f.source, 'projects', 'repo-a', 'memory'), { recursive: true });
  const elsewhere = join(f.root, 'elsewhere');
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(home, 'projects'), process.platform === 'win32' ? 'junction' : 'dir');
  await mirrorAccountSharedConfig(target);
  assert.deepEqual(readdirSync(elsewhere), []);
  assert.ok(existsSync(join(f.source, 'projects', 'repo-a', 'memory')));
  assert.match(accountSharedConfigNote(target)!, /项目记忆同步失败/);

  const codex = fixture(t, 'codex');
  mkdirSync(join(codex.source, 'projects', 'repo-a', 'memory'), { recursive: true });
  const codexTarget = await codex.create();
  assert.ok(!existsSync(join(codexTarget.accountHome!, 'projects')));
});
