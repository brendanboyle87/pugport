import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';

// All image inputs and caches are synthetic. This script never opens personal pictures.
const scratch = await mkdtemp(join(tmpdir(), 'image-latency-'));
process.env.COMBORUNNER_DATA_DIR = scratch;
process.env.COMBORUNNER_IMAGE_INDEX_DIR = join(scratch, 'image-index');
process.env.COMBORUNNER_MEMORY_VECTORS_DIR = join(scratch, 'vectors');
process.env.COMBORUNNER_IMAGE_BACKGROUND = '0';
const sourceRoot = resolve(process.argv[2] || '.');
const { pathToFileURL } = await import('node:url');
const memoryFlag = process.argv.indexOf('--memory');
if (memoryFlag >= 0) {
  const databasePath = resolve(process.argv[memoryFlag + 1]!);
  if (!databasePath.startsWith(resolve(tmpdir()))) throw new Error('Use only a completed temporary database copy.');
  const { DatabaseSync } = await import('node:sqlite');
  const { WorkspaceStore } = await import(pathToFileURL(join(sourceRoot, 'src/server/workspace-store.ts')).href);
  let memoryModule = pathToFileURL(join(sourceRoot, 'src/server/memory-vectors.ts')).href;
  if (process.argv.includes('--baseline-memory')) {
    const { execFileSync } = await import('node:child_process');
    const oldSource = execFileSync('git', ['show', '22d95fc9:src/server/memory-vectors.ts'], {
      cwd: sourceRoot,
      encoding: 'utf8',
    });
    const source = oldSource.replace(
      /from '(\.[^']+)'/g,
      (_, relativePath: string) => `from '${pathToFileURL(resolve(sourceRoot, 'src/server', relativePath)).href}'`,
    );
    const baseline = join(scratch, 'memory-vectors-baseline.ts');
    await writeFile(baseline, source);
    memoryModule = pathToFileURL(baseline).href;
  }
  const { indexMemory } = await import(memoryModule);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  const store = new WorkspaceStore(db, { initialize: false, recoverInterrupted: false });
  const row = db
    .prepare(
      "SELECT c.owner AS projectId,count(*) AS n FROM workspace_records m JOIN workspace_records c ON c.kind='conversation' AND c.id=m.owner JOIN workspace_records p ON p.kind='project' AND p.id=c.owner WHERE m.kind='message' AND json_extract(p.value,'$.removedAt') IS NULL GROUP BY c.owner ORDER BY n DESC LIMIT 1",
    )
    .get() as { projectId: string; n: number };
  const modelRoot = join(scratch, 'application');
  const model = join(modelRoot, '.runtime', 'memory-search');
  await mkdir(model, { recursive: true });
  await writeFile(join(model, 'model.onnx'), 'synthetic-no-inference');
  await writeFile(join(model, 'tokenizer.json'), '{}');
  let previous = performance.now(),
    maximum = 0,
    samples = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maximum = Math.max(maximum, now - previous - 5);
    previous = now;
    samples++;
  }, 5);
  await new Promise((done) => setTimeout(done, 30));
  const started = performance.now();
  const remaining = await indexMemory(modelRoot, store, row.projectId, { until: 0 });
  await new Promise((done) => setTimeout(done, 30));
  clearInterval(timer);
  db.close();
  const report = {
    mode: 'memory',
    sourceRoot,
    scratch,
    databasePath,
    projectMessageCount: row.n,
    remaining,
    elapsedMs: Math.round(performance.now() - started),
    maxEventLoopDelayMs: Number(maximum.toFixed(2)),
    samples,
    inference: false,
  };
  await writeFile(join(scratch, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
const image = await import(pathToFileURL(join(sourceRoot, 'src/server/image-search.ts')).href);
const pictures = join(scratch, 'Pictures');
const noModels = join(scratch, 'application');
await mkdir(pictures);
await mkdir(noModels);
const count = 320;
for (let i = 0; i < count; i++) {
  const width = 256;
  const rgb = Buffer.alloc(width * width * 3);
  let state = i + 1;
  for (let p = 0; p < rgb.length; p++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    rgb[p] = state >>> 24;
  }
  const output = sharp(rgb, { raw: { width, height: width, channels: 3 } });
  await (i % 2 ? output.jpeg({ quality: 90 }) : output.png()).toFile(join(pictures, `${i}.${i % 2 ? 'jpg' : 'png'}`));
}
// A crop exercises the real ORB query/match path rather than only exact-file matching.
const reference = join(scratch, 'reference.png');
await sharp(join(pictures, '0.png')).extract({ left: 20, top: 20, width: 180, height: 180 }).png().toFile(reference);
const metadataEntries = process.argv.includes('--metadata') ? 60_000 : 0;
if (metadataEntries) {
  await mkdir(process.env.COMBORUNNER_IMAGE_INDEX_DIR!, { recursive: true });
  await writeFile(join(process.env.COMBORUNNER_IMAGE_INDEX_DIR!, 'vectors.bin'), new Int8Array(metadataEntries * 512));
  await writeFile(
    join(process.env.COMBORUNNER_IMAGE_INDEX_DIR!, 'index.json'),
    JSON.stringify({
      version: 1,
      folders: [pictures],
      entries: Array.from({ length: metadataEntries }, (_, v) => ({
        path: join(pictures, `metadata-${v}.png`),
        size: 4096,
        mtime: 1,
        v,
        hash: '0123456789abcdef',
        text: 'Synthetic OCR text. '.repeat(60),
      })),
    }),
  );
}
image.foregroundBudget.alone = { analyze: 120_000, match: 10_000 };
let previous = performance.now();
let maximum = 0;
let samples = 0;
const timer = setInterval(() => {
  const now = performance.now();
  maximum = Math.max(maximum, now - previous - 5);
  previous = now;
  samples++;
}, 5);
await new Promise((done) => setTimeout(done, 30));
const started = performance.now();
let result = '';
try {
  result = await image.findSimilarImages({ image: reference, folders: [pictures] }, noModels);
  await new Promise((done) => setTimeout(done, 30));
} finally {
  clearInterval(timer);
  image.stopImageBackground();
}
const report = {
  sourceRoot,
  scratch,
  images: count,
  metadataEntries,
  formats: ['PNG', 'JPG'],
  dimensions: [256, 256],
  matchBudgetMs: 10_000,
  elapsedMs: Math.round(performance.now() - started),
  maxEventLoopDelayMs: Number(maximum.toFixed(2)),
  samples,
  result,
};
await writeFile(join(scratch, 'result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
