import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ExecuteContext, RunEvent, RuntimeTarget } from '../src/shared/types.js';
import { createGrokAdapter } from '../src/server/adapters/grok.js';
import { redactToolDiagnostic } from '../src/server/tool-diagnostics.ts';
import {
  executeGrokAcp,
  grokAcpArgs,
  grokAcpSessionMeta,
  grokAcpUsage,
  GrokAcpUnsupported,
} from '../src/server/adapters/grok-acp.js';

type Packet = Record<string, any>;
const target: RuntimeTarget = {
  id: 'grok',
  provider: 'grok',
  label: 'Grok',
  command: 'fixture',
  environment: 'native',
  enabled: true,
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  }) as unknown as ChildProcessWithoutNullStreams;
  const requests: Packet[] = [];
  const events: RunEvent[] = [];
  const abort = new AbortController();
  let steer: ((text: string, delivery?: { id: string; mode?: 'interrupt' | 'append' }) => Promise<void>) | undefined;
  const steeringStates: { state: string; reason?: string; available: boolean }[] = [];
  let custom: ((packet: Packet) => boolean) | undefined;
  let sessionId = '',
    prompt: Packet | undefined,
    terminated = 0,
    toolsEnded = 0;
  const send = (packet: Packet) =>
    (child.stdout as PassThrough).write(JSON.stringify({ jsonrpc: '2.0', ...packet }) + '\n');
  const reply = (packet: Packet, result: Packet) => send({ id: packet.id, result });
  const notify = (method: string, params: Packet) => send({ method, params: { sessionId, ...params } });
  const complete = (extra: Packet = {}) => {
    assert.ok(prompt);
    reply(prompt, { stopReason: 'end_turn', ...extra });
  };
  let buffer = '';
  child.stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let at: number;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const packet = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      requests.push(packet);
      queueMicrotask(() => {
        if (custom?.(packet)) return;
        if (packet.method === 'initialize')
          reply(packet, {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true },
            authMethods: [{ id: 'cached_token' }],
            _meta: { defaultAuthMethodId: 'cached_token' },
          });
        else if (packet.method === '_x.ai/interject' && !packet.params.sessionId)
          send({ id: packet.id, error: { code: -32602, message: 'Invalid params' } });
        else if (packet.method === 'session/new') {
          sessionId = packet.params._meta.sessionId;
          reply(packet, { sessionId });
        } else if (packet.method === 'session/load') {
          sessionId = packet.params.sessionId;
          reply(packet, {});
        } else if (packet.method === 'session/prompt') {
          // Send-now tests control its queue acknowledgement and full-turn RPC separately.
          if (packet.params._meta?.sendNow) return;
          prompt = packet;
          notify('_x.ai/queue/changed', { entries: [], runningPromptId: packet.params._meta.promptId });
        } else if (packet.method === '_x.ai/interject') {
          reply(packet, { result: { status: 'queued' } });
          notify('_x.ai/session/interjection', {
            interjectionId: packet.params.interjectionId,
            text: packet.params.text,
          });
        } else if (packet.method === '_x.ai/session/info')
          reply(packet, { result: { sessionId, agentName: 'comborunner-grok' } });
        else if (packet.id !== undefined && packet.method) reply(packet, {});
      });
    }
  });
  const ctx: ExecuteContext = {
    target,
    signal: abort.signal,
    approvalMode: 'auto',
    input: { prompt: 'Original prompt', projectPath: process.cwd(), kind: 'general', permissionMode: 'read-only' },
    route: { runtimeId: 'grok', model: 'grok-4.7', effort: 'high', kind: 'general', reasons: [], warnings: [] },
    emit: (event) => events.push(event),
    approve: async () => {
      throw new Error('No host prompt is permitted.');
    },
    endTools: () => toolsEnded++,
    registerSteer: (handler, info) => {
      steer = handler;
      if (info) steeringStates.push({ ...info, available: !!handler });
    },
  };
  const deps = {
    spawn: async () => child,
    terminate: async () => {
      terminated++;
      child.emit('close', 0);
    },
    timeoutMs: 1000,
  };
  return {
    child,
    ctx,
    deps,
    requests,
    events,
    steeringStates,
    send,
    reply,
    notify,
    complete,
    abort,
    get steer() {
      return steer;
    },
    get prompt() {
      return prompt;
    },
    get sessionId() {
      return sessionId;
    },
    get terminated() {
      return terminated;
    },
    get toolsEnded() {
      return toolsEnded;
    },
    customize(fn: (packet: Packet) => boolean) {
      custom = fn;
    },
    async ready() {
      for (let i = 0; i < 30 && !steer; i++) await tick();
      assert.ok(steer);
    },
  };
}

test('Grok ACP permission trace separates its requested profile from observed native fields without exposing bridge credentials', async () => {
  const h = harness();
  h.customize((packet) => {
    if (packet.method !== '_x.ai/session/info') return false;
    h.reply(packet, {
      result: {
        sessionId: h.sessionId,
        agentName: 'comborunner-grok',
        permissionMode: 'auto',
        token: 'OPAQUE_SECRET',
        systemPrompt: 'PRIVATE_SYSTEM',
        headers: { Authorization: 'PRIVATE_AUTH' },
      },
    });
    return true;
  });
  const execution = executeGrokAcp(h.ctx, h.deps);
  await h.ready();
  h.notify('session/update', {
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Synthetic reply.' } },
  });
  h.complete();
  await execution;
  const configs = h.events
    .filter((event) => event.data?.kind === 'permission-config')
    .map((event) => event.data?.detail as Record<string, unknown>);
  const requested = configs.find((detail) => detail.provenance === 'requested')!;
  const observed = configs.find((detail) => detail.provenance === 'observed')!;
  assert.deepEqual(requested.tools, ['Read', 'Grep']);
  assert.deepEqual(requested.disallowedTools, ['Agent', 'Edit', 'Write', 'Bash', 'search_tool', 'use_tool']);
  assert.deepEqual(requested.mcpServerNames, []);
  assert.equal(requested.yoloMode, false);
  assert.equal(observed.permissionMode, 'auto');
  assert.equal(observed.agentName, 'comborunner-grok');
  assert.equal(observed.tools, undefined, 'requested tools are not proof of observed native tools');
  assert.doesNotMatch(JSON.stringify(configs), /OPAQUE_SECRET|PRIVATE_SYSTEM|PRIVATE_AUTH/);
});

test('Grok ACP submits a new user message to the active session and keeps streaming in one prompt', async () => {
  const h = harness();
  const execution = createGrokAdapter(h.deps).execute(h.ctx);
  await h.ready();
  h.notify('session/update', {
    update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking' } },
  });
  h.notify('session/update', {
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Before ' } },
  });
  const savedHandler = h.steer!;
  await savedHandler('Steer with $() and "quotes"');
  assert.equal(h.child.stdin.writableEnded, false);
  h.notify('session/update', {
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after' } },
  });
  h.complete({
    _meta: {
      usage: {
        inputTokens: 10,
        cachedReadTokens: 3,
        cacheCreationTokens: 1,
        outputTokens: 2,
        totalTokens: 12,
        costUsdTicks: 100000000,
      },
    },
  });
  const result = await execution;
  assert.equal(result.output, 'Before after');
  assert.equal(result.nativeSessionId, h.sessionId);
  assert.equal(h.requests.filter((packet) => packet.method === 'session/new').length, 1);
  assert.equal(h.requests.filter((packet) => packet.method === 'session/prompt').length, 1);
  const steerPacket = h.requests.find((packet) => packet.method === '_x.ai/interject' && packet.params.sessionId);
  assert.equal(steerPacket?.params.sessionId, h.sessionId);
  assert.equal(steerPacket?.params.text, 'Steer with $() and "quotes"');
  assert.ok(steerPacket?.params.interjectionId);
  assert.ok(!h.requests.some((packet) => packet.method === 'session/cancel'));
  assert.equal(
    h.events
      .filter((event) => event.type === 'reasoning')
      .map((event) => event.text)
      .join(''),
    'Thinking',
  );
  assert.equal(h.events.find((event) => event.type === 'usage')?.data?.inputTokens, 6);
  assert.equal(h.steer, undefined);
  assert.equal(h.steeringStates.at(-1)?.state, 'finishing');
  await assert.rejects(savedHandler('Too late'), /runtime-process-closed/);
  assert.equal(h.terminated, 1);
});

