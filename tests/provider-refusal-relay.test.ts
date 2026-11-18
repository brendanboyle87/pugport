import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { claudeAdapter } from '../src/server/adapters/claude.ts';
import { redactError } from '../src/server/adapters/process.ts';
import { providerRefused, refusalVendor, providerRefusedCode } from '../src/server/content-refusal.ts';
import { route } from '../src/server/routing.ts';
import { cursorModelPool } from '../src/shared/cursor-models.ts';
import type {
  ExecuteContext,
  ExecuteResult,
  RunInput,
  RunRecord,
  RuntimeSnapshot,
  RuntimeTarget,
  Settings,
  Workflow,
} from '../src/shared/types.ts';

// Synthetic catalogs, run records and adapters only; no executor or provider is contacted.

const anthropicBlock =
  "Anthropic: This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy. To learn more, see [redacted URL]";

test('provider policy blocks are recognised from the provider’s own words, ordinary failures are not', () => {
  for (const message of [
    anthropicBlock,
    'The model refused to complete the request',
    'Provider stopped with: sensitive',
    'Provider finish_reason: sensitive',
    'Provider finish_reason: content_filter',
    'incomplete: content_filter',
    '{"error":{"code":"content_policy_violation","message":"Your request was rejected as a result of our safety system."}}',
    'Invalid prompt: your prompt was flagged as potentially violating our usage policy.',
    'cyber_policy: This content was flagged for possible cybersecurity risk.',
    'Content violates usage guidelines.',
    '{"promptFeedback":{"blockReason":"SAFETY"}}',
    'Content Exists Risk',
    'The request was rejected because it was considered high risk',
    '{"error":{"code":"1301","message":"系统检测到输入或生成内容可能包含不安全或敏感内容"}}',
  ])
    assert.equal(providerRefused(message), true, message);
  for (const message of [
    undefined,
    '',
    'connect ECONNREFUSED 127.0.0.1:443',
    'Connection refused',
    '400 invalid_request_error: max_tokens: 900000 > 128000',
    '400 Bad Request: messages: text content blocks must be non-empty',
    'Command blocked by the sandbox policy: workspace-write',
    'Request rejected: unsupported content type',
    'model_not_found: The model `x` does not exist or you do not have access to it.',
    '429 rate limit exceeded',
    'Error: I cannot open that file, permission denied',
    '敏感内容检查服务暂时不可用',
  ])
    assert.equal(providerRefused(message), false, String(message));
  // The provider's message alone still classifies as an untyped failure; the controller upgrades it.
  assert.equal(redactError(anthropicBlock), 'runtime-request-failed');
  assert.equal(redactError(providerRefusedCode), providerRefusedCode);
});

test('a refusal is judged by the model’s vendor, whichever CLI, card or Cursor pool carries it', () => {
  assert.equal(refusalVendor('pi', 'anthropic', 'claude-opus-5'), 'anthropic');
  assert.equal(refusalVendor('claude', undefined, 'opus'), 'anthropic');
  assert.equal(refusalVendor('cursor', undefined, 'claude-sonnet-5-thinking'), 'anthropic');
  assert.equal(refusalVendor('pi', 'openrouter', 'anthropic/claude-sonnet-5'), 'anthropic');
  assert.equal(refusalVendor('codex', undefined, 'gpt-6-astra'), 'openai');
  assert.equal(refusalVendor('codex', undefined, 'o4-mini'), 'openai');
  assert.equal(refusalVendor('grok', undefined, 'grok-4.7'), 'xai');
  assert.equal(refusalVendor('cursor', undefined, 'grok-4.7'), 'xai');
  assert.equal(refusalVendor('cursor', undefined, 'glm-5p3'), 'zhipu');
  assert.equal(refusalVendor('pi', 'zai-cn', 'glm-5'), 'zhipu');
  assert.equal(refusalVendor('pi', 'moonshot-cn', 'kimi-k3'), 'moonshot');
  assert.equal(refusalVendor('pi', 'deepseek', 'deepseek-chat'), 'deepseek');
  assert.equal(refusalVendor('cursor', undefined, 'composer-2.5'), 'cursor');
  assert.equal(refusalVendor('pi', 'custom-api', 'house-model'), 'custom-api');
});

