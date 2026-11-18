import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ExecuteContext, RunEvent } from '../src/shared/types.ts';
import { claudeExecutionArgs, createClaudeAdapter } from '../src/server/adapters/claude.ts';
import { codexAppServerArgs, createCodexAdapter } from '../src/server/adapters/codex.ts';
import { createCursorAdapter, cursorAccountFingerprint, cursorExecutionArgs } from '../src/server/adapters/cursor.ts';
import { grokExecutionArgs } from '../src/server/adapters/grok.ts';
import { grokAcpArgs, grokAcpMcpServers, grokAcpSessionMeta } from '../src/server/adapters/grok-acp.ts';
import { createPiAdapter, makePiTarget } from '../src/server/adapters/pi.ts';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { loadQuickJSWasm } from '@earendil-works/pi-codemode';

await loadQuickJSWasm();
const { default: studioPermissions } = await import(
  pathToFileURL(join(process.cwd(), 'src/server/pi-extension.mjs')).href
);

type Packet = Record<string, any>;
const prompt = 'Preserve this original request. Edit the file, but do not run commands. $() & |';
function context(provider: ExecuteContext['target']['provider'], prohibitCommands?: boolean): ExecuteContext {
  return {
    target: {
      id: provider,
      provider,
      label: provider,
      command: 'synthetic-never-launched',
      environment: 'native',
      enabled: true,
    },
    input: { prompt, projectPath: process.cwd(), kind: 'general', permissionMode: 'workspace-write', prohibitCommands },
    route: { runtimeId: provider, model: 'synthetic', kind: 'general', reasons: [], warnings: [] },
    signal: new AbortController().signal,
    approvalMode: 'ask',
    emit: () => {},
    approve: async () => true,
  };
}
const value = (args: string[], name: string) => args[args.indexOf(name) + 1];

function wire(handle: (packet: Packet, send: (packet: Packet) => void) => void) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 999999,
    exitCode: null as number | null,
    signalCode: null,
  });
  const send = (packet: Packet) => child.stdout.write(JSON.stringify(packet) + '\n');
  const packets: Packet[] = [];
  let buffer = '';
  child.stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const packet = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      packets.push(packet);
      queueMicrotask(() => handle(packet, send));
    }
  });
  child.stdin.on('finish', () => {
    child.exitCode = 0;
    child.emit('close', 0);
  });
  return { child: child as unknown as ChildProcessWithoutNullStreams, packets, send };
}

test('Claude command prohibition keeps scoped file tools, excludes other native tools, and preserves the prompt', () => {
  const ctx = context('claude', true);
  const args = claudeExecutionArgs(ctx, 'host-bridge.json');
  assert.equal(value(args, '--tools'), 'Read,Glob,Grep,Edit,Write');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('--safe-mode'));
  assert.equal(value(args, '--mcp-config'), 'host-bridge.json');
  const chat = claudeExecutionArgs({ ...ctx, input: { ...ctx.input, latencySensitiveChat: true } });
  assert.equal(value(chat, '--tools'), '');
  assert.ok(chat.includes('--safe-mode'));
  ctx.input.permissionMode = 'read-only';
  assert.equal(value(claudeExecutionArgs(ctx), '--tools'), 'Read,Glob,Grep');
  assert.equal(ctx.input.prompt, prompt);
  for (const flag of [undefined, false]) assert.ok(!claudeExecutionArgs(context('claude', flag)).includes('--tools'));
});

