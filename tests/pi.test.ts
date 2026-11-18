import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { join, resolve } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ExecuteContext, RunEvent } from '../src/shared/types.js';
import {
  createPiAdapter,
  makePiTarget,
  modelAccessRefused,
  piBridgeToolNames,
  piModelAuditDetails,
  piModels,
} from '../src/server/adapters/pi.js';
import { apiEnvironment } from '../src/server/api-providers.ts';
import { contextFromEvent } from '../src/shared/context-usage.ts';
import { testDirectory } from '../src/server/platform/under-test.ts';
import { apiPreset } from '../src/shared/api-providers.ts';
import { agentDirectory, mentionsAgent, resolveAgent } from '../src/server/agent-names.ts';

const target = makePiTarget(process.cwd(), testDirectory());

test('Pi folds only explicitly unsupported reasoning effort formats', () => {
  for (const thinkingFormat of ['zai', 'deepseek', 'qwen', 'openai', undefined]) {
    const entry = {
      provider: 'test',
      id: 'reasoner',
      reasoning: true,
      compat: { thinkingFormat, supportsReasoningEffort: false },
    };
    assert.deepEqual(
      piModels({ models: [entry] })[0].efforts,
      thinkingFormat === undefined
        ? ['off', 'minimal', 'low', 'medium', 'high']
        : thinkingFormat === 'openai'
          ? ['off']
          : ['off', 'high'],
    );
    assert.deepEqual(piModels({ models: [{ ...entry, compat: { thinkingFormat } }] })[0].efforts, [
      'off',
      'minimal',
      'low',
      'medium',
      'high',
    ]);
  }
});

test('Pi discovery reads the initial model once through RPC without inference or catalog imports', async () => {
  const { child, requests } = fixture((packet, send) => {
    if (packet.type === 'get_state') {
      send({
        id: packet.id,
        type: 'response',
        success: true,
        data: { model: { provider: 'qwen-token-plan-cn', id: 'qwen99-fixture' } },
      });
      return true;
    }
    if (packet.type !== 'get_available_models') return;
    send({
      id: packet.id,
      type: 'response',
      success: true,
      data: {
        models: [
          { provider: 'qwen-token-plan-cn', id: 'deepseek-v4-pro' },
          { provider: 'qwen-token-plan-cn', id: 'qwen99-fixture' },
        ],
      },
    });
    return true;
  });
  const result = await createPiAdapter({
    spawn: async () => child,
    terminate: async () => {},
    version: async () => '1.2.0',
    key: () => 'SYNTHETIC_KEY',
    environment: () => ({ PI_OFFLINE: '1' }),
  }).discover({ ...target, gateway: 'api', apiProvider: 'qwen-cn' });
  assert.equal(result.status, 'ready');
  assert.equal(result.models.find((entry) => entry.catalogDefault)?.id, 'qwen-token-plan-cn/qwen99-fixture');
  assert.deepEqual(
    requests.map((packet) => packet.type),
    ['get_state', 'get_available_models'],
  );
});

test('Pi discovery stays ready without a catalog default when get_state fails', async () => {
  const { child, requests } = fixture((packet, send) => {
    if (packet.type !== 'get_state') return;
    send({ id: packet.id, type: 'response', success: false, error: 'synthetic state failure' });
    return true;
  });
  const result = await adapterFor(child).discover(target);
  assert.equal(result.status, 'ready');
  assert.deepEqual(
    result.models.map((entry) => entry.id),
    ['test/reasoner'],
  );
  assert.ok(result.models.every((entry) => entry.catalogDefault === undefined));
  assert.deepEqual(
    requests.map((packet) => packet.type),
    ['get_state', 'get_available_models'],
  );
});

test('custom API discovery preserves connection metadata without inventing prices or requiring a model-list endpoint', async () => {
  const connection = {
    protocol: 'azure-openai-responses' as const,
    baseUrl: 'https://synthetic.services.ai.azure.com/openai/v1',
    model: 'synthetic-alias',
  };
  const snapshot = await createPiAdapter({
    key: () => undefined,
    spawn: async () => {
      throw new Error('No CLI required without a key');
    },
  }).discover({
    ...target,
    gateway: 'api',
    apiProvider: 'custom-api',
    apiConnection: connection,
  });
  assert.equal(snapshot.status, 'auth-required');
  assert.deepEqual(snapshot.apiConnection, connection);
  assert.equal(snapshot.models[0]?.id, 'pugport-custom-api/synthetic-alias');
  assert.equal(snapshot.models[0]?.price, undefined);
  assert.deepEqual(snapshot.models[0]?.efforts, ['off']);
});

test('custom API usage with unknown prices never records the runtime zero placeholder as free', async () => {
  const configured = {
    provider: 'pugport-custom-api',
    id: 'synthetic-alias',
    reasoning: false,
    cost: { input: 0, output: 0 },
  };
  const { child } = fixture((packet, send) => {
    if (packet.type === 'get_available_models') {
      send({ id: packet.id, type: 'response', success: true, data: { models: [configured] } });
      return true;
    }
    if (packet.type !== 'prompt') return;
    send({ id: packet.id, type: 'response', success: true });
    send({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'stop',
        usage: { input: 10, output: 2, cost: { total: 0 } },
      },
    });
    send({ type: 'agent_settled' });
    return true;
  });
  const events: RunEvent[] = [];
  await createPiAdapter({
    spawn: async () => child,
    terminate: async () => {},
    key: () => 'SYNTHETIC_CUSTOM_KEY',
    environment: () => ({}),
  }).execute(
    context({
      target: {
        ...target,
        gateway: 'api',
        apiProvider: 'custom-api',
        apiConnection: {
          protocol: 'azure-openai-responses',
          baseUrl: 'https://synthetic.services.ai.azure.com/openai/v1',
          model: configured.id,
        },
      },
      route: { ...context().route, model: `${configured.provider}/${configured.id}`, effort: undefined },
      emit: (event) => events.push(event),
    }),
  );
  const usage = events.find((event) => event.type === 'usage');
  assert.equal(usage?.data?.input, 10);
  assert.equal(usage?.data?.costUsd, undefined);
  assert.ok(!JSON.stringify(events).includes('SYNTHETIC_CUSTOM_KEY'));
});

test('Pi discovery catalog defaults are injectable and an absent initial model is harmless', async () => {
  for (const injected of [false, true]) {
    const { child } = fixture();
    const result = await createPiAdapter({
      spawn: async () => child,
      terminate: async () => {},
      version: async () => '1.2.0',
      ...(injected ? { catalogDefaults: () => ({ test: 'reasoner' }) } : {}),
    }).discover(target);
    assert.equal(result.status, 'ready');
    assert.equal(result.models[0].catalogDefault, injected ? true : undefined);
  }
});
const model = {
  provider: 'test',
  id: 'reasoner',
  name: 'Reasoner',
  reasoning: true,
  thinkingLevelMap: { off: null, minimal: null, xhigh: 'xhigh' },
};
const sessionFile = join(testDirectory(), 'pi', 'sessions', 'session.jsonl');
type Packet = Record<string, unknown>;
function fixture(onPacket?: (packet: Packet, send: (value: unknown) => void) => boolean | void) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 999999,
    exitCode: null as number | null,
    signalCode: null,
  });
  const requests: Packet[] = [];
  const send = (value: unknown) => {
    child.stdout.write(`${JSON.stringify(value)}\n`);
  };
  let buffer = '';
  child.stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const packet = JSON.parse(line) as Packet;
      requests.push(packet);
      if (onPacket?.(packet, send)) continue;
      if (packet.type === 'extension_ui_response') continue;
      const data =
        packet.type === 'get_available_models'
          ? { models: [model] }
          : packet.type === 'get_available_thinking_levels'
            ? { levels: ['low', 'medium', 'high', 'xhigh'] }
            : packet.type === 'get_state'
              ? { sessionFile }
              : packet.type === 'get_commands'
                ? {
                    commands: [
                      { name: 'studio-permissions-v1', source: 'extension' },
                      { name: 'studio-codemode-v1', source: 'extension' },
                    ],
                  }
                : {};
      send({ id: packet.id, type: 'response', command: packet.type, success: true, data });
    }
  });
  child.stdin.on('finish', () => {
    child.exitCode = 0;
    child.emit('close', 0);
  });
  return { child: child as unknown as ChildProcessWithoutNullStreams, requests, send };
}
function context(overrides: Partial<ExecuteContext> = {}): ExecuteContext {
  return {
    target,
    input: { prompt: 'Read README', projectPath: process.cwd(), kind: 'general', permissionMode: 'read-only' },
    route: { runtimeId: target.id, model: 'test/reasoner', effort: 'high', kind: 'general', reasons: [], warnings: [] },
    signal: new AbortController().signal,
    emit: () => {},
    approve: async () => false,
    ...overrides,
  };
}
function adapterFor(child: ChildProcessWithoutNullStreams) {
  return createPiAdapter({ spawn: async () => child, terminate: async () => {}, version: async () => '0.87.1' });
}

