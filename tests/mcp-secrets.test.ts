import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { McpConnection } from '../src/server/mcp-client.ts';
import type { McpExtension } from '../src/shared/extensions.ts';

const envSecret = 'sk-synthetic-TEST-0001';
const headerSecret = 'Bearer synthetic-HDR-0002';
const argSecret = 'sk-synthetic-ARG-0003';
const urlSecret = 'synthetic-URL-0004';
const base = {
  kind: 'mcp',
  id: 'secrets-test',
  name: 'fixture',
  source: 'fixture',
  enabled: true,
  installedAt: '',
} as const;
const config = (): McpExtension => ({
  ...base,
  transport: 'http',
  url: 'https://example.invalid/mcp?key={{secret:1}}',
  env: { NOTES_API_KEY: envSecret },
  headers: { Authorization: headerSecret },
  args: ['--api-key={{secret:1}}'],
  secretValues: { args: { '1': argSecret }, url: { '1': urlSecret } },
});
const echoed = [envSecret, headerSecret, argSecret, urlSecret].join(' ');
const checkSafe = (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.match(error.message, /\*\*\*/);
  for (const secret of [envSecret, headerSecret, argSecret, urlSecret]) assert.ok(!error.message.includes(secret));
  assert.ok(!error.stack?.includes(envSecret));
  return true;
};

async function mocked(
  run: (connection: McpConnection, calls: { url: string; init?: RequestInit }[]) => Promise<void>,
  response: (message: any) => Response,
) {
  const previous = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (init?.method === 'DELETE') return new Response(null, { status: 202 });
    const message = JSON.parse(String(init?.body));
    if (message.id === undefined) return new Response(null, { status: 202 });
    if (message.method === 'initialize')
      return Response.json(
        { id: message.id, result: { protocolVersion: '2025-06-18' } },
        { headers: { 'mcp-session-id': 'fixture' } },
      );
    return response(message);
  };
  const connection = new McpConnection(config());
  try {
    await run(connection, calls);
  } finally {
    await connection.close();
    globalThis.fetch = previous;
  }
}

test('runtime fills URL and header credentials without mutating config, including session DELETE', async () => {
  await mocked(
    async (connection, calls) => {
      await connection.start();
      await connection.close();
      assert.ok(calls.every((call) => call.url === 'https://example.invalid/mcp?key=synthetic-URL-0004'));
      assert.ok(calls.every((call) => new Headers(call.init?.headers).get('Authorization') === headerSecret));
      assert.equal(calls.at(-1)?.init?.method, 'DELETE');
      assert.equal(connection.config.url, 'https://example.invalid/mcp?key={{secret:1}}');
      assert.deepEqual(connection.config.args, ['--api-key={{secret:1}}']);
    },
    () => new Response(null, { status: 202 }),
  );
});

test('JSON-RPC errors and isError content redact secrets while successful content and schemas remain unchanged', async () => {
  await mocked(
    async (connection) => {
      const tools = await connection.listTools();
      assert.equal(tools[0]?.name, `get_${envSecret}`);
      assert.deepEqual(tools[0]?.inputSchema, { description: envSecret });
      assert.equal((await connection.callTool('success', {})).content[0]?.text, echoed);
      const failure = await connection.callTool('failure', {});
      assert.equal(failure.isError, true);
      assert.equal(failure.content[0]?.text, 'context *** *** *** ***');
      await assert.rejects(connection.callTool('rpc', {}), checkSafe);
    },
    (message) =>
      Response.json({
        id: message.id,
        ...(message.method === 'tools/list'
          ? { result: { tools: [{ name: `get_${envSecret}`, inputSchema: { description: envSecret } }] } }
          : message.params.name === 'rpc'
            ? { error: { message: `context ${echoed}` } }
            : {
                result: {
                  isError: message.params.name === 'failure',
                  content: [{ type: 'text', text: message.params.name === 'failure' ? `context ${echoed}` : echoed }],
                },
              }),
      }),
  );
});

