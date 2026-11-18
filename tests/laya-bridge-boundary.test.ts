import { listenForFetch } from './helpers/fetch-port.ts';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, realpath, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AgentBridge } from '../src/server/agent-bridge.ts';
import { Controller } from '../src/server/controller.ts';
import { extensions } from '../src/server/extensions.ts';
import { Store } from '../src/server/store.ts';
import { LayaReviewStore } from '../src/server/laya-review-store.ts';
import { fork } from '../src/server/platform/test-process.ts';
import type { ConnectorService } from '../src/server/connectors.ts';
import type { Workspace } from '../src/server/workspace.ts';
import type { BridgeCatalogTool } from '../src/shared/bridge-catalog.ts';
import type { LayaReviewRecord } from '../src/shared/laya.ts';
import type { RunEvent, RunRecord, RuntimeTarget } from '../src/shared/types.ts';

type ToolResult = { isError?: boolean; content: Array<{ text: string }>; tools?: BridgeCatalogTool[] };
const externalNames = ['mcp_synthetic__command', 'mcp_synthetic__read', 'github_synthetic', 'connector_synthetic'];
const commandNames = [
  'git',
  'commit_branch',
  'run_remote_query',
  'run_remote_job',
  'remote_job_status',
  'cancel_remote_job',
];
async function temporary(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'pugport-laya-boundary-')));
  const closers: Array<() => Promise<void>> = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    assert.equal(dirname(directory).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
    assert.ok(basename(directory).startsWith('pugport-laya-boundary-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { directory, beforeCleanup: (close: () => Promise<void>) => closers.push(close) };
}

async function bridgeFixture(t: TestContext, prohibitCommands: boolean) {
  const { directory, beforeCleanup } = await temporary(t);
  await writeFile(join(directory, 'synthetic-note.txt'), 'Synthetic file content remains readable.');
  const effects: string[] = [];
  const events: RunEvent[] = [];
  const abort = new AbortController();
  const target = { id: 'synthetic', provider: 'codex', enabled: true } as RuntimeTarget;
  const run = {
    id: 'run-a',
    workflowId: 'workflow-a',
    projectPath: directory,
    status: 'running',
    route: { runtimeId: target.id },
    toolApprovalMode: 'auto',
  } as RunRecord;
  const controller = new EventEmitter() as unknown as Controller;
  Object.setPrototypeOf(controller, Controller.prototype);
  Object.assign(controller, {
    dataDir: directory,
    active: new Map([[run.id, { run, abort }]]),
    targets: [target],
    bridgeTokens: new Map([
      [
        'synthetic',
        {
          runId: run.id,
          prohibitCommands,
          delegate: false,
          child: false,
          recycle: false,
          write: true,
          deferredTools: true,
          abort,
        },
      ],
    ]),
    recordRunEvent: (_id: string, event: RunEvent) => events.push(event),
    returnExecution: () => async () => {},
    retainMutation: () => () => {},
    approve: async () => {
      effects.push('approve');
      return true;
    },
  });
  const project = { id: 'project-a', path: directory, mcpServers: ['synthetic'] };
  const workspace = {
    store: {
      get: (kind: string) =>
        kind === 'workflow'
          ? { id: 'workflow-a', projectId: project.id, conversationId: 'chat-a', input: {} }
          : kind === 'project'
            ? project
            : kind === 'conversation'
              ? { projectId: project.id, connectorIds: ['synthetic'] }
              : undefined,
    },
    takeNotices: () => [],
  } as unknown as Workspace;
  const catalog = externalNames.slice(0, 2).map((name) => ({
    name,
    description: 'Synthetic external tool',
    inputSchema: { type: 'object' },
    annotations: { readOnlyHint: name.endsWith('__read') },
  }));
  t.mock.method(extensions, 'bridgeTools', (write: boolean) =>
    catalog.filter((tool) => write || tool.annotations.readOnlyHint),
  );
  t.mock.method(extensions, 'handles', (name: string) => catalog.some((tool) => tool.name === name));
  t.mock.method(
    extensions,
    'call',
    async (
      name: string,
      _args: unknown,
      _write: boolean,
      _signal?: AbortSignal,
      _skills?: string[],
      _servers?: string[],
      authorize?: () => Promise<void>,
      validate?: () => void,
    ) => {
      await authorize?.();
      validate?.();
      effects.push(name);
      return { content: [{ type: 'text' as const, text: 'Synthetic external result' }] };
    },
  );
  const connectors = {
    toolsFor: async () => [
      { name: 'connector_synthetic', description: 'Synthetic read', inputSchema: {}, readOnly: true },
    ],
    validateCall: (_name: string, args: unknown) => args,
    call: async () => {
      effects.push('connector_synthetic');
      return { value: 'Synthetic connector result' };
    },
  } as unknown as ConnectorService;
  const github = {
    tools: () => [{ name: 'synthetic', description: 'Synthetic read', inputSchema: {}, readOnly: true }],
    call: async () => {
      effects.push('github_synthetic');
      return { content: [{ type: 'text' as const, text: 'Synthetic GitHub result' }], isError: false };
    },
    defaultBranch: async () => 'unused',
  };
  const bridge = new AgentBridge(workspace, controller, directory, {}, connectors, undefined, github);
  const builtins = bridge as unknown as {
    call(
      caller: unknown,
      name: string,
      args: Record<string, unknown>,
      signal?: AbortSignal,
      steps?: unknown,
    ): Promise<unknown>;
  };
  const original = builtins.call.bind(bridge);
  t.mock.method(
    builtins,
    'call',
    async (caller: unknown, name: string, args: Record<string, unknown>, signal?: AbortSignal, steps?: unknown) => {
      effects.push(name);
      return commandNames.includes(name)
        ? 'Synthetic command result; no process launched.'
        : original(caller, name, args, signal, steps);
    },
  );
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const response = await bridge.handle(req.headers.authorization, JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response.body));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error) }));
    }
  });
  await listenForFetch(server);
  beforeCleanup(async () => {
    await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
    await bridge.close();
    controller.removeAllListeners();
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const request = async (method: string, params?: object) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    const reply = (await response.json()) as { result: ToolResult; error?: unknown };
    assert.equal(reply.error, undefined, JSON.stringify(reply));
    return reply.result;
  };
  return {
    directory,
    effects,
    events,
    controller,
    request,
    call: (name: string, args: object = {}) => request('tools/call', { name, arguments: args }),
  };
}

