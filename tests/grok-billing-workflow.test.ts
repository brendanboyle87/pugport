import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { grokAdapter } from '../src/server/adapters/grok.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { executeGrokAcp } from '../src/server/adapters/grok-acp.ts';
import { grokBuildBillingMessage } from '../src/server/grok-billing-failure.ts';
import { TaskJudge } from '../src/server/task-judgment.ts';
import type { ExecuteContext, RuntimeSnapshot, Workflow } from '../src/shared/types.ts';

type Packet = Record<string, any>;
async function nativeFailure(ctx: ExecuteContext, error: Packet) {
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  }) as unknown as ChildProcessWithoutNullStreams;
  const send = (packet: Packet) =>
    (child.stdout as PassThrough).write(JSON.stringify({ jsonrpc: '2.0', ...packet }) + '\n');
  let buffer = '',
    sessionId = '';
  child.stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let at: number;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const packet: Packet = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      queueMicrotask(() => {
        if (!packet.method) return;
        if (packet.method === 'initialize')
          send({
            id: packet.id,
            result: {
              protocolVersion: 1,
              agentCapabilities: { loadSession: true },
              authMethods: [{ id: 'cached_token' }],
              _meta: { defaultAuthMethodId: 'cached_token' },
            },
          });
        else if (packet.method === '_x.ai/interject')
          send({ id: packet.id, error: { code: -32602, message: 'Invalid params' } });
        else if (packet.method === 'session/new') {
          sessionId = packet.params._meta.sessionId;
          send({ id: packet.id, result: { sessionId } });
          send({ method: '_x.ai/mcp_initialized', params: { sessionId } });
        } else if (packet.method === '_x.ai/session/info')
          send({ id: packet.id, result: { result: { sessionId, agentName: 'comborunner-grok' } } });
        else if (packet.method === 'session/prompt') send({ id: packet.id, error });
        else send({ id: packet.id, result: {} });
      });
    }
  });
  return executeGrokAcp(ctx, {
    spawn: async () => child,
    terminate: async () => {
      child.emit('close', 1, null);
    },
    timeoutMs: 1000,
  });
}

