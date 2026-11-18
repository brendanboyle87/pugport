// Fetches the local speech-recognition model for voice input: the original SenseVoiceSmall (Chinese, English, Japanese, Korean,
// Cantonese; with punctuation) in the int8 build published by sherpa-onnx. The model uses the FunASR model
// license; the sherpa-onnx engine uses Apache-2.0. See THIRD_PARTY_NOTICES.md. Pinned by SHA-256 and stored
// in the configured runtime directory; audio recognition stays on this computer.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeRoot } from './runtime-paths.mjs';
import {
  downloadVerifiedFile,
  reportProgress,
  validateArchiveEntries,
  validateArchiveTypes,
} from './model-download.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(runtimeRoot(root), 'voice', 'sense-voice');
const name = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17';
const url = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${name}.tar.bz2`;
const sha256 = '7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e';

if (existsSync(join(target, 'model.int8.onnx')) && existsSync(join(target, 'tokens.txt'))) {
  console.log('Voice model is ready.');
  process.exit(0);
}
// Staging on the target volume keeps publication atomic even when TEMP is on C:
// and the chosen runtime directory is on another disk.
mkdirSync(dirname(target), { recursive: true });
const scratch = mkdtempSync(join(dirname(target), '.voice-install-'));
try {
  const archive = join(scratch, `${name}.tar.bz2`);
  await downloadVerifiedFile(archive, [url], sha256);
  const tar =
    process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const listed = spawnSync(tar, ['-tjf', archive], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  if (listed.status !== 0) throw new Error('Could not inspect the voice model archive.');
  const entries = listed.stdout.split(/\r?\n/).filter(Boolean);
  validateArchiveEntries(entries);
  const types = spawnSync(tar, ['-tvjf', archive], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  if (types.status !== 0) throw new Error('Could not inspect voice model file types.');
  validateArchiveTypes(types.stdout);
  // Extract only model data and accompanying notices from this verified archive.
  const required = ['model.int8.onnx', 'tokens.txt'].map((file) => `${name}/${file}`);
  if (!required.every((file) => entries.includes(file))) throw new Error('Incomplete voice model archive.');
  const selected = [
    ...required,
    ...entries.filter(
      (file) => file.startsWith(`${name}/`) && file.split('/').length === 2 && /(?:license|readme)/i.test(file),
    ),
  ];
  reportProgress('installing', '正在解压语音模型。');
  const unpacked = spawnSync(tar, ['-xjf', archive, '-C', scratch, ...selected], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
  });
  if (unpacked.status !== 0) throw new Error(`Could not unpack the voice model (${unpacked.stderr}).`);
  const folder = join(scratch, name);
  mkdirSync(target, { recursive: true });
  // Publish tokens first; model discovery only considers the component ready when both exist.
  for (const file of readdirSync(folder).sort(
    (a, b) => Number(a === 'model.int8.onnx') - Number(b === 'model.int8.onnx'),
  )) {
    const path = join(folder, file);
    if (statSync(path).isFile() && (/^(model\.int8\.onnx|tokens\.txt)$/.test(file) || /license|readme/i.test(file)))
      renameSync(path, join(target, file));
  }
  console.log('Voice model is ready.');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
