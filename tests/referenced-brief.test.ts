import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { referencedBrief } from '../src/server/referenced-brief.ts';

test('referenced briefs are read from the project; missing or outside ones are null; targets are ignored', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pugport-brief-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(join(project, '.design'), { recursive: true });
  writeFileSync(join(project, '.design', 'brief-x.md'), 'Change src/a.ts');
  writeFileSync(join(project, 'README.md'), 'Readme text');
  writeFileSync(join(root, 'brief-outside.md'), 'Outside');

  assert.equal(referencedBrief('Implement .design/brief-x.md', project), 'Change src/a.ts');
  assert.equal(referencedBrief(`按 ${join(project, '.design', 'brief-x.md')} 实现`, project), 'Change src/a.ts');
  assert.equal(referencedBrief('请按 .design/brief-missing.md 实现', project), null);
  assert.equal(referencedBrief('Fix the typo in README.md', project), undefined);
  assert.equal(referencedBrief('按 README.md 实现', project), 'Readme text');
  assert.equal(referencedBrief('把 README.md 里的按钮说明改短', project), undefined);
  assert.equal(referencedBrief('Fix the following typos in README.md', project), undefined);
  // Outside the project: never read, but named as the brief it is work of unknown size.
  assert.equal(referencedBrief('Implement ../brief-outside.md', project), null);
  assert.equal(
    referencedBrief(
      `Implement the task brief in this file. It is the complete and final specification: ${join(root, 'codex-brief-m56-1.md')}`,
      project,
    ),
    null,
  );
  assert.equal(referencedBrief('Fix the typo in ../NOTES.md', project), undefined);
  assert.equal(referencedBrief('Implement the parser', project), undefined);
  for (const paths of [
    '.design/brief-x.md and .design/brief-missing.md',
    '.design/brief-missing.md and .design/brief-x.md',
  ])
    assert.equal(referencedBrief(`Implement according to ${paths}`, project), null);
});

test('creation targets, URLs, ordinary missing files and directories do not count as unreadable briefs', (t) => {
  const project = mkdtempSync(join(tmpdir(), 'pugport-brief-target-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, 'brief-directory.md'));
  for (const prompt of [
    '新建 docs/plan.md 写下周计划',
    '根据代码结构写一份 ARCHITECTURE.md',
    '参考 https://x.com/a/SPEC.md 实现',
    '按 brief-directory.md 实现',
    '根据 missing.md 实现',
    'Implement plan-missing.md',
    '根据任务书创建 plan.md',
    '根据任务书 create plan.md',
    '根据任务书 write plan.md',
    '根据任务书 add plan.md',
  ])
    assert.equal(referencedBrief(prompt, project), undefined, prompt);
  assert.equal(referencedBrief('请根据 brief-missing.md 实现', project), null);
  assert.equal(referencedBrief('创建 output.md。根据 brief-missing.md 实现', project), null);
});

test('brief reading is capped at 20000 bytes even for large multibyte files', (t) => {
  const project = mkdtempSync(join(tmpdir(), 'pugport-brief-large-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const content = '界'.repeat(6666) + 'ab' + 'TAIL'.repeat(100000);
  writeFileSync(join(project, 'brief-large.txt'), content);
  assert.equal(referencedBrief('按 brief-large.txt 实现', project), '界'.repeat(6666) + 'ab');
});
