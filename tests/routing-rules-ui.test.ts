import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';
import { parseRoutingRules } from '../src/shared/routing-parser.ts';
import type { RoutingCard } from '../src/shared/conversation-routing.ts';
import type { RulesDraft } from '../src/ui/RoutingRulesEditor.tsx';

const bundle = uiBundle('src/ui/RoutingRulesEditor.tsx');
const cards: RoutingCard[] = [
  {
    id: 'cursor',
    label: 'Cursor · 本机',
    provider: 'cursor',
    models: [{ id: 'glm-5p3', label: 'GLM 5.3', efforts: ['high'] }],
  },
];

test('stored stages, automatic switching and verification round-trip without a description', async () => {
  const harness = uiHarness(await bundle);
  let value: RulesDraft = {
    version: 2,
    text: '',
    unparsed: [],
    rules: [
      {
        id: 'code',
        category: 'code',
        enabled: true,
        strict: false,
        source: 'manual',
        candidates: [{ provider: 'cursor' }],
      },
    ],
    roles: {
      coordinator: { provider: 'cursor' },
      verifier: [{ provider: 'cursor', model: 'glm-5p3', effort: 'high' }],
    },
  };
  let saved: RulesDraft | undefined;
  const props = {
    value,
    cards,
    api: async () => {
      throw Error('No model call expected');
    },
    onChange(next: RulesDraft) {
      props.value = value = next;
    },
    onSave(next: RulesDraft) {
      saved = next;
    },
    onError() {},
  };
  const render = () => harness.render('RoutingRulesEditor', props);
  const control = (label: string) => findNode(render(), (node) => node.props['aria-label'] === label)!;
  assert.equal(control('路由流程').props.children.length, 3);
  assert.match(text(render()), /开始.*执行.*核验/s);
  assert.equal(control('按分类指定子任务').props.checked, true);
  assert.equal(control('完成后核验').props.checked, true);
  const originalRules = value.rules;
  control('自动执行子任务').props.onChange();
  assert.equal(value.rules, originalRules);
  assert.equal(
    findNode(render(), (node) => node.props['aria-label'] === '代码候选顺序'),
    undefined,
  );
  control('按分类指定子任务').props.onChange();
  assert.equal(value.rules, originalRules);
  const originalVerifier = value.roles!.verifier;
  control('完成后核验').props.onChange({ target: { checked: false } });
  assert.equal(value.roles?.verifier, undefined);
  control('完成后核验').props.onChange({ target: { checked: true } });
  assert.equal(value.roles?.verifier, originalVerifier);
  findNode(render(), (node) => node.type === 'button' && node.props.children === '保存并启用')!.props.onClick();
  assert.equal(saved?.rules, originalRules);
  assert.equal(saved?.roles?.verifier, originalVerifier);
  control('自动执行子任务').props.onChange();
  control('完成后核验').props.onChange({ target: { checked: false } });
  findNode(render(), (node) => node.type === 'button' && node.props.children === '保存并启用')!.props.onClick();
  assert.equal(saved?.rules.length, 0);
  assert.equal(saved?.roles?.verifier, undefined);
  assert.equal(value.rules, originalRules);
  harness.unmount();
});

test('empty profile can be saved using only the fixed flow and offers at most one backup', async () => {
  const harness = uiHarness(await bundle);
  let value: RulesDraft | undefined;
  let saved: RulesDraft | undefined;
  const props = {
    value,
    cards,
    api: async () => {
      throw Error('No model call expected');
    },
    onChange(next: RulesDraft) {
      props.value = value = next;
    },
    onSave(next: RulesDraft) {
      saved = next;
    },
    onError() {},
  };
  const render = () => harness.render('RoutingRulesEditor', props);
  const save = () => findNode(render(), (node) => node.type === 'button' && node.props.children === '保存并启用')!;
  assert.equal(!!save().props.disabled, false);
  save().props.onClick();
  assert.equal(saved?.text, '');
  findNode(render(), (node) => node.props['aria-label'] === '完成后核验')!.props.onChange({
    target: { checked: true },
  });
  findNode(render(), (node) => node.type === 'button' && node.props.children === '添加备用')!.props.onClick();
  assert.equal(value?.roles?.verifier?.length, 2);
  assert.equal(
    findNode(render(), (node) => node.type === 'button' && node.props.children === '添加备用'),
    undefined,
  );
  findNode(render(), (node) => node.props['aria-label'] === '删除核验候选 2')!.props.onClick();
  assert.equal(value?.roles?.verifier?.length, 1);
  harness.unmount();
});

