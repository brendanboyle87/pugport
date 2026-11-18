import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLayaRunHints, workflowLayaState, withLayaSourceBudget } from '../src/server/laya-workflow.ts';
import type { LayaInference, LayaReviewRecord } from '../src/shared/laya.ts';
import type { ConversationMessage, ExecuteContext, RunInput, RunRecord, Workflow } from '../src/shared/types.ts';
import { fixture, finished, result } from './helpers/session-workspace.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { layaInputCompacted, layaPolicy } from '../src/server/laya-policy.ts';
import { claudeAdapter } from '../src/server/adapters/claude.ts';

const prediction: LayaInference = {
  status: 'ok',
  reason: 'accepted',
  modelVersion: 'pugport-laya-v4',
  device: 'cuda',
  latencyMs: 80,
  choices: {
    task_type: 'conversation',
    difficulty: 'simple',
    web_search: 'no',
    input_modality: 'text',
    document_read: 'no',
    media_output: 'none',
    project_access: 'none',
    run_commands: 'no',
    browser_use: 'no',
    executor_intent: 'none',
  },
  raw: {
    answers: {
      task_type: { choice: 'conversation', probabilities: { conversation: 0.9, coding: 0.1 }, answer_confidence: 0.9 },
    },
  },
};

test('an unresponsive classifier cannot prevent a real workflow from reaching its synthetic executor', async (t) => {
  const f = fixture(t);
  f.controller.settings.laya = { mode: 'cloud', shareTraining: false, enabled: true, recordTraining: false };
  t.mock.method(f.controller.laya, 'predict', () => new Promise<LayaInference>(() => {}));
  const execute = async () => result('completed', 'Ordinary chat continued');
  t.mock.method(codexAdapter, 'execute', execute);
  t.mock.method(claudeAdapter, 'execute', execute);
  const conversation = await f.workspace.createGeneralConversation();
  const { workflow } = await f.workspace.send(conversation.id, {
    content: 'Explain a cache briefly',
    mode: 'chat',
    permissionMode: 'read-only',
    executionPolicy: 'cli-first',
  });
  const final = await finished(f.workspace, workflow.id);
  assert.equal(final.status, 'completed');
  assert.equal(final.laya?.inference.reason, 'timeout');
  assert.equal(final.input.permissionMode, 'read-only');
});

test('transport bounding preserves a long request tail and marks the source budget explicitly', () => {
  const message = {
    id: 'long',
    role: 'user',
    content:
      'Background\n' + 'Synthetic context. '.repeat(1500) + '\nWhat hardware is needed for training and inference?',
  } as ConversationMessage;
  const state = workflowLayaState(message, [], []);
  assert.ok(state.message.startsWith('Background'));
  assert.ok(state.message.endsWith('What hardware is needed for training and inference?'));
  assert.ok(state.message.length <= 12000);
  const result = withLayaSourceBudget(prediction, message);
  assert.equal((result.raw?.usage as Record<string, unknown>).source_compacted, true);
  assert.notEqual(result, prediction);
  assert.equal(withLayaSourceBudget(prediction, { ...message, content: 'Short' }), prediction);
  for (const reason of ['disabled', 'busy', 'cooldown']) {
    const unavailable = { ...prediction, status: 'fallback' as const, reason, raw: undefined };
    assert.equal(withLayaSourceBudget(unavailable, message), unavailable);
  }
});

test('history-only compaction preserves a short question, semantic choices and standard advice', () => {
  const message = { id: 'current', content: '苹果的 M6 是不是已经出了？' } as ConversationMessage;
  const history = [
    { id: 'prior', role: 'assistant', content: 'Earlier context. '.repeat(1000) },
  ] as ConversationMessage[];
  const state = workflowLayaState(message, history, []);
  assert.equal(state.message, message.content);
  assert.ok(state.recent_context.length < history[0]!.content.length);
  for (const usage of [
    { input_compacted: true, compacted_fields: ['recent_context', 'candidate_executors'] },
    { input_compacted: true, message_truncated: false, context_truncated: true },
    { truncated: true, context_truncated: true },
  ]) {
    const inference = withLayaSourceBudget(
      {
        ...prediction,
        choices: { ...prediction.choices!, difficulty: 'standard', task_type: 'research', web_search: 'yes' },
        raw: { usage },
      },
      message,
    );
    assert.equal(layaInputCompacted(inference), false);
    assert.equal(inference.choices!.web_search, 'yes');
    const policy = layaPolicy(state, inference, {}, []);
    assert.deepEqual([policy.suggestedTier, policy.suggestedEffort], ['standard', 'medium']);
    assert.equal(policy.category?.id, 'research');
    assert.equal(policy.needsAssessment, undefined);
    assert.ok(!policy.reasons.some((reason) => /compacted|semantic choices are not applied/.test(reason)));
  }
});

