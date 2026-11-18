import { idleMachineReading } from './helpers/machine-reading.ts';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { AgentBridge } from '../src/server/agent-bridge.ts';
import type { ConnectorService } from '../src/server/connectors.ts';
import { extensions } from '../src/server/extensions.ts';
import { settledWorkflow } from './helpers/workflow-state.ts';
import { capabilities } from '../src/server/platform/host.ts';
import { mentionsAgent, normalizeAgentName, resolveAgent } from '../src/server/agent-names.ts';
import { codexAdapter, codexAppServerArgs } from '../src/server/adapters/codex.ts';
import {
  agentBridgeTools,
  claudeAdapter,
  claudeBridgeConfig,
  claudeExecutionArgs,
} from '../src/server/adapters/claude.ts';
import { grokAcpArgs, grokAcpMcpServers } from '../src/server/adapters/grok-acp.ts';
import { grokAdapter } from '../src/server/adapters/grok.ts';
import { recyclablePaths } from '../src/server/recycle-bin.ts';
import { safeToolEventText } from '../src/shared/tool-event-data.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import type {
  ExecuteContext,
  ExecuteResult,
  MessageInput,
  RuntimeSnapshot,
  RuntimeTarget,
  Workflow,
} from '../src/shared/types.ts';

const card = (id: string, provider: RuntimeTarget['provider'], label: string, enabled = true): RuntimeTarget => ({
  id,
  provider,
  label,
  command: 'unused',
  environment: 'native',
  enabled,
});

test('card names match regardless of case, spacing and separators, and renamed cards are recognized', () => {
  const targets = [
    card('codex-native', 'codex', 'Codex · 本机'),
    card('codex-account-b', 'codex', 'Codex B'),
    card('grok-native', 'grok', 'Grok · 本机'),
    card('claude-native', 'claude', 'Claude · 本机'),
    card('grok-account-c', 'grok', 'Grok C', false),
  ];
  assert.equal(normalizeAgentName('Grok · 本机'), normalizeAgentName('grok本机'));
  assert.equal(resolveAgent('grok 本机', targets).runtimeId, 'grok-native');
  assert.equal(resolveAgent('CODEX-B', targets).runtimeId, 'codex-account-b');
  assert.equal(resolveAgent('codexb', targets).runtimeId, 'codex-account-b');
  // One card for the provider: its name alone is enough. Several: the provider picks an account automatically.
  assert.equal(resolveAgent('claude', targets).runtimeId, 'claude-native');
  const auto = resolveAgent('Codex', targets);
  assert.equal(auto.runtimeId, undefined);
  assert.equal(auto.provider, 'codex');
  assert.throws(() => resolveAgent('Grok C', targets), /已停用/);
  assert.throws(() => resolveAgent('Gemini', targets), /没有找到.*Codex B/);
  targets[1]!.label = '小助手';
  assert.equal(resolveAgent('小助手', targets).runtimeId, 'codex-account-b');
  assert.equal(mentionsAgent('让小助手检查一下', targets), true);
  assert.equal(mentionsAgent('解释一下这个函数', targets), false);
});

