import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  documentImagePrompts,
  documentPlan,
  namedDocumentPaths,
  picturesPerSubject,
} from '../src/server/image-documents.ts';

const document = [
  '# 人物生图提示词',
  ...['林照', '周宁', '沈遥'].flatMap((name, index) => [
    `## ${index + 1}. ${name}（30岁）`,
    '### 四、生图提示词',
    '* **中文提示词**：',
    `  > 全身立姿人像摄影，从头到脚完整全身构图。人物是${name}，站姿挺拔，神态自然。`,
    '* **英文提示词**：',
    `  > Full-body standing portrait, head-to-toe framing, the character ${name}, natural expression.`,
  ]),
].join('\n');

test('a folder named after a character in the file path is not a request for that character alone', () => {
  const request =
    '文件完整绝对路径： c:\\Users\\me\\Documents\\Writing\\林照\\drafts\\portrait-prompts.md\n点击直接打开： portrait-prompts.md\n这里面每个人物都生成几章不同穿搭和姿势的图片';
  const plan = documentPlan(request, document)!;
  assert.deepEqual(
    plan.subjects.map((subject) => subject.title),
    ['林照', '周宁', '沈遥'],
  );
  assert.equal(plan.perSubject, 3);
  assert.match(plan.subjects[0]!.prompt, /^全身立姿/);
});

test('how many of each, and whom, come from the owner words', () => {
  assert.equal(picturesPerSubject('每人3张'), 3);
  assert.equal(picturesPerSubject('每个人物各两张不同姿势'), 2);
  assert.equal(picturesPerSubject('每个人物生成十二张'), 12);
  assert.equal(picturesPerSubject('生成每个人物的图'), 1);
  assert.equal(picturesPerSubject('每个人物几张不同穿搭'), 3);
  const named = documentPlan('只生成周宁，用英文，每人4张', document)!;
  assert.deepEqual(
    named.subjects.map((subject) => subject.title),
    ['周宁'],
  );
  assert.equal(named.perSubject, 4);
  assert.match(named.subjects[0]!.prompt, /^Full-body/);
});

test('several looks per character come from the planner, keep the written prompt, and fall back when it fails', async () => {
  const plan = documentPlan('每个人物各两张不同穿搭', document)!;
  const planned = await documentImagePrompts(plan, '每个人物各两张不同穿搭', async (prompt) => {
    assert.match(prompt, /write 2 different looks/);
    assert.match(prompt, /a child wears ordinary children/);
    return '```json\n{"looks":{"林照":["白衬衫西裤，正面站立","风衣，侧身回眸"]}}\n```';
  });
  assert.equal(planned.prompts.length, 6);
  assert.deepEqual(planned.titles, ['林照 1', '林照 2', '周宁 1', '周宁 2', '沈遥 1', '沈遥 2']);
  assert.match(planned.prompts[0]!, /人物是林照[\s\S]*本张造型：白衬衫西裤，正面站立。单人单张/);
  // No look planned for 周宁: the fallback still varies the two pictures.
  assert.notEqual(planned.prompts[2]!.split('本张造型：')[1], planned.prompts[3]!.split('本张造型：')[1]);
  const failed = await documentImagePrompts(plan, '每个人物各两张不同穿搭', async () => {
    throw new Error('no planner');
  });
  assert.equal(failed.prompts.length, 6);
  const single = await documentImagePrompts(documentPlan('生成每个人物', document)!, '生成每个人物', async () =>
    assert.fail('one each needs no planning'),
  );
  assert.equal(single.prompts.length, 3);
});

test('a prompt file named by its full path is found on every platform, and only as a whole path', () => {
  assert.deepEqual(
    namedDocumentPaths(
      'Windows C:\\Users\\x\\甲一\\人物.md, macOS /Users/x/甲一/人物.md, 路径：/home/x/shots.txt and again /Users/x/甲一/人物.md',
    ),
    ['C:\\Users\\x\\甲一\\人物.md', '/Users/x/甲一/人物.md', '/home/x/shots.txt'],
  );
  assert.deepEqual(namedDocumentPaths('C:/Users/x/人物.md'), ['C:/Users/x/人物.md']);
  assert.deepEqual(namedDocumentPaths('https://example.test/docs/人物.md and docs/人物.md and /tmp/x.png'), []);
});