test('HTTP transport exceptions, validation errors and abort reasons are redacted', async () => {
  await mocked(
    async (connection) => {
      await connection.start();
      await assert.rejects(
        connection.callTool('x', {}, undefined, () => {
          throw new Error(echoed);
        }),
        checkSafe,
      );
      const controller = new AbortController();
      controller.abort(new Error(echoed));
      await assert.rejects(connection.callTool('x', {}, controller.signal), checkSafe);
      globalThis.fetch = async () => {
        throw Object.assign(new Error(echoed), { status: 503 });
      };
      await assert.rejects(connection.callTool('x', {}), (error) => {
        checkSafe(error);
        assert.equal((error as Error & { status: number }).status, 503);
        return true;
      });
    },
    () => new Response(null, { status: 202 }),
  );
});

test('runtime expands process variables and reports missing variable names without contacting HTTP', async () => {
  const previous = process.env.BATCH3_SYNTHETIC;
  const fetch = globalThis.fetch;
  try {
    process.env.BATCH3_SYNTHETIC = envSecret;
    const aborted = new AbortController();
    aborted.abort(new Error(envSecret));
    const unstarted = new McpConnection({ ...config(), env: {}, headers: { Authorization: '${BATCH3_SYNTHETIC}' } });
    await assert.rejects(unstarted.callTool('never-start', {}, aborted.signal), checkSafe);
    globalThis.fetch = async (_url, init) => {
      assert.equal(new Headers(init?.headers).get('Authorization'), envSecret);
      const message = JSON.parse(String(init?.body));
      if (message.id === undefined) return new Response(null, { status: 202 });
      return Response.json({ id: message.id, result: { protocolVersion: '2025-06-18' } });
    };
    const connection = new McpConnection({ ...config(), headers: { Authorization: '${BATCH3_SYNTHETIC}' } });
    await connection.start();
    await connection.close();
    assert.equal(connection.config.headers?.Authorization, '${BATCH3_SYNTHETIC}');
    delete process.env.BATCH3_SYNTHETIC;
    globalThis.fetch = async () => {
      assert.fail('missing variable must not reach transport');
    };
    await assert.rejects(
      new McpConnection({ ...config(), headers: { Authorization: '${BATCH3_SYNTHETIC}' } }).start(),
      { message: '需要设置环境变量 BATCH3_SYNTHETIC，或在这里填写它的值' },
    );
    await assert.rejects(new McpConnection({ ...config(), secretValues: {} }).start(), /工具凭据缺失/);
  } finally {
    globalThis.fetch = fetch;
    if (previous === undefined) delete process.env.BATCH3_SYNTHETIC;
    else process.env.BATCH3_SYNTHETIC = previous;
  }
});

test('stdio receives filled argument and env while split stderr secrets are redacted with context retained', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-secrets-'));
  const file = join(directory, 'server.cjs');
  writeFileSync(
    file,
    `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') process.stdout.write(JSON.stringify({id: message.id, result: {protocolVersion: '2025-06-18'}})+'\\n');
      if (message.method === 'tools/call') {
        const secret = process.env.NOTES_API_KEY;
        if (message.params.name === 'delivery') process.stdout.write(JSON.stringify({id: message.id, result: {content: [{type: 'text', text: JSON.stringify({env: secret === ${JSON.stringify(envSecret)}, arg: process.argv[2] === ${JSON.stringify('--api-key=' + argSecret)}})}]}})+'\\n');
        else { process.stderr.write('before ' + secret.slice(0, 7)); setTimeout(() => { process.stderr.write(secret.slice(7) + ' after\\n'); process.exit(1); }, 20); }
      }
    });
  `,
  );
  const connection = new McpConnection({
    ...config(),
    transport: 'stdio',
    command: process.execPath,
    args: [file, '--api-key={{secret:1}}'],
  });
  try {
    assert.deepEqual(JSON.parse(String((await connection.callTool('delivery', {})).content[0]?.text)), {
      env: true,
      arg: true,
    });
    await assert.rejects(connection.callTool('exit', {}), (error) => {
      checkSafe(error);
      assert.match((error as Error).message, /before \*\*\* after/);
      return true;
    });
  } finally {
    await connection.close();
  }
});