test('HTTP bridge denies direct commands and unverified external tools before dispatch when Laya prohibits commands', async (t) => {
  const f = await bridgeFixture(t, true);
  assert.equal(f.controller.agentBridgeCaller('synthetic')?.prohibitCommands, true);
  assert.equal(
    f.controller.agentBridgeCaller('synthetic')?.write,
    true,
    'file writes retain their separate permission',
  );
  for (const name of [...commandNames, ...externalNames, 'unknown_synthetic']) {
    const result = await f.call(name);
    assert.equal(result.isError, true, name);
    assert.match(result.content[0]!.text, /本轮禁止执行命令/, name);
  }
  assert.deepEqual(f.effects, []);
  const failures = f.events.filter((event) => event.data?.kind === 'pugportToolCall' && event.data.status === 'failed');
  assert.equal(failures.length, commandNames.length + externalNames.length + 1);
});

test('HTTP catalog discovery grants no bypass through either tool proxy under Laya command prohibition', async (t) => {
  const f = await bridgeFixture(t, true);
  const discovered = await f.call('search_tools', { names: externalNames });
  assert.equal(discovered.isError, undefined);
  assert.deepEqual(
    JSON.parse(discovered.content[0]!.text)
      .tools.map((tool: BridgeCatalogTool) => tool.name)
      .sort(),
    [...externalNames].sort(),
  );
  for (const proxy of ['call_tool', 'call_read_only_tool']) {
    for (const name of [...commandNames, ...externalNames]) {
      const result = await f.call(proxy, { name, arguments: {} });
      assert.equal(result.isError, true, `${proxy} -> ${name}`);
      assert.match(result.content[0]!.text, /本轮禁止执行命令/);
    }
    const nested = await f.call(proxy, {
      name: 'call_tool',
      arguments: { name: 'mcp_synthetic__command', arguments: {} },
    });
    assert.equal(nested.isError, true);
  }
  assert.deepEqual(f.effects, []);
});

