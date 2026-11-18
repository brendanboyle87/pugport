import { saveAttachment } from './helpers/attachments.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { route, RouteUnavailableError } from '../src/server/routing.ts';
import { Controller } from '../src/server/controller.ts';
import { piAdapter } from '../src/server/adapters/pi.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { freeStage2Fixture } from './free-stage2-fixture.ts';
import { now, settings, input, free, paid } from './save-money-fixture.ts';
import { MentionMenu, mentionItems } from '../src/ui/Mentions.tsx';
import { freeChainMentionId } from '../src/shared/participants.ts';
import { ComposerSession, emptyDraft, pickDraftMention } from '../src/ui/composer-session.ts';
import type { ExecuteContext, RunInput, RunRecord, RuntimeTarget, Workflow } from '../src/shared/types.ts';

const hosted = { ...free, id: 'hosted', apiProvider: 'groq-free', local: false, mayLog: true };
const request: RunInput = { ...input, freeChain: true, textOnlyPrompt: 'Say hello' };
const cooling = (source: typeof free, delay: number) => ({
  ...source,
  availability: {
    reason: 'quota' as const,
    observedAt: new Date(now).toISOString(),
    retryAt: new Date(now + delay).toISOString(),
  },
});
const message = {
  content: 'Say hello',
  mode: 'chat' as const,
  permissionMode: 'read-only' as const,
  executionPolicy: 'api-only' as const,
  freeChain: true,
};

test('free chain chooses local first and ignores paid pins, models and strict paid rules', () => {
  assert.equal(route(request, [paid, hosted, free], settings, new Set(), now).runtimeId, free.id);
  assert.equal(route(request, [paid, hosted], settings, new Set(), now).runtimeId, hosted.id);
  assert.equal(
    route(
      {
        ...request,
        runtimeId: paid.id,
        model: paid.models[0]!.id,
        confirmedRoute: { runtimeId: paid.id, model: paid.models[0]!.id },
        routeRule: { strict: true } as never,
      },
      [paid, free],
      settings,
      new Set(),
      now,
    ).runtimeId,
    free.id,
  );
  assert.throws(() => route(request, [paid], settings, new Set(), now), /免费来源都暂不可用/);
});

test('cooling local is skipped; all cooling wait for the earliest retry, never paid', () => {
  assert.equal(route(request, [cooling(free, 60000), hosted, paid], settings, new Set(), now).runtimeId, hosted.id);
  for (const patch of [{}, { excludeRuntimeIds: [free.id, hosted.id] }]) {
    assert.throws(
      () =>
        route({ ...request, ...patch }, [cooling(free, 60000), cooling(hosted, 30000), paid], settings, new Set(), now),
      (error: unknown) =>
        error instanceof RouteUnavailableError &&
        error.kind === 'quota' &&
        error.retryAt === new Date(now + 30000).toISOString() &&
        /可取消/.test(error.message),
    );
  }
});

test('only may-log sources explain images and reject files before sending', () => {
  assert.throws(
    () => route({ ...request, attachments: [{ kind: 'image' } as never] }, [hosted, paid], settings, new Set(), now),
    /不能发送附件/,
  );
  assert.throws(
    () =>
      route(
        {
          ...request,
          attachments: [
            {
              id: 'pdf',
              name: 'fixture.pdf',
              path: 'fixture.pdf',
              mimeType: 'application/pdf',
              size: 10,
              kind: 'file',
            },
          ],
        },
        [hosted, paid],
        settings,
        new Set(),
        now,
      ),
    /都可能记录内容.*不能发送附件.*移除附件或选择不记录内容的来源/,
  );
  assert.throws(() => route({ ...request, textOnlyPrompt: undefined }, [hosted], settings, new Set(), now));
});