for (const state of ['set', 'unset', 'empty'] as const)
  test(`runtime default expansion uses only process environment when variable is ${state}`, async () => {
    const variable = 'BATCH3_DEFAULT_VALUE';
    const previous = process.env[variable];
    const originalFetch = globalThis.fetch;
    const expected = state === 'set' ? envSecret : argSecret;
    if (state === 'unset') delete process.env[variable];
    else process.env[variable] = state === 'set' ? envSecret : '';
    const expression = '${' + variable + ':-' + argSecret + '}';
    const connection = new McpConnection({
      ...base,
      transport: 'http',
      url: 'https://example.invalid/mcp?key=' + expression,
      env: { [variable]: headerSecret, LOG_LEVEL: 'info' },
      headers: { Authorization: expression },
    });
    globalThis.fetch = async (url, init) => {
      assert.ok(String(url) === 'https://example.invalid/mcp?key=' + expected);
      assert.ok(new Headers(init?.headers).get('Authorization') === expected);
      const message = JSON.parse(String(init?.body));
      if (message.id === undefined) return new Response(null, { status: 202 });
      return Response.json({
        id: message.id,
        result:
          message.method === 'initialize'
            ? { protocolVersion: '2025-06-18' }
            : { isError: true, content: [{ type: 'text', text: 'get_info ' + expected }] },
      });
    };
    try {
      const result = await connection.callTool('get_info', {});
      assert.equal(result.isError, true);
      assert.equal(result.content[0]?.text, 'get_info ***');
      assert.equal(connection.config.headers!.Authorization, expression);
    } finally {
      await connection.close();
      globalThis.fetch = originalFetch;
      if (previous === undefined) delete process.env[variable];
      else process.env[variable] = previous;
    }
  });

test('empty defaults are accepted and missing variables without defaults still fail safely', async () => {
  const previous = process.env.BATCH3_EMPTY_DEFAULT;
  const originalFetch = globalThis.fetch;
  delete process.env.BATCH3_EMPTY_DEFAULT;
  globalThis.fetch = async (_url, init) => {
    assert.equal(new Headers(init?.headers).get('X-Optional'), '');
    const message = JSON.parse(String(init?.body));
    return message.id === undefined
      ? new Response(null, { status: 202 })
      : Response.json({ id: message.id, result: { protocolVersion: '2025-06-18' } });
  };
  const connection = new McpConnection({
    ...base,
    transport: 'http',
    url: 'https://example.invalid/mcp',
    headers: { 'X-Optional': '${BATCH3_EMPTY_DEFAULT:-}' },
  });
  try {
    await connection.start();
    await assert.rejects(
      new McpConnection({ ...connection.config, headers: { 'X-Optional': '${BATCH3_EMPTY_DEFAULT}' } }).start(),
      { message: '需要设置环境变量 BATCH3_EMPTY_DEFAULT，或在这里填写它的值' },
    );
  } finally {
    await connection.close();
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.BATCH3_EMPTY_DEFAULT;
    else process.env.BATCH3_EMPTY_DEFAULT = previous;
  }
});

test('isError redacts secrets but preserves LOG_LEVEL info and ordinary header values', async () => {
  await mocked(
    async (connection) => {
      connection.config.env!.LOG_LEVEL = 'info';
      connection.config.headers!['X-Mode'] = 'info';
      // A fresh connection collects the final configuration, as the hub does.
      const configured = new McpConnection(connection.config);
      try {
        const failure = await configured.callTool('get_info', {});
        assert.equal(failure.content[0]?.text, 'get_info *** *** *** ***');
      } finally {
        await configured.close();
      }
    },
    (message) =>
      Response.json({
        id: message.id,
        result: { isError: true, content: [{ type: 'text', text: 'get_info ' + echoed }] },
      }),
  );
});
