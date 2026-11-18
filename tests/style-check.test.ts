import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  checkChapter,
  checkStyle,
  manuscriptCandidates,
  resolveBook,
  styleCheckLimits,
} from '../src/server/style-check.ts';

function resourceFixture(t: TestContext): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'style-limits-')));
  t.after(() => {
    assert.equal(dirname(root), realpathSync.native(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('each habit is counted in the narration, and short spoken lines are left alone', () => {
  const chapter = checkChapter(
    '第01章.txt',
    [
      '第01章 雪夜',
      '　　白不是雪。是月光照出来的。',
      '　　她不是在躲他，而是在躲那盏路灯。',
      '　　冷。手指冻得发红。台阶上有冰。她没停。门是锁的。',
      '　　他把地址抄下来。抄下来以后，他才敲门。',
      '　　她缓缓点头。',
      '　　「雪。」他说。「开门。」',
    ].join('\n'),
  );
  assert.equal(chapter.title, '第01章 雪夜');
  assert.equal(chapter.counts.selfAnswer, 1);
  assert.equal(chapter.counts.contrast, 1);
  assert.equal(chapter.counts.fragment, 1, 'only 「冷。」: the spoken 「雪。」 and 「开门。」 are dialogue');
  assert.equal(chapter.counts.staccato, 1);
  assert.equal(chapter.counts.echo, 1);
  assert.equal(chapter.counts.stock, 1);
  assert.match(chapter.examples.echo![0]!, /抄下来。抄下来以后/);
});

test('the book report names the worst habits, the recurring sentences and the chapters to rewrite', async (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'style-check-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '正文'));
  mkdirSync(join(root, '归档'));
  for (const number of [1, 2, 3])
    writeFileSync(
      join(root, '正文', `第0${number}章_标题.txt`),
      `第0${number}章 标题\n　　灯没有灭。白不是雪。是霜。他把窗推开。推开以后，风很大。林照说。\n　　她慢慢地走到桌前，把那张旧地图又摊开看了一遍，然后才坐下。`,
    );
  // Archived drafts and notes are not chapters of the book.
  writeFileSync(join(root, '归档', '第01章_旧稿.txt'), '第01章\n白不是雪。是霜。');
  writeFileSync(join(root, '人物卡.md'), '白不是雪。是霜。');
  const report = await checkStyle(root);
  assert.equal(report.chapters.length, 3);
  assert.match(report.text, /文风体检：3 章/);
  // Counts are hints, not verdicts: the report says so, and never orders a chapter rewritten.
  assert.match(report.text, /只用来提示先看哪里，不代表这些地方都要改，更不代表要整章重写/);
  assert.match(report.text, /先否定再自己作答（「白不是雪。是……」）：3 章里有/);
  assert.match(report.text, /「灯没有灭」出现在 3 章/);
  assert.doesNotMatch(report.text, /「林照说」/, 'a speech tag is not a habit');
  assert.match(report.text, /建议先通读的章节/);
  assert.doesNotMatch(report.text, /需要整章重写/);
  await assert.rejects(checkStyle(join(root, '归档', '没有')), /找不到/);
});

test('speech after a colon is dialogue too, and the book is the folder the user named', async (t) => {
  const chapter = checkChapter('第01章.txt', '第01章\n　　他应了一声。她问：你没听见吗。他答：现在听见了。');
  assert.equal(chapter.counts.fragment, 0, 'short spoken lines after a colon are not fragments');
  const { manuscriptCandidates } = await import('../src/server/style-check.ts');
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'style-scope-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [folder, count] of [
    ['书/正文/v2', 3],
    ['书_修订', 1],
    ['书_废稿', 2],
    ['书/资料/参考小说', 2],
  ] as const) {
    mkdirSync(join(root, folder), { recursive: true });
    for (let number = 1; number <= count; number++)
      writeFileSync(join(root, folder, `第0${number}章.txt`), `第0${number}章\n正文。`);
  }
  const candidates = await manuscriptCandidates(root);
  // Discarded drafts and reference books are no candidate; the folder with the most chapters comes first.
  assert.deepEqual(
    candidates.map((item) => [item.folder.slice(root.length + 1).replace(/\\/g, '/'), item.chapters]),
    [
      ['书/正文/v2', 3],
      ['书_修订', 1],
    ],
  );
});

test('speech after a colon ends with its sentence, a file without a title keeps its first paragraph, neighbouring hits all count', () => {
  const chapter = checkChapter(
    '第09章_无题.txt',
    '她笑：明天再来。随后她微微侧身，缓缓走远。\n　　他微微一怔，微微摇头。',
  );
  assert.equal(chapter.title, '第09章_无题');
  assert.equal(chapter.counts.fragment, 0, 'the leftover speech tag is not a fragment');
  assert.equal(chapter.counts.stock, 4, 'the narration after the speech and both 微微 in a row are counted');
  const twice = checkChapter('第02章.txt', '第02章 雪\n　　白不是雪。是霜。白不是雪。是月。');
  assert.equal(twice.counts.selfAnswer, 2);
});

test('agents and the panel find the book the same way: the named folder, the only one, or a question', async (t) => {
  const { resolveBook } = await import('../src/server/style-check.ts');
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'style-book-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '书', '正文'), { recursive: true });
  writeFileSync(join(root, '书', '正文', '第01章.txt'), '第01章\n正文。');
  assert.equal(await resolveBook(root), join(root, '书', '正文'));
  mkdirSync(join(root, '书_修订'));
  writeFileSync(join(root, '书_修订', '第01章.txt'), '第01章\n正文。');
  await assert.rejects(resolveBook(root), /先在路由面板里选好这本书的正式正文文件夹：项目里有 2 个放章节的文件夹/);
  assert.equal(await resolveBook(root, join(root, '书_修订')), join(root, '书_修订'));
});

test('400 chapters are complete, while a 401st chapter errors instead of silently truncating or over-reading', async (t) => {
  const root = resourceFixture(t);
  for (let number = 1; number <= styleCheckLimits.chapters; number++)
    writeFileSync(join(root, `第${number}章.txt`), `第${number}章\n他把门关好，走进院子。`);
  assert.equal((await checkStyle(root)).chapters.length, styleCheckLimits.chapters);
  writeFileSync(join(root, '第401章.txt'), '第401章\n他把门关好，走进院子。');
  await assert.rejects(checkStyle(root), /章节数量超过 400 章.*未生成不完整的全书报告/);
  await assert.rejects(manuscriptCandidates(root), /章节数量超过 400 章/);
  await assert.rejects(
    resolveBook(root),
    /章节数量超过 400 章/,
    'discovery must not turn a limit into no chapters found',
  );
});

test('chapter count applies across directories, and excessive depth cannot produce a partial whole-book report', async (t) => {
  const root = resourceFixture(t);
  for (const folder of ['上卷', '下卷']) {
    mkdirSync(join(root, folder));
    for (let number = 1; number <= 201; number++) writeFileSync(join(root, folder, `第${number}章.txt`), '正文。');
  }
  await assert.rejects(checkStyle(root), /章节数量超过 400 章/);
  const deepRoot = resourceFixture(t);
  mkdirSync(join(deepRoot, ...Array.from({ length: styleCheckLimits.depth + 1 }, () => '分卷')), { recursive: true });
  writeFileSync(join(deepRoot, '第1章.txt'), '第1章\n正文。');
  await assert.rejects(checkStyle(deepRoot), /子目录超过 5 层.*未生成不完整的全书报告/);
});

test('the single chapter byte limit is inclusive and also applies to a directly chosen file', async (t) => {
  const root = resourceFixture(t);
  const file = join(root, '第1章.txt');
  writeFileSync(file, Buffer.alloc(styleCheckLimits.chapterBytes, 32));
  assert.equal((await checkStyle(file)).chapters.length, 1);
  writeFileSync(file, Buffer.alloc(styleCheckLimits.chapterBytes + 1, 32));
  await assert.rejects(checkStyle(file), /单章超过 1 MiB/);
  await assert.rejects(checkStyle(root), /单章超过 1 MiB/);
});

test('many individually valid chapters cannot exceed the total reading budget', async (t) => {
  const root = resourceFixture(t);
  const chapter = Buffer.alloc(styleCheckLimits.chapterBytes, 32);
  for (let number = 1; number <= styleCheckLimits.totalBytes / chapter.length + 1; number++)
    writeFileSync(join(root, `第${number}章.txt`), chapter);
  await assert.rejects(checkStyle(root), /章节总大小超过 32 MiB.*未生成不完整的全书报告/);
});

test('dense rule hits keep exact counts while examples remain bounded', () => {
  const count = 20_000;
  const chapter = checkChapter('第1章.txt', `第1章\n${'微微'.repeat(count)}`);
  assert.equal(chapter.counts.stock, count);
  assert.ok(chapter.examples.stock!.length <= 3);
});
