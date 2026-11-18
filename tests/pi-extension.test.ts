import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const extensionUrl = pathToFileURL(join(process.cwd(), 'src', 'server', 'pi-extension.mjs')).href;
const {
  default: extension,
  commandForTrustedTurn,
  describePiToolCall,
  registerPiHostBridge,
  registerPiBudgetGuard,
} = await import(extensionUrl);

type Row = Record<string, any>;
test('standalone Pi default fetch refuses the owner live app port', async () => {
  await assert.rejects(
    registerPiHostBridge(
      {},
      {
        COMBORUNNER_AGENT_BRIDGE_URL: 'http://127.0.0.1:4317/mcp',
        COMBORUNNER_AGENT_BRIDGE_TOKEN: 'synthetic-token',
        COMBORUNNER_AGENT_BRIDGE_TOOLS: '[]',
      },
    ),
    /PugPort under test: refused network request/,
  );
});

function extensionFixture() {
  const handlers: Row = {},
    tools: Row = {},
    commands: Row = {};
  return {
    handlers,
    tools,
    commands,
    api: {
      on: (name: string, handler: any) => {
        handlers[name] = handler;
      },
      registerTool: (tool: Row) => {
        tools[tool.name] = tool;
      },
      registerCommand: (name: string, definition: Row) => {
        commands[name] = definition;
      },
    },
  };
}

for (const format of ['application/json', 'text/event-stream']) {
  test(`Pi bridge registers host-granted schemas and forwards arguments and ${format} results`, async (t) => {
    const timeouts: number[] = [];
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
      timeouts.push(milliseconds);
      return timeout(milliseconds);
    });
    const f = extensionFixture();
    const requests: Row[] = [];
    const env = {
      COMBORUNNER_AGENT_BRIDGE_URL: 'http://127.0.0.1:4317/mcp',
      COMBORUNNER_AGENT_BRIDGE_TOKEN: 'fixture-token',
      COMBORUNNER_AGENT_BRIDGE_TOOLS: '["delegate","get_result"]',
    };
    const tools = ['delegate', 'get_result'].map((name) => ({
      name,
      description: `${name} synthetic description`,
      inputSchema: { type: 'object', properties: { task: { type: 'string' } }, additionalProperties: false },
    }));
    const fetchImpl = (async (_url, options) => {
      assert.equal(options?.redirect, 'error');
      assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer fixture-token');
      assert.equal(new Headers(options?.headers).get('Accept'), 'application/json, text/event-stream');
      const request = JSON.parse(String(options?.body));
      requests.push(request);
      const result =
        request.method === 'tools/list' ? { tools } : { content: [{ type: 'text', text: 'child result' }] };
      const packet = JSON.stringify({ jsonrpc: '2.0', id: request.id, result });
      return new Response(
        format === 'text/event-stream'
          ? `: keepalive\r\n\r\nevent: message\r\ndata: {"result":{"ignored":true}}\r\n\r\nevent: message\r\ndata: ${packet}\r\n\r\n: keepalive\r\n\r\n`
          : packet,
        { headers: { 'Content-Type': `${format}; charset=utf-8` } },
      );
    }) as typeof fetch;
    assert.deepEqual(
      [...(await registerPiHostBridge(f.api, env, fetchImpl))],
      ['pugport_delegate', 'pugport_get_result'],
    );
    assert.deepEqual(f.tools.pugport_delegate.parameters, tools[0]!.inputSchema);
    assert.equal(f.tools.pugport_write, undefined);
    assert.equal(typeof f.commands['studio-host-bridge-v1'].handler, 'function');
    const result = await f.tools.pugport_delegate.execute(
      'native-call-id',
      { task: 'only this bounded task' },
      new AbortController().signal,
      undefined,
      {},
    );
    assert.deepEqual(requests[1]?.params, { name: 'delegate', arguments: { task: 'only this bounded task' } });
    assert.deepEqual(result.content, [{ type: 'text', text: 'child result' }]);
    assert.equal(result.details.nativeToolCallId, 'native-call-id');
    assert.equal(timeouts.at(-1), 660_000, 'Bridge calls outlast the ten-minute owner confirmation window.');
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(f.tools.pugport_get_result.execute('cancelled', {}, abort.signal, undefined, {}));
    assert.equal(requests.length, 2, 'Cancelled native calls cannot send a new host request.');
  });
}