test('Grok send-now acknowledges the queue, survives its old turn cancellation and streams a new turn in the same process', async () => {
  const h = harness();
  const execution = executeGrokAcp(h.ctx, h.deps);
  await h.ready();
  h.notify('session/update', {
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Earlier output. ' } },
  });
  const delivery = h.steer!('Only scan the narrowed folder.', { id: 'replacement-1', mode: 'interrupt' });
  const replacement = h.requests.find((packet) => packet.params?._meta?.promptId === 'replacement-1');
  assert.ok(replacement);
  assert.equal(replacement.method, 'session/prompt');
  assert.equal(replacement.params.sessionId, h.sessionId);
  assert.equal(replacement.params._meta.sendNow, true);
  assert.match(replacement.params.prompt[0].text, /Only scan the narrowed folder\./);
  assert.match(replacement.params.prompt[0].text, /后台运行/);
  h.notify('_x.ai/queue/changed', {
    runningPromptId: h.prompt!.params._meta.promptId,
    entries: [{ id: 'replacement-1' }],
  });
  await delivery;
  assert.equal(h.toolsEnded, 0);
  assert.equal(h.events.filter((event) => event.data?.steeringPhase === 'resuming').length, 0);
  h.complete({ stopReason: 'cancelled', _meta: { cancelTrigger: 'send_now' } });
  await tick();
  assert.equal(h.terminated, 0, 'The old native turn cancellation must not kill the replacement.');
  h.notify('_x.ai/queue/changed', { runningPromptId: 'replacement-1', entries: [] });
  assert.equal(h.events.find((event) => event.data?.steeringPhase === 'resuming')?.data?.steeringId, 'replacement-1');
  h.notify('session/update', {
    update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'New plan for the new scope.' } },
  });
  h.notify('session/update', {
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Replanned.' } },
  });
  h.reply(replacement, { stopReason: 'end_turn' });
  h.notify('_x.ai/queue/changed', { entries: [] });
  const result = await execution;
  assert.match(result.output, /Replanned\./);
  assert.equal(h.requests.filter((packet) => packet.method === 'session/new').length, 1);
  assert.equal(h.requests.filter((packet) => packet.method === 'session/prompt').length, 2);
  assert.equal(h.requests.filter((packet) => packet.method === '_x.ai/interject' && packet.params.sessionId).length, 0);
  assert.equal(h.terminated, 1);
});

test('successive send-now messages keep their own queue receipts and native turn lifetimes', async () => {
  const h = harness();
  const execution = executeGrokAcp(h.ctx, h.deps);
  await h.ready();
  const first = h.steer!('First change', { id: 'replacement-a', mode: 'interrupt' });
  const firstPrompt = h.requests.find((packet) => packet.params?._meta?.promptId === 'replacement-a')!;
  h.notify('_x.ai/queue/changed', {
    runningPromptId: h.prompt!.params._meta.promptId,
    entries: [{ id: 'replacement-a' }],
  });
  await first;
  h.complete({ stopReason: 'cancelled', _meta: { cancelTrigger: 'send_now' } });
  h.notify('_x.ai/queue/changed', { runningPromptId: 'replacement-a', entries: [] });
  await tick();
  const second = h.steer!('Second change', { id: 'replacement-b', mode: 'interrupt' });
  const secondPrompt = h.requests.find((packet) => packet.params?._meta?.promptId === 'replacement-b')!;
  h.notify('_x.ai/queue/changed', { runningPromptId: 'replacement-a', entries: [{ id: 'replacement-b' }] });
  await second;
  h.reply(firstPrompt, { stopReason: 'cancelled', _meta: { cancelTrigger: 'send_now' } });
  h.notify('_x.ai/queue/changed', { runningPromptId: 'replacement-b', entries: [] });
  h.notify('session/update', {
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Both changes incorporated.' } },
  });
  h.reply(secondPrompt, { stopReason: 'end_turn' });
  h.notify('_x.ai/queue/changed', { entries: [] });
  await execution;
  assert.deepEqual(
    h.requests.filter((packet) => packet.params?._meta?.sendNow).map((packet) => packet.params._meta.promptId),
    ['replacement-a', 'replacement-b'],
  );
  assert.deepEqual(
    h.events.filter((event) => event.data?.steeringPhase === 'resuming').map((event) => event.data?.steeringId),
    ['replacement-a', 'replacement-b'],
  );
});

test('send-now preserves real cancellation and does not treat it as replacement cancellation', async () => {
  const h = harness();
  const execution = executeGrokAcp(h.ctx, h.deps);
  const rejected = assert.rejects(execution, /operation-cancelled/);
  await h.ready();
  const delivery = h.steer!('New scope', { id: 'replacement-stop', mode: 'interrupt' });
  h.notify('_x.ai/queue/changed', {
    runningPromptId: h.prompt!.params._meta.promptId,
    entries: [{ id: 'replacement-stop' }],
  });
  await delivery;
  h.complete({ stopReason: 'cancelled', _meta: { cancelTrigger: 'user' } });
  await rejected;
  assert.equal(h.terminated, 1);
});

test('a rejected send-now submission reports failure without killing the original native turn', async () => {
  const h = harness();
  const execution = executeGrokAcp(h.ctx, h.deps);
  await h.ready();
  const delivery = h.steer!('New scope', { id: 'replacement-rejected', mode: 'interrupt' });
  const replacement = h.requests.find((packet) => packet.params?._meta?.promptId === 'replacement-rejected')!;
  h.send({ id: replacement.id, error: { code: -32602, message: 'Native send-now rejected' } });
  await assert.rejects(delivery, /runtime-request-failed/);
  assert.equal(h.toolsEnded, 0);
  h.notify('session/update', {
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Original task result.' } },
  });
  h.complete();
  assert.equal((await execution).output, 'Original task result.');
});

test('native goal send-now conversion needs its matching echo in either wire order and never reports a new turn', async () => {
  for (const echoFirst of [true, false]) {
    const h = harness();
    const execution = executeGrokAcp(h.ctx, h.deps);
    await h.ready();
    const delivery = h.steer!('Goal correction', { id: 'goal-correction', mode: 'interrupt' });
    const replacement = h.requests.find((packet) => packet.params?._meta?.promptId === 'goal-correction')!;
    const echo = () =>
      h.notify('_x.ai/session/interjection', {
        interjectionId: 'goal-correction',
        text: replacement.params.prompt[0].text,
      });
    if (echoFirst) echo();
    h.reply(replacement, { stopReason: 'cancelled', _meta: { completionKind: 'removedFromQueue' } });
    if (!echoFirst) {
      await tick();
      echo();
    }
    await delivery;
    assert.equal(h.events.find((event) => event.data?.steeringPhase === 'received')?.data?.steeringMode, 'append');
    assert.ok(!h.events.some((event) => event.data?.steeringPhase === 'resuming'));
    h.notify('session/update', {
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Goal continued.' } },
    });
    h.complete();
    await execution;
  }
});

test('Grok ACP native policy preserves auto/dontAsk, read-only tools, no subagents and no permission window', async () => {
  const h = harness();
  const args = grokAcpArgs(h.ctx);
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'auto');
  assert.ok(args.includes('--no-leader'));
  assert.ok(args.includes('--disable-web-search'));
  assert.ok(!args.includes('--always-approve'));
  const meta = grokAcpSessionMeta(h.ctx);
  assert.equal(meta.yoloMode, false);
  assert.equal(meta.autoMode, true);
  assert.deepEqual((meta.agentProfile as Packet).tools, ['Read', 'Grep']);
  for (const deny of ['Agent', 'Edit', 'Write', 'Bash', 'search_tool', 'use_tool'])
    assert.ok((meta.agentProfile as Packet).disallowedTools.includes(deny));
  h.ctx.approvalMode = 'ask';
  assert.equal((grokAcpSessionMeta(h.ctx).agentProfile as Packet).permissionMode, 'dontAsk');
  h.ctx.input.permissionMode = 'workspace-write';
  assert.equal((grokAcpSessionMeta(h.ctx).agentProfile as Packet).tools, undefined);
  assert.deepEqual((grokAcpSessionMeta(h.ctx).agentProfile as Packet).disallowedTools, ['Agent']);
  const execution = executeGrokAcp(h.ctx, h.deps);
  await h.ready();
  h.send({
    id: 'permission-1',
    method: 'session/request_permission',
    params: {
      sessionId: h.sessionId,
      options: [
        { kind: 'allow_once', optionId: 'yes' },
        { kind: 'reject_once', optionId: 'no' },
      ],
    },
  });
  h.send({ id: 'fs-1', method: 'fs/write_text_file', params: { path: 'forbidden.txt' } });
  await tick();
  assert.deepEqual(h.requests.find((packet) => packet.id === 'permission-1')?.result, {
    outcome: { outcome: 'selected', optionId: 'no' },
  });
  assert.equal(h.requests.find((packet) => packet.id === 'fs-1')?.error.code, -32601);
  h.notify('session/update', {
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done' } },
  });
  h.complete();
  await execution;
});

const bridgeSnapshot = (url: string, transport: 'http' | 'session-only' = 'http') => ({
  sessionMcpResolved: false,
  servers: [
    {
      name: 'pugport',
      ...(transport === 'http' ? { type: 'http', url } : { type: 'stdio', source: 'local', command: '' }),
      session: { enabled: true, status: 'ready', tools: [{ name: 'git' }] },
    },
    { name: 'other-server', session: { enabled: true, status: 'initializing' } },
  ],
});

