import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRoutingRules, reorderCandidates } from '../src/shared/routing-parser.ts';
import { conversationRoutingSchema } from '../src/shared/routing-schema.ts';
import { parseRoutingText, type RoutingCard } from '../src/shared/conversation-routing.ts';

const cards: RoutingCard[] = [
  {
    id: 'cursor',
    label: 'Cursor · 本机',
    provider: 'cursor',
    models: [
      { id: 'glm-5', label: 'GLM 5', efforts: [] },
      { id: 'glm-5p3', label: 'GLM 5.3', efforts: ['high'] },
    ],
  },
];

test('the owner planner and verifier wording resolves compact model names and ordered alternatives', () => {
  const executors: RoutingCard[] = [
    {
      id: 'claude',
      label: 'Claude',
      provider: 'claude',
      models: [{ id: 'opus', label: 'Claude Opus 5.5', efforts: ['high'] }],
    },
    {
      id: 'codex',
      label: 'Codex',
      provider: 'codex',
      models: [
        { id: 'gpt-6-astra', label: 'GPT 6 Astra', efforts: ['high'] },
        { id: 'gpt-6-sol', label: 'GPT 6 Sol', efforts: ['high'] },
      ],
    },
    {
      id: 'cursor-sol',
      label: 'Cursor account',
      provider: 'cursor',
      models: [{ id: 'gpt-6-sol', label: 'GPT 6 Sol', efforts: ['high'] }],
    },
  ];
  const result = parseRoutingRules(
    '直接使用Opus5.5作为开始，不需要判断，然后后面分配具体的任务给不同的模型和强度，codex astra或者sol进行核验',
    executors,
  );
  assert.deepEqual(result.roles, {
    coordinator: { provider: 'claude', model: 'opus' },
    verifier: [
      { provider: 'codex', model: 'gpt-6-astra' },
      { provider: 'codex', model: 'gpt-6-sol' },
    ],
  });
  assert.deepEqual(result.rules, []);
  assert.deepEqual(result.unparsed, []);
  assert.deepEqual(conversationRoutingSchema.parse(result), result);
  for (const start of ['先用', '开头用', '规划用'])
    assert.equal(parseRoutingRules(`${start}Opus5.5`, executors).roles?.coordinator?.model, 'opus');
  for (const verify of ['核验', '审核', '检查', '验收', 'review', 'verify'])
    assert.deepEqual(
      parseRoutingRules(`${verify}用 Codex astra，不行换 sol`, executors).roles?.verifier?.map(
        (candidate) => candidate.model,
      ),
      ['gpt-6-astra', 'gpt-6-sol'],
    );
  assert.deepEqual(parseRoutingRules('核验用 Codex astra 或者 Cursor account 的 sol', executors).roles?.verifier, [
    { provider: 'codex', model: 'gpt-6-astra' },
    { runtimeId: 'cursor-sol', provider: 'cursor', model: 'gpt-6-sol' },
  ]);
  const named = executors.map((card) => (card.id === 'codex' ? { ...card, label: 'Work Codex' } : card));
  assert.deepEqual(
    parseRoutingRules('核验用 Work Codex 的 astra 或 sol', named).roles?.verifier,
    ['gpt-6-astra', 'gpt-6-sol'].map((model) => ({ runtimeId: 'codex', provider: 'codex', model })),
  );
  assert.deepEqual(parseRoutingRules('核验用 Codex astra 或 imaginary', executors).unparsed, [
    '核验用 Codex astra 或 imaginary',
  ]);
  assert.deepEqual(parseRoutingRules('然后后面分配具体的任务给不同的模型和强度，但只用未知模型', executors).unparsed, [
    '但只用未知模型',
  ]);
});
test('the owner sentence drafts adult strict ordered candidates and clears other', () => {
  const result = parseRoutingRules('成人内容可以用 grok 或者 cursor 里的 GLM，其他内容照旧自动', cards);
  assert.equal(result.rules.length, 2);
  assert.deepEqual(result.unparsed, []);
  assert.deepEqual(result.rules[0]?.candidates, [{ provider: 'grok' }, { provider: 'cursor', model: 'glm-5p3' }]);
  assert.equal(result.rules[0]?.strict, true);
  assert.equal(result.rules[1]?.category, 'other');
  assert.deepEqual(result.rules[1]?.candidates, []);
  assert.equal(result.rules[1]?.strict, false);
  assert.deepEqual(conversationRoutingSchema.parse(result), result);
  assert.deepEqual(parseRoutingText(result.text, cards), result, 'the existing public parser now drafts v2 rules');
});
test('connectors preserve order; only means strict while other categories default to prefer', () => {
  for (const connector of ['或', '或者', '不行就', '再用', '其次', '、', ' or ', ' then ', ' else ']) {
    const [rule] = parseRoutingRules(`代码用 codex${connector}claude`, cards).rules;
    assert.deepEqual(rule?.candidates, [{ provider: 'codex' }, { provider: 'claude' }]);
    assert.equal(rule?.strict, false);
  }
  assert.equal(parseRoutingRules('代码只能用 codex', cards).rules[0]?.strict, true);
  assert.equal(parseRoutingRules('成人内容优先用 grok', cards).rules[0]?.strict, false);
  assert.equal(parseRoutingRules('writing only claude', cards).rules[0]?.strict, true);
});
test('unknown clauses and unavailable named model families remain unparsed; custom labels work', () => {
  assert.deepEqual(parseRoutingRules('写作交给月亮；这句请保留', cards).unparsed, ['写作交给月亮', '这句请保留']);
  assert.deepEqual(parseRoutingRules('成人内容用 cursor 里的 GLM', []).unparsed, ['成人内容用 cursor 里的 GLM']);
  const categories = [{ id: 'custom:legal', label: '法律', keywords: ['合同'] }];
  assert.equal(parseRoutingRules('法律用 claude', cards, categories).rules[0]?.category, 'custom:legal');
});
test('schema rejects v1, duplicate categories, privilege fields, arbitrary providers and overlong keywords', () => {
  const result = parseRoutingRules('代码用 codex', cards);
  for (const bad of [
    { ...result, version: 1 },
    { ...result, rules: [...result.rules, ...result.rules] },
    { ...result, permissionMode: 'workspace-write' },
    { ...result, rules: [{ ...result.rules[0], candidates: [{ provider: 'unknown' }] }] },
    { ...result, categories: [{ id: 'custom:legal', label: '法律', keywords: ['x'.repeat(81)] }] },
    { ...result, rules: [{ ...result.rules[0], candidates: [{ provider: 'codex', tools: true }] }] },
  ])
    assert.equal(conversationRoutingSchema.safeParse(bad).success, false);
});
test('candidate reorder is immutable, with invalid positions ignored', () => {
  const rule = parseRoutingRules('代码用 codex 或 claude', cards).rules[0]!;
  assert.deepEqual(reorderCandidates(rule, 0, 1).candidates, [{ provider: 'claude' }, { provider: 'codex' }]);
  assert.equal(rule.candidates[0]?.provider, 'codex');
  assert.equal(reorderCandidates(rule, -1, 1), rule);
});