test('adapters receive the bridge only through per-run configuration', () => {
  const bridge = { url: 'http://127.0.0.1:4317/mcp', token: 'secret-token' };
  const codex = codexAppServerArgs(card('codex', 'codex', 'Codex'), 'linux', bridge);
  assert.ok(codex.includes('mcp_servers.pugport.url=http://127.0.0.1:4317/mcp'));
  assert.ok(codex.includes('mcp_servers.pugport.bearer_token_env_var=COMBORUNNER_AGENT_TOKEN'));
  assert.ok(!codex.join(' ').includes('secret-token'));
  assert.deepEqual(codexAppServerArgs(card('codex', 'codex', 'Codex'), 'linux'), [
    'app-server',
    '--stdio',
    '-c',
    "mcp_servers.pugport-app={enabled=false,command='pugport-app'}",
  ]);

  const ctx = (permissionMode: 'read-only' | 'workspace-write') =>
    ({
      target: card('grok', 'grok', 'Grok'),
      input: { prompt: 'x', projectPath: '/tmp', kind: 'general', permissionMode },
      route: {},
      approvalMode: 'auto',
      agentBridge: bridge,
    }) as unknown as ExecuteContext;
  const claudeArgs = claudeExecutionArgs(ctx('read-only'), '/tmp/mcp.json');
  assert.ok(agentBridgeTools.includes('mcp__pugport__git'));
  assert.deepEqual(claudeArgs.slice(-4), [
    '--mcp-config',
    '/tmp/mcp.json',
    '--allowedTools',
    agentBridgeTools.join(','),
  ]);
  assert.ok(claudeArgs.includes('--strict-mcp-config'));
  assert.deepEqual(JSON.parse(claudeBridgeConfig(bridge)).mcpServers.pugport.headers, {
    Authorization: 'Bearer secret-token',
  });
  assert.deepEqual(grokAcpMcpServers(ctx('workspace-write')), [
    {
      type: 'http',
      name: 'pugport',
      url: bridge.url,
      headers: [{ name: 'Authorization', value: 'Bearer secret-token' }],
    },
  ]);
  assert.deepEqual(grokAcpMcpServers(ctx('read-only')), grokAcpMcpServers(ctx('workspace-write')));
  const grokArgs = grokAcpArgs(ctx('workspace-write'));
  assert.equal(grokArgs[grokArgs.indexOf('--allow') + 1], 'MCPTool(pugport__*)');
  assert.ok(grokArgs.indexOf('--allow') < grokArgs.indexOf('agent'));
  assert.equal(grokArgs[grokArgs.indexOf('--permission-mode') + 1], 'auto');
  assert.ok(!grokArgs.includes('--deny'));
  const readArgs = grokAcpArgs(ctx('read-only'));
  assert.equal(readArgs[readArgs.indexOf('--permission-mode') + 1], 'default');
  assert.ok(!readArgs.includes('--allow'));
  assert.ok(!readArgs.includes('--deny'));
});

