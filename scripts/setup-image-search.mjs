// Fetches the local models for image search, pinned by revision and SHA-256 and kept in .runtime/image-search;
// nothing is installed on the system and pictures never leave the computer:
// - Chinese-CLIP ViT-B/16 (OFA-Sys, MIT), int8 ONNX build published by Xenova for Transformers.js: what a
//   picture shows, and pictures matching a description;
// - PaddleOCR PP-OCRv4 detection and recognition (Apache-2.0), ONNX builds published by RapidOCR, with
//   PaddleOCR's character list: the text in screenshots and documents.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeRoot } from './runtime-paths.mjs';
import { downloadVerifiedFile } from './model-download.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(runtimeRoot(root), 'image-search');
// Hugging Face, then its public mirror for networks where it is slow or unreachable.
const hub = (repository, revision, path) =>
  ['https://huggingface.co', 'https://hf-mirror.com'].map(
    (host) => `${host}/${repository}/resolve/${revision}/${path}`,
  );
const clip = ['Xenova/chinese-clip-vit-base-patch16', 'f26904860903e70e050b8f48255e5f48401816e9'];
const rapid = ['SWHL/RapidOCR', '1cfba2e90fc938db55889873735088de210cc173'];
const paddle = '338ba3ee4a0208cee354cd3b7d2c93b320e0ea54';
const files = [
  {
    name: 'model.onnx',
    urls: hub(...clip, 'onnx/model_quantized.onnx'),
    sha256: 'a2c2849329eafb24100acec5a9421a39f8cb445296444c5c98855b69e5e7a751',
  },
  {
    name: 'vocab.txt',
    urls: hub(...clip, 'vocab.txt'),
    sha256: '45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c',
  },
  {
    name: 'ocr/det.onnx',
    urls: hub(...rapid, 'PP-OCRv4/ch_PP-OCRv4_det_infer.onnx'),
    sha256: 'd2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9',
  },
  {
    name: 'ocr/rec.onnx',
    urls: hub(...rapid, 'PP-OCRv4/ch_PP-OCRv4_rec_infer.onnx'),
    sha256: '48fc40f24f6d2a207a2b1091d3437eb3cc3eb6b676dc3ef9c37384005483683b',
  },
  {
    name: 'ocr/keys.txt',
    urls: [
      `https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/${paddle}/ppocr/utils/ppocr_keys_v1.txt`,
      `https://cdn.jsdelivr.net/gh/PaddlePaddle/PaddleOCR@${paddle}/ppocr/utils/ppocr_keys_v1.txt`,
    ],
    sha256: '28b2362ad4ab2dc38769aa72feb535e3a9ddb3fd2a7585a05920e6393b1dc7f7',
  },
];

mkdirSync(target, { recursive: true });
for (const file of files) await downloadVerifiedFile(join(target, file.name), file.urls, file.sha256);
writeFileSync(
  join(target, 'README.txt'),
  [
    'Chinese-CLIP ViT-B/16 (https://github.com/OFA-Sys/Chinese-CLIP), MIT License, by the OFA-Sys team.',
    `ONNX weights: https://huggingface.co/${clip[0]} (revision ${clip[1]}), converted for Transformers.js.`,
    `PP-OCRv4 (https://github.com/PaddlePaddle/PaddleOCR), Apache License 2.0, by PaddlePaddle; character list from commit ${paddle}.`,
    `ONNX builds: https://huggingface.co/${rapid[0]} (revision ${rapid[1]}), by RapidOCR (Apache License 2.0).`,
    '',
  ].join('\n'),
);
console.log('Image search models are ready.');