const hostMarkers = (budget = false) => ({
  commands: [
    { name: 'studio-permissions-v1', source: 'extension' },
    { name: 'studio-codemode-v1', source: 'extension' },
    { name: 'studio-host-bridge-v1', source: 'extension' },
    ...(budget ? [{ name: 'studio-api-budget-v1', source: 'extension' }] : []),
  ],
});

test('Pi parses Retry-After before redaction and emits only its numeric duration', async () => {
  const { child } = fixture((packet, send) => {
    if (packet.type !== 'prompt') return;
    send({ id: packet.id, type: 'response', success: true });
    send({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'HTTP 429 private-fixture-token\nRetry-After: 91',
      },
    });
    send({ type: 'agent_settled' });
    return true;
  });
  const events: RunEvent[] = [];
  await assert.rejects(
    adapterFor(child).execute(context({ emit: (event) => events.push(event) })),
    /^Error: quota-or-rate-limit$/,
  );
  assert.ok(events.some((event) => event.data?.retryAfterSeconds === 91));
  assert.doesNotMatch(JSON.stringify(events), /private-fixture-token|Retry-After/);
});

test('a failed Pi request marks its usage so no context occupancy is derived from it', async () => {
  const { child } = fixture((packet, send) => {
    if (packet.type !== 'prompt') return;
    send({ id: packet.id, type: 'response', success: true });
    send({
      type: 'message_end',
      message: {
        id: 'synthetic-failed',
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'synthetic upstream failure',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      },
    });
    send({ type: 'agent_settled' });
    return true;
  });
  const events: RunEvent[] = [];
  await assert.rejects(adapterFor(child).execute(context({ emit: (event) => events.push(event) })));
  const usage = events.find((event) => event.type === 'usage');
  assert.equal(usage?.data?.stopReason, 'error');
  assert.equal(usage?.data?.requestOrdinal, undefined, 'the unused request ordinal is gone');
  assert.equal(contextFromEvent('pi', 'synthetic', usage!), undefined, 'not reported, never context 0');
});

test('Pi host catalogue uses only the authenticated local endpoint and rejects an invalid grant catalogue', async () => {
  const bridge = { url: 'http://127.0.0.1:4317/mcp', token: 'fixture-opaque-token' };
  let calls = 0;
  const fetchImpl = (async (url, options) => {
    calls++;
    assert.equal(String(url), bridge.url);
    assert.equal(options?.redirect, 'error');
    assert.equal(new Headers(options?.headers).get('Authorization'), `Bearer ${bridge.token}`);
    assert.equal(JSON.parse(String(options?.body)).method, 'tools/list');
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'pi-host-tools',
        result: {
          tools: [{ name: 'delegate' }, { name: 'get_result' }],
        },
      }),
    );
  }) as typeof fetch;
  assert.deepEqual(await piBridgeToolNames(bridge, new AbortController().signal, fetchImpl), [
    'delegate',
    'get_result',
  ]);
  for (const url of ['https://example.test/mcp', 'http://localhost:4317/mcp', 'http://127.0.0.1@evil.test/mcp'])
    await assert.rejects(piBridgeToolNames({ ...bridge, url }, new AbortController().signal, fetchImpl), /permission/);
  assert.equal(calls, 1, 'A temporary bearer must never leave the literal loopback host.');
  await assert.rejects(
    piBridgeToolNames(
      bridge,
      new AbortController().signal,
      (async () =>
        new Response(
          JSON.stringify({
            result: { tools: [{ name: 'read' }, { name: 'read' }] },
          }),
        )) as typeof fetch,
    ),
    /protocol/,
  );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(piBridgeToolNames(bridge, aborted.signal, fetchImpl));
  assert.equal(calls, 1);
});

test('API Pi loads the scoped host bridge without sharing provider credentials or changing model and effort', async () => {
  const api = {
    ...target,
    id: 'api-pi-fixture',
    gateway: 'api' as const,
    apiProvider: 'openai',
    agentDir: join(testDirectory(), 'api-pi-fixture'),
  };
  const bridge = { url: 'http://127.0.0.1:4317/mcp', token: 'OPAQUE_RUN_TOKEN' };
  let args: string[] = [],
    env: NodeJS.ProcessEnv = {};
  const events: RunEvent[] = [];
  const { child, requests } = fixture((packet, send) => {
    if (packet.type === 'get_commands') {
      send({ id: packet.id, type: 'response', success: true, data: hostMarkers() });
      return true;
    }
    if (packet.type === 'get_available_models') {
      send({
        id: packet.id,
        type: 'response',
        success: true,
        data: { models: [{ ...model, id: 'gpt-6.1-sol', provider: 'openai' }] },
      });
      return true;
    }
    if (packet.type === 'prompt') {
      send({ id: packet.id, type: 'response', success: true });
      send({
        type: 'tool_execution_start',
        toolName: 'pugport_delegate',
        toolCallId: 'native-delegate',
        args: { agent: 'Codex B', task: 'Read only: inspect a synthetic fixture.' },
      });
      send({
        type: 'tool_execution_end',
        toolName: 'pugport_delegate',
        toolCallId: 'native-delegate',
        isError: false,
        result: { content: [{ type: 'text', text: 'child completed' }] },
      });
      send({ type: 'agent_settled' });
      return true;
    }
  });
  const adapter = createPiAdapter({
    spawn: async (_target, values, options) => {
      args = values;
      env = options?.env ?? {};
      return child;
    },
    terminate: async () => {},
    permissionExtension: async () => '/app/pi-extension.mjs',
    environment: (profile) =>
      apiEnvironment(profile, apiPreset('openai')!, 'SYNTHETIC_API_KEY', {
        PATH: 'fixture-path',
        ANTHROPIC_API_KEY: 'OTHER_PLATFORM_KEY',
        COMBORUNNER_AGENT_BRIDGE_TOKEN: 'AMBIENT_TOKEN',
      }),
    bridgeTools: async (value, signal) => {
      assert.equal(value, bridge);
      assert.equal(signal.aborted, false);
      return ['delegate', 'get_result', 'find_files'];
    },
  });
  await adapter.execute(
    context({
      target: api,
      route: { ...context().route, runtimeId: api.id, model: 'openai/gpt-6.1-sol' },
      agentBridge: bridge,
      emit: (event) => events.push(event),
    }),
  );
  assert.equal(env.OPENAI_API_KEY, 'SYNTHETIC_API_KEY');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.USERPROFILE, api.agentDir);
  assert.equal(env.COMBORUNNER_AGENT_BRIDGE_TOKEN, bridge.token);
  assert.equal(env.COMBORUNNER_PI_PERMISSION_MODE, 'read-only');
  assert.equal(env.COMBORUNNER_PI_CODEMODE, 'on');
  assert.equal(args[args.indexOf('--extension') + 1], '/app/pi-extension.mjs');
  assert.equal(
    args[args.indexOf('--tools') + 1],
    'read,grep,find,ls,codemode,pugport_delegate,pugport_get_result,pugport_find_files',
  );
  assert.deepEqual(requests.find((packet) => packet.type === 'set_model')?.modelId, 'gpt-6.1-sol');
  assert.equal(requests.find((packet) => packet.type === 'set_thinking_level')?.level, 'high');
  assert.ok(
    events.some(
      (event) => event.data?.kind === 'host-tool-bridge' && (event.data.detail as { ready?: boolean })?.ready === true,
    ),
  );
  assert.equal(events.filter((event) => event.type === 'tool').length, 2);
  assert.doesNotMatch(
    JSON.stringify({ args, events }),
    /OPAQUE_RUN_TOKEN|SYNTHETIC_API_KEY|OTHER_PLATFORM_KEY|AMBIENT_TOKEN/,
  );
});

