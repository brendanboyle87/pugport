// Fetches the local text-embedding model that finds earlier conversation by meaning: BAAI's bge-m3 (MIT), in
// the int8 ONNX build published by Xenova, with its tokenizer. Pinned by revision and SHA-256 and kept in
// .runtime/memory-search; nothing is installed on the system and conversations never leave the computer.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeRoot } from './runtime-paths.mjs';
import { downloadVerifiedFile } from './model-download.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(runtimeRoot(root), 'memory-search');
const [repository, revision] = ['Xenova/bge-m3', '4de13258303883538bd53b696b452bf8099f0858'];
// Hugging Face, then its public mirror for networks where it is slow or unreachable.
const hub = (path) =>
  ['https://huggingface.co', 'https://hf-mirror.com'].map(
    (host) => `${host}/${repository}/resolve/${revision}/${path}`,
  );
const files = [
  {
    name: 'model.onnx',
    urls: hub('onnx/model_quantized.onnx'),
    sha256: '0826f8c1ab9edf1801db86c61919d4d108e8bfc0b809ec823ad366882ff0b77d',
  },
  {
    name: 'tokenizer.json',
    urls: hub('tokenizer.json'),
    sha256: '6710678b12670bc442b99edc952c4d996ae309a7020c1fa0096dd245c2faf790',
  },
];

mkdirSync(target, { recursive: true });
for (const file of files) await downloadVerifiedFile(join(target, file.name), file.urls, file.sha256);
writeFileSync(
  join(target, 'README.txt'),
  [
    'bge-m3 (https://huggingface.co/BAAI/bge-m3), MIT License, by BAAI (Beijing Academy of Artificial Intelligence).',
    `ONNX weights and tokenizer: https://huggingface.co/${repository} (revision ${revision}), converted for Transformers.js.`,
    '',
  ].join('\n'),
);
console.log('Memory search model is ready.');
