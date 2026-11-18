import { IdleModel } from './idle-model.ts';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';

/*
 * Text embeddings for finding earlier conversation by meaning: BAAI's bge-m3 (MIT), in the int8 ONNX build
 * published by Xenova. Runs in the model worker thread. Its tokenizer is a SentencePiece unigram model
 * (XLM-RoBERTa); it is reproduced here from tokenizer.json, with NFKC standing in for SentencePiece's
 * precompiled normalization table, which only matters for rare characters.
 */

export const embeddingSize = 1024;

type Tokenizer = { pieces: Map<string, { id: number; score: number }>; longest: number; unknownScore: number };
let tokenizer: { dir: string; value: Tokenizer } | undefined;
function loadTokenizer(dir: string): Tokenizer {
  if (tokenizer?.dir !== dir) {
    const json = JSON.parse(readFileSync(join(dir, 'tokenizer.json'), 'utf8')) as {
      model: { vocab: Array<[string, number]> };
    };
    const pieces = new Map<string, { id: number; score: number }>();
    let longest = 1,
      lowest = 0;
    json.model.vocab.forEach(([piece, score], id) => {
      // The four control tokens are never produced from text.
      if (id < 4) return;
      pieces.set(piece, { id, score });
      longest = Math.max(longest, [...piece].length);
      lowest = Math.min(lowest, score);
    });
    tokenizer = { dir, value: { pieces, longest, unknownScore: lowest - 10 } };
  }
  return tokenizer.value;
}

const begin = 0,
  end = 2,
  unknown = 3,
  padding = 1;

/** Token ids for one text: <s> pieces… </s>, at most `maxLength` in all. */
export function encode(dir: string, text: string, maxLength = 256): number[] {
  const { pieces, longest, unknownScore } = loadTokenizer(dir);
  const normalized = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const ids: number[] = [begin];
  // Metaspace: every word starts with "▁"; the unigram model then splits each word by best total score.
  for (const word of normalized.split(' ').filter(Boolean)) {
    const chars = [...`▁${word}`];
    const best = new Array<number>(chars.length + 1).fill(-Infinity);
    const from = new Array<number>(chars.length + 1).fill(-1);
    const token = new Array<number>(chars.length + 1).fill(unknown);
    best[0] = 0;
    for (let i = 0; i < chars.length; i++) {
      if (best[i] === -Infinity) continue;
      let matched = false;
      for (let length = 1; length <= longest && i + length <= chars.length; length++) {
        const piece = pieces.get(chars.slice(i, i + length).join(''));
        if (!piece) continue;
        matched ||= length === 1;
        const score = best[i]! + piece.score;
        if (score > best[i + length]!) {
          best[i + length] = score;
          from[i + length] = i;
          token[i + length] = piece.id;
        }
      }
      // A character the vocabulary lacks becomes <unk>.
      if (!matched && best[i]! + unknownScore > best[i + 1]!) {
        best[i + 1] = best[i]! + unknownScore;
        from[i + 1] = i;
        token[i + 1] = unknown;
      }
    }
    const word_: number[] = [];
    for (let at = chars.length; at > 0; at = from[at]!) word_.push(token[at]!);
    for (const id of word_.reverse()) {
      // Consecutive unknown characters count as one <unk>, as in SentencePiece.
      if (id === unknown && ids.at(-1) === unknown) continue;
      ids.push(id);
    }
    if (ids.length >= maxLength - 1) break;
  }
  return [...ids.slice(0, maxLength - 1), end];
}

type Tensor = { data: Float32Array; dims: readonly number[] };
type Session = { release(): Promise<void>; run(feeds: Record<string, unknown>): Promise<Record<string, Tensor>> };
type Ort = {
  InferenceSession: { create(path: string, options: Record<string, unknown>): Promise<Session> };
  Tensor: new (type: string, data: unknown, dims: number[]) => unknown;
};
const sharedModel = new IdleModel<{ ort: Ort; session: Session }>(async (value) => {
  await value.session.release();
  tokenizer = undefined;
});
async function loadModel(dir: string) {
  const ort = createRequire(import.meta.url)('onnxruntime-node') as Ort;
  const session = await ort.InferenceSession.create(join(dir, 'model.onnx'), {
    executionProviders: ['cpu'],
    intraOpNumThreads: Math.max(2, Math.min(4, Math.floor(availableParallelism() / 4))),
    graphOptimizationLevel: 'all',
    logSeverityLevel: 3,
  });
  return { ort, session };
}

/**
 * Unit-length embeddings (the first token's state, as bge-m3 defines its dense vector), `texts.length` rows of
 * 1024. Indexing and questions share the CPU session; DirectML's compiled text graph used excessive RAM.
 */
export async function embedTexts(dir: string, texts: string[]): Promise<Float32Array> {
  return sharedModel.use(
    dir,
    () => loadModel(dir),
    async ({ ort, session: model }) => {
      const encoded = texts.map((text) => encode(dir, text));
      const out = new Float32Array(texts.length * embeddingSize);
      const batch = 8;
      for (let start = 0; start < encoded.length; start += batch) {
        const group = encoded.slice(start, start + batch);
        const rows = group.length;
        const length = Math.max(...group.map((ids) => ids.length));
        const ids = new BigInt64Array(rows * length).fill(BigInt(padding));
        const mask = new BigInt64Array(rows * length);
        group.forEach((tokens, row) =>
          tokens.forEach((id, column) => {
            ids[row * length + column] = BigInt(id);
            mask[row * length + column] = 1n;
          }),
        );
        const result = Object.values(
          await model.run({
            input_ids: new ort.Tensor('int64', ids, [rows, length]),
            attention_mask: new ort.Tensor('int64', mask, [rows, length]),
          }),
        )[0]!;
        group.forEach((_, row) => {
          const first = result.data.subarray(
            row * length * embeddingSize,
            row * length * embeddingSize + embeddingSize,
          );
          let norm = 0;
          for (const value of first) norm += value * value;
          norm = Math.sqrt(norm) || 1;
          out.set(
            first.map((value) => value / norm),
            (start + row) * embeddingSize,
          );
        });
      }
      return out;
    },
  );
}

/** Load without inference; the same serial lease serves prewarm, indexing, and questions. */
export function prewarmTexts(dir: string): Promise<void> {
  return sharedModel.use(
    dir,
    () => loadModel(dir),
    async () => {},
  );
}