test('Pi does not send a prompt when the host bridge extension handshake is incomplete', async () => {
  const { child, requests } = fixture();
  const adapter = createPiAdapter({
    spawn: async () => child,
    terminate: async () => {},
    permissionExtension: async () => '/app/pi-extension.mjs',
    bridgeTools: async () => ['delegate'],
  });
  await assert.rejects(
    adapter.execute(context({ agentBridge: { url: 'http://127.0.0.1:4317/mcp', token: 'test' } })),
    /permission/,
  );
  assert.deepEqual(
    requests.map((packet) => packet.type),
    ['get_commands'],
  );
});

test('Pi refuses tool-enabled runs until its guarded Code Mode extension is ready', async () => {
  for (const source of [undefined, 'prompt']) {
    const { child, requests } = fixture((packet, send) => {
      if (packet.type !== 'get_commands') return;
      send({
        id: packet.id,
        type: 'response',
        success: true,
        data: {
          commands: [
            { name: 'studio-permissions-v1', source: 'extension' },
            ...(source ? [{ name: 'studio-codemode-v1', source }] : []),
          ],
        },
      });
      return true;
    });
    await assert.rejects(adapterFor(child).execute(context()), /permission/);
    assert.deepEqual(
      requests.map((packet) => packet.type),
      ['get_commands'],
    );
    assert.equal(child.stdin.writableEnded, true);
  }
});

test('Pi visual assistance cannot activate a supplied host bridge or inherit ambient bridge state', async () => {
  let env: NodeJS.ProcessEnv = {},
    args: string[] = [];
  const { child } = fixture((packet, send) => {
    if (packet.type === 'prompt') {
      send({ id: packet.id, type: 'response', success: true });
      send({ type: 'agent_settled' });
      return true;
    }
  });
  const adapter = createPiAdapter({
    spawn: async (_target, values, options) => {
      args = values;
      env = options?.env ?? {};
      return child;
    },
    terminate: async () => {},
    bridgeTools: async () => assert.fail('No host catalogue for visual helpers.'),
    environment: () => ({
      COMBORUNNER_AGENT_BRIDGE_URL: 'http://127.0.0.1:9999/old',
      COMBORUNNER_AGENT_BRIDGE_TOKEN: 'ambient',
      COMBORUNNER_AGENT_BRIDGE_TOOLS: '["delegate"]',
    }),
  });
  await adapter.execute(
    context({
      input: { ...context().input, visualAssistant: true },
      agentBridge: { url: 'http://127.0.0.1:4317/mcp', token: 'supplied' },
    }),
  );
  assert.equal(env.COMBORUNNER_AGENT_BRIDGE_TOKEN, '');
  assert.equal(env.COMBORUNNER_AGENT_BRIDGE_URL, '');
  assert.equal(env.COMBORUNNER_AGENT_BRIDGE_TOOLS, '');
  assert.equal(args[args.indexOf('--tools') + 1], 'read,grep,find,ls,codemode');
  assert.ok(args.includes('--extension'));
});

test('Pi per-run budget accumulates reported cost and aborts with the budget reason', async () => {
  const { child, requests } = fixture((packet, send) => {
    if (packet.type === 'get_commands') {
      send({ id: packet.id, type: 'response', success: true, data: hostMarkers(true) });
      return true;
    }
    if (packet.type === 'prompt') {
      send({ id: packet.id, type: 'response', success: true });
      for (const cost of [0.6, 0.45])
        send({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [],
            usage: { cost: { total: cost } },
          },
        });
      return true;
    }
  });
  const events: RunEvent[] = [];
  await assert.rejects(
    adapterFor(child).execute(context({ apiBudget: { maxCostUsd: 1 }, emit: (event) => events.push(event) })),
    /^Error: api-budget-exhausted$/,
  );
  assert.equal(requests.filter((packet) => packet.type === 'prompt').length, 1);
  assert.ok(requests.some((packet) => packet.type === 'clear_queue'));
  assert.ok(requests.some((packet) => packet.type === 'abort'));
  assert.ok(events.some((event) => event.type === 'error' && event.text === 'api-budget-exhausted'));
  assert.deepEqual(
    events.filter((event) => event.type === 'usage').map((event) => event.data?.costUsd),
    [0.6, 0.45],
  );
});

test('Pi budget stops on missing costs, a running cutoff or an extension stop notification', async () => {
  for (const reason of ['api-budget-usage-unknown', 'api-budget-expired', 'api-budget-exhausted']) {
    const { child, requests } = fixture((packet, send) => {
      if (packet.type === 'get_commands') {
        send({ id: packet.id, type: 'response', success: true, data: hostMarkers(true) });
        return true;
      }
      if (packet.type === 'prompt') {
        send({ id: packet.id, type: 'response', success: true });
        if (reason === 'api-budget-usage-unknown')
          send({ type: 'message_end', message: { role: 'assistant', content: [] } });
        if (reason === 'api-budget-exhausted')
          send({ type: 'extension_ui_request', method: 'notify', message: reason });
        return true;
      }
    });
    await assert.rejects(
      adapterFor(child).execute(
        context({
          apiBudget: {
            maxCostUsd: 1,
            ...(reason === 'api-budget-expired' ? { expiresAt: new Date(Date.now() + 100).toISOString() } : {}),
          },
        }),
      ),
      new RegExp(reason),
    );
    assert.ok(
      requests.some((packet) => packet.type === 'abort'),
      reason,
    );
  }
  let spawned = false;
  await assert.rejects(
    createPiAdapter({
      spawn: async () => {
        spawned = true;
        throw new Error('unexpected');
      },
    }).execute(context({ apiBudget: { maxCostUsd: 1, expiresAt: new Date(0).toISOString() } })),
    /api-budget-expired/,
  );
  assert.equal(spawned, false);
});