function fixture() {
  const now = Date.now();
  const iso = (offset = 0) => new Date(now + offset).toISOString();
  const settings: Settings = {
    refreshSeconds: 60,
    reservePercent: 10,
    maxQuotaAgeSeconds: 180,
    preferCli: true,
    designProvider: 'claude',
    architectureProvider: 'codex',
    routineProvider: 'codex',
    defaultProjectPath: 'C:/synthetic',
    maxConcurrentRuns: 0,
    unknownQuotaPolicy: 'manual-only',
    toolApprovalMode: 'auto',
  };
  const card = (id: string, provider: RuntimeTarget['provider'], apiProvider?: string): RuntimeTarget => ({
    id,
    provider,
    label: id,
    command: 'never-executed',
    environment: 'native',
    enabled: true,
    ...(apiProvider ? { gateway: 'api' as const, apiProvider } : {}),
  });
  const targets = [
    card('pi-anthropic', 'pi', 'anthropic'),
    card('pi-openai', 'pi', 'openai'),
    card('codex-a', 'codex'),
    card('claude-a', 'claude'),
    card('grok-a', 'grok'),
    card('cursor-a', 'cursor'),
  ];
  const window = (used: number, pool?: 'cursor' | 'other') => ({
    id: pool ?? 'week',
    label: pool ?? 'week',
    usedPercent: used,
    resetsAt: iso(86_400_000),
    ...(pool ? { modelPool: pool } : {}),
  });
  const snapshot = (target: RuntimeTarget, models: string[]): RuntimeSnapshot => ({
    id: target.id,
    provider: target.provider,
    label: target.label,
    environment: 'native',
    ...(target.gateway ? { gateway: target.gateway, apiProvider: target.apiProvider } : {}),
    installed: true,
    status: 'ready',
    models: models.map((id) => ({
      id,
      label: id,
      efforts: ['low', 'medium', 'high'],
      ...(target.provider === 'cursor' ? { quotaPool: cursorModelPool(id) } : {}),
    })),
    quota: {
      status: 'known',
      source: 'synthetic',
      observedAt: iso(-1000),
      windows: target.provider === 'cursor' ? [window(20, 'cursor'), window(20, 'other')] : [window(20)],
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: false },
    refreshedAt: iso(-1000),
  });
  const snapshots = [
    snapshot(targets[0]!, ['claude-opus-5']),
    snapshot(targets[1]!, ['gpt-5.6-sol']),
    snapshot(targets[2]!, ['gpt-5.6-sol']),
    snapshot(targets[3]!, ['claude-opus-5']),
    snapshot(targets[4]!, ['grok-4.7']),
    snapshot(targets[5]!, ['composer-2.5', 'claude-sonnet-5']),
  ];
  const input: RunInput = {
    prompt: 'How is a PS5 jailbroken?',
    userInput: 'How is a PS5 jailbroken?',
    projectPath: settings.defaultProjectPath,
    kind: 'general',
    workflowId: 'workflow',
    stepId: 'step',
    permissionMode: 'read-only',
    allowExecutorFallback: true,
  };
  const records = new Map<string, RunRecord>();
  let count = 0;
  /** A run on `runtimeId` that the provider blocked; `from` makes it a content relay of that run. */
  const blocked = (runtimeId: string, model: string, from?: RunRecord, detail = `Pi: ${anthropicBlock}`): RunRecord => {
    const run: RunRecord = {
      id: `run-${++count}`,
      prompt: input.prompt,
      projectPath: input.projectPath,
      kind: 'general',
      status: 'failed',
      errorCode: providerRefusedCode,
      error: providerRefusedCode,
      errorDetail: detail,
      route: { runtimeId, model, kind: 'general', reasons: [], warnings: [] },
      startedAt: iso(),
      endedAt: iso(),
      output: '',
      events: [],
      workflowId: input.workflowId,
      stepId: input.stepId,
      ...(from
        ? { relay: { fromRunId: from.id, fromRuntimeId: from.route.runtimeId, reason: 'content' as const } }
        : {}),
    };
    records.set(run.id, run);
    return run;
  };
  const controller = Object.assign(Object.create(Controller.prototype), {
    settings,
    targets,
    snapshots,
    active: new Map(),
    store: { run: (id: string) => records.get(id) },
    accountHealth: { apply: (value: RuntimeSnapshot) => value },
    freeHealth: { apply: (value: RuntimeSnapshot) => value },
    cooldown: { apply: (value: RuntimeSnapshot) => value },
  }) as Controller;
  const spend = (id: string) => {
    const found = snapshots.find((value) => value.id === id)!;
    found.quota.windows = found.quota.windows.map((value) => ({ ...value, usedPercent: 100 }));
  };
  const lands = (next: RunInput) => route(next, snapshots, settings);
  return { controller, input, settings, targets, snapshots, blocked, spend, lands };
}

