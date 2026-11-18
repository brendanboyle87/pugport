import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  executorGroup,
  mediaModelKind,
  openPickerGroups,
  pickerMatches,
  readModelAge,
  shortPickerItems,
  splitOlderModels,
} from '../src/shared/model-groups.ts';
import { cursorModels, openaiModels, routerModels } from './helpers/model-picker-catalog.ts';
import { probeFreeSource } from '../src/server/free-sources.ts';
import { apiMediaModels } from '../src/server/api-model-discovery.ts';
import { planImageRoutes } from '../src/server/image-generation.ts';
import { piAdapter } from '../src/server/adapters/pi.ts';
import { fixture, finished } from './helpers/session-workspace.ts';
import type {
  ConversationMessage,
  ExecuteContext,
  ExecuteResult,
  RuntimeSnapshot,
  RuntimeTarget,
} from '../src/shared/types.ts';

const card = (id: string, provider: RuntimeTarget['provider'], extra: Partial<RuntimeTarget> = {}): RuntimeTarget => ({
  id,
  provider,
  label: id,
  command: 'unused',
  environment: 'native',
  enabled: true,
  ...extra,
});
const json = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;

test('models are classified Text, Image or Video from catalog metadata first, then from the id', () => {
  for (const id of [
    'gpt-image-2.5',
    'dall-e-3',
    'imagen-4.0-generate-001',
    'grok-imagine-image',
    'chatgpt-image-latest',
  ])
    assert.equal(mediaModelKind(id), 'image', id);
  for (const id of ['sora-2', 'sora-2-pro', 'veo-3.0-generate-preview', 'grok-imagine-video', 'models/veo-2.0'])
    assert.equal(mediaModelKind(id), 'video', id);
  for (const id of ['gpt-5.2', 'o4-mini', 'claude-sonnet-5', 'deepseek-chat', 'grok-4', 'gpt-4o-realtime'])
    assert.equal(mediaModelKind(id), undefined, id);
  // Metadata wins over the id: a provider's own output modalities decide.
  assert.equal(mediaModelKind('x-art-1', { output_modalities: ['image'] }), 'image');
  assert.equal(mediaModelKind('x-motion', { architecture: { output_modalities: ['video'] } }), 'video');
  assert.equal(mediaModelKind('gpt-image-lookalike-chat', { output_modalities: ['text'] }), undefined);
});

test('executors group by registry transport, never by name', () => {
  assert.equal(executorGroup('codex'), 'cli');
  assert.equal(executorGroup('claude'), 'cli');
  assert.equal(executorGroup('grok'), 'cli');
  assert.equal(executorGroup('cursor'), 'cli');
  assert.equal(executorGroup('pi'), 'api');
});

test('the selection group is always open; others open in a short list; the owner’s choice is remembered', () => {
  const short = [
    { id: 'cli', count: 7 },
    { id: 'api', count: 5 },
  ];
  assert.deepEqual([...openPickerGroups({ groups: short })], ['cli', 'api']);
  const long = [
    { id: 'text', count: shortPickerItems },
    { id: 'image', count: 2 },
    { id: 'video', count: 1 },
  ];
  assert.deepEqual([...openPickerGroups({ groups: long })], []);
  assert.deepEqual([...openPickerGroups({ groups: long, selectedGroup: 'image' })], ['image']);
  // Remembered: collapsed stays collapsed, opened stays open, but never hides the selection.
  assert.deepEqual(
    [
      ...openPickerGroups({
        groups: long,
        selectedGroup: 'text',
        remembered: { text: false, video: true },
      }),
    ],
    ['text', 'video'],
  );
  assert.deepEqual([...openPickerGroups({ groups: short, remembered: { api: false } })], ['cli']);
});