test('Pi target uses bundled native RPC, isolates sessions and reflects advertised thinking maps', () => {
  assert.equal(
    target.enabled,
    false,
    'new installations require an explicit Pi opt-in before using ambient provider credentials',
  );
  assert.equal(target.command, process.execPath);
  assert.ok(target.args?.[0]?.endsWith(join('dist', 'bundle', 'cli.js')));
  assert.ok(target.args?.includes('--session-dir'));
  assert.deepEqual(piModels({ models: [model] })[0]?.efforts, ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(piModels({ models: [{ ...model, reasoning: false }] })[0]?.efforts, ['off']);
  assert.deepEqual(piModels({ models: [{ id: 'without-provider' }] }), []);
});

test('Pi model audit separates API platform configuration from observed model state and excludes credentials', () => {
  const ctx = context({
    target: { ...target, gateway: 'api', apiProvider: 'openai', label: 'OpenAI API' },
    route: { ...context().route, model: 'openai/requested-model' },
  });
  const details = piModelAuditDetails(ctx, 'get_state', 'initial', {
    model: {
      provider: 'openai',
      id: 'confirmed-model',
      api: 'openai-responses',
      reasoning: true,
      headers: { Authorization: 'OPAQUE_AUTH' },
      baseUrl: 'https://example.test/OPAQUE_URL',
      _meta: { reasoning: 'PRIVATE_META' },
    },
    thinkingLevel: 'medium',
    messages: ['PRIVATE_MESSAGES'],
    apiKey: 'OPAQUE_KEY',
  }) as Record<string, unknown>;
  assert.equal(details.provider, 'pi');
  assert.equal(details.executor, 'OpenAI API');
  assert.equal(details.executionPath, 'api');
  assert.equal(details.configuredApiPlatform, 'openai');
  assert.deepEqual(details.requestedModel, { provider: 'openai', modelId: 'requested-model' });
  assert.deepEqual(details.confirmedModel, {
    provider: 'openai',
    id: 'confirmed-model',
    api: 'openai-responses',
    reasoningSupported: true,
  });
  assert.equal(details.requestedEffort, 'high');
  assert.equal(details.confirmedThinkingLevel, 'medium', 'observed effort is independent of requested effort');
  assert.doesNotMatch(JSON.stringify(details), /OPAQUE_|PRIVATE_/);
  const unknown = piModelAuditDetails(context(), 'get_state', 'initial', {}) as Record<string, unknown>;
  assert.equal(unknown.confirmedModel, undefined, 'missing state cannot confirm the requested model');
  assert.equal(unknown.confirmedThinkingLevel, undefined);
});

test('Pi records typed partial tool results without completing the native call, and confirms state from RPC fields', async () => {
  const events: RunEvent[] = [];
  const { child } = fixture((packet, send) => {
    if (packet.type === 'set_model' || packet.type === 'get_state') {
      send({
        id: packet.id,
        type: 'response',
        success: true,
        data:
          packet.type === 'set_model'
            ? model
            : {
                sessionFile,
                model: { ...model, api: 'openai-responses', apiKey: 'PRIVATE_KEY' },
                thinkingLevel: 'high',
                messages: ['PRIVATE_MESSAGES'],
              },
      });
      return true;
    }
    if (packet.type !== 'prompt') return;
    send({ id: packet.id, type: 'response', success: true });
    send({ type: 'tool_execution_start', toolCallId: 'native-call', toolName: 'read', args: { path: 'README.md' } });
    send({
      type: 'tool_execution_update',
      toolCallId: 'native-call',
      parentToolCallId: 'native-parent',
      toolName: 'read',
      args: { path: 'README.md' },
      partialResult: {
        content: [{ type: 'text', text: 'first lines token=PRIVATE_TOKEN' }],
        details: { rows: 2, thinking: 'PRIVATE_THOUGHT' },
      },
    });
    send({
      type: 'tool_execution_end',
      toolCallId: 'native-call',
      toolName: 'read',
      isError: false,
      result: { content: [{ type: 'text', text: 'complete lines' }] },
    });
    send({ type: 'auto_retry_end', success: true, attempt: 2, finalError: 'PRIVATE_RETRY_BODY' });
    send({ type: 'new_native_event', status: 'observed', messages: ['PRIVATE_UNKNOWN_BODY'] });
    send({ type: 'agent_settled' });
    return true;
  });
  await adapterFor(child).execute(context({ emit: (event) => events.push(event) }));
  const tools = events.filter((event) => event.type === 'tool');
  assert.deepEqual(
    tools.map((event) => event.data?.status),
    ['inProgress', 'inProgress', 'completed'],
  );
  assert.ok(tools.every((event) => event.data?.toolCallId === 'native-call'));
  assert.equal(tools[1].data?.partial, true);
  assert.equal(tools[1].data?.parentToolCallId, 'native-parent');
  assert.deepEqual(tools[1].data?.output, {
    content: [{ type: 'text', text: 'first lines token=[redacted]' }],
    details: { rows: 2 },
  });
  const modelEvents = events.filter((event) => ['model-request', 'model-confirmed'].includes(String(event.data?.kind)));
  assert.equal(modelEvents.length, 4);
  const metadata = events.filter((event) =>
    ['protocol-observation', 'protocol-unmapped'].includes(String(event.data?.kind)),
  );
  assert.ok(
    metadata.some(
      (event) =>
        (event.data?.detail as Record<string, unknown>).type === 'auto_retry_end' &&
        (event.data?.detail as Record<string, unknown>).success === true,
    ),
  );
  assert.ok(
    metadata.some(
      (event) =>
        event.data?.kind === 'protocol-unmapped' &&
        (event.data?.detail as Record<string, unknown>).type === 'new_native_event',
    ),
  );
  assert.equal((modelEvents[2].data?.detail as Record<string, unknown>).confirmedThinkingLevel, 'high');
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_/);
});

test('retired gateway targets cannot discover, execute, or enter the agent directory', async () => {
  let spawns = 0;
  const adapter = createPiAdapter({
    spawn: async () => {
      spawns++;
      throw new Error('Retired gateway must never spawn or inherit ambient credentials');
    },
  });
  const native = { ...target, enabled: true };
  for (const retired of [
    { ...native, id: 'pi-magpie' },
    { ...native, id: 'renamed-gateway', label: 'Retired gateway', gateway: 'magpie' as const },
  ]) {
    const discovered = await adapter.discover(retired);
    assert.equal(discovered.status, 'error');
    assert.equal(discovered.capabilities.execute, false);
    assert.deepEqual(discovered.models, []);
    await assert.rejects(adapter.execute(context({ target: retired })), /Magpie 网关已移除/);
    assert.deepEqual(agentDirectory([retired, native]), [
      { label: native.label, provider: 'pi', runtimeId: native.id },
    ]);
    assert.throws(() => resolveAgent(retired.id, [retired, native]), /没有找到/);
  }
  assert.equal(mentionsAgent('Use Magpie for this task', [native]), false);
  assert.equal(spawns, 0);
});

test('Pi discovery makes no inference, carries authentication environment, and never invents quota', async () => {
  const { child, requests } = fixture();
  let args: string[] = [],
    env: NodeJS.ProcessEnv = {};
  const adapter = createPiAdapter({
    spawn: async (_target, values, options) => {
      args = values;
      env = options?.env ?? {};
      return child;
    },
    terminate: async () => {},
    version: async () => '0.87.1',
  });
  const snapshot = await adapter.discover(target);
  assert.deepEqual(
    requests.map((packet) => packet.type),
    ['get_state', 'get_available_models'],
  );
  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.quota.status, 'unknown');
  assert.deepEqual(snapshot.quota.windows, []);
  assert.equal(snapshot.capabilities.approvals, true);
  assert.equal(snapshot.capabilities.steer, true);
  assert.equal(snapshot.version, '0.87.1');
  assert.ok(
    args.includes('--no-session') &&
      args.includes('--no-tools') &&
      args.includes('--no-extensions') &&
      args.includes('--no-approve'),
  );
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(env.PI_OFFLINE, '1');
  assert.equal(env.PI_CODING_AGENT_DIR, process.env.PI_CODING_AGENT_DIR);
  assert.ok(child.stdin.writableEnded);
});

