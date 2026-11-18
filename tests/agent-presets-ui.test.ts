import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { builtinAgentPresets, type AgentPreset, type AgentPresetDraft } from '../src/shared/agent-presets.ts';
import { AgentPresetDialog, agentPresetPayload, saveAgentPreset } from '../src/ui/AgentPresets.tsx';
import { MentionMenu, mentionItems, rankMentions } from '../src/ui/Mentions.tsx';
import { mentionPrefixAt } from '../src/shared/mentions.ts';
import type { RuntimeTarget } from '../src/shared/types.ts';
import type { Api } from '../src/ui/Workspace.tsx';

const draft: AgentPresetDraft = {
  name: 'My reviewer',
  description: 'Review source files.',
  instructions: 'Check correctness before proposing changes.',
  mode: 'chat',
  permissionMode: 'read-only',
};
const custom: AgentPreset = { ...draft, id: 'custom-one' };

test('@ offers roles and executors, most used first, without showing private role instructions', () => {
  const executors: RuntimeTarget[] = [
    {
      id: 'grok-native',
      provider: 'grok',
      label: 'Grok · 本机',
      environment: 'native',
      command: 'grok',
      enabled: true,
    },
    { id: 'codex-b', provider: 'codex', label: 'Codex B', environment: 'native', command: 'codex', enabled: true },
  ];
  const presets = mentionItems(
    [...builtinAgentPresets, { ...custom, instructions: 'PRIVATE_ROLE_INSTRUCTIONS' }],
    executors,
  );
  const ranked = rankMentions(presets, '', {
    'custom-one': { count: 3, last: 1 },
    'executor:grok-native': { count: 2, last: 3 },
    'code-review': { count: 1, last: 2 },
  });
  assert.deepEqual(
    ranked.slice(0, 3).map((item) => [item.kind, item.name]),
    [
      ['role', 'My reviewer'],
      ['executor', 'Grok'],
      ['role', '代码审查'],
    ],
  );
  assert.ok(
    ranked.some((item) => item.kind === 'executor' && item.name === 'Codex B'),
    'other accounts keep their name',
  );
  assert.ok(
    ranked.some((item) => item.id === 'third-party-review'),
    'a ready-made reviewer is always there to call',
  );
  assert.ok(!ranked.some((preset) => preset.id === 'standard'), 'the default assistant is not someone you call');
  assert.deepEqual(
    rankMentions(presets, 'my', {}).map((preset) => preset.id),
    ['custom-one'],
  );
  let called = 0;
  const html = renderToStaticMarkup(
    createElement(MentionMenu, {
      items: ranked,
      active: 0,
      onHover() {
        called++;
      },
      onPick() {
        called++;
      },
      onCreate() {
        called++;
      },
    }),
  );
  assert.match(html, /My reviewer/);
  assert.match(html, /新建角色/);
  assert.match(html, /aria-selected="true"/);
  assert.doesNotMatch(html, /PRIVATE_ROLE_INSTRUCTIONS/);
  assert.equal(called, 0);
  assert.deepEqual(mentionPrefixAt('请 @@代码', 6), { start: 2, tier: 2, query: '代码' });
  assert.deepEqual(mentionPrefixAt('请 @代码', 5), { start: 2, tier: 1, query: '代码' });
  assert.equal(mentionPrefixAt('mail@example', 12), undefined, 'an @ inside a word is not a call');
});

test('dialog is accessible, uses local opt-in generation and does no API work on render', () => {
  let calls = 0;
  const api: Api = async <T>() => {
    calls++;
    return {} as T;
  };
  const html = renderToStaticMarkup(
    createElement(AgentPresetDialog, { presets: [...builtinAgentPresets, custom], api, notify() {}, onClose() {} }),
  );
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby=/);
  assert.match(html, /关闭角色管理/);
  assert.match(html, /内置 · 可复制/);
  assert.match(html, /自定义/);
  assert.match(html, /生成本地草稿/);
  assert.match(html, /不调用模型/);
  assert.match(html, /点击保存后才成为角色/);
  assert.match(html, /当前运行不会改变/);
  assert.match(html, /maxLength="3000"/);
  assert.match(html, /maxLength="8000"/);
  assert.match(html, /maxLength="60"/);
  assert.equal(calls, 0);
});