test('Pi bridge rejects expired authorization, catalogue changes and host operation denials', async () => {
  const env = {
    COMBORUNNER_AGENT_BRIDGE_URL: 'http://127.0.0.1:4317/mcp',
    COMBORUNNER_AGENT_BRIDGE_TOKEN: 'fixture-token',
    COMBORUNNER_AGENT_BRIDGE_TOOLS: '["delegate"]',
  };
  const denied = (async () => new Response('{}', { status: 401 })) as typeof fetch;
  await assert.rejects(registerPiHostBridge(extensionFixture().api, env, denied), /authorization/);
  await assert.rejects(
    registerPiHostBridge(
      extensionFixture().api,
      { ...env, COMBORUNNER_AGENT_BRIDGE_URL: 'https://example.test/mcp' },
      denied,
    ),
    /permission/,
  );
  await assert.rejects(
    registerPiHostBridge(
      extensionFixture().api,
      env,
      (async () => new Response(JSON.stringify({ result: { tools: [] } }))) as typeof fetch,
    ),
    /catalogue changed/,
  );
  const f = extensionFixture();
  const fetchImpl = (async (_url, options) => {
    const packet = JSON.parse(String(options?.body));
    return new Response(
      JSON.stringify({
        result:
          packet.method === 'tools/list'
            ? {
                tools: [{ name: 'delegate', inputSchema: { type: 'object', properties: {} } }],
              }
            : { isError: true, content: [{ type: 'text', text: 'The parent has read-only permission.' }] },
      }),
    );
  }) as typeof fetch;
  await registerPiHostBridge(f.api, env, fetchImpl);
  await assert.rejects(
    f.tools.pugport_delegate.execute('denied', { write: true }, undefined, undefined, {}),
    /read-only/,
  );
});

test('Pi bridge retains protocol errors and the 8 MB limit for JSON and SSE', async () => {
  const env = {
    COMBORUNNER_AGENT_BRIDGE_URL: 'http://127.0.0.1:5555/mcp',
    COMBORUNNER_AGENT_BRIDGE_TOKEN: 'synthetic-token',
    COMBORUNNER_AGENT_BRIDGE_TOOLS: '[]',
  };
  for (const format of ['application/json', 'text/event-stream']) {
    for (const [packet, expected] of [
      ['{"error":{"code":-32603}}', /host tool request failed/],
      ['{}', /host tool request failed/],
      ['invalid JSON', /Unexpected token/],
      [' '.repeat(8 * 1024 * 1024 + 1), /exceeded the protocol limit/],
    ] as const) {
      const fetchImpl = async () =>
        new Response(format === 'text/event-stream' ? `: keepalive\n\ndata: ${packet}\n\n` : packet, {
          headers: { 'Content-Type': format },
        });
      await assert.rejects(registerPiHostBridge(extensionFixture().api, env, fetchImpl), expected);
    }
  }
});

test('Pi readonly extension keeps native reads but refuses writes, shell and unregistered host names', async () => {
  const prior = process.env.COMBORUNNER_PI_PERMISSION_MODE;
  let f: ReturnType<typeof bridge>;
  try {
    process.env.COMBORUNNER_PI_PERMISSION_MODE = 'read-only';
    f = bridge('auto');
  } finally {
    if (prior === undefined) delete process.env.COMBORUNNER_PI_PERMISSION_MODE;
    else process.env.COMBORUNNER_PI_PERMISSION_MODE = prior;
  }
  const ctx = { cwd: process.cwd(), hasUI: false };
  for (const toolName of ['read', 'grep', 'find', 'ls'])
    assert.equal(await f.handler({ toolName, input: {} }, ctx), undefined);
  for (const toolName of ['write', 'edit', 'bash', 'powershell', 'pugport_delegate'])
    assert.equal((await f.handler({ toolName, input: {} }, ctx))?.block, true);
});