test('conversation save and undo reset stage state; delayed parsing preserves the current executor checklist', async () => {
  const parent = uiHarness(await uiBundle('src/ui/ConversationPanel.tsx'));
  const child = uiHarness(await bundle);
  const original = {
    ...parseRoutingRules('代码用 cursor', cards),
    automaticExecutors: ['cursor'],
    updatedAt: 'before',
  };
  let stored = original;
  let resolveCompile!: (value: unknown) => void;
  const props = {
    conversation: { id: 'synthetic', routing: original, routingHistory: [original] },
    state: {
      settings: {},
      targets: [{ ...cards[0], enabled: true }],
      runtimes: [{ ...cards[0], installed: true, status: 'ready' }],
    },
    api: async (path: string, body: any) => {
      if (path.endsWith('/compile'))
        return new Promise((resolve) => {
          resolveCompile = resolve;
        });
      stored = body.undo ? original : { ...body.routing, updatedAt: 'saved' };
      return { ...props.conversation, routing: stored };
    },
    notify() {},
  };
  let key: unknown;
  const editor = () =>
    findNode(parent.render('RoutingTab', props), (node) => node.type?.name === 'RoutingRulesEditor')!;
  const render = () => {
    const element = editor();
    if (key !== element.key) {
      child.remount();
      key = element.key;
    }
    return child.render('RoutingRulesEditor', element.props);
  };
  const control = (label: string) => findNode(render(), (node) => node.props['aria-label'] === label)!;
  const button = (label: string) =>
    findNode(render(), (node) => node.type === 'button' && node.props.children === label)!;
  assert.equal(control('按分类指定子任务').props.checked, true);
  control('自动执行子任务').props.onChange();
  button('保存修改').props.onClick();
  await nextTurn();
  assert.equal(stored.rules.length, 0);
  button('撤销上一次').props.onClick();
  await nextTurn();
  assert.equal(control('按分类指定子任务').props.checked, true);
  assert.ok(control('代码候选顺序'));
  control('路由规则原话').props.onChange({ target: { value: '其余用 cursor' } });
  button('重新解析').props.onClick();
  findNode(parent.render('RoutingTab', props), (node) => node.type?.name === 'ExecutorChecklist')!.props.onChange([
    'other',
  ]);
  resolveCompile({ draft: parseRoutingRules('其余用 cursor', cards), fallback: false });
  await nextTurn();
  assert.deepEqual(Array.from(editor().props.value.automaticExecutors), ['other']);
  child.unmount();
  parent.unmount();
});