function fixture(t: TestContext) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'agent-bridge-test-')));
  const controller = new Controller(directory, join(directory, 'data'));
  clearInterval(controller.timer);
  t.mock.method(controller, 'machineReading', idleMachineReading);
  controller.settings.decisionMode = 'auto';
  controller.settings.routePreferencesEnabled = true;
  controller.settings.architectureProvider = 'codex';
  controller.settings.routineProvider = 'codex';
  controller.settings.designProvider = 'codex';
  controller.agentBridgeUrl = 'http://127.0.0.1:0/mcp';
  controller.targets = [
    card('codex', 'codex', 'Codex B'),
    card('claude', 'claude', 'Claude · 本机'),
    card('grok', 'grok', 'Grok'),
  ];
  const snapshot = (target: RuntimeTarget): RuntimeSnapshot => ({
    ...target,
    installed: true,
    status: 'ready',
    models: [{ id: 'test-model', label: 'Test model', efforts: ['low', 'medium', 'high'] }],
    quota: {
      status: 'known',
      source: 'fixture',
      observedAt: new Date().toISOString(),
      windows: [
        { id: 'week', label: 'week', usedPercent: 10, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
      ],
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: new Date().toISOString(),
  });
  controller.snapshots = controller.targets.map(snapshot);
  t.mock.method(controller, 'refresh', async () => {});
  const calls: ExecuteContext[] = [];
  const behavior: {
    codex?: (ctx: ExecuteContext) => Promise<string>;
    claude?: (ctx: ExecuteContext) => Promise<string>;
    grok?: (ctx: ExecuteContext) => Promise<string>;
  } = {};
  const execute = async (ctx: ExecuteContext): Promise<ExecuteResult> => {
    calls.push(ctx);
    const output =
      ctx.target.provider === 'codex' && behavior.codex
        ? await behavior.codex(ctx)
        : ctx.target.provider === 'claude' && behavior.claude
          ? await behavior.claude(ctx)
          : ctx.target.provider === 'grok' && behavior.grok
            ? await behavior.grok(ctx)
            : `${ctx.target.label} answer`;
    return { output, nativeSessionId: `session-${calls.length}` };
  };
  t.mock.method(codexAdapter, 'execute', execute);
  t.mock.method(claudeAdapter, 'execute', execute);
  t.mock.method(grokAdapter, 'execute', execute);
  const workspace = new Workspace(controller, { autoTick: false });
  const bridge = new AgentBridge(workspace, controller);
  t.after(async () => {
    await workspace.close();
    await controller.close();
    const absolute = resolve(directory);
    assert.ok(
      absolute.startsWith(realpathSync.native(tmpdir()) + sep) && basename(absolute).startsWith('agent-bridge-test-'),
    );
    rmSync(absolute, { recursive: true, force: true });
  });
  return { workspace, controller, calls, behavior, bridge, directory };
}

const finish = settledWorkflow;

test('ordinary chats retain their local tools without advertising or accepting child dispatch', async (t) => {
  const f = fixture(t);
  const project = await f.workspace.createProject(f.directory);
  project.scope = 'chat';
  f.workspace.store.save('project', project.id, project.id, project);
  const conversation = f.workspace.createConversation(project.id);
  f.behavior.codex = async (ctx) => {
    assert.ok(ctx.agentBridge);
    assert.equal(ctx.input.agentCalls, undefined);
    assert.doesNotMatch(ctx.input.prompt, /可自动用 delegate|可以像团队一样分工/);
    const auth = `Bearer ${ctx.agentBridge.token}`;
    const initialized = await f.bridge.handle(auth, { jsonrpc: '2.0', id: 1, method: 'initialize' });
    assert.doesNotMatch(
      (initialized.body as { result: { instructions: string } }).result.instructions,
      /delegate|list_agents/,
    );
    const listed = await f.bridge.handle(auth, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = (listed.body as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name);
    for (const name of ['delegate', 'delegate_many', 'list_agents', 'set_plan']) assert.ok(!names.includes(name));
    assert.ok(names.includes('search_tools'), 'normal connector discovery stays available');
    const refused = await f.bridge.handle(auth, call('delegate', { task: 'Do this elsewhere' }));
    assert.equal((refused.body as { result: { isError?: boolean } }).result.isError, true);
    return 'The explanation is complete.';
  };
  const parent = await f.workspace.send(conversation.id, {
    content: 'Explain this short example.',
    mode: 'chat',
    permissionMode: 'read-only',
    executionPolicy: 'cli-first',
    autoEscalate: false,
  });
  assert.equal((await finish(f.workspace, parent.workflow.id)).status, 'completed');
  assert.equal(f.calls.length, 1);
  assert.equal(f.workspace.conversation(conversation.id).workflows.length, 1);
});

test('read-only Grok execution receives a read-only bridge grant and tool hint', async (t) => {
  const f = fixture(t);
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const grants: { bridge: boolean; write: boolean | undefined }[] = [];
  const prompts: string[] = [];
  f.behavior.grok = async (ctx) => {
    grants.push({
      bridge: !!ctx.agentBridge,
      write: ctx.agentBridge ? f.controller.agentBridgeCaller(ctx.agentBridge.token)?.write : undefined,
    });
    prompts.push(ctx.input.prompt);
    return 'Synthetic Grok answer';
  };
  const result = await f.workspace.send(conversation.id, {
    content: 'Inspect the project',
    mode: 'chat',
    permissionMode: 'read-only',
    executionPolicy: 'cli-first',
    runtimeId: 'grok',
    autoEscalate: false,
  });
  assert.equal((await finish(f.workspace, result.workflow.id)).status, 'completed');
  assert.deepEqual(grants, [{ bridge: true, write: false }]);
  assert.match(prompts[0]!, /只选择以 pugport__ 开头的工具/);
});

const call = (name: string, args: Record<string, unknown>, id = 1) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});
const text = (reply: { body?: unknown }) =>
  (reply.body as { result: { content: { text: string }[] } }).result.content[0]!.text;

for (const batch of [false, true])
  test(`bridge contains a tools/list failure ${batch ? 'in a batch' : 'in a single request'}`, async (t) => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'agent-bridge-error-test-')));
    const controller = Object.assign(new EventEmitter(), {
      dataDir: directory,
      agentBridgeCaller: () => ({
        run: { id: 'synthetic-run' },
        target: { provider: 'codex' },
        write: false,
        signal: new AbortController().signal,
      }),
      returnExecution: () => async () => {},
    }) as unknown as Controller;
    const workspace = { store: { get: () => undefined } } as unknown as Workspace;
    let calls = 0;
    const connectors = {
      toolsFor: async () => {
        calls++;
        throw new Error('Synthetic connector listing failure');
      },
    } as unknown as ConnectorService;
    t.mock.method(extensions, 'bridgeTools', () => []);
    const bridge = new AgentBridge(workspace, controller, 'unused', {}, connectors);
    t.after(async () => {
      await bridge.close();
      assert.ok(directory.startsWith(realpathSync.native(tmpdir()) + sep));
      assert.ok(basename(directory).startsWith('agent-bridge-error-test-'));
      rmSync(directory, { recursive: true, force: true });
    });
    const message = { jsonrpc: '2.0', id: 0, method: 'tools/list' };
    const failure = {
      jsonrpc: '2.0',
      id: 0,
      error: { code: -32603, message: 'Synthetic connector listing failure' },
    };
    assert.deepEqual(
      await bridge.handle('Bearer synthetic', batch ? [message, { id: 'ping', method: 'ping' }] : message),
      {
        status: 200,
        body: batch ? [failure, { jsonrpc: '2.0', id: 'ping', result: {} }] : failure,
      },
    );
    assert.equal(calls, 1);
    assert.deepEqual(await bridge.handle('Bearer synthetic', { method: 'tools/list' }), { status: 202 });
    assert.equal(calls, 1, 'notifications do not execute tools or produce replies');
  });

