import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import type { DiscoveryOptions, ExecuteContext, RunEvent, RuntimeTarget } from '../src/shared/types.js';
import { createGrokAdapter, grokExecutionArgs, grokModels, grokResultUsage } from '../src/server/adapters/grok.js';
import { grokAcpArgs, grokAcpSessionMeta } from '../src/server/adapters/grok-acp.ts';

const target: RuntimeTarget = {
  id: 'grok-test',
  provider: 'grok',
  label: 'Grok test',
  command: 'fixture',
  environment: 'native',
  enabled: true,
};
const passedVersion = (version: string): DiscoveryOptions => ({ grokHandshake: { lastPassedVersion: version } });
const ctx = (): ExecuteContext => ({
  target,
  input: {
    prompt: 'User prompt with $() and quotes "',
    projectPath: process.cwd(),
    kind: 'general',
    permissionMode: 'read-only',
  },
  route: { runtimeId: target.id, model: 'grok-4.7', effort: 'high', kind: 'general', reasons: [], warnings: [] },
  signal: new AbortController().signal,
  emit: () => undefined,
  approve: async () => {
    throw new Error('Headless Grok must not pretend to support host approval.');
  },
});

test('Grok model discovery does not invent efforts for custom IDs or count token totals as quota', async () => {
  const listing =
    'You are logged in with grok.com.\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.5\n  - custom-model\n';
  assert.deepEqual(
    grokModels(listing).map((row) => row.efforts),
    [['low', 'medium', 'high', 'xhigh'], ['low', 'medium', 'high'], []],
  );
  const adapter = createGrokAdapter({
    capture: async (_target, args) => ({ stdout: args[0] === '--version' ? 'grok 1.0.41' : listing, exitCode: 0 }),
    quota: async (runtime) => {
      assert.equal(runtime, target);
      return { status: 'unknown', source: 'Grok CLI _x.ai/billing', observedAt: null, windows: [] };
    },
  });
  const snapshot = await adapter.discover(target, passedVersion('1.0.41'));
  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.version, '1.0.41');
  assert.equal(snapshot.quota.status, 'unknown');
  assert.equal(snapshot.quota.observedAt, null);
  assert.equal(snapshot.capabilities.approvals, false);
  assert.equal(snapshot.accounting?.mode, 'subscription');
});

test('Grok expired authentication overrides a successful cached model listing without exposing diagnostics', async () => {
  const adapter = createGrokAdapter({
    capture: async (_target, args) =>
      args[0] === '--version'
        ? { stdout: 'grok 0.2.103', exitCode: 0 }
        : {
            stdout: 'You are logged in with grok.com.\nAvailable models:\n - grok-build (default)\n',
            exitCode: 0,
            diagnostic: 'authentication-required',
          },
    quota: async () => {
      throw new Error('Quota must not be requested for an expired login.');
    },
  });
  const snapshot = await adapter.discover(target, passedVersion('0.2.103'));
  assert.equal(snapshot.installed, true);
  assert.equal(snapshot.status, 'auth-required');
  assert.equal(snapshot.note, 'authentication-required');
  assert.equal(snapshot.models[0]?.id, 'grok-build');
  assert.equal(snapshot.accounting?.mode, 'unknown');
  assert.equal(snapshot.quota.status, 'unknown');
  assert.match(snapshot.quota.note ?? '', /重新登录/);
});

test('Grok failed metadata with a classified authentication error requests login', async () => {
  const adapter = createGrokAdapter({
    capture: async (_target, args) => {
      if (args[0] === '--version') return { stdout: 'grok 1.0.62', exitCode: 0 };
      throw new Error('authentication-required');
    },
  });
  const snapshot = await adapter.discover(target);
  assert.equal(snapshot.installed, true);
  assert.equal(snapshot.status, 'auth-required');
  assert.equal(snapshot.note, 'authentication-required');
  assert.match(snapshot.quota.note ?? '', /重新登录/);
});