test('classifier input keeps current words, separates quoted data and takes newest context in chronological order', () => {
  const message = {
    id: 'now',
    role: 'user',
    content: 'Use the previous example.',
    quotes: [{ text: 'Quoted instruction' }],
    attachments: [{ kind: 'image', name: 'sample.png', path: 'PRIVATE_FILE_PATH' }],
  } as unknown as ConversationMessage;
  const history = Array.from({ length: 7 }, (_, i) => ({
    id: String(i),
    role: 'assistant',
    content: `chronological-${i}`,
  })) as ConversationMessage[];
  const state = workflowLayaState(message, history, []);
  assert.equal(state.message, message.content);
  assert.equal(state.reference_text, 'Quoted instruction');
  assert.equal(
    state.recent_context,
    [
      'assistant: chronological-3',
      'assistant: chronological-4',
      'assistant: chronological-5',
      'assistant: chronological-6',
    ].join('\n'),
  );
  assert.deepEqual(state.attachments, [{ kind: 'image', name: 'sample.png' }]);
  assert.ok(!JSON.stringify(state).includes('PRIVATE_FILE_PATH'));
});

test('Laya context uses the latest trusted messages from the actual chronological workspace store', async (t) => {
  const f = fixture(t);
  const conversation = await f.workspace.createGeneralConversation();
  const messages: ConversationMessage[] = [];
  for (let i = 0; i < 7; i++) {
    const message = f.workspace.store.addMessage(conversation.id, 'assistant', `stored-${i}`);
    message.createdAt = `2026-10-26T12:00:0${i}.000Z`;
    f.workspace.store.save('message', message.id, conversation.id, message);
    messages.push(message);
  }
  const untrusted = f.workspace.store.addMessage(conversation.id, 'assistant', 'UNTRUSTED_REFERENCE_SENTINEL');
  untrusted.createdAt = '2026-10-26T12:00:07.000Z';
  untrusted.untrustedContent = true;
  f.workspace.store.save('message', untrusted.id, conversation.id, untrusted);
  const current = f.workspace.store.addMessage(conversation.id, 'user', 'CURRENT_INSTRUCTION_SENTINEL');
  current.createdAt = '2026-10-26T12:00:08.000Z';
  f.workspace.store.save('message', current.id, conversation.id, current);
  const history = f.workspace.store.contextMessages(conversation.id, current.id);
  assert.deepEqual(
    history.slice(0, 7).map((message) => message.id),
    messages.map((message) => message.id),
  );
  const state = workflowLayaState(current, history, f.controller.targets);
  assert.equal(state.recent_context, [3, 4, 5, 6].map((i) => `assistant: stored-${i}`).join('\n'));
  assert.doesNotMatch(state.recent_context, /stored-[012]|UNTRUSTED_REFERENCE_SENTINEL|CURRENT_INSTRUCTION_SENTINEL/);
  assert.equal(state.message, current.content);
});