test('free relay continues through free sources but refuses partial output, tools and content refusals', () => {
  const sources = [free, hosted, { ...free, id: 'third' }, paid];
  const controller = Object.assign(Object.create(Controller.prototype), {
    targets: sources,
    store: { run: () => undefined },
    preview: (next: RunInput) => route(next, sources, settings, new Set(), now),
  }) as Controller;
  const failed: RunRecord = {
    id: 'fixture',
    prompt: '',
    projectPath: 'fixture',
    kind: 'routine',
    status: 'failed',
    startedAt: '',
    output: '',
    events: [],
    errorCode: 'quota-or-rate-limit',
    route: route(request, sources, settings, new Set(), now),
  };
  const next = controller.freeRelay(request, failed)!.input;
  assert.equal(next.freeChain, true);
  assert.equal(controller.preview(next).runtimeId, 'third');
  for (const patch of [
    { output: 'partial' },
    { output: ' ' },
    { hadToolActivity: true },
    { events: [{ at: '', type: 'text', text: 'streamed' }] },
    { error: 'content_policy_violation', errorCode: 'runtime-request-failed' },
    { status: 'completed', output: 'I cannot help with this content policy request.' },
  ] as Partial<RunRecord>[])
    assert.equal(controller.freeRelay(request, { ...failed, ...patch }), undefined);
  assert.equal(controller.accountRelay(request, failed), undefined);
});

test('Mentions hides free without enabled sources and renders an icon and description', () => {
  const target = { ...free, enabled: true, command: 'never' } as RuntimeTarget;
  assert.equal(
    mentionItems([], []).some((item) => item.id === freeChainMentionId),
    false,
  );
  assert.equal(
    mentionItems([], [{ ...target, enabled: false }]).some((item) => item.id === freeChainMentionId),
    false,
  );
  const item = mentionItems([], [], [], [], [target]).find((row) => row.id === freeChainMentionId)!;
  assert.equal(item.name, '免费');
  const html = renderToStaticMarkup(
    createElement(MentionMenu, {
      items: [item],
      active: 0,
      onHover() {},
      onPick() {},
      onCreate() {},
    }),
  );
  assert.match(html, /<svg/);
  assert.match(html, /只用免费来源/);
  const session = new ComposerSession();
  session.changeDraft('draft', (draft) => pickDraftMention(draft, item, '@免费 Say hello'));
  assert.equal(session.getSnapshot().drafts.draft!.freeChain, true);
  assert.equal(session.getSnapshot().drafts.draft!.called, undefined);
  assert.equal(
    pickDraftMention(emptyDraft(), { kind: 'executor', id: 'paid', name: 'Paid' }, '@Paid hi').freeChain,
    false,
  );
  session.dispose();
});

test('workflow relays to hosted text-only and never calls a paid executor', async (t) => {
  const f = await freeStage2Fixture(t);
  t.mock.method(f.workspace as unknown as { trySteer(): Promise<undefined> }, 'trySteer', async () => {
    assert.fail('free chain must not steer a running paid task');
  });
  const calls: ExecuteContext[] = [];
  t.mock.method(piAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    if (ctx.target.id === free.id) throw Error('quota-or-rate-limit');
    return { output: 'Free answer' };
  });
  t.mock.method(codexAdapter, 'execute', async () => {
    assert.fail('paid executor');
  });
  const workflow = await f.finish((await f.workspace.send(f.conversation.id, message)).workflow.id);
  assert.equal(workflow.status, 'completed');
  assert.equal(workflow.input.queue, true);
  assert.deepEqual(
    calls.map((ctx) => ctx.target.id),
    [free.id, hosted.id],
  );
  const sent = calls[1]!.input;
  assert.equal(sent.textOnly, true);
  assert.equal(sent.permissionMode, 'read-only');
  assert.equal(sent.attachments, undefined);
  assert.equal(sent.prompt, sent.textOnlyPrompt);
  assert.doesNotMatch(sent.prompt, /PRIVATE_PROJECT_RULE|PRIVATE_RETRIEVED_MEMORY/);
});

test('a free model refusal stays in the free chain instead of retrying the card default', async (t) => {
  const f = await freeStage2Fixture(t);
  const source = f.controller.snapshots.find((snapshot) => snapshot.id === free.id)!;
  source.models = [
    ...source.models,
    { id: 'pugport-ollama/default', label: 'Default', efforts: ['off'], catalogDefault: true },
  ];
  const calls: ExecuteContext[] = [];
  t.mock.method(piAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    if (ctx.target.id === free.id) throw Error('runtime-model-unavailable');
    return { output: 'Free answer' };
  });
  t.mock.method(codexAdapter, 'execute', async () => assert.fail('must not use a paid executor'));
  const workflow = await f.finish((await f.workspace.send(f.conversation.id, message)).workflow.id);
  assert.equal(workflow.status, 'completed');
  assert.deepEqual(
    calls.map((ctx) => ctx.target.id),
    [free.id, hosted.id],
  );
  assert.ok(calls.every((ctx) => ctx.input.freeChain));
  assert.equal(workflow.modelFallbackNotice, undefined);
});

