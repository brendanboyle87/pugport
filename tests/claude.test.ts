import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextFromEvent } from '../src/shared/context-usage.ts';
import { quotaReadingPending } from '../src/shared/quota-summary.ts';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactError } from '../src/server/adapters/process.ts';
import { ExternalTasks } from '../src/server/external-tasks.ts';
import { collectReturnFiles } from '../src/server/node/peer-files.ts';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ApprovalKey, ExecuteContext, RunEvent, RunRecord, RuntimeTarget } from '../src/shared/types.js';
import { TaskContinuationProgress, hasContinuationProgress } from '../src/server/task-continuation.js';
import { IdleNativeSessionSlot } from '../src/server/idle-native-session.ts';
import {
  claudeModels,
  claudeQuota,
  claudeExecutionArgs,
  claudeSecretRule,
  claudeUserContent,
  createClaudeAdapter,
  claudeAuthentication,
  claudeResultUsage,
  claudeAccountFingerprint,
} from '../src/server/adapters/claude.js';

test('Claude secret rules normalize absolute paths and reject globs', () => {
  assert.equal(claudeSecretRule('C:\\Users\\Example\\secrets'), 'Edit(//c/Users/Example/secrets/**)');
  assert.equal(claudeSecretRule('/home/example/secrets'), 'Edit(//home/example/secrets/**)');
  assert.equal(claudeSecretRule('/home/example/[unsafe]'), undefined);
});

test('Claude denies default and custom skill and plugin roots', () => {
  const oldClaude = process.env.CLAUDE_CONFIG_DIR;
  const oldCodex = process.env.CODEX_HOME;
  const customClaude = join(tmpdir(), 'synthetic-claude');
  const customCodex = join(tmpdir(), 'synthetic-codex');
  process.env.CLAUDE_CONFIG_DIR = customClaude;
  process.env.CODEX_HOME = customCodex;
  try {
    const args = claudeExecutionArgs(context());
    const deny = JSON.parse(args[args.indexOf('--settings') + 1]!).permissions.deny as string[];
    assert.ok(deny.includes('Edit(~/.claude/skills/**)'));
    assert.ok(deny.includes('Edit(~/.claude/plugins/**)'));
    for (const folder of [join(customClaude, 'skills'), join(customClaude, 'plugins'), customCodex])
      assert.ok(deny.includes(claudeSecretRule(folder)!));
  } finally {
    if (oldClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = oldClaude;
    if (oldCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodex;
  }
});

test('Claude card settings cannot override the generated deny rules', async () => {
  const ctx = context({ target: { ...target, args: ['--settings', 'fixture.json', '--verbose'] } });
  const adapter = createClaudeAdapter({
    spawn: async (actual, args) => {
      assert.deepEqual(actual.args, ['--verbose']);
      assert.equal(args.filter((arg) => arg === '--settings').length, 1);
      assert.ok(JSON.parse(args[args.indexOf('--settings') + 1]!).permissions.deny.includes('Edit(~/.ssh/**)'));
      throw new Error('Synthetic spawn stopped');
    },
  });
  await assert.rejects(adapter.execute(ctx), /Synthetic spawn stopped/);
});

const target: RuntimeTarget = {
  id: 'test-claude',
  provider: 'claude',
  label: 'Claude test',
  command: 'fixture',
  environment: 'native',
  enabled: true,
};
function fakeChild(onPacket: (packet: Record<string, unknown>, send: (packet: unknown) => void) => void) {
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 999999,
    exitCode: null as number | null,
    signalCode: null,
  });
  const send = (packet: unknown) => child.stdout.write(`${JSON.stringify(packet)}\n`);
  let buffer = '';
  child.stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let split: number;
    while ((split = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, split);
      buffer = buffer.slice(split + 1);
      if (line) onPacket(JSON.parse(line) as Record<string, unknown>, send);
    }
  });
  child.stdin.on('finish', () => {
    child.exitCode = 0;
    child.emit('close', 0);
  });
  return child as unknown as ChildProcessWithoutNullStreams;
}
function context(overrides: Partial<ExecuteContext> = {}): ExecuteContext {
  return {
    target,
    input: { prompt: 'Test prompt', projectPath: process.cwd(), kind: 'general', permissionMode: 'read-only' },
    route: { runtimeId: target.id, model: 'sonnet', effort: 'high', kind: 'general', reasons: [], warnings: [] },
    signal: new AbortController().signal,
    emit: () => undefined,
    approve: async () => false,
    ...overrides,
  };
}

const liveIdentity = {
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'live-fixture@example.test',
  orgId: 'fixture-org',
};

function liveClaudeFixture(t: import('node:test').TestContext) {
  const slot = new IdleNativeSessionSlot();
  t.after(() => slot.close());
  let starts = 0;
  let authReads = 0;
  let users = 0;
  let stopped = 0;
  const sends: Array<(packet: unknown) => void> = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  const userPackets: Array<Record<string, unknown>> = [];
  let response: (packet: Record<string, unknown>, send: (packet: unknown) => void) => void = (packet, send) => {
    send({
      type: 'result',
      subtype: 'success',
      session_id: 'live-session',
      user_message_uuid: packet.uuid,
      result: `reply-${users}`,
    });
  };
  const adapter = createClaudeAdapter({
    capture: async () => {
      authReads++;
      return { stdout: JSON.stringify(liveIdentity), exitCode: 0 };
    },
    spawn: async () => {
      starts++;
      const child = fakeChild((packet, send) => {
        sends.push(send);
        if (packet.type === 'control_request')
          send({
            type: 'control_response',
            response: { request_id: packet.request_id, subtype: 'success', response: {} },
          });
        if (packet.type === 'user') {
          users++;
          userPackets.push(packet);
          send({
            type: 'system',
            subtype: 'init',
            session_id: 'live-session',
            tools: [],
            mcp_servers: [],
            model: 'sonnet-observed',
          });
          send({ type: 'user', isReplay: true, uuid: packet.uuid, session_id: 'live-session' });
          response(packet, send);
        }
      });
      children.push(child);
      return child;
    },
    terminate: async (child) => {
      stopped++;
      child.stdin.end();
    },
  });
  const ctx = (overrides: Partial<ExecuteContext> = {}) => {
    const value = context({
      nativeSessionConfiguration: 'fixture-config',
      takeNativeSession: (key, sessionId) => slot.take(key, sessionId),
      ...overrides,
    });
    value.input.explicitNoTools = true;
    value.route.accountFingerprint = claudeAccountFingerprint(liveIdentity);
    return value;
  };
  return {
    adapter,
    slot,
    ctx,
    sends,
    children,
    userPackets,
    counts: () => ({ starts, authReads, users, stopped }),
    respond: (next: typeof response) => {
      response = next;
    },
  };
}

test('Claude keeps a successful no-tools child for the same native session with fresh per-turn identity and callbacks', async (t) => {
  const f = liveClaudeFixture(t);
  const firstEvents: RunEvent[] = [],
    secondEvents: RunEvent[] = [];
  const firstAbort = new AbortController();
  const first = await f.adapter.execute(f.ctx({ signal: firstAbort.signal, emit: (event) => firstEvents.push(event) }));
  assert.ok(first.idleNativeSession, 'a successful correlated no-tools turn may offer its idle child');
  await f.slot.hold(first.idleNativeSession);
  f.slot.activate(first.idleNativeSession);
  firstAbort.abort();
  const firstCount = firstEvents.length;
  const second = await f.adapter.execute(
    f.ctx({ nativeSessionId: first.nativeSessionId, emit: (event) => secondEvents.push(event) }),
  );
  assert.equal(second.output, 'reply-2');
  assert.equal(firstEvents.length, firstCount, 'old run callbacks are detached');
  assert.deepEqual(f.counts(), { starts: 1, authReads: 1, users: 2, stopped: 0 });
  assert.equal(f.userPackets[1]!.session_id, first.nativeSessionId);
  assert.notEqual(f.userPackets[0]!.uuid, f.userPackets[1]!.uuid);
  assert.ok(secondEvents.some((event) => event.type === 'text' && event.text === 'reply-2'));
  assert.ok(second.idleNativeSession);
  await f.slot.hold(second.idleNativeSession);
  f.slot.activate(second.idleNativeSession!);
  const secondCount = secondEvents.length;
  await f.slot.close();
  assert.equal(firstEvents.length, firstCount, 'idle exit must not emit into the first run');
  assert.equal(secondEvents.length, secondCount, 'idle exit must not emit into the completed second run');
});

for (const change of [
  'model',
  'effort',
  'cwd',
  'configuration',
  'permission',
  'approval',
  'skills',
  'connector',
  'command',
  'session',
  'tools',
  'run-temp',
] as const)
  test(`Claude live session falls back to ordinary cold resume when ${change} changes`, async (t) => {
    const f = liveClaudeFixture(t);
    const first = await f.adapter.execute(f.ctx());
    assert.ok(first.idleNativeSession);
    await f.slot.hold(first.idleNativeSession);
    f.slot.activate(first.idleNativeSession);
    const ctx = f.ctx({ nativeSessionId: first.nativeSessionId });
    if (change === 'model') ctx.route.model = 'opus';
    if (change === 'effort') ctx.route.effort = 'medium';
    if (change === 'cwd') ctx.input.projectPath = join(ctx.input.projectPath, 'different');
    if (change === 'configuration') ctx.nativeSessionConfiguration = 'changed';
    if (change === 'permission') ctx.input.permissionMode = 'workspace-write';
    if (change === 'approval') ctx.approvalMode = 'ask';
    if (change === 'skills') ctx.input.skills = ['new-skill'];
    if (change === 'connector') ctx.input.connectorRevision = 'new';
    if (change === 'command') ctx.target = { ...ctx.target, command: 'changed-command' };
    if (change === 'session') ctx.nativeSessionId = 'different-session';
    if (change === 'tools') ctx.input.explicitNoTools = false;
    if (change === 'run-temp') ctx.runTemp = join(tmpdir(), 'synthetic-run-temp');
    const second = await f.adapter.execute(ctx);
    assert.equal(f.counts().starts, 2);
    assert.equal(f.counts().stopped, change === 'tools' || change === 'run-temp' ? 2 : 1);
    if (second.idleNativeSession) {
      await f.slot.hold(second.idleNativeSession);
      f.slot.activate(second.idleNativeSession);
    }
  });

for (const bad of [
  'old-result',
  'missing-uuid',
  'wrong-session',
  'old-replay',
  'tool',
  'changed-tools',
  'exit',
] as const)
  test(`Claude live session rejects ${bad} without replaying or completing a new turn`, async (t) => {
    const f = liveClaudeFixture(t);
    const first = await f.adapter.execute(f.ctx());
    assert.ok(first.idleNativeSession);
    await f.slot.hold(first.idleNativeSession);
    f.slot.activate(first.idleNativeSession);
    const oldId = f.userPackets[0]!.uuid;
    f.respond((packet, send) => {
      const result = {
        type: 'result',
        subtype: 'success',
        session_id: 'live-session',
        user_message_uuid: packet.uuid,
        result: 'untrusted-late-output',
      };
      if (bad === 'old-result') send({ ...result, user_message_uuid: oldId });
      if (bad === 'missing-uuid') send({ ...result, user_message_uuid: undefined });
      if (bad === 'wrong-session') send({ ...result, session_id: 'other' });
      if (bad === 'old-replay') send({ type: 'user', isReplay: true, uuid: oldId });
      if (bad === 'tool')
        send({
          type: 'stream_event',
          event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read' } },
        });
      if (bad === 'changed-tools')
        send({ type: 'system', subtype: 'init', model: 'sonnet-observed', tools: ['Read'], mcp_servers: [] });
      if (bad === 'exit') {
        Object.assign(f.children[0]!, { exitCode: 1 });
        f.children[0]!.emit('close', 1);
      }
    });
    const events: RunEvent[] = [];
    await assert.rejects(
      f.adapter.execute(f.ctx({ nativeSessionId: first.nativeSessionId, emit: (event) => events.push(event) })),
      /native-session|Claude process closed/,
    );
    assert.equal(f.counts().starts, 1);
    assert.equal(f.counts().users, 2);
    assert.equal(f.counts().stopped, 1);
    assert.ok(events.every((event) => event.type !== 'text'));
  });

test('Claude live session cancellation closes the owned child and leaves no resumable live handle', async (t) => {
  const f = liveClaudeFixture(t);
  const first = await f.adapter.execute(f.ctx());
  assert.ok(first.idleNativeSession);
  await f.slot.hold(first.idleNativeSession);
  f.slot.activate(first.idleNativeSession);
  const abort = new AbortController();
  f.respond(() => abort.abort());
  await assert.rejects(
    f.adapter.execute(f.ctx({ nativeSessionId: first.nativeSessionId, signal: abort.signal })),
    /cancelled/,
  );
  assert.equal(f.counts().starts, 1);
  assert.equal(f.counts().users, 2);
  assert.ok(f.counts().stopped >= 1);
});

test('Claude live session discards unsolicited idle packets before the next prompt', async (t) => {
  const f = liveClaudeFixture(t);
  const first = await f.adapter.execute(f.ctx());
  assert.ok(first.idleNativeSession);
  await f.slot.hold(first.idleNativeSession);
  f.slot.activate(first.idleNativeSession);
  f.sends[0]!({ type: 'result', subtype: 'success', user_message_uuid: f.userPackets[0]!.uuid });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await f.adapter.execute(f.ctx({ nativeSessionId: first.nativeSessionId }));
  assert.equal(f.counts().starts, 2);
  if (second.idleNativeSession) {
    await f.slot.hold(second.idleNativeSession);
    f.slot.activate(second.idleNativeSession);
  }
});

