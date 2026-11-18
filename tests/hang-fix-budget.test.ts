import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { optionalInference } from '../src/server/inference-budget.ts';
import { workflowLayaState } from '../src/server/laya-workflow.ts';
import { deriveTrajectory } from '../src/shared/trajectory.ts';
import type { ConversationMessage, RunRecord } from '../src/shared/types.ts';

test('thousands of observations for one streamed call are rendered once with all evidence retained', (t) => {
  const count = 6204;
  const record: RunRecord = {
    id: 'synthetic',
    prompt: 'Read the file',
    projectPath: 'C:/synthetic',
    kind: 'general',
    status: 'completed',
    startedAt: '2026-01-01T00:00:00Z',
    output: '',
    route: { runtimeId: 'synthetic', model: 'synthetic', kind: 'general', reasons: [], warnings: [] },
    events: Array.from({ length: count }, (_, index) => ({
      type: 'tool',
      at: '2026-01-01T00:00:00Z',
      seq: index + 1,
      data: {
        toolCallId: 'one-stream',
        tool: 'Read',
        status: index === count - 1 ? 'completed' : 'running',
        outputMode: 'delta',
        output: 'synthetic output '.repeat(20),
      },
    })),
  };
  const started = performance.now();
  const trajectory = deriveTrajectory(record);
  const elapsed = performance.now() - started;
  t.diagnostic(`6204 observations: ${elapsed.toFixed(1)} ms`);
  assert.ok(elapsed < 2000, `projection blocked for ${elapsed} ms`);
  const row = trajectory.rows.find((item) => item.lane === 'tools')!;
  const detail = JSON.parse(row.detail!);
  assert.equal(detail.observations.length, count);
  assert.equal(detail.observations[0].sequence, 1);
  assert.equal(detail.observations.at(-1).sequence, count);
  assert.equal(row.status, 'completed');
});

test('shared classification deadline releases a transport that ignores abort and ignores its late result', async () => {
  const controller = new AbortController();
  let resolve!: (value: string) => void;
  const pending = optionalInference(
    controller.signal,
    () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
  );
  await Promise.resolve();
  controller.abort();
  assert.equal(await pending, undefined);
  resolve('late advice');
  let called = false;
  assert.equal(
    await optionalInference(controller.signal, async () => {
      called = true;
      return 'second';
    }),
    undefined,
  );
  assert.equal(called, false);
  assert.equal(
    await optionalInference(new AbortController().signal, async () => {
      throw Error('offline');
    }),
    undefined,
  );
});

test('classification of a synthetic phone screenshot transports metadata only', async () => {
  const image = await sharp({ create: { width: 1170, height: 2532, channels: 3, background: '#abc' } })
    .jpeg()
    .toBuffer();
  const metadata = await sharp(image).metadata();
  assert.deepEqual([metadata.width, metadata.height], [1170, 2532]);
  const message = {
    id: 'current',
    role: 'user',
    content: '找一下这个内容',
    attachments: [{ id: 'image', name: 'synthetic.jpg', kind: 'image', mimeType: 'image/jpeg', size: image.length }],
  } as ConversationMessage;
  const history = Array.from({ length: 6 }, (_, i) => ({
    ...message,
    id: `prior-${i}`,
    content: 'Synthetic history '.repeat(30),
  }));
  const state = workflowLayaState(message, history, []);
  assert.deepEqual(state.attachments, [{ kind: 'image', name: 'synthetic.jpg' }]);
  assert.ok(JSON.stringify(state).length < 6000);
  assert.equal(state.message, '找一下这个内容');
});