const relayed = (value: ReturnType<Controller['refusalRelay']>) => {
  assert.ok(value && 'input' in value, 'expected a relay');
  return value;
};
const stopped = (value: ReturnType<Controller['refusalRelay']>) => {
  assert.ok(value && 'stopped' in value, 'expected the relay to stop');
  return value;
};

test('an Anthropic API block moves to another vendor, never to Claude Code, Cursor’s Claude or a billed card', () => {
  const f = fixture();
  // Codex and Grok are used up: what is left is Claude Code, Cursor and the billed OpenAI card.
  f.spend('codex-a');
  f.spend('grok-a');
  const origin = f.blocked('pi-anthropic', 'claude-opus-5');
  const relay = relayed(f.controller.refusalRelay(f.input, origin));
  assert.equal(relay.input.relayReason, 'content');
  assert.equal(relay.input.relayFromRunId, origin.id);
  assert.equal(relay.input.automaticExecutorSelection, true);
  assert.equal(relay.input.allowExecutorFallback, false);
  assert.equal(relay.input.runtimeId, undefined, 'ordinary automatic routing makes the choice');
  assert.ok(relay.input.excludeRuntimeIds?.includes('pi-anthropic'));
  // Every Anthropic choice is set aside before routing, so even a busy pool cannot land on one.
  assert.ok(relay.input.excludeRuntimeIds?.includes('claude-a'));
  assert.ok(relay.input.routingRules?.excludeModels?.includes('claude-sonnet-5'));
  assert.ok(!relay.input.routingRules?.excludeModels?.includes('composer-2.5'));
  const decision = f.lands(relay.input);
  assert.deepEqual([decision.runtimeId, decision.model], ['cursor-a', 'composer-2.5']);
  assert.equal(relay.label, 'cursor-a · composer-2.5');
  assert.equal(
    relay.notice,
    'pi-anthropic · claude-opus-5 被服务方按使用政策拒绝，改由 cursor-a · composer-2.5 接手。',
  );

  // With Cursor off the checklist too, only Anthropic and a billed card remain: it stops and says why.
  f.settings.excludedExecutors = ['cursor-a'];
  const stop = stopped(f.controller.refusalRelay(f.input, origin));
  assert.equal(
    stop.stopped,
    'pi-anthropic · claude-opus-5 被服务方按使用政策拒绝，没有其他厂商的执行器可以自动接手（按次计费的 API 卡要钉选才会用）。',
  );
  assert.equal(stop.details, `pi-anthropic · claude-opus-5: Pi: ${anthropicBlock}`);
});

test('each step tries a vendor not yet tried, and the chain stops after three with every reason', () => {
  const f = fixture();
  const origin = f.blocked('pi-anthropic', 'claude-opus-5');
  const first = relayed(f.controller.refusalRelay(f.input, origin));
  const firstChoice = f.lands(first.input);
  // The second executor declines in its reply rather than with an error.
  const second = f.blocked(firstChoice.runtimeId, firstChoice.model, origin, '');
  Object.assign(second, {
    status: 'completed',
    errorCode: undefined,
    error: undefined,
    errorDetail: undefined,
    output: "I can't help with that because it violates the usage policy.",
  });
  const next = relayed(f.controller.refusalRelay(first.input, second));
  const secondChoice = f.lands(next.input);
  const vendor = (id: string, model: string) => {
    const target = f.targets.find((value) => value.id === id)!;
    return refusalVendor(target.provider, target.apiProvider, model);
  };
  assert.equal(
    new Set([
      'anthropic',
      vendor(firstChoice.runtimeId, firstChoice.model),
      vendor(secondChoice.runtimeId, secondChoice.model),
    ]).size,
    3,
  );
  assert.notEqual(secondChoice.runtimeId, 'pi-openai');
  const third = f.blocked(secondChoice.runtimeId, secondChoice.model, second, 'Provider finish_reason: content_filter');
  const stop = stopped(f.controller.refusalRelay(next.input, third));
  assert.match(
    stop.stopped,
    /^这条消息先后交给了 pi-anthropic · claude-opus-5、.+、.+，都被服务方按使用政策拒绝。已经停下。$/,
  );
  const lines = stop.details.split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], `pi-anthropic · claude-opus-5: Pi: ${anthropicBlock}`);
  assert.match(lines[1]!, /: I can't help with that because it violates the usage policy\.$/);
  assert.match(lines[2]!, /: Provider finish_reason: content_filter$/);
});

