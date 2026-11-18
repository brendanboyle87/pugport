import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imageBatchPrompts } from '../src/server/image-batch.ts';
import { pickImageReferences, referenceLegend } from '../src/server/image-references.ts';

const base = { generatedIds: new Set(['person', 'grid']), previousMessageImages: [] as string[], edit: true };

test('"keep the person from before, wear the outfit I sent" uses the outfit and the last picture', () => {
  const picks = pickImageReferences({
    ...base,
    text: '刚才的人物保持不变，换上这套我给你发的服饰生成几个不同姿势的',
    current: [{ id: 'outfit', name: 'image.png' }],
    lastGenerated: 'person',
  });
  assert.deepEqual(picks, [
    { id: 'outfit', source: 'current' },
    { id: 'person', source: 'last-generated' },
  ]);
  const legend = referenceLegend(picks);
  assert.match(legend, /1\) attached or quoted by the owner with this message/);
  assert.match(legend, /2\) the picture generated in the previous turn/);
});

test('"this person; the earlier picture was only for the outfit" adds the outfit from the previous message', () => {
  const picks = pickImageReferences({
    ...base,
    text: '我说的是这个人物，刚才的图片只是给你作为服饰参考',
    // A downscaled copy of an earlier picture: nothing ties it to the generated one, the words decide.
    current: [{ id: 'copy', name: '1fa6860e.png' }],
    lastGenerated: 'grid',
    previousMessageImages: ['outfit'],
  });
  assert.deepEqual(picks, [
    { id: 'copy', source: 'current' },
    { id: 'outfit', source: 'previous-message' },
  ]);
});

test('plain requests keep their old references', () => {
  assert.deepEqual(pickImageReferences({ ...base, text: 'make it brighter', current: [], lastGenerated: 'person' }), [
    { id: 'person', source: 'last-generated' },
  ]);
  assert.deepEqual(
    pickImageReferences({ ...base, text: '画一只猫', current: [], lastGenerated: 'person', edit: false }),
    [],
  );
  const one = pickImageReferences({ ...base, text: '把背景换成蓝色', current: [{ id: 'a', name: 'a.png' }] });
  assert.deepEqual(one, [{ id: 'a', source: 'current' }]);
  assert.equal(referenceLegend(one), '');
});

test('"几个不同姿势" asks for several pictures', async () => {
  for (const request of [
    '刚才的人物保持不变，换上这套我给你发的服饰生成几个不同姿势的',
    '来几种不同角度',
    'show her in different poses',
  ]) {
    let calls = 0;
    await imageBatchPrompts(request, async () => {
      calls++;
      return '{"images":["a","b"]}';
    });
    assert.equal(calls, 1, request);
  }
});