test('a model id is read for its line, family, version and pinned date from its structure alone', () => {
  const age = (id: string) => {
    const { line, family, major, minor, stamp, base } = readModelAge(id);
    return [line, family, major, minor, stamp, base];
  };
  assert.deepEqual(age('openai/gpt-5.4-2026-03-05'), ['gpt', 'gpt', 5, 4, '20260305', 'gpt-5.4']);
  assert.deepEqual(age('openai/gpt-4o-2024-08-06'), ['gpt', 'gpt', 4, 0, '20240806', 'gpt-4o']);
  assert.deepEqual(age('gpt-4-1106-preview'), ['gpt', 'gpt-preview', 4, 0, '1106', 'gpt-4-preview']);
  assert.deepEqual(age('claude-3-5-sonnet-20241022'), [
    'claude',
    'claude-sonnet',
    3,
    5,
    '20241022',
    'claude-3-5-sonnet',
  ]);
  assert.deepEqual(age('claude-sonnet-4-5'), ['claude-sonnet', 'claude-sonnet', 4, 5, '', 'claude-sonnet-4-5']);
  assert.deepEqual(age('o3-mini'), ['o', 'o-mini', 3, 0, '', 'o3-mini']);
  assert.deepEqual(age('gemini-1.5-pro-002'), ['gemini', 'gemini-pro', 1, 5, '002', 'gemini-1.5-pro']);
  // Sizes stay in the name; a date's later parts never become a version.
  assert.deepEqual(age('llama-3.1-8b-instruct'), ['llama', 'llama-8b-instruct', 3, 1, '', 'llama-3.1-8b-instruct']);
  assert.deepEqual(age('qwen-max-2025-01-25'), ['qwen-max', 'qwen-max', undefined, undefined, '20250125', 'qwen-max']);
  assert.deepEqual(age('codex-mini-latest'), [
    'codex-mini-latest',
    'codex-mini-latest',
    undefined,
    undefined,
    '',
    'codex-mini-latest',
  ]);
});