test('a running executor hands a write task to another card by name and gets its result back', async (t) => {
  const f = fixture(t);
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const replies: string[] = [];
  let token = '';
  const childTools: string[][] = [];
  const childDelegate: string[] = [];
  f.behavior.claude = async (ctx) => {
    if (ctx.agentBridge) {
      const auth = `Bearer ${ctx.agentBridge.token}`;
      const listed = await f.bridge.handle(auth, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      childTools.push((listed.body as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name));
      childDelegate.push(text(await f.bridge.handle(auth, call('delegate', { agent: 'Codex B', task: 'x' }))));
    }
    return 'Claude · 本机 answer';
  };
  f.behavior.codex = async (ctx) => {
    if (ctx.input.agentChild) return 'Independent Codex child answer';
    if (!ctx.agentBridge) return 'no bridge';
    token = ctx.agentBridge.token;
    assert.match(ctx.input.prompt, /可调用的其他执行器.*Claude · 本机/);
    const auth = `Bearer ${token}`;
    const init = await f.bridge.handle(auth, {
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    });
    assert.equal((init.body as { result: { protocolVersion: string } }).result.protocolVersion, '2025-03-26');
    assert.equal((await f.bridge.handle(auth, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    const listed = await f.bridge.handle(auth, { jsonrpc: '2.0', id: 9, method: 'tools/list' });
    const delegateTool = (
      listed.body as {
        result: { tools: { name: string; inputSchema: { properties: Record<string, { description?: string }> } }[] };
      }
    ).result.tools.find((tool) => tool.name === 'delegate')!;
    assert.match(delegateTool.inputSchema.properties.effort!.description!, /独立选择，不继承/);
    replies.push(
      (listed.body as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name).join(','),
    );
    replies.push(text(await f.bridge.handle(auth, call('list_agents', {}))));
    replies.push(text(await f.bridge.handle(auth, call('delegate', { agent: 'Codex B', task: 'x' }))));
    // The parent holds this directory's write lease; the child still runs with write access instead of deadlocking.
    replies.push(
      text(
        await f.bridge.handle(
          auth,
          call('delegate', {
            agent: 'claude 本机',
            task: 'Add a test',
            effort: 'high',
            write: true,
            files: ['tests'],
            wait_seconds: 30,
          }),
        ),
      ),
    );
    return 'parent finished';
  };
  const input: MessageInput = {
    content: '让 Claude 本机 帮我写测试',
    mode: 'build',
    permissionMode: 'workspace-write',
    executionPolicy: 'cli-first',
    autoEscalate: false,
  };
  const parent = await f.workspace.send(conversation.id, input);
  assert.equal((await finish(f.workspace, parent.workflow.id)).status, 'completed');

  // The Recycle Bin / Trash tool exists wherever the system has one (Windows, macOS, Linux).
  const parentTools = capabilities().trash ? ',recycle_files' : '';
  assert.equal(
    replies.shift(),
    `report_outcome,list_agents,list_swarm,message_agent,set_plan,ask_user,add_project_rule,list_conversations,manage_conversations,delegate,delegate_many,get_result,cancel_task,message_task${parentTools},organize_files,undo_organize,git,read_run_detail,find_files,search_text,read_document,find_similar_images,summarize_folder,find_duplicates,analyze_media,test_page,search_tools,call_tool,call_read_only_tool,push_branch,open_branch_pull_request,merge_branch_pull_request,run_judge,judge_result,cancel_judge`
      .split(',')
      .sort()
      .join(','),
  );
  assert.match(replies[0]!, /Codex B（你自己）/);
  assert.match(replies[0]!, /Claude · 本机/);
  assert.match(replies[1]!, /Independent Codex child answer/);
  assert.match(replies[2]!, /Claude · 本机 已完成/);
  assert.match(replies[2]!, /Claude · 本机 answer/);

  const child = f.calls.find((ctx) => ctx.target.provider === 'claude')!;
  assert.equal(child.input.permissionMode, 'workspace-write');
  // The caller's effort is a target for automatic selection, not a user pin.
  assert.equal(child.input.effort, undefined);
  assert.equal(child.input.suggestedEffort, 'high');
  assert.equal(child.route.effort, 'high');
  assert.ok(child.route.reasons.some((reason) => reason.startsWith('调用方建议思考强度：high')));
  // Children retain their permission ceiling while receiving bounded nested delegation tools; outside swarm mode the
  // task list stays the parent's.
  assert.deepEqual(childTools, [
    [
      'report_outcome',
      'report_progress',
      'message_parent',
      'list_agents',
      'list_swarm',
      'message_agent',
      'delegate',
      'delegate_many',
      'get_result',
      'cancel_task',
      'message_task',
      ...(capabilities().trash ? ['recycle_files'] : []),
      'organize_files',
      'undo_organize',
      'git',
      'read_run_detail',
      'find_files',
      'search_text',
      'read_document',
      'find_similar_images',
      'summarize_folder',
      'find_duplicates',
      'analyze_media',
      'test_page',
      'search_tools',
      'call_read_only_tool',
      'call_tool',
    ].sort(),
  ]);
  assert.match(childDelegate[0]!, /Independent Codex child answer/);
  // It also starts without the parent's native session.
  assert.equal(child.input.continuationRunId, undefined);
  const children = f.workspace.store
    .workflows(conversation.id)
    .filter((workflow) => workflow.delegation?.parentId === parent.workflow.id);
  assert.equal(children.length, 2);
  assert.deepEqual(children.find((item) => item.delegation?.agent?.provider === 'claude')!.delegation?.agent, {
    label: 'Claude · 本机',
    provider: 'claude',
    runtimeId: 'claude',
    caller: 'Codex B',
  });

  const finishedParent = f.workspace.store.get<Workflow>('workflow', parent.workflow.id)!;
  const parentRun = f.controller.runWithAudit(finishedParent.runIds.at(-1)!)!;
  const savedChild = children.find((item) => item.delegation?.agent?.provider === 'claude')!;
  const childRun = f.controller.runWithAudit(savedChild.runIds.at(-1)!)!;
  const parentExecution = f.calls.find((ctx) => ctx.target.provider === 'codex' && ctx.agentBridge)!;
  for (const [run, ctx] of [
    [parentRun, parentExecution],
    [childRun, child],
  ] as const) {
    const context = run.events.find((event) => event.data?.kind === 'execution-context')!;
    assert.equal((context.data?.detail as Record<string, unknown>).prompt, safeToolEventText(ctx.input.prompt));
    assert.equal(JSON.stringify(context).includes(token), false);
    const route = run.events.find((event) => event.data?.kind === 'routing')!;
    assert.equal((route.data?.detail as Record<string, unknown>).runtimeId, ctx.route.runtimeId);
  }
  const assignment = parentRun.events.find(
    (event) =>
      event.text === '指派子任务' && (event.data?.detail as Record<string, unknown>)?.toWorkflowId === savedChild.id,
  )!;
  assert.equal((assignment.data?.detail as Record<string, unknown>).task, savedChild.input.content);
  assert.equal((assignment.data?.detail as Record<string, unknown>).toWorkflowId, savedChild.id);
  assert.equal((assignment.data?.detail as Record<string, unknown>).requestedEffort, 'high');
  assert.equal((assignment.data?.detail as Record<string, unknown>).effort, undefined);
  assert.equal((assignment.data?.detail as Record<string, unknown>).suggestedEffort, 'high');

  // The token expires with the run.
  assert.equal((await f.bridge.handle(`Bearer ${token}`, call('list_agents', {}))).status, 401);
  assert.equal((await f.bridge.handle(undefined, call('list_agents', {}))).status, 401);
});

test('new bridge grants expose fixed discovery tools while actual writes are approved by the host', async (t) => {
  const f = fixture(t);
  const readTools = ['synthetic__read', 'use_skill', 'read_skill_file'];
  let writeTools = ['synthetic__write', 'synthetic__delete'];
  t.mock.method(extensions, 'toolNames', (write: boolean, _skills?: string[], mcpAllowed?: string[]) =>
    [...readTools, ...(write ? writeTools : [])].filter((name) => !name.includes('__') || mcpAllowed?.length !== 0),
  );
  f.controller.githubToolNames = () => ['github_list_issues', 'github_create_issue'];
  const project = await f.workspace.createProject(f.directory);
  for (const permissionMode of ['workspace-write', 'read-only', 'workspace-write'] as const) {
    const conversation = f.workspace.createConversation(project.id);
    const sent = await f.workspace.send(conversation.id, {
      content: 'Complete the synthetic task',
      mode: permissionMode === 'read-only' ? 'chat' : 'build',
      permissionMode,
      executionPolicy: 'cli-first',
      autoEscalate: false,
    });
    assert.equal((await finish(f.workspace, sent.workflow.id)).status, 'completed');
    const ctx = f.calls.at(-1)!;
    assert.equal(ctx.input.permissionMode, permissionMode);
    const bridge = ctx.agentBridge!;
    assert.ok(bridge);
    assert.equal(bridge.askTools, undefined);
    assert.deepEqual(
      bridge.extraTools,
      [
        'use_skill',
        'read_skill_file',
        'search_tools',
        'call_read_only_tool',
        ...(permissionMode === 'workspace-write' ? ['call_tool', 'report_outcome'] : []),
      ].sort(),
    );
    if (permissionMode === 'read-only') writeTools = [];
  }
});

test('a read-only caller cannot grant write access, and the bridge can be turned off', async (t) => {
  const f = fixture(t);
  f.controller.githubToolNames = (write) => {
    assert.equal(write, false);
    return ['github_list_issues'];
  };
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  f.behavior.codex = async (ctx) => {
    if (!ctx.agentBridge) return 'no bridge';
    const reply = await f.bridge.handle(
      `Bearer ${ctx.agentBridge.token}`,
      call('delegate', { agent: 'claude', task: 'Edit files', write: true, files: ['src'], wait_seconds: 30 }),
    );
    assert.match(text(reply), /只读 · 上级任务是只读的/);
    return 'done';
  };
  const input: MessageInput = {
    content: 'Ask Claude to look',
    mode: 'chat',
    permissionMode: 'read-only',
    executionPolicy: 'cli-first',
    autoEscalate: false,
  };
  const parent = await f.workspace.send(conversation.id, input);
  await finish(f.workspace, parent.workflow.id);
  assert.equal(f.calls.find((ctx) => ctx.target.provider === 'claude')?.input.permissionMode, 'read-only');
  assert.ok(f.calls.find((ctx) => ctx.target.provider === 'claude')?.agentBridge?.extraTools?.includes('search_tools'));

  f.controller.settings.agentBridge = false;
  const before = f.calls.length;
  const next = await f.workspace.send(conversation.id, input);
  await finish(f.workspace, next.workflow.id);
  // With calling turned off the run keeps its local tools, but no sub-task can be created.
  assert.equal(f.calls.length, before + 1);
});

test('delegated scope restrictions preserve an explicit write grant and ignore conflicting intent hints', async (t) => {
  const f = fixture(t);
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  f.behavior.codex = async (ctx) => {
    if (!ctx.agentBridge) return 'no bridge';
    await f.bridge.handle(
      `Bearer ${ctx.agentBridge.token}`,
      call('delegate', {
        agent: 'claude',
        task: '不要改，只查看 tests。',
        intentText: 'Modify tests now.',
        write: true,
        files: ['tests'],
        wait_seconds: 30,
      }),
    );
    return 'done';
  };
  const parent = await f.workspace.send(conversation.id, {
    content: 'Ask Claude to update tests.',
    intentText: 'Update tests.',
    mode: 'build',
    permissionMode: 'workspace-write',
    executionPolicy: 'cli-first',
    autoEscalate: false,
  });
  assert.equal((await finish(f.workspace, parent.workflow.id)).status, 'completed');
  const child = f.calls.find((ctx) => ctx.target.provider === 'claude')!;
  assert.equal(child.input.permissionMode, 'workspace-write');
  assert.match(child.input.prompt, /范围限制（来自你的消息）：不要改/);
  assert.doesNotMatch(child.input.prompt, /Modify tests now/);
});

test('renaming a card is validated and takes effect for callers immediately', (t) => {
  const f = fixture(t);
  assert.throws(() => f.controller.renameTarget('codex', 'Claude · 本机'), /同名/);
  assert.throws(() => f.controller.renameTarget('codex', '  '), /1–40/);
  f.controller.renameTarget('codex', '主力 Codex');
  assert.equal(resolveAgent('主力codex', f.controller.targets).runtimeId, 'codex');
  assert.equal(f.controller.snapshots.find((s) => s.id === 'codex')?.label, '主力 Codex');
});

test('only existing paths strictly inside the project can be recycled', async (t) => {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'recycle-paths-test-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'folder'));
  writeFileSync(join(directory, 'folder', 'inner.txt'), 'x');
  writeFileSync(join(directory, 'a.txt'), 'x');
  const checked = await recyclablePaths(directory, [
    'a.txt',
    join(directory, 'A.TXT'),
    'folder',
    'folder/inner.txt',
    'missing.txt',
    '..',
    directory,
  ]);
  assert.deepEqual(checked.paths, [join(directory, 'a.txt'), join(directory, 'folder')]);
  // Case sensitivity belongs to the fixture's filesystem, not the operating system (macOS volumes vary too).
  const caseAliasExists = existsSync(join(directory, 'A.TXT'));
  assert.deepEqual(
    checked.failed.map((item) => item.reason),
    [...(caseAliasExists ? [] : ['不存在']), '不存在', '不在当前项目目录内', '不能回收项目目录本身'],
  );
  await assert.rejects(recyclablePaths(directory, 'a.txt'), /paths/);
  await assert.rejects(recyclablePaths(directory, []), /paths/);
});

test('read-only runs are not offered the Recycle Bin, and the setting turns it off', async (t) => {
  const f = fixture(t);
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const offered: (string[] | undefined)[] = [];
  f.behavior.codex = async (ctx) => {
    if (!ctx.agentBridge) {
      offered.push(undefined);
      return 'no bridge';
    }
    const listed = await f.bridge.handle(`Bearer ${ctx.agentBridge.token}`, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    offered.push((listed.body as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name));
    const refused = await f.bridge.handle(`Bearer ${ctx.agentBridge.token}`, call('recycle_files', { paths: ['x'] }));
    assert.match(text(refused), /不能修改文件|关闭/);
    return 'done';
  };
  const ask = (permissionMode: 'read-only' | 'workspace-write') =>
    f.workspace.send(conversation.id, {
      content: 'Tidy up',
      mode: permissionMode === 'read-only' ? 'chat' : 'build',
      permissionMode,
      executionPolicy: 'cli-first',
      autoEscalate: false,
    });
  await finish(f.workspace, (await ask('read-only')).workflow.id);
  f.controller.settings.recycleWithoutAsking = false;
  await finish(f.workspace, (await ask('workspace-write')).workflow.id);
  // Planner calls run read-only without tools; only execution steps are offered the bridge.
  assert.deepEqual(offered.filter(Boolean), [
    [
      'list_agents',
      'list_swarm',
      'message_agent',
      'set_plan',
      'ask_user',
      'add_project_rule',
      'delegate',
      'delegate_many',
      'get_result',
      'cancel_task',
      'message_task',
      'git',
      'read_run_detail',
      'find_files',
      'search_text',
      'read_document',
      'find_similar_images',
      'summarize_folder',
      'find_duplicates',
      'analyze_media',
      'test_page',
      'search_tools',
      'call_read_only_tool',
      'run_judge',
      'judge_result',
      'cancel_judge',
    ].sort(),
    [
      'report_outcome',
      'list_agents',
      'list_swarm',
      'message_agent',
      'set_plan',
      'ask_user',
      'add_project_rule',
      'delegate',
      'delegate_many',
      'get_result',
      'cancel_task',
      'message_task',
      'organize_files',
      'undo_organize',
      'list_conversations',
      'manage_conversations',
      'git',
      'read_run_detail',
      'find_files',
      'search_text',
      'read_document',
      'find_similar_images',
      'summarize_folder',
      'find_duplicates',
      'analyze_media',
      'test_page',
      'search_tools',
      'call_read_only_tool',
      'call_tool',
      'push_branch',
      'open_branch_pull_request',
      'merge_branch_pull_request',
      'run_judge',
      'judge_result',
      'cancel_judge',
    ].sort(),
  ]);
});