test('Pi without configured models reports authentication required, not ready', async () => {
  const { child } = fixture((packet, send) => {
    send({ id: packet.id, type: 'response', command: packet.type, success: true, data: { models: [] } });
    return true;
  });
  const snapshot = await adapterFor(child).discover(target);
  assert.equal(snapshot.installed, true);
  assert.equal(snapshot.status, 'auth-required');
  assert.deepEqual(snapshot.models, []);
});

test('Pi preserves streamed Unicode and waits through agent_end until agent_settled', async () => {
  const events: RunEvent[] = [];
  let sendEvent: (value: unknown) => void = () => {};
  let signalPrompt!: () => void;
  const prompted = new Promise<void>((resolvePrompt) => {
    signalPrompt = resolvePrompt;
  });
  const { child } = fixture((packet, send) => {
    if (packet.type !== 'prompt') return;
    sendEvent = send;
    send({ id: packet.id, type: 'response', command: 'prompt', success: true });
    send({ type: 'message_start', message: { role: 'assistant' } });
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello\u2028world' } });
    send({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello\u2028world' }],
        stopReason: 'stop',
        usage: { input: 10, output: 2, cost: { total: 0.01 } },
      },
    });
    send({ type: 'agent_end', willRetry: false });
    signalPrompt();
    return true;
  });
  let complete = false;
  const pending = adapterFor(child)
    .execute(context({ emit: (event) => events.push(event) }))
    .then((result) => {
      complete = true;
      return result;
    });
  await prompted;
  await new Promise<void>((next) => setImmediate(next));
  assert.equal(complete, false);
  sendEvent({ type: 'agent_settled' });
  const result = await pending;
  assert.equal(result.output, 'Hello\u2028world');
  assert.equal(result.nativeSessionId, sessionFile);
  assert.equal(events.filter((event) => event.type === 'text').length, 1);
  assert.equal(events.find((event) => event.type === 'usage')?.data?.costUsd, 0.01);
});

for (const aborted of [false, true]) {
  test(`Pi agent_settled aborted=${aborted} determines completion without a final assistant message`, async () => {
    const { child } = fixture((packet, send) => {
      if (packet.type !== 'prompt') return;
      send({ id: packet.id, type: 'response', command: 'prompt', success: true });
      send({ type: 'agent_settled', aborted });
      return true;
    });
    const pending = adapterFor(child).execute(context());
    if (aborted) await assert.rejects(pending, /^Error: operation-cancelled$/);
    else assert.equal((await pending).output, '');
  });
}

test('Pi steering uses correlated native steer requests and remains available until agent_settled', async () => {
  const { child, requests, send } = fixture();
  let current: ((prompt: string) => Promise<void>) | undefined;
  let ready!: (handler: (prompt: string) => Promise<void>) => void;
  const registered = new Promise<(prompt: string) => Promise<void>>((resolve) => {
    ready = resolve;
  });
  const executing = adapterFor(child).execute(
    context({
      registerSteer: (handler) => {
        current = handler;
        if (handler) ready(handler);
      },
    }),
  );
  const steer = await registered;
  await Promise.all([steer('Focus on README 世界'), steer('Keep the existing permissions')]);
  const submitted = requests.filter((packet) => packet.type === 'steer');
  assert.deepEqual(
    submitted.map((packet) => packet.message),
    ['Focus on README 世界', 'Keep the existing permissions'],
  );
  assert.notEqual(submitted[0]!.id, submitted[1]!.id);
  assert.ok(submitted.every((packet) => Object.keys(packet).sort().join(',') === 'id,message,type'));
  assert.equal(requests.filter((packet) => packet.type === 'prompt').length, 1);
  send({ type: 'agent_end' });
  assert.equal(current, steer, 'a low-level run end can precede steering work');
  send({ type: 'agent_settled' });
  await executing;
  assert.equal(current, undefined);
  await assert.rejects(steer('Should not queue after completion'), /steering-unavailable/);
});

test('Pi steering rejection is reported without replaying the initial prompt', async () => {
  const { child, requests, send } = fixture((packet, sendPacket) => {
    if (packet.type !== 'steer') return;
    sendPacket({
      id: packet.id,
      type: 'response',
      command: 'steer',
      success: false,
      error: 'Steer failed token=secret-should-not-leak',
    });
    return true;
  });
  let ready!: (handler: (prompt: string) => Promise<void>) => void;
  const registered = new Promise<(prompt: string) => Promise<void>>((resolve) => {
    ready = resolve;
  });
  const executing = adapterFor(child).execute(
    context({
      registerSteer: (handler) => {
        if (handler) ready(handler);
      },
    }),
  );
  await assert.rejects((await registered)('Focus on tests'), (error: Error) => {
    assert.ok(!error.message.includes('secret-should-not-leak'));
    return true;
  });
  assert.equal(requests.filter((packet) => packet.type === 'prompt').length, 1);
  send({ type: 'agent_settled' });
  await executing;
});

test('Pi does not report steering accepted after the native execution settles before its acknowledgment', async () => {
  const { child, requests } = fixture((packet, send) => {
    if (packet.type !== 'steer') return;
    send({ type: 'agent_settled' });
    send({ id: packet.id, type: 'response', command: 'steer', success: true });
    return true;
  });
  let ready!: (handler: (prompt: string) => Promise<void>) => void;
  const registered = new Promise<(prompt: string) => Promise<void>>((resolve) => (ready = resolve));
  const executing = adapterFor(child).execute(
    context({
      registerSteer: (handler) => {
        if (handler) ready(handler);
      },
    }),
  );
  await assert.rejects((await registered)('Do not misreport queued input.'), /steering-unavailable/);
  await executing;
  assert.equal(requests.filter((packet) => packet.type === 'prompt').length, 1);
  assert.equal(requests.filter((packet) => packet.type === 'steer').length, 1);
});

test('Pi cancellation immediately unregisters steering and rejects retained handlers', async () => {
  const { child } = fixture();
  const abort = new AbortController();
  let current: ((prompt: string) => Promise<void>) | undefined;
  let ready!: (handler: (prompt: string) => Promise<void>) => void;
  const registered = new Promise<(prompt: string) => Promise<void>>((resolve) => {
    ready = resolve;
  });
  const executing = adapterFor(child).execute(
    context({
      signal: abort.signal,
      registerSteer: (handler) => {
        current = handler;
        if (handler) ready(handler);
      },
    }),
  );
  const rejected = assert.rejects(executing, /cancelled/);
  const steer = await registered;
  abort.abort();
  assert.equal(current, undefined);
  await assert.rejects(steer('Should not send'), /steering-unavailable/);
  await rejected;
});

test('Pi rejects writes with no bridge and unavailable effort before any prompt', async () => {
  let spawned = false;
  const adapter = createPiAdapter({
    permissionExtension: async () => {
      throw new Error('runtime-permission-or-sandbox-error');
    },
    spawn: async () => {
      spawned = true;
      throw new Error('unexpected');
    },
  });
  await assert.rejects(
    adapter.execute(
      context({
        input: { prompt: 'Write a file', projectPath: '.', kind: 'general', permissionMode: 'workspace-write' },
      }),
    ),
    /permission/,
  );
  assert.equal(spawned, false);
  const { child, requests } = fixture();
  await assert.rejects(
    adapterFor(child).execute(context({ route: { ...context().route, effort: 'max' } })),
    /protocol/,
  );
  assert.ok(!requests.some((packet) => packet.type === 'prompt'));
});

