import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, sep } from 'node:path';
import sharp from 'sharp';

// The index goes to a scratch directory and nothing runs in the background.
const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'image-search-test-')));
process.env.COMBORUNNER_IMAGE_INDEX_DIR = join(scratch, 'index');
process.env.COMBORUNNER_IMAGE_BACKGROUND = '0';
const {
  connectImageSearch,
  dedupeFolders,
  differenceHash,
  findSimilarImages,
  foregroundBudget,
  hammingDistance,
  imageSearchNote,
  imageSearchTasks,
  pauseImageSearchTask,
  reloadImageSearches,
  resetImageIndex,
  resumeImageSearchTask,
  closeImageSearchTask,
  tokenize,
} = await import('../src/server/image-search.ts');
test.after(() => rmSync(scratch, { recursive: true, force: true }));

/** A deterministic picture full of corners and edges (random blocks), so keypoints have something to hold. */
async function picture(path: string, seed: number, width = 900, height = 700) {
  let state = seed;
  const random = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pixels = Buffer.alloc(width * height * 3);
  const block = 18;
  for (let by = 0; by < height; by += block)
    for (let bx = 0; bx < width; bx += block) {
      const colour = [random() * 255, random() * 255, random() * 255];
      for (let y = by; y < Math.min(by + block, height); y++)
        for (let x = bx; x < Math.min(bx + block, width); x++)
          for (let c = 0; c < 3; c++) pixels[(y * width + x) * 3 + c] = colour[c]!;
    }
  await sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toFile(path);
}