for (const arrival of ['finishing', 'idle'] as const)
  test(`Claude terminal completion preserves the correlated child: ${arrival}`, async (t) => {
    const f = liveClaudeFixture(t);
    const completion = (uuid: unknown) => ({
      type: 'command_lifecycle',
      command_uuid: uuid,
      state: 'completed',
      uuid: '00000000-0000-4000-8000-000000000001',
      session_id: 'live-session',
    });
    f.respond((packet, send) => {
      send({
        type: 'result',
        subtype: 'success',
        session_id: 'live-session',
        user_message_uuid: packet.uuid,
        result: 'done',
      });
      if (arrival === 'finishing') send(completion(packet.uuid));
    });
    const first = await f.adapter.execute(f.ctx());
    assert.ok(first.idleNativeSession);
    await f.slot.hold(first.idleNativeSession);
    if (arrival === 'idle') f.sends[0]!(completion(f.userPackets[0]!.uuid));
    assert.equal(
      f.slot.isPending(first.nativeSessionId!),
      true,
      'the terminal receipt must not destroy a settling child',
    );
    assert.equal(f.slot.activate(first.idleNativeSession), true);
    const second = await f.adapter.execute(f.ctx({ nativeSessionId: first.nativeSessionId }));
    assert.deepEqual(f.counts(), { starts: 1, authReads: 1, users: 2, stopped: 0 });
    if (second.idleNativeSession) await f.slot.hold(second.idleNativeSession);
  });

for (const arrival of ['finishing', 'idle'] as const)
  for (const bad of [
    'wrong-user',
    'wrong-session',
    'missing-packet-uuid',
    'unknown-field',
    'hook',
    'tool',
    'unknown-state',
  ] as const)
    test(`Claude terminal completion rejects ${bad} packets: ${arrival}`, async (t) => {
      const f = liveClaudeFixture(t);
      const invalid = (uuid: unknown): Record<string, unknown> => {
        const packet: Record<string, unknown> = {
          type: 'command_lifecycle',
          command_uuid: uuid,
          state: 'completed',
          uuid: '00000000-0000-4000-8000-000000000001',
          session_id: 'live-session',
        };
        if (bad === 'wrong-user') packet.command_uuid = 'a-different-user';
        if (bad === 'wrong-session') packet.session_id = 'a-different-session';
        if (bad === 'missing-packet-uuid') delete packet.uuid;
        if (bad === 'unknown-field') packet.future_work = true;
        if (bad === 'unknown-state') packet.state = 'future-terminal-state';
        if (bad === 'hook') return { type: 'system', subtype: 'hook_started', hook_id: 'late-hook' };
        if (bad === 'tool') return { type: 'control_request', request: { subtype: 'can_use_tool' } };
        return packet;
      };
      f.respond((packet, send) => {
        send({
          type: 'result',
          subtype: 'success',
          session_id: 'live-session',
          user_message_uuid: packet.uuid,
          result: 'done',
        });
        if (arrival === 'finishing') send(invalid(packet.uuid));
      });
      const first = await f.adapter.execute(f.ctx());
      if (arrival === 'finishing') assert.equal(first.idleNativeSession, undefined);
      else {
        assert.ok(first.idleNativeSession);
        await f.slot.hold(first.idleNativeSession);
        f.sends[0]!(invalid(f.userPackets[0]!.uuid));
        assert.equal(first.idleNativeSession.isAlive(), false);
        assert.equal(f.slot.isPending(first.nativeSessionId!), false);
        assert.equal(await f.slot.take(first.idleNativeSession.key, first.nativeSessionId), undefined);
      }
      assert.equal(f.counts().users, 1, 'an unexpected packet must not cause a prompt replay');
      assert.ok(f.counts().stopped >= 1);
    });

test('Claude live session closes an unexpected idle child even when its audit callback throws', async (t) => {
  const f = liveClaudeFixture(t);
  let diagnostics = 0;
  const first = await f.adapter.execute(
    f.ctx({
      emit: (event) => {
        if (event.data?.kind === 'native-session-idle-discard') {
          diagnostics++;
          throw new Error('synthetic audit failure');
        }
      },
    }),
  );
  assert.ok(first.idleNativeSession);
  await f.slot.hold(first.idleNativeSession);
  assert.doesNotThrow(() => f.sends[0]!({ type: 'system', subtype: 'hook_started', hook_id: 'late-hook' }));
  assert.equal(diagnostics, 1);
  assert.equal(first.idleNativeSession.isAlive(), false);
  assert.equal(f.slot.isPending(first.nativeSessionId!), false);
  assert.equal(await f.slot.take(first.idleNativeSession.key, first.nativeSessionId), undefined);
  assert.deepEqual(f.counts(), { starts: 1, authReads: 0, users: 1, stopped: 1 });
});

for (const hooks of ['unfinished', 'complete', 'late'] as const)
  test(`Claude live session retains only completed foreground hooks: ${hooks}`, async (t) => {
    const f = liveClaudeFixture(t);
    f.respond((packet, send) => {
      send({ type: 'system', subtype: 'hook_started', hook_id: 'foreground-hook' });
      if (hooks !== 'unfinished') send({ type: 'system', subtype: 'hook_response', hook_id: 'foreground-hook' });
      send({
        type: 'result',
        subtype: 'success',
        session_id: 'live-session',
        user_message_uuid: packet.uuid,
        result: 'done',
      });
    });
    const result = await f.adapter.execute(f.ctx());
    assert.equal(!!result.idleNativeSession, hooks !== 'unfinished');
    if (result.idleNativeSession) {
      await f.slot.hold(result.idleNativeSession);
      f.slot.activate(result.idleNativeSession);
      if (hooks === 'late') {
        f.sends[0]!({ type: 'system', subtype: 'hook_started', hook_id: 'late-hook' });
        assert.equal(result.idleNativeSession.isAlive(), false);
        assert.equal(await f.slot.take(result.idleNativeSession.key, result.nativeSessionId), undefined);
      }
    }
    if (hooks !== 'complete') assert.equal(f.counts().stopped, 1);
  });

test('idle native session slot expires, isolates controllers and rejects handles after close', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slot = new IdleNativeSessionSlot(),
    other = new IdleNativeSessionSlot();
  let closes = 0;
  const resource = {
    key: 'key',
    nativeSessionId: 'session',
    isAlive: () => true,
    close: async () => {
      closes++;
    },
  };
  await slot.hold(resource);
  slot.activate(resource);
  assert.equal(await other.take('key', 'session'), undefined);
  t.mock.timers.tick(60_000);
  await slot.close();
  assert.equal(closes, 1);
  await slot.hold(resource);
  slot.activate(resource);
  assert.equal(closes, 2);
  await other.close();
});

for (const mode of ['bridge', 'no bridge', 'untrusted', 'simple-chat'] as const)
  test(`Claude extends MCP tool timeout only for a configured bridge: ${mode}`, async () => {
    const events: RunEvent[] = [];
    const ctx = context({
      emit: (event) => events.push(event),
      ...(mode !== 'no bridge'
        ? { agentBridge: { url: 'http://127.0.0.1:5555/agent', token: 'synthetic-run-token' } }
        : {}),
    });
    if (mode === 'untrusted') ctx.input.untrustedContent = true;
    if (mode === 'simple-chat') {
      ctx.input.latencySensitiveChat = true;
      ctx.runTemp = join(tmpdir(), `missing-chat-temp-${process.pid}-${Date.now()}`);
    }
    let starts = 0;
    const adapter = createClaudeAdapter({
      spawn: async (_target, args, options) => {
        starts++;
        assert.equal(args.includes('--mcp-config'), mode === 'bridge');
        assert.equal(options?.env?.MCP_TOOL_TIMEOUT, mode === 'bridge' ? '660000' : undefined);
        const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path');
        if (mode === 'bridge' && pathKey) assert.equal(options?.env?.[pathKey], process.env[pathKey]);
        assert.equal(options?.cwd, ctx.input.projectPath);
        assert.equal(options?.signal, ctx.signal);
        throw new Error('Synthetic spawn stopped');
      },
    });
    await assert.rejects(adapter.execute(ctx), /Synthetic spawn stopped/);
    assert.equal(starts, 1);
    const timings = events.filter((event) => event.data?.kind === 'startup-timing').map((event) => event.data!);
    assert.equal(timings.filter((event) => event.phase === 'mcp-config').length, Number(mode === 'bridge'));
    assert.equal(
      timings.find((event) => event.phase === 'mcp-config')?.status,
      mode === 'bridge' ? 'completed' : undefined,
    );
    assert.equal(timings.find((event) => event.phase === 'native-spawn')?.status, 'failed');
    assert.ok(!JSON.stringify(timings).includes('synthetic-run-token'));
  });

for (const option of ['--safe-mode', '--permission-prompts'])
  test(`Claude reports incompatible ${option} support without dropping safety arguments`, async () => {
    let starts = 0;
    const child = fakeChild((packet) => {
      assert.equal(packet.type, 'control_request', 'no model prompt is sent by discovery');
      (child.stderr as PassThrough).write('private-account@example.test credential=private-secret\nerror: un');
      (child.stderr as PassThrough).write(`known option '${option}'\n`);
      child.emit('close', 1);
    });
    const adapter = createClaudeAdapter({
      capture: async () => ({ stdout: JSON.stringify({ loggedIn: true, authMethod: 'oauth_token' }), exitCode: 0 }),
      spawn: async (_target, args) => {
        starts++;
        assert.ok(args.includes('--safe-mode'));
        assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
        assert.equal(args[args.indexOf('--tools') + 1], '');
        assert.ok(args.includes('--strict-mcp-config'));
        assert.ok(args.includes('--include-partial-messages'));
        assert.ok(args.includes('--replay-user-messages'));
        assert.equal(args[args.indexOf('--permission-mode') + 1], 'auto');
        assert.ok(!args.includes('--model') && !args.includes('--effort'));
        return child;
      },
      terminate: async () => {},
      profile: async () => ({}),
    });
    const snapshot = await adapter.discover(target);
    assert.equal(starts, 1, 'never retry with weaker permission arguments');
    assert.equal(snapshot.installed, true);
    assert.equal(snapshot.status, 'error');
    assert.equal(snapshot.note, 'runtime-protocol-incompatible');
    assert.match(snapshot.quota.note ?? '', /更新官方 Claude Code/);
    assert.ok(!JSON.stringify(snapshot).includes('private-secret'));
    assert.ok(!JSON.stringify(snapshot).includes('private-account'));
    assert.match(snapshot.errorDetail ?? '', /^error: unknown option/);
  });

test('Claude execution preserves protocol classification and never sends a prompt after an unsupported option', async () => {
  const packets: string[] = [];
  const child = fakeChild((packet) => {
    packets.push(String(packet.type));
    (child.stderr as PassThrough).write("error: unknown option '--permission-prompts'\n");
    child.emit('close', 1);
  });
  const adapter = createClaudeAdapter({ spawn: async () => child, terminate: async () => {} });
  await assert.rejects(adapter.execute(context()), { message: 'runtime-protocol-incompatible' });
  assert.deepEqual(packets, ['control_request']);
});

test('Claude announces finishing before awaiting cleanup after initialize is rejected', async () => {
  let cleanupStarted!: () => void, finishCleanup!: () => void;
  const cleanupEntered = new Promise<void>((resolve) => (cleanupStarted = resolve));
  const cleanup = new Promise<void>((resolve) => (finishCleanup = resolve));
  let latestState: string | undefined,
    stateAtStop: string | undefined,
    stateAtTerminate: string | undefined,
    completed = false;
  const child = fakeChild((packet, send) => {
    if (packet.type === 'control_request')
      send({
        type: 'control_response',
        response: { request_id: packet.request_id, subtype: 'error', error: 'Mock initialize failure' },
      });
  });
  child.stdin.on('finish', () => (stateAtStop = latestState));
  const ctx = context({ registerSteer: (_handler, status) => (latestState = status?.state) });
  const adapter = createClaudeAdapter({
    spawn: async () => child,
    terminate: async () => {
      stateAtTerminate = latestState;
      cleanupStarted();
      await cleanup;
    },
  });
  const execution = adapter.execute(ctx);
  const rejected = assert.rejects(execution, /runtime-request-failed/).then(() => (completed = true));
  try {
    await cleanupEntered;
    assert.equal(stateAtStop, 'finishing', 'authorization ends before closing the native input');
    assert.equal(stateAtTerminate, 'finishing', 'authorization ends before process cleanup can block');
    assert.equal(latestState, 'finishing');
    assert.equal(completed, false, 'the execution is still awaiting process cleanup');
    assert.equal(ctx.signal.aborted, false, 'finishing does not cancel the native run signal');
  } finally {
    finishCleanup();
    await rejected;
  }
});

test('Claude also announces finishing when spawning fails before a channel exists', async () => {
  const states: Array<string | undefined> = [];
  const adapter = createClaudeAdapter({
    spawn: async () => {
      throw new Error('Mock spawn failure');
    },
  });
  await assert.rejects(
    adapter.execute(context({ registerSteer: (_handler, status) => states.push(status?.state) })),
    /Mock spawn failure/,
  );
  assert.equal(states.at(-1), 'finishing');
});

test('Claude quota preserves null/absent values and rejects invalid percentages', () => {
  const quota = claudeQuota({
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 25, resets_at: '2026-09-26T05:00:00Z' },
      seven_day: { utilization: null, resets_at: null },
      seven_day_opus: { utilization: 200 },
    },
  });
  assert.equal(quota.status, 'known');
  assert.equal(quota.windows[0]?.usedPercent, 25);
  assert.equal(quota.windows[1]?.usedPercent, null);
  assert.equal(quota.windows[2]?.usedPercent, null);
  assert.equal(quota.windows[1]?.resetNotReported, true);
  assert.equal(claudeQuota({ rate_limits_available: false }).status, 'unknown');
  assert.deepEqual(claudeQuota({}).windows, []);
});