test('Grok discovery uses this target billing allowance and keeps API credentials separate', async () => {
  let api = false,
    reads = 0;
  const quota = {
    status: 'known' as const,
    source: 'Grok CLI _x.ai/billing',
    observedAt: '2026-09-27T00:00:00Z',
    windows: [{ id: 'included', label: 'Weekly allowance', usedPercent: 12, resetsAt: null }],
  };
  const adapter = createGrokAdapter({
    capture: async (_target, args) => ({
      stdout:
        args[0] === '--version'
          ? 'grok 1.0.41'
          : `You are logged in with ${api ? 'an API key' : 'grok.com'}.\n - grok-4.7`,
      exitCode: 0,
    }),
    quota: async (runtime) => {
      assert.equal(runtime, target);
      reads++;
      return quota;
    },
  });
  assert.deepEqual((await adapter.discover(target, passedVersion('1.0.41'))).quota, quota);
  api = true;
  const snapshot = await adapter.discover(target, passedVersion('1.0.41'));
  assert.equal(snapshot.accounting?.mode, 'usage');
  assert.equal(snapshot.quota.status, 'unknown');
  assert.equal(reads, 1, 'API authentication cannot read another saved subscription allowance');
});

test('a quota collector failure does not turn successful subscription model discovery into a failed connection', async () => {
  const adapter = createGrokAdapter({
    capture: async (_target, args) => ({
      stdout: args[0] === '--version' ? 'grok 1.0.41' : 'You are logged in with grok.com.\n - grok-4.7',
      exitCode: 0,
    }),
    quota: async () => {
      throw new Error('sensitive private@example.invalid');
    },
  });
  const snapshot = await adapter.discover(target, passedVersion('1.0.41'));
  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.accounting?.mode, 'subscription');
  assert.equal(snapshot.quota.status, 'error');
  assert.equal(snapshot.models.length, 1);
  assert.ok(!JSON.stringify(snapshot).includes('private'));
});

test('Grok per-prompt usage preserves token buckets and only complete reported cost', () => {
  const usage = {
    input_tokens: 3,
    cache_read_input_tokens: 5,
    cache_creation_input_tokens: 2,
    output_tokens: 4,
    reasoning_tokens: 1,
    total_tokens: 14,
  };
  const complete = grokResultUsage({ usage, total_cost_usd: 0.01, total_cost_usd_ticks: 100000000 });
  assert.equal(complete?.scope, 'run-cumulative');
  assert.equal(complete?.inputTokens, 3);
  assert.equal(complete?.totalTokens, 14);
  assert.equal(complete?.costUsd, 0.01);
  assert.equal(complete?.costKind, 'reported');
  for (const flag of ['cost_is_partial', 'usage_is_incomplete']) {
    const partial = grokResultUsage({ usage, [flag]: true, total_cost_usd: 99 });
    assert.equal(partial?.costUsd, undefined);
    assert.equal(partial?.incomplete, true);
    assert.equal(partial?.outputTokens, 4);
  }
  assert.equal(grokResultUsage({}), undefined);
});

test('Grok read-only arguments cannot enable bypass or restore code on resume', () => {
  const context = ctx();
  context.nativeSessionId = 'session-1';
  const args = grokExecutionArgs(context, 'prompt.txt', 'new-session');
  assert.ok(args.includes('dontAsk'));
  assert.ok(args.includes('Read,Grep'));
  assert.ok(args.includes('--resume'));
  assert.ok(!args.includes('--always-approve'));
  assert.ok(!args.includes('--restore-code'));
  assert.ok(!args.includes('--session-id'));
  assert.ok(!args.includes(context.input.prompt));
});

