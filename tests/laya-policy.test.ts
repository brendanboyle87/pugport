import assert from 'node:assert/strict';
import test from 'node:test';
import { layaPolicy } from '../src/server/laya-policy.ts';
import { route } from '../src/server/routing.ts';
import { referencedBrief } from '../src/server/referenced-brief.ts';
import type { LayaChoices, LayaInference, LayaState } from '../src/shared/laya.ts';
import type { RuntimeTarget } from '../src/shared/types.ts';

const targets: RuntimeTarget[] = [
  { id: 'account-a', label: 'Muse', provider: 'codex', command: 'codex', enabled: true, environment: 'native' },
  { id: 'account-b', label: 'Nova Prime', provider: 'claude', command: 'claude', enabled: true, environment: 'native' },
];
const state = (message: string, extra: Partial<LayaState> = {}): LayaState => ({
  message,
  recent_context: '',
  reference_text: '',
  attachments: [],
  candidate_executors: [],
  ...extra,
});
const inference = (choices: Partial<LayaChoices> = {}): LayaInference => ({
  status: 'ok',
  reason: 'fixture',
  modelVersion: 'pugport-laya-v4',
  latencyMs: 1,
  choices: {
    task_type: 'coding',
    difficulty: 'complex',
    web_search: 'no',
    input_modality: 'text',
    document_read: 'no',
    media_output: 'none',
    project_access: 'write',
    run_commands: 'yes',
    browser_use: 'no',
    // Laya undecided: the deterministic text rules below are what these cases exercise.
    executor_intent: 'unclear',
    ...choices,
  },
});

test('creating a plan file with write access does not trigger unreadable-brief escalation', () => {
  const prompt = '新建 docs/plan.md 写下周计划';
  const policy = layaPolicy(
    state(prompt),
    inference({ difficulty: 'simple' }),
    { permissionMode: 'workspace-write', briefUnreadable: referencedBrief(prompt, process.cwd()) === null },
    targets,
  );
  assert.notEqual(policy.suggestedTier, 'strong');
  assert.notEqual(policy.needsAssessment, true);
});

test('compaction is provisional strong advice, never a trusted weak classification or permission grant', () => {
  for (const usage of [
    { input_compacted: true },
    { truncated: true },
    { source_compacted: true, message_truncated: false },
    { message_truncated: true, context_truncated: true },
    { input_compacted: true, compacted_fields: ['message'] },
    { input_compacted: true, compacted_fields: ['reference_text', 'recent_context'] },
    { message_truncated: false, compacted_fields: ['reference_text'] },
  ]) {
    const result = layaPolicy(
      state('不要修改文件。请研究训练和部署需要的设备。'),
      {
        ...inference({ difficulty: 'simple', task_type: 'automation', project_access: 'write' }),
        raw: { usage },
      },
      {},
      targets,
    );
    assert.equal(result.suggestedTier, 'strong');
    assert.equal(result.suggestedEffort, 'high');
    assert.equal(result.needsAssessment, true);
    assert.equal(result.category, undefined);
    assert.equal(result.permissionMode, 'read-only');
    assert.deepEqual(result.conflicts, []);
  }
});

test('compaction never overrides a manually selected model or effort', () => {
  const result = layaPolicy(
    state('A long research request'),
    {
      ...inference(),
      raw: { usage: { input_compacted: true } },
    },
    { model: 'chosen-model', effort: 'low' },
    targets,
  );
  assert.equal(result.suggestedTier, undefined);
  assert.equal(result.suggestedEffort, undefined);
});

test('multibyte transport overflow gets the same provisional protection as token compaction', () => {
  const result = layaPolicy(
    state('Explain the final requirement'),
    {
      status: 'fallback',
      reason: 'input_too_large',
      modelVersion: 'pugport-laya-v4',
      latencyMs: 0,
    },
    {},
    targets,
  );
  assert.equal(result.needsAssessment, true);
  assert.equal(result.suggestedTier, 'strong');
  assert.equal(result.suggestedEffort, 'high');
});

test('suggests category, tier and effort without granting execution or write permission', () => {
  const policy = layaPolicy(state('Implement the feature'), inference(), {}, targets);
  assert.equal(policy.category?.id, 'code');
  assert.equal(policy.suggestedTier, 'strong');
  assert.equal(policy.suggestedEffort, 'high');
  assert.equal(policy.permissionMode, undefined);
  assert.equal(policy.prohibitCommands, undefined);
  assert.equal(policy.runtimeId, undefined);
});

