import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ExecuteContext, RunEvent, RuntimeTarget } from '../src/shared/types.js';
import { executeGrokAcp } from '../src/server/adapters/grok-acp.js';

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

// Grok merges pending plain-text sendNow prompts; the follower receives
// removedFromQueue without an interjection echo, while its text still runs.
for (const rpcFirst of [true, false]) {
  for (const identicalText of [false, true]) {
    test(
      'combined send-now keeps the accepted head alive: RPC first=' + rpcFirst + ', identical=' + identicalText,
      async () => {
        const h = harness();
        const execution = executeGrokAcp(h.ctx, h.deps);
        let settled = false;
        void execution.then(
          () => (settled = true),
          () => (settled = true),
        );
        try {
          await h.ready();
          const first = h.steer!('Use the narrow folder', { id: 'combined-a', mode: 'interrupt' });
          const second = h.steer!(identicalText ? 'Use the narrow folder' : 'Keep existing output', {
            id: 'combined-b',
            mode: 'interrupt',
          });
          const a = h.requests.find((packet) => packet.params?._meta?.promptId === 'combined-a')!;
          const b = h.requests.find((packet) => packet.params?._meta?.promptId === 'combined-b')!;
          h.notify('_x.ai/queue/changed', {
            runningPromptId: h.prompt!.params._meta.promptId,
            entries: [{ id: 'combined-a' }, { id: 'combined-b' }],
          });
          await Promise.all([first, second]);
          h.complete({ stopReason: 'cancelled', _meta: { cancelTrigger: 'send_now' } });
          const removed = () => h.reply(b, { stopReason: 'cancelled', _meta: { completionKind: 'removedFromQueue' } });
          const promoting = () =>
            h.notify('_x.ai/queue/changed', {
              entries: [],
              runningPromptId: 'combined-a',
              runningCombinedTexts: [a.params.prompt[0].text, b.params.prompt[0].text],
            });
          if (rpcFirst) {
            removed();
            await tick();
            promoting();
          } else {
            promoting();
            await tick();
            removed();
          }
          await tick();
          assert.equal(settled, false, 'Merging a follower is not an execution failure.');
          assert.equal(h.terminated, 0);
          assert.equal(h.toolsEnded, 0, 'The combined running turn still needs its PugPort tools.');
          assert.ok(h.steer, 'More corrections can reach the combined running turn.');
          h.notify('session/update', {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Both corrections applied.' },
            },
          });
          h.reply(a, { stopReason: 'end_turn' });
          h.notify('_x.ai/queue/changed', { entries: [] });
          assert.equal((await execution).output, 'Both corrections applied.');
        } finally {
          if (!settled) h.abort.abort();
          await execution.catch(() => undefined);
        }
      },
    );
  }
}

for (const invalidEvidence of ['none', 'other-session', 'unknown-head', 'missing-follower-text']) {
  test('removed send-now does not invent delivery from invalid combined evidence: ' + invalidEvidence, async () => {
    const h = harness();
    h.deps.timeoutMs = 500;
    const execution = executeGrokAcp(h.ctx, h.deps);
    const rejected = assert.rejects(execution, /runtime-steer-not-confirmed|runtime-timeout/);
    await h.ready();
    const first = h.steer!('First exact instruction', { id: 'verified-a', mode: 'interrupt' });
    const second = h.steer!('Second exact instruction', { id: 'verified-b', mode: 'interrupt' });
    const a = h.requests.find((packet) => packet.params?._meta?.promptId === 'verified-a')!;
    const b = h.requests.find((packet) => packet.params?._meta?.promptId === 'verified-b')!;
    h.notify('_x.ai/queue/changed', {
      runningPromptId: h.prompt!.params._meta.promptId,
      entries: [{ id: 'verified-a' }, { id: 'verified-b' }],
    });
    await Promise.all([first, second]);
    h.complete({ stopReason: 'cancelled', _meta: { cancelTrigger: 'send_now' } });
    if (invalidEvidence !== 'none')
      h.notify('_x.ai/queue/changed', {
        ...(invalidEvidence === 'other-session' ? { sessionId: 'unrelated-session' } : {}),
        entries: [],
        runningPromptId: invalidEvidence === 'unknown-head' ? 'unrelated-prompt' : 'verified-a',
        runningCombinedTexts: [
          a.params.prompt[0].text,
          invalidEvidence === 'missing-follower-text' ? 'unrelated text' : b.params.prompt[0].text,
        ],
      });
    h.reply(b, { stopReason: 'cancelled', _meta: { completionKind: 'removedFromQueue' } });
    await rejected;
    assert.ok(
      !h.events.some((event) => event.data?.steeringPhase === 'resuming' && event.data?.steeringId === 'verified-b'),
    );
  });
}

test('a later queued correction cannot claim an earlier identical combined segment', async () => {
  const h = harness();
  const execution = executeGrokAcp(h.ctx, h.deps);
  let settled = false;
  void execution.then(
    () => (settled = true),
    () => (settled = true),
  );
  try {
    await h.ready();
    const first = h.steer!('First scope', { id: 'old-head', mode: 'interrupt' });
    const second = h.steer!('Keep existing output', { id: 'old-follower', mode: 'interrupt' });
    const a = h.requests.find((packet) => packet.params?._meta?.promptId === 'old-head')!;
    const b = h.requests.find((packet) => packet.params?._meta?.promptId === 'old-follower')!;
    h.notify('_x.ai/queue/changed', {
      runningPromptId: h.prompt!.params._meta.promptId,
      entries: [{ id: 'old-head' }, { id: 'old-follower' }],
    });
    await Promise.all([first, second]);
    h.complete({ stopReason: 'cancelled', _meta: { cancelTrigger: 'send_now' } });
    h.reply(b, { stopReason: 'cancelled', _meta: { completionKind: 'removedFromQueue' } });
    const combinedTexts = [a.params.prompt[0].text, b.params.prompt[0].text];
    h.notify('_x.ai/queue/changed', { runningPromptId: 'old-head', entries: [], runningCombinedTexts: combinedTexts });
    await tick();
    const third = h.steer!('Keep existing output', { id: 'new-same-text', mode: 'interrupt' });
    const c = h.requests.find((packet) => packet.params?._meta?.promptId === 'new-same-text')!;
    h.notify('_x.ai/queue/changed', {
      runningPromptId: 'old-head',
      entries: [{ id: 'new-same-text' }],
      runningCombinedTexts: combinedTexts,
    });
    await third;
    assert.ok(
      !h.events.some((event) => event.data?.steeringPhase === 'resuming' && event.data?.steeringId === 'new-same-text'),
      'The native queue still lists the third correction as waiting.',
    );
    h.reply(a, { stopReason: 'cancelled', _meta: { cancelTrigger: 'send_now' } });
    h.notify('_x.ai/queue/changed', { runningPromptId: 'new-same-text', entries: [] });
    h.notify('session/update', {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Third correction now applied.' },
      },
    });
    h.reply(c, { stopReason: 'end_turn' });
    h.notify('_x.ai/queue/changed', { entries: [] });
    assert.equal((await execution).output, 'Third correction now applied.');
  } finally {
    if (!settled) h.abort.abort();
    await execution.catch(() => undefined);
  }
});

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