test('HTTP bridge without the Laya flag preserves direct commands and authorized external proxy dispatch', async (t) => {
  const f = await bridgeFixture(t, false);
  assert.equal(f.controller.agentBridgeCaller('synthetic')?.prohibitCommands, undefined);
  for (const name of [...commandNames, ...externalNames]) assert.notEqual((await f.call(name)).isError, true, name);
  for (const name of externalNames)
    assert.notEqual((await f.call('call_tool', { name, arguments: {} })).isError, true, name);
  assert.deepEqual(f.effects, [...commandNames, ...externalNames, ...externalNames]);
});

test('HTTP Laya command prohibition keeps local file tools advertised and can read and find a synthetic document', async (t) => {
  const f = await bridgeFixture(t, true);
  const listed = await f.request('tools/list');
  for (const name of ['find_files', 'read_document'])
    assert.ok(
      listed.tools?.some((tool) => tool.name === name),
      name,
    );
  const read = await f.call('read_document', { path: 'synthetic-note.txt' });
  assert.equal(read.isError, undefined);
  assert.equal(read.content[0]!.text, 'Synthetic file content remains readable.');
  const found = await f.call('find_files', { query: 'synthetic-note.txt' });
  assert.equal(found.isError, undefined);
  assert.ok(found.content[0]!.text.includes(join(f.directory, 'synthetic-note.txt')), found.content[0]!.text);
  assert.deepEqual(f.effects, ['read_document', 'find_files']);
});