test('a pinned card that refuses moves on and says so, but never to another billed card', () => {
  const f = fixture();
  f.spend('codex-a');
  f.spend('grok-a');
  const origin = f.blocked('pi-anthropic', 'claude-opus-5');
  const pin = { ...f.input, runtimeId: 'pi-anthropic', model: 'claude-opus-5', effort: 'high' };
  const relay = relayed(f.controller.refusalRelay(pin, origin));
  assert.deepEqual(
    [relay.input.runtimeId, relay.input.model, relay.input.effort, relay.input.automaticExecutorSelection],
    [undefined, undefined, undefined, true],
    'the pin is lifted and ordinary automatic routing chooses',
  );
  assert.equal(
    relay.notice,
    '你钉选的 pi-anthropic · claude-opus-5 被服务方按使用政策拒绝，改由 cursor-a · composer-2.5 接手。',
  );
  assert.ok(relay.input.excludeRuntimeIds?.includes('pi-openai'), 'pinning one billed card allows only that card');
  assert.deepEqual([f.lands(relay.input).runtimeId, f.lands(relay.input).model], ['cursor-a', 'composer-2.5']);
  // The next step inherits the exclusion, so a later refusal cannot reach the other billed card either.
  const cursor = f.blocked('cursor-a', 'composer-2.5', origin, 'Provider finish_reason: content_filter');
  // (API-only here, where billed cards would otherwise be allowed, so only the inherited exclusion keeps it out.)
  stopped(f.controller.refusalRelay({ ...relay.input, executionPolicy: 'api-only' }, cursor));

  // Even an API-only conversation, which otherwise opts in to billed cards, keeps the other card out after a pin.
  const apiOnly = { ...pin, executionPolicy: 'api-only' as const };
  const pinnedStop = stopped(f.controller.refusalRelay(apiOnly, origin));
  assert.equal(
    pinnedStop.stopped,
    '你钉选的 pi-anthropic · claude-opus-5 被服务方按使用政策拒绝，没有其他厂商的执行器可以自动接手（按次计费的 API 卡要钉选才会用）。',
  );
  const optedIn = relayed(f.controller.refusalRelay({ ...f.input, executionPolicy: 'api-only' }, origin));
  assert.equal(
    f.lands(optedIn.input).runtimeId,
    'pi-openai',
    'without a pin, API-only still means billed cards are allowed',
  );
  // A route the user confirmed before it ran is not switched.
  assert.equal(
    f.controller.refusalRelay(
      { ...pin, confirmedRoute: { runtimeId: 'pi-anthropic', model: 'claude-opus-5' } } as RunInput,
      origin,
    ),
    undefined,
  );
});

