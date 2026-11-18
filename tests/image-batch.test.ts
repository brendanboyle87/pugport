import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imageBatchPrompts } from '../src/server/image-batch.ts';

test('single images keep the exact request and never call the helper', async () => {
  for (const request of ['  Draw a red fox  ', '生成一张猫的图片', 'Make one portrait']) {
    assert.deepEqual(await imageBatchPrompts(request, async () => assert.fail('Unexpected helper call')), [request]);
  }
});

for (const request of [
  '生成不同的姿势，穿着，还有带着金丝眼镜的几张不同的',
  '晚礼服要全身，还有细高跟，漏脚后跟的细高跟，黑丝铅笔裙，分开生成不同的单张',
]) {
  test(`the owner request produces four standalone prompts: ${request}`, async () => {
    let calls = 0;
    const expected = ['正面', '侧面', '背面', '坐姿'].map(
      (pose) => `同一人物，全身，单张，${pose}，保留相同风格与金丝眼镜，不要拼图`,
    );
    const result = await imageBatchPrompts(request, async (prompt) => {
      calls++;
      assert.ok(prompt.includes(request));
      assert.match(prompt, /unspecified plural count use 4/);
      assert.match(prompt, /subject, fixed character identity, style, references/);
      assert.match(prompt, /full body.*one separate image/);
      assert.match(prompt, /never a grid/);
      return JSON.stringify({ images: expected });
    });
    assert.equal(calls, 1);
    assert.deepEqual(result, expected);
    assert.ok(result.every((item) => item.includes('同一人物') && item.includes('单张') && item.includes('不要拼图')));
  });
}

test('plural counts and list cues call the helper once', async () => {
  for (const request of [
    '几张猫',
    '多张猫',
    '一组猫',
    '分别画猫',
    '分开画猫',
    '各画一张',
    '每个角色',
    '每种姿势',
    '每张不同',
    '不同的三款',
    '2张猫',
    '三张猫',
    '4 images',
    'a few portraits',
    'several cats',
    'a set of cats',
    'each cat',
    'draw separately',
    '猫还有狗',
  ]) {
    let calls = 0;
    await imageBatchPrompts(request, async () => {
      calls++;
      return '{"images":["one","two"]}';
    });
    assert.equal(calls, 1, request);
  }
});

test('an ordinary one-picture sentence with commas or "and" never calls the helper', async () => {
  for (const request of ['画一只猫，坐在窗边，阳光很暖', '一只猫、一盆花的静物', 'a cat and a dog on a sofa'])
    assert.deepEqual(await imageBatchPrompts(request, async () => assert.fail('Unexpected helper call')), [request]);
});

test('JSON wrapped in a code fence or a sentence is still read', async () => {
  for (const output of ['```json\n{"images":["a","b"]}\n```', 'Here you go: {"images":["a","b"]} done.'])
    assert.deepEqual(await imageBatchPrompts('several cats', async () => output), ['a', 'b']);
});

test('bad JSON and malformed image entries fall back to the original', async () => {
  const request = 'several cats';
  for (const output of ['oops', 'null', '[]', '{}', '{"images":[]}', '{"images":[""]}', '{"images":["cat",2]}'])
    assert.deepEqual(await imageBatchPrompts(request, async () => output), [request]);
});

test('helper failure falls back without throwing', async () => {
  assert.deepEqual(
    await imageBatchPrompts('several cats', async () => {
      throw new Error('Unavailable');
    }),
    ['several cats'],
  );
});

test('timeout returns the original and aborts a stalled helper', async () => {
  let signal: AbortSignal | undefined;
  const result = await imageBatchPrompts(
    'several cats',
    async (_, abort) => {
      signal = abort;
      return new Promise<string>(() => {});
    },
    { timeoutMs: 5 },
  );
  assert.deepEqual(result, ['several cats']);
  assert.equal(signal?.aborted, true);
});

test('incognito never calls the helper', async () => {
  assert.deepEqual(
    await imageBatchPrompts('several cats', async () => assert.fail('Private helper call'), { incognito: true }),
    ['several cats'],
  );
});

test('parent cancellation aborts planning and falls back', async () => {
  const abort = new AbortController();
  const result = imageBatchPrompts(
    'several cats',
    async () => {
      abort.abort();
      return new Promise<string>(() => {});
    },
    { signal: abort.signal },
  );
  assert.deepEqual(await result, ['several cats']);
});

test('valid model output is trimmed and a long set is kept whole', async () => {
  const planned = await imageBatchPrompts('30 images', async () =>
    JSON.stringify({ images: [' one ', ...Array.from({ length: 29 }, (_, index) => `item ${index + 2}`)] }),
  );
  assert.equal(planned.length, 30);
  assert.equal(planned[0], 'one');
});
