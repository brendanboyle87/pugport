import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import sharp from 'sharp';
import { imageIntent } from '../src/server/image-intent.ts';
import {
  estimateImageCostUsd,
  openAiImages,
  planImageRoutes,
  stageCodexImageItem,
  stageCodexSavedImages,
} from '../src/server/image-generation.ts';
import { bestOpenAiImageModel, generatedImageCaption, imagePipeline } from '../src/shared/image-generation.ts';
import { imageGenerationKind } from '../src/shared/provider-registry.ts';
import { probeFreeSource } from '../src/server/free-sources.ts';
import { createCodexAdapter, codexAdapter } from '../src/server/adapters/codex.ts';
import { claudeAdapter } from '../src/server/adapters/claude.ts';
import { createPiAdapter, piAdapter } from '../src/server/adapters/pi.ts';
import { fixture, finished } from './helpers/session-workspace.ts';
import type { LayaChoices, LayaInference } from '../src/shared/laya.ts';
import type {
  ConversationMessage,
  ExecuteContext,
  ExecuteResult,
  RunEvent,
  RuntimeSnapshot,
  RuntimeTarget,
} from '../src/shared/types.ts';
import type { ApiBudgetView } from '../src/shared/api-providers.ts';

const syntheticPng = (color = '#3b82f6', size = 32) =>
  sharp({ create: { width: size, height: size, channels: 3, background: color } })
    .png()
    .toBuffer();

let directory: string;
before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'pugport-image-generation-')));
  await writeCodexFixture();
});
after(async () => {
  await rm(directory, { recursive: true, force: true });
});

// ---------------------------------------------------------------- intent

const choices = (media_output: LayaChoices['media_output']): LayaInference => ({
  status: 'ok',
  reason: 'accepted',
  modelVersion: 'pugport-laya-v4',
  latencyMs: 40,
  choices: {
    task_type: 'media',
    difficulty: 'simple',
    web_search: 'no',
    input_modality: 'text',
    document_read: 'no',
    media_output,
    project_access: 'none',
    run_commands: 'no',
    browser_use: 'no',
    executor_intent: 'none',
  },
});
const unavailable: LayaInference = {
  status: 'fallback',
  reason: 'timeout',
  modelVersion: 'pugport-laya-v4',
  latencyMs: 3000,
};

test('Laya media_output decides image intent, including an edit of the last generated image', () => {
  assert.deepEqual(
    imageIntent({ message: 'A cosy reading nook, please', inference: choices('image_create'), lastImage: false })?.kind,
    'create',
  );
  assert.equal(imageIntent({ message: '亮一点', inference: choices('image_edit'), lastImage: true })?.kind, 'edit');
  // An edit with nothing to edit draws a new picture rather than failing.
  assert.equal(
    imageIntent({ message: 'Make it brighter', inference: choices('image_edit'), lastImage: false })?.kind,
    'create',
  );
  // Laya's judgment stands: a clear phrase it judged as no image output stays with ordinary routing.
  assert.equal(imageIntent({ message: '画一张猫', inference: choices('none'), lastImage: false }), undefined);
  // A vision question is never drawn, even if a judgment says otherwise.
  assert.equal(
    imageIntent({ message: '这张图里是什么？', inference: choices('image_create'), lastImage: true }),
    undefined,
  );
  assert.equal(
    imageIntent({ message: 'Describe this image', inference: choices('image_edit'), lastImage: true }),
    undefined,
  );
  for (const result of [
    imageIntent({ message: 'Draw a fox', inference: choices('image_create'), lastImage: false }),
    imageIntent({ message: 'Draw a fox', inference: unavailable, lastImage: false }),
  ])
    assert.ok(result);
  assert.equal(
    imageIntent({ message: 'Draw a fox', inference: choices('image_create'), lastImage: false })?.source,
    'laya',
  );
  assert.equal(imageIntent({ message: 'Draw a fox', inference: unavailable, lastImage: false })?.source, 'rules');
});

test('without a Laya judgment, regression phrases in Chinese and English follow the narrow grammar', () => {
  const create = [
    '画一张猫在月球上的图',
    '帮我画只穿宇航服的柴犬',
    '请绘制一幅水彩风格的西湖',
    '给我生成一张赛博朋克风格的海报',
    '设计一个咖啡店的 logo',
    '做一张生日贺卡封面',
    '来一张夕阳下的海边壁纸',
    'Draw a red fox in the snow',
    'make me a poster of a jazz night in Tokyo',
    'Generate an icon for a weather app',
    'Can you paint a sunset over the ocean?',
    'create three wallpaper images of mountains',
    'Design a mascot for our hiking club',
  ];
  for (const message of create)
    assert.equal(imageIntent({ message, inference: unavailable, lastImage: false })?.kind, 'create', message);
  const negative = [
    '这张图里是什么',
    '这张照片上写的是什么？',
    '描述一下这张图片',
    '帮我分析这张截图',
    '怎么画一只猫？',
    '生成一份周报',
    '帮我画一个流程图说明登录逻辑',
    '画面感太强了',
    '用 Python 生成一张销售图表',
    'describe this image',
    "What's in this picture?",
    'What does this screenshot show?',
    'How do I draw a realistic eye?',
    'Generate a report on Q3 sales',
    'Write a React icon component for the settings button',
    'Create an SVG logo in code',
    'Make the tests pass',
    'Summarize the attached photos',
  ];
  for (const message of negative)
    assert.equal(imageIntent({ message, inference: unavailable, lastImage: false }), undefined, message);
});

test('a short change request edits the last generated image only right after it', () => {
  const edits = [
    '亮一点',
    '把背景换成蓝色',
    '再可爱一点',
    '颜色调暖一些',
    'make it brighter',
    'Make the sky purple',
    'add a hat',
    'darker please',
  ];
  for (const message of edits) {
    assert.equal(
      imageIntent({ message, inference: unavailable, lastImage: true, lastImageIsLatestReply: true })?.kind,
      'edit',
      message,
    );
    // Without an image right before it, the same words are ordinary chat.
    assert.equal(imageIntent({ message, inference: unavailable, lastImage: false }), undefined, message);
    assert.equal(
      imageIntent({ message, inference: unavailable, lastImage: true, lastImageIsLatestReply: false }),
      undefined,
      message,
    );
  }
  for (const message of ['这张图里是什么', 'describe this image', 'Thanks, that works!', '谢谢'])
    assert.equal(
      imageIntent({ message, inference: unavailable, lastImage: true, lastImageIsLatestReply: true }),
      undefined,
      message,
    );
  // A creation request with an attached image redraws that image.
  assert.equal(
    imageIntent({ message: '把这张照片画成水彩画', inference: unavailable, lastImage: false, attachedImage: true })
      ?.kind,
    'edit',
  );
});

test('right after a generated image, a picture request keeps that image unless it starts over', () => {
  const create = choices('image_create');
  const after = { inference: create, lastImage: true, lastImageIsLatestReply: true };
  // The owner's follow-up that Laya judged a new picture: it drew a different person.
  for (const message of [
    '单独把人提取出来，不要放到背景上，透明背景的，衣服有没有别的颜色，我不喜欢这个颜色',
    '做成透明背景的图',
    'give it a new colour scheme',
  ])
    assert.equal(imageIntent({ ...after, message })?.kind, 'edit', message);
  // Starting over, or opening a new drawing, still draws from the words alone.
  for (const message of [
    '重新画一张',
    '换一张新的图',
    '画一只猫',
    '生成一张海报',
    'draw a fox',
    'another image please',
  ])
    assert.equal(imageIntent({ ...after, message })?.kind, 'create', message);
  // Not right after the image, or with the owner's own image attached, nothing is kept.
  const message = '单独把人提取出来，透明背景';
  assert.equal(imageIntent({ ...after, lastImageIsLatestReply: false, message })?.kind, 'create');
  assert.equal(imageIntent({ ...after, attachedImage: true, message })?.kind, 'create');
});