test('Claude reads dynamic weekly Fable limits without treating private promotional fields as shared quota', () => {
  const quota = claudeQuota({
    rate_limits_available: true,
    subscription_type: 'pro',
    rate_limits: {
      five_hour: { utilization: 17, resets_at: '2026-10-06T00:30:00Z' },
      seven_day: { utilization: 58, resets_at: '2026-10-07T10:00:00Z' },
      seven_day_opus: { utilization: 35, resets_at: null },
      private_promotion: { utilization: 100, remaining_dollars: 0 },
      model_scoped: [
        { display_name: 'Fable', utilization: 13, resets_at: '2026-10-07T10:00:00Z' },
        { display_name: 'Opus', utilization: 25, resets_at: null },
        { display_name: 'Future model', utilization: null, resets_at: 'invalid' },
        { display_name: '', utilization: 50 },
      ],
    },
  });
  assert.equal(quota.windows.length, 5);
  assert.deepEqual(
    quota.windows.find((window) => window.id === 'seven_day_fable'),
    {
      id: 'seven_day_fable',
      label: 'Fable · 每周额度',
      durationMinutes: 10080,
      usedPercent: 13,
      resetsAt: '2026-10-07T10:00:00Z',
      modelFamily: 'fable',
    },
  );
  assert.equal(quota.windows.filter((window) => window.id === 'seven_day_opus').length, 1);
  assert.equal(quota.windows.find((window) => window.id === 'seven_day_opus')?.usedPercent, 25);
  assert.equal(quota.windows.find((window) => window.id === 'seven_day_opus')?.modelFamily, 'opus');
  assert.equal(quota.windows.at(-1)?.usedPercent, null);
  assert.equal(quota.windows.at(-1)?.resetsAt, null);
  assert.equal(quota.windows.at(-1)?.modelFamily, undefined);
  assert.equal(quota.subscription?.label, 'Pro');
  assert.match(quota.subscription?.source ?? '', /缓存/);
  assert.ok(!JSON.stringify(quota).includes('private_promotion'));
});

test('a verified live Claude plan supersedes stale Pro metadata while profile failure preserves quota', async () => {
  for (const unavailable of [false, true]) {
    const authPayload = {
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      email: 'fixture@example.test',
      orgId: 'fixture-org',
      subscriptionType: 'pro',
    };
    const child = fakeChild((packet, send) => {
      const request = packet.request as Record<string, unknown>;
      assert.equal(packet.type, 'control_request', 'discovery never sends a user/model prompt');
      send({
        type: 'control_response',
        response: {
          request_id: packet.request_id,
          subtype: 'success',
          response:
            request.subtype === 'get_usage'
              ? {
                  subscription_type: 'pro',
                  rate_limits_available: true,
                  rate_limits: {
                    five_hour: { utilization: 17, resets_at: null },
                    model_scoped: [{ display_name: 'Fable', utilization: 13, resets_at: null }],
                  },
                }
              : { models: [{ value: 'fable', supportedEffortLevels: ['high'] }] },
        },
      });
    });
    const adapter = createClaudeAdapter({
      capture: async () => ({ stdout: JSON.stringify(authPayload), exitCode: 0 }),
      spawn: async () => child,
      terminate: async () => {},
      profile: async (_target, auth) => {
        assert.deepEqual(auth, authPayload);
        return unavailable
          ? { note: '实时套餐暂未核验，当前套餐名称来自 CLI 登录缓存。' }
          : {
              subscription: { label: 'Max (20x)', source: 'Claude OAuth profile', observedAt: '2026-10-05T12:00:00Z' },
            };
      },
    });
    const snapshot = await adapter.discover(target);
    assert.equal(snapshot.status, 'ready');
    assert.equal(snapshot.subscription?.label, unavailable ? 'Pro' : 'Max (20x)');
    assert.equal(snapshot.quota.subscription?.label, unavailable ? 'Pro' : 'Max (20x)');
    assert.equal(snapshot.quota.windows.find((window) => window.modelFamily === 'fable')?.usedPercent, 13);
    if (unavailable) assert.match(snapshot.quota.note ?? '', /实时套餐暂未核验/);
    assert.ok(!JSON.stringify(snapshot).includes('fixture@example.test'));
  }
});

test('Claude checks fresh plan independently when control initialization fails without hiding the failure', async () => {
  for (const profileUnavailable of [false, true]) {
    let profileReads = 0;
    const child = fakeChild((packet, send) => {
      assert.equal(packet.type, 'control_request', 'metadata discovery never sends a model prompt');
      assert.equal((packet.request as Record<string, unknown>).subtype, 'initialize');
      send({
        type: 'control_response',
        response: { request_id: packet.request_id, subtype: 'error', error: 'network connection timed out' },
      });
    });
    const adapter = createClaudeAdapter({
      capture: async () => ({
        stdout: JSON.stringify({
          loggedIn: true,
          authMethod: 'claude.ai',
          apiProvider: 'firstParty',
          subscriptionType: 'pro',
          email: 'fixture@example.test',
          orgId: 'fixture-org',
        }),
        exitCode: 0,
      }),
      spawn: async () => child,
      terminate: async () => {},
      profile: async () => {
        profileReads++;
        if (profileUnavailable) throw Error('private account diagnostics never shown');
        return { subscription: { label: 'Max (20x)', source: 'Verified profile', observedAt: '2026-10-05T12:00:00Z' } };
      },
    });
    const snapshot = await adapter.discover(target);
    assert.equal(profileReads, 1, 'the control failure cannot suppress account metadata');
    assert.equal(snapshot.status, 'error', 'a plan lookup does not prove that the execution channel works');
    assert.equal(snapshot.note, 'runtime-timeout');
    assert.equal(snapshot.accounting?.mode, 'subscription');
    assert.equal(snapshot.subscription?.label, profileUnavailable ? 'Pro' : 'Max (20x)');
    assert.equal(snapshot.quota.status, 'unknown', 'never invent quota from a plan name');
    assert.deepEqual(snapshot.quota.windows, []);
    assert.match(snapshot.quota.note ?? '', /握手检查未完成/);
    assert.ok(!JSON.stringify(snapshot).includes('private account'));
    assert.ok(!JSON.stringify(snapshot).includes('fixture@example.test'));
  }
});

test('Claude uses advertised effort capabilities and preserves native launcher semantics', () => {
  assert.deepEqual(
    claudeModels({ models: [{ value: 'custom', supportedEffortLevels: ['high', 'invented'] }] })[0]?.efforts,
    ['high'],
  );
  const args = claudeExecutionArgs(context({ nativeSessionId: 'previous-session' }));
  assert.ok(args.includes('stdio'));
  assert.ok(args.includes('--resume'));
  assert.ok(args.includes('Read,Glob,Grep'));
  assert.ok(!args.includes('--bare'));
  assert.ok(!args.includes('--dangerously-skip-permissions'));
});

test('Claude automatic mode uses native classifier, no host prompts, and retains the read-only tools', () => {
  for (const permissionMode of ['read-only', 'workspace-write'] as const) {
    const ctx = context({ approvalMode: 'auto' });
    ctx.input.permissionMode = permissionMode;
    const args = claudeExecutionArgs(ctx);
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'auto');
    assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
    assert.equal(args.includes('--permission-prompt-tool'), false);
    assert.equal(args.includes('Read,Glob,Grep'), permissionMode === 'read-only');
    assert.equal(args.includes('--dangerously-skip-permissions'), false);
    assert.equal(args.includes('bypassPermissions'), false);
  }
  const ask = claudeExecutionArgs(context({ approvalMode: 'ask' }));
  assert.equal(ask[ask.indexOf('--permission-mode') + 1], 'manual');
  assert.equal(ask[ask.indexOf('--permission-prompts') + 1], 'host');
});

test('Claude bypasses its classifier only for a device write task on this computer', () => {
  const mode = (change: (ctx: ReturnType<typeof context>) => void) => {
    const ctx = context({ approvalMode: 'auto' });
    ctx.trustedProject = true;
    ctx.input.permissionMode = 'workspace-write';
    ctx.input.permissionOrigin = { mode: 'workspace-write', source: 'device' };
    change(ctx);
    const args = claudeExecutionArgs(ctx);
    return args[args.indexOf('--permission-mode') + 1];
  };
  assert.equal(
    mode(() => {}),
    'bypassPermissions',
  );
  assert.equal(
    mode((ctx) => (ctx.input.permissionOrigin = { mode: 'workspace-write', source: 'user' })),
    'auto',
  );
  assert.equal(
    mode((ctx) => (ctx.input.permissionMode = 'read-only')),
    'auto',
  );
  assert.equal(
    mode((ctx) => (ctx.trustedProject = false)),
    'auto',
  );
  assert.equal(
    mode((ctx) => (ctx.approvalMode = 'ask')),
    'manual',
  );
});

test('Claude scoped host MCP permits swarm diagnostics and communication without widening native read-only tools', () => {
  const ctx = context({ approvalMode: 'auto' });
  ctx.agentBridge = { url: 'http://127.0.0.1:5555/agent', token: 'synthetic-run-token' };
  const args = claudeExecutionArgs(ctx, 'synthetic-mcp.json');
  const allowed = args[args.indexOf('--allowedTools') + 1]!.split(',');
  assert.ok(allowed.includes('mcp__pugport__list_swarm'));
  assert.ok(allowed.includes('mcp__pugport__message_agent'));
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(!JSON.stringify(args).includes('synthetic-run-token'));
  assert.ok(!args.includes('--dangerously-skip-permissions'));
});

test('Claude simple chat disables tools and MCP while preserving settings, permissions, model and effort', () => {
  for (const approvalMode of ['auto', 'ask'] as const)
    for (const permissionMode of ['read-only', 'workspace-write'] as const)
      for (const hint of ['latencySensitiveChat', 'explicitNoTools'] as const) {
        const ctx = context({ approvalMode, nativeSessionId: 'same-chat' });
        Object.assign(ctx.input, { prompt: 'Conversation reply', [hint]: true, permissionMode });
        const args = claudeExecutionArgs(ctx, 'must-not-use-mcp.json');
        const value = (flag: string) => args[args.indexOf(flag) + 1];
        assert.equal(value('--tools'), '');
        assert.ok(args.includes('--strict-mcp-config'));
        for (const flag of ['--mcp-config', '--allowedTools', '--safe-mode', '--settings', '--setting-sources'])
          assert.ok(!args.includes(flag), flag);
        assert.equal(value('--permission-mode'), approvalMode === 'auto' ? 'auto' : 'manual');
        assert.equal(value('--permission-prompts'), approvalMode === 'auto' ? 'none' : 'host');
        assert.equal(value('--model'), ctx.route.model);
        assert.equal(value('--effort'), ctx.route.effort);
        assert.equal(value('--resume'), 'same-chat');
      }
});

test('Claude simple chat never offers live steering even when the native session supports it', async () => {
  const registrations: Parameters<NonNullable<ExecuteContext['registerSteer']>>[] = [];
  const child = fakeChild((packet, send) => {
    if (packet.type === 'control_request')
      send({ type: 'control_response', response: { request_id: packet.request_id, subtype: 'success', response: {} } });
    if (packet.type === 'user') {
      send({
        type: 'system',
        subtype: 'init',
        session_id: 'simple-session',
        claude_code_version: '2.1.281',
        capabilities: ['interrupt_receipt_v1'],
      });
      send({ type: 'stream_event', user_message_uuid: packet.uuid, event: { type: 'message_start' } });
      send({ type: 'result', subtype: 'success', result: '你好' });
    }
  });
  const ctx = context({ registerSteer: (...args) => registrations.push(args) });
  ctx.input.latencySensitiveChat = true;
  const adapter = createClaudeAdapter({ spawn: async () => child, terminate: async () => undefined });
  assert.equal((await adapter.execute(ctx)).output, '你好');
  assert.ok(registrations.some(([, status]) => status?.state === 'unsupported'));
  assert.ok(registrations.every(([handler]) => handler === undefined));
});

for (const outcome of ['completed', 'failed', 'cancelled'] as const)
  test(`Claude simple chat retains the resume identity guard and sanitized startup timing: ${outcome}`, async () => {
    const events: RunEvent[] = [];
    const abort = new AbortController();
    const identity = {
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      email: 'private@example.test',
      orgId: 'private-org',
    };
    let spawned = 0;
    const child = fakeChild((packet, send) => {
      if (packet.type === 'control_request')
        send({
          type: 'control_response',
          response: { request_id: packet.request_id, subtype: 'success', response: {} },
        });
      if (packet.type === 'user') send({ type: 'result', subtype: 'success', result: '你好' });
    });
    const ctx = context({
      nativeSessionId: 'existing-session',
      signal: abort.signal,
      emit: (event) => events.push(event),
    });
    ctx.input.explicitNoTools = true;
    ctx.route.accountFingerprint = claudeAccountFingerprint(identity);
    const adapter = createClaudeAdapter({
      capture: async (_target, args, options) => {
        assert.deepEqual(args, ['auth', 'status']);
        assert.equal(options?.timeoutMs, 10000);
        if (outcome === 'cancelled') abort.abort();
        if (outcome !== 'completed') throw Error('private authentication diagnostic');
        return { stdout: JSON.stringify(identity), exitCode: 0 };
      },
      spawn: async () => {
        spawned++;
        return child;
      },
      terminate: async () => undefined,
    });
    if (outcome === 'completed') assert.equal((await adapter.execute(ctx)).output, '你好');
    else
      await assert.rejects(adapter.execute(ctx), {
        message: outcome === 'cancelled' ? 'Run cancelled.' : 'native-session-identity-unverified',
      });
    assert.equal(spawned, Number(outcome === 'completed'));
    const timings = events.filter((event) => event.data?.kind === 'startup-timing').map((event) => event.data!);
    assert.equal(timings.find((event) => event.phase === 'resume-identity')?.status, outcome);
    assert.equal(
      timings.find((event) => event.phase === 'native-spawn')?.status,
      outcome === 'completed' ? 'completed' : undefined,
    );
    assert.ok(
      timings.every(
        (event) => typeof event.elapsedMs === 'number' && Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0,
      ),
    );
    assert.ok(!JSON.stringify(timings).includes('private'));
  });