test(
  'real local HTTP Laya records require a session, filter dates and statuses, preserve used batches and clear only records',
  { timeout: 60000 },
  async (t) => {
    const { directory, beforeCleanup } = await temporary(t);
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const data = join(directory, 'data');
    const projectPath = join(directory, 'synthetic-project');
    await mkdir(projectPath);
    await writeFile(join(projectPath, 'keep.txt'), 'Keep this project.');
    const store = new Store(data);
    store.setConfig(
      'targets',
      (['codex', 'claude', 'grok', 'pi', 'cursor', 'gemini'] as const).map<RuntimeTarget>((provider) => ({
        id: provider + '-native',
        provider,
        label: 'Disabled synthetic',
        command: 'unused',
        environment: 'native',
        enabled: false,
        commandDiscovery: 'fixed',
      })),
    );
    store.setConfig('settings', {
      laya: { mode: 'rules', enabled: false, recordTraining: true, shareTraining: false },
    });
    store.close();
    const reviews = new LayaReviewStore(data);
    const capture = (day: number): Omit<LayaReviewRecord, 'id' | 'training'> => ({
      workflowId: randomUUID(),
      projectId: 'synthetic-project',
      conversationId: 'synthetic-chat',
      createdAt: new Date(2026, 9, day, 12).toISOString(),
      question: `Synthetic question on day ${day}`,
      state: {
        message: 'Synthetic question',
        recent_context: '',
        reference_text: '',
        attachments: [],
        candidate_executors: [],
      },
      inference: { status: 'skipped', reason: 'synthetic-no-model', modelVersion: 'pugport-laya-v4', latencyMs: 0 },
      policy: { applied: false, reasons: [], conflicts: [], excludeRuntimeIds: [] },
    });
    const first = (await reviews.capture(capture(26)))!;
    await reviews.capture(capture(27));
    const child = fork(join(root, 'src/server/main.ts'), [], {
      cwd: root,
      execArgv: ['--import', 'tsx'],
      windowsHide: true,
      env: {
        ...process.env,
        COMBORUNNER_ROOT: directory,
        COMBORUNNER_DATA_DIR: data,
        COMBORUNNER_MEMORY_DIR: join(directory, 'memory'),
        COMBORUNNER_SECRETS_DIR: join(directory, 'synthetic-secrets'),
        COMBORUNNER_PORT: '0',
        USERPROFILE: directory,
        HOME: directory,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let output = '';
    child.stdout?.on('data', (chunk) => (output += chunk));
    child.stderr?.on('data', (chunk) => (output += chunk));
    const exited = new Promise((done) => child.once('exit', done));
    beforeCleanup(async () => {
      if (child.exitCode === null && child.connected) child.send('shutdown');
      const timer = setTimeout(() => child.kill(), 5000);
      await exited;
      clearTimeout(timer);
    });
    let startupTimer: NodeJS.Timeout | undefined;
    let token = '';
    let owner = '';
    const port = await new Promise<number>((done, reject) => {
      startupTimer = setTimeout(() => reject(Error(`Synthetic server did not start: ${output}`)), 40000);
      child.once('error', reject);
      child.once('exit', () => reject(Error(output)));
      child.on('message', (message: { type?: string; token?: string; owner?: string; port?: number }) => {
        if (message.type === 'session') {
          token = message.token ?? '';
          owner = message.owner ?? '';
        }
        if (message.type === 'ready' && message.port) done(message.port);
      });
    }).finally(() => clearTimeout(startupTimer));
    const base = `http://127.0.0.1:${port}`;
    const session = { token };
    const request = (path: string, method = 'GET', body?: unknown, authenticated = true) =>
      fetch(base + path, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(authenticated ? { 'x-agent-token': session.token, 'x-pugport-owner': owner } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000),
      });
    assert.equal((await request('/api/laya/records', 'GET', undefined, false)).status, 403);
    assert.equal((await request('/api/laya/status', 'GET', undefined, false)).status, 403);
    assert.equal((await request('/api/laya/records', 'HEAD', undefined, false)).status, 403);
    assert.equal(
      (await request('/api/laya/records/transition', 'POST', { ids: [first], status: 'reviewed' }, false)).status,
      403,
    );
    assert.equal((await request('/api/laya/records', 'DELETE', undefined, false)).status, 403);
    const status = (await request('/api/laya/status').then((response) => response.json())) as {
      settings: { mode: string; enabled: boolean; recordTraining: boolean };
      status: { state: string };
      training: { recording: boolean; directory: string };
    };
    assert.equal(status.settings.enabled, false);
    assert.equal(status.settings.mode, 'rules');
    assert.equal(status.status.state, 'disabled');
    assert.equal(status.training.recording, true);
    assert.equal(status.training.directory, reviews.directory);
    const list = async (query = '') => {
      const response = await request('/api/laya/records' + query);
      assert.equal(response.status, 200);
      return (await response.json()) as { records: LayaReviewRecord[] };
    };
    assert.equal((await list()).records.length, 2);
    assert.deepEqual(
      (await list('?date=2026-10-26&status=pending&limit=1')).records.map((record) => record.id),
      [first],
    );
    const transition = (status: string, batchId?: string) =>
      request('/api/laya/records/transition', 'POST', {
        ids: [first],
        status,
        ...(batchId ? { batchId } : {}),
        modelVersion: 'synthetic-v5',
      });
    assert.equal((await transition('reviewed')).status, 200);
    assert.equal((await transition('reserved', 'synthetic-batch')).status, 200);
    assert.equal((await transition('used', 'synthetic-batch')).status, 200);
    assert.notEqual((await transition('reviewed', 'synthetic-batch')).status, 200);
    assert.notEqual((await transition('used', 'different-batch')).status, 200);
    const used = (await list('?date=2026-10-26&status=used')).records[0]!;
    assert.equal(used.training.batchId, 'synthetic-batch');
    assert.equal(used.training.modelVersion, 'synthetic-v5');
    assert.equal((await list('?date=2026-10-26&status=pending')).records.length, 0);
    assert.notEqual((await request('/api/laya/records?limit=201')).status, 200);
    assert.notEqual((await request('/api/laya/records?date=2026-10-99')).status, 200);
    assert.equal((await request('/api/settings', 'PATCH', { laya: { recordTraining: false } })).status, 200);
    const disabled = (await request('/api/laya/status').then((response) => response.json())) as typeof status;
    assert.equal(disabled.settings.recordTraining, false);
    assert.equal(disabled.training.recording, false);
    assert.equal((await list()).records.length, 2, 'recording off keeps existing samples');
    assert.equal((await request('/api/laya/records', 'DELETE')).status, 200);
    assert.equal((await list()).records.length, 0);
    assert.equal(await readFile(join(projectPath, 'keep.txt'), 'utf8'), 'Keep this project.');
  },
);