test('advice preserves human pins and strict routes, applies only suggestions and tightens permissions', () => {
  const workflow = {
    laya: {
      inference: prediction,
      policy: {
        applied: true,
        reasons: [],
        conflicts: [],
        excludeRuntimeIds: ['blocked'],
        suggestedTier: 'light',
        suggestedEffort: 'low',
        category: { id: 'other', confidence: 'low', reason: 'suggestion' },
        permissionMode: 'read-only',
        prohibitCommands: true,
      },
    },
  } as unknown as Workflow;
  const base = {
    runtimeId: 'pinned',
    model: 'fixed',
    effort: 'high',
    permissionMode: 'workspace-write',
    category: { id: 'code', confidence: 'high', reason: 'explicit rule' },
  } as RunInput;
  const pinned = applyLayaRunHints(base, workflow);
  assert.equal(pinned.runtimeId, 'pinned');
  assert.equal(pinned.model, 'fixed');
  assert.equal(pinned.effort, 'high');
  assert.equal(pinned.suggestedTier, undefined);
  assert.deepEqual(pinned.category, base.category);
  assert.equal(pinned.permissionMode, 'read-only');
  assert.equal(pinned.prohibitCommands, true);
  assert.deepEqual(pinned.excludeRuntimeIds, ['blocked']);
  const automatic = applyLayaRunHints({ ...base, runtimeId: undefined, model: undefined, effort: undefined }, workflow);
  assert.equal(automatic.suggestedTier, 'light');
  workflow.laya!.policy.conflicts = ['Executor request is conditional or ambiguous; clarify the selection.'];
  workflow.laya!.policy.suggestedTier = 'strong';
  workflow.laya!.policy.suggestedEffort = 'high';
  const provisional = applyLayaRunHints(
    { ...base, runtimeId: undefined, model: undefined, effort: undefined },
    workflow,
  );
  assert.equal(provisional.suggestedTier, 'strong');
  assert.equal(provisional.suggestedEffort, 'high');
  const modelPin = applyLayaRunHints({ ...base, runtimeId: undefined, effort: undefined }, workflow);
  assert.equal(modelPin.suggestedTier, undefined);
  assert.equal(modelPin.suggestedEffort, 'high');
  assert.deepEqual(automatic.category, base.category);
  assert.throws(() => applyLayaRunHints({ ...base, runtimeId: 'blocked' }, workflow), /排除/);
  const navigator = applyLayaRunHints({ ...base, runtimeId: 'blocked', runtimeIdFromMode: true }, workflow);
  assert.equal(navigator.runtimeId, undefined);
  assert.equal(navigator.model, undefined);
  assert.equal(navigator.effort, undefined);
  assert.equal(navigator.runtimeIdFromMode, undefined);
  assert.deepEqual(navigator.excludeRuntimeIds, ['blocked']);
  assert.equal(navigator.permissionMode, 'read-only');
  workflow.laya!.policy.runtimeId = 'named';
  const free = { permissionMode: 'read-only' } as RunInput;
  assert.equal(applyLayaRunHints(free, workflow).runtimeId, 'named');
  assert.equal(applyLayaRunHints({ ...free, coordinator: true }, workflow).runtimeId, undefined);
  assert.equal(applyLayaRunHints(free, { ...workflow, requiresConfirmation: true }).runtimeId, undefined);
  assert.equal(applyLayaRunHints({ ...free, routeRule: {} } as RunInput, workflow).runtimeId, undefined);
  assert.equal(
    applyLayaRunHints(free, {
      ...workflow,
      laya: { ...workflow.laya!, inference: { ...prediction, status: 'fallback' } },
    }).runtimeId,
    undefined,
  );
});

async function savedRecords(
  controller: ReturnType<typeof fixture>['controller'],
  check: (records: LayaReviewRecord[]) => boolean,
) {
  const until = Date.now() + 5000;
  let records: LayaReviewRecord[] = [];
  while (Date.now() < until) {
    records = await controller.layaReviews.list({ limit: 20 });
    if (check(records)) return records;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(
    `Synthetic Laya records did not settle: ${JSON.stringify({ records, error: controller.layaRecordingError })}`,
  );
}

test('a real workflow records its question, full prediction and final route without executing a real model', async (t) => {
  const f = fixture(t);
  f.controller.settings.laya = { mode: 'cloud', shareTraining: false, enabled: true, recordTraining: true };
  const calls: ExecuteContext[] = [];
  t.mock.method(f.controller.laya, 'predict', async () => structuredClone(prediction));
  const execute = async (ctx: ExecuteContext) => {
    calls.push(ctx);
    return result('completed', 'Synthetic cache explanation');
  };
  t.mock.method(codexAdapter, 'execute', execute);
  t.mock.method(claudeAdapter, 'execute', execute);
  const conversation = await f.workspace.createGeneralConversation();
  const prompt = 'Explain what a cache is.\nKeep the explanation short.';
  const submitted = await f.workspace.send(conversation.id, {
    content: prompt,
    mode: 'chat',
    permissionMode: 'read-only',
    executionPolicy: 'cli-first',
  });
  const flow = await finished(f.workspace, submitted.workflow.id);
  assert.equal(flow.status, 'completed', flow.error ?? '');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.input.suggestedTier, 'light');
  const records = await savedRecords(
    f.controller,
    (items) => items.length === 1 && items[0]!.inference.status === 'ok' && items[0]!.outcome?.status === 'completed',
  );
  assert.equal(records[0]!.question, prompt);
  assert.equal(records[0]!.messageId, submitted.message.id);
  assert.deepEqual(records[0]!.inference.raw, prediction.raw);
  assert.equal(records[0]!.outcome!.routes[0]!.runId, flow.runIds[0]);
  assert.equal(records[0]!.outcome!.routes[0]!.model, 'mock-model');
  assert.equal(records[0]!.training.status, 'pending');
});