test(
  'Claude refuses a command permission request before approval but still approves a file edit',
  { timeout: 10000 },
  async () => {
    const responses: Packet[] = [];
    const f = wire((packet, send) => {
      if (packet.type === 'control_request')
        send({
          type: 'control_response',
          response: { subtype: 'success', request_id: packet.request_id, response: {} },
        });
      else if (packet.type === 'user') {
        assert.equal(packet.message.content, prompt);
        send({
          type: 'control_request',
          request_id: 'shell',
          request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'must not run' } },
        });
      } else if (packet.type === 'control_response') {
        responses.push(packet.response.response);
        if (packet.response.request_id === 'shell')
          send({
            type: 'control_request',
            request_id: 'edit',
            request: {
              subtype: 'can_use_tool',
              tool_name: 'Edit',
              input: { file_path: 'synthetic.txt', old_string: 'a', new_string: 'b' },
            },
          });
        else
          send({
            type: 'result',
            subtype: 'success',
            session_id: 'synthetic-session',
            result: 'done',
            is_error: false,
          });
      }
    });
    const ctx = context('claude', true);
    const approved: string[] = [];
    ctx.approve = async (tool) => {
      approved.push(tool);
      return true;
    };
    const result = await createClaudeAdapter({
      spawn: async () => f.child,
      terminate: async () => {
        f.child.stdin.end();
      },
    }).execute(ctx);
    assert.equal(result.output, 'done');
    assert.equal(responses[0].behavior, 'deny');
    assert.equal(responses[1].behavior, 'allow');
    assert.deepEqual(approved, ['Edit']);
  },
);

test('Grok applies native tool filters to headless and ACP without downgrading file writes', () => {
  const ctx = context('grok', true);
  ctx.route.model = 'grok-4.7';
  ctx.agentBridge = { url: 'http://127.0.0.1:1/synthetic', token: 'synthetic' };
  const headless = grokExecutionArgs(ctx, 'synthetic-prompt.txt', 'synthetic-session');
  assert.equal(value(headless, '--tools'), 'Read,Grep,Edit,Write');
  assert.ok(value(headless, '--disallowed-tools').split(',').includes('Bash'));
  const profile = grokAcpSessionMeta(ctx).agentProfile as Packet;
  assert.deepEqual(profile.tools, ['Read', 'Grep', 'Edit', 'Write']);
  for (const name of ['Bash', 'Agent', 'MCPTool', 'search_tool', 'use_tool'])
    assert.ok(profile.disallowedTools.includes(name));
  assert.deepEqual(grokAcpMcpServers(ctx), []);
  assert.ok(!grokAcpArgs(ctx).includes('MCPTool(pugport__*)'));
  ctx.input.permissionMode = 'read-only';
  const readOnly = grokAcpSessionMeta(ctx).agentProfile as Packet;
  assert.deepEqual(readOnly.tools, ['Read', 'Grep']);
  assert.ok(readOnly.disallowedTools.includes('Edit'));
  assert.ok(readOnly.disallowedTools.includes('Bash'));
  assert.ok(readOnly.disallowedTools.includes('use_tool'));
  assert.equal(ctx.input.prompt, prompt);
  for (const flag of [undefined, false]) {
    const normal = context('grok', flag);
    assert.equal((grokAcpSessionMeta(normal).agentProfile as Packet).tools, undefined);
    assert.ok(!grokExecutionArgs(normal, 'prompt', 'session').includes('--tools'));
  }
});

test('Cursor explicitly selects its verified read-only native mode for command prohibition', () => {
  const cursor = context('cursor', true);
  cursor.route.model = 'composer-2.5';
  assert.equal(value(cursorExecutionArgs(cursor), '--mode'), 'ask');
  for (const flag of [undefined, false]) {
    cursor.input.prohibitCommands = flag;
    // cursor-agent rejects `--mode agent`; agent is its default.
    assert.equal(cursorExecutionArgs(cursor).includes('--mode'), false);
  }
  assert.equal(cursor.input.prompt, prompt);
});

test('Codex disables verified shell/exec/hook features only for this policy', () => {
  const ctx = context('codex', true);
  const normal = codexAppServerArgs(ctx.target, 'linux');
  const restricted = codexAppServerArgs(ctx.target, 'linux', undefined, undefined, true);
  assert.deepEqual(
    restricted.filter((arg) => !normal.includes(arg) && arg !== '-c'),
    ['features.shell_tool=false', 'features.unified_exec=false', 'features.hooks=false'],
  );
  assert.ok(!normal.some((arg) => arg.startsWith('features.')));
});