test('explicit UI selections are retained and conflicting text cannot reroute them', () => {
  const policy = layaPolicy(
    state('用Muse完成'),
    inference(),
    { runtimeId: 'account-b', model: 'pinned-model', effort: 'low' },
    targets,
  );
  assert.equal(policy.runtimeId, undefined);
  assert.ok(policy.conflicts.length);
  assert.equal(policy.suggestedTier, undefined);
  assert.equal(policy.suggestedEffort, undefined);
  assert.equal(policy.category?.id, 'code');
  const pinned = layaPolicy(state('实现功能'), inference(), { model: 'pinned-model', effort: 'low' }, targets);
  assert.equal(pinned.suggestedTier, undefined);
  assert.equal(pinned.suggestedEffort, undefined);
});

test('resolves current card labels, quoted names, IDs and renamed cards dynamically', () => {
  for (const prompt of ["用'Muse'完成", '让Muse运行', 'use account-a', '调用“Nova Prime”完成']) {
    assert.equal(
      layaPolicy(state(prompt), inference(), {}, targets).runtimeId,
      prompt.includes('Nova') ? 'account-b' : 'account-a',
    );
  }
  const renamed = targets.map((target) => ({ ...target, label: target.id === 'account-a' ? '夜航' : target.label }));
  assert.equal(layaPolicy(state('让夜航运行'), inference(), {}, renamed).runtimeId, 'account-a');
  assert.equal(layaPolicy(state('用Muse完成'), inference(), {}, renamed).runtimeId, undefined);
});

test('quoted sentences, code, references and previous context cannot assign executors', () => {
  for (const prompt of [
    '解释“让Muse运行”这句话',
    'Explain "use Muse".',
    '翻译让Muse运行这句话',
    '> 用Muse执行',
    '```text\nuse Muse\n```',
  ]) {
    assert.equal(
      layaPolicy(
        state(prompt, { reference_text: '用Muse执行', recent_context: '让Muse运行' }),
        inference(),
        {},
        targets,
      ).runtimeId,
      undefined,
    );
  }
  assert.equal(
    layaPolicy(state('这次正常实现', { recent_context: '只读，不要执行，让Muse运行' }), inference(), {}, targets)
      .permissionMode,
    undefined,
  );
  const corrected = layaPolicy(state('之前只读、不要执行、用Muse，这次改用Nova Prime实现'), inference(), {}, targets);
  assert.equal(corrected.permissionMode, undefined);
  assert.equal(corrected.prohibitCommands, undefined);
  assert.equal(corrected.runtimeId, 'account-b');
});

test('reassignment and exclusion are deterministic and do not contradict a fixed card', () => {
  for (const prompt of [
    '不要用Muse，改用Nova Prime',
    '不用Muse，交给Nova Prime',
    "don't use Muse, switch to Nova Prime",
  ]) {
    const policy = layaPolicy(state(prompt), inference(), {}, targets);
    assert.equal(policy.runtimeId, 'account-b');
    assert.deepEqual(policy.excludeRuntimeIds, ['account-a']);
  }
  const fixed = layaPolicy(state('不要用Muse'), inference(), { runtimeId: 'account-a' }, targets);
  assert.deepEqual(fixed.excludeRuntimeIds, ['account-a']);
  assert.ok(fixed.conflicts.length);
  const contractions = layaPolicy(state("don't use Muse, don't use Nova Prime"), inference(), {}, targets);
  assert.equal(contractions.runtimeId, undefined);
  assert.deepEqual(contractions.excludeRuntimeIds, ['account-a', 'account-b']);
});

test('conditional, hesitant, competing and ambiguous requests produce conflicts without executor suggestions', () => {
  for (const prompt of [
    '如果有空，用Muse完成',
    '也许让Muse来做',
    '用Muse还是Nova Prime',
    'use Muse or Nova Prime',
    '用Muse；用Nova Prime',
    '不要用Muse；用Muse',
  ]) {
    const policy = layaPolicy(state(prompt), inference(), {}, targets);
    assert.equal(policy.runtimeId, undefined, prompt);
    assert.ok(policy.conflicts.length, prompt);
    assert.equal(policy.category?.id, 'code', prompt);
    assert.equal(policy.suggestedTier, 'strong', prompt);
  }
  const duplicate = [...targets, { ...targets[0]!, id: 'account-c' }];
  assert.ok(layaPolicy(state("用'Muse'完成"), inference(), {}, duplicate).conflicts.length);
  const partial = targets.map((target, index) => ({ ...target, label: index ? 'Muse Two' : 'Muse One' }));
  assert.ok(layaPolicy(state('用Muse完成'), inference(), {}, partial).conflicts.length);
});

