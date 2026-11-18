import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import {
  parseSubtitle,
  pickSubtitle,
  transcriptionCapSeconds,
  VideoReader,
  videoLinks,
  videoPromptBlock,
  type VideoProgress,
  type VideoTools,
} from '../src/server/video-transcript.ts';
import type { ExecuteContext } from '../src/shared/types.ts';
import { finished, fixture, input, result } from './helpers/session-workspace.ts';

const sample = { title: 'Synthetic talk', description: 'Synthetic description.', duration: 600, language: 'zh' };

function reader(t: { after(fn: () => void): void }, tools: Partial<VideoTools>) {
  const data = mkdtempSync(join(tmpdir(), 'pugport-video-test-'));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const fake: VideoTools = {
    ytDlp: 'synthetic-yt-dlp',
    ffmpeg: 'synthetic-ffmpeg',
    voiceReady: true,
    run: async () => {
      throw new Error('unexpected run');
    },
    samples: async function* () {
      throw new Error('unexpected decode');
    },
    transcribe: async () => {
      throw new Error('unexpected transcription');
    },
    fetchText: async () => {
      throw new Error('unexpected fetch');
    },
    ...tools,
  };
  return { data, video: new VideoReader(data, data, fake) };
}

test('video links: bare and full links, lookalikes ignored, each video once', () => {
  assert.deepEqual(videoLinks('bilibili.com/video/BV1G4xL6cEEw\n这个讲的是什么？'), [
    { url: 'https://bilibili.com/video/BV1G4xL6cEEw', key: 'bilibili:BV1G4xL6cEEw:1' },
  ]);
  assert.deepEqual(
    videoLinks(
      '看看https://www.youtube.com/watch?v=abcdefghijk&t=3s，还有 https://youtu.be/abcdefghijk 和 https://b23.tv/xYz12',
    ).map((link) => link.key),
    ['youtube:abcdefghijk', 'b23:xYz12'],
  );
  assert.equal(videoLinks('https://www.bilibili.com/video/BV1G4xL6cEEw/?p=3')[0]!.key, 'bilibili:BV1G4xL6cEEw:3');
  assert.deepEqual(videoLinks('https://example.com/r?u=youtube.com/watch?v=abcdefghijk'), []);
  assert.deepEqual(videoLinks('https://notyoutube.com/watch?v=abcdefghijk https://example.com/video'), []);
  assert.equal(
    videoLinks('https://vimeo.com/1 https://vimeo.com/2 https://vimeo.com/3').length,
    2,
    'at most two videos per message',
  );
});

test('subtitle choice: video language first, platform captions next, comments never', () => {
  const official = {
    en: [{ ext: 'vtt', url: 'u-en' }],
    'zh-Hans': [
      { ext: 'srt', url: 'u-srt' },
      { ext: 'json3', url: 'u-json3' },
    ],
    danmaku: [{ ext: 'xml', url: 'd' }],
  };
  assert.deepEqual(pickSubtitle({ language: 'zh', subtitles: official }), {
    language: 'zh-Hans',
    automatic: false,
    track: { ext: 'json3', url: 'u-json3' },
  });
  // The video's own auto captions beat an official translation into another language.
  const pick = pickSubtitle({
    language: 'ja',
    subtitles: { en: [{ ext: 'vtt', url: 'en' }] },
    automatic_captions: { 'ja-orig': [{ ext: 'vtt', url: 'ja' }], af: [{ ext: 'vtt', url: 'af' }] },
  });
  assert.equal(pick?.language, 'ja');
  assert.equal(pick?.automatic, true);
  // Unknown language: official before automatic, Chinese/English preferred over machine translations.
  assert.equal(
    pickSubtitle({ automatic_captions: { af: [{ ext: 'vtt', url: 'af' }], en: [{ ext: 'vtt', url: 'en' }] } })
      ?.language,
    'en',
  );
  assert.equal(
    pickSubtitle({ subtitles: { danmaku: [{ ext: 'xml', url: 'd' }], live_chat: [{ url: 'c' }] } }),
    undefined,
  );
  assert.equal(
    pickSubtitle({
      subtitles: { 'zh-Hans': [{ ext: 'srt', data: '1\n00:00:01,000 --> 00:00:02,000\n嗨' }] },
    })?.track.data?.includes('嗨'),
    true,
  );
});