test('Codex denies command approval even when the owner approval callback would allow it, while file approval remains usable', async () => {
  const responses: Packet[] = [];
  let threadConfig: Packet = {},
    turnConfig: Packet = {},
    args: string[] = [];
  const f = wire((packet, send) => {
    if (packet.id === 'command') {
      responses.push(packet.result);
      send({
        id: 'file',
        method: 'item/fileChange/requestApproval',
        params: { threadId: 'thread', itemId: 'file', changes: [{ path: 'synthetic.txt', diff: 'synthetic' }] },
      });
    } else if (packet.id === 'file') {
      responses.push(packet.result);
      send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } });
    } else if (packet.method === 'initialize') send({ id: packet.id, result: {} });
    else if (packet.method === 'thread/start') {
      threadConfig = packet.params;
      send({
        method: 'item/completed',
        params: { item: { id: 'old-command', type: 'commandExecution', status: 'completed' } },
      });
      send({ id: packet.id, result: { thread: { id: 'thread' } } });
    } else if (packet.method === 'turn/start') {
      turnConfig = packet.params;
      send({ id: packet.id, result: { turn: { id: 'turn' } } });
      send({
        id: 'command',
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'thread', itemId: 'command', command: 'must never execute' },
      });
    }
  });
  const ctx = context('codex', true);
  let approvalCalls = 0;
  ctx.approve = async () => {
    approvalCalls++;
    return true;
  };
  await createCodexAdapter({
    spawn: async (_target, actual) => {
      args = actual;
      return f.child;
    },
    targetPath: async (_target, path) => path,
    terminate: async () => {
      f.child.stdin.end();
    },
    sandboxStatus: async () => ({ available: false, reason: 'sdk-missing', message: 'synthetic' }),
  }).execute(ctx);
  assert.deepEqual(responses, [{ decision: 'decline' }, { decision: 'accept' }]);
  assert.equal(approvalCalls, 1);
  assert.equal(threadConfig.sandbox, 'workspace-write');
  assert.equal(turnConfig.sandboxPolicy.type, 'workspaceWrite');
  assert.equal(turnConfig.sandboxPolicy.networkAccess, false);
  assert.equal(turnConfig.input[0].text, prompt);
  assert.ok(args.includes('features.shell_tool=false'));
});

test(
  'Codex fails closed if the peer emits a command execution despite its disabled tool configuration',
  { timeout: 10000 },
  async () => {
    let terminated = 0;
    const f = wire((packet, send) => {
      if (packet.method === 'initialize') send({ id: packet.id, result: {} });
      else if (packet.method === 'thread/start') send({ id: packet.id, result: { thread: { id: 'thread' } } });
      else if (packet.method === 'turn/start') {
        send({ id: packet.id, result: { turn: { id: 'turn' } } });
        send({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'turn', status: 'inProgress' } } });
        send({
          method: 'item/started',
          params: {
            threadId: 'thread',
            turnId: 'turn',
            item: { id: 'command', type: 'commandExecution', command: 'must not run' },
          },
        });
      } else if (packet.method === 'turn/interrupt') send({ id: packet.id, result: {} });
    });
    await assert.rejects(
      createCodexAdapter({
        spawn: async () => f.child,
        targetPath: async (_target, path) => path,
        terminate: async () => {
          terminated++;
          f.child.stdin.end();
        },
        sandboxStatus: async () => ({ available: false, reason: 'sdk-missing', message: 'synthetic' }),
      }).execute(context('codex', true)),
    );
    assert.ok(terminated > 0);
    assert.ok(f.packets.some((packet) => packet.method === 'turn/interrupt'));
  },
);