test('recording opt-out and incognito skip training data; incognito does not call the classifier', async (t) => {
  const f = fixture(t);
  let predictions = 0;
  const calls: ExecuteContext[] = [];
  f.controller.settings.laya = { mode: 'cloud', shareTraining: false, enabled: true, recordTraining: false };
  t.mock.method(f.controller.laya, 'predict', async () => {
    predictions++;
    return structuredClone(prediction);
  });
  const execute = async (ctx: ExecuteContext) => {
    calls.push(ctx);
    return result('completed', 'Synthetic reply');
  };
  t.mock.method(codexAdapter, 'execute', execute);
  t.mock.method(claudeAdapter, 'execute', execute);
  const conversation = await f.workspace.createGeneralConversation();
  const input = {
    content: 'Explain a cache.',
    mode: 'chat',
    permissionMode: 'read-only',
    executionPolicy: 'cli-first',
  } as const;
  const normal = await f.workspace.send(conversation.id, input);
  assert.equal((await finished(f.workspace, normal.workflow.id)).status, 'completed');
  assert.equal(predictions, 1);
  assert.deepEqual(await f.controller.layaReviews.list({}), []);
  f.controller.settings.laya.recordTraining = true;
  const secret = await f.workspace.createGeneralConversation('Private synthetic chat', true);
  const hidden = await f.workspace.send(secret.id, { ...input, content: 'Explain a cache. 不要运行任何命令。' });
  const hiddenFlow = await finished(f.workspace, hidden.workflow.id);
  assert.equal(hiddenFlow.status, 'completed');
  assert.equal(
    calls.at(-1)!.input.prohibitCommands,
    true,
    JSON.stringify({
      laya: hiddenFlow.laya,
      content: hiddenFlow.input.content,
      prohibitCommands: hiddenFlow.input.prohibitCommands,
    }),
  );
  assert.equal(predictions, 1);
  assert.deepEqual(await f.controller.layaReviews.list({}), []);
});