test('workflow content refusal stops with a short notice', async (t) => {
  const f = await freeStage2Fixture(t);
  const calls: string[] = [];
  t.mock.method(piAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx.target.id);
    return { output: 'I cannot help with this content policy request.' };
  });
  t.mock.method(codexAdapter, 'execute', async () => {
    assert.fail('paid executor');
  });
  const workflow = await f.finish((await f.workspace.send(f.conversation.id, message)).workflow.id);
  assert.deepEqual(calls, [free.id]);
  assert.ok(
    f.workspace.store
      .messages(f.conversation.id)
      .some((row) => /免费来源拒绝/.test(row.systemNotice?.text ?? row.content)),
  );
  assert.notEqual(workflow.status, 'running');
});

test('workflow all cooling queues the earliest retry and can be cancelled without a paid call', async (t) => {
  const f = await freeStage2Fixture(t);
  for (const target of f.controller.targets.filter((source) => source.id !== paid.id))
    f.controller.freeHealth.record(target, 'quota-or-rate-limit', target.id === free.id ? 120 : 60);
  const due = Date.parse(f.controller.freeHealth.apply(hosted).availability!.retryAt!);
  t.mock.method(piAdapter, 'execute', async () => {
    assert.fail('cooling executor');
  });
  t.mock.method(codexAdapter, 'execute', async () => {
    assert.fail('paid executor');
  });
  const id = (await f.workspace.send(f.conversation.id, message)).workflow.id;
  let workflow: Workflow | undefined;
  for (let i = 0; i < 100; i++) {
    await f.workspace.tickQueue();
    workflow = f.workspace.store.get<Workflow>('workflow', id);
    if (workflow?.status === 'waiting-resource') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(workflow?.status, 'waiting-resource', JSON.stringify(workflow));
  assert.equal(workflow?.scheduling?.nextAttemptAt, new Date(due).toISOString());
  assert.equal(workflow?.runIds.length, 0);
  f.workspace.cancel(id);
  assert.equal(f.workspace.store.get<Workflow>('workflow', id)!.status, 'cancelled');
});

test('workflow waits after exhausting cooling sources, then retries a free source', async (t) => {
  const f = await freeStage2Fixture(t);
  const calls: string[] = [];
  const failed = new Set<string>();
  t.mock.method(piAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx.target.id);
    if (!failed.has(ctx.target.id)) {
      failed.add(ctx.target.id);
      ctx.emit({ at: new Date().toISOString(), type: 'status', data: { retryAfterSeconds: 2 } });
      throw Error('quota-or-rate-limit');
    }
    return { output: 'Free answer after waiting' };
  });
  t.mock.method(codexAdapter, 'execute', async () => {
    assert.fail('paid executor');
  });
  const id = (await f.workspace.send(f.conversation.id, message)).workflow.id;
  let waited = false;
  let workflow: Workflow | undefined;
  for (let i = 0; i < 1000; i++) {
    await f.workspace.tickQueue();
    workflow = f.workspace.store.get<Workflow>('workflow', id);
    if (workflow?.status === 'waiting-resource') waited = true;
    if (workflow && ['completed', 'blocked', 'failed', 'cancelled'].includes(workflow.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(waited, true);
  assert.equal(workflow?.status, 'completed', workflow?.error ?? 'workflow did not complete');
  assert.deepEqual(calls, [free.id, hosted.id, free.id]);
});

test('workflow image with only may-log sources explains and sends nothing', async (t) => {
  const f = await freeStage2Fixture(t);
  f.controller.targets = f.controller.targets.filter((source) => source.id !== free.id);
  f.controller.snapshots = f.controller.snapshots.filter((source) => source.id !== free.id);
  const attachment = await saveAttachment(f.workspace.attachments, f.conversation.id, {
    name: 'synthetic.png',
    mimeType: 'image/png',
    dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  });
  t.mock.method(piAdapter, 'execute', async () => {
    assert.fail('image sent to may-log source');
  });
  t.mock.method(codexAdapter, 'execute', async () => {
    assert.fail('paid visual fallback');
  });
  const workflow = await f.finish(
    (
      await f.workspace.send(f.conversation.id, {
        ...message,
        attachmentIds: [attachment.id],
      })
    ).workflow.id,
  );
  assert.equal(workflow.runIds.length, 0);
  assert.match(workflow.error ?? '', /不能发送附件/);
});