test('difference hashes survive resizing and recompression but tell different pictures apart', async () => {
  const folder = join(scratch, 'hash');
  mkdirSync(folder, { recursive: true });
  await picture(join(folder, 'a.png'), 1);
  await picture(join(folder, 'b.png'), 2);
  await sharp(join(folder, 'a.png')).resize(450).jpeg({ quality: 60 }).toFile(join(folder, 'a-small.jpg'));
  const hash = async (name: string) => {
    const { data } = await sharp(join(folder, name))
      .removeAlpha()
      .resize(224, 224, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return differenceHash(data);
  };
  assert.ok(hammingDistance(await hash('a.png'), await hash('a-small.jpg')) <= 6);
  assert.ok(hammingDistance(await hash('a.png'), await hash('b.png')) > 16);
  assert.equal(hammingDistance('ffffffffffffffff', '0000000000000000'), 64);
});

test('descriptions are tokenized the BERT way: each Chinese character alone, words by WordPiece', () => {
  const vocab = new Map(
    ['[PAD]', '[UNK]', '[CLS]', '[SEP]', '游', '戏', '截', '图', 'game', '##s', 'screen', '##shot'].map(
      (token, index) => [token, index] as const,
    ),
  );
  assert.deepEqual(tokenize('游戏截图', vocab), [2, 4, 5, 6, 7, 3]);
  assert.deepEqual(tokenize('Games screenshot', vocab), [2, 8, 9, 10, 11, 3]);
  assert.deepEqual(tokenize('未知', vocab), [2, 1, 1, 3]);
  assert.equal(tokenize('游'.repeat(80), vocab).length, 52);
});

test('nested folders are searched once', () => {
  const photos = join(scratch, 'Photos'),
    shots = join(scratch, 'Shots'),
    photos2 = join(scratch, 'Photos2');
  assert.deepEqual(
    dedupeFolders([join(photos, '2024'), photos, shots, photos2]).sort(),
    [photos, shots, photos2].sort(),
  );
  assert.deepEqual(dedupeFolders([photos + sep, join(photos, '2024', '..'), photos]), [photos]);
  assert.deepEqual(dedupeFolders([join(photos, '2024'), photos, parse(scratch).root]), [parse(scratch).root]);
});

test('folder deduplication follows native path case semantics', () => {
  const upper = join(scratch, 'Photos'),
    lower = join(scratch, 'photos');
  assert.deepEqual(dedupeFolders([upper, lower]), process.platform === 'win32' ? [upper] : [upper, lower]);
  assert.deepEqual(
    dedupeFolders([upper, join(lower, '2024')]),
    process.platform === 'win32' ? [upper] : [upper, join(lower, '2024')],
  );
});

test('a copy, a resized copy and the source of a partial screenshot are found and grouped', async () => {
  resetImageIndex();
  const folder = join(scratch, 'library');
  mkdirSync(join(folder, 'games'), { recursive: true });
  mkdirSync(join(folder, 'other'), { recursive: true });
  const original = join(folder, 'games', 'boss-fight.png');
  await picture(original, 7, 1200, 900);
  copyFileSync(original, join(folder, 'other', 'boss-fight-copy.png'));
  await sharp(original)
    .resize(600)
    .jpeg({ quality: 70 })
    .toFile(join(folder, 'other', 'boss-fight-small.jpg'));
  await picture(join(folder, 'other', 'unrelated.png'), 99, 1000, 800);
  // The query: a corner region of the original, captured at 80% size, kept outside the searched folder.
  const crop = join(scratch, 'crop.png');
  await sharp(original).extract({ left: 600, top: 420, width: 420, height: 320 }).resize(336).png().toFile(crop);
  // No model in this app root: exact, near-duplicate and keypoint layers still work.
  const app = join(scratch, 'app');
  mkdirSync(app, { recursive: true });

  const whole = await findSimilarImages({ image: original, folders: [folder] }, app);
  assert.match(whole, /完全相同的文件（1）：\n- .*boss-fight-copy\.png/);
  assert.match(whole, /几乎一样的图片.*\n- .*boss-fight-small\.jpg/);
  assert.doesNotMatch(whole, /unrelated\.png/);
  assert.match(whole, /内容相似需要先安装「图片搜索与识字」组件/);

  const partial = await findSimilarImages({ image: crop, folders: [folder] }, app);
  const section = partial.split('包含这张截图内容的图片')[1] ?? '';
  assert.match(section, /games[\\/]boss-fight\.png（\d+ 个特征点吻合，基本确定）/);
  assert.doesNotMatch(section, /unrelated\.png/);

  await assert.rejects(
    findSimilarImages({ text: '游戏截图', folders: [folder] }, app),
    /需要先安装「图片搜索与识字」组件/,
  );
  await assert.rejects(findSimilarImages({ image: 'relative.png' }, app), /完整路径/);
  await assert.rejects(findSimilarImages({ image: crop, folders: [join(scratch, 'missing')] }, app), /文件夹不存在/);
});

test('a search that cannot finish in time continues as a background task and posts its result', async () => {
  resetImageIndex();
  const folder = join(scratch, 'later');
  mkdirSync(folder, { recursive: true });
  const original = join(folder, 'map.png');
  await picture(original, 11, 1000, 800);
  await sharp(original).resize(500).jpeg({ quality: 70 }).toFile(join(folder, 'map-small.jpg'));
  const app = join(scratch, 'app');
  mkdirSync(app, { recursive: true });
  const delivered: Array<{ conversationId: string; text: string }> = [];
  let changes = 0;
  let finished!: () => void;
  const done = new Promise<void>((resolve) => (finished = resolve));
  connectImageSearch({
    deliver: (conversationId, text) => {
      delivered.push({ conversationId, text });
      finished();
    },
    changed: () => changes++,
  });
  // No time at all in the foreground: nothing is indexed before the executor gets its answer.
  const saved = { ...foregroundBudget.withBackground };
  foregroundBudget.withBackground = { analyze: 0, match: 0 };
  try {
    const first = await findSimilarImages({ image: original, folders: [folder] }, app, undefined, {
      conversationId: 'conversation-1',
    });
    assert.match(first, /剩下的分析已转为后台任务/);
    assert.match(first, /不要让用户过一会儿再来问/);
    const [task] = imageSearchTasks();
    assert.equal(task?.conversationId, 'conversation-1');
    assert.equal(task?.title, '后台找图');
    await done;
  } finally {
    foregroundBudget.withBackground = saved;
  }
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]!.conversationId, 'conversation-1');
  assert.match(delivered[0]!.text, /^后台找图已完成：“map\.png”/);
  assert.match(delivered[0]!.text, /\*\*几乎一样的图片.*\*\*\n- .*map-small\.jpg/);
  // The task is gone once its result is posted, and the interface heard about both changes.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(imageSearchTasks(), []);
  assert.ok(changes >= 2);
});

