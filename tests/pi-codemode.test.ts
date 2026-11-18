import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
  type ExtensionUIContext,
} from '@earendil-works/pi-coding-agent';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type JsonObject,
  type Model,
} from '@earendil-works/pi-ai';
import { loadQuickJSWasm } from '@earendil-works/pi-codemode';

await loadQuickJSWasm();
const { default: studioPermissions, registerPiBudgetGuard } = await import(
  pathToFileURL(join(process.cwd(), 'src/server/pi-extension.mjs')).href
);

type Call = { type: 'toolCall'; id: string; name: string; arguments: JsonObject };
const call = (id: string, name: string, args: JsonObject): Call => ({
  type: 'toolCall',
  id,
  name,
  arguments: args,
});
const model: Model<'openai-completions'> = {
  id: 'synthetic-codemode',
  name: 'Synthetic Code Mode',
  api: 'openai-completions',
  provider: 'pugport-codemode-test',
  baseUrl: 'http://127.0.0.1:1/never-requested',
  reasoning: false,
  input: ['text'],
  contextWindow: 100000,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const text = (value: { content?: Array<{ type: string; text?: string }> }) =>
  value.content
    ?.filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n') ?? '';

async function fixture(
  t: TestContext,
  options: {
    readOnly?: boolean;
    ask?: boolean;
    confirm?: ExtensionUIContext['confirm'];
    extra?: ExtensionFactory;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'pugport-codemode-'));
  const savedExecArgv = process.execArgv;
  process.execArgv = [];
  t.after(() => {
    process.execArgv = savedExecArgv;
  });
  const cwd = join(root, 'workspace');
  const agentDir = join(root, 'agent');
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment: Record<string, string | undefined> = {
    COMBORUNNER_PI_CODEMODE: 'on',
    COMBORUNNER_PI_PERMISSION_MODE: options.readOnly ? 'read-only' : 'workspace-write',
    COMBORUNNER_TOOL_APPROVAL_MODE: options.ask ? 'ask' : 'auto',
    COMBORUNNER_PI_API_BUDGET: undefined,
    COMBORUNNER_AGENT_BRIDGE_URL: undefined,
    COMBORUNNER_AGENT_BRIDGE_TOKEN: undefined,
    COMBORUNNER_AGENT_BRIDGE_TOOLS: undefined,
  };
  const saved = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [studioPermissions, ...(options.extra ? [options.extra] : [])],
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: null,
    modelsStorePath: join(agentDir, 'models-cache.json'),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider(model.provider, {
    api: model.api,
    baseUrl: model.baseUrl,
    apiKey: 'synthetic-not-a-real-key',
    models: [model],
    streamSimple: () => {
      throw new Error('Test must never invoke a model provider');
    },
  });
  const { session, extensionsResult } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader,
    modelRuntime,
    model,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    thinkingLevel: 'off',
    tools: ['read', 'write', 'bash', 'codemode'],
  });
  t.after(() => session.dispose());
  assert.deepEqual(extensionsResult.errors, []);
  const events: any[] = [];
  const requests: any[] = [];
  const errors: unknown[] = [];
  const notices: string[] = [];
  await session.bindExtensions({
    uiContext: {
      confirm: options.confirm ?? (async () => false),
      notify: (message: string) => notices.push(message),
    } as unknown as ExtensionUIContext,
    onError: (error) => errors.push(error),
  });
  session.subscribe((event) => {
    events.push(event);
  });
  const run = async (...batches: Call[][]) => {
    let index = 0;
    // The model response alone is synthetic; Pi's real Agent loop, hooks, tools and QuickJS run unchanged.
    session.agent.streamFunction = (_model, context) => {
      requests.push(context);
      const calls = batches[index++] ?? [];
      const message: AssistantMessage = {
        role: 'assistant',
        content: calls.length ? calls : [{ type: 'text', text: 'Done.' }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: calls.length ? 'toolUse' : 'stop',
        timestamp: Date.now(),
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: calls.length ? 'toolUse' : 'stop', message });
      return stream;
    };
    await session.prompt('Run the synthetic tool sequence.');
    assert.deepEqual(errors, []);
  };
  return {
    root,
    cwd,
    session,
    events,
    requests,
    notices,
    run,
    ended: () => events.filter((event) => event.type === 'tool_execution_end'),
  };
}