test('subtitle formats: json3, Bilibili json, vtt rolling captions, srt and xml', () => {
  assert.deepEqual(
    parseSubtitle(
      JSON.stringify({
        events: [{ tStartMs: 1500, segs: [{ utf8: 'Hello ' }, { utf8: 'world' }] }, { tStartMs: 3000 }],
      }),
    ),
    [{ start: 1.5, text: 'Hello world' }],
  );
  assert.deepEqual(parseSubtitle(JSON.stringify({ body: [{ from: 62.4, to: 64, content: '第一句' }] })), [
    { start: 62.4, text: '第一句' },
  ]);
  const vtt = [
    'WEBVTT',
    'Kind: captions',
    '',
    '00:00:01.000 --> 00:00:03.000 align:start',
    'we<00:00:01.500><c> start</c> here',
    '',
    '00:00:03.000 --> 00:00:05.000',
    'we start here',
    'and go on &amp; on',
    '',
    '01:00:00.000 --> 01:00:02.000',
    'late line',
  ].join('\n');
  assert.deepEqual(parseSubtitle(vtt), [
    { start: 1, text: 'we start here' },
    { start: 3, text: 'and go on & on' },
    { start: 3600, text: 'late line' },
  ]);
  assert.deepEqual(
    parseSubtitle('1\r\n00:01:02,500 --> 00:01:04,000\r\n字幕一\r\n\r\n2\r\n00:01:05,000 --> 00:01:06,000\r\n字幕二'),
    [
      { start: 62.5, text: '字幕一' },
      { start: 65, text: '字幕二' },
    ],
  );
  assert.deepEqual(
    parseSubtitle(
      '<timedtext><body><p t="2000" d="1000">A&#39;s <s>line</s></p><p begin="00:00:04.5s">B</p></body></timedtext>',
    ),
    [
      { start: 2, text: "A's line" },
      { start: 4.5, text: 'B' },
    ],
  );
});

test('reader: subtitles are used first and cached; incognito keeps nothing', async (t) => {
  const runs: string[][] = [];
  const { data, video } = reader(t, {
    run: async (_command, args) => {
      runs.push(args);
      return JSON.stringify({
        ...sample,
        subtitles: { zh: [{ ext: 'srt', url: 'https://subtitles.example/zh.srt' }] },
      });
    },
    fetchText: async (url) => {
      assert.equal(url, 'https://subtitles.example/zh.srt');
      return '1\n00:00:01,000 --> 00:00:02,000\n合成字幕第一句\n\n2\n00:06:00,000 --> 00:06:02,000\n合成字幕第二段';
    },
  });
  const link = videoLinks('https://www.bilibili.com/video/BV1aaaaaaaaa')[0]!;
  const notes: VideoProgress[] = [];
  const reading = await video.read(link, {
    signal: new AbortController().signal,
    progress: (step) => notes.push(step),
  });
  assert.equal(reading.source, 'subtitles');
  assert.equal(reading.language, 'zh');
  assert.equal(reading.automatic, false);
  assert.equal(reading.cues.length, 2);
  assert.ok(runs[0]!.includes('--skip-download'));
  assert.deepEqual(notes, [{ stage: 'reading' }]);
  const again = await video.read(link, { signal: new AbortController().signal });
  assert.equal(again.cues.length, 2);
  assert.equal(runs.length, 1, 'a cached transcript needs no second download');

  const other = videoLinks('https://youtu.be/bbbbbbbbbbb')[0]!;
  await video.read(other, { signal: new AbortController().signal, cache: false });
  assert.equal(readdirSync(join(data, 'video-transcripts')).length, 1, 'incognito reading is not written to disk');
  assert.equal(runs.length, 2);

  const block = videoPromptBlock([reading]);
  assert.match(block, /内容来源：字幕（官方，语言 zh）/);
  assert.match(block, /\[0:00–5:00\] 合成字幕第一句/);
  assert.match(block, /\[5:00–10:00\] 合成字幕第二段/);
  assert.match(block, /开头用一句话说明用的是哪种来源/);
});