test('Grok automatic mode delegates to native auto without expanding the read-only tool boundary', () => {
  const context = ctx();
  context.approvalMode = 'auto';
  const readonly = grokExecutionArgs(context, 'prompt.txt', 'new-session');
  assert.equal(readonly[readonly.indexOf('--permission-mode') + 1], 'auto');
  assert.equal(readonly[readonly.indexOf('--tools') + 1], 'Read,Grep');
  for (const tool of ['Edit', 'Bash', 'MCPTool']) {
    assert.ok(readonly.some((value, index) => value === '--deny' && readonly[index + 1] === tool));
  }
  context.input.permissionMode = 'workspace-write';
  const writable = grokExecutionArgs(context, 'prompt.txt', 'new-session');
  assert.equal(writable[writable.indexOf('--permission-mode') + 1], 'auto');
  assert.ok(!writable.includes('--allow'), 'write mode must use native classification, not a blanket allow rule');
  for (const args of [readonly, writable]) {
    for (const forbidden of ['--always-approve', '--yolo', 'bypassPermissions', '--sandbox'])
      assert.ok(!args.includes(forbidden));
  }
  context.approvalMode = 'ask';
  const manual = grokExecutionArgs(context, 'prompt.txt', 'new-session');
  assert.equal(manual[manual.indexOf('--permission-mode') + 1], 'dontAsk');
});

test('Grok bypasses its classifier only for a device write task on this computer', () => {
  const mode = (change: (context: ExecuteContext) => void) => {
    const context = ctx();
    context.approvalMode = 'auto';
    context.trustedProject = true;
    context.input.permissionMode = 'workspace-write';
    context.input.permissionOrigin = { mode: 'workspace-write', source: 'device' };
    change(context);
    const args = grokExecutionArgs(context, 'prompt.txt', 'new-session');
    const acp = grokAcpArgs(context);
    const mode = args[args.indexOf('--permission-mode') + 1];
    assert.equal(acp[acp.indexOf('--permission-mode') + 1], mode);
    const meta = grokAcpSessionMeta(context);
    assert.equal(meta.yoloMode, mode === 'bypassPermissions');
    assert.equal(meta.autoMode, mode === 'auto');
    assert.equal((meta.agentProfile as { permissionMode?: string }).permissionMode, mode);
    return mode;
  };
  assert.equal(
    mode(() => {}),
    'bypassPermissions',
  );
  assert.equal(
    mode((context) => (context.input.permissionOrigin = { mode: 'workspace-write', source: 'user' })),
    'auto',
  );
  assert.equal(
    mode((context) => (context.trustedProject = false)),
    'auto',
  );
  assert.equal(
    mode((context) => (context.approvalMode = 'ask')),
    'dontAsk',
  );
});

for (const approvalMode of ['auto', 'ask'] as const)
  test(`Grok ${approvalMode} streams without a host approval, preserves the session, and cleans its prompt file`, async () => {
    const events: RunEvent[] = [];
    let savedPrompt = '';
    let promptPath = '';
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null,
    }) as unknown as ChildProcessWithoutNullStreams;
    child.stdin.on('finish', () => {
      for (const packet of [
        { type: 'stream_event', event: { type: 'message_start' } },
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: {
              type: 'tool_use',
              id: 'read-1',
              name: 'Read',
              input: { file: 'private-input' },
            },
          },
        },
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'read-1', name: 'Read' }] } },
        {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'private-result' }] },
        },
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'bash-1', name: 'Bash' }] } },
        {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'bash-1', content: 'background task started' }] },
        },
        { type: 'result', subtype: 'success', result: 'Hello', total_cost_usd: 0.01 },
      ])
        (child.stdout as PassThrough).write(`${JSON.stringify(packet)}\n`);
      child.emit('close', 0);
    });
    const adapter = createGrokAdapter({
      spawn: async (_target, args) => {
        assert.equal(args[args.indexOf('--permission-mode') + 1], approvalMode === 'auto' ? 'auto' : 'dontAsk');
        promptPath = args[args.indexOf('--prompt-file') + 1]!;
        savedPrompt = await readFile(promptPath, 'utf8');
        return child;
      },
      targetPath: async (_target, file) => file,
      terminate: async () => undefined,
    });
    const context = ctx();
    context.approvalMode = approvalMode;
    context.emit = (event) => events.push(event);
    context.nativeSessionId = 'session-1';
    const result = await adapter.execute(context);
    assert.equal(savedPrompt, context.input.prompt);
    assert.equal(result.output, 'Hello');
    assert.equal(result.nativeSessionId, 'session-1');
    assert.equal(events.filter((event) => event.type === 'text').length, 1);
    assert.deepEqual(
      events.filter((event) => event.type === 'tool').map((event) => [event.data?.toolCallId, event.data?.status]),
      [
        ['read-1', 'inProgress'],
        ['read-1', 'completed'],
        ['bash-1', 'inProgress'],
        ['bash-1', 'unknown'],
      ],
    );
    assert.ok(JSON.stringify(events).includes('private-input'));
    assert.ok(JSON.stringify(events).includes('private-result'));
    assert.match(
      events.find((event) => event.type === 'status' && !event.data?.kind)?.text ?? '',
      approvalMode === 'auto' ? /原生 auto/ : /dontAsk/,
    );
    await assert.rejects(access(promptPath));
  });