test('the background task bar shows this conversation only: stop and close while running, continue when paused', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { BackgroundTasks } = await import('../src/ui/BackgroundTasks.tsx');
  const task = (id: string, conversationId: string) => ({
    id,
    conversationId,
    title: '后台找图',
    detail: '正在分析图片',
    done: 3214,
    total: 13649,
    startedAt: new Date().toISOString(),
    folders: ['D:\\BaiduNetdiskDownload'],
    previewUrl: '/api/conversations/here/attachments/x/content',
  });
  const html = renderToStaticMarkup(
    createElement(BackgroundTasks, {
      tasks: [task('a', 'here'), task('b', 'elsewhere')],
      conversationId: 'here',
      onPause: () => undefined,
      onResume: () => undefined,
      onClose: () => undefined,
    }),
  );
  assert.equal((html.match(/class="background-task"/g) ?? []).length, 1);
  assert.match(html, /后台找图/);
  const visibleText = (markup: string) => markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  assert.match(visibleText(html), /正在分析图片 3,214 \/ 13,649/);
  assert.match(html, /width:24%/);
  assert.match(html, /停止<\/button>/);
  assert.match(html, /关闭<\/button>/);
  assert.doesNotMatch(html, /继续<\/button>/);
  assert.match(html, /搜索范围/);
  const paused = renderToStaticMarkup(
    createElement(BackgroundTasks, {
      tasks: [{ ...task('a', 'here'), state: 'paused' as const, detail: '已中断' }],
      conversationId: 'here',
      onPause: () => undefined,
      onResume: () => undefined,
      onClose: () => undefined,
    }),
  );
  assert.match(paused, /class="background-task paused"/);
  assert.match(visibleText(paused), /已中断 3,214 \/ 13,649/);
  assert.match(paused, /继续<\/button>/);
  assert.match(paused, /关闭<\/button>/);
  assert.doesNotMatch(paused, /停止<\/button>/);
  const none = { tasks: [], conversationId: 'here', onPause: () => {}, onResume: () => {}, onClose: () => {} };
  assert.equal(renderToStaticMarkup(createElement(BackgroundTasks, none)), '');
});

test('narrowing a running search keeps its progress and continues only inside the new folders', async () => {
  resetImageIndex();
  const root = join(scratch, 'narrow');
  const keep = join(root, 'keep'),
    drop = join(root, 'drop');
  mkdirSync(keep, { recursive: true });
  mkdirSync(drop, { recursive: true });
  const original = join(keep, 'castle.png');
  await picture(original, 21, 1000, 800);
  await sharp(original).resize(500).jpeg({ quality: 70 }).toFile(join(keep, 'castle-small.jpg'));
  for (let i = 0; i < 6; i++) await picture(join(drop, `other-${i}.png`), 100 + i, 600, 500);
  const app = join(scratch, 'app');
  mkdirSync(app, { recursive: true });
  const delivered: string[] = [];
  let finished!: () => void;
  const done = new Promise<void>((resolve) => (finished = resolve));
  connectImageSearch({
    deliver: (_, text) => {
      delivered.push(text);
      finished();
    },
    changed: () => undefined,
  });
  const saved = { ...foregroundBudget.withBackground };
  foregroundBudget.withBackground = { analyze: 0, match: 0 };
  try {
    await findSimilarImages({ image: original, folders: [root] }, app, undefined, { conversationId: 'narrow-1' });
    const [running] = imageSearchTasks();
    assert.deepEqual(running?.folders, [root]);
    assert.match(imageSearchNote('narrow-1'), /正在后台找图/);
    assert.match(imageSearchNote('narrow-1'), /不用再传 image/);
    // "Only in keep": no picture is named, the folder lies inside the running scope.
    const narrowed = await findSimilarImages({ folders: [keep] }, app, undefined, { conversationId: 'narrow-1' });
    assert.match(narrowed, /正在进行的后台找图已收窄到/);
    assert.match(narrowed, /不会重新开始/);
    const [same] = imageSearchTasks();
    assert.equal(same?.id, running?.id, 'the running task continues; it is not restarted');
    assert.deepEqual(same?.folders, [keep]);
    await done;
  } finally {
    foregroundBudget.withBackground = saved;
  }
  assert.equal(delivered.length, 1);
  assert.match(delivered[0]!, /castle-small\.jpg/);
  assert.doesNotMatch(delivered[0]!, /other-\d\.png/);
  assert.match(delivered[0]!, new RegExp(`搜索范围：\`${keep.replace(/\\/g, '\\\\')}\``));
});