test('Pi restores only an existing canonical session in the application session directory', async () => {
  let args: string[] = [];
  const { child } = fixture((packet, send) => {
    if (packet.type === 'prompt') {
      send({ id: packet.id, type: 'response', success: true });
      send({ type: 'agent_settled' });
      return true;
    }
  });
  const adapter = createPiAdapter({
    spawn: async (_target, values) => {
      args = values;
      return child;
    },
    terminate: async () => {},
    canonicalPath: async (path) => resolve(String(path)),
  });
  await adapter.execute(context({ nativeSessionId: sessionFile }));
  assert.equal(args[args.indexOf('--session') + 1], sessionFile);
  assert.equal(args[args.indexOf('--tools') + 1], 'read,grep,find,ls,codemode');
  await assert.rejects(adapter.execute(context({ nativeSessionId: resolve('outside.jsonl') })), /permission/);
});

test('Pi cancellation clears queue, aborts, closes stdin and terminates the owned child', async () => {
  const controller = new AbortController();
  let terminated = 0;
  const { child, requests } = fixture((packet, send) => {
    if (packet.type === 'prompt') {
      send({ id: packet.id, type: 'response', success: true });
      controller.abort();
      return true;
    }
  });
  const adapter = createPiAdapter({
    spawn: async () => child,
    terminate: async (owned) => {
      assert.equal(owned, child);
      terminated++;
    },
  });
  await assert.rejects(adapter.execute(context({ signal: controller.signal })), /cancelled/);
  assert.deepEqual(
    requests.slice(-2).map((packet) => packet.type),
    ['clear_queue', 'abort'],
  );
  assert.equal(child.stdin.writableEnded, true);
  assert.equal(terminated, 1);
});

test('Pi reports post-acknowledgment provider failures without raw credentials', async () => {
  const { child } = fixture((packet, send) => {
    if (packet.type === 'prompt') {
      send({ id: packet.id, type: 'response', success: true });
      send({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: 'API key rejected: secret-value',
          content: [],
        },
      });
      send({ type: 'agent_end' });
      send({ type: 'agent_settled' });
      return true;
    }
  });
  await assert.rejects(adapterFor(child).execute(context()), /^Error: api-key-auth-or-configuration$/);
});

test('Pi reports a provider refusing the chosen model as runtime-model-unavailable, keeping the detail', async () => {
  const { child } = fixture((packet, send) => {
    if (packet.type === 'prompt') {
      send({ id: packet.id, type: 'response', success: true });
      send({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: '403: {"code":"1220","message":"您无权访问glm-5.3-highspeed。"}',
          content: [],
        },
      });
      send({ type: 'agent_end' });
      send({ type: 'agent_settled' });
      return true;
    }
  });
  await assert.rejects(adapterFor(child).execute(context()), (error: Error & { detail?: string }) => {
    assert.equal(error.message, 'runtime-model-unavailable');
    assert.match(error.detail ?? '', /1220/);
    return true;
  });
});

const writableInput = { ...context().input, permissionMode: 'workspace-write' as const };

test('Pi workspace-write fails closed when the permission extension marker is absent', async () => {
  const { child, requests } = fixture((packet, send) => {
    if (packet.type === 'get_commands') {
      send({
        id: packet.id,
        type: 'response',
        success: true,
        data: { commands: [{ name: 'studio-permissions-v1', source: 'prompt' }] },
      });
      return true;
    }
  });
  await assert.rejects(adapterFor(child).execute(context({ input: writableInput })), /permission/);
  assert.deepEqual(
    requests.map((packet) => packet.type),
    ['get_commands'],
  );
  assert.equal(child.stdin.writableEnded, true);
});

test('Pi workspace-write loads only its explicit bridge and forwards one approval per tool call', async () => {
  let args: string[] = [];
  const events: RunEvent[] = [];
  const approved: string[] = [];
  const { child, requests } = fixture((packet, send) => {
    if (packet.type === 'prompt') {
      send({ id: packet.id, type: 'response', success: true });
      for (const id of ['file-read', 'file-write'])
        send({ type: 'extension_ui_request', id, method: 'confirm', title: `Pi ${id}`, message: `Details for ${id}` });
      send({
        type: 'extension_ui_request',
        id: 'file-write',
        method: 'confirm',
        title: 'Duplicate',
        message: 'Duplicate',
      });
      return true;
    }
    if (packet.type === 'extension_ui_response' && packet.id === 'file-write') {
      send({ type: 'agent_settled' });
      return true;
    }
  });
  const adapter = createPiAdapter({
    spawn: async (_target, values) => {
      args = values;
      return child;
    },
    terminate: async () => {},
    permissionExtension: async () => '/app/pi-extension.mjs',
  });
  await adapter.execute(
    context({
      input: writableInput,
      emit: (event) => events.push(event),
      approve: async (tool, description) => {
        approved.push(`${tool}: ${description}`);
        return true;
      },
    }),
  );
  assert.equal(args[args.indexOf('--extension') + 1], '/app/pi-extension.mjs');
  assert.equal(
    args[args.indexOf('--tools') + 1],
    process.platform === 'win32'
      ? 'read,grep,find,ls,edit,write,bash,powershell,codemode'
      : 'read,grep,find,ls,edit,write,bash,codemode',
  );
  assert.ok(args.includes('--no-extensions') && args.includes('--no-approve'));
  assert.equal(requests[0]?.type, 'get_commands');
  const configs = events
    .filter((event) => event.data?.kind === 'permission-config')
    .map((event) => event.data?.detail as Record<string, unknown>);
  assert.equal(configs.find((detail) => detail.provenance === 'requested')?.approvalMode, 'ask');
  assert.equal(configs.find((detail) => detail.provenance === 'observed')?.permissionsReady, true);
  assert.equal(
    configs.find((detail) => detail.provenance === 'observed')?.approvalMode,
    undefined,
    'extension presence does not prove an effective approval mode',
  );
  assert.deepEqual(approved, ['Pi file-read: Details for file-read', 'Pi file-write: Details for file-write']);
  assert.deepEqual(
    requests
      .filter((packet) => packet.type === 'extension_ui_response')
      .map(({ id, confirmed }) => ({ id, confirmed })),
    [
      { id: 'file-read', confirmed: true },
      { id: 'file-write', confirmed: true },
    ],
  );
});

test('Pi bridge propagates a denial, including rejected host approval promises', async () => {
  for (const rejects of [false, true]) {
    const { child, requests } = fixture((packet, send) => {
      if (packet.type === 'prompt') {
        send({ id: packet.id, type: 'response', success: true });
        send({
          type: 'extension_ui_request',
          id: 'write',
          method: 'confirm',
          title: 'Pi write',
          message: 'Write details',
        });
        return true;
      }
      if (packet.type === 'extension_ui_response') {
        send({ type: 'agent_settled' });
        return true;
      }
    });
    await adapterFor(child).execute(
      context({
        input: writableInput,
        approve: async () => {
          if (rejects) throw new Error('Approval UI disconnected');
          return false;
        },
      }),
    );
    assert.deepEqual(
      requests.filter((packet) => packet.type === 'extension_ui_response'),
      [{ type: 'extension_ui_response', id: 'write', confirmed: false }],
    );
  }
});

