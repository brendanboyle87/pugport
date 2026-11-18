import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cleanDictation } from '../src/shared/voice-cleanup.ts';
import { addVoiceAudio, finishVoiceSession, startVoiceSession, voiceModelDirectory } from '../src/server/voice.ts';

test('the free pass removes fillers and stutters but keeps meaning', () => {
  assert.equal(
    cleanDictation('嗯，那个，帮我把额度改成红黄绿，然后然后再检查一下路由。'),
    '帮我把额度改成红黄绿，然后再检查一下路由。',
  );
  assert.equal(cleanDictation('呃 我我觉得这个方案可以。'), '我觉得这个方案可以。');
  assert.equal(cleanDictation('Um, uh, please rename the file.'), 'please rename the file.');
  // Meaningful words stay: "那个文件" is not a filler.
  assert.equal(cleanDictation('把那个文件删掉'), '把那个文件删掉');
  assert.equal(cleanDictation('哈哈，谢谢谢谢'), '哈哈，谢谢谢谢');
});

const modelReady = !!voiceModelDirectory(process.cwd());

test('a Mod recording becomes text locally', { skip: !modelReady }, async () => {
  // One second of silence: recognised as nothing, which is reported rather than invented.
  const id = startVoiceSession();
  await addVoiceAudio(process.cwd(), id, Buffer.from(new Float32Array(16000).buffer));
  const result = await finishVoiceSession(process.cwd(), id);
  assert.equal(typeof result.text, 'string');
  await assert.rejects(addVoiceAudio(process.cwd(), id, Buffer.alloc(8)), /录音已结束/);
});

test('the model is looked up in the app folder (development) and next to it (packaged)', () => {
  const dir = voiceModelDirectory(process.cwd());
  if (dir) assert.ok(existsSync(join(dir, 'model.int8.onnx')));
  assert.equal(voiceModelDirectory(join(process.cwd(), 'no-such-folder')), undefined);
});