test('advanced routing controls preserve editable exclusions and custom categories through parsing and saving', async () => {
  const harness = uiHarness(await bundle);
  let value: RulesDraft = { version: 2, text: '', rules: [], unparsed: [] };
  let saved: RulesDraft | undefined;
  const props = {
    value,
    cards,
    api: async () => {
      throw Error('Synthetic offline');
    },
    onChange(next: RulesDraft) {
      props.value = value = next;
    },
    onSave(next: RulesDraft) {
      saved = next;
    },
    onError() {},
    changed: true,
  };
  const render = () => harness.render('RoutingRulesEditor', props);
  const field = (label: string) => findNode(render(), (node) => node.props['aria-label'] === label)!;
  field('规则候选的选择方式').props.onChange({ target: { value: 'quota' } });
  field('自动选择时排除这些模型').props.onChange({ target: { value: '*-tiny,' } });
  assert.equal(field('自动选择时排除这些模型').props.value, '*-tiny,');
  field('自动选择时排除这些模型').props.onChange({ target: { value: '*-tiny, blocked' } });
  findNode(render(), (node) => node.type === 'button' && node.props.children === '添加自定义分类')!.props.onClick();
  const categoryId = value.categories![0]!.id;
  field(`分类名称 ${categoryId}`).props.onChange({ target: { value: '调查' } });
  field(`分类关键词 ${categoryId}`).props.onBlur({ target: { value: 'diagnose, root cause' } });
  field('路由规则原话').props.onChange({ target: { value: '调查优先 Cursor' } });
  findNode(render(), (node) => node.type === 'button' && node.props.children === '重新解析')!.props.onClick();
  await nextTurn();
  assert.equal(value.rules[0]?.category, categoryId);
  assert.equal(value.selection, 'quota');
  assert.deepEqual(JSON.parse(JSON.stringify(value.excludeModels)), ['*-tiny', 'blocked']);
  assert.deepEqual(JSON.parse(JSON.stringify(value.categories?.[0]?.keywords)), ['diagnose', 'root cause']);
  findNode(render(), (node) => node.type === 'button' && node.props.className === 'button primary')!.props.onClick();
  assert.equal(saved?.rules[0]?.category, categoryId);
  field(`删除自定义分类 调查`).props.onClick();
  assert.equal(value.categories?.length, 0);
  assert.equal(value.rules.length, 0);
  harness.unmount();
});
test('chips render, arrow and drag reorder the controlled draft, and save sends that exact order', async () => {
  const harness = uiHarness(await bundle);
  let value: RulesDraft = parseRoutingRules('成人内容用 grok 或 cursor 里的 GLM；其他照旧自动', cards);
  let saved: RulesDraft | undefined;
  const props = {
    value,
    cards,
    api: async () => {
      throw Error('Synthetic offline');
    },
    onChange(next: RulesDraft) {
      props.value = value = next;
    },
    onSave(next: RulesDraft) {
      saved = next;
    },
    onError() {},
    changed: true,
  };
  let tree = harness.render('RoutingRulesEditor', props);
  const control = (label: string) => findNode(tree, (node) => node.props['aria-label'] === label)!;
  assert.ok(control('成人内容候选顺序'));
  control('下移成人内容候选 1').props.onClick();
  assert.equal(value.rules[0]?.candidates[0]?.provider, 'cursor');
  tree = harness.render('RoutingRulesEditor', props);
  let data = '';
  const chips = control('成人内容候选顺序').props.children[0];
  chips[0].props.onDragStart({
    dataTransfer: {
      setData(_type: string, next: string) {
        data = next;
      },
    },
  });
  chips[1].props.onDrop({
    preventDefault() {},
    dataTransfer: {
      getData() {
        return data;
      },
    },
  });
  assert.equal(value.rules[0]?.candidates[0]?.provider, 'grok');
  tree = harness.render('RoutingRulesEditor', props);
  findNode(tree, (node) => node.type === 'button' && node.props.children === '保存并启用')!.props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), JSON.parse(JSON.stringify(value)));
  assert.deepEqual(JSON.parse(JSON.stringify(saved?.rules[0]?.candidates)), [
    { provider: 'grok' },
    { provider: 'cursor', model: 'glm-5p3' },
  ]);
  assert.ok(findNode(tree, (node) => node.props.draggable));
  harness.unmount();
});
test('parse, model/effort changes, candidate delete/add, strict toggle and undo callback work locally', async () => {
  const harness = uiHarness(await bundle);
  let value: RulesDraft | undefined;
  let undone = false;
  const props = {
    value,
    cards,
    api: async () => {
      throw Error('Synthetic offline');
    },
    onChange(next: RulesDraft) {
      props.value = value = next;
    },
    onSave() {},
    onError() {},
    canUndo: true,
    onUndo() {
      undone = true;
    },
  };
  let tree = harness.render('RoutingRulesEditor', props);
  findNode(tree, (node) => node.type === 'textarea')!.props.onChange({
    target: { value: '成人内容可以用 grok 或者 cursor 里的 GLM，其他内容照旧自动' },
  });
  tree = harness.render('RoutingRulesEditor', props);
  findNode(tree, (node) => node.type === 'button' && node.props.children === '重新解析')!.props.onClick();
  await nextTurn();
  assert.equal(value?.rules.length, 2);
  tree = harness.render('RoutingRulesEditor', props);
  findNode(tree, (node) => node.props['aria-label'] === '删除成人内容候选 1')!.props.onClick();
  assert.equal(value?.rules[0]?.candidates.length, 1);
  tree = harness.render('RoutingRulesEditor', props);
  findNode(tree, (node) => node.props['aria-label'] === '成人内容添加候选')!.props.onChange({
    target: { value: 'p:claude' },
  });
  assert.equal(value?.rules[0]?.candidates[1]?.provider, 'claude');
  tree = harness.render('RoutingRulesEditor', props);
  findNode(tree, (node) => node.props['aria-label'] === '成人内容规则方式')!.props.onChange({
    target: { value: 'prefer' },
  });
  assert.equal(value?.rules[0]?.strict, false);
  findNode(tree, (node) => node.type === 'button' && node.props.children === '撤销上一次')!.props.onClick();
  assert.equal(undone, true);
  const editor = harness.exports.RoutingCandidateEditor({
    value: value?.rules[0]?.candidates[0],
    cards,
    label: '候选',
    onChange(next: unknown) {
      assert.deepEqual(JSON.parse(JSON.stringify(next)), { provider: 'cursor', model: 'glm-5p3', effort: 'high' });
    },
  });
  findNode(editor, (node) => node.props['aria-label'] === '候选的强度')!.props.onChange({ target: { value: 'high' } });
  harness.unmount();
});