for (const [version, skipBehaviors] of [
  ['2.1.302', true],
  ['2.1.303', true],
  ['2.1.281', false],
  [undefined, false],
  ['invalid', false],
  ['3.0.0', false],
] as const)
  test(`Claude discovery sends only read-only control requests and reports unknown quota: ${version}`, async () => {
    const requests: string[] = [];
    const child = fakeChild((packet, send) => {
      assert.equal(packet.type, 'control_request');
      const request = packet.request as Record<string, unknown>;
      requests.push(String(request.subtype));
      if (request.subtype === 'get_usage') assert.equal(request.skip_behaviors, skipBehaviors);
      send({
        type: 'control_response',
        response: {
          request_id: packet.request_id,
          subtype: 'success',
          response:
            request.subtype === 'get_usage'
              ? { rate_limits_available: false }
              : { claude_code_version: version, models: [{ value: 'sonnet', supportedEffortLevels: ['high'] }] },
        },
      });
    });
    const adapter = createClaudeAdapter({
      spawn: async () => child,
      capture: async () => ({ stdout: JSON.stringify({ loggedIn: true, authMethod: 'oauth_token' }), exitCode: 0 }),
      terminate: async () => undefined,
    });
    const snapshot = await adapter.discover(target);
    assert.deepEqual(requests, ['initialize', 'list_models', 'get_usage']);
    assert.equal(snapshot.version, version);
    assert.equal(snapshot.quota.status, 'unknown');
    assert.equal(snapshot.models[0]?.id, 'sonnet');
    assert.equal(snapshot.status, 'ready');
    assert.equal(snapshot.accounting?.mode, 'unknown');
  });

for (const trafficSwitch of [undefined, '', '1', '0', 'false'])
  test(`Claude usage discovery preserves privacy while allowing requested metadata (${String(trafficSwitch)})`, async () => {
    const originalEnvironment = process.env;
    const inherited: NodeJS.ProcessEnv = { PUGPORT_FIXTURE: 'keep', DO_NOT_TRACK: '1' };
    if (trafficSwitch !== undefined) {
      inherited.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = trafficSwitch;
      inherited.claude_code_disable_nonessential_traffic = trafficSwitch;
    }
    process.env = inherited;
    try {
      let launchedEnvironment: NodeJS.ProcessEnv | undefined;
      const requests: string[] = [];
      const child = fakeChild((packet, send) => {
        assert.equal(packet.type, 'control_request', 'quota discovery never sends a model prompt');
        const request = packet.request as Record<string, unknown>;
        requests.push(String(request.subtype));
        const blocked = Object.entries(launchedEnvironment ?? inherited).some(
          ([key, value]) => /^CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC$/i.test(key) && !!value,
        );
        send({
          type: 'control_response',
          response: {
            request_id: packet.request_id,
            subtype: 'success',
            response:
              request.subtype === 'get_usage'
                ? {
                    rate_limits_available: true,
                    rate_limits: blocked ? null : { five_hour: { utilization: 9 } },
                  }
                : { models: [{ value: 'sonnet' }] },
          },
        });
      });
      const adapter = createClaudeAdapter({
        spawn: async (_target, _args, options) => {
          launchedEnvironment = options?.env ?? process.env;
          return child;
        },
        capture: async () => ({ stdout: JSON.stringify({ loggedIn: true, authMethod: 'oauth_token' }), exitCode: 0 }),
        terminate: async () => {},
        profile: async () => ({}),
      });
      const snapshot = await adapter.discover(target);
      assert.equal(snapshot.quota.status, 'known');
      assert.equal(snapshot.quota.windows[0]?.usedPercent, 9);
      assert.deepEqual(requests, ['initialize', 'list_models', 'get_usage']);
      assert.equal(launchedEnvironment?.PUGPORT_FIXTURE, 'keep');
      assert.equal(launchedEnvironment?.DO_NOT_TRACK, '1');
      for (const name of [
        'DISABLE_TELEMETRY',
        'DISABLE_ERROR_REPORTING',
        'DISABLE_AUTOUPDATER',
        'DISABLE_FEEDBACK_COMMAND',
      ])
        assert.equal(launchedEnvironment?.[name], trafficSwitch ? '1' : undefined);
      assert.equal(process.env === inherited, true, 'discovery preserves the parent environment');
      assert.equal(inherited.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, trafficSwitch);
      assert.equal(inherited.claude_code_disable_nonessential_traffic, trafficSwitch);
      assert.equal(inherited.DISABLE_TELEMETRY, undefined);

      const executionChild = fakeChild((packet, send) => {
        assert.equal(packet.type, 'control_request');
        send({
          type: 'control_response',
          response: { request_id: packet.request_id, subtype: 'error', error: 'fixture-stop-before-inference' },
        });
      });
      let executionEnvironment: NodeJS.ProcessEnv | undefined;
      const execution = createClaudeAdapter({
        spawn: async (_target, _args, options) => {
          executionEnvironment = options?.env ?? process.env;
          return executionChild;
        },
        terminate: async () => {},
      });
      await assert.rejects(execution.execute(context()), /runtime-request-failed/);
      assert.equal(executionEnvironment?.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, trafficSwitch);
      assert.equal(executionEnvironment?.DISABLE_TELEMETRY, undefined);
    } finally {
      process.env = originalEnvironment;
    }
  });

test('Claude authentication interpretation exposes no identity or secret and does not infer an OAuth billing plan', () => {
  assert.deepEqual(
    claudeAuthentication({ loggedIn: true, authMethod: 'api_key', email: 'private@example.test', apiKey: 'secret' })
      .accounting.mode,
    'usage',
  );
  const status = claudeAuthentication({
    loggedIn: true,
    authMethod: 'oauth_token',
    apiProvider: 'firstParty',
    token: 'secret',
  });
  assert.equal(status.accounting.mode, 'unknown');
  assert.equal(status.loggedIn, true);
  assert.ok(!JSON.stringify(status).includes('secret'));
  assert.equal(
    claudeAuthentication({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      subscriptionType: 'pro',
    }).accounting.mode,
    'subscription',
  );
  assert.equal(
    claudeAuthentication({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'thirdParty',
      subscriptionType: 'pro',
    }).accounting.mode,
    'unknown',
  );
  assert.equal(
    claudeAuthentication({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      subscriptionType: 'free',
    }).accounting.mode,
    'unknown',
  );
});

test('Claude native account identity changes across accounts and organizations without retaining private metadata', () => {
  const account = {
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    email: 'first@example.test',
    orgId: 'org-one',
  };
  const first = claudeAccountFingerprint(account);
  assert.match(first ?? '', /^[a-f0-9]{64}$/);
  assert.equal(claudeAccountFingerprint({ ...account, email: ' FIRST@example.test ', subscriptionType: 'max' }), first);
  assert.notEqual(claudeAccountFingerprint({ ...account, email: 'second@example.test' }), first);
  assert.notEqual(claudeAccountFingerprint({ ...account, orgId: 'org-two' }), first);
  assert.equal(claudeAccountFingerprint({ ...account, loggedIn: false }), undefined);
  assert.equal(claudeAccountFingerprint({ ...account, authMethod: 'api_key' }), undefined);
  assert.equal(claudeAccountFingerprint({ ...account, apiProvider: 'thirdParty' }), undefined);
  assert.equal(claudeAccountFingerprint({ ...account, email: '' }), undefined);
  assert.ok(!first?.includes('example'));
});

test('Claude does not invent quota or reset times for null, absent or malformed fields', () => {
  const quota = claudeQuota({
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 0, resets_at: null },
      seven_day: { utilization: 34, resets_at: '2026-09-30T09:59:59.683280+00:00' },
      seven_day_opus: { utilization: 17, resets_at: 'not-a-date' },
      seven_day_sonnet: { resets_at: null },
    },
  });
  assert.deepEqual(quota.windows[0], {
    id: 'five_hour',
    label: '5 小时额度',
    durationMinutes: 300,
    usedPercent: 0,
    resetsAt: null,
    resetNotReported: true,
  });
  assert.equal(quota.windows[1]?.usedPercent, 34);
  assert.equal(quota.windows[1]?.resetNotReported, undefined);
  assert.equal(quota.windows[2]?.resetsAt, null);
  assert.equal(quota.windows[2]?.resetNotReported, undefined);
  assert.equal(quota.windows[3]?.usedPercent, null);
  assert.equal(
    claudeQuota({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 0 } } }).windows[0]
      ?.resetNotReported,
    undefined,
  );
  const unavailable = claudeQuota({ rate_limits_available: true, rate_limits: null, subscription_type: 'pro' });
  assert.equal(unavailable.status, 'unknown');
  assert.deepEqual(unavailable.windows, []);
  assert.match(unavailable.note ?? '', /没有返回有效窗口/);
});

test('Claude signed-out auth status is distinct from readable model metadata', async () => {
  let spawned = false;
  const adapter = createClaudeAdapter({
    spawn: async () => {
      spawned = true;
      throw new Error('A signed-out CLI must not start control discovery.');
    },
    capture: async (_target, _args, options) => {
      assert.deepEqual(options?.acceptedExitCodes, [0, 1]);
      return { stdout: JSON.stringify({ loggedIn: false }), exitCode: 1 };
    },
    terminate: async () => undefined,
  });
  const snapshot = await adapter.discover(target);
  assert.equal(snapshot.status, 'auth-required');
  assert.equal(snapshot.installed, true);
  assert.equal(spawned, false);
  assert.equal(snapshot.quota.status, 'unknown');
  assert.equal(snapshot.accounting?.mode, 'unknown');
  assert.deepEqual(snapshot.quota.windows, []);
  assert.match(snapshot.quota.note ?? '', /没有有效登录/);
});

test('Claude logged-in subscription reports verified quota while a failed usage query keeps the CLI ready', async () => {
  for (const failQuota of [false, true]) {
    const identity = {
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      email: 'usage@example.test',
      orgId: 'fixture-org',
    };
    let authReads = 0;
    const child = fakeChild((packet, send) => {
      const request = packet.request as Record<string, unknown>;
      if (request.subtype === 'get_usage') assert.equal(request.skip_behaviors, true);
      if (request.subtype === 'get_usage' && failQuota) {
        send({
          type: 'control_response',
          response: {
            request_id: packet.request_id,
            subtype: 'error',
            error: 'network unavailable for private-account@example.test secret=fixture-secret',
          },
        });
        return;
      }
      send({
        type: 'control_response',
        response: {
          request_id: packet.request_id,
          subtype: 'success',
          response:
            request.subtype === 'get_usage'
              ? {
                  rate_limits_available: true,
                  rate_limits: {
                    five_hour: { utilization: 42, resets_at: '2026-09-27T10:00:00Z' },
                    seven_day: { utilization: 81, resets_at: '2026-10-01T10:00:00Z' },
                  },
                  behaviors: null,
                }
              : { claude_code_version: '2.1.302', models: [{ value: 'sonnet', supportedEffortLevels: ['high'] }] },
        },
      });
    });
    const adapter = createClaudeAdapter({
      spawn: async () => child,
      capture: async (_target, args) => {
        authReads++;
        assert.deepEqual(args, ['auth', 'status']);
        return { stdout: JSON.stringify(identity), exitCode: 0 };
      },
      terminate: async () => undefined,
      profile: async () => ({}),
    });
    const snapshot = await adapter.discover(target);
    assert.equal(snapshot.status, 'ready');
    assert.equal(snapshot.quota.status, failQuota ? 'error' : 'known');
    assert.equal(snapshot.accounting?.mode, failQuota ? 'unknown' : 'subscription');
    assert.equal(snapshot.quota.windows[0]?.usedPercent, failQuota ? undefined : 42);
    assert.deepEqual(
      snapshot.quota.windows.map((window) => window.usedPercent),
      failQuota ? [] : [42, 81],
    );
    assert.equal(authReads, 2, 'the quota-only read retains the final account identity check');
    assert.equal(snapshot.accountFingerprint, claudeAccountFingerprint(identity));
    if (failQuota) {
      assert.ok(Number.isFinite(Date.parse(snapshot.quota.observedAt!)));
      assert.equal(snapshot.quota.note, 'runtime-network-error');
      assert.equal(quotaReadingPending(snapshot), false);
      assert.doesNotMatch(JSON.stringify(snapshot), /private-account|fixture-secret/);
    }
  }
});

test('Claude older CLI without auth status still uses the read-only control protocol', async () => {
  const child = fakeChild((packet, send) =>
    send({
      type: 'control_response',
      response: { request_id: packet.request_id, subtype: 'success', response: { models: [{ value: 'haiku' }] } },
    }),
  );
  const adapter = createClaudeAdapter({
    spawn: async () => child,
    capture: async () => {
      throw new Error('unsupported auth status');
    },
    terminate: async () => undefined,
  });
  const snapshot = await adapter.discover(target);
  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.quota.status, 'unknown');
});

test('an unavailable Claude profile cannot mask a completed subscription quota error', async () => {
  const child = fakeChild((packet, send) => {
    const usage = (packet.request as Record<string, unknown>).subtype === 'get_usage';
    send({
      type: 'control_response',
      response: {
        request_id: packet.request_id,
        subtype: usage ? 'error' : 'success',
        ...(usage ? { error: 'network unavailable' } : { response: { models: [{ value: 'sonnet' }] } }),
      },
    });
  });
  const snapshot = await createClaudeAdapter({
    spawn: async () => child,
    capture: async () => ({
      stdout: JSON.stringify({
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        email: 'fixture@example.test',
        orgId: 'fixture-org',
        subscriptionType: 'pro',
      }),
      exitCode: 0,
    }),
    terminate: async () => {},
    profile: async () => ({ note: '实时套餐暂未核验，当前套餐名称来自 CLI 登录缓存。' }),
  }).discover(target);
  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.accounting?.mode, 'subscription');
  assert.equal(snapshot.subscription?.label, 'Pro');
  assert.equal(snapshot.quota.status, 'error');
  assert.equal(snapshot.quota.note, 'runtime-network-error');
  assert.equal(quotaReadingPending(snapshot), false);
});