test('stop pauses a search and keeps it; a restart shows it interrupted; continue resumes; close ends it', async () => {
  resetImageIndex();
  const folder = join(scratch, 'pause');
  mkdirSync(folder, { recursive: true });
  const original = join(folder, 'tower.png');
  await picture(original, 31, 1000, 800);
  for (let i = 0; i < 8; i++) await picture(join(folder, `noise-${i}.png`), 200 + i, 700, 600);
  await sharp(original).resize(450).jpeg({ quality: 70 }).toFile(join(folder, 'tower-small.jpg'));
  const app = join(scratch, 'app');
  mkdirSync(app, { recursive: true });
  const delivered: string[] = [];
  let finished!: () => void;
  const done = new Promise<void>((resolve) => (finished = resolve));
  connectImageSearch({
    appRoot: app,
    deliver: (_, text) => {
      delivered.push(text);
      finished();
    },
    changed: () => undefined,
  });
  const saved = { ...foregroundBudget.withBackground };
  foregroundBudget.withBackground = { analyze: 0, match: 0 };
  try {
    await findSimilarImages({ image: original, folders: [folder] }, app, undefined, { conversationId: 'pause-1' });
    const [running] = imageSearchTasks();
    assert.equal(running?.state, 'running');
    assert.ok(pauseImageSearchTask(running!.id));
    const [paused] = imageSearchTasks();
    assert.equal(paused?.state, 'paused');
    assert.equal(paused?.detail, '已暂停');
    assert.equal(paused?.id, running!.id);

    // As after a restart: the saved search comes back, still paused, and the note tells the next executor.
    reloadImageSearches();
    const [restored] = imageSearchTasks();
    assert.equal(restored?.id, running!.id);
    assert.equal(restored?.state, 'paused');
    assert.match(imageSearchNote('pause-1'), /暂停的后台找图/);
    assert.match(imageSearchNote('pause-1'), /不用再传 image/);

    assert.ok(resumeImageSearchTask(restored!.id));
    assert.equal(imageSearchTasks()[0]?.state, 'running');
    await done;
  } finally {
    foregroundBudget.withBackground = saved;
  }
  assert.equal(delivered.length, 1);
  assert.match(delivered[0]!, /tower-small\.jpg/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(imageSearchTasks(), [], 'a finished search leaves no task behind');

  // "Keep looking" without a picture reuses the conversation's last one; close ends that task for good.
  foregroundBudget.withBackground = { analyze: 0, match: 0 };
  try {
    const again = await findSimilarImages({}, app, undefined, { conversationId: 'pause-1' });
    assert.match(again, new RegExp(`参考图片：${original.replace(/\\/g, '\\\\')}`));
  } finally {
    foregroundBudget.withBackground = saved;
  }
  const task = imageSearchTasks()[0];
  if (task) {
    assert.ok(closeImageSearchTask(task.id));
    assert.deepEqual(imageSearchTasks(), []);
  }
});

test('quitting the app while a search runs keeps it, shown as interrupted next time', async () => {
  resetImageIndex();
  const { stopImageBackground } = await import('../src/server/image-search.ts');
  const folder = join(scratch, 'quit');
  mkdirSync(folder, { recursive: true });
  const original = join(folder, 'bridge.png');
  await picture(original, 41, 900, 700);
  for (let i = 0; i < 10; i++) await picture(join(folder, `filler-${i}.png`), 300 + i, 800, 600);
  const app = join(scratch, 'app');
  mkdirSync(app, { recursive: true });
  connectImageSearch({ appRoot: app, deliver: () => undefined, changed: () => undefined });
  const saved = { ...foregroundBudget.withBackground };
  foregroundBudget.withBackground = { analyze: 0, match: 0 };
  try {
    await findSimilarImages({ image: original, folders: [folder] }, app, undefined, { conversationId: 'quit-1' });
  } finally {
    foregroundBudget.withBackground = saved;
  }
  const [running] = imageSearchTasks();
  assert.equal(running?.state, 'running');
  stopImageBackground();
  reloadImageSearches();
  const [restored] = imageSearchTasks().filter((task) => task.conversationId === 'quit-1');
  assert.equal(restored?.id, running!.id);
  assert.equal(restored?.state, 'paused');
  assert.equal(restored?.detail, '已中断');
  assert.ok(closeImageSearchTask(restored!.id));
});