test('disabled, opted-out or provider-ambiguous executors are never selected', () => {
  assert.ok(
    layaPolicy(
      state('用Muse完成'),
      inference(),
      {},
      targets.map((target) => ({ ...target, enabled: false })),
    ).conflicts.length,
  );
  assert.ok(
    layaPolicy(
      state('用Muse完成'),
      inference(),
      {},
      targets.map((target) => ({ ...target, executionDisabledByUser: true })),
    ).conflicts.length,
  );
  const sameProvider = targets.map((target) => ({ ...target, provider: 'codex' as const }));
  assert.ok(layaPolicy(state('use codex'), inference(), {}, sameProvider).conflicts.length);
});

test('explicit read-only and no-execution limits only narrow permissions', () => {
  const policy = layaPolicy(
    state('只读分析，不要实际执行任何命令'),
    inference(),
    { permissionMode: 'workspace-write' },
    targets,
  );
  assert.equal(policy.permissionMode, 'read-only');
  assert.equal(policy.prohibitCommands, true);
  assert.ok(policy.conflicts.length);
  assert.equal(policy.suggestedTier, undefined);
  const modelOnly = layaPolicy(
    state('分析问题'),
    inference({ project_access: 'read', run_commands: 'no' }),
    { permissionMode: 'read-only' },
    targets,
  );
  assert.equal(modelOnly.permissionMode, undefined);
  assert.equal(modelOnly.prohibitCommands, undefined);
  assert.equal(
    layaPolicy(state('只读'), inference(), { permissionMode: 'workspace-write', permissionReauthorized: true }, targets)
      .permissionMode,
    undefined,
  );
  assert.equal(
    layaPolicy(
      state('Do not edit any files'),
      inference(),
      { permissionMode: 'workspace-write', explicitWrite: true },
      targets,
    ).permissionMode,
    undefined,
  );
  const specific = layaPolicy(state('不要运行测试，但可以用命令读取文件'), inference(), {}, targets);
  assert.equal(specific.prohibitCommands, undefined);
  for (const message of ['不要修改 config.json，修改 src/task.ts', 'Do not edit config.json; update src/task.ts'])
    assert.equal(
      layaPolicy(state(message), inference(), { permissionMode: 'workspace-write' }, targets).permissionMode,
      undefined,
    );
  for (const message of ['给文件属性添加只读模式切换按钮', 'Implement a toggle for read-only mode']) {
    const feature = layaPolicy(state(message), inference(), {}, targets);
    assert.equal(feature.permissionMode, undefined);
    assert.deepEqual(feature.conflicts, []);
  }
  const conditional = layaPolicy(state('如果只读分析就不要运行测试'), inference(), {}, targets);
  assert.equal(conditional.permissionMode, undefined);
  assert.equal(conditional.prohibitCommands, undefined);
  assert.ok(conditional.conflicts.length);
});

test('explicit run and authenticated-browser requests reveal conflicting model judgments', () => {
  for (const prompt of ['运行测试', 'run the tests', '执行npm test']) {
    const policy = layaPolicy(state(prompt), inference({ run_commands: 'no' }), {}, targets);
    assert.ok(policy.conflicts.some((reason) => reason.includes('command')));
    assert.equal(policy.suggestedTier, undefined);
  }
  const browser = layaPolicy(state('在已登录网页点击按钮'), inference(), {}, targets);
  assert.ok(browser.conflicts.some((reason) => reason.includes('browser')));
  assert.equal(browser.category, undefined);
});

test('attachments remain metadata, explicit opt-outs win and unsupported modality is not forced', () => {
  const attachments = [{ kind: 'image', name: 'fixture.png', mime_type: 'image/png' }];
  const neutral = layaPolicy(state('写一个函数', { attachments }), inference(), {}, targets);
  assert.equal(neutral.category?.id, 'code');
  assert.deepEqual(neutral.conflicts, []);
  const ignored = layaPolicy(state('忽略附件，写一个函数', { attachments }), inference(), {}, targets);
  assert.deepEqual(ignored.conflicts, []);
  const active = layaPolicy(state('分析这张图片', { attachments }), inference(), {}, targets);
  assert.ok(active.conflicts.some((reason) => reason.includes('modality')));
  assert.equal(active.category, undefined);
});