test(
  'real Pi Code Mode keeps direct tools and preserves nested results while filtering model output',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, { readOnly: true });
    const original = 'first line\noriginal diagnostic evidence\n';
    await writeFile(join(f.cwd, 'source.txt'), original);
    await f.run(
      [call('direct', 'read', { path: 'source.txt' })],
      [
        call('script', 'codemode', {
          code: 'const value = await tools.read({path:"source.txt"}); text(value.split("\\n")[0]); text(JSON.stringify({models:typeof models,fetch:typeof fetch,process:typeof process,require:typeof require}));',
        }),
      ],
    );
    assert.ok(f.session.getActiveToolNames().includes('read'));
    assert.ok(f.session.getActiveToolNames().includes('codemode'));
    const declarations = f.requests[0].messages
      .filter((message: any) => message.role === 'system')
      .flatMap((message: any) => message.toolsAdded ?? [])
      .map((tool: any) => tool.name);
    assert.ok(declarations.includes('read'));
    assert.ok(declarations.includes('codemode'));
    const direct = f.ended().find((event) => event.toolCallId === 'direct');
    const nested = f.ended().find((event) => event.parentToolCallId === 'script');
    const script = f.ended().find((event) => event.toolCallId === 'script');
    assert.equal(direct.isError, false);
    assert.equal(nested.toolName, 'read');
    assert.equal(text(nested.result), original);
    assert.equal(script.isError, false);
    assert.match(text(script.result), /first line/);
    assert.doesNotMatch(text(script.result), /original diagnostic evidence/);
    for (const name of ['models', 'fetch', 'process', 'require'])
      assert.match(text(script.result), new RegExp(`"${name}":"undefined"`));
  },
);

test(
  'real Pi Code Mode rechecks read-only, workspace paths and shell permission on nested calls',
  { timeout: 20000 },
  async (t) => {
    await t.test('read-only blocks writes even when the tool is registered', async (t) => {
      const f = await fixture(t, { readOnly: true });
      await f.run([
        call('readonly-script', 'codemode', {
          code: 'await tools.write({path:"forbidden.txt",content:"must not exist"});',
        }),
      ]);
      const nested = f.ended().find((event) => event.parentToolCallId === 'readonly-script');
      assert.equal(nested.toolName, 'write');
      assert.equal(nested.isError, true);
      assert.match(text(nested.result), /read-only mode/);
      await assert.rejects(readFile(join(f.cwd, 'forbidden.txt')), { code: 'ENOENT' });
    });
    await t.test('automatic writes stay inside the workspace and cannot invoke shell', async (t) => {
      const f = await fixture(t);
      await f.run([
        call('auto-script', 'codemode', {
          code: `
      const results = await Promise.allSettled([
        tools.write({path:"allowed.txt",content:"inside only"}),
        tools.write({path:"../outside.txt",content:"must not exist"}),
        tools.bash({command:"echo must-not-run"})
      ]);
      text(results.map(result => result.status));
    `,
        }),
      ]);
      assert.equal(await readFile(join(f.cwd, 'allowed.txt'), 'utf8'), 'inside only');
      await assert.rejects(readFile(join(f.root, 'outside.txt')), { code: 'ENOENT' });
      const nested = f.ended().filter((event) => event.parentToolCallId === 'auto-script');
      assert.equal(nested.length, 3);
      assert.equal(nested.filter((event) => !event.isError).length, 1);
      assert.match(text(nested.find((event) => event.toolName === 'bash').result), /不执行 Pi shell/);
      assert.match(text(nested.find((event) => event.toolName === 'write' && event.isError).result), /工作区之外/);
    });
  },
);