// ---------------------------------------------------------------- registry and routing

test('image models: GPT Image 2.5, then GPT Image 2, then the newest other gpt-image', () => {
  assert.equal(bestOpenAiImageModel(['gpt-image-1', 'gpt-image-2', 'gpt-image-2.5']), 'gpt-image-2.5');
  assert.equal(bestOpenAiImageModel(['gpt-image-2-mini', 'gpt-image-1', 'gpt-image-2']), 'gpt-image-2');
  assert.equal(bestOpenAiImageModel(['gpt-image-1', 'gpt-image-1.5']), 'gpt-image-1.5');
  assert.equal(bestOpenAiImageModel(['gpt-5', 'dall-e-3']), undefined);
  // Quality tier first within a version; the alias beats its dated snapshot; a newer version still wins over tier.
  const catalog = [
    'gpt-image-2-2026-04-21',
    'gpt-image-2.5-flare',
    'gpt-image-1.5',
    'gpt-image-2',
    'gpt-image-1-mini',
    'chatgpt-image-latest',
    'gpt-image-2.5-sunburst-2026-09-08',
    'gpt-image-2.5-sunburst',
    'gpt-image-2.5-flare-2026-09-08',
  ];
  assert.equal(bestOpenAiImageModel(catalog), 'gpt-image-2.5-sunburst');
  assert.equal(
    bestOpenAiImageModel(['gpt-image-2.5-sunburst-2026-09-08', 'gpt-image-2.5-flare']),
    'gpt-image-2.5-sunburst-2026-09-08',
  );
  assert.equal(
    bestOpenAiImageModel([...catalog, 'gpt-image-2.6-flare', 'gpt-image-2.6-sunburst']),
    'gpt-image-2.6-sunburst',
  );
  assert.equal(bestOpenAiImageModel(['gpt-image-2.5-flare', 'gpt-image-2.6-flare']), 'gpt-image-2.6-flare');
  assert.equal(imageGenerationKind('codex'), 'native-tool');
  assert.equal(imageGenerationKind('pi'), 'api-images');
  for (const provider of ['claude', 'grok', 'cursor', 'gemini']) assert.equal(imageGenerationKind(provider), undefined);
});

const now = Date.parse('2026-11-03T12:00:00Z');
function card(id: string, provider: RuntimeTarget['provider'], extra: Partial<RuntimeTarget> = {}): RuntimeTarget {
  return { id, provider, label: id, command: 'unused', environment: 'native', enabled: true, ...extra };
}
function ready(target: RuntimeTarget, extra: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    id: target.id,
    provider: target.provider,
    label: target.label,
    environment: 'native',
    installed: true,
    status: 'ready',
    models: [],
    quota: { status: 'known', source: 'fixture', windows: [] },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: new Date(now).toISOString(),
    ...extra,
  } as RuntimeSnapshot;
}
const budget = (expiresInDays: number, spentUsd: number): ApiBudgetView => ({
  policy: {
    limitUsd: 100,
    perRunUsd: 1,
    maxConcurrentRuns: 1,
    burstConcurrentRuns: 4,
    preferExpiring: true,
    startedAt: new Date(now - 13 * 86_400_000).toISOString(),
    expiresAt: new Date(now + expiresInDays * 86_400_000).toISOString(),
  },
  spentUsd,
  reservedUsd: 0,
  unreportedRuns: 0,
  phase: expiresInDays <= 3 ? 'accelerated' : 'priority',
  maxConcurrentRuns: 1,
  remainingUsd: 100 - spentUsd,
  daysRemaining: expiresInDays,
});

test('routing prefers Codex, uses a paid API card only for expiring credit or a pin, and never Grok or Claude', () => {
  const codex = card('codex-native', 'codex');
  const codexB = card('codex-b', 'codex');
  const openai = card('api-openai', 'pi', { gateway: 'api', apiProvider: 'openai' });
  const claude = card('claude-native', 'claude');
  const grok = card('grok-native', 'grok');
  const models = () => ['gpt-image-1', 'gpt-image-2'];
  const snapshots = [ready(codex), ready(codexB), ready(openai), ready(claude), ready(grok)];
  const targets = [openai, claude, grok, codex, codexB];
  // No expiring credit: the API card is skipped, Codex cards lead.
  let plan = planImageRoutes({ targets, snapshots, imageModels: models, now });
  assert.deepEqual(
    plan.candidates.map((item) => item.target.id),
    ['codex-native', 'codex-b'],
  );
  assert.match(plan.skipped.find((item) => item.runtimeId === 'api-openai')!.reason, /expiring credit/);
  // Credit behind its straight-line plan: the API card joins after Codex with the best image model.
  const behind = [
    ...snapshots.filter((item) => item.id !== 'api-openai'),
    ready(openai, { apiBudgetState: budget(1, 5) }),
  ];
  plan = planImageRoutes({ targets, snapshots: behind, imageModels: models, now, preferredRuntimeId: 'codex-b' });
  assert.deepEqual(
    plan.candidates.map((item) => [item.target.id, item.model]),
    [
      ['codex-b', undefined],
      ['codex-native', undefined],
      ['api-openai', 'gpt-image-2'],
    ],
  );
  // Pinned in the UI: only that card, even without expiring credit.
  plan = planImageRoutes({ targets, snapshots, imageModels: models, now, pinnedRuntimeId: 'api-openai' });
  assert.deepEqual(
    plan.candidates.map((item) => item.target.id),
    ['api-openai'],
  );
  assert.equal(plan.pinned, 'api-openai');
  plan = planImageRoutes({ targets, snapshots, imageModels: models, now, pinnedRuntimeId: 'claude-native' });
  assert.deepEqual(plan.candidates, []);
  assert.equal(plan.pinned, 'claude-native');
  // Logged-out, disabled, excluded and catalog-less cards fall through to the next.
  plan = planImageRoutes({
    targets: [{ ...codex, executionDisabledByUser: true }, codexB, openai],
    snapshots: [
      ready(codex),
      ready(codexB, { status: 'auth-required' }),
      ready(openai, { apiBudgetState: budget(1, 5) }),
    ],
    imageModels: () => [],
    now,
  });
  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(
    plan.skipped.map((item) => item.runtimeId),
    ['codex-native', 'codex-b', 'api-openai'],
  );
  plan = planImageRoutes({ targets, snapshots, imageModels: models, now, excludeRuntimeIds: ['codex-native'] });
  assert.deepEqual(
    plan.candidates.map((item) => item.target.id),
    ['codex-b'],
  );
});

test('OpenAI model discovery keeps image models out of the chat catalog', async () => {
  const target = card('api-openai', 'pi', { gateway: 'api', apiProvider: 'openai' });
  const fake = (async () =>
    new Response(
      JSON.stringify({
        data: [{ id: 'gpt-5.2' }, { id: 'gpt-image-2' }, { id: 'gpt-image-2.5' }, { id: 'dall-e-3' }, { id: 'tts-1' }],
      }),
      { status: 200 },
    )) as typeof fetch;
  const probe = await probeFreeSource(target, 'sk-synthetic-not-real', fake);
  assert.deepEqual(
    probe.models.map((model) => model.id),
    ['gpt-5.2'],
  );
  assert.deepEqual(probe.imageModelIds, ['gpt-image-2', 'gpt-image-2.5', 'dall-e-3']);
  const anthropic = await probeFreeSource(
    card('api-anthropic', 'pi', { gateway: 'api', apiProvider: 'anthropic' }),
    'synthetic',
    (async () => new Response(JSON.stringify({ data: [{ id: 'claude-x' }] }), { status: 200 })) as typeof fetch,
  );
  assert.deepEqual(anthropic.imageModelIds, []);
});