test('reader: no subtitles → audio is downloaded, decoded in windows and transcribed locally with progress', async (t) => {
  let folder = '';
  let decodeLimit = 0;
  const { video } = reader(t, {
    run: async (_command, args, _signal, line) => {
      if (args.includes('-J'))
        return JSON.stringify({ ...sample, duration: 75, subtitles: { danmaku: [{ ext: 'xml', url: 'd' }] } });
      const output = args[args.indexOf('-o') + 1]!;
      folder = join(output, '..');
      writeFileSync(output.replace('%(ext)s', 'm4a'), 'synthetic audio bytes');
      line?.('download:  50.0%');
      line?.('download: 100.0%');
      assert.ok(args.includes('bestaudio[abr<=160]/bestaudio/worst'));
      return '';
    },
    samples: async function* (_ffmpeg, file, maxSeconds, seconds) {
      assert.ok(file.endsWith('audio.m4a'));
      assert.equal(seconds, 30);
      decodeLimit = maxSeconds;
      yield new Float32Array(30 * 16000);
      yield new Float32Array(30 * 16000);
      yield new Float32Array(15 * 16000);
    },
    transcribe: (() => {
      const texts = ['第一段合成转写。', '', '最后一段。'];
      return async () => texts.shift()!;
    })(),
  });
  const notes: VideoProgress[] = [];
  const reading = await video.read(videoLinks('https://youtu.be/ccccccccccc')[0]!, {
    signal: new AbortController().signal,
    progress: (step) => notes.push(step),
  });
  assert.equal(reading.source, 'transcription');
  assert.deepEqual(reading.cues, [
    { start: 0, text: '第一段合成转写。' },
    { start: 60, text: '最后一段。' },
  ]);
  assert.equal(reading.transcribedSeconds, 75);
  assert.equal(decodeLimit, 75);
  assert.deepEqual(
    notes.filter((step) => step.stage === 'downloading').map((step) => step.percent),
    [0, 50, 100],
  );
  assert.deepEqual(
    notes.find((step) => step.stage === 'transcribing'),
    { stage: 'transcribing', minutes: 0, total: 2 },
  );
  assert.deepEqual(notes.at(-1), { stage: 'transcribing', minutes: 1, total: 2 });
  assert.equal(existsSync(folder), false, 'the downloaded audio is deleted');
  assert.match(videoPromptBlock([reading]), /内容来源：PugPort 在本机把视频音频转写成的文字/);
});

test('reader: long videos are transcribed up to the cap and say so', async (t) => {
  let decodeLimit = 0;
  const { video } = reader(t, {
    run: async (_command, args) => {
      if (args.includes('-J')) return JSON.stringify({ ...sample, duration: 4 * 3600 });
      writeFileSync(args[args.indexOf('-o') + 1]!.replace('%(ext)s', 'webm'), 'x');
      return '';
    },
    samples: async function* (_ffmpeg, _file, maxSeconds) {
      decodeLimit = maxSeconds;
      yield new Float32Array(30 * 16000);
    },
    transcribe: async () => 'synthetic words',
  });
  const reading = await video.read(videoLinks('https://youtu.be/ddddddddddd')[0]!, {
    signal: new AbortController().signal,
  });
  assert.equal(decodeLimit, transcriptionCapSeconds);
  assert.match(videoPromptBlock([reading]), /只转写了前 0:30，后面没有转写/);
});

test('reader: falls back to title and description with the exact reason', async (t) => {
  const signal = new AbortController().signal;
  const link = videoLinks('https://youtu.be/eeeeeeeeeee')[0]!;
  const missing = await reader(t, { ytDlp: undefined }).video.read(link, { signal });
  assert.equal(missing.source, 'description');
  assert.deepEqual(missing.reasons, ['这台电脑没有安装 yt-dlp，读不到视频的字幕和音频']);

  const metadata = async () => JSON.stringify(sample);
  const noVoice = await reader(t, { run: metadata, voiceReady: false }).video.read(link, { signal });
  assert.deepEqual(noVoice.reasons, [
    '这个视频没有可用字幕（B 站的 AI 字幕要登录才能读）',
    '没有安装「视频转写」组件，无法自己转写音频',
  ]);
  const block = videoPromptBlock([noVoice]);
  assert.match(block, /内容来源：只有标题和简介，没有拿到正片内容。原因：这个视频没有可用字幕/);
  assert.match(block, /简介：Synthetic description\./);

  const failing = await reader(t, {
    run: async (_command, args) => {
      if (args.includes('-J')) return JSON.stringify(sample);
      throw new Error('ERROR: [synthetic] HTTP Error 403: Forbidden\nmore');
    },
  }).video.read(link, { signal });
  assert.equal(failing.source, 'description');
  assert.equal(failing.reasons.at(-1), '音频转写失败（[synthetic] HTTP Error 403: Forbidden）');

  const unreadable = await reader(t, {
    run: async () => {
      throw new Error('ERROR: Unsupported URL');
    },
  }).video.read(link, { signal });
  assert.deepEqual(unreadable.reasons, ['yt-dlp 读不到这个视频（Unsupported URL）']);
});