for (const nativeSessionId of [undefined, 'synthetic-resumed-session'])
  for (const transport of ['http', 'session-only'] as const)
    test(`Grok ACP starts hinted self-contained chat after its bridge catalog is ready (${nativeSessionId ? 'resume' : 'new'}, ${transport})`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const h = harness();
      h.ctx.input.selfContainedChat = true;
      h.ctx.nativeSessionId = nativeSessionId;
      h.ctx.agentBridge = { url: 'http://127.0.0.1:4317/mcp/PRIVATE_PATH', token: 'PRIVATE_TOKEN' };
      h.customize((packet) => {
        if (packet.method !== '_x.ai/mcp/list') return false;
        assert.deepEqual(packet.params, { sessionId: h.sessionId, cache: true });
        assert.ok(h.requests.some((request) => request.method === '_x.ai/session/info'));
        h.reply(packet, { result: bridgeSnapshot(h.ctx.agentBridge!.url, transport) });
        return true;
      });
      const execution = executeGrokAcp(h.ctx, h.deps);
      const settled = execution.catch(() => undefined);
      try {
        await h.ready();
        const session = h.requests.find(
          (packet) => packet.method === (nativeSessionId ? 'session/load' : 'session/new'),
        )!;
        assert.deepEqual(
          session.params.mcpServers.map((server: Packet) => server.name),
          ['pugport'],
        );
        assert.equal(session.params._meta.agentProfile.permissionMode, 'default');
        const trace = h.events.find((event) => event.data?.kind === 'mcp-readiness')?.data?.detail as Packet;
        assert.equal(trace.outcome, 'bridge-ready');
        assert.equal(typeof trace.waitMs, 'number');
        assert.doesNotMatch(JSON.stringify(trace), /PRIVATE_PATH|PRIVATE_TOKEN/);
        h.notify('session/update', {
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } },
        });
        h.complete();
        await execution;
      } finally {
        h.abort.abort();
        t.mock.timers.tick(10_000);
        await settled;
      }
    });

test('Grok ACP preserves the all-server wait for ordinary tool tasks even when its bridge is ready', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.ctx.agentBridge = { url: 'http://127.0.0.1:4317/mcp', token: 'synthetic' };
  const execution = executeGrokAcp(h.ctx, h.deps);
  const settled = execution.catch(() => undefined);
  try {
    await tick();
    assert.ok(h.requests.some((packet) => packet.method === '_x.ai/session/info'));
    assert.ok(!h.requests.some((packet) => packet.method === '_x.ai/mcp/list'));
    t.mock.timers.tick(9999);
    await tick();
    assert.equal(h.prompt, undefined);
    t.mock.timers.tick(1);
    await h.ready();
    const trace = h.events.find((event) => event.data?.kind === 'mcp-readiness')?.data?.detail as Packet;
    assert.equal(trace.outcome, 'timeout');
    h.notify('session/update', {
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done' } },
    });
    h.complete();
    await execution;
  } finally {
    h.abort.abort();
    t.mock.timers.tick(10_000);
    await settled;
  }
});

test('Grok ACP polls the hinted bridge without accepting a wrong endpoint, incomplete catalog or unavailable server', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.ctx.input.selfContainedChat = true;
  h.ctx.agentBridge = { url: 'http://127.0.0.1:4317/mcp', token: 'synthetic' };
  const snapshots = [
    { url: 'http://127.0.0.1:4317/another-account' },
    { name: 'other-bridge' },
    { type: 'stdio', source: 'local', command: 'another-server', url: undefined },
    { type: 'stdio', source: 'managed', command: '', url: undefined },
    { type: 'stdio', source: 'local', command: '', args: ['another-server'], url: undefined },
    { type: 'stdio', source: 'local', command: '', env: [{ name: 'ACCOUNT', value: 'other' }], url: undefined },
    { session: { enabled: true, status: 'initializing', tools: [{ name: 'git' }] } },
    { session: { enabled: false, status: 'ready', tools: [{ name: 'git' }] } },
    { session: { enabled: true, status: 'ready', tools: [] } },
    { session: { enabled: true, status: 'ready', tools: [{ name: 'git' }], authRequired: true } },
  ];
  let queries = 0;
  h.customize((packet) => {
    if (packet.method !== '_x.ai/mcp/list') return false;
    const snapshot = bridgeSnapshot(h.ctx.agentBridge!.url);
    Object.assign(snapshot.servers[0]!, snapshots[queries++]);
    h.reply(packet, { result: snapshot });
    return true;
  });
  const execution = executeGrokAcp(h.ctx, h.deps);
  const settled = execution.catch(() => undefined);
  try {
    await tick();
    for (let i = 0; i < snapshots.length; i++) {
      assert.equal(queries, i + 1);
      assert.equal(h.prompt, undefined);
      t.mock.timers.tick(250);
      await tick();
    }
    await h.ready();
    assert.equal(queries, snapshots.length + 1);
    h.notify('session/update', {
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } },
    });
    h.complete();
    await execution;
  } finally {
    h.abort.abort();
    t.mock.timers.tick(10_000);
    await settled;
  }
});