test('compacted classification starts planning first and keeps parallel assessment out of answer runs', async (t) => {
  const f = fixture(t);
  steadyMachine(f, t);
  f.controller.settings.maxConcurrentRuns = 2;
  f.controller.snapshots.find((snapshot) => snapshot.provider === 'claude')!.capabilities.toolless = true;
  f.controller.settings.laya = { mode: 'cloud', shareTraining: false, enabled: true, recordTraining: true };
  t.mock.method(f.controller.laya, 'predict', async () => ({
    ...structuredClone(prediction),
    raw: { usage: { input_compacted: true } },
  }));
  const calls: ExecuteContext[] = [];
  const startErrors: string[] = [];
  const start = f.controller.start.bind(f.controller);
  t.mock.method(f.controller, 'start', async (...args: Parameters<typeof start>) => {
    try {
      return await start(...args);
    } catch (error) {
      startErrors.push(String(error));
      throw error;
    }
  });
  let releaseForeground!: () => void;
  const foregroundHeld = new Promise<void>((resolve) => {
    releaseForeground = resolve;
  });
  t.after(() => releaseForeground());
  const execute = async (ctx: ExecuteContext) => {
    calls.push(ctx);
    if (ctx.input.untrustedContent)
      return { output: JSON.stringify({ tier: 'standard', effort: 'medium', reason: 'A bounded explanation.' }) };
    await foregroundHeld;
    if (!ctx.input.stepId)
      return {
        output: JSON.stringify({
          steps: [
            {
              id: 'step1',
              title: 'Explain',
              instruction: 'Explain the synthetic result.',
              kind: 'general',
              transport: 'auto',
              dependsOn: [],
            },
          ],
        }),
      };
    return result('completed', 'Synthetic answer');
  };
  t.mock.method(codexAdapter, 'execute', execute);
  t.mock.method(claudeAdapter, 'execute', execute);
  const project = await f.workspace.createProject(f.directory);
  project.localMemory = { exportEnabled: true, cliEnabled: false };
  f.workspace.store.save('project', project.id, project.id, project);
  const conversation = f.workspace.createConversation(project.id);
  const content = 'Synthetic background. '.repeat(650) + '\nExplain the compute tradeoffs for training and inference.';
  const quotes = [
    { text: 'REFERENCE_ONE_START\n' + 'Synthetic reference. '.repeat(200) + '\nREFERENCE_ONE_END' },
    { text: 'REFERENCE_TWO_START\n' + 'Other quoted data. '.repeat(200) + '\nREFERENCE_TWO_END' },
  ];
  const sent = await f.workspace.send(conversation.id, {
    content,
    quotes,
    mode: 'build',
    permissionMode: 'read-only',
    executionPolicy: 'cli-first',
  });
  try {
    await until(() => {
      const assessment = f.workspace.store.get<Workflow>('workflow', sent.workflow.id)?.laya?.assessment;
      return !!assessment && assessment.status !== 'running';
    }, 'parallel assessment while foreground remains active');
    const activeFlow = f.workspace.store.get<Workflow>('workflow', sent.workflow.id)!;
    assert.equal(
      activeFlow.laya?.assessment?.status,
      'completed',
      JSON.stringify({ assessment: activeFlow.laya?.assessment, startErrors }),
    );
    assert.equal(calls.length, 2, 'one foreground call and one assessment must actually reach an adapter');
    const [foreground, assessment] = calls;
    assert.equal(foreground!.input.untrustedContent, undefined);
    assert.equal(foreground!.input.permissionMode, 'read-only');
    assert.notEqual(foreground!.input.explicitNoTools, true);
    assert.notEqual(foreground!.input.prohibitCommands, true);
    assert.equal(assessment!.input.permissionMode, 'read-only');
    assert.equal(assessment!.input.untrustedContent, true);
    assert.equal(assessment!.input.explicitNoTools, true);
    assert.equal(assessment!.input.prohibitCommands, true);
    assert.equal(assessment!.input.agentCalls, false);
    const requestJson = assessment!.input.prompt.split('User request (JSON string):\n')[1]!;
    const assessed = JSON.parse(JSON.parse(requestJson));
    assert.equal(assessed.current_request, content, 'assessment receives the unabridged current question');
    assert.equal(
      assessed.quoted_reference,
      quotes.map((quote) => quote.text).join('\n\n'),
      'assessment receives every quoted reference in full',
    );
    assert.ok(activeFlow.laya!.assessment!.runId);
    assert.ok(!activeFlow.runIds.includes(activeFlow.laya!.assessment!.runId!));
    assert.equal(activeFlow.runIds.length, 1);
    assert.ok(f.controller.active.has(activeFlow.runIds[0]!), 'assessment must not stop or replace the foreground run');
  } finally {
    releaseForeground();
  }
  const flow = await finished(f.workspace, sent.workflow.id);
  assert.equal(flow.status, 'completed', flow.error ?? '');
  assert.equal(calls[0]!.input.untrustedContent, undefined);
  assert.equal(calls[0]!.input.suggestedTier, 'strong');
  assert.equal(calls[0]!.input.suggestedEffort, 'high');
  assert.equal(flow.runIds.length, 2);
  assert.equal(flow.laya?.assessment?.status, 'completed');
  assert.ok(!flow.runIds.includes(flow.laya!.assessment!.runId!));
  const records = await savedRecords(
    f.controller,
    (items) =>
      items.length === 1 &&
      items[0]!.outcome?.status === 'completed' &&
      items[0]!.outcome?.assessment?.status === 'completed',
  );
  assert.equal(records[0]!.policy.needsAssessment, true);
  assert.equal(records[0]!.policy.suggestedTier, 'strong');
  assert.deepEqual(records[0]!.inference.raw, { usage: { input_compacted: true, source_compacted: true } });
  assert.equal(records[0]!.outcome!.routes.length, 2);
});