test('Pi budget guard aborts the request signal before a new provider call and blocks later tools', () => {
  const f = extensionFixture(),
    abort = new AbortController();
  const notifications: string[] = [];
  const ctx = {
    signal: abort.signal,
    abort: () => abort.abort(),
    ui: { notify: (text: string) => notifications.push(text) },
  };
  registerPiBudgetGuard(f.api, { maxCostUsd: 1 });
  assert.equal(typeof f.commands['studio-api-budget-v1'].handler, 'function');
  f.handlers.message_end({ message: { role: 'assistant', usage: { cost: { total: 0.4 } } } }, ctx);
  assert.equal(abort.signal.aborted, false);
  f.handlers.message_end({ message: { role: 'assistant', usage: { cost: { total: 0.6 } } } }, ctx);
  assert.equal(abort.signal.aborted, true);
  assert.deepEqual(notifications, ['api-budget-exhausted']);
  assert.throws(() => f.handlers.before_provider_request({ payload: {} }, ctx));
  assert.equal(f.handlers.tool_call({}, ctx).block, true);
});

test('Pi budget guard does not treat missing costs as free and checks cutoff before a request', () => {
  for (const reason of ['api-budget-usage-unknown', 'api-budget-expired']) {
    const f = extensionFixture(),
      abort = new AbortController();
    const notifications: string[] = [];
    const ctx = {
      signal: abort.signal,
      abort: () => abort.abort(),
      ui: { notify: (text: string) => notifications.push(text) },
    };
    registerPiBudgetGuard(
      f.api,
      { maxCostUsd: 1, ...(reason === 'api-budget-expired' ? { expiresAt: new Date(1000).toISOString() } : {}) },
      () => 1001,
    );
    if (reason === 'api-budget-expired') assert.throws(() => f.handlers.before_provider_request({}, ctx));
    else f.handlers.message_end({ message: { role: 'assistant' } }, ctx);
    assert.equal(abort.signal.aborted, true);
    assert.deepEqual(notifications, [reason]);
  }
  assert.throws(() => registerPiBudgetGuard(extensionFixture().api, { maxCostUsd: -1 }), /permission/);
});
function bridge(approvalMode?: string, trustedCommands = false) {
  let handler!: (event: Row, ctx: Row) => Promise<Row | undefined>;
  const commands: Row = {};
  const original = process.env.COMBORUNNER_TOOL_APPROVAL_MODE;
  try {
    if (approvalMode === undefined) delete process.env.COMBORUNNER_TOOL_APPROVAL_MODE;
    else process.env.COMBORUNNER_TOOL_APPROVAL_MODE = approvalMode;
    if (trustedCommands) process.env.COMBORUNNER_PI_TRUSTED_COMMANDS = '1';
    extension({
      on: (name: string, fn: typeof handler) => {
        assert.equal(name, 'tool_call');
        handler = fn;
      },
      registerCommand: (name: string, details: Row) => {
        commands[name] = details;
      },
    });
  } finally {
    if (original === undefined) delete process.env.COMBORUNNER_TOOL_APPROVAL_MODE;
    else process.env.COMBORUNNER_TOOL_APPROVAL_MODE = original;
    delete process.env.COMBORUNNER_PI_TRUSTED_COMMANDS;
  }
  return { handler, commands };
}
async function cleanup(root: string) {
  const path = resolve(root);
  assert.ok(path.startsWith(resolve(tmpdir()) + sep) && basename(path).startsWith('studio-pi-permissions-'));
  await rm(path, { recursive: true, force: true });
}

test('Pi permission extension registers a verifiable marker and blocks without a UI', async () => {
  const { handler, commands } = bridge();
  assert.equal(typeof commands['studio-permissions-v1'].handler, 'function');
  const result = await handler({ toolName: 'read', input: { path: '.' } }, { cwd: process.cwd(), hasUI: false });
  assert.equal(result?.block, true);
});