for (const interrupted of ['abort', 'close'] as const)
  test(`Grok ACP ends its readiness wait immediately on ${interrupted}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = harness();
    h.ctx.input.selfContainedChat = true;
    h.ctx.agentBridge = { url: 'http://127.0.0.1:4317/mcp', token: 'synthetic' };
    h.customize((packet) => packet.method === '_x.ai/mcp/list');
    let ended = false;
    const execution = executeGrokAcp(h.ctx, h.deps);
    const rejected = assert
      .rejects(execution, interrupted === 'abort' ? /operation-cancelled/ : /runtime-process-closed/)
      .then(() => {
        ended = true;
      });
    try {
      await tick();
      if (interrupted === 'abort') h.abort.abort();
      else h.child.emit('close', 0);
      await tick();
      assert.equal(ended, true, 'cancellation must not wait for the readiness timeout');
      assert.equal(h.prompt, undefined);
      const queries = h.requests.filter((packet) => packet.method === '_x.ai/mcp/list').length;
      t.mock.timers.tick(10_000);
      await tick();
      assert.equal(h.requests.filter((packet) => packet.method === '_x.ai/mcp/list').length, queries);
    } finally {
      t.mock.timers.tick(10_000);
      await rejected;
    }
  });

for (const nativeSessionId of [undefined, 'synthetic-resumed-session'])
  test(`Grok read-only ACP asks the host and approves only its bridge use_tool calls (${nativeSessionId ? 'resume' : 'new'})`, async () => {
    for (const approvalMode of ['auto', 'ask'] as const) {
      const h = harness();
      h.ctx.approvalMode = approvalMode;
      h.ctx.nativeSessionId = nativeSessionId;
      h.ctx.agentBridge = { url: 'http://127.0.0.1:4317/mcp', token: 'synthetic-bridge-token' };
      h.customize((packet) => {
        if (packet.method === 'session/new' || packet.method === 'session/load')
          h.send({
            method: '_x.ai/mcp_initialized',
            params: { sessionId: nativeSessionId ?? packet.params._meta.sessionId },
          });
        return false;
      });
      const args = grokAcpArgs(h.ctx);
      const execution = executeGrokAcp(h.ctx, h.deps);
      await h.ready();
      for (const [id, toolCall] of [
        ['own', { title: 'use_tool', rawInput: { tool_name: 'pugport__git' } }],
        ['other', { title: 'use_tool', rawInput: { tool_name: 'pikpak__delete_file' } }],
        ['unnamed', {}],
        ['misleading', { title: 'pugport__git', rawInput: { tool_name: 'pikpak__x' } }],
      ] as const)
        h.send({
          id,
          method: 'session/request_permission',
          params: {
            sessionId: h.sessionId,
            toolCall: { toolCallId: id, ...toolCall },
            options: [
              { kind: 'allow_once', optionId: 'yes' },
              { kind: 'reject_once', optionId: 'no' },
            ],
          },
        });
      await tick();
      h.notify('session/update', {
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Synthetic reply' } },
      });
      h.complete({ stopReason: 'cancelled' });
      await assert.rejects(execution, /runtime-permission-or-sandbox-error/);
      const session = h.requests.find(
        (packet) => packet.method === (nativeSessionId ? 'session/load' : 'session/new'),
      )?.params;
      assert.deepEqual(session.mcpServers, [
        {
          type: 'http',
          name: 'pugport',
          url: h.ctx.agentBridge.url,
          headers: [{ name: 'Authorization', value: 'Bearer synthetic-bridge-token' }],
        },
      ]);
      assert.equal(session._meta.agentProfile.permissionMode, 'default');
      assert.equal(session._meta.autoMode, false);
      assert.equal(args[args.indexOf('--permission-mode') + 1], 'default');
      const requested = h.events.find(
        (event) => event.data?.kind === 'permission-config' && (event.data.detail as Packet).provenance === 'requested',
      )?.data?.detail as Packet;
      assert.equal(requested.permissionMode, 'default');
      assert.equal(requested.autoMode, false);
      assert.deepEqual(requested.mcpServerNames, ['pugport']);
      assert.deepEqual(requested.tools, ['Read', 'Grep']);
      assert.deepEqual(requested.disallowedTools, ['Agent', 'Edit', 'Write', 'Bash']);
      for (const [id, optionId] of [
        ['own', 'yes'],
        ['other', 'no'],
        ['unnamed', 'no'],
        ['misleading', 'no'],
      ])
        assert.deepEqual(h.requests.find((packet) => packet.id === id)?.result, {
          outcome: { outcome: 'selected', optionId },
        });
    }
  });

test('Grok ACP approves PugPort tools behind use_tool and reports any other rejected ask as a blocked step', async () => {
  const h = harness();
  h.ctx.input.permissionMode = 'workspace-write';
  h.ctx.agentBridge = { url: 'http://127.0.0.1:4317/mcp', token: 'bridge-token' };
  // Grok reports its MCP servers ready before the prompt; the prompt must not wait out the fallback timer.
  h.customize((packet) => {
    if (packet.method === 'session/new')
      h.send({ method: '_x.ai/mcp_initialized', params: { sessionId: packet.params._meta.sessionId } });
    return false;
  });
  const execution = executeGrokAcp(h.ctx, h.deps);
  void execution.catch(() => undefined);
  await h.ready();
  const options = [
    { kind: 'allow_once', optionId: 'yes' },
    { kind: 'reject_once', optionId: 'no' },
  ];
  h.notify('session/update', {
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'own',
      title: 'use_tool',
      kind: 'other',
      rawInput: { tool_name: 'pugport__organize_files', tool_input: { recycle: ['D:\\inbox\\empty'] } },
    },
  });
  h.send({
    id: 'permission-own',
    method: 'session/request_permission',
    params: { sessionId: h.sessionId, toolCall: { toolCallId: 'own' }, options },
  });
  h.send({
    id: 'permission-other',
    method: 'session/request_permission',
    params: {
      sessionId: h.sessionId,
      toolCall: { toolCallId: 'other', title: 'use_tool', rawInput: { tool_name: 'github__create_issue' } },
      options,
    },
  });
  await tick();
  assert.deepEqual(h.requests.find((packet) => packet.id === 'permission-own')?.result, {
    outcome: { outcome: 'selected', optionId: 'yes' },
  });
  assert.deepEqual(h.requests.find((packet) => packet.id === 'permission-other')?.result, {
    outcome: { outcome: 'selected', optionId: 'no' },
  });
  // Grok's own auto review can still refuse a PugPort tool outright; that refusal is a blocked step too, and the
  // reason names the tool instead of the use_tool wrapper.
  h.notify('session/update', {
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'recycle',
      title: 'pugport__recycle_files',
      kind: 'other',
      rawInput: { variant: 'UseTool', tool_name: 'pugport__recycle_files', tool_input: { paths: ['D:\\inbox'] } },
    },
  });
  const autoBlocked = 'Tool `use_tool` was not executed: Auto mode blocked this action (only a comparison was asked).';
  h.notify('session/update', {
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'recycle',
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: autoBlocked } }],
    },
  });
  await tick();
  const blocked = h.events.filter((event) => event.data?.executionBlocked);
  assert.deepEqual(
    blocked.map((event) => event.data?.toolCallId),
    ['other', 'recycle'],
  );
  assert.equal(blocked[1]?.data?.detail, `pugport__recycle_files：${autoBlocked}`);
  // Grok ends a turn as cancelled after a rejection; that is a blocked step, not a stop the user asked for.
  h.complete({ stopReason: 'cancelled' });
  await tick();
  assert.equal(h.requests.filter((packet) => packet.method === 'session/prompt').length, 2);
  h.notify('session/update', {
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Completed another way.' } },
  });
  h.complete();
  await execution;
});

test('Grok ACP resumes the same session without replaying old output or changing the requested model', async () => {
  const h = harness();
  h.ctx.nativeSessionId = 'persisted-session';
  h.customize((packet) => {
    if (packet.method !== 'session/load') return false;
    h.send({
      method: 'session/update',
      params: {
        sessionId: 'persisted-session',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Old replay' } },
      },
    });
    return false;
  });
  const execution = executeGrokAcp(h.ctx, h.deps);
  await h.ready();
  h.send({
    method: 'session/update',
    params: {
      sessionId: 'persisted-session',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'New' } },
    },
  });
  h.complete();
  assert.equal((await execution).output, 'New');
  assert.ok(!h.requests.some((packet) => packet.method === 'session/new'));
  const load = h.requests.find((packet) => packet.method === 'session/load');
  assert.equal(load?.params.sessionId, 'persisted-session');
  assert.equal(load?.params._meta.restoreCode, false);
  assert.deepEqual(h.requests.find((packet) => packet.method === 'session/set_model')?.params, {
    sessionId: 'persisted-session',
    modelId: 'grok-4.7',
    _meta: { reasoningEffort: 'high' },
  });
});

test('Grok ACP validates nested extension failures and does not claim that unsupported input was delivered', async () => {
  const h = harness();
  h.customize((packet) => {
    if (packet.method !== '_x.ai/interject' || !packet.params.sessionId) return false;
    h.reply(packet, { result: null, error: 'Failed with private diagnostic' });
    return true;
  });
  const execution = executeGrokAcp(h.ctx, h.deps);
  await h.ready();
  await assert.rejects(h.steer!('Update'), /runtime-request-failed/);
  h.notify('session/update', {
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Still running' } },
  });
  h.complete();
  assert.equal((await execution).output, 'Still running');
  assert.ok(!JSON.stringify(h.events).includes('private'));
});

test('Grok ACP waits for a native same-session fallback turn after an accepted interjection races completion', async () => {
  const h = harness();
  const execution = executeGrokAcp(h.ctx, h.deps);
  await h.ready();
  await h.steer!('Late update');
  h.notify('session/update', {
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'First ' } },
  });
  h.complete({
    _meta: {
      usage: {
        inputTokens: 10,
        cachedReadTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 2,
        totalTokens: 12,
        costUsdTicks: 100000000,
      },
    },
  });
  h.notify('_x.ai/queue/changed', { entries: [], runningPromptId: 'interject-fallback-1' });
  let settled = false;
  void execution.then(() => {
    settled = true;
  });
  await tick();
  await tick();
  assert.equal(settled, false);
  assert.equal(h.terminated, 0);
  assert.ok(h.steer, 'The native fallback is still an active turn in the same session.');
  await h.steer('Additional update during fallback');
  h.notify('_x.ai/session/prompt_complete', { promptId: h.prompt!.params._meta.promptId, stopReason: 'end_turn' });
  h.notify('_x.ai/session/update', {
    update: { type: 'turn_completed', promptId: h.prompt!.params._meta.promptId, stopReason: 'end_turn' },
  });
  h.notify('_x.ai/queue/changed', { entries: [], runningPromptId: h.prompt!.params._meta.promptId });
  assert.ok(h.steer, 'Late initial completion and queue snapshots must not close the running fallback.');
  assert.equal(h.steeringStates.at(-1)?.state, 'ready');
  h.notify('session/update', {
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'follow-up' } },
  });
  h.notify('_x.ai/session/update', {
    update: { type: 'turn_completed', promptId: 'interject-fallback-1', stopReason: 'end_turn' },
  });
  assert.equal((await execution).output, 'First follow-up');
  assert.equal(h.requests.filter((packet) => packet.method === 'session/prompt').length, 1);
  assert.equal(h.requests.filter((packet) => packet.method === '_x.ai/interject' && packet.params.sessionId).length, 2);
  assert.ok(!h.requests.some((packet) => packet.method === 'session/cancel'));
  const usage = h.events.find((event) => event.type === 'usage');
  assert.equal(usage?.data?.incomplete, true);
  assert.equal(usage?.data?.costUsd, undefined);
  assert.equal(usage?.data?.totalTokens, undefined);
});

test('Grok ACP keeps a live fallback and its tools when another interjection fails during initial completion', async () => {
  for (const failure of ['rpc', 'receipt-timeout']) {
    const h = harness();
    let rejectedInput: Packet | undefined;
    h.customize((packet) => {
      if (packet.method !== '_x.ai/interject' || packet.params.text !== 'Unconfirmed update') return false;
      rejectedInput = packet;
      if (failure === 'receipt-timeout') h.reply(packet, { result: { status: 'queued' } });
      return true;
    });
    const execution = executeGrokAcp(h.ctx, h.deps);
    // Observe rejection immediately, so the assertion reports early teardown instead of an unhandled rejection.
    let settled = false;
    void execution.then(
      () => (settled = true),
      () => (settled = true),
    );
    try {
      await h.ready();
      await h.steer!('Accepted update');
      h.notify('_x.ai/queue/changed', { entries: [], runningPromptId: 'surviving-native-fallback' });
      const delivery = h.steer!('Unconfirmed update');
      const rejection = assert.rejects(delivery, failure === 'rpc' ? /runtime-request-failed/ : /runtime-timeout/);
      await tick();
      assert.ok(rejectedInput);
      h.complete();
      await tick();
      if (failure === 'rpc')
        h.send({ id: rejectedInput.id, error: { code: -32000, message: 'Mock interjection was rejected' } });
      await rejection;
      await tick();
      assert.equal(settled, false, 'A delivery error belongs to that input, not the already running native turn.');
      assert.equal(h.terminated, 0);
      assert.equal(h.toolsEnded, 0, 'The live fallback must retain its bridge token.');
      assert.ok(h.steer);
      h.notify('session/update', {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'surviving-tool',
          kind: 'other',
          status: 'completed',
        },
      });
      h.notify('session/update', {
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fallback completed' } },
      });
      h.notify('_x.ai/session/update', {
        update: { type: 'turn_completed', promptId: 'surviving-native-fallback', stopReason: 'end_turn' },
      });
      assert.equal((await execution).output, 'Fallback completed');
      assert.equal(h.toolsEnded, 1);
      assert.equal(h.requests.filter((packet) => packet.method === 'session/prompt').length, 1);
      assert.ok(!h.requests.some((packet) => packet.method === 'session/cancel'));
    } finally {
      if (!settled) h.abort.abort();
      await execution.catch(() => undefined);
    }
  }
});

test('Grok ACP keeps accepted-steer transition waiting through the actor barrier and streams next-turn tools', async () => {
  const h = harness();
  let barrier: Packet | undefined,
    settled = false;
  h.customize((packet) => {
    if (packet.method !== '_x.ai/session/info' || !h.prompt) return false;
    barrier = packet;
    return true;
  });
  const execution = executeGrokAcp(h.ctx, h.deps);
  void execution.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await h.ready();
    const handler = h.steer!;
    await handler('Continue with the next tool step');
    h.notify('session/update', {
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Initial ' } },
    });
    const transitionAt = h.steeringStates.length;
    h.complete();
    await tick();
    assert.ok(barrier, 'Accepted input requires an actor barrier before native execution can drain.');
    assert.equal(h.steer, undefined, 'A completed turn cannot accept another interjection yet.');
    assert.equal(h.steeringStates.at(-1)?.state, 'waiting');
    assert.equal(h.terminated, 0);
    assert.equal(h.toolsEnded, 0, 'Waiting for the native next turn must not revoke its tools.');
    assert.equal(settled, false);
    const requestCount = h.requests.length;
    await assert.rejects(handler('Do not guess a native turn is running'), /runtime-process-closed/);
    assert.equal(h.requests.length, requestCount);
    h.notify('session/update', {
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'next-tool',
        kind: 'other',
        title: 'PugPort tool',
        status: 'in_progress',
      },
    });
    assert.ok(h.events.some((event) => event.type === 'tool' && event.data?.toolCallId === 'next-tool'));
    h.notify('_x.ai/queue/changed', { entries: [], runningPromptId: 'accepted-steer-next-turn' });
    assert.equal(h.steer, handler, 'Only native running evidence restores the input handler.');
    h.reply(barrier, { result: { sessionId: h.sessionId, agentName: 'comborunner-grok' } });
    await tick();
    assert.equal(settled, false);
    assert.ok(!h.steeringStates.slice(transitionAt).some((state) => state.state === 'finishing'));
    assert.equal(h.toolsEnded, 0);
    h.notify('session/update', {
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'next-tool', status: 'completed' },
    });
    h.notify('session/update', {
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'next turn' } },
    });
    h.notify('_x.ai/session/update', {
      update: { type: 'turn_completed', promptId: 'accepted-steer-next-turn', stopReason: 'end_turn' },
    });
    assert.equal((await execution).output, 'Initial next turn');
    assert.equal(h.toolsEnded, 1);
    assert.equal(h.steeringStates.at(-1)?.state, 'finishing');
    assert.equal(h.steer, undefined);
    assert.equal(h.events.filter((event) => event.type === 'tool' && event.data?.toolCallId === 'next-tool').length, 2);
    assert.equal(
      h.requests.filter((packet) => packet.method === 'session/prompt').length,
      1,
      'The continuation is a native same-session turn, not a second client prompt.',
    );
  } finally {
    if (!settled) h.abort.abort();
    await execution.catch(() => undefined);
  }
});

test('Grok ACP accepted-steer gap and next-turn failures finish only on cancellation or error', async () => {
  for (const mode of ['cancel-gap', 'error-gap', 'error-next-turn']) {
    const h = harness();
    let barrier: Packet | undefined,
      settled = false;
    h.customize((packet) => {
      if (packet.method !== '_x.ai/session/info' || !h.prompt) return false;
      barrier = packet;
      return true;
    });
    const execution = executeGrokAcp(h.ctx, h.deps);
    void execution.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await h.ready();
      const handler = h.steer!;
      await handler('Accepted before completion');
      h.complete();
      await tick();
      assert.ok(barrier);
      assert.equal(h.steeringStates.at(-1)?.state, 'waiting');
      assert.equal(h.terminated, 0);
      if (mode === 'cancel-gap') h.abort.abort();
      else if (mode === 'error-gap') h.send({ id: barrier.id, error: { code: -32000, message: 'Mock actor failure' } });
      else {
        h.notify('_x.ai/queue/changed', { entries: [], runningPromptId: 'error-native-followup' });
        h.reply(barrier, { result: { sessionId: h.sessionId, agentName: 'comborunner-grok' } });
        await tick();
        h.notify('session/update', {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'error-tool',
            kind: 'other',
            title: 'Next-turn tool',
            status: 'in_progress',
          },
        });
        assert.ok(h.events.some((event) => event.data?.toolCallId === 'error-tool'));
        h.notify('_x.ai/session/update', {
          update: {
            type: 'turn_completed',
            promptId: 'error-native-followup',
            stopReason: 'error',
            errorKind: 'mock',
            agentResult: 'Mock native failure',
          },
        });
      }
      await assert.rejects(execution, mode === 'cancel-gap' ? /operation-cancelled/ : /runtime-request-failed/);
      assert.equal(h.steeringStates.at(-1)?.state, 'finishing');
      assert.equal(h.steer, undefined);
      assert.ok(h.terminated > 0);
      assert.equal(
        h.requests.some((packet) => packet.method === 'session/cancel'),
        mode === 'cancel-gap',
      );
      const eventCount = h.events.length,
        stateCount = h.steeringStates.length;
      h.notify('_x.ai/queue/changed', { entries: [], runningPromptId: 'too-late' });
      h.notify('session/update', {
        update: { sessionUpdate: 'tool_call', toolCallId: 'after-terminal', status: 'pending' },
      });
      assert.equal(h.events.length, eventCount);
      assert.equal(h.steeringStates.length, stateCount);
      await assert.rejects(handler('Late input'), /runtime-process-closed/);
    } finally {
      if (!settled) h.abort.abort();
      await execution.catch(() => undefined);
    }
  }
});

test('Grok ACP closes a completed turn and restores input only after native fallback running evidence', async () => {
  const h = harness();
  const execution = executeGrokAcp(h.ctx, h.deps);
  await h.ready();
  const originalHandler = h.steer!;
  // An empty queue snapshot alone is not a final RPC or terminal signal.
  h.notify('_x.ai/queue/changed', { entries: [] });
  assert.equal(h.steer, originalHandler);
  h.notify('session/update', {
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Original' } },
  });
  h.notify('_x.ai/session/prompt_complete', { promptId: h.prompt!.params._meta.promptId, stopReason: 'end_turn' });
  assert.equal(h.steer, undefined);
  assert.equal(h.steeringStates.at(-1)?.state, 'waiting');
  const requestCount = h.requests.length;
  await assert.rejects(originalHandler('Too late without a native running turn'), /runtime-process-closed/);
  assert.equal(h.requests.length, requestCount);
  h.notify('_x.ai/queue/changed', { entries: [], runningPromptId: 'interject-fallback-native' });
  assert.equal(h.steer, originalHandler);
  assert.equal(h.steeringStates.at(-1)?.state, 'ready');
  h.complete();
  await tick();
  assert.equal(h.steer, originalHandler, 'Initial RPC completion must preserve the newer native running turn.');
  await originalHandler('A second message');
  h.notify('_x.ai/session/update', {
    update: { type: 'turn_completed', promptId: 'interject-fallback-native', stopReason: 'end_turn' },
  });
  assert.equal((await execution).output, 'Original');
  assert.equal(h.steer, undefined);
  assert.equal(h.requests.filter((packet) => packet.method === 'session/new').length, 1);
  assert.equal(h.requests.filter((packet) => packet.method === 'session/prompt').length, 1);
});

test('Grok ACP matches native receipt session, nonce and source text before acknowledging delivery', async () => {
  const h = harness();
  let submitted: Packet | undefined;
  h.customize((packet) => {
    if (packet.method !== '_x.ai/interject' || !packet.params.sessionId) return false;
    submitted = packet;
    h.reply(packet, { result: { status: 'queued' } });
    return true;
  });
  const execution = executeGrokAcp(h.ctx, h.deps);
  await h.ready();
  let delivered = false;
  const submission = h.steer!('Exact submitted text').then(() => {
    delivered = true;
  });
  await tick();
  assert.ok(submitted);
  h.send({
    method: '_x.ai/session/interjection',
    params: {
      sessionId: 'another-session',
      interjectionId: submitted.params.interjectionId,
      text: submitted.params.text,
    },
  });
  h.notify('_x.ai/session/interjection', { interjectionId: 'another-nonce', text: submitted.params.text });
  h.notify('_x.ai/session/interjection', {
    interjectionId: submitted.params.interjectionId,
    text: 'Another source text',
  });
  await tick();
  assert.equal(delivered, false);
  h.notify('_x.ai/session/interjection', {
    interjectionId: submitted.params.interjectionId,
    text: submitted.params.text,
  });
  await submission;
  assert.equal(delivered, true);
  h.notify('session/update', {
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done' } },
  });
  h.complete();
  await execution;
});

test('Grok ACP drains late fallback submissions through receipts and the native actor without a client restart', async () => {
  const h = harness();
  const execution = executeGrokAcp(h.ctx, h.deps);
  await h.ready();
  h.notify('session/update', {
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'First ' } },
  });
  h.notify('_x.ai/queue/changed', { entries: [], runningPromptId: 'interject-fallback-first' });
  h.complete();
  await tick();
  let submitted: Packet | undefined;
  let barrier: Packet | undefined;
  h.customize((packet) => {
    if (packet.method === '_x.ai/interject' && packet.params.sessionId) {
      submitted = packet;
      h.reply(packet, { result: { status: 'queued' } });
      return true;
    }
    if (packet.method === '_x.ai/session/info') {
      barrier = packet;
      return true;
    }
    return false;
  });
  const submission = h.steer!('At the end of the fallback');
  await tick();
  h.notify('_x.ai/session/update', {
    update: { type: 'turn_completed', promptId: 'interject-fallback-first', stopReason: 'end_turn' },
  });
  assert.equal(h.steer, undefined);
  assert.equal(h.steeringStates.at(-1)?.state, 'waiting');
  await tick();
  assert.equal(h.terminated, 0, 'A queued request without its matching native receipt is still pending.');
  h.notify('_x.ai/session/interjection', {
    interjectionId: submitted!.params.interjectionId,
    text: submitted!.params.text,
  });
  await tick();
  assert.ok(barrier);
  assert.equal(h.terminated, 0, 'The actor barrier must expose a native fallback before the request drains.');
  h.notify('_x.ai/queue/changed', { entries: [], runningPromptId: 'interject-fallback-second' });
  assert.ok(h.steer);
  assert.equal(h.steeringStates.at(-1)?.state, 'ready');
  h.reply(barrier, { result: { sessionId: h.sessionId, agentName: 'comborunner-grok' } });
  await submission;
  assert.equal(h.terminated, 0);
  h.notify('session/update', {
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'second' } },
  });
  h.notify('_x.ai/session/update', {
    update: { type: 'turn_completed', promptId: 'interject-fallback-second', stopReason: 'end_turn' },
  });
  assert.equal((await execution).output, 'First second');
  assert.equal(h.requests.filter((packet) => packet.method === 'session/new').length, 1);
  assert.equal(h.requests.filter((packet) => packet.method === 'session/prompt').length, 1);
  assert.ok(!h.requests.some((packet) => packet.method === 'session/cancel'));
});

test('Grok ACP capability probe stops before creating a session on unsupported CLI', async () => {
  const h = harness();
  h.customize((packet) => {
    if (packet.method !== '_x.ai/interject') return false;
    h.send({ id: packet.id, error: { code: -32601, message: 'Method not found' } });
    return true;
  });
  await assert.rejects(executeGrokAcp(h.ctx, h.deps), GrokAcpUnsupported);
  assert.ok(!h.requests.some((packet) => ['authenticate', 'session/new', 'session/prompt'].includes(packet.method)));
  assert.equal(h.steer, undefined);
  assert.equal(h.terminated, 1);
});

test('Grok ACP announces finishing before awaiting cleanup after initialize is rejected', async () => {
  const h = harness();
  h.customize((packet) => {
    if (packet.method !== 'initialize') return false;
    h.send({ id: packet.id, error: { code: -32000, message: 'Mock initialize failure' } });
    return true;
  });
  let cleanupStarted!: () => void, finishCleanup!: () => void;
  const cleanupEntered = new Promise<void>((resolve) => (cleanupStarted = resolve));
  const cleanup = new Promise<void>((resolve) => (finishCleanup = resolve));
  let stateAtTerminate: string | undefined,
    completed = false;
  const execution = executeGrokAcp(h.ctx, {
    ...h.deps,
    terminate: async () => {
      stateAtTerminate = h.steeringStates.at(-1)?.state;
      cleanupStarted();
      await cleanup;
    },
  });
  const rejected = assert.rejects(execution, /runtime-request-failed/).then(() => (completed = true));
  try {
    await cleanupEntered;
    assert.equal(stateAtTerminate, 'finishing');
    assert.equal(h.steer, undefined);
    assert.equal(completed, false, 'the execution is still awaiting process cleanup');
    assert.equal(h.ctx.signal.aborted, false, 'finishing does not cancel the native run signal');
    assert.ok(!h.requests.some((packet) => ['session/new', 'session/prompt'].includes(packet.method)));
  } finally {
    finishCleanup();
    await rejected;
  }
});

test('Grok ACP also announces finishing when spawning fails before listeners exist', async () => {
  const h = harness();
  await assert.rejects(
    executeGrokAcp(h.ctx, {
      ...h.deps,
      spawn: async () => {
        throw new Error('Mock spawn failure');
      },
    }),
    /Mock spawn failure/,
  );
  assert.equal(h.steeringStates.at(-1)?.state, 'finishing');
  assert.equal(h.terminated, 0);
});

test('Grok ACP cancellation and EOF reject the live prompt and unregister input', async () => {
  for (const mode of ['cancel', 'eof', 'close']) {
    const h = harness();
    const execution = executeGrokAcp(h.ctx, h.deps);
    await h.ready();
    if (mode === 'cancel') h.abort.abort();
    else if (mode === 'eof') (h.child.stdout as PassThrough).end();
    else h.child.emit('close', 1);
    await assert.rejects(execution, mode === 'cancel' ? /operation-cancelled/ : /runtime-process-closed/);
    assert.equal(h.steer, undefined);
    if (mode === 'cancel') assert.ok(h.requests.some((packet) => packet.method === 'session/cancel'));
  }
});

test('Grok ACP usage treats missing/partial cost and cache data as unknown', () => {
  const partial = grokAcpUsage({
    inputTokens: 12,
    cachedReadTokens: 4,
    cacheCreationTokens: 2,
    outputTokens: 3,
    costUsdTicks: 90,
    costIsPartial: true,
  });
  assert.equal(partial?.inputTokens, 6);
  assert.equal(partial?.costUsd, undefined);
  assert.equal(partial?.incomplete, true);
  const missingCache = grokAcpUsage({ inputTokens: 12, outputTokens: 3 });
  assert.equal(missingCache?.inputTokens, undefined);
  assert.equal(missingCache?.incomplete, true);
  assert.equal(grokAcpUsage({}), undefined);
});

test('Grok ACP reports native mutation permission denials without treating failed reads as a blocked task', async () => {
  const h = harness();
  h.ctx.input.permissionMode = 'workspace-write';
  const execution = executeGrokAcp(h.ctx, h.deps);
  await h.ready();
  h.notify('session/update', {
    update: { sessionUpdate: 'tool_call', toolCallId: 'read-1', kind: 'read', title: 'Read missing file' },
  });
  h.notify('session/update', {
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'read-1',
      status: 'failed',
      rawOutput: { error: 'tool_execution_failed', message: 'Permission denied' },
    },
  });
  h.notify('session/update', {
    update: { sessionUpdate: 'tool_call', toolCallId: 'bash-1', kind: 'execute', title: 'Move files' },
  });
  h.notify('session/update', {
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'bash-1',
      status: 'failed',
      content: [
        {
          type: 'content',
          content: { type: 'text', text: 'denied by prompt policy (tool not pre-approved) for tool `Bash`' },
        },
      ],
    },
  });
  h.notify('session/update', {
    update: { sessionUpdate: 'tool_call', toolCallId: 'edit-1', kind: 'edit', title: 'Edit file' },
  });
  h.send({
    id: 'permission-1',
    method: 'session/request_permission',
    params: {
      sessionId: h.sessionId,
      toolCall: { toolCallId: 'edit-1' },
      options: [
        { kind: 'allow_once', optionId: 'yes' },
        { kind: 'reject_always', optionId: 'persist-no' },
      ],
    },
  });
  const editReason = 'User rejected the execution for tool `Edit`';
  const editFailure = {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'edit-1',
    status: 'failed',
    content: [{ type: 'content', content: { type: 'text', text: editReason } }],
  };
  h.notify('session/update', { update: editFailure });
  h.notify('session/update', { update: editFailure });
  for (let retry = 0; retry < 3; retry++)
    h.notify('session/update', {
      update: {
        ...editFailure,
        content: [{ type: 'content', content: { type: 'text', text: `${editReason}; retry ${retry}` } }],
      },
    });
  const blocked = h.events.filter((event) => event.data?.executionBlocked);
  assert.deepEqual(
    blocked.map((event) => event.data?.toolCallId),
    ['bash-1', 'edit-1', 'edit-1'],
  );
  assert.ok(blocked.every((event) => event.type === 'error' && event.data?.reason === 'permission'));
  const editBlocks = blocked.filter((event) => event.data?.toolCallId === 'edit-1');
  assert.equal(editBlocks[0]?.data?.detail, undefined);
  assert.equal(editBlocks[0]?.data?.deniedBy, 'host');
  assert.equal(editBlocks[0]?.data?.nativeMethod, 'session/request_permission');
  assert.match(editBlocks[0]?.text ?? '', /^PugPort 拒绝/);
  assert.equal(editBlocks[1]?.data?.deniedBy, 'host');
  assert.equal(editBlocks[1]?.data?.detail, editReason);
  assert.ok(editBlocks[1]?.text?.includes(editReason));
  assert.deepEqual(h.requests.find((packet) => packet.id === 'permission-1')?.result, {
    outcome: { outcome: 'cancelled' },
  });
  h.notify('session/update', {
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Blocked' } },
  });
  h.complete();
  await execution;
});

test('Grok ACP keeps the native auto denial reason from both failed-tool diagnostic formats', async () => {
  const reason =
    'Tool `run_terminal_command` was not executed: Auto mode blocked this action (The current request is only to review the collection; moving files to a backup folder is an unrequested destructive step). Take a safer approach and continue the review.';
  for (const source of ['rawOutput', 'content']) {
    const h = harness();
    h.ctx.input.permissionMode = 'workspace-write';
    const execution = executeGrokAcp(h.ctx, h.deps);
    await h.ready();
    h.notify('session/update', {
      update: { sessionUpdate: 'tool_call', toolCallId: 'cleanup', kind: 'execute', title: 'Remove build artifacts' },
    });
    const update = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'cleanup',
      status: 'failed',
      ...(source === 'rawOutput'
        ? { rawOutput: { error: 'tool_execution_failed', message: reason } }
        : { content: [{ type: 'content', content: { type: 'text', text: reason } }] }),
    };
    h.notify('session/update', { update });
    h.notify('session/update', { update });
    const failed = h.events.find((event) => event.type === 'tool' && event.data?.status === 'failed');
    assert.equal(failed?.data?.detail, reason);
    const blocked = h.events.filter((event) => event.data?.executionBlocked);
    assert.equal(blocked.length, 1, 'Repeated native updates must not produce duplicate permission blocks.');
    assert.equal(blocked[0]?.type, 'error');
    assert.equal(blocked[0]?.data?.reason, 'permission');
    assert.equal(blocked[0]?.data?.toolCallId, 'cleanup');
    assert.equal(blocked[0]?.data?.detail, reason);
    assert.ok(blocked[0]?.text?.includes(reason));
    assert.ok(!h.requests.some((packet) => packet.method === 'session/cancel'));
    h.notify('session/update', {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Review complete; cleanup blocked.' },
      },
    });
    h.complete();
    assert.equal((await execution).output, 'Review complete; cleanup blocked.');
  }
});

test('Grok ACP preserves a native permission reason carried by the request before a cancelled turn', async () => {
  const h = harness();
  h.ctx.input.permissionMode = 'workspace-write';
  const reason = 'Auto mode blocked this action (the user requested a comparison, not deleting a directory).';
  const execution = executeGrokAcp(h.ctx, h.deps);
  void execution.catch(() => undefined);
  await h.ready();
  h.send({
    id: 'permission-with-reason',
    method: 'session/request_permission',
    params: {
      sessionId: h.sessionId,
      toolCall: {
        toolCallId: 'native-delete',
        kind: 'execute',
        title: 'Bash',
        rawOutput: { message: reason },
      },
      options: [
        { kind: 'allow_once', optionId: 'yes' },
        { kind: 'reject_once', optionId: 'no' },
      ],
    },
  });
  await tick();
  h.complete({ stopReason: 'cancelled' });
  await tick();
  assert.equal(h.requests.filter((packet) => packet.method === 'session/prompt').length, 2);
  h.notify('session/update', {
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Completed another way.' } },
  });
  h.complete();
  await execution;
  assert.equal(h.events.find((event) => event.data?.executionBlocked)?.data?.detail, reason);
  assert.equal(h.events.find((event) => event.data?.executionBlocked)?.data?.toolCallId, 'native-delete');
  assert.equal(
    h.events.find((event) => event.data?.executionBlocked)?.data?.nativeMethod,
    'session/request_permission',
  );
  assert.deepEqual(h.requests.find((packet) => packet.id === 'permission-with-reason')?.result, {
    outcome: { outcome: 'selected', optionId: 'no' },
  });
});

test('Grok ACP retains ordinary terminal failures without marking the native permission layer blocked', async () => {
  const h = harness();
  h.ctx.input.permissionMode = 'workspace-write';
  const execution = executeGrokAcp(h.ctx, h.deps);
  await h.ready();
  const reason = 'Command exited with code 2: unexpected token near `)`';
  h.notify('session/update', {
    update: { sessionUpdate: 'tool_call', toolCallId: 'terminal', kind: 'execute', title: 'Run verification' },
  });
  h.notify('session/update', {
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'terminal',
      status: 'failed',
      rawOutput: { error: 'tool_execution_failed', message: reason, privateField: 'never-copy-the-output-object' },
    },
  });
  const failed = h.events.find((event) => event.type === 'tool' && event.data?.status === 'failed');
  assert.equal(failed?.data?.detail, reason);
  assert.ok(!h.events.some((event) => event.data?.executionBlocked || event.data?.reason === 'permission'));
  assert.ok(!JSON.stringify(h.events).includes('never-copy-the-output-object'));
  h.notify('session/update', {
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'The verification command failed.' },
    },
  });
  h.complete();
  await execution;
});

test('Grok ACP saves bounded redacted permission diagnostics and prioritizes the concrete native reason', async () => {
  const h = harness();
  const execution = executeGrokAcp(h.ctx, h.deps);
  await h.ready();
  const reason =
    '\u001b[31mAuto mode blocked this action (unrequested destructive step)\u001b[0m ' +
    'api_key="quoted api credential" token=private-token password=\'password with spaces\' ' +
    'Authorization: Bearer bearer-credential xai-native-api-credential ' +
    'https://username:url-password@example.invalid/action?secret=query-credential ' +
    '\u202e' +
    'native explanation '.repeat(300);
  h.notify('session/update', {
    update: { sessionUpdate: 'tool_call', toolCallId: 'delete', kind: 'delete', title: 'Delete generated file' },
  });
  h.notify('session/update', {
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'delete',
      status: 'failed',
      rawOutput: { message: 'Earlier execution log '.repeat(300), secret: 'unrelated-private-field' },
      content: [{ type: 'content', content: { type: 'text', text: reason } }],
    },
  });
  const failed = h.events.find((event) => event.type === 'tool' && event.data?.status === 'failed');
  const blocked = h.events.find((event) => event.data?.executionBlocked);
  const detail = String(failed?.data?.detail);
  assert.ok(detail.startsWith('Auto mode blocked this action (unrequested destructive step)'));
  assert.ok(detail.includes('[redacted]'));
  assert.ok(detail.includes('[redacted URL]'));
  assert.equal(detail.length, 1200);
  assert.equal(blocked?.data?.detail, detail);
  assert.ok(blocked?.text?.includes(detail));
  assert.doesNotMatch(
    JSON.stringify(h.events),
    /quoted api credential|private-token|password with spaces|bearer-credential|xai-native-api-credential|url-password|query-credential|unrelated-private-field|\u001b|\u202e/,
  );
  h.notify('session/update', {
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Blocked.' } },
  });
  h.complete();
  await execution;
});

test('tool diagnostics redact quoted credential values before truncating and remove terminal formatting', () => {
  const detail = redactToolDiagnostic(
    '\u001b]8;;https://private.invalid/\u001b\\Visible reason\u001b]8;;\u001b\\ ' +
      '"apiKey": "credential that spans the cut boundary"; ' +
      "'refresh_token'='refresh credential'; password=unquoted-password; Authorization: Basic basic-credential; " +
      'eyJheader.payload.signature https://example.invalid/?token=url-credential',
    220,
  );
  assert.ok(detail.startsWith('Visible reason'));
  assert.ok(detail.includes('[redacted]'));
  assert.ok(detail.length <= 220);
  assert.doesNotMatch(
    detail,
    /credential that|refresh credential|unquoted-password|basic-credential|eyJheader|url-credential|\u001b/,
  );
  assert.equal(redactToolDiagnostic('password="credential across limit"', 18), 'password=[redacte…');
  assert.equal(redactToolDiagnostic('Any diagnostic', 0), '');
});

test('Grok ACP stops before a prompt when native strict harness discarded the selected tool policy', async () => {
  const h = harness();
  h.customize((packet) => {
    if (packet.method !== '_x.ai/session/info') return false;
    h.reply(packet, { result: { sessionId: h.sessionId, agentName: 'another-model-harness' } });
    return true;
  });
  await assert.rejects(createGrokAdapter(h.deps).execute(h.ctx), /runtime-permission-policy-unverified/);
  assert.equal(h.requests.filter((packet) => packet.method === 'session/new').length, 1);
  assert.ok(!h.requests.some((packet) => packet.method === 'session/prompt'));
  assert.equal(h.steer, undefined);
  assert.equal(h.terminated, 1);
});

test('a rejected Grok session/load is native-session-unavailable before tools or prompts', async () => {
  const h = harness();
  h.ctx.nativeSessionId = 'missing-session';
  h.customize((packet) => {
    if (packet.method !== 'session/load') return false;
    h.send({ id: packet.id, error: { code: -32602, message: 'Synthetic session missing' } });
    return true;
  });
  await assert.rejects(executeGrokAcp(h.ctx, h.deps), /native-session-unavailable/);
  assert.ok(!h.requests.some((packet) => packet.method === 'session/prompt' || packet.method === 'session/new'));
  assert.ok(!h.events.some((event) => event.type === 'tool' || event.type === 'text'));
});

async function refusePrompt(h: ReturnType<typeof harness>, id: string, command = 'Remove-Item outside-project') {
  h.send({
    id,
    method: 'session/request_permission',
    params: {
      sessionId: h.sessionId,
      toolCall: { toolCallId: id, kind: 'execute', title: 'Bash', rawInput: { command } },
      options: [
        { kind: 'allow_once', optionId: 'yes' },
        { kind: 'reject_once', optionId: 'no' },
      ],
    },
  });
  await tick();
  assert.deepEqual(h.requests.find((packet) => packet.id === id)?.result, {
    outcome: { outcome: 'selected', optionId: 'no' },
  });
  h.complete({ stopReason: 'cancelled' });
  await tick();
}

test('Grok ACP continues a refused writable turn once in the same session with bounded redacted host guidance', async () => {
  const h = harness();
  h.ctx.input.permissionMode = 'workspace-write';
  const execution = executeGrokAcp(h.ctx, h.deps);
  void execution.catch(() => undefined);
  await h.ready();
  await refusePrompt(h, 'outside-1', `Remove-Item outside-project; token=PRIVATE_SECRET; ${'x'.repeat(1800)}`);
  const prompts = h.requests.filter((packet) => packet.method === 'session/prompt');
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1].params.sessionId, prompts[0].params.sessionId);
  assert.notEqual(prompts[1].params._meta.promptId, prompts[0].params._meta.promptId);
  assert.equal(prompts[1].params.prompt.length, 1);
  const guidance = prompts[1].params.prompt[0].text as string;
  assert.match(guidance, /上一条操作超出了本任务的写入范围/);
  assert.ok(guidance.includes(h.ctx.input.projectPath));
  assert.match(guidance, /Remove-Item outside-project/);
  assert.match(guidance, /不要再试这条/);
  assert.ok(!guidance.includes('PRIVATE_SECRET'));
  assert.ok(guidance.length < h.ctx.input.projectPath.length + 1600);
  h.notify('session/update', {
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Completed another way.' } },
  });
  h.complete();
  assert.equal((await execution).output, 'Completed another way.');
  assert.equal(h.requests.filter((packet) => packet.method === 'session/new').length, 1);
  assert.equal(h.events.filter((event) => event.data?.kind === 'permission-refusal-continuation').length, 1);
  assert.equal(h.events.filter((event) => event.data?.executionBlocked).length, 1);
});

test('Grok ACP stops on the third refused writable turn after exactly two host continuations', async () => {
  const h = harness();
  h.ctx.input.permissionMode = 'workspace-write';
  const execution = executeGrokAcp(h.ctx, h.deps);
  void execution.catch(() => undefined);
  await h.ready();
  for (let index = 0; index < 3; index++) {
    await refusePrompt(h, `outside-${index}`);
    if (h.requests.filter((packet) => packet.method === 'session/prompt').length <= index + 1) break;
  }
  await assert.rejects(execution, /runtime-permission-or-sandbox-error/);
  assert.equal(h.requests.filter((packet) => packet.method === 'session/prompt').length, 3);
  assert.equal(h.events.filter((event) => event.data?.kind === 'permission-refusal-continuation').length, 2);
});

for (const restriction of ['read-only', 'untrusted', 'prohibitCommands'] as const)
  test(`Grok ACP does not continue a refused ${restriction} turn`, async () => {
    const h = harness();
    h.ctx.input.permissionMode = restriction === 'read-only' ? 'read-only' : 'workspace-write';
    h.ctx.input.untrustedContent = restriction === 'untrusted';
    h.ctx.input.prohibitCommands = restriction === 'prohibitCommands';
    const execution = executeGrokAcp(h.ctx, h.deps);
    void execution.catch(() => undefined);
    await h.ready();
    await refusePrompt(h, 'outside-guard');
    await assert.rejects(execution, /runtime-permission-or-sandbox-error/);
    assert.equal(h.requests.filter((packet) => packet.method === 'session/prompt').length, 1);
    assert.equal(h.events.filter((event) => event.data?.kind === 'permission-refusal-continuation').length, 0);
  });

test('Grok ACP does not mistake a later user cancellation for the previous recovered refusal', async () => {
  const h = harness();
  h.ctx.input.permissionMode = 'workspace-write';
  const execution = executeGrokAcp(h.ctx, h.deps);
  void execution.catch(() => undefined);
  await h.ready();
  await refusePrompt(h, 'outside-once');
  assert.equal(h.requests.filter((packet) => packet.method === 'session/prompt').length, 2);
  h.complete({ stopReason: 'cancelled', _meta: { cancelTrigger: 'user' } });
  await assert.rejects(execution, /operation-cancelled/);
  assert.equal(h.requests.filter((packet) => packet.method === 'session/prompt').length, 2);
});

test('Grok ACP correlates refusal continuations without native running notifications', async () => {
  const h = harness();
  h.ctx.input.permissionMode = 'workspace-write';
  let pendingPrompt: Packet | undefined;
  let attempts = 0;
  h.customize((packet) => {
    if (packet.method === 'session/prompt') {
      pendingPrompt = packet;
      h.send({
        id: `silent-refusal-${++attempts}`,
        method: 'session/request_permission',
        params: {
          sessionId: h.sessionId,
          toolCall: { toolCallId: `silent-tool-${attempts}`, kind: 'execute', title: 'Outside command' },
          options: [{ kind: 'reject_once', optionId: 'no' }],
        },
      });
      return true;
    }
    if (typeof packet.id === 'string' && packet.id.startsWith('silent-refusal-')) {
      assert.deepEqual(packet.result, { outcome: { outcome: 'selected', optionId: 'no' } });
      h.reply(pendingPrompt!, { stopReason: 'cancelled' });
      return true;
    }
    return false;
  });
  await assert.rejects(executeGrokAcp(h.ctx, h.deps), /runtime-permission-or-sandbox-error/);
  assert.equal(attempts, 3);
  assert.equal(h.events.filter((event) => event.data?.kind === 'permission-refusal-continuation').length, 2);
});

test('Grok reports the native source of a policy denial', async () => {
  const h = harness();
  h.ctx.input.permissionMode = 'workspace-write';
  const execution = executeGrokAcp(h.ctx, h.deps);
  await h.ready();
  h.notify('session/update', {
    update: { sessionUpdate: 'tool_call', toolCallId: 'denied', kind: 'execute', title: 'command' },
  });
  h.notify('session/update', {
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'denied',
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: 'auto mode blocked this action' } }],
    },
  });
  await tick();
  h.notify('session/update', {
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done' } },
  });
  h.complete();
  await execution;
  const denied = h.events.find((event) => event.type === 'error' && event.data?.deniedBy === 'native');
  assert.match(denied?.text ?? '', /^Grok 原生权限策略/);
  assert.match(String(denied?.data?.detail), /^auto mode blocked this action/);
  assert.ok(!h.events.some((event) => event.data?.kind === 'permission-refusal-continuation'));
});