for (const [blocked, alone] of [
  [false, false],
  [true, false],
  [false, true],
])
  test(`Grok structured billing failure ${blocked ? 'keeps an unknown competing cause blocked' : alone ? 'with no other executor ends with the real 402 reason' : 'automatically hands off and delivers the final reply'}`, async (t) => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-billing-workflow-')));
    const home = join(directory, 'empty-home');
    mkdirSync(home);
    const overrides: Record<string, string | undefined> = {
      HOME: home,
      USERPROFILE: home,
      PATH: '',
      APPDATA: join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(home, 'AppData', 'Local'),
      XDG_CONFIG_HOME: join(home, 'config'),
      JEV_API_KEY: undefined,
      TYPESAFE_API_KEY: undefined,
      GROK_HOME: join(home, 'grok'),
      CODEX_HOME: join(home, 'codex'),
      CLAUDE_CONFIG_DIR: join(home, 'claude'),
      COMBORUNNER_MEMORY_DIR: join(directory, 'memory'),
    };
    const previous = Object.fromEntries(Object.keys(overrides).map((name) => [name, process.env[name]]));
    for (const [name, value] of Object.entries(overrides))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    const controller = new Controller(directory, join(directory, 'data'), {
      readAccountIdentity: (target) => (target.id.includes('grok') ? 'synthetic-grok-b' : 'synthetic-codex'),
      taskJudge: new TaskJudge({
        credential: () => undefined,
        fetch: async () => {
          throw Error('No network in fixtures');
        },
      }),
    });
    clearInterval(controller.timer);
    Object.assign(controller.settings, {
      taskJudgment: 'local',
      unknownQuotaPolicy: 'allow',
      toolApprovalMode: 'auto',
    });
    controller.targets = [
      {
        id: 'grok-b',
        provider: 'grok',
        label: 'Grok B',
        command: 'unused',
        environment: 'native',
        enabled: true,
        accountFingerprint: 'synthetic-grok-b',
      },
      {
        id: 'grok-alias',
        provider: 'grok',
        label: 'Same account',
        command: 'unused',
        environment: 'native',
        enabled: true,
        accountFingerprint: 'synthetic-grok-b',
      },
      {
        id: 'codex',
        provider: 'codex',
        label: 'Codex',
        command: 'unused',
        environment: 'native',
        enabled: true,
        accountFingerprint: 'synthetic-codex',
      },
    ];
    if (alone) controller.targets.pop();
    controller.snapshots = controller.targets.map((target): RuntimeSnapshot => ({
      id: target.id,
      provider: target.provider,
      label: target.label,
      environment: 'native',
      accountFingerprint: target.accountFingerprint,
      installed: true,
      status: 'ready',
      models: [
        {
          id: target.provider === 'grok' ? 'grok-4.7-build-fast' : 'mock-codex',
          label: 'Fixture model',
          efforts: ['low', 'medium'],
        },
      ],
      quota: {
        status: 'known',
        source: 'synthetic',
        observedAt: new Date().toISOString(),
        windows: [
          { id: 'week', label: 'Week', usedPercent: 0, resetsAt: new Date(Date.now() + 86400000).toISOString() },
        ],
      },
      capabilities: { execute: true, resume: true, cancel: true, approvals: false },
      refreshedAt: new Date().toISOString(),
    }));
    // Post-run metadata remains 100% available. It cannot clear the observed Build billing fault.
    t.mock.method(controller, 'refresh', async () => {});
    const calls: ExecuteContext[] = [];
    t.mock.method(grokAdapter, 'execute', async (ctx: ExecuteContext) => {
      calls.push(ctx);
      return nativeFailure(ctx, {
        code: -32603,
        message: 'Internal error',
        data: {
          http_status: 402,
          message: 'API error (status 402 Payment Required): Grok Build usage balance exhausted',
          promptUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, numTurns: 0, usageIsIncomplete: true },
          ...(blocked ? { reason: 'content-policy' } : {}),
        },
      });
    });
    t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
      calls.push(ctx);
      assert.equal(ctx.input.permissionMode, 'workspace-write');
      assert.equal(ctx.input.projectPath, directory);
      return {
        output:
          'Synthetic final report complete.\nCOMBORUNNER_TASK_RESULT: {"status":"completed","summary":"Synthetic final report complete."}',
      };
    });
    const workspace = new Workspace(controller, { autoTick: false, retryMs: 10, memoryDebounceMs: 100000 });
    t.after(async () => {
      await workspace.close();
      await controller.close();
      for (const [name, value] of Object.entries(previous))
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      assert.ok(
        directory.startsWith(realpathSync.native(tmpdir()) + sep) &&
          basename(directory).startsWith('pugport-billing-workflow-'),
      );
      rmSync(directory, { recursive: true, force: true });
    });
    const project = await workspace.createProject(directory);
    const conversation = workspace.createConversation(project.id);
    const sent = await workspace.send(conversation.id, {
      content: 'Produce the synthetic final report',
      mode: 'build',
      runtimeId: 'grok-b',
      model: 'grok-4.7-build-fast',
      effort: 'low',
      permissionMode: 'workspace-write',
      executionPolicy: 'cli-only',
      allowExecutorFallback: true,
      autoEscalate: true,
    });
    const deadline = Date.now() + 8000;
    let flow: Workflow | undefined;
    while (Date.now() < deadline) {
      await workspace.tickQueue();
      flow = workspace.store.get<Workflow>('workflow', sent.workflow.id);
      if (flow && ['completed', 'blocked', 'failed', 'cancelled'].includes(flow.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(flow);
    assert.equal(flow.planning?.strategy, 'native');
    const source = controller.store.run(flow.runIds[0]!)!;
    if (blocked) {
      assert.equal(flow.status, 'blocked');
      assert.equal(calls.length, 1);
      assert.equal(source.handoffCheckpoint?.safe, false);
      assert.equal(source.errorCode, 'runtime-request-failed');
    } else if (alone) {
      // Only the same Grok identity exists: the task stops with the balance message, not "no executor".
      assert.equal(flow.status, 'blocked');
      assert.equal(calls.length, 1);
      assert.equal(flow.runIds.length, 1);
      assert.equal(source.error, grokBuildBillingMessage);
      assert.ok(flow.error?.includes(grokBuildBillingMessage), String(flow.error));
      assert.ok(!flow.error?.includes('没有可用的执行器'), String(flow.error));
    } else {
      assert.equal(flow.status, 'completed');
      assert.deepEqual(
        calls.map((ctx) => ctx.target.id),
        ['grok-b', 'codex'],
      );
      assert.equal(source.errorCode, 'quota-or-rate-limit');
      assert.equal(source.error, grokBuildBillingMessage);
      assert.equal(source.handoffCheckpoint?.safe, true);
      assert.equal(controller.accountHealth.report()[0]?.billingSource, 'grok-build');
      assert.equal(controller.accountHealth.apply(controller.snapshots[1]!).availability?.reason, 'quota');
      const final = controller.store.run(flow.runIds.at(-1)!)!;
      assert.equal(final.relay?.fromRunId, source.id);
      // Leaving the executor the user pinned is said plainly, with the replacement and the reason.
      const notice = '已离开你指定的 Grok B，改用 Codex 继续（原因：Grok B 余额已用完）。';
      assert.equal(final.relay?.notice, notice);
      assert.ok(
        controller.runWithAudit(final.id)!.events.some((event) => event.type === 'status' && event.text === notice),
      );
      assert.ok(final.output.includes('Synthetic final report complete.'));
      assert.ok(calls[1]!.input.excludeRuntimeIds?.includes('grok-alias'));
      assert.ok(
        workspace
          .conversation(conversation.id)
          .messages.some(
            (item) => item.role === 'assistant' && item.content.includes('Synthetic final report complete.'),
          ),
      );
    }
  });
