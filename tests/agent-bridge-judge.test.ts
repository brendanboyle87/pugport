import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test, type TestContext } from 'node:test';
import { AgentBridge } from '../src/server/agent-bridge.ts';
import { extensions } from '../src/server/extensions.ts';
import type { ConnectorService } from '../src/server/connectors.ts';
import type { Controller } from '../src/server/controller.ts';
import type { Workspace } from '../src/server/workspace.ts';

const names = ['run_judge', 'judge_result', 'cancel_judge'];
const sha = 'a'.repeat(40);
function fixture(
  t: TestContext,
  options: {
    scope?: string;
    workflow?: boolean;
    project?: boolean;
    removed?: boolean;
    caller?: Record<string, unknown>;
    runner?: boolean;
  } = {},
) {
  const events: { type: string; data?: Record<string, unknown> }[] = [];
  const calls: unknown[][] = [];
  let startStatus: 'running' | 'busy' = 'running';
  const caller = {
    run: { id: 'run', ...(options.workflow === false ? {} : { workflowId: 'wf' }) },
    target: { provider: 'codex' },
    delegate: false,
    recycle: false,
    child: false,
    write: false,
    network: false,
    signal: new AbortController().signal,
    ...options.caller,
  };
  const controller = Object.assign(new EventEmitter(), {
    dataDir: '.',
    agentBridgeCaller: () => caller,
    returnExecution: () => async () => {},
    recordRunEvent: (_id: string, event: { type: string; data?: Record<string, unknown> }) => events.push(event),
  }) as unknown as Controller;
  const judgeRunner = {
    start: async (input: unknown, opts: { audit: (phase: string, fields: Record<string, unknown>) => void }) => {
      calls.push(['start', input]);
      opts.audit('spawned', { judgeId: 'jg-one', sha, executor: 'codex', argv: ['exec'], prompt: 'SECRET PROMPT' });
      return { judge_id: 'jg-one', status: startStatus, sha, executor: 'codex', file: 'verdict.md' };
    },
    result: async (...args: unknown[]) => {
      calls.push(['result', ...args]);
      return { judge_id: args[1], status: 'completed' };
    },
    cancel: async (...args: unknown[]) => {
      calls.push(['cancel', ...args]);
      return { judge_id: args[1], status: 'cancelled' };
    },
  };
  const workspace = {
    store: {
      get: (kind: string, id: string) =>
        kind === 'workflow' && id === 'wf'
          ? { id, projectId: 'p', conversationId: 'c', input: {} }
          : kind === 'project' && id === 'p' && options.project !== false
            ? { id, scope: options.scope ?? 'project', ...(options.removed ? { removedAt: 'now' } : {}) }
            : kind === 'conversation' && id === 'c'
              ? { id, projectId: 'p' }
              : undefined,
    },
    takeNotices: () => [],
    restoreAutoArchivedWorkflow: () => {},
    ...(options.runner === false ? {} : { judgeRunner }),
  } as unknown as Workspace;
  const bridge = new AgentBridge(workspace, controller, 'unused', {}, {
    toolsFor: async () => [],
  } as unknown as ConnectorService);
  t.after(() => bridge.close());
  return {
    bridge,
    calls,
    events,
    setStartStatus: (status: 'running' | 'busy') => {
      startStatus = status;
    },
  };
}
async function list(bridge: AgentBridge) {
  const response = await bridge.handle('Bearer synthetic', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  return (
    response.body as {
      result: {
        tools: { name: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> }[];
      };
    }
  ).result.tools;
}
async function call(bridge: AgentBridge, name: string, args: Record<string, unknown>) {
  const response = await bridge.handle('Bearer synthetic', {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  return response.body as { result: { isError?: boolean; content: { text: string }[] } };
}

test('judge tools are listed only for eligible project calls', async (t) => {
  t.mock.method(extensions, 'bridgeTools', () => []);
  const available = fixture(t);
  const tools = await list(available.bridge);
  for (const name of names) assert.ok(tools.some((tool) => tool.name === name));
  for (const tool of tools.filter((item) => names.includes(item.name)))
    assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(tools.find((tool) => tool.name === 'run_judge')?.inputSchema, {
    type: 'object',
    properties: {
      sha: { type: 'string', pattern: '^[0-9a-f]{40}$' },
      claim: { type: 'string', maxLength: 65536 },
      wait_seconds: { type: 'integer', minimum: 0, maximum: 300 },
    },
    required: ['sha', 'claim'],
    additionalProperties: false,
  });
  assert.deepEqual(tools.find((tool) => tool.name === 'judge_result')?.inputSchema, {
    type: 'object',
    properties: {
      judge_id: { type: 'string', maxLength: 24 },
      wait_seconds: { type: 'integer', minimum: 0, maximum: 300 },
    },
    required: ['judge_id'],
    additionalProperties: false,
  });
  assert.deepEqual(tools.find((tool) => tool.name === 'cancel_judge')?.inputSchema, {
    type: 'object',
    properties: { judge_id: { type: 'string', maxLength: 24 } },
    required: ['judge_id'],
    additionalProperties: false,
  });
  assert.equal(tools.find((tool) => tool.name === 'judge_result')?.annotations?.readOnlyHint, true);
  for (const options of [
    { scope: 'chat' },
    { workflow: false },
    { project: false },
    { removed: true },
    { caller: { child: true } },
    { caller: { background: true } },
    { caller: { prohibitCommands: true } },
  ]) {
    const f = fixture(t, options);
    assert.ok((await list(f.bridge)).every((tool) => !names.includes(tool.name)));
    for (const name of names) {
      const result = await call(f.bridge, name, { sha, claim: 'claim', judge_id: 'jg-one' });
      assert.equal(result.result.isError, true);
      assert.match(
        result.result.content[0].text,
        options.caller?.prohibitCommands ? /本轮禁止执行命令/ : /只有项目任务可以运行判官/,
      );
    }
  }
});

test('judge dispatch validates input, forwards project, waits only on request, and audits no prompt', async (t) => {
  t.mock.method(extensions, 'bridgeTools', () => []);
  const f = fixture(t);
  for (const [name, args, error] of [
    ['run_judge', { sha: 'a'.repeat(39), claim: 'x' }, 'sha 必须是 40 位小写十六进制提交号。'],
    ['run_judge', { sha, claim: '' }, 'claim 不能为空。'],
    ['run_judge', { sha, claim: 4 }, 'claim 不能为空。'],
    ['run_judge', { sha, claim: 'x'.repeat(65537) }, 'claim 过长。'],
    ['judge_result', { judge_id: 'x'.repeat(25) }, '请选择判官编号。'],
    ['cancel_judge', { judge_id: 5 }, '请选择判官编号。'],
    ['judge_result', { judge_id: 'jg-one', wait_seconds: 301 }, 'wait_seconds 必须是 0 至 300 的整数。'],
  ] as const) {
    const response = await call(f.bridge, name, args);
    assert.equal(response.result.isError, true);
    assert.equal(response.result.content[0].text, error);
  }
  const first = await call(f.bridge, 'run_judge', { sha, claim: 'claim' });
  assert.equal(first.result.isError, undefined);
  assert.deepEqual(f.calls[0], ['start', { projectId: 'p', sha, claim: 'claim' }]);
  assert.equal(f.calls.filter((item) => item[0] === 'result').length, 0);
  await call(f.bridge, 'judge_result', { judge_id: 'jg-one' });
  assert.deepEqual(f.calls.at(-1), ['result', 'p', 'jg-one', 0]);
  await call(f.bridge, 'judge_result', { judge_id: 'jg-one', wait_seconds: 7 });
  assert.deepEqual(f.calls.at(-1), ['result', 'p', 'jg-one', 7]);
  await call(f.bridge, 'run_judge', { sha, claim: 'claim', wait_seconds: 3 });
  assert.deepEqual(f.calls.at(-1), ['result', 'p', 'jg-one', 3]);
  f.setStartStatus('busy');
  await call(f.bridge, 'run_judge', { sha, claim: 'claim', wait_seconds: 3 });
  assert.deepEqual(f.calls.at(-1), ['start', { projectId: 'p', sha, claim: 'claim' }]);
  await call(f.bridge, 'cancel_judge', { judge_id: 'jg-one' });
  assert.deepEqual(f.calls.at(-1), ['cancel', 'p', 'jg-one']);
  const audit = f.events.filter((event) => event.data?.kind === 'judge');
  assert.ok(audit.length);
  assert.doesNotMatch(JSON.stringify(audit), /SECRET PROMPT/);
  const unavailable = fixture(t, { runner: false });
  assert.match(
    (await call(unavailable.bridge, 'run_judge', { sha, claim: 'claim' })).result.content[0].text,
    /当前没有可用的判官服务/,
  );
});