test('Pi permission extension awaits per-call approval, blocks denial and exceptions', async () => {
  const { handler } = bridge();
  const event = { toolName: 'write', toolCallId: 'write-call', input: { path: 'example.txt', content: 'hello' } };
  for (const allowed of [false, true]) {
    let called = 0;
    const result = await handler(event, {
      cwd: process.cwd(),
      hasUI: true,
      signal: new AbortController().signal,
      ui: {
        confirm: async (title: string, message: string) => {
          called++;
          assert.match(title, /write/);
          assert.match(message, /write-call/);
          assert.match(message, /hello/);
          return allowed;
        },
      },
    });
    assert.equal(called, 1);
    assert.equal(result?.block, allowed ? undefined : true);
  }
  const failed = await handler(event, {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      confirm: async () => {
        throw new Error('closed');
      },
    },
  });
  assert.equal(failed?.block, true);
});

test('Pi extension cancellation wins over a late approval and unknown tools fail closed', async () => {
  const { handler } = bridge();
  const controller = new AbortController();
  const result = await handler(
    { toolName: 'bash', input: { command: 'echo test' } },
    {
      cwd: process.cwd(),
      hasUI: true,
      signal: controller.signal,
      ui: {
        confirm: async () => {
          controller.abort();
          return true;
        },
      },
    },
  );
  assert.equal(result?.block, true);
  let confirmations = 0;
  const unknown = await handler(
    { toolName: 'unregistered-network-tool', input: {} },
    {
      cwd: process.cwd(),
      hasUI: true,
      ui: {
        confirm: async () => {
          confirmations++;
          return true;
        },
      },
    },
  );
  assert.equal(unknown?.block, true);
  assert.equal(confirmations, 0);
  const oversized = await handler(
    { toolName: 'bash', input: { command: 'x'.repeat(12001) } },
    {
      cwd: process.cwd(),
      hasUI: true,
      ui: {
        confirm: async () => {
          confirmations++;
          return true;
        },
      },
    },
  );
  assert.equal(oversized?.block, true);
  assert.equal(confirmations, 0);
});

test('Pi edit approval previews the installed multi-edit schema', async () => {
  const preview = await describePiToolCall(
    {
      toolName: 'edit',
      input: {
        path: 'example.txt',
        edits: [
          { oldText: 'old-one', newText: 'new-one' },
          { oldText: 'old-two', newText: 'new-two' },
        ],
      },
    },
    process.cwd(),
  );
  assert.match(preview.message, /共 2 处替换/);
  for (const text of ['old-one', 'new-one', 'old-two', 'new-two']) assert.ok(preview.message.includes(text));
  await assert.rejects(
    describePiToolCall(
      { toolName: 'edit', input: { path: 'example.txt', oldText: 'legacy', newText: 'unsupported' } },
      process.cwd(),
    ),
    /Missing edit/,
  );
});

test('Pi extension labels existing and future paths outside the project, including symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-pi-permissions-'));
  try {
    const project = join(root, 'project'),
      external = join(root, 'external');
    await mkdir(project);
    await mkdir(external);
    const inside = await describePiToolCall(
      { toolName: 'write', input: { path: 'new/future.txt', content: 'ok' } },
      project,
    );
    assert.match(inside.title, /工作区内写入/);
    const outside = await describePiToolCall(
      { toolName: 'write', input: { path: '../external/future.txt', content: 'ok' } },
      project,
    );
    assert.match(outside.title, /工作区外写入/);
    await symlink(external, join(project, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const linked = await describePiToolCall(
      { toolName: 'write', input: { path: 'link/future.txt', content: 'ok' } },
      project,
    );
    assert.match(linked.title, /工作区外写入/);
    assert.match(linked.message, /external/);
    const shell = await describePiToolCall(
      { toolName: 'powershell', input: { command: 'Write-Output example' } },
      project,
    );
    assert.match(shell.message, /Write-Output example/);
    assert.match(shell.message, /没有操作系统沙箱/);
  } finally {
    await cleanup(root);
  }
});