test('fallback keeps explicit limits but does not apply model suggestions or raw executor guesses', () => {
  const policy = layaPolicy(state('只读，用Muse完成'), { ...inference(), status: 'fallback' }, {}, targets);
  assert.equal(policy.permissionMode, 'read-only');
  assert.equal(policy.runtimeId, 'account-a');
  assert.equal(policy.category, undefined);
  const hallucinated = layaPolicy(state('比较两个执行器'), inference({ executor_intent: 'assign' }), {}, targets);
  assert.ok(hallucinated.conflicts.length);
  assert.equal(hallucinated.category?.id, 'code');
});

test('fallback and compacted judgments keep strong advice through executor conflicts and pins', () => {
  for (const result of [
    { ...inference(), status: 'fallback' as const, reason: 'warming' },
    { ...inference(), status: 'fallback' as const, reason: 'timeout' },
    { ...inference(), raw: { usage: { input_compacted: true } } },
  ]) {
    const policy = layaPolicy(state('如果需要，用Muse完成'), result, {}, targets);
    assert.ok(policy.conflicts.length);
    assert.equal(policy.suggestedTier, 'strong');
    assert.equal(policy.suggestedEffort, 'high');
    assert.equal(policy.needsAssessment, true);
    const pinned = layaPolicy(state('实现'), result, { model: 'fixed', effort: 'low' }, targets);
    assert.equal(pinned.suggestedTier, undefined);
    assert.equal(pinned.suggestedEffort, undefined);
  }
});

test('disabled Laya leaves local classification and model selection unchanged without assessment', () => {
  const prompt = 'Rename a variable in one file.';
  const policy = layaPolicy(state(prompt), { ...inference(), status: 'fallback', reason: 'disabled' }, {}, targets);
  assert.equal(policy.needsAssessment, undefined);
  assert.equal(policy.category, undefined);
  assert.equal(policy.suggestedTier, undefined);
  assert.equal(policy.suggestedEffort, undefined);
  assert.equal(policy.applied, false);
  const picked = route(
    {
      prompt,
      kind: 'auto',
      projectPath: 'synthetic',
      suggestedTier: policy.suggestedTier,
      suggestedEffort: policy.suggestedEffort,
    },
    [
      {
        id: 'claude-fixture',
        provider: 'claude',
        label: 'Synthetic',
        environment: 'native',
        installed: true,
        status: 'ready',
        models: ['haiku', 'sonnet', 'opus'].map((id) => ({ id, label: id, efforts: ['low', 'medium', 'high'] })),
        capabilities: { execute: true, resume: true, cancel: true, approvals: true },
        quota: {
          status: 'known',
          source: 'synthetic',
          observedAt: new Date().toISOString(),
          windows: [
            {
              id: 'weekly',
              label: 'Weekly',
              usedPercent: 20,
              resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
            },
          ],
        },
        refreshedAt: new Date().toISOString(),
      },
    ],
    {
      refreshSeconds: 60,
      reservePercent: 10,
      maxQuotaAgeSeconds: 180,
      preferCli: true,
      designProvider: 'claude',
      architectureProvider: 'codex',
      routineProvider: 'claude',
      unknownQuotaPolicy: 'manual-only',
      defaultProjectPath: 'synthetic',
      maxConcurrentRuns: 2,
    },
  );
  assert.deepEqual([picked.kind, picked.model, picked.effort], ['routine', 'haiku', 'low']);
});

test('an unreadable referenced brief gets strong/high and an assessment even with Laya off', () => {
  const policy = layaPolicy(
    state('请按 .design/brief-missing.md 实现'),
    { ...inference(), status: 'fallback', reason: 'disabled' },
    { briefUnreadable: true },
    targets,
  );
  assert.deepEqual([policy.needsAssessment, policy.suggestedTier, policy.suggestedEffort], [true, 'strong', 'high']);
  assert.match(policy.reasons.join('\n'), /referenced brief cannot be read/);
  const pinned = layaPolicy(state('x'), inference(), { briefUnreadable: true, model: 'opus', effort: 'low' }, targets);
  assert.deepEqual([pinned.suggestedTier, pinned.suggestedEffort], [undefined, undefined]);
});