test('resumed sessions, ordinary failures, minors, images and repeated writes are never relayed', () => {
  const f = fixture();
  const origin = f.blocked('pi-anthropic', 'claude-opus-5');
  assert.equal(f.controller.refusalRelay({ ...f.input, resumeRunId: 'earlier' }, origin), undefined);
  // An ordinary failure, a quota stop or a completed answer.
  const ordinary = f.blocked('pi-anthropic', 'claude-opus-5', undefined, 'Pi: 400 invalid_request_error');
  Object.assign(ordinary, { errorCode: 'runtime-request-failed', error: 'runtime-request-failed' });
  assert.equal(f.controller.refusalRelay(f.input, ordinary), undefined);
  const quota = f.blocked('pi-anthropic', 'claude-opus-5', undefined, 'Pi: 429 rate limit');
  Object.assign(quota, { errorCode: 'quota-or-rate-limit', error: 'quota-or-rate-limit' });
  assert.equal(f.controller.refusalRelay(f.input, quota), undefined);
  // A reply-level refusal does not start this chain; only the provider's own block does.
  const text = f.blocked('pi-anthropic', 'claude-opus-5', undefined, '');
  Object.assign(text, {
    status: 'completed',
    errorCode: undefined,
    error: undefined,
    errorDetail: undefined,
    output: "I can't help with that; it is against the usage policy.",
  });
  assert.equal(f.controller.refusalRelay(f.input, text), undefined);
  // Minors, in the request or in the provider's reason.
  assert.equal(f.controller.refusalRelay({ ...f.input, userInput: '关于未成年人的内容' }, origin), undefined);
  const minors = f.blocked('pi-anthropic', 'claude-opus-5', undefined, 'Pi: blocked under the Usage Policy (minors)');
  assert.equal(f.controller.refusalRelay(f.input, minors), undefined);
  const image = {
    ...f.input,
    attachments: [
      {
        id: 'image',
        name: 'fixture.png',
        kind: 'image' as const,
        path: 'never-read.png',
        mimeType: 'image/png',
        size: 1,
      },
    ],
  };
  assert.equal(f.controller.refusalRelay(image, origin), undefined);
  // A writing run that already used tools is not repeated elsewhere; a read-only one may be.
  const worked = f.blocked('pi-anthropic', 'claude-opus-5');
  worked.hadToolActivity = true;
  assert.equal(f.controller.refusalRelay({ ...f.input, permissionMode: 'workspace-write' }, worked), undefined);
  assert.ok(relayed(f.controller.refusalRelay(f.input, worked)));
});

