import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { AgentBridge } from '../src/server/agent-bridge.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { ProjectCliContextService } from '../src/server/project-cli-context.ts';
import { RemoteJobs } from '../src/server/remote-jobs.ts';
import type { spawnTarget } from '../src/server/adapters/process.ts';
import { Workspace } from '../src/server/workspace.ts';
import { hostBridgeToolNames } from '../src/server/adapters/host-bridge.ts';
import { agentBridgeTools } from '../src/server/adapters/claude.ts';
import { conversationWorkTools } from '../src/server/conversation-work-tools.ts';
import type { Controller } from '../src/server/controller.ts';
import type { Workflow, RunRecord } from '../src/shared/types.ts';

test('workflow tool schemas are shared by the live MCP catalog and Pi, while readonly runs cannot obtain commit', async (t) => {
  const db = new DatabaseSync(':memory:');
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  t.after(() => db.close());
  store.save('project', 'p', 'p', { id: 'p', path: 'synthetic-unused-project' });
  store.save('workflow', 'w', 'c', {
    id: 'w',
    projectId: 'p',
    conversationId: 'c',
    input: { permissionMode: 'workspace-write' },
    executionWorkspace: { mode: 'branch' },
  } as Workflow);
  const workspace = Object.assign(Object.create(Workspace.prototype), {
    store,
    takeNotices: () => [],
    conversationAutomation: {},
    projectCliContext: {},
  }) as Workspace;
  const caller = {
    run: { id: 'r', workflowId: 'w', projectPath: 'synthetic-unused-project' } as RunRecord,
    target: { provider: 'codex' },
    delegate: false,
    recycle: false,
    child: false,
    write: true,
    signal: new AbortController().signal,
  };
  const controller = Object.assign(new EventEmitter(), {
    dataDir: 'synthetic-unused-data',
    agentBridgeCaller: () => caller,
    returnExecution: () => async () => {},
    recordRunEvent: () => {},
  }) as unknown as Controller;
  const bridge = new AgentBridge(workspace, controller);
  const listed = await bridge.handle('Bearer synthetic', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const tools = (listed.body as any).result.tools as Array<{ name: string; inputSchema: Record<string, unknown> }>;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  for (const definition of conversationWorkTools) {
    assert.deepEqual(byName.get(definition.name)?.inputSchema, definition.inputSchema);
    assert.ok(agentBridgeTools.includes(`mcp__pugport__${definition.name}`));
  }
  const lane = byName.get('create_lane')!.inputSchema as {
    properties: Record<string, { type: string }>;
    required: string[];
  };
  for (const name of ['base', 'branch']) {
    assert.equal(lane.properties[name]?.type, 'string');
    assert.ok(!lane.required.includes(name));
  }
  for (const name of [
    'list_remote_queries',
    'run_remote_query',
    'run_remote_job',
    'remote_job_status',
    'cancel_remote_job',
    'commit_branch',
  ]) {
    assert.equal(byName.get(name)?.inputSchema.type, 'object');
    if (name === 'run_remote_job')
      assert.deepEqual((byName.get(name)?.inputSchema as { required: string[] }).required, ['name']);
    assert.ok(agentBridgeTools.includes(`mcp__pugport__${name}`));
  }
  const grant = { url: 'http://127.0.0.1:5555/synthetic-bridge', token: 'synthetic' };
  const fetchImpl = async () =>
    new Response(JSON.stringify(listed.body), { headers: { 'content-type': 'application/json' } });
  const names = await hostBridgeToolNames(grant, caller.signal, fetchImpl as typeof fetch);
  assert.deepEqual(
    names,
    tools.map((tool) => tool.name),
    'Cursor and Gemini consume this authenticated dynamic name catalog',
  );
  const { registerPiHostBridge } = await import(pathToFileURL(join(process.cwd(), 'src/server/pi-extension.mjs')).href);
  const registered = new Map<string, any>();
  await registerPiHostBridge(
    { registerTool: (tool: any) => registered.set(tool.name, tool), registerCommand() {} },
    {
      COMBORUNNER_AGENT_BRIDGE_URL: grant.url,
      COMBORUNNER_AGENT_BRIDGE_TOKEN: grant.token,
      COMBORUNNER_AGENT_BRIDGE_TOOLS: JSON.stringify(names),
    },
    fetchImpl,
  );
  for (const name of [
    ...conversationWorkTools.map((tool) => tool.name),
    'list_remote_queries',
    'run_remote_query',
    'run_remote_job',
    'remote_job_status',
    'cancel_remote_job',
    'commit_branch',
  ])
    assert.deepEqual(registered.get(`pugport_${name}`)?.parameters, byName.get(name)?.inputSchema);
  caller.write = false;
  const readonly = await bridge.handle('Bearer synthetic', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.ok(!(readonly.body as any).result.tools.some((tool: any) => tool.name === 'commit_branch'));
  for (const name of ['run_remote_job', 'remote_job_status', 'cancel_remote_job'])
    assert.ok(
      (readonly.body as any).result.tools.some((tool: any) => tool.name === name),
      name,
    );
});

test('external dispatches are not offered automation creation or resume tools', async () => {
  const db = new DatabaseSync(':memory:');
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  store.save('project', 'p', 'p', { id: 'p', path: 'synthetic-unused-project' });
  const workflow = { id: 'w', projectId: 'p', conversationId: 'c', input: {} } as Workflow;
  const workspace = Object.assign(Object.create(Workspace.prototype), {
    store,
    takeNotices: () => [],
    conversationAutomation: {},
  }) as Workspace;
  const controller = Object.assign(new EventEmitter(), {
    dataDir: 'synthetic-unused-data',
    agentBridgeCaller: () => ({
      run: { id: 'r', workflowId: workflow.id },
      target: { provider: 'codex' },
      write: false,
      signal: new AbortController().signal,
    }),
    returnExecution: () => async () => {},
  }) as unknown as Controller;
  const bridge = new AgentBridge(workspace, controller);
  try {
    for (const source of ['external', 'caller', 'device', 'user', undefined] as const) {
      workflow.input.permissionOrigin = source ? { mode: 'read-only', source } : undefined;
      store.save('workflow', workflow.id, workflow.conversationId, workflow);
      const listed = await bridge.handle('Bearer synthetic', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      assert.ok((listed.body as any).result, JSON.stringify(listed.body));
      const names = (listed.body as any).result.tools.map((tool: { name: string }) => tool.name) as string[];
      for (const name of ['create_lane', 'schedule_work', 'watch_pull_request', 'pause_scheduled_work'])
        assert.equal(names.includes(name), source === 'user' || source === undefined, `${source}: ${name}`);
      for (const name of ['list_conversation_work', 'list_project_conversations', 'delete_scheduled_work'])
        assert.ok(names.includes(name), `${source}: ${name}`);
    }
  } finally {
    await bridge.close();
    db.close();
  }
});

test('remote job tools enforce write ceilings and project ownership through the bridge', async (t) => {
  const db = new DatabaseSync(':memory:');
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  t.after(() => db.close());
  for (const id of ['p', 'q']) {
    store.save('project', id, id, { id, path: process.cwd(), scope: 'project' });
    store.save('workflow', 'w-' + id, 'c-' + id, {
      id: 'w-' + id,
      projectId: id,
      conversationId: 'c-' + id,
      input: {},
    } as Workflow);
  }
  const context = new ProjectCliContextService(store);
  await context.update(
    'p',
    {
      revision: 0,
      autoMemoryDirectory: null,
      sshQueries: [
        { name: 'write', host: 'fake-host', argv: ['true'], background: true, params: { mode: 'word' } },
        { name: 'read', host: 'fake-host', argv: ['true'], background: true, readOnly: true },
        { name: 'query', host: 'fake-host', argv: ['true'] },
        {
          name: 'push',
          host: 'fake-host',
          argv: ['true'],
          background: true,
          push: { repository: '/fake.git', refs: ['main:main'] },
        },
      ],
    },
    { source: 'user' },
  );
  let launches = 0;
  const launch: typeof spawnTarget = async () => {
    launches++;
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
    });
    let script = '';
    child.stdin.on('data', (chunk) => {
      script += chunk.toString();
    });
    setImmediate(() => {
      child.stdout.write(
        script.includes('echo STARTED')
          ? 'STARTED\n'
          : script.includes('tail -c')
            ? '0\n---\nRESULT: ok\n---\ntail'
            : '',
      );
      child.exitCode = 0;
      child.emit('close', 0);
    });
    return child as unknown as Awaited<ReturnType<typeof spawnTarget>>;
  };
  let failWait = false;
  const jobs = new RemoteJobs(context, store, {
    launch,
    terminate: async () => {},
    sleep: async () => {
      if (failWait) throw new Error('synthetic wait failure');
    },
  });
  const workspace = Object.assign(Object.create(Workspace.prototype), {
    store,
    projectCliContext: context,
    remoteJobs: jobs,
    takeNotices: () => [],
  }) as Workspace;
  const caller = {
    run: { id: 'r', workflowId: 'w-p' } as RunRecord,
    target: { provider: 'codex' },
    write: false,
    prohibitCommands: false,
    signal: new AbortController().signal,
  };
  const controller = Object.assign(new EventEmitter(), {
    dataDir: 'synthetic-unused-data',
    agentBridgeCaller: () => caller,
    returnExecution: () => async () => {},
    recordRunEvent: () => {},
  }) as unknown as Controller;
  const bridge = new AgentBridge(workspace, controller);
  t.after(() => bridge.close());
  const call = async (name: string, args: object = {}) => {
    const response = await bridge.handle('Bearer synthetic', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    return (response.body as any).result as { isError?: boolean; content: { text: string }[] };
  };
  const list = await call('list_remote_queries');
  assert.deepEqual(JSON.parse(list.content[0]!.text), [
    { name: 'write', host: 'fake-host', background: true, params: { mode: 'word' }, readOnly: false, push: false },
    { name: 'read', host: 'fake-host', background: true, params: {}, readOnly: true, push: false },
    { name: 'query', host: 'fake-host', background: false, params: {}, readOnly: false, push: false },
    { name: 'push', host: 'fake-host', background: true, params: {}, readOnly: false, push: true },
  ]);
  assert.match((await call('run_remote_query', { name: 'write' })).content[0]!.text, /这是远程作业/);
  assert.equal((await call('run_remote_job', { name: 'write', params: { mode: 'fast' } })).isError, true);
  assert.equal(launches, 0);
  assert.equal((await call('run_remote_job', { name: 'read', params: {}, wait_seconds: 301 })).isError, true);
  assert.equal(launches, 0);
  const started = await call('run_remote_job', { name: 'read' });
  assert.equal(started.isError, undefined);
  const job = JSON.parse(started.content[0]!.text);
  assert.equal(job.status, 'running');
  assert.equal(launches, 1);
  caller.run.workflowId = 'w-q';
  for (const name of ['remote_job_status', 'cancel_remote_job']) {
    const result = await call(name, { job_id: job.jobId });
    assert.equal(result.isError, true, name);
    assert.match(result.content[0]!.text, /not authorized/);
  }
  assert.equal(launches, 1);
  caller.run.workflowId = 'w-p';
  const status = await call('remote_job_status', { job_id: job.jobId });
  assert.equal(JSON.parse(status.content[0]!.text).status, 'completed');
  caller.write = true;
  const writeJob = JSON.parse(
    (await call('run_remote_job', { name: 'write', params: { mode: 'fast' } })).content[0]!.text,
  );
  assert.equal(writeJob.status, 'running');
  const cancelled = await call('cancel_remote_job', { job_id: writeJob.jobId });
  assert.equal(JSON.parse(cancelled.content[0]!.text).status, 'cancelled');
  assert.equal(launches, 4);
  const waited = await call('run_remote_job', { name: 'read', params: {}, wait_seconds: 5 });
  assert.equal(JSON.parse(waited.content[0]!.text).status, 'completed');
  assert.equal(launches, 6);
  failWait = true;
  const failedWait = JSON.parse(
    (await call('run_remote_job', { name: 'read', params: {}, wait_seconds: 5 })).content[0]!.text,
  );
  assert.equal(failedWait.status, 'running');
  assert.match(failedWait.jobId, /^rj-/);
  assert.match(failedWait.error, /等待失败/);
  assert.equal(launches, 7);
  caller.prohibitCommands = true;
  for (const name of ['run_remote_job', 'remote_job_status', 'cancel_remote_job']) {
    const result = await call(name, { name: 'read', params: {}, job_id: job.jobId });
    assert.equal(result.isError, true, name);
    assert.match(result.content[0]!.text, /本轮禁止执行命令/);
  }
  assert.equal(launches, 7);
});