for (const change of ['email', 'organization', 'signed-out', 'api-key', 'unavailable'] as const) {
  test(`Claude discards discovery quota and plan when the final account check changes: ${change}`, async () => {
    const original = {
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      email: 'before@example.test',
      orgId: 'fixture-org',
      subscriptionType: 'pro',
    };
    const changed =
      change === 'email'
        ? { ...original, email: 'after@example.test' }
        : change === 'organization'
          ? { ...original, orgId: 'changed-org' }
          : change === 'signed-out'
            ? { loggedIn: false }
            : change === 'api-key'
              ? { loggedIn: true, authMethod: 'api-key', apiProvider: 'firstParty' }
              : undefined;
    let initialized = false;
    let authReads = 0;
    const child = fakeChild((packet, send) => {
      assert.equal(packet.type, 'control_request');
      const request = packet.request as Record<string, unknown>;
      if (request.subtype === 'initialize') initialized = true;
      if (request.subtype === 'get_usage') assert.equal(request.skip_behaviors, true);
      send({
        type: 'control_response',
        response: {
          request_id: packet.request_id,
          subtype: 'success',
          response:
            request.subtype === 'get_usage'
              ? { rate_limits_available: true, rate_limits: { five_hour: { utilization: 73 } } }
              : { claude_code_version: '2.1.302', models: [{ value: 'sonnet', supportedEffortLevels: ['high'] }] },
        },
      });
    });
    const adapter = createClaudeAdapter({
      spawn: async () => child,
      terminate: async () => {},
      capture: async (_target, args) => {
        authReads++;
        assert.deepEqual(args, ['auth', 'status']);
        if (initialized && !changed) throw new Error('fixture unavailable');
        return { stdout: JSON.stringify(initialized ? changed : original), exitCode: 0 };
      },
      profile: async () => ({
        subscription: { label: 'Max (20x)', source: 'fixture old account profile', observedAt: '2026-10-06T00:00:00Z' },
      }),
    });
    const snapshot = await adapter.discover(target);
    // A check that cannot be read at all is retried once before the reading is withheld.
    assert.equal(authReads, change === 'unavailable' ? 3 : 2);
    assert.equal(snapshot.accountFingerprint, undefined);
    assert.equal(snapshot.subscription, undefined);
    assert.equal(snapshot.quota.status, 'unknown');
    assert.equal(snapshot.quota.subscription, undefined);
    assert.deepEqual(snapshot.quota.windows, []);
    assert.equal(snapshot.status, change === 'signed-out' ? 'auth-required' : 'unknown');
    assert.equal(quotaReadingPending(snapshot), false, 'a completed identity check is not an in-flight quota read');
    assert.equal(snapshot.quota.observedAt, null, 'an identity mismatch must not become a trusted observation');
    assert.ok(!JSON.stringify(snapshot).includes('before@example.test'));
    assert.ok(!JSON.stringify(snapshot).includes('after@example.test'));
  });
}

test('one failed final account check is retried, so a hiccup does not wipe the same account quota', async () => {
  const status = {
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    email: 'same@example.test',
    orgId: 'fixture-org',
    subscriptionType: 'pro',
  };
  let initialized = false;
  let finalReads = 0;
  const child = fakeChild((packet, send) => {
    const request = packet.request as Record<string, unknown>;
    if (request.subtype === 'initialize') initialized = true;
    send({
      type: 'control_response',
      response: {
        request_id: packet.request_id,
        subtype: 'success',
        response:
          request.subtype === 'get_usage'
            ? { rate_limits_available: true, rate_limits: { five_hour: { utilization: 73 } } }
            : { models: [{ value: 'sonnet', supportedEffortLevels: ['high'] }] },
      },
    });
  });
  const adapter = createClaudeAdapter({
    spawn: async () => child,
    terminate: async () => {},
    capture: async () => {
      if (initialized && ++finalReads === 1) throw new Error('fixture timeout');
      return { stdout: JSON.stringify(status), exitCode: 0 };
    },
    profile: async () => ({}),
  });
  const snapshot = await adapter.discover(target);
  assert.equal(finalReads, 2);
  assert.ok(snapshot.accountFingerprint);
  assert.equal(snapshot.quota.status, 'known');
});

test('Claude usage separates current turn tokens from resumed session estimates', () => {
  const [tokens, cost] = claudeResultUsage(
    {
      usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 6, cache_creation_input_tokens: 2 },
      total_cost_usd: 0.25,
    },
    'session-1',
    false,
  );
  assert.equal(tokens?.scope, 'run-cumulative');
  assert.equal(tokens?.inputTokens, 10);
  assert.equal(tokens?.cacheReadTokens, 6);
  assert.equal(tokens?.coverage, 'main-agent-only');
  assert.equal(cost?.scope, 'session-cumulative');
  assert.equal(cost?.sessionId, 'session-1');
  assert.match(String(tokens?.note), /不包含子 Agent/);
  assert.equal(tokens?.totalTokens, 22);
  assert.equal(cost?.freshSession, false);
  assert.equal(cost?.estimatedCostUsd, 0.25);
  assert.deepEqual(claudeResultUsage({ usage: { input_tokens: -1 }, total_cost_usd: NaN }), []);
});

for (const streamed of [false, true])
  test(`Claude text blocks keep distinct item IDs and contiguous deltas (streamed=${streamed})`, async (t) => {
    const events: RunEvent[] = [];
    const folder = await mkdtemp(join(tmpdir(), 'claude-blocks-'));
    const path = join(folder, 'returned.txt');
    await writeFile(path, 'synthetic');
    t.after(async () => {
      await unlink(path);
      await rmdir(folder);
    });
    const blocks = ['Here is the file.', `PUGPORT_SEND_FILE: ${path}`];
    const child = fakeChild((packet, send) => {
      if (packet.type === 'control_request')
        send({
          type: 'control_response',
          response: { request_id: packet.request_id, subtype: 'success', response: {} },
        });
      if (packet.type !== 'user') return;
      if (streamed) {
        send({ type: 'stream_event', event: { type: 'message_start' } });
        for (const [index, block] of blocks.entries()) {
          send({ type: 'stream_event', event: { type: 'content_block_start', index } });
          for (const text of [block.slice(0, 5), block.slice(5)])
            send({
              type: 'stream_event',
              event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
            });
        }
      }
      send({ type: 'assistant', message: { content: blocks.map((text) => ({ type: 'text', text })) } });
      send({ type: 'result', subtype: 'success', result: blocks.join('\n') });
    });
    const adapter = createClaudeAdapter({ spawn: async () => child, terminate: async () => undefined });
    await adapter.execute(context({ emit: (event) => events.push(event) }));
    const texts = events.filter((event) => event.type === 'text');
    assert.equal(texts.map((event) => event.text).join(''), blocks.join(''));
    assert.notEqual(texts[0]!.data?.itemId, texts.at(-1)!.data?.itemId);
    if (streamed) {
      assert.equal(texts[0]!.data?.itemId, texts[1]!.data?.itemId);
      assert.equal(texts[2]!.data?.itemId, texts[3]!.data?.itemId);
    }
    const tasks = {
      find: () => ({ runIds: ['synthetic'] }),
      workspace: { controller: { runWithAudit: () => ({ events }) } },
    } as unknown as ExternalTasks;
    const outputs = ExternalTasks.prototype.fullOutputs.call(tasks, 'synthetic');
    assert.deepEqual(outputs, [blocks.join('\n')]);
    const returned = await collectReturnFiles(outputs, false);
    assert.deepEqual(returned.refused, []);
    assert.equal(returned.files[0]?.name, 'returned.txt');
  });

test('Claude streams once, forwards approval denials, restores a session, and emits usage', async () => {
  const account = {
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    email: 'first@example.test',
    orgId: 'org-one',
  };
  const events: RunEvent[] = [];
  let permissionResponse: Record<string, unknown> | undefined;
  let args: string[] = [];
  const child = fakeChild((packet, send) => {
    if (packet.type === 'control_request')
      send({ type: 'control_response', response: { request_id: packet.request_id, subtype: 'success', response: {} } });
    if (packet.type === 'user') {
      send({ type: 'system', subtype: 'init', session_id: 'session-1' });
      send({ type: 'stream_event', event: { type: 'message_start' } });
      send({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
      });
      send({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } });
      send({
        type: 'control_request',
        request_id: 'approval-1',
        request: { subtype: 'can_use_tool', tool_name: 'Read', input: { file_path: 'README.md' } },
      });
    }
    if (packet.type === 'control_response') {
      permissionResponse = packet.response as Record<string, unknown>;
      send({ type: 'result', subtype: 'success', result: 'Hello', session_id: 'session-1', total_cost_usd: 0.1 });
    }
  });
  const adapter = createClaudeAdapter({
    capture: async (_target, args) => {
      assert.deepEqual(args, ['auth', 'status']);
      return { stdout: JSON.stringify(account), exitCode: 0 };
    },
    spawn: async (_target, inputArgs) => {
      args = inputArgs;
      return child;
    },
    terminate: async () => undefined,
  });
  let promptDescription = '';
  const result = await adapter.execute(
    context({
      nativeSessionId: 'session-1',
      route: { ...context().route, accountFingerprint: claudeAccountFingerprint(account) },
      emit: (event) => events.push(event),
      approve: async (_tool, description) => {
        promptDescription = description;
        return false;
      },
    }),
  );
  assert.equal(result.output, 'Hello');
  assert.equal(result.nativeSessionId, 'session-1');
  assert.equal((permissionResponse?.response as Record<string, unknown>)?.behavior, 'deny');
  assert.match(promptDescription, /README\.md/);
  assert.ok(args.includes('--resume'));
  assert.equal(events.filter((event) => event.type === 'text').length, 1);
  assert.equal(events.find((event) => event.type === 'usage')?.data?.cumulative, true);
});

test('Claude sends structured keys only for supported commands and file edits and allows each request individually', async () => {
  const requests = [
    { tool: 'Bash', input: { command: 'npm test --watch' }, key: { tool: 'Bash', command: 'npm test --watch' } },
    { tool: 'Bash', input: { command: 'node -e code' }, key: undefined },
    { tool: 'Bash', input: { command: 'CI=true npm test' }, key: undefined },
    {
      tool: 'Bash',
      input: { command: 'timeout 60 npm test' },
      key: { tool: 'Bash', command: 'timeout 60 npm test' },
    },
    { tool: 'Bash', input: { command: 'npm run build' }, key: { tool: 'Bash', command: 'npm run build' } },
    ...['Edit', 'Write', 'MultiEdit'].map((tool) => ({
      tool,
      input: { file_path: join(process.cwd(), 'src/a.ts') },
      key: { tool, paths: [join(process.cwd(), 'src/a.ts')] },
    })),
    {
      tool: 'NotebookEdit',
      input: { notebook_path: join(process.cwd(), 'book.ipynb') },
      key: { tool: 'NotebookEdit', paths: [join(process.cwd(), 'book.ipynb')] },
    },
    ...['~/.bashrc', ' C:\\Windows\\x', 'src/a.ts'].map((file_path) => ({
      tool: 'Write',
      input: { file_path },
      key: undefined,
    })),
    { tool: 'Read', input: { file_path: join(process.cwd(), 'src/a.ts') }, key: undefined },
  ];
  let index = 0;
  const keys: Array<ApprovalKey | undefined> = [];
  const request = (send: (packet: unknown) => void) =>
    send({
      type: 'control_request',
      request_id: `approval-${index}`,
      request: { subtype: 'can_use_tool', tool_name: requests[index].tool, input: requests[index].input },
    });
  const child = fakeChild((packet, send) => {
    if (packet.type === 'control_request')
      send({ type: 'control_response', response: { request_id: packet.request_id, subtype: 'success', response: {} } });
    if (packet.type === 'user') request(send);
    if (packet.type === 'control_response') {
      const response = (packet.response as Record<string, unknown>).response as Record<string, unknown>;
      assert.equal(response.behavior, 'allow');
      assert.deepEqual(response.updatedInput, requests[index].input);
      assert.equal(response.updatedPermissions, undefined);
      index++;
      if (index < requests.length) request(send);
      else send({ type: 'result', subtype: 'success', result: 'Done', session_id: 'fixture-session' });
    }
  });
  const adapter = createClaudeAdapter({ spawn: async () => child, terminate: async () => {} });
  await adapter.execute(
    context({
      approve: async (_tool, _description, key) => {
        keys.push(key);
        return true;
      },
    }),
  );
  assert.equal(index, requests.length);
  assert.deepEqual(
    keys,
    requests.map((request) => request.key),
  );
});

test('Claude context uses root messages, ignores repeats and synthetic errors, and preserves later blocks', async () => {
  for (const model of ['sonnet', 'sonnet[1m]']) {
    const events: RunEvent[] = [];
    const child = fakeChild((packet, send) => {
      if (packet.type === 'control_request')
        send({
          type: 'control_response',
          response: { request_id: packet.request_id, subtype: 'success', response: {} },
        });
      if (packet.type !== 'user') return;
      for (const [index, input] of [10, 20, 30].entries()) {
        send({
          type: 'assistant',
          message: {
            id: `message-${index}`,
            model: 'claude-sonnet-5-5',
            usage: {
              input_tokens: input,
              cache_read_input_tokens: 100,
              cache_creation_input_tokens: 5,
              output_tokens: 99,
            },
            content: [{ type: 'tool_use', id: `tool-${index}`, name: 'Read', input: {} }],
          },
        });
        send({
          type: 'assistant',
          message: {
            id: `message-${index}`,
            model: 'claude-sonnet-5-5',
            usage: { input_tokens: input, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 },
            content: [{ type: 'text', text: `Later block ${index}` }],
          },
        });
        send({
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: `tool-${index}`, content: 'Fixture result' }] },
        });
      }
      for (const extra of [{ isReplay: true }, { parent_tool_use_id: 'subagent' }])
        send({ type: 'assistant', ...extra, message: { usage: { input_tokens: 999 }, content: [] } });
      send({
        type: 'assistant',
        message: {
          id: 'synthetic-error',
          model: '<synthetic>',
          usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          content: [{ type: 'text', text: 'Prompt is too long' }],
        },
      });
      send({
        type: 'result',
        subtype: 'success',
        result: 'Done',
        usage: { input_tokens: 60, cache_read_input_tokens: 300, cache_creation_input_tokens: 15 },
        // The CLI names each model's real window only here; the subagent's smaller model must not win.
        modelUsage: {
          'claude-haiku-4-5': { contextWindow: 200000 },
          'claude-sonnet-5-5': { contextWindow: 1000000 },
        },
      });
    });
    const adapter = createClaudeAdapter({ spawn: async () => child, terminate: async () => undefined });
    await adapter.execute(context({ route: { ...context().route, model }, emit: (event) => events.push(event) }));
    const snapshots = events
      .map((event) => contextFromEvent('claude', model, event))
      .filter((value) => value !== undefined);
    const first = model === 'sonnet';
    // Three root messages; the first run repeats the last one once the result names the window, and later runs
    // already know it. No 200K guess is made before that.
    assert.equal(snapshots.length, first ? 4 : 3);
    assert.equal(snapshots.at(-1)?.tokens, 135);
    assert.equal(snapshots.at(-1)?.window, 1000000);
    assert.equal(snapshots[0]?.window, first ? undefined : 1000000);
    assert.ok(events.some((event) => event.type === 'text' && event.text === 'Later block 2'));
    assert.ok(events.some((event) => event.type === 'text' && event.text === 'Prompt is too long'));
    assert.ok(events.some((event) => event.type === 'usage' && event.data?.inputTokens === 60));
  }
});