test('reader: stopping the task stops the download instead of falling back', async (t) => {
  const stop = new AbortController();
  const { video } = reader(t, {
    run: async (_command, args) => {
      if (args.includes('-J')) return JSON.stringify(sample);
      stop.abort(new Error('stopped'));
      throw new Error('killed');
    },
  });
  await assert.rejects(video.read(videoLinks('https://youtu.be/fffffffffff')[0]!, { signal: stop.signal }), /stopped/);
});

test('long transcripts keep every section, excerpted evenly within the budget', () => {
  const cues = Array.from({ length: 24 }, (_, index) => ({
    start: index * 300,
    text: `段${index}`.padEnd(8000, '字'),
  }));
  const block = videoPromptBlock([
    {
      url: 'https://youtu.be/x',
      title: 'Long',
      description: '',
      durationSeconds: 7200,
      source: 'subtitles',
      language: 'en',
      automatic: true,
      cues,
      reasons: [],
    },
  ]);
  assert.ok(block.length < 70_000, `prompt block too long: ${block.length}`);
  assert.match(block, /正文（视频较长，按时间段均匀节选）/);
  assert.match(block, /\[1:55:00–2:00:00\] 段23/);
  assert.match(block, /平台自动生成，语言 en/);
});

test('a message with a video link reaches the executor with the video text and status notes', async (t) => {
  const f = fixture(t, false);
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    return result('completed', 'Synthetic reply.');
  });
  const caches: string[] = [];
  const shown: Array<string | undefined> = [];
  t.mock.method(
    f.workspace.videoReader,
    'read',
    async (link: { url: string }, options: { progress?: (step: VideoProgress) => void; cache?: boolean }) => {
      options.progress?.({ stage: 'transcribing', minutes: 3, total: 21 });
      shown.push([...f.workspace['active'].values()].at(-1)?.workflow.scheduling?.reason);
      caches.push(String(options.cache));
      return {
        url: link.url,
        title: '合成标题',
        description: '',
        source: 'subtitles',
        language: 'zh',
        automatic: true,
        cues: [{ start: 0, text: '合成视频正文' }],
        reasons: [],
      };
    },
  );
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const sent = await f.workspace.send(conversation.id, {
    ...input,
    mode: 'chat',
    permissionMode: 'read-only',
    runtimeId: 'mock',
    content: 'bilibili.com/video/BV1G4xL6cEEw\n这个讲的是什么？',
  });
  assert.equal((await finished(f.workspace, sent.workflow.id)).status, 'completed');
  const prompt = calls.at(-1)!.input.prompt;
  assert.match(prompt, /<视频内容 链接="https:\/\/bilibili\.com\/video\/BV1G4xL6cEEw">/);
  assert.match(prompt, /内容来源：字幕（平台自动生成，语言 zh）/);
  assert.match(prompt, /\[0:00–5:00\] 合成视频正文/);
  assert.ok(prompt.indexOf('<视频内容') < prompt.indexOf('<用户当前问题>'));
  assert.deepEqual(caches, ['true']);
  assert.deepEqual(shown, ['正在本机转写视频语音：3/21 分钟']);

  const offline = await f.workspace.send(conversation.id, {
    ...input,
    mode: 'chat',
    permissionMode: 'read-only',
    runtimeId: 'mock',
    content: 'https://youtu.be/abcdefghijk 不要联网，只凭记忆说说',
  });
  assert.equal((await finished(f.workspace, offline.workflow.id)).status, 'completed');
  assert.equal(caches.length, 1, 'a message that forbids going online reads no video');
  assert.doesNotMatch(calls.at(-1)!.input.prompt, /<视频内容/);
});