test('payload trims fields, removes built-in identity and timestamps, deduplicates skills', () => {
  const result = agentPresetPayload(
    {
      ...draft,
      name: '  Reader  ',
      description: '  Read files  ',
      instructions: '  Read only  ',
      preferredModel: '  small  ',
      createdAt: 'old',
      updatedAt: 'old',
    },
    ' read_file, search\nread_file， inspect ',
  );
  assert.deepEqual(result, {
    name: 'Reader',
    description: 'Read files',
    instructions: 'Read only',
    mode: 'chat',
    permissionMode: 'read-only',
    preferredModel: 'small',
    skills: ['read_file', 'search', 'inspect'],
  });
  assert.equal('id' in result, false);
  assert.equal('createdAt' in result, false);
});

test('payload enforces text bounds, preserves permission choice, and leaves automatic preferences absent', () => {
  assert.throws(() => agentPresetPayload({ ...draft, name: ' ' }, ''), /名称/);
  assert.throws(() => agentPresetPayload({ ...draft, name: 'x'.repeat(61) }, ''), /名称/);
  assert.throws(() => agentPresetPayload({ ...draft, description: 'x'.repeat(3001) }, ''), /描述/);
  assert.throws(() => agentPresetPayload({ ...draft, instructions: 'x'.repeat(8001) }, ''), /指令/);
  const result = agentPresetPayload(
    { ...draft, preferredModel: ' ', preferredEffort: '', permissionMode: 'read-only' },
    '',
  );
  assert.equal(result.permissionMode, 'read-only');
  for (const key of ['preferredProvider', 'preferredModel', 'preferredEffort', 'skills'])
    assert.equal(key in result, false);
  assert.equal(agentPresetPayload({ ...draft, instructions: '' }, '').instructions, '');
});

test('save creates a custom role with a flat body and lets the server allocate its identifier', async () => {
  const calls: unknown[][] = [];
  const api: Api = async <T>(...args: [string, unknown?, string?]) => {
    calls.push(args);
    return { preset: custom } as T;
  };
  const saved = await saveAgentPreset(api, draft);
  assert.equal(saved, custom);
  assert.deepEqual(calls, [['/api/agent-presets', draft, 'POST']]);
  assert.equal('id' in (calls[0][1] as object), false);
});

test('save updates an existing custom role and refuses built-in mutation before calling the API', async () => {
  const calls: unknown[][] = [];
  const api: Api = async <T>(...args: [string, unknown?, string?]) => {
    calls.push(args);
    return { preset: custom } as T;
  };
  await saveAgentPreset(api, draft, custom.id);
  assert.deepEqual(calls, [[`/api/agent-presets/${custom.id}`, draft, 'PUT']]);
  await assert.rejects(saveAgentPreset(api, draft, 'standard'), /内置角色只能复制/);
  assert.equal(calls.length, 1);
});

test('save failures propagate for the dialog to show instead of claiming success', async () => {
  const api: Api = async () => {
    throw new Error('Storage unavailable');
  };
  await assert.rejects(saveAgentPreset(api, draft), /Storage unavailable/);
});

test('fifty existing custom roles prevent additional new-role actions', () => {
  const presets = [
    ...builtinAgentPresets,
    ...Array.from({ length: 50 }, (_, index) => ({ ...custom, id: `custom-${index}` })),
  ];
  const api: Api = async <T>() => ({}) as T;
  const html = renderToStaticMarkup(createElement(AgentPresetDialog, { presets, api, notify() {}, onClose() {} }));
  assert.match(html, /disabled="" aria-pressed="true">＋ 新建角色/);
  assert.match(html, /50\/50 个自定义角色/);
});