test('in a conversation, Claude answers what OpenAI blocked; when Claude blocks too, a note lists both reasons', async (t) => {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'provider-refusal-test-')));
  const previousMemory = process.env.COMBORUNNER_MEMORY_DIR;
  process.env.COMBORUNNER_MEMORY_DIR = join(directory, 'memory');
  const calls: string[] = [];
  // The shape Pi gives a provider failure: a coded message with the provider's own words as detail.
  const block = (detail: string) => Object.assign(new Error('runtime-request-failed'), { detail });
  let claudeBlocks = false;
  t.mock.method(codexAdapter, 'execute', async (context: ExecuteContext): Promise<ExecuteResult> => {
    calls.push(context.target.provider);
    throw block('OpenAI: Invalid prompt: your prompt was flagged as potentially violating our usage policy.');
  });
  t.mock.method(claudeAdapter, 'execute', async (context: ExecuteContext): Promise<ExecuteResult> => {
    calls.push(context.target.provider);
    if (claudeBlocks) throw block(anthropicBlock);
    return { output: 'Here is the public overview.' };
  });
  const controller = new Controller(directory, join(directory, 'data'), { readAccountIdentity: () => 'synthetic' });
  clearInterval(controller.timer);
  controller.settings.decisionMode = 'auto';
  const now = Date.now();
  const card = (id: string, provider: RuntimeTarget['provider']): RuntimeTarget => ({
    id,
    provider,
    label: id,
    command: 'unused',
    environment: 'native',
    enabled: true,
  });
  // Codex's window resets soon, so it takes the message first.
  const runtime = (id: string, provider: RuntimeSnapshot['provider'], resetMs: number): RuntimeSnapshot => ({
    id,
    provider,
    label: id,
    environment: 'native',
    installed: true,
    status: 'ready',
    models: [{ id: `${provider}-model`, label: 'Model', efforts: ['low', 'medium', 'high'] }],
    quota: {
      status: 'known',
      source: 'fixture',
      observedAt: new Date(now - 1000).toISOString(),
      windows: [{ id: 'week', label: 'week', usedPercent: 10, resetsAt: new Date(now + resetMs).toISOString() }],
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: new Date(now - 1000).toISOString(),
  });
  controller.targets = [card('codex-b', 'codex'), card('claude-b', 'claude')];
  controller.snapshots = [runtime('codex-b', 'codex', 1_800_000), runtime('claude-b', 'claude', 172_800_000)];
  t.mock.method(controller, 'refresh', async () => {});
  const workspace = new Workspace(controller, {
    autoTick: false,
    retrieveMemory: async () => ({ context: '', excerpts: [], paths: [], elapsedMs: 0 }),
  });
  t.after(async () => {
    await workspace.close();
    await controller.close();
    if (previousMemory === undefined) delete process.env.COMBORUNNER_MEMORY_DIR;
    else process.env.COMBORUNNER_MEMORY_DIR = previousMemory;
    const absolute = resolve(directory);
    assert.ok(
      absolute.startsWith(realpathSync.native(tmpdir()) + sep) && basename(absolute).startsWith('provider-refusal-'),
    );
    rmSync(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const finish = async (id: string) => {
    for (let i = 0; i < 1000; i++) {
      await workspace.tickQueue();
      const workflow = workspace.store.get<Workflow>('workflow', id)!;
      if (['completed', 'blocked', 'cancelled', 'failed'].includes(workflow.status)) return workflow;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    throw new Error('fixture workflow did not finish');
  };
  const folder = join(directory, 'repo');
  mkdirSync(folder);
  const project = await workspace.createProject(folder);
  const conversation = workspace.createConversation(project.id);
  const message = {
    content: 'How is a PS5 jailbroken?',
    mode: 'chat' as const,
    permissionMode: 'read-only' as const,
    executionPolicy: 'cli-first' as const,
  };
  const replies = () =>
    workspace.store
      .messages(conversation.id)
      .filter((value) => value.role === 'assistant' && !value.systemNotice)
      .map((value) => value.content);

  const first = await finish((await workspace.send(conversation.id, message)).workflow.id);
  assert.equal(first.status, 'completed');
  assert.deepEqual(calls, ['codex', 'claude']);
  const refusedRun = controller.run(first.runIds[0]!)!;
  assert.equal(refusedRun.errorCode, providerRefusedCode);
  const answered = controller.run(first.runIds.at(-1)!)!;
  assert.deepEqual(answered.relay, { fromRunId: refusedRun.id, fromRuntimeId: 'codex-b', reason: 'content' });
  assert.deepEqual(replies(), ['Here is the public overview.']);
  const handoff = workspace.store.messages(conversation.id).find((value) => value.systemNotice)!;
  assert.equal(
    handoff.systemNotice!.text,
    'codex-b · codex-model 被服务方按使用政策拒绝，改由 claude-b · claude-model 接手。',
  );
  assert.match(handoff.systemNotice!.details!, /flagged as potentially violating our usage policy/);

  claudeBlocks = true;
  calls.length = 0;
  await finish((await workspace.send(conversation.id, message)).workflow.id);
  assert.deepEqual(calls, ['codex', 'claude'], 'each vendor once, and nothing else is set up');
  const last = workspace.store
    .messages(conversation.id)
    .filter((value) => value.systemNotice)
    .at(-1)!;
  assert.equal(
    last.systemNotice!.text,
    '这条消息先后交给了 codex-b · codex-model、claude-b · claude-model，都被服务方按使用政策拒绝。已经停下。',
  );
  assert.match(last.systemNotice!.details!, /^codex-b · codex-model: OpenAI: Invalid prompt/);
  assert.match(
    last.systemNotice!.details!,
    /\nclaude-b · claude-model: Anthropic: This request triggered restrictions/,
  );
  assert.equal(last.replyIdentity?.kind, 'system');

  // The user pins Codex: when it refuses, Claude still answers, and the note says the pinned choice refused.
  claudeBlocks = false;
  calls.length = 0;
  const pinned = await finish(
    (await workspace.send(conversation.id, { ...message, runtimeId: 'codex-b' })).workflow.id,
  );
  assert.equal(pinned.status, 'completed');
  assert.deepEqual(calls, ['codex', 'claude']);
  assert.equal(controller.run(pinned.runIds.at(-1)!)?.relay?.reason, 'content');
  assert.equal(replies().at(-1), 'Here is the public overview.');
  assert.equal(
    workspace.store
      .messages(conversation.id)
      .filter((value) => value.systemNotice)
      .at(-1)!.systemNotice!.text,
    '你钉选的 codex-b · codex-model 被服务方按使用政策拒绝，改由 claude-b · claude-model 接手。',
  );
});