test(
  'real Pi Code Mode asks for each nested operation and respects individual denial',
  { timeout: 20000 },
  async (t) => {
    const approvals: string[] = [];
    const f = await fixture(t, {
      ask: true,
      confirm: async (_title, message) => {
        approvals.push(message);
        return approvals.length === 1;
      },
    });
    await f.run([
      call('approval-script', 'codemode', {
        code: `
    await tools.write({path:"approved.txt",content:"approved operation"});
    try { await tools.write({path:"denied.txt",content:"denied operation"}); }
    catch (error) { text(error.message); }
  `,
      }),
    ]);
    assert.equal(approvals.length, 2);
    assert.match(approvals[0]!, /approved\.txt/);
    assert.match(approvals[1]!, /denied\.txt/);
    assert.equal(await readFile(join(f.cwd, 'approved.txt'), 'utf8'), 'approved operation');
    await assert.rejects(readFile(join(f.cwd, 'denied.txt')), { code: 'ENOENT' });
    const nested = f.ended().filter((event) => event.parentToolCallId === 'approval-script');
    assert.deepEqual(
      nested.map((event) => event.isError),
      [false, true],
    );
    assert.match(text(nested[1].result), /denied or cancelled/);
  },
);

test(
  'real Pi Code Mode terminates its CPU loop on cancellation without running later tools',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    let timer: NodeJS.Timeout | undefined;
    f.session.subscribe((event) => {
      if (event.type === 'tool_execution_update' && event.toolCallId === 'cancel-script') {
        timer ??= setTimeout(() => {
          void f.session.abort();
        }, 30);
      }
    });
    t.after(() => clearTimeout(timer));
    const started = Date.now();
    await f.run([
      call('cancel-script', 'codemode', {
        code: 'text("entered QuickJS"); while (true) {} await tools.write({path:"after-cancel.txt",content:"must not exist"});',
      }),
    ]);
    assert.ok(timer, 'QuickJS must emit output before cancellation');
    assert.ok(Date.now() - started < 5000, 'cancellation should terminate the worker promptly');
    const result = f.ended().find((event) => event.toolCallId === 'cancel-script');
    assert.equal(result.isError, true);
    assert.equal(f.session.isStreaming, false);
    assert.equal(f.ended().filter((event) => event.parentToolCallId === 'cancel-script').length, 0);
    await assert.rejects(readFile(join(f.cwd, 'after-cancel.txt')), { code: 'ENOENT' });
  },
);

test('real Pi Code Mode rechecks the API cutoff between nested calls', { timeout: 20000 }, async (t) => {
  let now = 0;
  const f = await fixture(t, {
    extra: (pi) => {
      registerPiBudgetGuard(pi, { maxCostUsd: 1, expiresAt: new Date(1000).toISOString() }, () => now);
      pi.on('tool_result', (event) => {
        if (event.toolName === 'read') now = 2000;
      });
    },
  });
  await writeFile(join(f.cwd, 'before-cutoff.txt'), 'read before expiry');
  await f.run([
    call('budget-script', 'codemode', {
      code: `
    await tools.read({path:"before-cutoff.txt"});
    await tools.write({path:"after-cutoff.txt",content:"must not exist"});
  `,
    }),
  ]);
  const nested = f.ended().filter((event) => event.parentToolCallId === 'budget-script');
  assert.equal(nested[0].toolName, 'read');
  assert.equal(nested[0].isError, false);
  assert.ok(f.notices.includes('api-budget-expired'));
  assert.equal(nested.find((event) => event.toolName === 'write')?.isError, true);
  await assert.rejects(readFile(join(f.cwd, 'after-cutoff.txt')), { code: 'ENOENT' });
});