test('Pi auto mode accepts validated workspace file tools without an approval UI', async () => {
  const { handler } = bridge('auto');
  let confirmations = 0;
  const ctx = {
    cwd: process.cwd(),
    hasUI: false,
    ui: {
      confirm: async () => {
        confirmations++;
        return false;
      },
    },
  };
  for (const toolName of ['read', 'grep', 'find', 'ls', 'write', 'edit']) {
    const input = {
      path: 'future/subdirectory/file.txt',
      content: 'new content',
      edits: [{ oldText: 'before', newText: 'after' }],
    };
    assert.equal(await handler({ toolName, input }, ctx), undefined, toolName);
  }
  assert.equal(confirmations, 0);
});

test('Pi auto mode denies external and linked paths, shell and unknown tools without prompting', async () => {
  const notifications: string[] = [];
  const root = await mkdtemp(join(tmpdir(), 'studio-pi-permissions-'));
  try {
    const project = join(root, 'project'),
      external = join(root, 'external');
    await mkdir(project);
    await mkdir(external);
    await symlink(external, join(project, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const { handler } = bridge('auto');
    let confirmations = 0;
    const ctx = {
      cwd: project,
      hasUI: true,
      ui: {
        notify: (message: string) => notifications.push(message),
        confirm: async () => {
          confirmations++;
          return true;
        },
      },
    };
    for (const path of ['../external/future.txt', join(external, 'absolute.txt'), 'link/future.txt']) {
      const result = await handler({ toolName: 'write', input: { path, content: 'no' } }, ctx);
      assert.equal(result?.block, true);
      assert.match(result?.reason, /工作区之外/);
    }
    for (const toolName of ['bash', 'powershell']) {
      const result = await handler({ toolName, toolCallId: toolName, input: { command: 'echo do not execute' } }, ctx);
      assert.equal(result?.block, true);
      assert.match(result?.reason, /Codex 原生执行器/);
    }
    const unknown = await handler({ toolName: 'custom-tool', input: {} }, ctx);
    assert.equal(unknown?.block, true);
    assert.match(unknown?.reason, /无法验证此工具/);
    assert.equal(confirmations, 0);
    assert.deepEqual(notifications, ['pugport-command-untrusted:bash', 'pugport-command-untrusted:powershell']);
  } finally {
    await cleanup(root);
  }
});

test('Pi auto policy is captured from the host environment, ignores model overrides and honors cancellation', async () => {
  let confirmations = 0;
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      confirm: async () => {
        confirmations++;
        return false;
      },
    },
  };
  const event = {
    toolName: 'write',
    approvalMode: 'auto',
    input: { path: 'example.txt', content: 'ok', approvalMode: 'auto', COMBORUNNER_TOOL_APPROVAL_MODE: 'auto' },
  };
  // Absent and invalid host configuration stay in ask mode even if the model asks for auto.
  for (const mode of [undefined, 'invalid', 'AUTO']) {
    const result = await bridge(mode).handler(event, ctx);
    assert.equal(result?.block, true);
  }
  assert.equal(confirmations, 3);
  const automatic = bridge('auto');
  assert.equal(await automatic.handler({ ...event, approvalMode: 'ask' }, ctx), undefined);
  assert.equal(confirmations, 3);
  const signal = new AbortController();
  signal.abort();
  const cancelled = await automatic.handler(event, { ...ctx, signal: signal.signal });
  assert.equal(cancelled?.block, true);
  assert.match(cancelled?.reason, /cancelled/);
  const invalid = await automatic.handler({ toolName: 'write', input: { path: 'bad\0path' } }, ctx);
  assert.equal(invalid?.block, true);
});
test('Pi registers Git and GitHub host tools and allows them in read-only mode', async (t) => {
  const f = extensionFixture();
  const configured = {
    COMBORUNNER_PI_PERMISSION_MODE: 'read-only',
    COMBORUNNER_AGENT_BRIDGE_URL: 'http://127.0.0.1:5555/mcp',
    COMBORUNNER_AGENT_BRIDGE_TOKEN: 'synthetic',
    COMBORUNNER_AGENT_BRIDGE_TOOLS: '["git","github_list_issues"]',
  };
  const previous = Object.fromEntries(Object.keys(configured).map((key) => [key, process.env[key]]));
  const tools = ['git', 'github_list_issues'].map((name) => ({
    name,
    description: 'synthetic',
    inputSchema: { type: 'object' },
    annotations: { readOnlyHint: true },
  }));
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: any) => {
    const request = JSON.parse(options.body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools } }));
  });
  try {
    Object.assign(process.env, configured);
    await extension(f.api);
    for (const name of ['pugport_git', 'pugport_github_list_issues']) {
      assert.ok(f.tools[name]);
      assert.equal(
        await f.handlers.tool_call({ toolName: name, input: {} }, { hasUI: false, cwd: process.cwd() }),
        undefined,
      );
    }
    assert.equal((await f.handlers.tool_call({ toolName: 'bash', input: {} }, { hasUI: false }))?.block, true);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Pi auto mode runs commands only on a writable turn in a trusted project', async () => {
  const ctx = { cwd: process.cwd(), hasUI: false, ui: { confirm: async () => false } };
  const command = { toolName: 'bash', input: { command: 'echo harmless' } };
  // PugPort sets the marker only when trustedCommandTurn holds; the extension then lets Pi run the command.
  assert.equal(await bridge('auto', true).handler(command, ctx), undefined);
  assert.equal(
    await bridge('auto', true).handler({ toolName: 'powershell', input: { command: 'Get-Date' } }, ctx),
    undefined,
  );
  assert.equal((await bridge('auto', true).handler({ toolName: 'bash', input: { command: ' ' } }, ctx))?.block, true);
  // A user's "no commands" still wins over a trusted turn.
  process.env.COMBORUNNER_PI_PROHIBIT_COMMANDS = '1';
  try {
    const prohibited = await bridge('auto', true).handler(command, ctx);
    assert.equal(prohibited?.block, true);
  } finally {
    delete process.env.COMBORUNNER_PI_PROHIBIT_COMMANDS;
  }
  const untrusted = await bridge('auto').handler(command, ctx);
  assert.equal(untrusted?.block, true);
  assert.match(untrusted?.reason, /不执行 Pi shell/);
});