test('Claude rejects a stale account identity before spawning a native model session', async () => {
  const old = {
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    email: 'first@example.test',
    orgId: 'org-one',
  };
  let spawned = false;
  const adapter = createClaudeAdapter({
    capture: async () => ({ stdout: JSON.stringify({ ...old, email: 'second@example.test' }), exitCode: 0 }),
    spawn: async () => {
      spawned = true;
      throw Error('Must not reach model spawn');
    },
  });
  await assert.rejects(
    adapter.execute(
      context({
        nativeSessionId: 'private-old-session',
        route: { ...context().route, accountFingerprint: claudeAccountFingerprint(old) },
      }),
    ),
    { message: 'native-session-identity-changed' },
  );
  assert.equal(spawned, false);
  assert.equal(redactError(new Error('native-session-identity-changed')), 'native-session-identity-changed');
});

test('Claude refuses unverified or unavailable current identity before resuming and preserves a sanitized error', async () => {
  for (const payload of [
    undefined,
    { loggedIn: false },
    { loggedIn: true, authMethod: 'api_key', email: 'api@example.test' },
  ]) {
    let spawned = false;
    const adapter = createClaudeAdapter({
      capture: async () => {
        if (!payload) throw Error('Sensitive raw authentication diagnostic');
        return { stdout: JSON.stringify(payload), exitCode: 0 };
      },
      spawn: async () => {
        spawned = true;
        throw Error('Must not reach model spawn');
      },
    });
    await assert.rejects(
      adapter.execute(
        context({ nativeSessionId: 'old-session', route: { ...context().route, accountFingerprint: 'saved-account' } }),
      ),
      { message: 'native-session-identity-unverified' },
    );
    assert.equal(spawned, false);
  }
  assert.equal(redactError(new Error('native-session-identity-unverified')), 'native-session-identity-unverified');
});

test('Claude cancellation terminates only its owned child and rejects execution', async () => {
  const controller = new AbortController();
  let terminated = 0;
  const child = fakeChild((packet, send) => {
    if (packet.type === 'control_request')
      send({ type: 'control_response', response: { request_id: packet.request_id, subtype: 'success', response: {} } });
    if (packet.type === 'user') controller.abort();
  });
  const adapter = createClaudeAdapter({
    capture: async () => assert.fail('new sessions must not pay for an extra resume identity lookup'),
    spawn: async () => child,
    terminate: async (owned) => {
      assert.equal(owned, child);
      terminated++;
      child.stdin.end();
    },
  });
  await assert.rejects(adapter.execute(context({ signal: controller.signal })), /cancelled/);
  assert.ok(terminated >= 1);
});

test('Claude unexpected interactive requests in automatic mode are denied without claiming user rejection', async () => {
  const events: RunEvent[] = [];
  let hostCalls = 0;
  const child = fakeChild((packet, send) => {
    if (packet.type === 'control_request')
      send({ type: 'control_response', response: { request_id: packet.request_id, subtype: 'success', response: {} } });
    if (packet.type === 'user')
      send({
        type: 'control_request',
        request_id: 'unexpected',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'outside-project-command' } },
      });
    if (packet.type === 'control_response') {
      const response = (packet.response as Record<string, unknown>).response as Record<string, unknown>;
      assert.equal(response.behavior, 'deny');
      assert.match(String(response.message), /automatic mode/);
      assert.doesNotMatch(String(response.message), /user denied/);
      send({ type: 'result', subtype: 'success', result: 'Continued inside current permissions.' });
    }
  });
  const adapter = createClaudeAdapter({ spawn: async () => child, terminate: async () => undefined });
  await adapter.execute(
    context({
      approvalMode: 'auto',
      emit: (event) => events.push(event),
      approve: async () => {
        hostCalls++;
        return true;
      },
    }),
  );
  assert.equal(hostCalls, 0);
  assert.ok(events.some((event) => event.data?.decision === 'deny'));
});

test('Claude native automatic denials surface sanitized reasons and do not duplicate result denials', async () => {
  const events: RunEvent[] = [];
  const child = fakeChild((packet, send) => {
    if (packet.type === 'control_request')
      send({ type: 'control_response', response: { request_id: packet.request_id, subtype: 'success', response: {} } });
    if (packet.type === 'user') {
      send({ type: 'system', subtype: 'init', permissionMode: 'auto' });
      send({
        type: 'system',
        subtype: 'permission_denied',
        tool_name: 'Bash',
        tool_use_id: 'denied-1',
        decision_reason_type: 'classifier',
        decision_reason: 'Blocked destructive operation token=must-not-leak',
        message: 'Permission denied',
      });
      send({
        type: 'result',
        subtype: 'success',
        result: 'Could not perform the blocked operation.',
        permission_denials: [
          { tool_name: 'Bash', tool_use_id: 'denied-1', tool_input: { secret: 'must-not-leak' } },
          { tool_name: 'Write', tool_use_id: 'denied-2' },
        ],
      });
    }
  });
  const adapter = createClaudeAdapter({ spawn: async () => child, terminate: async () => undefined });
  await adapter.execute(context({ approvalMode: 'auto', emit: (event) => events.push(event) }));
  const denied = events.filter((event) => event.data?.decision === 'deny');
  assert.equal(denied.length, 2);
  assert.match(denied[0]?.text ?? '', /Blocked destructive operation/);
  assert.equal(denied[0]?.data?.reasonType, 'classifier');
  assert.equal(denied[0]?.data?.toolCallId, 'denied-1');
  assert.equal(denied[0]?.data?.nativeMethod, 'system/permission_denied');
  assert.equal(denied[1]?.data?.toolCallId, 'denied-2');
  assert.equal(denied[1]?.data?.nativeMethod, 'result/permission_denials');
  const configs = events
    .filter((event) => event.data?.kind === 'permission-config')
    .map((event) => event.data?.detail as Record<string, unknown>);
  assert.equal(configs.find((detail) => detail.provenance === 'requested')?.permissionMode, 'auto');
  assert.equal(configs.find((detail) => detail.provenance === 'observed')?.permissionMode, 'auto');
  assert.ok(!JSON.stringify(events).includes('must-not-leak'));
});

test('Claude live tool results retain safe display fields and settled progress without exposing native hidden fields or secrets', async (t) => {
  const scenarios: Array<{
    name: string;
    tool: string;
    result?: Record<string, unknown>;
    error?: unknown;
    background?: boolean;
    replay?: boolean;
    orphan?: boolean;
    deny?: boolean;
    expected: boolean;
    readOnlyExpected?: boolean;
  }> = [
    { name: 'read', tool: 'Read', expected: true },
    { name: 'foreground shell', tool: 'Bash', result: { interrupted: false }, expected: true },
    {
      name: 'failed shell',
      tool: 'Bash',
      result: { interrupted: false },
      error: true,
      expected: false,
      readOnlyExpected: true,
    },
    { name: 'interrupted shell', tool: 'Bash', result: { interrupted: true }, expected: false, readOnlyExpected: true },
    { name: 'read-only bridge failure', tool: 'mcp__pugport__read_document', error: true, expected: true },
    {
      name: 'write bridge failure',
      tool: 'mcp__pugport__organize_files',
      error: true,
      expected: false,
      readOnlyExpected: true,
    },
    {
      name: 'requested background shell',
      tool: 'Bash',
      background: true,
      result: { interrupted: false },
      expected: false,
    },
    {
      name: 'auto background shell',
      tool: 'Bash',
      result: { interrupted: false, backgroundTaskId: 'background-task' },
      expected: false,
    },
    {
      name: 'manually backgrounded shell',
      tool: 'Bash',
      result: { interrupted: false, backgroundedByUser: true },
      expected: false,
    },
    { name: 'timed out shell', tool: 'Bash', result: { interrupted: false, timedOutAfterMs: 1000 }, expected: false },
    { name: 'unknown shell metadata', tool: 'Bash', expected: false },
    {
      name: 'malformed background flag',
      tool: 'Bash',
      result: { interrupted: false, backgroundedByUser: 'true' },
      expected: false,
    },
    {
      name: 'malformed background identity',
      tool: 'Bash',
      result: { interrupted: false, backgroundTaskId: false },
      expected: false,
    },
    { name: 'native child agent', tool: 'Agent', expected: false },
    { name: 'unpaired result', tool: 'Read', orphan: true, expected: false },
    { name: 'replayed result', tool: 'Read', replay: true, expected: false },
    { name: 'invalid error flag', tool: 'Read', error: 'false', expected: false },
    { name: 'native denial even with a success result', tool: 'Read', deny: true, expected: false },
  ];
  for (const scenario of scenarios)
    await t.test(scenario.name, async () => {
      const events: RunEvent[] = [];
      const child = fakeChild((packet, send) => {
        if (packet.type === 'control_request')
          send({
            type: 'control_response',
            response: { request_id: packet.request_id, subtype: 'success', response: {} },
          });
        if (packet.type !== 'user') return;
        send({ type: 'system', subtype: 'init', session_id: 'fixture-session' });
        send({ type: 'system', subtype: 'compact_boundary', status: 'completed', content: 'PRIVATE_COMPACTION_BODY' });
        send({ type: 'new_native_control', payload: 'PRIVATE_CONTROL_BODY' });
        const start = (id: string, name: string, background = false) =>
          send({
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id,
                  name,
                  input: {
                    run_in_background: background,
                    file_path: 'README.md',
                    token: 'SECRET_INPUT',
                    reasoning: 'PRIVATE_NATIVE_REASONING',
                  },
                },
              ],
            },
          });
        const finish = (id: string, extra: Record<string, unknown> = {}) =>
          send({
            type: 'user',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: id,
                  content: 'never-expose-result',
                  ...(scenario.error === undefined ? {} : { is_error: scenario.error }),
                },
              ],
            },
            ...extra,
          });
        // A successful read prevents failure cases from passing merely because no work completed.
        start('good-read', 'Read');
        send({
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'good-read', content: 'never-expose-result' }],
          },
        });
        if (!scenario.orphan) start('subject', scenario.tool, scenario.background);
        if (scenario.deny)
          send({ type: 'system', subtype: 'permission_denied', tool_use_id: 'subject', tool_name: scenario.tool });
        finish('subject', {
          ...(scenario.replay ? { isReplay: true } : {}),
          ...(scenario.result ? { tool_use_result: scenario.result } : {}),
        });
        send({ type: 'result', subtype: 'success', result: 'The next batch remains.' });
      });
      const adapter = createClaudeAdapter({ spawn: async () => child, terminate: async () => undefined });
      const executed = await adapter.execute(context({ emit: (event) => events.push(event) }));
      const progress = new TaskContinuationProgress();
      for (const event of events) progress.observe(event);
      const run: RunRecord = {
        id: 'fixture',
        projectPath: process.cwd(),
        prompt: 'Continue authorized batches.',
        kind: 'general',
        status: 'failed',
        route: context().route,
        startedAt: new Date().toISOString(),
        nativeSessionId: executed.nativeSessionId,
        permissionMode: 'workspace-write',
        events,
        output: executed.output,
        taskOutcome: { source: 'executor-report', status: 'partial', summary: 'The next batch remains.' },
      };
      const budget = () => ({ count: 0, reports: new Set<string>(), tools: new Set<string>() });
      assert.equal(hasContinuationProgress(run, progress, budget()), scenario.expected);
      assert.equal(
        hasContinuationProgress({ ...run, permissionMode: 'read-only' }, progress, budget()),
        scenario.readOnlyExpected ?? scenario.expected,
      );
      assert.ok(
        events.some(
          (event) =>
            event.type === 'tool' && event.data?.toolCallId === 'good-read' && event.data.status === 'completed',
        ),
      );
      assert.match(JSON.stringify(events), /README.md/);
      assert.match(JSON.stringify(events), /never-expose-result/);
      assert.doesNotMatch(JSON.stringify(events), /SECRET_INPUT|PRIVATE_NATIVE_REASONING/);
      assert.ok(
        events.some(
          (event) =>
            event.data?.kind === 'protocol-observation' &&
            (event.data?.detail as Record<string, unknown>).subtype === 'compact_boundary',
        ),
      );
      assert.ok(
        events.some(
          (event) =>
            event.data?.kind === 'protocol-unmapped' &&
            (event.data?.detail as Record<string, unknown>).type === 'new_native_control',
        ),
      );
      assert.doesNotMatch(JSON.stringify(events), /PRIVATE_COMPACTION_BODY|PRIVATE_CONTROL_BODY/);
      const subject = events.filter((event) => event.type === 'tool' && event.data?.toolCallId === 'subject');
      if (scenario.orphan || (scenario.error !== undefined && typeof scenario.error !== 'boolean')) {
        const observed = subject.at(-1);
        assert.equal(
          observed?.data?.output,
          'never-expose-result',
          'an observed result is retained even without trustworthy lifecycle flags',
        );
        assert.equal(observed?.data?.status, 'unknown');
        assert.equal(observed?.data?.resultObserved, true);
        if (scenario.orphan) assert.equal(observed?.data?.startUnknown, true);
        else assert.equal(observed?.data?.malformedErrorFlag, true);
      }
    });
});