test('Pi cancellation rejects an outstanding approval once and ignores a late positive decision', async () => {
  const controller = new AbortController();
  let decision!: (allow: boolean) => void;
  let approvalStarted!: () => void;
  const started = new Promise<void>((resolveStarted) => {
    approvalStarted = resolveStarted;
  });
  const { child, requests } = fixture((packet, send) => {
    if (packet.type === 'prompt') {
      send({ id: packet.id, type: 'response', success: true });
      send({
        type: 'extension_ui_request',
        id: 'shell',
        method: 'confirm',
        title: 'Pi bash',
        message: 'Command details',
      });
      return true;
    }
  });
  const pending = adapterFor(child).execute(
    context({
      input: writableInput,
      signal: controller.signal,
      approve: async () => {
        approvalStarted();
        return new Promise<boolean>((resolveDecision) => {
          decision = resolveDecision;
        });
      },
    }),
  );
  await started;
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  decision(true);
  await new Promise<void>((next) => setImmediate(next));
  assert.deepEqual(
    requests.filter((packet) => packet.type === 'extension_ui_response'),
    [{ type: 'extension_ui_response', id: 'shell', cancelled: true }],
  );
  assert.ok(requests.some((packet) => packet.type === 'clear_queue'));
  assert.ok(requests.some((packet) => packet.type === 'abort'));
});

test('Pi denies unexpected confirmation in read-only mode without asking the host', async () => {
  let approvals = 0;
  const { child, requests } = fixture((packet, send) => {
    if (packet.type === 'prompt') {
      send({ id: packet.id, type: 'response', success: true });
      send({ type: 'extension_ui_request', id: 'unexpected', method: 'confirm', title: 'Wrong mode' });
      return true;
    }
    if (packet.type === 'extension_ui_response') {
      send({ type: 'agent_settled' });
      return true;
    }
  });
  await adapterFor(child).execute(
    context({
      approve: async () => {
        approvals++;
        return true;
      },
    }),
  );
  assert.equal(approvals, 0);
  assert.deepEqual(
    requests.filter((packet) => packet.type === 'extension_ui_response'),
    [{ type: 'extension_ui_response', id: 'unexpected', cancelled: true }],
  );
});

test('Pi auto mode passes host policy, retains tool events and never forwards unexpected approvals', async () => {
  let approvals = 0;
  let environment: NodeJS.ProcessEnv = {};
  const events: RunEvent[] = [];
  const { child, requests } = fixture((packet, send) => {
    if (packet.type === 'prompt') {
      send({ id: packet.id, type: 'response', success: true });
      send({
        type: 'tool_execution_start',
        toolCallId: 'pi-write-1',
        toolName: 'write',
        args: { content: 'private-input', api_key: 'SECRET_TOOL_INPUT' },
      });
      send({
        type: 'tool_execution_end',
        toolCallId: 'pi-write-1',
        toolName: 'write',
        isError: false,
        result: { content: [{ type: 'text', text: 'private-result' }] },
      });
      send({
        type: 'extension_ui_request',
        id: 'unexpected',
        method: 'confirm',
        title: 'Do not auto-approve this request',
      });
      return true;
    }
    if (packet.type === 'extension_ui_response') {
      send({ type: 'agent_settled' });
      return true;
    }
  });
  const adapter = createPiAdapter({
    spawn: async (_target, _args, options) => {
      environment = options?.env ?? {};
      return child;
    },
    terminate: async () => {},
  });
  await adapter.execute(
    context({
      input: writableInput,
      approvalMode: 'auto',
      emit: (event) => events.push(event),
      approve: async () => {
        approvals++;
        return true;
      },
    }),
  );
  assert.equal(environment.COMBORUNNER_TOOL_APPROVAL_MODE, 'auto');
  assert.equal(approvals, 0);
  assert.deepEqual(
    requests.filter((packet) => packet.type === 'extension_ui_response'),
    [{ type: 'extension_ui_response', id: 'unexpected', cancelled: true }],
  );
  assert.deepEqual(
    events.filter((event) => event.type === 'tool').map((event) => event.text),
    ['write: started', 'write: finished'],
  );
  assert.deepEqual(
    events.filter((event) => event.type === 'tool').map((event) => event.data),
    [
      {
        toolCallId: 'pi-write-1',
        kind: 'nativeToolCall',
        tool: 'write',
        status: 'inProgress',
        input: { content: 'private-input', api_key: '[redacted]' },
      },
      {
        toolCallId: 'pi-write-1',
        kind: 'nativeToolCall',
        tool: 'write',
        status: 'completed',
        output: { content: [{ type: 'text', text: 'private-result' }] },
      },
    ],
  );
  assert.ok(!JSON.stringify(events).includes('SECRET_TOOL_INPUT'));
  assert.ok(
    events.some((event) => event.type === 'status' && event.text?.includes('需要 shell 的任务请使用 Codex 原生执行器')),
  );
});

test('Pi execution defaults explicitly to ask despite an ambient auto variable and keeps read-only tools restricted', async () => {
  const original = process.env.COMBORUNNER_TOOL_APPROVAL_MODE;
  let environment: NodeJS.ProcessEnv = {},
    args: string[] = [];
  const { child } = fixture((packet, send) => {
    if (packet.type === 'prompt') {
      send({ id: packet.id, type: 'response', success: true });
      send({ type: 'agent_settled' });
      return true;
    }
  });
  try {
    process.env.COMBORUNNER_TOOL_APPROVAL_MODE = 'auto';
    const adapter = createPiAdapter({
      spawn: async (_target, values, options) => {
        args = values;
        environment = options?.env ?? {};
        return child;
      },
      terminate: async () => {},
    });
    await adapter.execute(context());
  } finally {
    if (original === undefined) delete process.env.COMBORUNNER_TOOL_APPROVAL_MODE;
    else process.env.COMBORUNNER_TOOL_APPROVAL_MODE = original;
  }
  assert.equal(environment.COMBORUNNER_TOOL_APPROVAL_MODE, 'ask');
  assert.equal(environment.COMBORUNNER_PI_CODEMODE, 'on');
  assert.equal(args[args.indexOf('--tools') + 1], 'read,grep,find,ls,codemode');
  assert.ok(args.includes('--extension'));
});

test('Pi tool-less turns off every tool and context file and never reaches the host bridge', async () => {
  const run = async (apiBudget?: ExecuteContext['apiBudget']) => {
    let args: string[] = [],
      env: NodeJS.ProcessEnv = {},
      bridgeCalls = 0;
    const { child } = fixture((packet, send) => {
      if (packet.type === 'get_commands') {
        send({ id: packet.id, type: 'response', success: true, data: hostMarkers(true) });
        return true;
      }
      if (packet.type === 'prompt') {
        send({ id: packet.id, type: 'response', success: true });
        send({ type: 'agent_settled' });
        return true;
      }
    });
    const adapter = createPiAdapter({
      spawn: async (_target, values, options) => {
        args = values;
        env = options?.env ?? {};
        return child;
      },
      terminate: async () => {},
      version: async () => '0.87.1',
      permissionExtension: async () => '/app/pi-extension.mjs',
      environment: () => ({ COMBORUNNER_PI_CODEMODE: 'on' }),
      bridgeTools: async () => {
        bridgeCalls++;
        return ['find_files'];
      },
    });
    await adapter.execute(
      context({
        // Even a writable request carrying other people's words gets no tools.
        input: { ...context().input, permissionMode: 'workspace-write', untrustedContent: true },
        agentBridge: { url: 'http://127.0.0.1:4317/mcp', token: 'synthetic-token' },
        ...(apiBudget ? { apiBudget } : {}),
      }),
    );
    return { args, env, bridgeCalls };
  };
  const plain = await run();
  assert.ok(plain.args.includes('--no-tools') && plain.args.includes('--no-context-files'));
  assert.ok(!plain.args.includes('--tools') && !plain.args.includes('--extension'));
  assert.ok(plain.args.includes('--no-extensions'));
  assert.equal(plain.bridgeCalls, 0);
  assert.equal(plain.env.COMBORUNNER_AGENT_BRIDGE_URL, '');
  assert.equal(plain.env.COMBORUNNER_AGENT_BRIDGE_TOKEN, '');
  assert.equal(plain.env.COMBORUNNER_PI_PERMISSION_MODE, 'read-only');
  assert.equal(plain.env.COMBORUNNER_PI_CODEMODE, '');
  // An API budget still loads its guard; every tool stays off.
  const budgeted = await run({ maxCostUsd: 1 });
  assert.ok(budgeted.args.includes('--no-tools') && !budgeted.args.includes('--tools'));
  assert.equal(budgeted.args[budgeted.args.indexOf('--extension') + 1], '/app/pi-extension.mjs');
  assert.equal(budgeted.bridgeCalls, 0);
  assert.equal(budgeted.env.COMBORUNNER_PI_CODEMODE, '');
});