test('a trusted turn hides credentials and PugPort variables from commands and restores the user home', async () => {
  const env = {
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'synthetic-key',
    OPENAI_APIKEY: 'synthetic-key',
    COMBORUNNER_AGENT_BRIDGE_TOKEN: 'synthetic-token',
    ELECTRON_RUN_AS_NODE: '1',
    GH_TOKEN: 'kept',
    COMBORUNNER_PI_USER_HOME: JSON.stringify({ HOME: "/home/o'brien", 'BAD NAME': 'x' }),
  };
  const bash = commandForTrustedTurn('bash', 'npm test', env);
  assert.equal(
    bash,
    "unset ANTHROPIC_API_KEY OPENAI_APIKEY COMBORUNNER_AGENT_BRIDGE_TOKEN ELECTRON_RUN_AS_NODE COMBORUNNER_PI_USER_HOME\nexport HOME='/home/o'\\''brien'\nnpm test",
  );
  assert.doesNotMatch(bash, /synthetic-key|GH_TOKEN/);
  const powershell = commandForTrustedTurn('powershell', 'npm test', env);
  assert.match(powershell, /Remove-Item -LiteralPath Env:ANTHROPIC_API_KEY/);
  assert.match(powershell, /\$env:HOME = '\/home\/o''brien'; npm test$/);
  // The extension rewrites the command it lets through.
  const event = { toolName: 'bash', input: { command: 'echo harmless' } };
  const ctx = { cwd: process.cwd(), hasUI: false, ui: { confirm: async () => false } };
  assert.equal(await bridge('auto', true).handler(event, ctx), undefined);
  assert.match(event.input.command, /^unset .*\necho harmless$|^echo harmless$/s);
});