test('Claude refuses a native downgrade from requested auto to manual instead of silently blocking every tool', async () => {
  const events: RunEvent[] = [];
  const child = fakeChild((packet, send) => {
    if (packet.type === 'control_request')
      send({ type: 'control_response', response: { request_id: packet.request_id, subtype: 'success', response: {} } });
    if (packet.type === 'user') send({ type: 'system', subtype: 'init', permissionMode: 'default' });
  });
  const adapter = createClaudeAdapter({ spawn: async () => child, terminate: async () => undefined });
  await assert.rejects(
    adapter.execute(context({ approvalMode: 'auto', emit: (event) => events.push(event) })),
    /runtime-permission-or-sandbox-error/,
  );
  assert.match(events.find((event) => event.type === 'status' && !event.data?.kind)?.text ?? '', /未启用自动审批/);
});

test('Claude accepts the bypass it requested for a device write and still refuses a downgrade to auto', async () => {
  for (const observed of ['bypassPermissions', 'auto']) {
    const child = fakeChild((packet, send) => {
      if (packet.type === 'control_request')
        send({
          type: 'control_response',
          response: { request_id: packet.request_id, subtype: 'success', response: {} },
        });
      if (packet.type === 'user') {
        send({ type: 'system', subtype: 'init', permissionMode: observed });
        send({ type: 'result', subtype: 'success', result: 'Synthetic device work done.' });
      }
    });
    const adapter = createClaudeAdapter({ spawn: async () => child, terminate: async () => undefined });
    const ctx = context({ approvalMode: 'auto' });
    ctx.trustedProject = true;
    ctx.input.permissionMode = 'workspace-write';
    ctx.input.permissionOrigin = { mode: 'workspace-write', source: 'device' };
    if (observed === 'auto') await assert.rejects(adapter.execute(ctx), /runtime-permission-or-sandbox-error/);
    else await adapter.execute(ctx);
  }
});

test('Claude sends attached images as actual native content in read-only mode and rejects unreadable or oversized data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'comborunner-claude-image-'));
  const path = join(directory, 'image.png');
  // Managed attachment validation checks image signatures before this adapter is called.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR2UAAAAASUVORK5CYII=',
    'base64',
  );
  await writeFile(path, png);
  const ctx = context({ approvalMode: 'auto' });
  ctx.input.attachments = [
    { id: 'picture', name: 'image.png', mimeType: 'image/png', kind: 'image', size: png.length, path },
  ];
  let seenContent: unknown;
  const child = fakeChild((packet, send) => {
    if (packet.type === 'control_request')
      send({ type: 'control_response', response: { request_id: packet.request_id, subtype: 'success', response: {} } });
    if (packet.type === 'user') {
      seenContent = (packet.message as Record<string, unknown>).content;
      send({ type: 'result', subtype: 'success', result: 'Image received.' });
    }
  });
  const adapter = createClaudeAdapter({ spawn: async () => child, terminate: async () => undefined });
  try {
    assert.equal((await adapter.execute(ctx)).output, 'Image received.');
    assert.deepEqual(seenContent, [
      { type: 'text', text: 'Test prompt' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } },
    ]);
    assert.equal(await claudeUserContent(context()), 'Test prompt');
    ctx.input.attachments[0]!.mimeType = 'image/svg+xml';
    await assert.rejects(claudeUserContent(ctx), /不支持此图片格式/);
    ctx.input.attachments[0]!.mimeType = 'image/png';
    await writeFile(path, Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]));
    const notes: RunEvent[] = [];
    ctx.emit = (event) => {
      notes.push(event);
    };
    const oversized = await claudeUserContent(ctx);
    assert.ok(Array.isArray(oversized) && oversized.every((block) => block.type !== 'image'));
    assert.match(notes.at(-1)!.text!, /没有可用的缩图副本/);
    await unlink(path);
    await assert.rejects(claudeUserContent(ctx), /ENOENT/);
  } finally {
    await unlink(path).catch(() => {});
    await rmdir(directory);
  }
});

test('Claude interrupt-and-continue preserves its process/session and waits for the acknowledged continuation result', async () => {
  const users: Record<string, unknown>[] = [];
  const controls: Record<string, unknown>[] = [];
  const events: RunEvent[] = [];
  let sendNative!: (packet: unknown) => void;
  let handler: ((prompt: string) => Promise<void>) | undefined;
  let ready!: (handler: (prompt: string) => Promise<void>) => void;
  const available = new Promise<(prompt: string) => Promise<void>>((resolve) => (ready = resolve));
  let spawned = 0;
  let finished = false;
  const child = fakeChild((packet, send) => {
    sendNative = send;
    if (packet.type === 'control_request') {
      controls.push(packet.request as Record<string, unknown>);
      const interrupt = (packet.request as Record<string, unknown>).subtype === 'interrupt';
      send({
        type: 'control_response',
        response: {
          request_id: packet.request_id,
          subtype: 'success',
          response: interrupt ? { still_queued: ['native-scheduled'] } : {},
        },
      });
      if (interrupt)
        send({
          type: 'result',
          subtype: 'success',
          uuid: 'interrupted-result',
          session_id: 'same-session',
          user_message_uuid: users[0]?.uuid,
          terminal_reason: 'aborted_streaming',
          usage: { input_tokens: 2, output_tokens: 3 },
          total_cost_usd: 0.1,
        });
    }
    if (packet.type === 'user') {
      users.push(packet);
      if (users.length === 1) {
        send({
          type: 'system',
          subtype: 'init',
          session_id: 'same-session',
          claude_code_version: '2.1.281',
          capabilities: ['interrupt_receipt_v1'],
        });
        send({ type: 'stream_event', user_message_uuid: packet.uuid, event: { type: 'message_start' } });
        send({
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Original. ' } },
        });
      } else send({ ...packet, type: 'user', isReplay: true });
    }
  });
  const adapter = createClaudeAdapter({
    spawn: async (_target, args) => {
      spawned++;
      assert.ok(args.includes('--replay-user-messages'));
      return child;
    },
    terminate: async () => undefined,
  });
  const execution = adapter
    .execute(
      context({
        emit: (event) => events.push(event),
        registerSteer: (next) => {
          handler = next;
          if (next) ready(next);
        },
      }),
    )
    .then((result) => {
      finished = true;
      return result;
    });
  const steer = await available;
  await steer('Focus on the failing test.');
  assert.equal(finished, false);
  assert.equal(child.stdin.writableEnded, false);
  assert.equal(handler, undefined);
  assert.equal(users.length, 2);
  assert.deepEqual(controls, [{ subtype: 'initialize' }, { subtype: 'interrupt' }]);
  assert.equal(users[1]?.session_id, 'same-session');
  assert.notEqual(users[1]?.uuid, users[0]?.uuid);
  assert.equal(users[1]?.client_composed, true);
  assert.deepEqual(users[1]?.origin, { kind: 'human' });
  assert.deepEqual(users[1]?.message, { role: 'user', content: 'Focus on the failing test.' });
  assert.equal(users[1]?.model, undefined);
  assert.equal(users[1]?.permissionMode, undefined);
  sendNative({ type: 'stream_event', user_message_uuid: users[1]?.uuid, event: { type: 'message_start' } });
  assert.equal(typeof handler, 'function');
  sendNative({
    type: 'result',
    subtype: 'success',
    uuid: 'foreign-result',
    user_message_uuid: 'native-scheduled',
    result: 'Unrelated native work must not replace the continuation.',
  });
  assert.equal(finished, false);
  sendNative({
    type: 'result',
    subtype: 'success',
    uuid: 'continued-result',
    session_id: 'same-session',
    user_message_uuids: [users[0]?.uuid, users[1]?.uuid],
    result: 'Continued.',
    usage: { input_tokens: 10, output_tokens: 4 },
    total_cost_usd: 0.2,
  });
  const result = await execution;
  assert.equal(result.output, 'Original. Continued.');
  assert.equal(result.nativeSessionId, 'same-session');
  assert.equal(spawned, 1);
  assert.equal(handler, undefined);
  await assert.rejects(steer('Too late'), /runtime-steering-unavailable/);
  const tokens = events.filter((event) => event.type === 'usage' && event.data?.inputTokens !== undefined);
  assert.deepEqual(
    tokens.map((event) => event.data?.inputTokens),
    [2, 10],
  );
  assert.equal(new Set(tokens.map((event) => event.data?.eventId)).size, 2);
  assert.ok(tokens.every((event) => event.data?.scope === 'assistant-message' && event.data?.cumulative === false));
});

test('Claude only registers interrupt-and-continue on a capable modern CLI after the turn starts', async () => {
  for (const init of [
    { claude_code_version: '2.1.264', capabilities: ['interrupt_receipt_v1'] },
    { claude_code_version: '2.1.281', capabilities: [] },
    {},
  ]) {
    const registered: unknown[] = [];
    const child = fakeChild((packet, send) => {
      if (packet.type === 'control_request')
        send({
          type: 'control_response',
          response: { request_id: packet.request_id, subtype: 'success', response: {} },
        });
      if (packet.type === 'user') {
        send({ type: 'system', subtype: 'init', ...init });
        send({ type: 'stream_event', user_message_uuid: packet.uuid, event: { type: 'message_start' } });
        send({ type: 'result', subtype: 'success', result: 'Done.' });
      }
    });
    const adapter = createClaudeAdapter({ spawn: async () => child, terminate: async () => undefined });
    await adapter.execute(context({ registerSteer: (next) => registered.push(next) }));
    assert.ok(registered.every((next) => next === undefined));
  }
});

test('Claude rejected interrupt does not submit a continuation or replay the prompt', async () => {
  const users: Record<string, unknown>[] = [];
  let sendNative!: (packet: unknown) => void;
  let handler: ((prompt: string) => Promise<void>) | undefined;
  let ready!: (handler: (prompt: string) => Promise<void>) => void;
  const available = new Promise<(prompt: string) => Promise<void>>((resolve) => (ready = resolve));
  const child = fakeChild((packet, send) => {
    sendNative = send;
    if (packet.type === 'control_request') {
      const interrupt = (packet.request as Record<string, unknown>).subtype === 'interrupt';
      send({
        type: 'control_response',
        response: {
          request_id: packet.request_id,
          subtype: interrupt ? 'error' : 'success',
          response: {},
          error: 'unsupported interrupt token=secret-value',
        },
      });
    }
    if (packet.type === 'user') {
      users.push(packet);
      send({ type: 'system', subtype: 'init', claude_code_version: '2.1.281', capabilities: ['interrupt_receipt_v1'] });
      send({ type: 'stream_event', user_message_uuid: packet.uuid, event: { type: 'message_start' } });
    }
  });
  const adapter = createClaudeAdapter({ spawn: async () => child, terminate: async () => undefined });
  const execution = adapter.execute(
    context({
      registerSteer: (next) => {
        handler = next;
        if (next) ready(next);
      },
    }),
  );
  const steer = await available;
  await assert.rejects(steer('Change direction.'), (error: Error) => !error.message.includes('secret-value'));
  assert.equal(typeof handler, 'function');
  assert.equal(users.length, 1);
  sendNative({ type: 'result', subtype: 'success', result: 'Original completed.', user_message_uuid: users[0]?.uuid });
  assert.equal((await execution).output, 'Original completed.');
  assert.equal(handler, undefined);
});

test('Claude cancellation during interrupt unregisters steering and rejects concurrent or retained handlers', async () => {
  const controller = new AbortController();
  let handler: ((prompt: string) => Promise<void>) | undefined;
  let ready!: (handler: (prompt: string) => Promise<void>) => void;
  const available = new Promise<(prompt: string) => Promise<void>>((resolve) => (ready = resolve));
  let users = 0;
  const child = fakeChild((packet, send) => {
    if (packet.type === 'control_request' && (packet.request as Record<string, unknown>).subtype === 'initialize')
      send({ type: 'control_response', response: { request_id: packet.request_id, subtype: 'success', response: {} } });
    if (packet.type === 'user') {
      users++;
      send({ type: 'system', subtype: 'init', claude_code_version: '2.1.281', capabilities: ['interrupt_receipt_v1'] });
      send({ type: 'stream_event', user_message_uuid: packet.uuid, event: { type: 'message_start' } });
    }
  });
  const adapter = createClaudeAdapter({ spawn: async () => child, terminate: async () => undefined });
  const execution = adapter.execute(
    context({
      signal: controller.signal,
      registerSteer: (next) => {
        handler = next;
        if (next) ready(next);
      },
    }),
  );
  const failedExecution = assert.rejects(execution, /cancelled/);
  const steer = await available;
  const delivery = steer('Change direction.');
  const failedDelivery = assert.rejects(delivery, /cancelled/);
  assert.equal(handler, undefined);
  await assert.rejects(steer('Concurrent input.'), /runtime-steering-unavailable/);
  controller.abort();
  await Promise.all([failedExecution, failedDelivery]);
  assert.equal(handler, undefined);
  assert.equal(users, 1);
  await assert.rejects(steer('Too late.'), /runtime-steering-unavailable/);
});

test('Claude a capable initialization alone does not expose steering before the first turn starts', async () => {
  let sendNative!: (packet: unknown) => void;
  let userId: unknown;
  let handler: ((prompt: string) => Promise<void>) | undefined;
  let ready!: () => void;
  const initialized = new Promise<void>((resolve) => (ready = resolve));
  const child = fakeChild((packet, send) => {
    sendNative = send;
    if (packet.type === 'control_request')
      send({ type: 'control_response', response: { request_id: packet.request_id, subtype: 'success', response: {} } });
    if (packet.type === 'user') {
      userId = packet.uuid;
      send({ type: 'system', subtype: 'init', claude_code_version: '2.1.281', capabilities: ['interrupt_receipt_v1'] });
      ready();
    }
  });
  const adapter = createClaudeAdapter({ spawn: async () => child, terminate: async () => undefined });
  const execution = adapter.execute(context({ registerSteer: (next) => (handler = next) }));
  await initialized;
  assert.equal(handler, undefined);
  sendNative({ type: 'stream_event', user_message_uuid: userId, event: { type: 'message_start' } });
  assert.equal(typeof handler, 'function');
  sendNative({ type: 'result', subtype: 'success', result: 'Done.', user_message_uuid: userId });
  await execution;
  assert.equal(handler, undefined);
});