test('Pi text-only turns off every tool and context file and never reaches the host bridge', async () => {
  const run = async (apiBudget?: ExecuteContext['apiBudget']) => {
    let args: string[] = [],
      env: NodeJS.ProcessEnv = {},
      bridgeCalls = 0;
    const { child } = fixture((packet, send) => {
      if (packet.type === 'get_commands') {
        send({ id: packet.id, type: 'response', success: true, data: hostMarkers(true) });
        return true;
      }
      if (packet.type === 'prompt') {
        send({ id: packet.id, type: 'response', success: true });
        send({ type: 'agent_settled' });
        return true;
      }
    });
    const adapter = createPiAdapter({
      spawn: async (_target, values, options) => {
        args = values;
        env = options?.env ?? {};
        return child;
      },
      terminate: async () => {},
      version: async () => '0.87.1',
      permissionExtension: async () => '/app/pi-extension.mjs',
      environment: () => ({ COMBORUNNER_PI_CODEMODE: 'on' }),
      bridgeTools: async () => {
        bridgeCalls++;
        return ['find_files'];
      },
    });
    await adapter.execute(
      context({
        // Even a writable request carrying other people's words gets no tools.
        input: { ...context().input, permissionMode: 'workspace-write', textOnly: true },
        agentBridge: { url: 'http://127.0.0.1:4317/mcp', token: 'synthetic-token' },
        ...(apiBudget ? { apiBudget } : {}),
      }),
    );
    return { args, env, bridgeCalls };
  };
  const plain = await run();
  assert.ok(plain.args.includes('--no-tools') && plain.args.includes('--no-context-files'));
  assert.ok(!plain.args.includes('--tools') && !plain.args.includes('--extension'));
  assert.ok(plain.args.includes('--no-extensions'));
  assert.equal(plain.bridgeCalls, 0);
  assert.equal(plain.env.COMBORUNNER_AGENT_BRIDGE_URL, '');
  assert.equal(plain.env.COMBORUNNER_AGENT_BRIDGE_TOKEN, '');
  assert.equal(plain.env.COMBORUNNER_PI_PERMISSION_MODE, 'read-only');
  assert.equal(plain.env.COMBORUNNER_PI_CODEMODE, '');
  // An API budget still loads its guard; every tool stays off.
  const budgeted = await run({ maxCostUsd: 1 });
  assert.ok(budgeted.args.includes('--no-tools') && !budgeted.args.includes('--tools'));
  assert.equal(budgeted.args[budgeted.args.indexOf('--extension') + 1], '/app/pi-extension.mjs');
  assert.equal(budgeted.bridgeCalls, 0);
  assert.equal(budgeted.env.COMBORUNNER_PI_CODEMODE, '');
});

test('Pi upgrades only an unclassified provider failure to runtime-model-unavailable', () => {
  for (const raw of [
    '403: {"code":"1220","message":"您无权访问glm-5.3-highspeed。"}',
    'The model `synthetic-model` does not exist or you do not have access to it.',
    '{"error":{"code":"model_not_found","message":"synthetic"}}',
    '您无权访问该模型',
  ])
    assert.equal(modelAccessRefused(raw), true, raw);
  for (const raw of [
    'process exit_code=1220',
    'HTTP 429 rate limit: 无权访问',
    'API key 无权访问 this workspace',
    '无权访问此工作区',
    'Request failed with an unknown provider error',
  ])
    assert.equal(modelAccessRefused(raw), false, raw);
  assert.equal(
    modelAccessRefused({ error: { code: '1220', message: 'API key does not have access to model' } }),
    false,
  );
});

test('Pi reads each model image support from its catalog and marks the card when any model reads images', async () => {
  const models = piModels({
    models: [
      { provider: 'anthropic', id: 'claude-fixture', input: ['text', 'image'] },
      { provider: 'deepseek', id: 'deepseek-fixture', input: ['text'] },
      { provider: 'test', id: 'no-input-field' },
    ],
  });
  assert.deepEqual(
    models.map((entry) => entry.imageInput),
    [true, false, false],
  );
  for (const input of [['text', 'image'], ['text']]) {
    const { child } = fixture((packet, send) => {
      if (packet.type !== 'get_available_models') return;
      send({ id: packet.id, type: 'response', success: true, data: { models: [{ ...model, input }] } });
      return true;
    });
    const result = await adapterFor(child).discover(target);
    assert.equal(result.capabilities.imageInput, input.includes('image'));
  }
});

test('Pi sends attached pictures to the model as RPC image content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pugport-pi-image-test-'));
  try {
    const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#008c95' } })
      .png()
      .toBuffer();
    const path = join(directory, 'shape.png');
    await writeFile(path, bytes);
    const run = async (input: string[]) => {
      const { child, requests } = fixture((packet, send) => {
        if (packet.type === 'get_available_models') {
          send({ id: packet.id, type: 'response', success: true, data: { models: [{ ...model, input }] } });
          return true;
        }
        if (packet.type !== 'prompt') return;
        send({ id: packet.id, type: 'response', success: true });
        send({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'stop' } });
        send({ type: 'agent_settled' });
        return true;
      });
      await adapterFor(child).execute(
        context({
          input: {
            ...context().input,
            prompt: 'What is in the picture?',
            attachments: [
              { id: 'image-1', kind: 'image', name: 'shape.png', mimeType: 'image/png', size: bytes.length, path },
            ],
          },
        }),
      );
      return requests;
    };
    const prompt = (await run(['text', 'image'])).find((packet) => packet.type === 'prompt')!;
    assert.equal(prompt.message, 'What is in the picture?');
    assert.deepEqual(prompt.images, [{ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }]);
    // The live catalog no longer lists image input for the routed model: nothing is sent.
    await assert.rejects(run(['text']), /runtime-image-input-unavailable/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const handoff of [true, false]) {
  test(`Pi denied commands signal once and handoff=${handoff}`, async () => {
    let calls = 0;
    const { child, requests } = fixture((packet, send) => {
      if (packet.type !== 'prompt') return;
      send({ id: packet.id, type: 'response', success: true });
      for (const id of ['denied-1', 'denied-2']) {
        send({ type: 'tool_execution_start', toolCallId: id, toolName: 'powershell' });
        send({ type: 'extension_ui_request', method: 'notify', message: `pugport-command-untrusted:${id}` });
        send({ type: 'tool_execution_end', toolCallId: id, toolName: 'powershell', isError: true });
      }
      if (!handoff) send({ type: 'agent_settled' });
      return true;
    });
    const adapter = createPiAdapter({ spawn: async () => child, terminate: async () => {} });
    await adapter.execute(
      context({
        input: writableInput,
        approvalMode: 'auto',
        commandDenied: () => {
          calls++;
          return handoff;
        },
      }),
    );
    assert.equal(calls, 1);
    assert.equal(
      requests.some((packet) => packet.type === 'abort'),
      handoff,
    );
  });
}