test('Grok cancellation rejects and terminates the owned process', async () => {
  const controller = new AbortController();
  let terminated = 0;
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null,
  }) as unknown as ChildProcessWithoutNullStreams;
  child.stdin.on('finish', () => controller.abort());
  const adapter = createGrokAdapter({
    spawn: async () => child,
    targetPath: async (_target, file) => file,
    terminate: async (owned) => {
      assert.equal(owned, child);
      terminated++;
      child.emit('close', null);
    },
  });
  const context = ctx();
  context.signal = controller.signal;
  await assert.rejects(adapter.execute(context), /cancelled/);
  assert.ok(terminated >= 1);
});

test('Grok thinking deltas stream as reasoning, never as answer text, and are not repeated from the whole message', async () => {
  const events: RunEvent[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null,
  }) as unknown as ChildProcessWithoutNullStreams;
  child.stdin.on('finish', () => {
    for (const packet of [
      { type: 'stream_event', event: { type: 'message_start' } },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Check the ' } },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'folder.' } },
      },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done' } } },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'Check the folder.' },
            { type: 'text', text: 'Done' },
          ],
        },
      },
      // A later message without partial deltas still surfaces its thinking once.
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Second thought.' }] } },
      { type: 'result', subtype: 'success', result: 'Done' },
    ])
      (child.stdout as PassThrough).write(`${JSON.stringify(packet)}\n`);
    child.emit('close', 0);
  });
  const adapter = createGrokAdapter({
    spawn: async () => child,
    targetPath: async (_target, file) => file,
    terminate: async () => undefined,
  });
  const context = ctx();
  context.emit = (event) => events.push(event);
  const result = await adapter.execute(context);
  assert.equal(result.output, 'Done');
  assert.deepEqual(
    events.filter((event) => event.type === 'reasoning').map((event) => event.text),
    ['Check the ', 'folder.', 'Second thought.'],
  );
  assert.deepEqual(
    events.filter((event) => event.type === 'text').map((event) => event.text),
    ['Done'],
  );
});

test('legacy Grok output classifies an HTTP 402 balance failure as quota, like the ACP path', async () => {
  for (const packet of [
    { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Grok Build usage balance exhausted' },
    { type: 'result', subtype: 'error', is_error: true, result: 'API error (status 402 Payment Required)' },
    { type: 'error', error: { status: 402, message: 'Request failed' } },
  ]) {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null,
    }) as unknown as ChildProcessWithoutNullStreams;
    child.stdin.on('finish', () => {
      (child.stdout as PassThrough).write(`${JSON.stringify(packet)}\n`);
      child.emit('close', 1);
    });
    const adapter = createGrokAdapter({
      spawn: async () => child,
      targetPath: async (_target, file) => file,
      terminate: async () => undefined,
    });
    await assert.rejects(adapter.execute(ctx()), /^Error: quota-or-rate-limit$/, JSON.stringify(packet));
  }
});
