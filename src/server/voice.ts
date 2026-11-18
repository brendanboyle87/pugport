import './platform/under-test.ts';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { cleanDictation } from '../shared/voice-cleanup.ts';
import { runtimeDirectories } from '../../scripts/runtime-paths.mjs';

/** Local recognition for video transcription and Mods' live voice. */

const sampleRate = 16000;
const maxSeconds = 300;

export function voiceModelDirectory(appRoot: string): string | undefined {
  // Development keeps it in .runtime/voice; a packaged app in resources/voice.
  return runtimeDirectories(appRoot, join('voice', 'sense-voice')).find(
    (dir) => existsSync(join(dir, 'model.int8.onnx')) && existsSync(join(dir, 'tokens.txt')),
  );
}

type Recognizer = {
  createStream(): { acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void };
  decodeAsync(stream: unknown): Promise<{ text?: string }>;
};
let recognizer: Promise<Recognizer> | undefined;
let transcriptions = 0;
export const voiceInUse = () => transcriptions > 0;
export function releaseVoice() {
  recognizer = undefined;
}
function loadRecognizer(appRoot: string): Promise<Recognizer> {
  const dir = voiceModelDirectory(appRoot);
  if (!dir) return Promise.reject(new Error('请先安装「视频转写」组件。'));
  recognizer ??= (async () => {
    const sherpa = createRequire(import.meta.url)('sherpa-onnx-node') as {
      OfflineRecognizer: { createAsync(config: unknown): Promise<Recognizer> };
    };
    return sherpa.OfflineRecognizer.createAsync({
      featConfig: { sampleRate, featureDim: 80 },
      modelConfig: {
        senseVoice: { model: join(dir, 'model.int8.onnx'), language: 'auto', useInverseTextNormalization: 1 },
        tokens: join(dir, 'tokens.txt'),
        numThreads: Math.max(2, Math.min(4, availableParallelism() - 1)),
        provider: 'cpu',
        debug: 0,
      },
    });
  })().catch((error) => {
    recognizer = undefined;
    throw error;
  });
  return recognizer;
}

/** Starts loading the model in the background (on the first recording), so it is ready when speech ends. */
export function preloadVoice(appRoot: string) {
  if (voiceModelDirectory(appRoot)) void loadRecognizer(appRoot).catch(() => undefined);
}

export async function transcribe(appRoot: string, samples: Float32Array): Promise<string> {
  if (!samples.length) return '';
  transcriptions++;
  try {
    const model = await loadRecognizer(appRoot);
    const stream = model.createStream();
    stream.acceptWaveform({ samples, sampleRate });
    const result = await model.decodeAsync(stream);
    return (result.text ?? '').trim();
  } finally {
    transcriptions--;
  }
}

/** Audio arrives in chunks while the user speaks; the text so far is decoded again now and then. */
type Session = {
  chunks: Float32Array[];
  length: number;
  touched: number;
  partialAt: number;
  /** How long the last preview took; previews never overlap and space out as the recording grows. */
  partialCost: number;
  decoding: boolean;
};
const sessions = new Map<string, Session>();
const sweep = () => {
  for (const [id, session] of sessions) if (Date.now() - session.touched > 10 * 60_000) sessions.delete(id);
};

export function startVoiceSession(): string {
  sweep();
  const id = randomUUID();
  sessions.set(id, { chunks: [], length: 0, touched: Date.now(), partialAt: 0, partialCost: 0, decoding: false });
  return id;
}

function joined(session: Session): Float32Array {
  const all = new Float32Array(session.length);
  let offset = 0;
  for (const chunk of session.chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  session.chunks = [all];
  return all;
}

/** Adds a chunk (16 kHz mono float32); about once a second returns the text recognised so far. */
export async function addVoiceAudio(appRoot: string, id: string, bytes: Buffer): Promise<{ text?: string }> {
  const session = sessions.get(id);
  if (!session) throw new Error('录音已结束，请重新开始。');
  const samples = new Float32Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength - (bytes.byteLength % 4)),
  );
  if (session.length + samples.length > maxSeconds * sampleRate) throw new Error('单次录音最长 5 分钟。');
  session.chunks.push(samples);
  session.length += samples.length;
  session.touched = Date.now();
  if (session.decoding || Date.now() - session.partialAt < Math.max(900, Math.min(session.partialCost, 1500) * 2))
    return {};
  session.decoding = true;
  const started = Date.now();
  try {
    return { text: cleanDictation(await transcribe(appRoot, joined(session))) };
  } finally {
    session.decoding = false;
    session.partialAt = Date.now();
    session.partialCost = Date.now() - started;
  }
}

export function cancelVoiceSession(id: string) {
  sessions.delete(id);
}

/** Ends a Mod recording and returns its locally recognized text. */
export async function finishVoiceSession(appRoot: string, id: string): Promise<{ text: string }> {
  const session = sessions.get(id);
  sessions.delete(id);
  if (!session) throw new Error('录音已结束，请重新开始。');
  return { text: cleanDictation(await transcribe(appRoot, joined(session))) };
}