for (const provider of ['cursor'] as const) {
  for (const prohibitCommands of [true, false]) {
    test(`${provider} ACP ${prohibitCommands ? 'rejects commands and native edits but permits reads' : 'keeps existing write-mode approvals'}`, async () => {
      const responses: string[] = [],
        events: RunEvent[] = [];
      const ctx = context(provider, prohibitCommands);
      const model = 'composer-2.5';
      ctx.route.model = model;
      ctx.emit = (event) => events.push(event);
      const identity = { isAuthenticated: true, userInfo: { email: 'synthetic@example.test', userId: 'synthetic' } };
      if (provider === 'cursor') ctx.route.accountFingerprint = cursorAccountFingerprint(identity);
      let promptId: unknown,
        selectedMode = '';
      const kinds = ['read', 'execute', 'edit'];
      const permission = (index: number, send: (packet: Packet) => void) =>
        send({
          jsonrpc: '2.0',
          id: `permission-${index}`,
          method: 'session/request_permission',
          params: {
            sessionId: 'session',
            toolCall: { kind: kinds[index], title: kinds[index] },
            options: [
              { optionId: 'allow', kind: 'allow_once' },
              { optionId: 'deny', kind: 'reject_once' },
            ],
          },
        });
      const f = wire((packet, rawSend) => {
        const send = (value: Packet) => rawSend({ jsonrpc: '2.0', ...value });
        if (String(packet.id).startsWith('permission-')) {
          responses.push(packet.result.outcome.optionId);
          const next = Number(String(packet.id).split('-')[1]) + 1;
          if (next < kinds.length) permission(next, send);
          else send({ id: promptId, result: { stopReason: 'end_turn' } });
        } else if (packet.method === 'initialize')
          send({ id: packet.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
        else if (packet.method === 'cursor/list_available_models')
          send({ id: packet.id, error: { code: -32601, message: 'unsupported' } });
        else if (packet.method === 'session/new')
          send({
            id: packet.id,
            result: {
              sessionId: 'session',
              modes: { availableModes: ['ask', 'agent', 'plan', 'default', 'auto_edit'].map((id) => ({ id })) },
              models: { currentModelId: model },
            },
          });
        else if (packet.method === 'session/set_mode') {
          selectedMode = packet.params.modeId;
          send({ id: packet.id, result: {} });
        } else if (packet.method === 'session/prompt') {
          promptId = packet.id;
          assert.equal(packet.params.prompt[0].text, prompt);
          permission(0, send);
        } else if (packet.id !== undefined && packet.method) send({ id: packet.id, result: {} });
      });
      const shared = {
        spawn: async () => f.child,
        terminate: async () => {
          f.child.stdin.end();
        },
        targetPath: async (_target: unknown, path: string) => path,
        requestTimeoutMs: 1000,
      };
      const adapter = createCursorAdapter({
        ...shared,
        capture: async (_target, args) => ({
          stdout: args[0] === 'models' ? 'Available models\ncomposer-2.5 - Composer\n' : JSON.stringify(identity),
          stderr: '',
          exitCode: 0,
        }),
      });
      await adapter.execute(ctx);
      assert.deepEqual(responses, prohibitCommands ? ['allow', 'deny', 'deny'] : ['allow', 'allow', 'allow']);
      assert.equal(selectedMode, prohibitCommands ? 'ask' : 'agent');
      if (prohibitCommands)
        assert.ok(events.some((event) => event.text?.includes('native file writes are also disabled')));
    });
  }
}

test('Pi excludes both shell tools at launch, preserves file writes and passes the original request', async () => {
  let args: string[] = [],
    environment: NodeJS.ProcessEnv = {};
  const f = wire((packet, send) => {
    const data =
      packet.type === 'get_commands'
        ? {
            commands: [
              { name: 'studio-permissions-v1', source: 'extension' },
              { name: 'studio-codemode-v1', source: 'extension' },
            ],
          }
        : packet.type === 'get_available_models'
          ? { models: [{ provider: 'synthetic', id: 'model', name: 'synthetic', reasoning: false }] }
          : packet.type === 'get_state'
            ? {}
            : {};
    send({ id: packet.id, type: 'response', success: true, data });
    if (packet.type === 'prompt') {
      assert.equal(packet.message, prompt);
      send({ type: 'agent_settled' });
    }
  });
  const ctx = context('pi', true);
  ctx.target = makePiTarget(process.cwd(), process.cwd());
  ctx.route.model = 'synthetic/model';
  await createPiAdapter({
    spawn: async (_target, actual, options) => {
      args = actual;
      environment = options?.env ?? {};
      return f.child;
    },
    terminate: async () => {
      f.child.stdin.end();
    },
    permissionExtension: async () => '/synthetic/extension.mjs',
    environment: () => ({}),
  }).execute(ctx);
  const tools = value(args, '--tools').split(',');
  assert.ok(!tools.includes('bash'));
  assert.ok(!tools.includes('powershell'));
  assert.ok(tools.includes('write'));
  assert.ok(tools.includes('edit'));
  assert.ok(tools.includes('codemode'));
  assert.equal(environment.COMBORUNNER_PI_PROHIBIT_COMMANDS, '1');
  assert.equal(environment.COMBORUNNER_PI_PERMISSION_MODE, 'workspace-write');
});

test('Pi direct hooks deny bash and powershell before approvals, and the unset flag preserves existing ask mode', async () => {
  const { default: studioPermissions } = await import(
    pathToFileURL(join(process.cwd(), 'src/server/pi-extension.mjs')).href
  );
  const names = [
    'COMBORUNNER_PI_PROHIBIT_COMMANDS',
    'COMBORUNNER_PI_CODEMODE',
    'COMBORUNNER_PI_PERMISSION_MODE',
    'COMBORUNNER_TOOL_APPROVAL_MODE',
    'COMBORUNNER_AGENT_BRIDGE_URL',
    'COMBORUNNER_AGENT_BRIDGE_TOKEN',
    'COMBORUNNER_PI_API_BUDGET',
  ];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    process.env.COMBORUNNER_TOOL_APPROVAL_MODE = 'ask';
    process.env.COMBORUNNER_PI_PERMISSION_MODE = 'workspace-write';
    for (const flag of ['1', '']) {
      process.env.COMBORUNNER_PI_PROHIBIT_COMMANDS = flag;
      let hook: any;
      let approvals = 0;
      await studioPermissions({
        on: (event: string, handler: any) => {
          if (event === 'tool_call') hook = handler;
        },
        registerCommand: () => {},
      });
      for (const toolName of ['bash', 'powershell']) {
        const result = await hook(
          { toolName, input: { command: 'must not execute', prohibitCommands: false } },
          {
            hasUI: true,
            cwd: process.cwd(),
            ui: {
              confirm: async () => {
                approvals++;
                return true;
              },
            },
          },
        );
        if (flag === '1') {
          assert.equal(result.block, true);
          assert.match(result.reason, /user prohibited commands/);
        } else assert.equal(result, undefined);
      }
      assert.equal(approvals, flag === '1' ? 0 : 2);
    }
  } finally {
    for (const [name, setting] of Object.entries(saved)) {
      if (setting === undefined) delete process.env[name];
      else process.env[name] = setting;
    }
  }
});

test(
  'Pi real Code Mode rechecks prohibited nested shell calls while permitted file writes still work',
  { timeout: 20000 },
  async (t) => {
    const savedExecArgv = process.execArgv;
    process.execArgv = [];
    t.after(() => {
      process.execArgv = savedExecArgv;
    });
    const root = await mkdtemp(join(tmpdir(), 'pugport-command-policy-')),
      cwd = join(root, 'workspace'),
      agentDir = join(root, 'agent');
    await Promise.all([mkdir(cwd), mkdir(agentDir)]);
    t.after(() => rm(root, { recursive: true, force: true }));
    const environment: Record<string, string | undefined> = {
      COMBORUNNER_PI_PROHIBIT_COMMANDS: '1',
      COMBORUNNER_PI_CODEMODE: 'on',
      COMBORUNNER_PI_PERMISSION_MODE: 'workspace-write',
      COMBORUNNER_TOOL_APPROVAL_MODE: 'ask',
      COMBORUNNER_AGENT_BRIDGE_URL: undefined,
      COMBORUNNER_AGENT_BRIDGE_TOKEN: undefined,
      COMBORUNNER_AGENT_BRIDGE_TOOLS: undefined,
      COMBORUNNER_PI_API_BUDGET: undefined,
    };
    const saved = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
    for (const [key, setting] of Object.entries(environment)) {
      if (setting === undefined) delete process.env[key];
      else process.env[key] = setting;
    }
    t.after(() => {
      for (const [key, setting] of Object.entries(saved)) {
        if (setting === undefined) delete process.env[key];
        else process.env[key] = setting;
      }
    });
    const model: any = {
      id: 'synthetic',
      name: 'synthetic',
      api: 'openai-completions',
      provider: 'pugport-command-policy-test',
      baseUrl: 'http://127.0.0.1:1/never',
      reasoning: false,
      input: ['text'],
      contextWindow: 10000,
      maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
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
      extensionFactories: [studioPermissions],
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
      apiKey: 'synthetic',
      models: [model],
      streamSimple: () => {
        throw new Error('No real model calls allowed');
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
    const confirmations: string[] = [],
      events: Packet[] = [];
    await session.bindExtensions({
      uiContext: {
        confirm: async (title: string) => {
          confirmations.push(title);
          return true;
        },
        notify: () => {},
      } as any,
      onError: (error) => {
        throw error;
      },
    });
    session.subscribe((event) => events.push(event));
    let turn = 0;
    session.agent.streamFunction = () => {
      const content: any =
        turn++ === 0
          ? [
              {
                type: 'toolCall',
                id: 'nested',
                name: 'codemode',
                arguments: {
                  code: 'const blocked = await Promise.allSettled([tools.bash({command:"echo MUST_NOT_RUN"})]); await tools.write({path:"allowed.txt",content:"preserved file writes"}); text(blocked[0].status);',
                },
              },
            ]
          : [{ type: 'text', text: 'done' }];
      const message: any = {
        role: 'assistant',
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: turn === 1 ? 'toolUse' : 'stop',
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
      stream.push({ type: 'done', reason: turn === 1 ? 'toolUse' : 'stop', message });
      return stream;
    };
    await session.prompt(prompt);
    assert.equal(await readFile(join(cwd, 'allowed.txt'), 'utf8'), 'preserved file writes');
    const shell = events.find(
      (event) =>
        event.type === 'tool_execution_end' && event.toolName === 'bash' && event.parentToolCallId === 'nested',
    );
    assert.ok(shell);
    assert.equal(shell.isError, true);
    assert.match(JSON.stringify(shell.result), /user prohibited commands/);
    assert.ok(!confirmations.some((title) => title.includes('bash')));
    assert.ok(confirmations.some((title) => title.includes('write')));
  },
);

test('Pi gets the command marker only on a trusted writable turn under automatic approval', async () => {
  const launch = async (patch: Partial<ExecuteContext>, input: Partial<ExecuteContext['input']> = {}) => {
    let environment: NodeJS.ProcessEnv = {};
    const f = wire((packet, send) => {
      const data =
        packet.type === 'get_commands'
          ? {
              commands: [
                { name: 'studio-permissions-v1', source: 'extension' },
                { name: 'studio-codemode-v1', source: 'extension' },
              ],
            }
          : packet.type === 'get_available_models'
            ? { models: [{ provider: 'synthetic', id: 'model', name: 'synthetic', reasoning: false }] }
            : {};
      send({ id: packet.id, type: 'response', success: true, data });
      if (packet.type === 'prompt') send({ type: 'agent_settled' });
    });
    const ctx = { ...context('pi'), ...patch };
    ctx.input = { ...ctx.input, ...input };
    ctx.target = makePiTarget(process.cwd(), process.cwd());
    ctx.route.model = 'synthetic/model';
    await createPiAdapter({
      spawn: async (_target, _args, options) => {
        environment = options?.env ?? {};
        return f.child;
      },
      terminate: async () => {
        f.child.stdin.end();
      },
      permissionExtension: async () => '/synthetic/extension.mjs',
      environment: () => ({}),
    }).execute(ctx);
    return environment.COMBORUNNER_PI_TRUSTED_COMMANDS;
  };
  assert.equal(await launch({ approvalMode: 'auto', trustedProject: true }), '1');
  assert.equal(await launch({ approvalMode: 'auto', trustedProject: false }), '');
  assert.equal(await launch({ approvalMode: 'ask', trustedProject: true }), '');
  assert.equal(await launch({ approvalMode: 'auto', trustedProject: true }, { webDriven: true }), '');
  assert.equal(await launch({ approvalMode: 'auto', trustedProject: true }, { permissionMode: 'read-only' }), '');
});