test('Claude aborts a steering transition with an uncorrelated result without submitting or replaying input', async () => {
  let ready!: (handler: (prompt: string) => Promise<void>) => void;
  const available = new Promise<(prompt: string) => Promise<void>>((resolve) => (ready = resolve));
  let users = 0;
  const child = fakeChild((packet, send) => {
    if (packet.type === 'control_request') {
      const interrupt = (packet.request as Record<string, unknown>).subtype === 'interrupt';
      send({
        type: 'control_response',
        response: {
          request_id: packet.request_id,
          subtype: 'success',
          response: interrupt ? { still_queued: [] } : {},
        },
      });
      if (interrupt) send({ type: 'result', subtype: 'success', terminal_reason: 'aborted_streaming' });
    }
    if (packet.type === 'user') {
      users++;
      send({ type: 'system', subtype: 'init', claude_code_version: '2.1.281', capabilities: ['interrupt_receipt_v1'] });
      send({ type: 'stream_event', user_message_uuid: packet.uuid, event: { type: 'message_start' } });
    }
  });
  const adapter = createClaudeAdapter({ spawn: async () => child, terminate: async () => undefined });
  const execution = adapter.execute(
    context({
      registerSteer: (next) => {
        if (next) ready(next);
      },
    }),
  );
  const failedExecution = assert.rejects(execution, /runtime-steering-result-identity-missing/);
  await assert.rejects((await available)('Change direction.'), /runtime-request-failed/);
  await failedExecution;
  assert.equal(users, 1);
});

test('Claude cancellation while waiting for continuation receipt fails ambiguous delivery without replay', async () => {
  const controller = new AbortController();
  let handler: ((prompt: string) => Promise<void>) | undefined;
  let ready!: (handler: (prompt: string) => Promise<void>) => void;
  const available = new Promise<(prompt: string) => Promise<void>>((resolve) => (ready = resolve));
  let received!: () => void;
  const submitted = new Promise<void>((resolve) => (received = resolve));
  const users: Record<string, unknown>[] = [];
  const child = fakeChild((packet, send) => {
    if (packet.type === 'control_request') {
      const interrupt = (packet.request as Record<string, unknown>).subtype === 'interrupt';
      send({
        type: 'control_response',
        response: {
          request_id: packet.request_id,
          subtype: 'success',
          response: interrupt ? { still_queued: [] } : {},
        },
      });
      if (interrupt)
        send({
          type: 'result',
          subtype: 'success',
          user_message_uuid: users[0]?.uuid,
          terminal_reason: 'aborted_tools',
        });
    }
    if (packet.type === 'user') {
      users.push(packet);
      if (users.length === 1) {
        send({
          type: 'system',
          subtype: 'init',
          claude_code_version: '2.1.281',
          capabilities: ['interrupt_receipt_v1'],
        });
        send({ type: 'stream_event', user_message_uuid: packet.uuid, event: { type: 'message_start' } });
      } else received();
    }
  });
  const adapter = createClaudeAdapter({ spawn: async () => child, terminate: async () => undefined });
  const execution = adapter.execute(
    context({
      signal: controller.signal,
      registerSteer: (next) => {
        handler = next;
        if (next) ready(next);
      },
    }),
  );
  const failedExecution = assert.rejects(execution, /cancelled/);
  const delivery = (await available)('Change direction.');
  const failedDelivery = assert.rejects(delivery, /cancelled/);
  await submitted;
  controller.abort();
  await Promise.all([failedExecution, failedDelivery]);
  assert.equal(handler, undefined);
  assert.equal(users.length, 2);
});

const missingSessionId = '3f1c2a9e-0000-4000-8000-000000000000';
const missingSessionAccount = {
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'synthetic@example.test',
  orgId: 'fixture',
};
const missingSessionText = `No conversation found with session ID: ${missingSessionId}`;
const missingSessionResult = {
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  num_turns: 0,
  total_cost_usd: 0,
  errors: [missingSessionText],
};

for (const source of [
  'errors',
  'empty-assistant',
  'stderr',
  'stdout-line',
  'stderr-close',
  'stderr-before-initialize',
  'result-before-initialize',
] as const)
  test(`Claude missing resume session: exact local fixture via ${source}`, async () => {
    const events: RunEvent[] = [];
    const child = fakeChild((packet, send) => {
      if (packet.type === 'control_request') {
        // As Claude Code 2.1 does: the error result on stdout and the line on stderr, then exit 1, unanswered.
        if (source === 'result-before-initialize') {
          send(missingSessionResult);
          (child.stderr as PassThrough).write(`${missingSessionText}\n`);
          Object.assign(child, { exitCode: 1 });
          child.emit('close', 1);
          return;
        }
        if (source === 'stderr-before-initialize') {
          (child.stderr as PassThrough).write(missingSessionText);
          Object.assign(child, { exitCode: 1 });
          child.emit('close', 1);
          return;
        }
        send({
          type: 'control_response',
          response: { request_id: packet.request_id, subtype: 'success', response: {} },
        });
      } else if (packet.type === 'user') {
        if (source === 'empty-assistant')
          send({ type: 'assistant', message: { content: [{ type: 'text', text: '' }] } });
        if (source.startsWith('stderr')) {
          (child.stderr as PassThrough).write('Unrelated diagnostic\nNo conversation fou');
          (child.stderr as PassThrough).write(`nd with session ID: ${missingSessionId}`);
        }
        if (source === 'stdout-line') (child.stdout as PassThrough).write(`${missingSessionText}\n`);
        if (source === 'stderr-close') {
          Object.assign(child, { exitCode: 1 });
          child.emit('close', 1);
        } else {
          send({
            ...missingSessionResult,
            errors: source === 'errors' || source === 'empty-assistant' ? [missingSessionText] : [],
            result: missingSessionText,
          });
          Object.assign(child, { exitCode: 1 });
          child.emit('close', 1);
        }
      }
    });
    const adapter = createClaudeAdapter({
      spawn: async () => child,
      terminate: async () => {},
      capture: async () => ({ stdout: JSON.stringify(missingSessionAccount), exitCode: 0 }),
    });
    await assert.rejects(
      adapter.execute(
        context({
          nativeSessionId: missingSessionId,
          route: { ...context().route, accountFingerprint: claudeAccountFingerprint(missingSessionAccount) },
          emit: (event) => events.push(event),
        }),
      ),
      { message: 'native-session-unavailable' },
    );
    assert.equal(
      events.some((event) => ['text', 'reasoning', 'tool'].includes(event.type)),
      false,
    );
    assert.ok(!JSON.stringify(events).includes('No conversation found'));
  });

for (const guard of [
  'no-resume',
  'other-subtype',
  'one-turn',
  'missing-turns',
  'other-error',
  'embedded-text',
  'assistant',
  'thinking',
  'stderr-one-turn',
  'usage-zero',
] as const)
  test(`Claude missing-session diagnostic preserves the guard: ${guard}`, async () => {
    const child = fakeChild((packet, send) => {
      if (packet.type === 'control_request')
        send({
          type: 'control_response',
          response: { request_id: packet.request_id, subtype: 'success', response: {} },
        });
      else if (packet.type === 'user') {
        if (guard === 'assistant' || guard === 'thinking')
          send({
            type: 'assistant',
            message: {
              content: [
                { type: guard === 'thinking' ? 'thinking' : 'text', text: 'Work happened', thinking: 'Work happened' },
              ],
            },
          });
        if (guard === 'stderr-one-turn') (child.stderr as PassThrough).write(`${missingSessionText}\n`);
        send({
          ...missingSessionResult,
          subtype: guard === 'other-subtype' ? 'error_max_turns' : missingSessionResult.subtype,
          num_turns:
            guard === 'one-turn' || guard === 'stderr-one-turn' || guard === 'usage-zero'
              ? 1
              : guard === 'missing-turns'
                ? undefined
                : 0,
          ...(guard === 'usage-zero'
            ? {
                usage: {
                  input_tokens: 0,
                  output_tokens: 0,
                  cache_read_input_tokens: 0,
                  cache_creation_input_tokens: 0,
                },
              }
            : {}),
          errors:
            guard === 'other-error'
              ? ['No conversation found for another reason']
              : guard === 'embedded-text'
                ? [`Quoted: ${missingSessionText}`]
                : [missingSessionText],
        });
      }
    });
    const adapter = createClaudeAdapter({
      spawn: async () => child,
      terminate: async () => {},
      capture: async () => ({ stdout: JSON.stringify(missingSessionAccount), exitCode: 0 }),
    });
    await assert.rejects(
      adapter.execute(
        context({
          nativeSessionId: guard === 'no-resume' ? undefined : missingSessionId,
          route: { ...context().route, accountFingerprint: claudeAccountFingerprint(missingSessionAccount) },
        }),
      ),
      {
        message: ['other-subtype', 'other-error', 'embedded-text', 'usage-zero'].includes(guard)
          ? 'native-session-unavailable'
          : 'runtime-request-failed',
      },
    );
  });

test('Claude empty resumed success ignores stale task notifications', async () => {
  const events: RunEvent[] = [];
  const child = fakeChild((packet, send) => {
    if (packet.type === 'control_request')
      send({ type: 'control_response', response: { request_id: packet.request_id, subtype: 'success', response: {} } });
    else if (packet.type === 'user') {
      for (let i = 0; i < 3; i++) send({ type: 'system', subtype: 'task_notification', status: 'stopped' });
      send({ type: 'result', subtype: 'success', result: '', num_turns: 0 });
      child.emit('close', 1);
    }
  });
  const adapter = createClaudeAdapter({
    spawn: async () => child,
    terminate: async () => {},
    capture: async () => ({ stdout: JSON.stringify(missingSessionAccount), exitCode: 0 }),
  });
  await assert.rejects(
    adapter.execute(
      context({
        nativeSessionId: missingSessionId,
        route: { ...context().route, accountFingerprint: claudeAccountFingerprint(missingSessionAccount) },
        emit: (event) => events.push(event),
      }),
    ),
    /native-session-unavailable/,
  );
  assert.ok(!events.some((event) => event.type === 'text' || event.type === 'tool'));
});

for (const variant of ['nonzero', 'zero', 'timeout', 'nonempty'] as const)
  test(`Claude fresh empty result waits for process close: ${variant}`, async () => {
    const child = fakeChild((packet, send) => {
      if (packet.type === 'control_request')
        send({
          type: 'control_response',
          response: { request_id: packet.request_id, subtype: 'success', response: {} },
        });
      else if (packet.type === 'user') {
        send({ type: 'system', subtype: 'init' });
        send({
          type: 'result',
          subtype: 'success',
          result: variant === 'nonempty' ? 'done' : '',
          num_turns: 0,
        });
        if (variant !== 'timeout') setTimeout(() => child.emit('close', variant === 'zero' ? 0 : 1), 20);
      }
    });
    const adapter = createClaudeAdapter({
      spawn: async () => child,
      terminate: async () => {},
      capture: async () => ({ stdout: JSON.stringify(missingSessionAccount), exitCode: 0 }),
    });
    const execution = adapter.execute(context());
    if (variant === 'nonzero')
      await assert.rejects(execution, (error: Error) => {
        assert.match(error.message, /Claude process closed \(1\)/);
        assert.equal(redactError(error), 'runtime-process-closed');
        return true;
      });
    else assert.equal((await execution).output, variant === 'nonempty' ? 'done' : '');
  });
test('Claude pre-approves read-only Git and GitHub in manual mode without approving other extensions', () => {
  const ctx = context({ approvalMode: 'ask' });
  ctx.agentBridge = {
    url: 'http://127.0.0.1:5555/agent',
    token: 'synthetic',
    extraTools: ['github_list_issues', 'some_ext'],
  };
  const args = claudeExecutionArgs(ctx, 'synthetic-mcp.json');
  const allowed = args[args.indexOf('--allowedTools') + 1]!.split(',');
  assert.ok(allowed.includes('mcp__pugport__git'));
  assert.ok(allowed.includes('mcp__pugport__github_list_issues'));
  assert.ok(!allowed.includes('mcp__pugport__some_ext'));
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep');
});

test('Claude protects sensitive paths in its memory settings and omits settings in tool-less modes', () => {
  const ctx = context();
  const noMemory = claudeExecutionArgs(ctx);
  assert.equal(noMemory.filter((arg) => arg === '--settings').length, 1);
  assert.ok(JSON.parse(noMemory[noMemory.indexOf('--settings') + 1]!).permissions.deny.includes('Edit(~/.ssh/**)'));
  assert.ok(JSON.parse(noMemory[noMemory.indexOf('--settings') + 1]!).permissions.deny.includes('Edit(~/.agents/**)'));
  assert.ok(
    JSON.parse(noMemory[noMemory.indexOf('--settings') + 1]!).permissions.deny.includes('Edit(~/.claude.json)'),
  );
  const directory = join(tmpdir(), 'synthetic project memory');
  ctx.input = { ...ctx.input, autoMemoryDirectory: directory };
  const args = claudeExecutionArgs(ctx);
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]!);
  assert.equal(settings.autoMemoryDirectory, directory);
  assert.ok(settings.permissions.deny.includes('Edit(~/.ssh/**)'));
  assert.equal(args.filter((arg) => arg === '--settings').length, 1);
  for (const flags of [{ untrustedContent: true }, { latencySensitiveChat: true }]) {
    assert.ok(!claudeExecutionArgs({ ...ctx, input: { ...ctx.input, ...flags } }).includes('--settings'));
  }
  for (const invalid of ['relative-memory', `${directory}\n--unsafe`, `${directory}\0`])
    assert.throws(
      () => claudeExecutionArgs({ ...ctx, input: { ...ctx.input, autoMemoryDirectory: invalid } }),
      /Invalid memory directory/,
    );
});