test('single-step chat keeps fallback advice without spending a parallel assessment', async (t) => {
  const f = fixture(t);
  steadyMachine(f, t);
  t.mock.method(f.controller.laya, 'predict', async () => ({
    status: 'fallback' as const,
    reason: 'warming',
    modelVersion: 'synthetic',
    latencyMs: 0,
  }));
  const calls: ExecuteContext[] = [];
  const execute = async (ctx: ExecuteContext) => {
    calls.push(ctx);
    return result('completed', 'Synthetic answer');
  };
  t.mock.method(codexAdapter, 'execute', execute);
  t.mock.method(claudeAdapter, 'execute', execute);
  const conversation = await f.workspace.createGeneralConversation();
  const sent = await f.workspace.send(conversation.id, {
    content: 'Explain this synthetic example.',
    mode: 'chat',
    permissionMode: 'read-only',
    executionPolicy: 'cli-first',
  });
  const flow = await finished(f.workspace, sent.workflow.id);
  assert.equal(flow.status, 'completed', flow.error ?? '');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.input.suggestedTier, 'strong');
  assert.equal(flow.laya?.assessment, undefined);
});

test('queued assessment yields the only slot to the next foreground plan step', async (t) => {
  const f = fixture(t);
  steadyMachine(f, t);
  f.controller.settings.maxConcurrentRuns = 1;
  f.controller.snapshots.find((snapshot) => snapshot.provider === 'claude')!.capabilities.toolless = true;
  t.mock.method(f.controller.laya, 'predict', async () => ({
    status: 'fallback' as const,
    reason: 'warming',
    modelVersion: 'synthetic',
    latencyMs: 0,
  }));
  const calls: ExecuteContext[] = [];
  const execute = async (ctx: ExecuteContext) => {
    calls.push(ctx);
    if (ctx.input.stepId === 'route-assessment') throw new Error('Assessment stole the foreground slot');
    if (!ctx.input.stepId)
      return {
        output: JSON.stringify({
          steps: [1, 2].map((n) => ({
            id: 'step' + n,
            title: 'Explain ' + n,
            instruction: 'Explain synthetic result ' + n,
            kind: 'general',
            transport: 'auto',
            dependsOn: n === 1 ? [] : ['step1'],
          })),
        }),
      };
    if (ctx.input.stepId === 'step1') {
      const entry = [...f.controller.active.values()].find(
        (value) => value.run.workflowId === ctx.input.workflowId && value.run.stepId === 'step1',
      )!;
      const resume = f.controller.suspendExecution(entry.run.id);
      try {
        await new Promise((resolve) => setTimeout(resolve, 250));
        assert.ok(
          calls.every((call) => call.input.stepId !== 'route-assessment'),
          'the parked foreground keeps priority over background assessment',
        );
      } finally {
        await resume({ deadline: Date.now() + 1000 });
      }
    }
    if (ctx.input.stepId === 'step2') {
      f.controller.settings.maxConcurrentRuns = 2;
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.ok(
        calls.every((call) => call.input.stepId !== 'route-assessment'),
        'a queued assessment is no longer useful once the last step starts',
      );
    }
    return result('completed', 'Synthetic answer');
  };
  t.mock.method(codexAdapter, 'execute', execute);
  t.mock.method(claudeAdapter, 'execute', execute);
  const project = await f.workspace.createProject(f.directory);
  project.localMemory = { exportEnabled: false, cliEnabled: false };
  f.workspace.store.save('project', project.id, project.id, project);
  const conversation = f.workspace.createConversation(project.id);
  const sent = await f.workspace.send(conversation.id, {
    content: 'Explain the first synthetic result and then compare the second result.',
    mode: 'build',
    permissionMode: 'read-only',
    executionPolicy: 'cli-first',
  });
  const flow = await finished(f.workspace, sent.workflow.id);
  assert.equal(flow.status, 'completed', flow.error ?? '');
  assert.deepEqual(
    calls.map((ctx) => ctx.input.stepId),
    [undefined, 'step1', 'step2'],
  );
  assert.equal(flow.runIds.length, 3);
  assert.ok(calls.every((ctx) => ctx.input.suggestedTier === 'strong'));
});