// ---------------------------------------------------------------- OpenAI Images API (fake fetch)

test('the Images API client sends the key only as a header and stages decoded PNGs', async () => {
  const key = 'sk-synthetic-image-key-0123456789';
  const png = await syntheticPng();
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fake = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return new Response(
      JSON.stringify({
        data: [{ b64_json: png.toString('base64'), revised_prompt: 'A synthetic blue square' }],
        usage: { input_tokens: 20, output_tokens: 1000, input_tokens_details: { image_tokens: 10 } },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const outputDir = join(directory, 'openai-out');
  const created = await openAiImages({
    key,
    model: 'gpt-image-2',
    prompt: 'A blue square',
    references: [],
    outputDir,
    signal: new AbortController().signal,
    fetch: fake,
  });
  assert.equal(requests[0]!.url, 'https://api.openai.com/v1/images/generations');
  assert.equal((requests[0]!.init.headers as Record<string, string>).Authorization, `Bearer ${key}`);
  assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), { model: 'gpt-image-2', prompt: 'A blue square', n: 1 });
  assert.equal(created.images.length, 1);
  assert.deepEqual(readFileSync(created.images[0]!.path), png);
  assert.equal(relative(outputDir, created.images[0]!.path).includes('..'), false);
  assert.equal(created.images[0]!.revisedPrompt, 'A synthetic blue square');
  assert.equal(estimateImageCostUsd(created.usage, 1), (10 * 5 + 10 * 10 + 1000 * 40) / 1_000_000);
  // References go to the edits endpoint as multipart image[] parts.
  const reference = join(directory, 'reference.png');
  writeFileSync(reference, png);
  await openAiImages({
    key,
    model: 'gpt-image-2',
    prompt: 'Make it brighter',
    references: [{ path: reference, mimeType: 'image/png', name: 'reference.png' }],
    outputDir,
    signal: new AbortController().signal,
    fetch: fake,
  });
  assert.equal(requests[1]!.url, 'https://api.openai.com/v1/images/edits');
  const form = requests[1]!.init.body as FormData;
  assert.equal(form.get('model'), 'gpt-image-2');
  assert.equal(form.getAll('image[]').length, 1);
  // Failures are classified codes: no body text, no key.
  const refused = openAiImages({
    key,
    model: 'gpt-image-2',
    prompt: 'x',
    references: [],
    outputDir,
    signal: new AbortController().signal,
    fetch: (async () => new Response(`{"error":"bad key ${key}"}`, { status: 401 })) as typeof fetch,
  });
  await assert.rejects(
    refused,
    (error: Error) => error.message === 'authentication-required' && !error.message.includes(key),
  );
});

test('an OpenAI API card makes images through the Pi adapter, records estimated spend and never logs the key', async () => {
  const key = 'sk-synthetic-pi-key-abcdefghijkl';
  const png = await syntheticPng('#16a34a');
  const urls: string[] = [];
  const adapter = createPiAdapter({
    key: () => key,
    fetch: (async (url: string) => {
      urls.push(url);
      return new Response(
        JSON.stringify({
          data: [{ b64_json: png.toString('base64'), revised_prompt: 'A synthetic green square' }],
          usage: { input_tokens: 10, output_tokens: 500 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch,
  });
  const events: RunEvent[] = [];
  const outputDir = join(directory, 'pi-out');
  const result = (await adapter.execute({
    target: card('api-openai', 'pi', { gateway: 'api', apiProvider: 'openai', label: 'OpenAI Work' }),
    input: {
      prompt: 'executor prompt',
      projectPath: directory,
      kind: 'general',
      permissionMode: 'read-only',
      imageGeneration: { outputDir, prompt: 'A green square', edit: false, model: 'gpt-image-2' },
    },
    route: { runtimeId: 'api-openai', model: 'openai/gpt-5.2', kind: 'general', reasons: [], warnings: [] },
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
    approve: async () => false,
  })) as ExecuteResult;
  assert.deepEqual(urls, ['https://api.openai.com/v1/images/generations']);
  assert.equal(result.generatedImages?.length, 1);
  assert.deepEqual(
    [result.generatedImages![0]!.executor, result.generatedImages![0]!.tool, result.generatedImages![0]!.imageModel],
    ['OpenAI Work', 'api-images', 'gpt-image-2'],
  );
  assert.equal(result.effectiveModel?.model, 'gpt-image-2');
  assert.ok(existsSync(result.generatedImages![0]!.path));
  const usage = events.find((event) => event.type === 'usage')!;
  assert.equal(usage.data?.costUsd, (10 * 5 + 500 * 40) / 1_000_000);
  // The record says exactly what went out and where the file landed.
  const request = events.find((event) => event.data?.kind === 'image-request')!.data!.detail;
  assert.deepEqual(request, {
    model: 'gpt-image-2',
    endpoint: 'images/generations',
    references: 0,
    edit: false,
    prompt: 'A green square',
  });
  const made = events.filter((event) => event.data?.kind === 'image-generation');
  assert.equal(made.length, 1);
  assert.deepEqual(made[0]!.data!.detail, {
    executor: 'OpenAI Work',
    runtimeId: 'api-openai',
    imageModel: 'gpt-image-2',
    tool: 'api-images',
    mimeType: 'image/png',
    path: result.generatedImages![0]!.path,
    bytes: png.length,
    revisedPrompt: 'A synthetic green square',
  });
  assert.equal(result.generatedImages![0]!.tool, (made[0]!.data!.detail as { tool: string }).tool);
  assert.ok(!('bytes' in result.generatedImages![0]!), 'the byte count stays in the record, not on the image');
  assert.ok(!JSON.stringify(events).includes(key));
  assert.ok(!JSON.stringify(result).includes(key));
});

test('an edit through the Pi adapter records the edits endpoint and how many references were sent', async () => {
  const png = await syntheticPng('#0f766e');
  const reference = join(directory, 'pi-reference.png');
  writeFileSync(reference, png);
  const urls: string[] = [];
  const adapter = createPiAdapter({
    key: () => 'sk-synthetic-pi-edit-key-000000',
    fetch: (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  const events: RunEvent[] = [];
  await adapter.execute({
    target: card('api-openai', 'pi', { gateway: 'api', apiProvider: 'openai', label: 'OpenAI Work' }),
    input: {
      prompt: 'executor prompt',
      projectPath: directory,
      kind: 'general',
      permissionMode: 'read-only',
      imageGeneration: {
        outputDir: join(directory, 'pi-edit-out'),
        prompt: 'Make it brighter',
        edit: true,
        model: 'gpt-image-2',
        references: [{ path: reference, mimeType: 'image/png', name: 'pi-reference.png' }],
      },
    },
    route: { runtimeId: 'api-openai', model: 'openai/gpt-5.2', kind: 'general', reasons: [], warnings: [] },
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
    approve: async () => false,
  });
  assert.deepEqual(urls, ['https://api.openai.com/v1/images/edits']);
  const request = events.find((event) => event.data?.kind === 'image-request')!.data!.detail as Record<string, unknown>;
  assert.deepEqual(
    [request.endpoint, request.references, request.edit, request.prompt],
    ['images/edits', 1, true, 'Make it brighter'],
  );
  assert.equal('size' in request || 'quality' in request, false, 'size and quality appear only when set');
  // The pipeline line reads the same records.
  const pipeline = imagePipeline({ events });
  assert.deepEqual(
    [pipeline?.executor, pipeline?.tool, pipeline?.imageModel, pipeline?.endpoint, pipeline?.edit],
    ['OpenAI Work', 'api-images', 'gpt-image-2', 'images/edits', true],
  );
  assert.equal(pipeline?.paths.length, 1);
});

test('the image pipeline prefers the saved attachment, reads old tool names and is absent for other runs', () => {
  const status = (kind: string, detail: unknown) => ({ type: 'status', data: { source: 'pugport', kind, detail } });
  assert.equal(imagePipeline({ events: [status('routing', { model: 'gpt-6.1-sol' })] }), undefined);
  const codex = imagePipeline({
    events: [
      status('image-generation', { executor: 'Codex · 本机', tool: 'image_generation', path: 'C:/staging/a.png' }),
      status('image-attachments', [
        { executor: 'Codex · 本机', tool: 'native-tool', imageModel: null, path: 'C:/data/attachments/a.png' },
      ]),
    ],
  });
  assert.deepEqual(codex, {
    executor: 'Codex · 本机',
    tool: 'native-tool',
    imageModel: null,
    edit: false,
    paths: ['C:/data/attachments/a.png'],
  });
  // A record written before the tool names matched said openai-images.
  const legacy = imagePipeline({
    events: [status('image-generation', { executor: 'OpenAI', tool: 'openai-images', imageModel: 'gpt-image-2' })],
  });
  assert.deepEqual([legacy?.tool, legacy?.imageModel, legacy?.paths], ['api-images', 'gpt-image-2', []]);
  // An older saved record has no path; the staged copy it replaced is gone, so nothing is linked.
  const savedWithoutPath = imagePipeline({
    events: [
      status('image-generation', { executor: 'OpenAI', tool: 'api-images', path: 'C:/staging/gone.png' }),
      status('image-attachments', [{ executor: 'OpenAI', tool: 'api-images', imageModel: 'gpt-image-2' }]),
    ],
  });
  assert.deepEqual(savedWithoutPath?.paths, []);
  // A run without image events still names its images.
  const fromRun = imagePipeline({
    events: [],
    generatedImages: [
      {
        path: 'C:/x.png',
        mimeType: 'image/png',
        executor: 'OpenAI',
        runtimeId: 'api',
        tool: 'api-images',
        imageModel: 'gpt-image-2',
      },
    ],
  });
  assert.deepEqual(fromRun?.paths, ['C:/x.png']);
});

// ---------------------------------------------------------------- Codex collection (fake app-server)

let codexFixture: string;
const writeCodexFixture = async () => {
  codexFixture = join(directory, 'codex-image-mock.mjs');
  await writeFile(
    codexFixture,
    `
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const mode = process.argv[2];
const png = process.env.SYNTHETIC_PNG_BASE64;
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const notify = (method, params) => send({ method, params });
const threadId = 'thread-image-1', turnId = 'turn-image-1';
if (!process.argv.includes('features.image_generation=true')) process.exit(31);
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line), p = message.params || {};
  if (message.method === 'initialize') return send({ id: message.id, result: {} });
  if (message.method === 'initialized') return;
  if (message.method === 'thread/start') return send({ id: message.id, result: { thread: { id: threadId } } });
  if (message.method === 'turn/start') {
    const images = (p.input || []).filter((item) => item.type === 'localImage').map((item) => item.path);
    if (JSON.stringify(images) !== process.env.EXPECTED_REFERENCES) process.exit(32);
    send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } });
    notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
    notify('item/started', { threadId, turnId, item: { id: 'ig_1', type: 'imageGeneration', status: 'generating', result: '' } });
    if (mode === 'inline') {
      notify('item/completed', { threadId, turnId, item: { id: 'ig_1', type: 'imageGeneration', status: 'completed', revisedPrompt: 'A synthetic cat', result: png, savedPath: null } });
    } else {
      // No inline bytes: only the copy Codex keeps under CODEX_HOME/generated_images/<thread>/.
      const folder = join(process.env.CODEX_HOME, 'generated_images', threadId);
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'ig_1.png'), Buffer.from(png, 'base64'));
      notify('item/completed', { threadId, turnId, item: { id: 'ig_1', type: 'imageGeneration', status: 'completed', result: '', savedPath: null } });
    }
    notify('item/completed', { threadId, turnId, item: { id: 'msg', type: 'agentMessage', text: 'Here is your cat.' } });
    notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
  }
});
`,
  );
};

async function runCodex(mode: 'inline' | 'saved', references: string[]) {
  const png = await syntheticPng('#f97316');
  const saved = {
    png: process.env.SYNTHETIC_PNG_BASE64,
    refs: process.env.EXPECTED_REFERENCES,
    home: process.env.CODEX_HOME,
  };
  process.env.SYNTHETIC_PNG_BASE64 = png.toString('base64');
  process.env.EXPECTED_REFERENCES = JSON.stringify(references);
  process.env.CODEX_HOME = join(directory, `codex-home-${mode}`);
  const events: RunEvent[] = [];
  const outputDir = join(directory, `codex-out-${mode}`);
  try {
    const adapter = createCodexAdapter({
      sandboxStatus: async () => ({ available: false, reason: 'sdk-missing', message: 'synthetic' }),
    });
    const ctx: ExecuteContext = {
      target: card('codex-native', 'codex', {
        label: 'Codex · 本机',
        command: process.execPath,
        args: [codexFixture, mode],
      }),
      input: {
        prompt: 'Draw a cat',
        projectPath: directory,
        kind: 'general',
        permissionMode: 'read-only',
        imageGeneration: {
          outputDir,
          prompt: 'Draw a cat',
          edit: references.length > 0,
          references: references.map((path) => ({ path, mimeType: 'image/png', name: 'ref.png' })),
        },
      },
      route: { runtimeId: 'codex-native', model: 'gpt-5.5', kind: 'general', reasons: [], warnings: [] },
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
      approve: async () => false,
    };
    const result = await adapter.execute(ctx);
    return { result, events, png, outputDir };
  } finally {
    for (const [name, value] of [
      ['SYNTHETIC_PNG_BASE64', saved.png],
      ['EXPECTED_REFERENCES', saved.refs],
      ['CODEX_HOME', saved.home],
    ] as const)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
}

test('the Codex adapter collects image_generation output from the stream into the task folder (fake app-server)', async () => {
  const reference = join(directory, 'codex-reference.png');
  writeFileSync(reference, await syntheticPng('#111827'));
  const { result, events, png, outputDir } = await runCodex('inline', [reference]);
  assert.equal(result.output, 'Here is your cat.');
  assert.equal(result.generatedImages?.length, 1);
  const image = result.generatedImages![0]!;
  assert.deepEqual(readFileSync(image.path), png);
  assert.ok(image.path.startsWith(outputDir));
  // Codex's image tool does not report its image model; the chat model (gpt-5.5) is never recorded as one.
  assert.deepEqual(
    [image.executor, image.runtimeId, image.tool, image.imageModel],
    ['Codex · 本机', 'codex-native', 'native-tool', null],
  );
  assert.equal(image.revisedPrompt, 'A synthetic cat');
  const trace = events.find((event) => event.data?.kind === 'image-generation');
  const detail = trace?.data?.detail as Record<string, unknown>;
  assert.equal(detail.imageModel, null);
  assert.equal(detail.imageModelNote, 'not reported');
  assert.equal(detail.path, image.path);
  assert.equal(detail.revisedPrompt, 'A synthetic cat');
  assert.ok(!JSON.stringify(trace).includes('gpt-5.5'), 'the chat model is not shown as the image model');
  // The PNG bytes never enter the event log.
  assert.ok(!JSON.stringify(events).includes(png.toString('base64').slice(0, 64)));
});

test('without inline bytes the Codex adapter takes the file Codex saved for this thread (fake app-server)', async () => {
  const { result, png } = await runCodex('saved', []);
  assert.equal(result.generatedImages?.length, 1);
  assert.deepEqual(readFileSync(result.generatedImages![0]!.path), png);
});

test('staging rejects non-images, failed items and files older than the run', async () => {
  const outputDir = join(directory, 'stage');
  assert.equal(
    await stageCodexImageItem({ type: 'imageGeneration', status: 'failed', result: 'AAAA' }, outputDir),
    undefined,
  );
  assert.equal(
    await stageCodexImageItem(
      { type: 'imageGeneration', status: 'completed', result: Buffer.from('not an image').toString('base64') },
      outputDir,
    ),
    undefined,
  );
  const home = join(directory, 'stale-home');
  mkdirSync(join(home, 'generated_images', 'thread-old'), { recursive: true });
  writeFileSync(join(home, 'generated_images', 'thread-old', 'ig_old.png'), await syntheticPng());
  assert.deepEqual(await stageCodexSavedImages(home, 'thread-old', Date.now() + 60_000, outputDir), []);
  assert.deepEqual(await stageCodexSavedImages(home, '../escape', 0, outputDir), []);
});

// ---------------------------------------------------------------- end to end through the workspace (fake executors)

test('a chat request makes an image attachment, and a follow-up edits it with the image as reference', async (t) => {
  const f = fixture(t);
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext): Promise<ExecuteResult> => {
    calls.push(ctx);
    const request = ctx.input.imageGeneration;
    if (!request) return { nativeSessionId: 'chat', output: 'An ordinary answer.' };
    mkdirSync(request.outputDir, { recursive: true });
    const path = join(request.outputDir, `synthetic-${calls.length}.png`);
    writeFileSync(path, await syntheticPng(calls.length === 1 ? '#1e3a8a' : '#93c5fd', 48));
    return {
      nativeSessionId: `image-${calls.length}`,
      output: calls.length === 1 ? 'A synthetic night-sky cat.' : 'Brighter now.',
      generatedImages: [
        {
          path,
          mimeType: 'image/png',
          executor: ctx.target.label,
          runtimeId: ctx.target.id,
          tool: 'native-tool',
          imageModel: null,
        },
      ],
    };
  });
  t.mock.method(claudeAdapter, 'execute', async () => {
    throw new Error('Claude cannot make images and must not be asked to.');
  });
  const conversation = await f.workspace.createGeneralConversation();
  const send = async (content: string) => {
    const { workflow } = await f.workspace.send(conversation.id, {
      content,
      mode: 'chat',
      permissionMode: 'read-only',
      executionPolicy: 'cli-first',
    });
    return finished(f.workspace, workflow.id);
  };
  const first = await send('画一张夜空下的猫');
  assert.equal(first.status, 'completed', String(first.error));
  const reply = f.workspace.store.get<ConversationMessage>('message', first.finalMessageId!)!;
  assert.equal(reply.content, 'A synthetic night-sky cat.');
  assert.equal(reply.attachments?.length, 1);
  assert.equal(reply.attachments![0]!.kind, 'image');
  assert.deepEqual(
    reply.generatedImages?.map((item) => [item.executor, item.runtimeId, item.tool, item.imageModel, item.edit]),
    [['Synthetic', 'mock', 'native-tool', null, undefined]],
  );
  // Stored with the conversation's attachments under the data folder, not the project; staging removed.
  const stored = f.workspace.attachments.get(conversation.id, reply.attachments![0]!.id);
  assert.ok(stored.path.startsWith(join(f.directory, 'data', 'attachments')));
  assert.equal(existsSync(join(f.directory, 'data', 'image-generation', first.id)), false);
  const firstCall = calls[0]!;
  assert.equal(firstCall.input.permissionMode, 'read-only');
  assert.deepEqual(firstCall.input.attachments, []);
  assert.equal(firstCall.input.imageGeneration?.edit, false);
  assert.match(firstCall.input.prompt, /image_generation/);
  // The trace says which executor and model made the picture.
  const run = f.controller.run(reply.replyIdentity!.runs[0]!.runId)!;
  const traced = f.controller.runWithAudit(run.id)?.events ?? run.events;
  const saved = traced.find((event) => event.data?.kind === 'image-attachments');
  assert.deepEqual(
    (saved?.data?.detail as Array<Record<string, unknown>>).map((item) => [
      item.tool,
      item.imageModel,
      item.imageModelNote,
    ]),
    [['native-tool', null, 'not reported']],
  );
  const savedDetail = (saved?.data?.detail as Array<Record<string, unknown>>)[0]!;
  assert.equal(savedDetail.path, stored.path);
  assert.equal(savedDetail.bytes, stored.size);

  const second = await send('make it brighter');
  assert.equal(second.status, 'completed', String(second.error));
  const edit = calls[1]!.input.imageGeneration!;
  assert.equal(edit.edit, true);
  assert.deepEqual(
    edit.references?.map((item) => item.path),
    [stored.path],
  );
  const edited = f.workspace.store.get<ConversationMessage>('message', second.finalMessageId!)!;
  assert.equal(edited.attachments?.length, 1);
  assert.equal(edited.generatedImages?.[0]?.edit, true);
  assert.ok(edited.attachments![0]!.name.startsWith('edited-'));

  // A question about the picture is vision, not generation.
  const third = await send('这张图里是什么？');
  assert.equal(third.status, 'completed', String(third.error));
  assert.equal(calls[2]!.input.imageGeneration, undefined);
  assert.equal(calls.length, 3);
  const listed = await readdir(join(f.directory, 'data', 'attachments'));
  assert.equal(listed.filter((name) => name.endsWith('.png')).length, 2);
});

test('with no executor able to make images, the reply says so plainly and suggests Codex or an OpenAI key', async (t) => {
  const f = fixture(t);
  f.controller.targets = f.controller.targets.filter((target) => target.provider === 'claude');
  f.controller.snapshots = f.controller.snapshots.filter((snapshot) => snapshot.provider === 'claude');
  t.mock.method(claudeAdapter, 'execute', async () => {
    throw new Error('A text-only answer must not stand in for an image.');
  });
  const conversation = await f.workspace.createGeneralConversation();
  const { workflow } = await f.workspace.send(conversation.id, {
    content: 'Generate an icon for a weather app',
    mode: 'chat',
    permissionMode: 'read-only',
    executionPolicy: 'cli-first',
  });
  const final = await finished(f.workspace, workflow.id);
  assert.equal(final.status, 'completed');
  const reply = f.workspace.store.get<ConversationMessage>('message', final.finalMessageId!)!;
  assert.match(reply.content, /没有已连接的执行器能生成图片/);
  assert.match(reply.content, /Codex/);
  assert.match(reply.content, /OpenAI API Key/);
  assert.equal(reply.attachments, undefined);
});

test('a failing Codex card falls back to the next one without failing the task', async (t) => {
  const f = fixture(t);
  f.controller.targets.push({
    id: 'mock-b',
    provider: 'codex',
    label: 'Synthetic B',
    command: 'unused',
    environment: 'native',
    enabled: true,
  });
  f.controller.snapshots.push({
    ...f.controller.snapshots[0]!,
    id: 'mock-b',
    label: 'mock-b',
    accountFingerprint: 'synthetic-mock-b',
  });
  const tried: string[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext): Promise<ExecuteResult> => {
    tried.push(ctx.target.id);
    if (ctx.target.id === 'mock') return { nativeSessionId: 'none', output: 'I described a cat in words instead.' };
    const request = ctx.input.imageGeneration!;
    mkdirSync(request.outputDir, { recursive: true });
    const path = join(request.outputDir, 'fallback.png');
    writeFileSync(path, await syntheticPng('#a855f7'));
    return {
      nativeSessionId: 'b',
      output: 'Made it.',
      generatedImages: [
        {
          path,
          mimeType: 'image/png',
          executor: ctx.target.label,
          runtimeId: ctx.target.id,
          tool: 'native-tool',
          imageModel: null,
        },
      ],
    };
  });
  const conversation = await f.workspace.createGeneralConversation();
  const { workflow } = await f.workspace.send(conversation.id, {
    content: 'make me a poster of a jazz night',
    mode: 'chat',
    permissionMode: 'read-only',
    executionPolicy: 'cli-first',
  });
  const final = await finished(f.workspace, workflow.id);
  assert.equal(final.status, 'completed', String(final.error));
  assert.deepEqual(tried, ['mock', 'mock-b']);
  const reply = f.workspace.store.get<ConversationMessage>('message', final.finalMessageId!)!;
  assert.equal(reply.generatedImages?.[0]?.runtimeId, 'mock-b');
});

test("a pinned API card is sent the owner's words alone, and the execution context records exactly that", async (t) => {
  const f = fixture(t);
  const agentDir = join(f.directory, 'api-openai-agent');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, 'model-list.json'),
    JSON.stringify({ preset: 'openai', checkedAt: Date.now(), ids: [], retired: [], images: ['gpt-image-2'] }),
  );
  const api = card('api-openai', 'pi', {
    gateway: 'api',
    apiProvider: 'openai',
    label: 'OpenAI Work',
    agentDir,
    apiBudget: {
      limitUsd: 10,
      perRunUsd: 0.1,
      maxConcurrentRuns: 1,
      burstConcurrentRuns: 1,
      preferExpiring: false,
      startedAt: new Date(Date.now() - 60000).toISOString(),
    },
  });
  f.controller.targets.push(api);
  f.controller.snapshots.push(
    ready(api, {
      authMode: 'apiKey',
      accountFingerprint: 'synthetic-api',
      models: [{ id: 'openai/gpt-5.2', label: 'GPT-5.2', efforts: ['low'], price: { input: 1, output: 2 } }],
      quota: {
        status: 'known',
        source: 'fixture',
        observedAt: new Date().toISOString(),
        windows: [
          { id: 'week', label: 'Week', usedPercent: 10, resetsAt: new Date(Date.now() + 3600000).toISOString() },
        ],
      },
      refreshedAt: new Date().toISOString(),
    }),
  );
  const calls: ExecuteContext[] = [];
  t.mock.method(piAdapter, 'execute', async (ctx: ExecuteContext): Promise<ExecuteResult> => {
    calls.push(ctx);
    const request = ctx.input.imageGeneration!;
    mkdirSync(request.outputDir, { recursive: true });
    const path = join(request.outputDir, 'api.png');
    writeFileSync(path, await syntheticPng('#be185d'));
    return {
      output: '已生成图片。',
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
  const { workflow } = await f.workspace.send(conversation.id, {
    content: '生成一张可爱巴哥的图片',
    mode: 'chat',
    permissionMode: 'read-only',
    executionPolicy: 'cli-first',
    runtimeId: 'api-openai',
  });
  const final = await finished(f.workspace, workflow.id);
  const notice = f.workspace.store.get<ConversationMessage>('message', final.finalMessageId!)?.systemNotice;
  assert.equal(final.status, 'completed', `${final.error} ${notice?.details}`);
  assert.equal(calls.length, 1);
  const request = calls[0]!.input.imageGeneration!.prompt;
  assert.equal(calls[0]!.input.prompt.includes('image_generation'), false, 'no Codex tool instruction');
  const reply = f.workspace.store.get<ConversationMessage>('message', final.finalMessageId!)!;
  const run = f.controller.run(reply.generatedImages![0]!.runId!)!;
  const events = f.controller.runWithAudit(run.id)?.events ?? run.events;
  const context = events.find((event) => event.data?.kind === 'execution-context')!.data!.detail as {
    prompt: string;
  };
  assert.equal(context.prompt, request);
  assert.equal(run.prompt, request);
});

test('the caption names a native tool without a model and an API card with its exact image model', () => {
  const codex = { executor: 'Codex · 本机', imageModel: null };
  assert.deepEqual(generatedImageCaption([codex]), [{ sentence: '由 {0} 内置生图生成', names: ['Codex · 本机'] }]);
  assert.deepEqual(generatedImageCaption([{ ...codex, edit: true }]), [
    { sentence: '由 {0} 内置生图修改', names: ['Codex · 本机'] },
  ]);
  assert.deepEqual(generatedImageCaption([{ executor: 'OpenAI WorkKey', imageModel: 'gpt-image-2.5' }]), [
    { sentence: '由 {0} 生成', names: ['OpenAI WorkKey · gpt-image-2.5'] },
  ]);
  // A reply stored before imageModel existed is treated as not reported, never as the old chat-model field.
  const legacy = { executor: 'Codex · 本机', model: 'gpt-5.5' } as unknown as Parameters<
    typeof generatedImageCaption
  >[0][number];
  assert.ok(!JSON.stringify(generatedImageCaption([legacy])).includes('gpt-5.5'));
  assert.equal(generatedImageCaption([codex], (name) => name.toUpperCase())[0]!.names[0], 'CODEX · 本机');
});

for (const [failedImages, stale] of [
  [0, false],
  [2, false],
  [4, false],
  [0, true],
] as const) {
  test(`workspace batches four API images with ${failedImages} failures${stale ? ', a stale catalog and no image words' : ''} and keeps last-image edits`, async (t) => {
    const f = fixture(t);
    const agentDir = join(f.directory, 'batch-api');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'model-list.json'),
      JSON.stringify({
        preset: 'openai',
        checkedAt: Date.now(),
        ids: [],
        retired: [],
        // Stale: just restarted, nothing cached yet; the picker pick alone must still draw.
        images: stale ? [] : ['chatgpt-image-latest'],
      }),
    );
    const api = card('batch-api', 'pi', {
      gateway: 'api',
      apiProvider: 'openai',
      agentDir,
      apiBudget: {
        limitUsd: 10,
        perRunUsd: 0.1,
        maxConcurrentRuns: 1,
        burstConcurrentRuns: 1,
        preferExpiring: false,
        startedAt: new Date(Date.now() - 60000).toISOString(),
      },
    });
    f.controller.targets.push(api);
    f.controller.snapshots.push(
      ready(api, {
        accountFingerprint: 'synthetic-batch',
        authMode: 'apiKey',
        quota: {
          status: 'known',
          source: 'fixture',
          observedAt: new Date().toISOString(),
          windows: [
            { id: 'week', label: 'Week', usedPercent: 10, resetsAt: new Date(Date.now() + 3600000).toISOString() },
          ],
        },
        models: [{ id: 'openai/gpt-5.2', label: 'GPT', efforts: ['low'], price: { input: 1, output: 2 } }],
        ...(stale
          ? {}
          : { mediaModels: [{ id: 'openai/chatgpt-image-latest', label: 'Image', modality: 'image' as const }] }),
        refreshedAt: new Date().toISOString(),
      }),
    );
    let hiddenCalls = 0;
    t.mock.method(f.workspace, 'runImageBatch', async (prompt: string) => {
      hiddenCalls++;
      // Every picture request is read by the planner first; the follow-up edit is planned as one picture.
      assert.match(prompt, /prepare an image-generation job/);
      if (hiddenCalls > 1) return JSON.stringify({ images: ['make it brighter'] });
      return JSON.stringify({
        images: [
          'A red cat single image',
          'A green cat single image',
          'A blue cat single image',
          'A gold cat single image',
        ],
      });
    });
    t.mock.method(claudeAdapter, 'execute', async () => {
      throw new Error('Unexpected adapter');
    });
    const png = await syntheticPng();
    const bodies: Array<Record<string, unknown> | FormData> = [];
    const fake = createPiAdapter({
      key: () => 'synthetic-key',
      fetch: (async (_url, init) => {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : (init?.body as FormData);
        bodies.push(body);
        if (bodies.length <= failedImages)
          return new Response(
            JSON.stringify({ error: { code: 'moderation_blocked', message: 'quoted prompt text', param: null } }),
            { status: 400 },
          );
        return new Response(
          JSON.stringify({
            data: [{ b64_json: png.toString('base64') }],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      }) as typeof fetch,
    });
    const contexts: ExecuteContext[] = [];
    t.mock.method(piAdapter, 'execute', async (ctx: ExecuteContext) => {
      contexts.push(ctx);
      return fake.execute(ctx);
    });
    const conversation = await f.workspace.createGeneralConversation();
    const send = async (content: string) => {
      const { workflow } = await f.workspace.send(conversation.id, {
        content,
        mode: 'chat',
        permissionMode: 'read-only',
        executionPolicy: 'cli-first',
        runtimeId: api.id,
        model: 'openai/chatgpt-image-latest',
      });
      return finished(f.workspace, workflow.id);
    };
    const flow = await send(stale ? '礼服要选短款，还有细高跟，分开生成不同的单张' : 'Generate 4 images of a cat');
    const reply = f.workspace.store.get<ConversationMessage>('message', flow.finalMessageId!)!;
    assert.equal(flow.status, failedImages === 4 ? 'blocked' : 'completed', reply.systemNotice?.details ?? '');
    assert.equal(hiddenCalls, 1);
    assert.equal(bodies.length, 4);
    for (const body of bodies) {
      assert.equal((body as Record<string, unknown>).n, 1);
      assert.equal((body as Record<string, unknown>).model, 'chatgpt-image-latest');
    }
    assert.equal(reply.attachments?.length ?? 0, 4 - failedImages);
    assert.equal(reply.generatedImages?.length ?? 0, 4 - failedImages);
    if (failedImages === 4) {
      assert.match(reply.systemNotice?.details ?? '', /image-request-rejected: moderation_blocked/);
      assert.doesNotMatch(reply.systemNotice?.details ?? '', /quoted prompt text/);
    } else if (failedImages) {
      // A partly drawn reply stays an ordinary reply; it says what is missing in words.
      assert.equal(reply.systemNotice, undefined);
      assert.match(reply.content, /另有 2 张没生成：被 OpenAI 的内容审核拦下了/);
    } else assert.doesNotMatch(reply.content, /没生成/);
    if (failedImages === 4) return;
    const run = f.controller.run(reply.generatedImages![0]!.runId!)!;
    const events = f.controller.runWithAudit(run.id)?.events ?? run.events;
    assert.equal(events.filter((e) => e.data?.kind === 'image-request').length, 4);
    assert.equal(events.filter((e) => e.type === 'usage').length, 4 - failedImages);
    const last = f.workspace.attachments.get(conversation.id, reply.attachments!.at(-1)!.id);
    const edited = await send('make it brighter');
    assert.equal(edited.status, 'completed');
    assert.equal(hiddenCalls, 2);
    const form = bodies.at(-1) as FormData;
    assert.equal(form.get('n'), null);
    assert.equal(form.getAll('image[]').length, 1);
    const editReply = f.workspace.store.get<ConversationMessage>('message', edited.finalMessageId!)!;
    assert.equal(editReply.generatedImages?.[0]?.edit, true);
    assert.equal(contexts.at(-1)!.input.imageGeneration?.references?.[0]?.path, last.path);
  });
}

test('a prompt document named by path draws one picture per character, four at a time, named after each', async (t) => {
  const f = fixture(t);
  const agentDir = join(f.directory, 'doc-api');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, 'model-list.json'),
    JSON.stringify({ preset: 'openai', checkedAt: Date.now(), ids: [], retired: [], images: [] }),
  );
  const names = ['甲一', '乙二', '丙三', '丁四', '戊五', '己六'];
  const documentPath = join(f.directory, 'portrait-prompts.md');
  writeFileSync(
    documentPath,
    [
      '# 全人物生图提示词',
      ...names.flatMap((name, index) => [
        `## ${index + 1}. ${name}（30岁）`,
        '### 四、生图提示词',
        '* **中文提示词**：',
        `  > 全身立姿人像摄影，从头到脚完整全身构图。一位中国女性，名叫${name}，站姿挺拔。`,
        '* **英文提示词**：',
        `  > Full-body standing portrait, head-to-toe framing, a Chinese woman called ${name}.`,
      ]),
    ].join('\n'),
  );
  const api = card('doc-api', 'pi', {
    gateway: 'api',
    apiProvider: 'openai',
    agentDir,
    // The per-run reservation is far below the set's cost: it must not stop the batch.
    apiBudget: {
      limitUsd: 50,
      perRunUsd: 0.01,
      maxConcurrentRuns: 1,
      burstConcurrentRuns: 1,
      preferExpiring: false,
      startedAt: new Date(Date.now() - 60000).toISOString(),
    },
  });
  f.controller.targets.push(api);
  f.controller.snapshots.push(
    ready(api, {
      accountFingerprint: 'synthetic-doc',
      authMode: 'apiKey',
      quota: {
        status: 'known',
        source: 'fixture',
        observedAt: new Date().toISOString(),
        windows: [
          { id: 'week', label: 'Week', usedPercent: 10, resetsAt: new Date(Date.now() + 3600000).toISOString() },
        ],
      },
      models: [{ id: 'openai/gpt-5.2', label: 'GPT', efforts: ['low'], price: { input: 1, output: 2 } }],
      refreshedAt: new Date().toISOString(),
    }),
  );
  let looksAsked = 0;
  const planned: string[] = [];
  t.mock.method(f.workspace, 'runImageBatch', async (prompt: string) => {
    // The planner sees the document's prompts by key and answers with keys plus what to add per picture.
    planned.push(prompt);
    looksAsked++;
    const zh = [...prompt.matchAll(/^D(\d+) \[(.+?), zh\]/gm)].map((match) => ({
      key: `D${match[1]}`,
      title: match[2]!,
    }));
    const several = /两张/.test(prompt);
    return JSON.stringify({
      images: zh.flatMap(({ key, title }) =>
        several
          ? [
              { title: `${title} 1`, base: key, prompt: '本张造型：白衬衫西裤，正面站立。', references: [] },
              { title: `${title} 2`, base: key, prompt: '本张造型：风衣，侧身回眸。', references: [] },
            ]
          : [{ title, base: key, prompt: '', references: [] }],
      ),
    });
  });
  const png = await syntheticPng();
  const prompts: string[] = [];
  const urls: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const fake = createPiAdapter({
    key: () => 'synthetic-key',
    fetch: (async (url, init) => {
      urls.push(String(url));
      inFlight++;
      peak = Math.max(peak, inFlight);
      prompts.push(JSON.parse(String(init?.body)).prompt);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight--;
      return new Response(
        JSON.stringify({
          data: [{ b64_json: png.toString('base64') }],
          usage: { input_tokens: 100, output_tokens: 5000 },
        }),
      );
    }) as typeof fetch,
  });
  t.mock.method(piAdapter, 'execute', async (ctx: ExecuteContext) => fake.execute(ctx));
  const conversation = await f.workspace.createGeneralConversation();
  const { workflow } = await f.workspace.send(conversation.id, {
    content: `按这个文件里的提示词把每个人物都生成出来 ${documentPath}`,
    mode: 'chat',
    permissionMode: 'read-only',
    executionPolicy: 'cli-first',
    runtimeId: api.id,
    model: 'openai/gpt-image-2.6-sunburst',
  });
  const flow = await finished(f.workspace, workflow.id);
  const reply = f.workspace.store.get<ConversationMessage>('message', flow.finalMessageId!)!;
  assert.equal(flow.status, 'completed', reply.systemNotice?.details ?? reply.content);
  assert.equal(prompts.length, 6);
  assert.ok(peak <= 4, `at most four requests at once, saw ${peak}`);
  // The Chinese prompts, as written, one per character.
  assert.deepEqual(
    [...prompts].sort(),
    names.map((name) => `全身立姿人像摄影，从头到脚完整全身构图。一位中国女性，名叫${name}，站姿挺拔。`).sort(),
  );
  assert.equal(reply.generatedImages?.length, 6);
  assert.deepEqual(
    reply.attachments?.map((file) => file.name),
    names.map((name, index) => `0${index + 1}-${name}.png`),
  );
  assert.doesNotMatch(reply.content, /没生成/);
  assert.equal(looksAsked, 1);
  assert.match(planned[0]!, /Document prompts:\nD1 \[甲一, zh\]/);

  // The owner's real wording: the path runs through a folder named after one character, the last reply holds
  // generated pictures, and they ask for several looks of everyone.
  const nested = join(f.directory, '甲一', 'drafts');
  mkdirSync(nested, { recursive: true });
  const nestedPath = join(nested, 'portrait-prompts.md');
  writeFileSync(nestedPath, readFileSync(documentPath, 'utf8'));
  prompts.length = 0;
  urls.length = 0;
  const second = await f.workspace.send(conversation.id, {
    content: `文件完整绝对路径： ${nestedPath}\n点击直接打开： portrait-prompts.md\n这里面每个人物都生成两张不同穿搭和姿势的图片`,
    mode: 'chat',
    permissionMode: 'read-only',
    executionPolicy: 'cli-first',
    runtimeId: api.id,
    model: 'openai/gpt-image-2.6-sunburst',
  });
  const set = await finished(f.workspace, second.workflow.id);
  const setReply = f.workspace.store.get<ConversationMessage>('message', set.finalMessageId!)!;
  assert.equal(set.status, 'completed', setReply.systemNotice?.details ?? setReply.content);
  assert.equal(looksAsked, 2);
  // The planner was told which pictures exist and where they came from, and chose none for new characters.
  assert.match(planned[1]!, /R1: generated by PugPort in the latest reply/);
  assert.equal(prompts.length, 12, 'every character, two looks each');
  // New pictures of the document's characters: the earlier generated picture is not an edit reference.
  assert.ok(
    urls.every((url) => url.endsWith('/images/generations')),
    urls.join('\n'),
  );
  assert.ok(prompts.some((prompt) => prompt.includes('本张造型：风衣，侧身回眸')));
  assert.deepEqual(
    setReply.attachments?.slice(0, 3).map((file) => file.name),
    ['01-甲一 1.png', '02-甲一 2.png', '03-乙二 1.png'],
  );
});

test('after a failed picture, 继续 and resend both draw again with the picked image model', async (t) => {
  const f = fixture(t);
  const agentDir = join(f.directory, 'retry-api');
  mkdirSync(agentDir, { recursive: true });
  // Just restarted: no cached catalog and no media list on the snapshot.
  writeFileSync(
    join(agentDir, 'model-list.json'),
    JSON.stringify({ preset: 'openai', checkedAt: Date.now(), ids: [], retired: [], images: [] }),
  );
  const api = card('retry-api', 'pi', {
    gateway: 'api',
    apiProvider: 'openai',
    agentDir,
    apiBudget: {
      limitUsd: 10,
      perRunUsd: 0.1,
      maxConcurrentRuns: 1,
      burstConcurrentRuns: 1,
      preferExpiring: false,
      startedAt: new Date(Date.now() - 60000).toISOString(),
    },
  });
  f.controller.targets.push(api);
  f.controller.snapshots.push(
    ready(api, {
      accountFingerprint: 'synthetic-retry',
      authMode: 'apiKey',
      quota: {
        status: 'known',
        source: 'fixture',
        observedAt: new Date().toISOString(),
        windows: [
          { id: 'week', label: 'Week', usedPercent: 10, resetsAt: new Date(Date.now() + 3600000).toISOString() },
        ],
      },
      models: [{ id: 'openai/gpt-5.2', label: 'GPT', efforts: ['low'], price: { input: 1, output: 2 } }],
      refreshedAt: new Date().toISOString(),
    }),
  );
  t.mock.method(f.workspace, 'runImageBatch', async () => JSON.stringify({ images: ['A', 'B'] }));
  const png = await syntheticPng();
  let calls = 0;
  let failing = true;
  const fake = createPiAdapter({
    key: () => 'synthetic-key',
    fetch: (async () => {
      calls++;
      if (failing) return new Response(JSON.stringify({ error: { code: 'moderation_blocked' } }), { status: 400 });
      return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
    }) as typeof fetch,
  });
  t.mock.method(piAdapter, 'execute', async (ctx: ExecuteContext) => {
    assert.ok(ctx.input.imageGeneration, 'every run is an image run, never a chat answer');
    return fake.execute(ctx);
  });
  const conversation = await f.workspace.createGeneralConversation();
  const { workflow, message } = await f.workspace.send(conversation.id, {
    content: '礼服要选短款，还有细高跟，分开生成不同的单张',
    mode: 'chat',
    permissionMode: 'read-only',
    executionPolicy: 'cli-first',
    runtimeId: api.id,
    model: 'openai/gpt-image-2.6-sunburst',
  });
  const failed = await finished(f.workspace, workflow.id);
  assert.equal(failed.status, 'blocked');
  assert.equal(calls, 2);
  failing = false;
  const continued = await f.workspace.continue(failed.id);

  const drawn = await finished(f.workspace, continued.workflow.id);
  const reply = f.workspace.store.get<ConversationMessage>('message', drawn.finalMessageId!)!;
  assert.equal(reply.generatedImages?.length, 2);
  assert.equal(calls, 4);
  const resent = await f.workspace.resendMessage(conversation.id, message.id);
  const again = await finished(f.workspace, resent.workflow.id);
  assert.equal(
    f.workspace.store.get<ConversationMessage>('message', again.finalMessageId!)!.generatedImages?.length,
    2,
  );
});

test('native image batching invokes Codex once with the complete list', async (t) => {
  const f = fixture(t);
  const prompts = ['A red cat', 'A blue cat', 'A green cat', 'A gold cat'];
  t.mock.method(f.workspace, 'runImageBatch', async () => JSON.stringify({ images: prompts }));
  let calls = 0;
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls++;
    assert.match(ctx.input.prompt, /Make 4 separate images/);
    assert.match(ctx.input.prompt, /call the tool once per image; never a grid/);
    for (const prompt of prompts) assert.ok(ctx.input.prompt.includes(prompt));
    const outputDir = ctx.input.imageGeneration!.outputDir;
    mkdirSync(outputDir, { recursive: true });
    const path = join(outputDir, 'synthetic.png');
    writeFileSync(path, await syntheticPng());
    return {
      output: 'Made four images.',
      generatedImages: prompts.map(() => ({
        path,
        mimeType: 'image/png' as const,
        executor: ctx.target.label,
        runtimeId: ctx.target.id,
        tool: 'native-tool' as const,
        imageModel: null,
      })),
    };
  });
  const conversation = await f.workspace.createGeneralConversation();
  const { workflow } = await f.workspace.send(conversation.id, {
    content: 'Generate 4 images of cats',
    mode: 'chat',
    permissionMode: 'read-only',
    executionPolicy: 'cli-first',
  });
  const flow = await finished(f.workspace, workflow.id);
  assert.equal(flow.status, 'completed');
  const reply = f.workspace.store.get<ConversationMessage>('message', flow.finalMessageId!)!;
  assert.equal(reply.attachments?.length, 4);
  assert.equal(calls, 1);
});
