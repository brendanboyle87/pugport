import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { ExtensionHub } from '../src/server/extensions.ts';
import { discoverPaths } from '../src/server/extension-sync.ts';
import { writePrivateConfig } from '../src/server/private-config.ts';
import type { McpExtension } from '../src/shared/extensions.ts';

const envValue = 'sk-synthetic-TEST-0001';
const headerValue = 'Bearer synthetic-HDR-0002';
const argValue = 'sk-synthetic-ARG-0003';
const urlValue = 'synthetic-URL-0004';
const url = `https://example.invalid/mcp?key=${urlValue}`;
const values = [envValue, headerValue, argValue, urlValue];
const clean = (text: string) => {
  for (const value of values) assert.equal(text.includes(value), false, 'secret escaped its private storage');
};

async function fixture(t: TestContext, writer = writePrivateConfig) {
  const home = await fs.mkdtemp(join(tmpdir(), 'extension-secrets-'));
  const dir = join(home, 'extensions');
  const secretDir = join(home, 'secrets');
  const changes = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'app'),
    LOCALAPPDATA: join(home, 'local'),
    COMBORUNNER_EXTENSIONS_DIR: dir,
    COMBORUNNER_SECRETS_DIR: secretDir,
  };
  const previous = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
  Object.assign(process.env, changes);
  const hub = new ExtensionHub(dir, [], async (...args) => {
    try {
      await writer(...args);
    } catch (error) {
      const failure = error as Error & { code?: string };
      t.diagnostic(
        `private write failure: ${failure.code ?? failure.name}; ${failure.message.includes('同时发生变化') ? 'concurrent update' : failure.message.includes('访问权限') ? 'access restriction failed' : 'other failure'}`,
      );
      throw error;
    }
  });
  t.after(async () => {
    await hub.stopAll();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const put = async (file: string, text: string) => {
    await fs.mkdir(dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  };
  const paths = discoverPaths({ platform: process.platform, home, appData: changes.APPDATA, env: {} });
  return {
    home,
    dir,
    hub,
    put,
    paths,
    file: join(dir, 'extensions.json'),
    secrets: join(secretDir, 'extension-settings.json'),
  };
}

function legacy(args: string[] = []): McpExtension {
  return {
    kind: 'mcp',
    id: 'local',
    name: 'local',
    transport: 'stdio',
    command: process.execPath,
    args,
    env: { NOTES_API_KEY: envValue },
    headers: { Authorization: headerValue },
    enabled: false,
    installedAt: '2026-10-28',
    source: 'synthetic',
  };
}

async function fakeServer(home: string) {
  const file = join(home, 'fake.mjs');
  await fs.writeFile(
    file,
    `import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); if(m.id===undefined)return;
 const result=m.method==='initialize'?{protocolVersion:'2025-06-18'}:
 m.method==='tools/list'?{tools:[{name:'report',description:'reports delivery',annotations:{readOnlyHint:true},inputSchema:{type:'object'}}]}:
 {content:[{type:'text',text:JSON.stringify({env:process.env.NOTES_API_KEY===${JSON.stringify(envValue)},arg:process.argv.includes(${JSON.stringify('--api-key=' + argValue)})})}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`,
  );
  return file;
}

test('sync stores all four synthetic values only in private settings and never logs them', async (t) => {
  const f = await fixture(t);
  // This test inspects persistence only. No HTTP request or process may start.
  f.hub.check = async () => [];
  const captured: string[] = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  for (const key of ['log', 'warn', 'error'] as const)
    console[key] = (...args) => {
      captured.push(args.map(String).join(' '));
    };
  try {
    await f.put(
      f.paths.claudeConfig,
      JSON.stringify({
        mcpServers: {
          local: {
            command: 'synthetic',
            args: [`--api-key=${argValue}`],
            env: { NOTES_API_KEY: envValue },
            headers: { Authorization: headerValue },
          },
          remote: { url, headers: { Authorization: headerValue } },
        },
      }),
    );
    await f.hub.syncOnce(f.paths);
    const persisted = await fs.readFile(f.file, 'utf8');
    clean(persisted);
    clean(JSON.stringify(f.hub.list()));
    clean(captured.join('\n'));
    const secrets = await fs.readFile(f.secrets, 'utf8');
    for (const value of values) assert.ok(secrets.includes(value));
    assert.match(persisted, /\{\{secret:\d+\}\}/);
    for (const item of f.hub.list())
      if (item.kind === 'mcp') {
        assert.equal(item.args, undefined);
        assert.equal(item.url, undefined);
        assert.equal(item.command, undefined);
      }
  } finally {
    Object.assign(console, originals);
  }
});

test('manual install delivers private env and secret arguments to the fake stdio server', async (t) => {
  const f = await fixture(t);
  const server = await fakeServer(f.home);
  const preview = await f.hub.preview(
    JSON.stringify({
      mcpServers: {
        local: { command: process.execPath, args: [server, `--api-key=${argValue}`], env: { NOTES_API_KEY: envValue } },
      },
    }),
  );
  clean(JSON.stringify(preview));
  const [id] = await f.hub.install(preview.token, [preview.drafts[0]!.key]);
  await f.hub.check(id!);
  const result = await f.hub.call(f.hub.toolNames(false)[0]!, {}, false);
  assert.deepEqual(JSON.parse(String(result.content[0]!.text)), { env: true, arg: true });
  clean(await fs.readFile(f.file, 'utf8'));
  clean(JSON.stringify(f.hub.list()));
});

test('environment references expand at runtime and missing variables appear as a safe setting hint', async (t) => {
  const f = await fixture(t);
  const server = await fakeServer(f.home);
  const variable = 'PUGPORT_SYNTHETIC_BATCH3_KEY';
  const previous = process.env[variable];
  t.after(() => {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  });
  process.env[variable] = envValue;
  const preview = await f.hub.preview(
    JSON.stringify({
      mcpServers: {
        local: {
          command: process.execPath,
          args: [server, `--api-key=${argValue}`],
          env: { NOTES_API_KEY: '${' + variable + '}' },
        },
      },
    }),
  );
  assert.equal(preview.drafts[0]!.needs?.includes('NOTES_API_KEY') ?? false, false);
  const [id] = await f.hub.install(preview.token, [preview.drafts[0]!.key]);
  await f.hub.check(id!);
  assert.deepEqual(JSON.parse(String((await f.hub.call(f.hub.toolNames(false)[0]!, {}, false)).content[0]!.text)), {
    env: true,
    arg: true,
  });
  await f.put(
    f.paths.claudeConfig,
    JSON.stringify({
      mcpServers: {
        local: {
          command: process.execPath,
          args: [server, `--api-key=${argValue}`],
          env: { NOTES_API_KEY: '${' + variable + '}' },
        },
      },
    }),
  );
  await f.hub.syncOnce(f.paths);
  assert.ok(f.hub.all().find((item) => item.id === id)!.sync);
  await f.hub.stopAll();
  delete process.env[variable];
  const fresh = new ExtensionHub(f.dir, []);
  t.after(() => fresh.stopAll());
  await assert.rejects(fresh.check(id!), { message: `需要设置环境变量 ${variable}，或在这里填写它的值` });
  assert.equal((fresh.list()[0] as McpExtension).error, `需要设置环境变量 ${variable}，或在这里填写它的值`);
  clean(JSON.stringify(fresh.list()));
});

test('legacy plaintext migrates on first save and reload restores private values', async (t) => {
  const f = await fixture(t);
  const item = {
    ...legacy([`--api-key=${argValue}`, '--token', argValue, `API_SECRET=${argValue}`]),
    url,
    error: values.join(' '),
  };
  await f.put(f.file, JSON.stringify({ version: 1, items: [item] }));
  assert.equal((f.hub.all()[0] as McpExtension).env!.NOTES_API_KEY, envValue);
  clean(JSON.stringify(f.hub.list()));
  await f.hub.setEnabled('local', false);
  clean(await fs.readFile(f.file, 'utf8'));
  const fresh = new ExtensionHub(f.dir, []);
  t.after(() => fresh.stopAll());
  const reloaded = fresh.all()[0] as McpExtension;
  assert.equal(reloaded.env!.NOTES_API_KEY, envValue);
  assert.equal(reloaded.headers!.Authorization, headerValue);
  assert.ok(Object.values(reloaded.secretValues!.args!).includes(argValue));
  assert.ok(Object.values(reloaded.secretValues!.url!).includes(urlValue));
  clean(JSON.stringify(fresh.list()));
});

test('private write failure keeps config byte-identical and retains new values in memory', async (t) => {
  const f = await fixture(t, async () => {
    throw new Error('injected private write failure');
  });
  const item = legacy();
  item.env = { NOTES_API_KEY: '' };
  item.headers = {};
  const original = JSON.stringify({ version: 1, items: [item] });
  await f.put(f.file, original);
  await assert.rejects(f.hub.configure('local', { NOTES_API_KEY: envValue }));
  assert.equal(await fs.readFile(f.file, 'utf8'), original);
  assert.equal((f.hub.all()[0] as McpExtension).env!.NOTES_API_KEY, envValue);
  clean(JSON.stringify(f.hub.list()));
});

for (const stage of ['private settings', 'new configuration'] as const) {
  test(`legacy migration preserves the old file when ${stage} save fails`, async (t) => {
    const f = await fixture(t);
    const oldDir = join(f.home, 'legacy');
    const oldFile = join(oldDir, 'extensions.json');
    const original = JSON.stringify({ items: [{ ...legacy([`--api-key=${argValue}`]), url }] });
    await f.put(oldFile, original);
    const hub = new ExtensionHub(f.dir, [oldDir], async (...args) => {
      assert.equal(await fs.readFile(oldFile, 'utf8'), original);
      await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
      if (stage === 'private settings') throw new Error('injected private write failure');
      await writePrivateConfig(...args);
    });
    t.after(() => hub.stopAll());
    assert.equal((hub.all()[0] as McpExtension).env!.NOTES_API_KEY, envValue);
    if (stage === 'new configuration') await fs.mkdir(`${f.file}.${process.pid}.tmp`, { recursive: true });
    await assert.rejects(hub.setEnabled('local', false));
    assert.equal(await fs.readFile(oldFile, 'utf8'), original);
    await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
    if (stage === 'private settings') await assert.rejects(fs.stat(f.secrets), { code: 'ENOENT' });
    else for (const value of values) assert.ok((await fs.readFile(f.secrets, 'utf8')).includes(value));
    const fresh = new ExtensionHub(f.dir, [oldDir]);
    t.after(() => fresh.stopAll());
    const restored = fresh.all()[0] as McpExtension;
    assert.equal(restored.env!.NOTES_API_KEY, envValue);
    assert.equal(restored.headers!.Authorization, headerValue);
    assert.ok(Object.values(restored.secretValues!.args!).includes(argValue));
    assert.ok(Object.values(restored.secretValues!.url!).includes(urlValue));
    clean(JSON.stringify(fresh.list()));
  });
}

test('legacy migration saves secrets before clean new config and reloads without its source', async (t) => {
  const f = await fixture(t);
  const oldDir = join(f.home, 'legacy');
  const oldFile = join(oldDir, 'extensions.json');
  const original = JSON.stringify({ items: [{ ...legacy([`--api-key=${argValue}`]), url }] });
  await f.put(oldFile, original);
  let privateWrites = 0;
  const hub = new ExtensionHub(f.dir, [oldDir], async (...args) => {
    privateWrites++;
    assert.equal(await fs.readFile(oldFile, 'utf8'), original);
    await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
    await writePrivateConfig(...args);
  });
  t.after(() => hub.stopAll());
  await hub.setEnabled('local', false);
  assert.equal(privateWrites, 1);
  clean(await fs.readFile(f.file, 'utf8'));
  for (const value of values) assert.ok((await fs.readFile(f.secrets, 'utf8')).includes(value));
  assert.equal(await fs.readFile(oldFile, 'utf8'), original);
  const fresh = new ExtensionHub(f.dir, []);
  t.after(() => fresh.stopAll());
  const restored = fresh.all()[0] as McpExtension;
  assert.equal(restored.env!.NOTES_API_KEY, envValue);
  assert.equal(restored.headers!.Authorization, headerValue);
  assert.ok(Object.values(restored.secretValues!.args!).includes(argValue));
  assert.ok(Object.values(restored.secretValues!.url!).includes(urlValue));
  clean(JSON.stringify(fresh.list()));
});

test('readonly legacy sources keep their plaintext even when filesystem-writable after successful saves', async (t) => {
  const f = await fixture(t);
  const oldDir = join(f.home, 'legacy');
  const oldFile = join(oldDir, 'extensions.json');
  const original = JSON.stringify({ items: [{ ...legacy([`--api-key=${argValue}`]), url }] });
  await f.put(oldFile, original);
  const before = await fs.stat(oldFile);
  const hub = new ExtensionHub(f.dir, [oldDir]);
  t.after(() => hub.stopAll());
  await hub.setEnabled('local', false);
  await hub.remove('local');
  const after = await fs.stat(oldFile);
  assert.equal(await fs.readFile(oldFile, 'utf8'), original);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.mode, before.mode);
  const fresh = new ExtensionHub(f.dir, [oldDir]);
  t.after(() => fresh.stopAll());
  assert.deepEqual(fresh.all(), [], 'the new location wins; old items must not return');
  clean(await fs.readFile(f.file, 'utf8'));
});

test('URL userinfo and every query value are private while launch syntax stays visible', async (t) => {
  const f = await fixture(t);
  const item = {
    ...legacy(),
    transport: 'http',
    url: `https://${argValue}:${urlValue}@example.invalid/mcp?first=${urlValue}&second=${envValue}`,
  };
  await f.put(f.file, JSON.stringify({ items: [item] }));
  await f.hub.setEnabled('local', false);
  const persisted = await fs.readFile(f.file, 'utf8');
  clean(persisted);
  clean(JSON.stringify(f.hub.list()));
  const stored = JSON.parse(await fs.readFile(f.secrets, 'utf8')).values.local.url as Record<string, string>;
  assert.ok(Object.values(stored).includes(`${argValue}:${urlValue}`));
  assert.ok(Object.values(stored).includes(urlValue));
  assert.ok(Object.values(stored).includes(envValue));
  assert.match(
    (f.hub.list()[0] as McpExtension).url!,
    /^https:\/\/\{\{secret:\d+\}\}@example\.invalid\/mcp\?first=\{\{secret:\d+\}\}&second=\{\{secret:\d+\}\}$/,
  );
});

test('corrupt private settings leave task startup readable and refuse mutations', async (t) => {
  const f = await fixture(t);
  const original = JSON.stringify({ items: [legacy()] });
  await f.put(f.file, original);
  await f.put(f.secrets, '{invalid');
  assert.deepEqual(f.hub.all(), []);
  assert.deepEqual(f.hub.toolNames(true), []);
  assert.equal(f.hub.skillHint('synthetic'), undefined);
  assert.deepEqual(f.hub.list(), []);
  assert.match(f.hub.list().error!, /无法读取工具配置或凭据/);
  for (const mutate of [
    () => f.hub.setEnabled('local', false),
    () => f.hub.rename('local', 'changed'),
    () => f.hub.configure('local', { NOTES_API_KEY: envValue }),
    () => f.hub.remove('local'),
    () => f.hub.install('missing', []),
    () => (f.hub as unknown as { save(): Promise<void> }).save(),
  ])
    await assert.rejects(mutate, /无法读取工具配置或凭据/);
  assert.equal(await fs.readFile(f.file, 'utf8'), original);
  assert.equal(await fs.readFile(f.secrets, 'utf8'), '{invalid');
});

test('corrupt extensions configuration leaves task startup readable and preserves both files', async (t) => {
  const f = await fixture(t);
  const privateText = JSON.stringify({ version: 1, values: { local: { env: { NOTES_API_KEY: envValue } } } });
  await f.put(f.file, '{invalid');
  await f.put(f.secrets, privateText);
  assert.deepEqual(f.hub.all(), []);
  assert.deepEqual(f.hub.toolNames(true), []);
  assert.equal(f.hub.skillHint('synthetic'), undefined);
  assert.deepEqual(f.hub.list(), []);
  clean(f.hub.list().error!);
  await assert.rejects(f.hub.setEnabled('local', true), /无法读取工具配置或凭据/);
  assert.equal(await fs.readFile(f.file, 'utf8'), '{invalid');
  assert.equal(await fs.readFile(f.secrets, 'utf8'), privateText);
});

test('private settings without values report a safe load error instead of TypeError', async (t) => {
  const f = await fixture(t);
  await f.put(f.file, JSON.stringify({ items: [legacy()] }));
  await f.put(f.secrets, JSON.stringify({ version: 1 }));
  assert.deepEqual(f.hub.all(), []);
  assert.deepEqual(f.hub.list(), []);
  assert.match(f.hub.list().error!, /无法读取工具配置或凭据/);
  await assert.rejects(f.hub.setEnabled('local', false), /无法读取工具配置或凭据/);
});

test('failed new and replacement installs restore original items and in-memory credentials', async (t) => {
  const f = await fixture(t, async () => {
    throw new Error('injected private write failure');
  });
  await f.put(f.file, JSON.stringify({ items: [legacy()] }));
  const original = f.hub.all()[0]!;
  const snapshot = structuredClone(original);
  const persisted = await fs.readFile(f.file, 'utf8');
  let checks = 0;
  f.hub.check = async () => {
    checks++;
    return [];
  };
  for (const replace of [false, true]) {
    const preview = await f.hub.preview(
      JSON.stringify({
        mcpServers: {
          added: { command: 'synthetic', env: { NOTES_API_KEY: argValue } },
        },
      }),
    );
    const key = preview.drafts[0]!.key;
    await assert.rejects(f.hub.install(preview.token, [key], {}, replace ? { [key]: { replaceId: 'local' } } : {}));
    assert.equal(f.hub.all().length, 1);
    assert.equal(f.hub.all()[0], original);
    assert.deepEqual(original, snapshot);
    assert.deepEqual(f.hub.toolNames(true), []);
    assert.equal(checks, 0);
    assert.equal(await fs.readFile(f.file, 'utf8'), persisted);
  }
});

test('config write failure after private write restores the original installation in memory', async (t) => {
  const f = await fixture(t);
  await f.put(f.file, JSON.stringify({ items: [legacy()] }));
  await f.hub.setEnabled('local', false);
  const original = f.hub.all()[0]!;
  const snapshot = structuredClone(original);
  const persisted = await fs.readFile(f.file, 'utf8');
  await fs.mkdir(`${f.file}.${process.pid}.tmp`);
  const preview = await f.hub.preview(
    JSON.stringify({
      mcpServers: {
        replacement: { command: 'synthetic', env: { NOTES_API_KEY: argValue } },
      },
    }),
  );
  const key = preview.drafts[0]!.key;
  await assert.rejects(f.hub.install(preview.token, [key], {}, { [key]: { replaceId: 'local' } }));
  assert.equal(f.hub.all()[0], original);
  assert.deepEqual(original, snapshot);
  assert.deepEqual(f.hub.toolNames(true), []);
  assert.equal(await fs.readFile(f.file, 'utf8'), persisted);
});

test('checks and concurrent sync retain both existing and newly discovered secrets', async (t) => {
  const f = await fixture(t);
  const server = await fakeServer(f.home);
  await f.put(f.file, JSON.stringify({ items: [{ ...legacy([server, `--api-key=${argValue}`]), enabled: true }] }));
  await f.put(
    f.paths.claudeConfig,
    JSON.stringify({
      mcpServers: {
        discovered: { command: 'synthetic', env: { NOTES_API_KEY: envValue }, headers: { Authorization: headerValue } },
      },
    }),
  );
  await Promise.all([f.hub.check('local'), f.hub.syncOnce(f.paths)]);
  const fresh = new ExtensionHub(f.dir, []);
  t.after(() => fresh.stopAll());
  const items = fresh.all().filter((item): item is McpExtension => item.kind === 'mcp');
  assert.equal(items.length, 2);
  assert.ok(items.every((item) => item.env!.NOTES_API_KEY === envValue));
  assert.equal(items.find((item) => item.id === 'local')!.headers!.Authorization, headerValue);
  clean(await fs.readFile(f.file, 'utf8'));
});

test('sync adopts a saved manual secret argument without merging different credentials', async (t) => {
  const f = await fixture(t);
  const definition = { command: 'synthetic', args: [`--api-key=${argValue}`], env: { NOTES_API_KEY: envValue } };
  await f.put(f.file, JSON.stringify({ items: [{ ...legacy(), ...definition, headers: undefined }] }));
  await f.hub.setEnabled('local', false);
  await f.put(f.paths.claudeConfig, JSON.stringify({ mcpServers: { local: definition } }));
  await f.hub.syncOnce(f.paths);
  assert.equal(f.hub.all().length, 1);
  assert.equal(f.hub.all()[0]!.id, 'local');
  assert.ok(f.hub.all()[0]!.sync);
  await f.put(
    f.paths.claudeConfig,
    JSON.stringify({ mcpServers: { local: definition, distinct: { ...definition, args: [`--api-key=${envValue}`] } } }),
  );
  await f.hub.syncOnce(f.paths);
  assert.equal(f.hub.all().length, 2);
  assert.equal(f.hub.all().find((item) => item.name === 'local')!.id, 'local');
  await f.put(
    f.paths.claudeConfig,
    JSON.stringify({
      mcpServers: {
        local: { ...definition, args: [`--api-key=${headerValue}`] },
        distinct: { ...definition, args: [`--api-key=${envValue}`] },
      },
    }),
  );
  await f.hub.syncOnce(f.paths);
  assert.equal(f.hub.all().length, 2);
  const changed = f.hub.all().find((item) => item.id === 'local') as McpExtension;
  assert.ok(
    Object.values(changed.secretValues!.args!).includes(`--api-key=${headerValue}`),
    'an argument-only secret update must be applied',
  );
  assert.equal(Object.values(changed.secretValues!.args!).includes(argValue), false);
  clean(await fs.readFile(f.file, 'utf8'));
});

test('unchanged checks and toggles do not rewrite secrets and removal prunes only on load', async (t) => {
  let writes = 0;
  const f = await fixture(t, async (...args) => {
    writes++;
    await writePrivateConfig(...args);
  });
  const server = await fakeServer(f.home);
  await f.put(f.file, JSON.stringify({ items: [legacy([server])] }));
  await f.hub.setEnabled('local', false);
  const first = writes;
  assert.equal(first, 1);
  await f.hub.check('local');
  await f.hub.setEnabled('local', false);
  assert.equal(writes, first);
  await f.hub.remove('local');
  assert.equal(writes, first);
  assert.ok(JSON.parse(await fs.readFile(f.secrets, 'utf8')).values.local);
  const fresh = new ExtensionHub(f.dir, []);
  assert.deepEqual(fresh.all(), []);
  await fresh.stopAll();
  assert.equal(JSON.parse(await fs.readFile(f.secrets, 'utf8')).values.local, undefined);
});
