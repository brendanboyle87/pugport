import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExtensionHub } from '../src/server/extensions.ts';
import { McpConnection } from '../src/server/mcp-client.ts';
import { discoverPaths } from '../src/server/extension-sync.ts';
import type { McpExtension } from '../src/shared/extensions.ts';

const envSecret = 'sk-synthetic-TEST-0001';
const headerSecret = 'Bearer synthetic-HDR-0002';
const argSecret = 'sk-synthetic-ARG-0003';
const urlSecret = 'synthetic-URL-0004';
const clean = (text: string) => {
  for (const value of [envSecret, headerSecret, argSecret, urlSecret])
    assert.equal(text.includes(value), false, 'secret escaped private storage');
};

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'secret-args-'));
  const previous = { ...process.env };
  const changes = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'app'),
    LOCALAPPDATA: join(home, 'local'),
    COMBORUNNER_EXTENSIONS_DIR: join(home, 'extensions'),
    COMBORUNNER_SECRETS_DIR: join(home, 'secrets'),
  };
  Object.assign(process.env, changes);
  const hub = new ExtensionHub(changes.COMBORUNNER_EXTENSIONS_DIR, []);
  hub.check = async () => [];
  t.after(async () => {
    await hub.stopAll();
    for (const key of Object.keys(changes)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  return { home, hub, file: join(changes.COMBORUNNER_EXTENSIONS_DIR, 'extensions.json') };
}

async function installedArguments(
  t: TestContext,
  args: string[],
  expected = args,
  env: Record<string, string> = {},
  fills: Record<string, string> = {},
) {
  const f = await fixture(t);
  const script = join(f.home, 'server.cjs');
  await writeFile(
    script,
    `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
    const m=JSON.parse(line); if(m.id===undefined)return;
    const result=m.method==='initialize'?{protocolVersion:'2025-06-18'}:
      {content:[{type:'text',text:String(JSON.stringify(process.argv.slice(2))===${JSON.stringify(JSON.stringify(expected))})}]};
    process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
  });`,
  );
  const preview = await f.hub.preview(
    JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [script, ...args], env } } }),
  );
  clean(JSON.stringify(preview));
  const key = preview.drafts[0]!.key;
  await f.hub.install(preview.token, [key], { [key]: fills });
  const item = f.hub.all()[0] as McpExtension;
  clean(await readFile(f.file, 'utf8'));
  clean(JSON.stringify(f.hub.list()));
  const before = JSON.stringify(item.secretValues);
  await f.hub.setEnabled(item.id, false);
  assert.equal(JSON.stringify(item.secretValues), before, 'repeated saves must keep token numbering stable');
  const connection = new McpConnection(item);
  try {
    assert.equal((await connection.callTool('verify', {})).content[0]?.text, 'true');
  } finally {
    await connection.close();
  }
  return { ...f, item };
}

test('connection-string arguments hide userinfo and query values and restore them at runtime', async (t) => {
  await installedArguments(t, [`postgresql://${envSecret}:${argSecret}@example.invalid/db?key=${urlSecret}`]);
});
for (const flag of ['--header', '-H'])
  test(`${flag} arguments are stored whole and restored at runtime`, async (t) => {
    const { item } = await installedArguments(t, [flag, `Authorization: ${headerSecret}`]);
    assert.ok(Object.values(item.secretValues!.args!).includes(`Authorization: ${headerSecret}`));
  });
test('embedded Authorization arguments are stored whole', async (t) => {
  const value = `--request-header=Authorization: ${envSecret}`;
  const { item } = await installedArguments(t, [value]);
  assert.ok(Object.values(item.secretValues!.args!).includes(value));
});
test('embedded Bearer arguments are stored whole', async (t) => {
  const value = `--request-header=${headerSecret}`;
  const { item } = await installedArguments(t, [value]);
  assert.ok(Object.values(item.secretValues!.args!).includes(value));
});
test('installation placeholder fills stay private and reach the server', async (t) => {
  const { item } = await installedArguments(t, ['<API_KEY>'], [argSecret], {}, { '<API_KEY>': argSecret });
  assert.match(item.args![1]!, /^\{\{secret:\d+\}\}$/);
  assert.ok(Object.values(item.secretValues!.args!).includes(argSecret));
});
test('ordinary env values do not rewrite transport or argument text', async (t) => {
  const { item } = await installedArguments(t, ['--transport=stdio', 'secret', 'info'], undefined, {
    TRANSPORT: 'stdio',
    MODE: 'secret',
    LOG_LEVEL: 'info',
  });
  assert.deepEqual(item.args!.slice(1), ['--transport=stdio', 'secret', 'info']);
});
test('existing secret placeholders are not rewritten by secret-named env values', async (t) => {
  const { item } = await installedArguments(t, ['--api-key=' + argSecret], undefined, { AUTH_MODE: 'secret' });
  const token = /^--api-key=\{\{secret:(\d+)\}\}$/.exec(item.args![1]!);
  assert.ok(token);
  assert.equal(item.secretValues!.args![token[1]!], argSecret);
});

test('secret-named env values embedded in ordinary arguments stay private', async (t) => {
  const { item } = await installedArguments(t, ['credential:' + envSecret], undefined, { NOTES_API_KEY: envSecret });
  assert.match(item.args![1]!, /^credential:\{\{secret:\d+\}\}$/);
});
test('synced lists hide command arguments and URLs including credentials in URL paths', async (t) => {
  const f = await fixture(t);
  const paths = discoverPaths({ platform: process.platform, home: f.home, appData: join(f.home, 'app'), env: {} });
  await mkdir(join(f.home, 'app'), { recursive: true });
  await writeFile(
    paths.claudeConfig,
    JSON.stringify({
      mcpServers: {
        remote: { url: `https://example.invalid/${urlSecret}` },
        local: { command: 'synthetic', args: [`--api-key=${argSecret}`] },
      },
    }),
  );
  await f.hub.syncOnce(paths);
  for (const item of f.hub.list())
    if (item.kind === 'mcp') {
      assert.equal(item.command, undefined);
      assert.equal(item.args, undefined);
      assert.equal(item.url, undefined);
    }
  clean(JSON.stringify(f.hub.list()));
});