async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Synthetic Laya fixture did not settle: ${label}`);
}
function steadyMachine(f: ReturnType<typeof fixture>, t: Parameters<typeof fixture>[0]) {
  t.mock.method(f.controller, 'machineReading', () => ({
    sampledAt: Date.now(),
    totalBytes: 32 * 1024 ** 3,
    cpus: 16,
    availableMemoryBytes: 16 * 1024 ** 3,
    cpuPercent: 20,
  }));
}

test('host verification cannot override a command prohibition even when its command is approved', async (t) => {
  const f = fixture(t);
  steadyMachine(f, t);
  f.controller.settings.laya = { mode: 'rules', shareTraining: false, enabled: false, recordTraining: false };
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    return result('completed', 'Synthetic inspection completed');
  });
  const verify = t.mock.method(
    f.controller as unknown as { verify: (command: string) => Promise<NonNullable<RunRecord['verification']>> },
    'verify',
    async (command: string) => ({ command, status: 'passed', exitCode: 0, output: 'Synthetic approved verification' }),
  );
  f.controller.isVerificationApproved = () => true;
  const base: RunInput = {
    prompt: 'Inspect the synthetic project.',
    projectPath: f.directory,
    kind: 'general',
    permissionMode: 'workspace-write',
    runtimeId: 'mock',
    model: 'mock-model',
    effort: 'medium',
    verificationCommand: 'synthetic-approved-command-never-executed',
  };
  const allowed = await f.controller.start({ ...base, prohibitCommands: false });
  await until(() => !f.controller.active.has(allowed.id), 'approved verification control');
  assert.equal(verify.mock.callCount(), 1);
  assert.equal(allowed.verification?.status, 'passed');
  const restricted = await f.controller.start({ ...base, prohibitCommands: true });
  await until(() => !f.controller.active.has(restricted.id), 'prohibited verification');
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.input.prohibitCommands, true);
  assert.equal(verify.mock.callCount(), 1, 'the approved host command must not dispatch during the restricted run');
  assert.equal(restricted.verification?.status, 'skipped');
  assert.equal(restricted.verification?.exitCode, null);
  assert.equal(restricted.verification?.receipt?.source, 'host-verification');
  assert.match(restricted.verification?.output ?? '', /禁止.*命令/);
  assert.equal(restricted.status, 'completed', restricted.error ?? '');
});

test('a mid-run command prohibition stops the old native run and starts a restricted successor instead of steering', async (t) => {
  const f = fixture(t);
  steadyMachine(f, t);
  f.controller.settings.laya = { mode: 'rules', shareTraining: false, enabled: false, recordTraining: false };
  f.controller.settings.steerOnSend = true;
  for (const snapshot of f.controller.snapshots) snapshot.capabilities.steer = true;
  const calls: ExecuteContext[] = [];
  const steers: string[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    if (calls.length === 1) {
      ctx.registerSteer?.(async (prompt) => {
        steers.push(prompt);
      });
      await new Promise<void>((done) => {
        if (ctx.signal.aborted) done();
        else ctx.signal.addEventListener('abort', () => done(), { once: true });
      });
      ctx.registerSteer?.(undefined);
    }
    return result('completed', 'Synthetic local review completed');
  });
  const project = await f.workspace.createProject(f.directory);
  project.localMemory = { exportEnabled: false, cliEnabled: false };
  f.workspace.store.save('project', project.id, project.id, project);
  const conversation = f.workspace.createConversation(project.id);
  const base = {
    content: 'Explain the synthetic parser.',
    mode: 'chat' as const,
    permissionMode: 'workspace-write' as const,
    explicitWrite: true,
    runtimeId: 'mock',
    model: 'mock-model',
    effort: 'medium' as const,
    executionPolicy: 'cli-only' as const,
    autoEscalate: false,
  };
  const first = await f.workspace.send(conversation.id, base);
  await until(() => calls.length === 1, 'initial native run');
  const firstRun = calls[0]!;
  const next = await f.workspace.send(conversation.id, {
    ...base,
    content: '不要运行任何命令，只继续检查本地文件。',
    queue: false,
  });
  assert.notEqual(next.workflow.id, first.workflow.id);
  assert.equal(firstRun.signal.aborted, true);
  assert.deepEqual(steers, [], 'a native session with its old command grants must not accept this as plain steering');
  assert.notEqual(next.message.steering?.status, 'accepted');
  const previous = f.workspace.store.get<Workflow>('workflow', first.workflow.id)!;
  assert.equal(previous.input.prohibitCommands, true, 'Continue must not restore the old unrestricted grant');
  assert.equal(previous.input.verificationCommand, undefined);
  await until(() => !f.controller.active.has(previous.runIds[0]!), 'old run cancellation');
  await f.workspace.tickQueue();
  await until(() => calls.length >= 2, 'restricted successor');
  assert.equal(calls[1]!.input.prohibitCommands, true);
  assert.equal(calls[1]!.input.verificationCommand, undefined);
  assert.ok(calls[1]!.input.prompt.includes('不要运行任何命令'));
  assert.equal(f.controller.store.run(previous.runIds[0]!)?.status, 'cancelled');
});

test('Jev workflow tier reaches routing while incognito and manual routes never call Jev', async (t) => {
  const f = fixture(t);
  f.controller.settings.laya = { mode: 'jev', recordTraining: false };
  let judged = 0;
  const calls: ExecuteContext[] = [];
  const { TaskJudge } = await import('../src/server/task-judgment.ts');
  const jev = new TaskJudge({
    enabled: () => true,
    credential: () => 'synthetic-key',
    fetch: async () => {
      judged++;
      return Response.json({
        answers: {
          model_tier: {
            type: 'choice',
            choice: 'sonnet',
            confidence: 0.98,
            probabilities: { haiku: 0.01, sonnet: 0.97, opus: 0.01, fable: 0.01 },
          },
        },
      });
    },
  });
  t.mock.method(f.controller.taskJudge, 'judge', jev.judge.bind(jev));
  const execute = async (ctx: ExecuteContext) => {
    calls.push(ctx);
    return result('completed', 'Synthetic Jev reply');
  };
  t.mock.method(codexAdapter, 'execute', execute);
  t.mock.method(claudeAdapter, 'execute', execute);
  const conversation = await f.workspace.createGeneralConversation();
  const input = {
    content: 'Explain how a cache works.',
    mode: 'chat',
    permissionMode: 'read-only',
    executionPolicy: 'cli-first',
  } as const;
  const sent = await f.workspace.send(conversation.id, input);
  const flow = await finished(f.workspace, sent.workflow.id);
  assert.equal(flow.status, 'completed', flow.error ?? '');
  assert.equal(flow.taskJudgment?.source, 'jev');
  assert.equal(flow.laya?.policy.suggestedTier, 'standard');
  assert.equal(calls[0]?.input.suggestedTier, 'standard');
  assert.equal(calls[0]?.input.permissionMode, 'read-only');
  assert.equal(judged, 1);
  const privateChat = await f.workspace.createGeneralConversation('Private synthetic chat', true);
  const privateSent = await f.workspace.send(privateChat.id, input);
  await finished(f.workspace, privateSent.workflow.id);
  const manual = await f.workspace.createGeneralConversation();
  const manualSent = await f.workspace.send(manual.id, { ...input, runtimeId: 'mock' });
  await finished(f.workspace, manualSent.workflow.id);
  assert.equal(judged, 1);
});

test('training eligibility rechecks conversation privacy and project recording without excluding ordinary Chats', async (t) => {
  const f = fixture(t);
  const chat = await f.workspace.createGeneralConversation();
  const record = { conversationId: chat.id, projectId: chat.projectId } as LayaReviewRecord;
  assert.equal(f.controller.layaTrainingEligible(record), true);
  const hidden = { ...chat, memory: 'off' as const };
  f.workspace.store.save('conversation', chat.id, chat.projectId, hidden);
  assert.equal(f.controller.layaTrainingEligible(record), false);
  f.workspace.store.save('conversation', chat.id, chat.projectId, { ...chat, incognito: true });
  assert.equal(f.controller.layaTrainingEligible(record), false);
  f.workspace.store.save('conversation', chat.id, chat.projectId, chat);
  const project = f.workspace.store.get<import('../src/shared/types.ts').Project>('project', chat.projectId)!;
  f.workspace.store.save('project', project.id, project.id, {
    ...project,
    scope: 'project',
    localMemory: { exportEnabled: false, cliEnabled: false },
  });
  assert.equal(f.controller.layaTrainingEligible(record), false);
});