test('an unavailable judge keeps the ordinary tier for a message the rules answer as a reply', () => {
  for (const reason of ['warming', 'timeout', 'busy', 'cooldown', 'error']) {
    const reply = layaPolicy(
      state('这个租来怎么用啊？'),
      { ...inference(), status: 'fallback', reason },
      { replyOnly: true },
      targets,
    );
    assert.deepEqual(
      [reply.needsAssessment, reply.suggestedTier, reply.suggestedEffort],
      [undefined, undefined, undefined],
    );
    assert.match(reply.reasons.join('\n'), /handle this as a reply at the ordinary tier/);
    // A task, or a message whose handling is unknown, keeps the precaution.
    for (const input of [{}, { replyOnly: false }]) {
      const task = layaPolicy(state('继续做完'), { ...inference(), status: 'fallback', reason }, input, targets);
      assert.deepEqual([task.needsAssessment, task.suggestedTier, task.suggestedEffort], [true, 'strong', 'high']);
    }
  }
  // Work of unknown size stays strong even when it reads as a reply: the judge saw only part of it.
  for (const [result, input] of [
    [{ ...inference(), raw: { usage: { input_compacted: true } } }, { replyOnly: true }],
    [{ ...inference(), status: 'fallback' as const, reason: 'input_too_large' }, { replyOnly: true }],
    [
      { ...inference(), status: 'fallback' as const, reason: 'timeout' },
      { replyOnly: true, briefUnreadable: true },
    ],
  ] as const) {
    const policy = layaPolicy(state('这个租来怎么用啊？'), result, input, targets);
    assert.deepEqual([policy.needsAssessment, policy.suggestedTier, policy.suggestedEffort], [true, 'strong', 'high']);
  }
});

test('cancelled, skipped and unknown judgments do not request fallback assessment', () => {
  for (const [status, reason] of [
    ['fallback', 'cancelled'],
    ['fallback', 'unknown'],
    ['skipped', 'incognito'],
    ['skipped', 'explicit-restriction'],
    ['skipped', 'queued-pending-judgment'],
    ['skipped', 'timeout'],
  ] as const) {
    const policy = layaPolicy(state('只读，不要运行命令'), { ...inference(), status, reason }, {}, targets);
    assert.equal(policy.needsAssessment, undefined, reason);
    assert.equal(policy.suggestedTier, undefined, reason);
    assert.equal(policy.suggestedEffort, undefined, reason);
    assert.equal(policy.category, undefined, reason);
    assert.equal(policy.permissionMode, 'read-only', reason);
    assert.equal(policy.prohibitCommands, true, reason);
  }
});

for (const reason of [
  'warming',
  'starting',
  'timeout',
  'busy',
  'cooldown',
  'error',
  'input_too_large',
  'invalid_state',
]) {
  test(`Laya ${reason} requests strong/high advice and assessment`, () => {
    const policy = layaPolicy(state('Hello'), { ...inference(), status: 'fallback', reason }, {}, targets);
    assert.equal(policy.suggestedTier, 'strong');
    assert.equal(policy.suggestedEffort, 'high');
    assert.equal(policy.needsAssessment, true);
  });
}

test('a card named as the topic of a question is not assigned when Laya sees no executor instruction', () => {
  // Regression: asking when DeepSeek is cheapest pinned the paid DeepSeek card and blocked the reply.
  const cards: RuntimeTarget[] = [
    ...targets,
    {
      id: 'api-deepseek',
      label: 'DeepSeek',
      provider: 'pi',
      gateway: 'api',
      apiProvider: 'deepseek',
      command: 'pi',
      enabled: true,
      environment: 'native',
    },
  ];
  for (const intent of ['none', 'mention_only'] as const) {
    const policy = layaPolicy(
      state('DeepSeek是不是按照时间有价格区别啊？我什么时间段在伦敦使用DeepSeek才是最便宜的呢？'),
      inference({ task_type: 'conversation', executor_intent: intent }),
      {},
      cards,
    );
    assert.equal(policy.runtimeId, undefined);
    assert.deepEqual(policy.excludeRuntimeIds, []);
  }
  const assigned = layaPolicy(
    state('这个问题用DeepSeek回答'),
    inference({ task_type: 'conversation', executor_intent: 'assign' }),
    {},
    cards,
  );
  assert.equal(assigned.runtimeId, 'api-deepseek');
});