test('a long text-model list keeps older generations and superseded snapshots in More models', () => {
  const ids = (models: Array<{ id: string }>) => models.map((model) => model.id.slice(model.id.indexOf('/') + 1));
  const { current, older } = splitOlderModels(openaiModels);
  assert.equal(current.length + older.length, openaiModels.length, 'every model stays listed');
  for (const id of ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.2', 'gpt-5', 'gpt-5-codex', 'o4-mini', 'codex-mini-latest'])
    assert.ok(ids(current).includes(id), `${id} is current`);
  assert.ok(ids(current).includes('gpt-5.5'), 'a newly discovered current model stays up front');
  for (const id of [
    'gpt-5.4-2026-03-05',
    'gpt-4o-2024-08-06',
    'gpt-4-0613',
    'gpt-4',
    'gpt-4o',
    'gpt-4.1-mini',
    'gpt-3.5-turbo',
    'o1',
    'o3-mini',
  ])
    assert.ok(ids(older).includes(id), `${id} is in More models`);
  // Order within each part is the catalog's.
  assert.deepEqual(ids(current).slice(0, 3), ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano']);

  // A dated id with no undated alias or later snapshot is the only listing of that model and stays current.
  const anthropic = splitOlderModels(
    [
      'claude-opus-5-20261001',
      'claude-sonnet-4-5-20250929',
      'claude-haiku-4-5-20251001',
      'claude-opus-4-1-20250805',
      'claude-opus-4-20250514',
      'claude-sonnet-4-20250514',
      'claude-3-7-sonnet-20250219',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-sonnet-20240620',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-20240229',
      'claude-3-haiku-20240307',
      'claude-3-sonnet-20240229',
    ].map((id) => ({ id: `anthropic/${id}` })),
  );
  assert.deepEqual(ids(anthropic.current), [
    'claude-opus-5-20261001',
    'claude-sonnet-4-5-20250929',
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-20250514',
  ]);

  // The catalog's default never moves; a short list is left whole.
  const withDefault = openaiModels.map((model) =>
    model.id === 'openai/gpt-4.1' ? { ...model, catalogDefault: true } : model,
  );
  assert.ok(ids(splitOlderModels(withDefault).current).includes('gpt-4.1'));
  const short = [{ id: 'gpt-5' }, { id: 'gpt-4' }, { id: 'gpt-4-0613' }];
  assert.deepEqual(splitOlderModels(short), { current: short, older: [] });

  // Cursor and aggregator lists are judged the same way.
  const cursor = splitOlderModels(cursorModels);
  assert.deepEqual(ids(cursor.older).sort(), [
    'claude-3.7-sonnet',
    'claude-4-opus',
    'claude-4.5-opus',
    'claude-4.5-opus-thinking',
    'composer-1',
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gpt-4.1',
    'grok-3',
    'grok-3-mini',
  ]);
  assert.ok(cursorModels.length + openaiModels.length + routerModels.length > 200, 'the fixture is owner-sized');
});

test('a picker filter matches names and ids however they are typed', () => {
  const gpt = ['GPT-5.4', 'openai/gpt-5.4'];
  for (const query of ['gpt-5.4', 'GPT 5.4', 'gpt54', '5.4', '  gpt  ', 'ｇｐｔ５．４', "g'p't", 'openai 5.4'])
    assert.equal(pickerMatches(gpt, query), true, query);
  for (const query of ['gpt-5.5', 'claude', 'gpt 4o']) assert.equal(pickerMatches(gpt, query), false, query);
  assert.equal(pickerMatches(gpt, ''), true, 'an empty filter shows everything');
  // Chinese names and their English rendering both match.
  assert.equal(pickerMatches(['自动', 'Auto', ''], '自动'), true);
  assert.equal(pickerMatches(['自动', 'Auto', ''], 'auto'), true);
  assert.equal(pickerMatches(['自动', 'Auto', ''], '模型'), false);
});

test('API catalogs list image and video models apart from the chat catalog', async () => {
  const openai = card('api-openai', 'pi', { gateway: 'api', apiProvider: 'openai' });
  const probe = await probeFreeSource(
    openai,
    'sk-synthetic-not-real',
    json({
      data: [{ id: 'gpt-5.2' }, { id: 'gpt-image-2' }, { id: 'dall-e-3' }, { id: 'sora-2' }, { id: 'tts-1' }],
    }),
  );
  assert.deepEqual(
    probe.models.map((model) => model.id),
    ['gpt-5.2'],
    'text routing still sees chat models only',
  );
  assert.deepEqual(probe.imageModelIds, ['gpt-image-2', 'dall-e-3']);
  assert.deepEqual(probe.videoModelIds, ['sora-2']);
  const xai = await probeFreeSource(
    card('api-xai', 'pi', { gateway: 'api', apiProvider: 'xai' }),
    'synthetic',
    json({
      models: [
        { id: 'grok-4', output_modalities: ['text'] },
        { id: 'grok-imagine-image', output_modalities: ['image'] },
        { id: 'grok-imagine-video', output_modalities: ['video'] },
      ],
    }),
  );
  assert.deepEqual(
    [xai.models.map((model) => model.id), xai.imageModelIds, xai.videoModelIds],
    [['grok-4'], ['grok-imagine-image'], ['grok-imagine-video']],
  );
});

test('only image models PugPort can run are selectable; video models are listed but disabled', (t) => {
  const f = fixture(t);
  const write = (target: RuntimeTarget, images: string[], videos: string[]) => {
    mkdirSync(target.agentDir!, { recursive: true });
    writeFileSync(
      join(target.agentDir!, 'model-list.json'),
      JSON.stringify({ preset: target.apiProvider, checkedAt: Date.now(), ids: [], retired: [], images, videos }),
    );
  };
  const openai = card('api-openai', 'pi', {
    gateway: 'api',
    apiProvider: 'openai',
    agentDir: join(f.directory, 'api-openai'),
  });
  write(openai, ['gpt-image-2', 'dall-e-3', 'gpt-image-2.5'], ['sora-2']);
  assert.deepEqual(apiMediaModels(openai), [
    { id: 'openai/gpt-image-2.5', label: 'gpt-image-2.5', modality: 'image' },
    { id: 'openai/dall-e-3', label: 'dall-e-3', modality: 'image', unsupported: true },
    { id: 'openai/gpt-image-2', label: 'gpt-image-2', modality: 'image' },
    { id: 'openai/sora-2', label: 'sora-2', modality: 'video', unsupported: true },
  ]);
  const xai = card('api-xai', 'pi', { gateway: 'api', apiProvider: 'xai', agentDir: join(f.directory, 'api-xai') });
  write(xai, ['grok-imagine-image'], []);
  assert.equal(apiMediaModels(xai)[0]!.unsupported, true, 'no image endpoint for this platform in PugPort yet');
  assert.deepEqual(apiMediaModels(card('codex-native', 'codex')), [], 'Codex cards list text only');
});

test('a picked image model pins the card and the exact model', () => {
  const openai = card('api-openai', 'pi', { gateway: 'api', apiProvider: 'openai' });
  const snapshot: RuntimeSnapshot = {
    id: openai.id,
    provider: 'pi',
    label: openai.label,
    environment: 'native',
    installed: true,
    status: 'ready',
    models: [],
    quota: { status: 'unknown', source: 'fixture', observedAt: null, windows: [] },
    capabilities: { execute: true, resume: false, cancel: true, approvals: false },
    refreshedAt: new Date().toISOString(),
  };
  const base = {
    targets: [card('codex-native', 'codex'), openai],
    snapshots: [snapshot, { ...snapshot, id: 'codex-native', provider: 'codex' as const }],
    imageModels: () => ['gpt-image-2', 'gpt-image-2.5'],
    pinnedRuntimeId: 'api-openai',
  };
  const plan = planImageRoutes({ ...base, pinnedModel: 'gpt-image-2' });
  assert.deepEqual(
    plan.candidates.map((item) => [item.target.id, item.model]),
    [['api-openai', 'gpt-image-2']],
  );
  // A picked image model always draws, even one the cached list has not seen yet: the pick is the owner's choice,
  // and falling back to a text reply was the bug.
  assert.deepEqual(
    planImageRoutes({ ...base, pinnedModel: 'gpt-image-9' }).candidates.map((item) => [item.target.id, item.model]),
    [['api-openai', 'gpt-image-9']],
  );
});

test('sending with an image model picked runs image generation with it; a video model replies plainly', async (t) => {
  const f = fixture(t);
  const openai = card('api-openai', 'pi', {
    label: 'OpenAI Work',
    gateway: 'api',
    apiProvider: 'openai',
    agentDir: join(f.directory, 'api-openai'),
  });
  mkdirSync(openai.agentDir!, { recursive: true });
  writeFileSync(
    join(openai.agentDir!, 'model-list.json'),
    JSON.stringify({ preset: 'openai', checkedAt: Date.now(), ids: [], retired: [], images: ['gpt-image-2'] }),
  );
  f.controller.targets.push(openai);
  f.controller.snapshots.push({
    ...f.controller.snapshots[0]!,
    id: openai.id,
    provider: 'pi',
    label: openai.label,
    gateway: 'api',
    apiProvider: 'openai',
    authMode: undefined,
    accountFingerprint: undefined,
    models: [{ id: 'openai/gpt-5.2', label: 'gpt-5.2', efforts: [] }],
    mediaModels: [
      { id: 'openai/gpt-image-2', label: 'gpt-image-2', modality: 'image' },
      { id: 'openai/sora-2', label: 'sora-2', modality: 'video', unsupported: true },
    ],
  });
  const calls: ExecuteContext[] = [];
  t.mock.method(piAdapter, 'execute', async (ctx: ExecuteContext): Promise<ExecuteResult> => {
    calls.push(ctx);
    const request = ctx.input.imageGeneration!;
    assert.ok(request, 'the picked image model runs through the image path');
    mkdirSync(request.outputDir, { recursive: true });
    const path = join(request.outputDir, 'harbor.png');
    writeFileSync(
      path,
      await sharp({ create: { width: 16, height: 16, channels: 3, background: '#0ea5e9' } })
        .png()
        .toBuffer(),
    );
    return {
      output: 'Image created.',
      generatedImages: [
        {
          path,
          mimeType: 'image/png',
          executor: ctx.target.label,
          runtimeId: ctx.target.id,
          tool: 'api-images',
          imageModel: request.model!,
        },
      ],
    };
  });
  const conversation = await f.workspace.createGeneralConversation();
  const send = async (content: string, model: string) => {
    const { workflow } = await f.workspace.send(conversation.id, {
      content,
      mode: 'chat',
      permissionMode: 'read-only',
      executionPolicy: 'cli-first',
      runtimeId: openai.id,
      model,
    });
    return finished(f.workspace, workflow.id);
  };
  // No drawing words: the picked model alone makes this an image request.
  const first = await send('a quiet harbor at dusk', 'openai/gpt-image-2');
  assert.equal(first.status, 'completed', String(first.error));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.target.id, 'api-openai');
  assert.equal(calls[0]!.input.imageGeneration?.model, 'gpt-image-2');
  const reply = f.workspace.store.get<ConversationMessage>('message', first.finalMessageId!)!;
  assert.deepEqual(
    reply.generatedImages?.map((image) => [image.tool, image.imageModel]),
    [['api-images', 'gpt-image-2']],
  );

  const video = await send('a quiet harbor at dusk, slowly panning', 'openai/sora-2');
  assert.equal(video.status, 'completed', String(video.error));
  assert.equal(calls.length, 1, 'no executor is asked to fake a video');
  const notice = f.workspace.store.get<ConversationMessage>('message', video.finalMessageId!)!;
  assert.match(notice.content, /暂不支持视频生成/);
  assert.equal(notice.attachments, undefined);
});
