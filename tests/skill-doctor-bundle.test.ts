import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('assets/skills/skill-doctor');

async function files(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) => {
        const name = path.join(dir, entry.name);
        return entry.isDirectory() ? files(name) : [name];
      }),
    )
  ).flat();
}

test('bundled skill retains license and attribution', async () => {
  const license = await fs.readFile(path.join(root, 'LICENSE'), 'utf8');
  const notice = await fs.readFile('THIRD_PARTY_NOTICES.md', 'utf8');
  assert.match(license, /Copyright \(c\) 2026 Denver Technologies, Inc\./);
  assert.match(notice, /skill-doctor/i);
  assert.match(notice, /warpdotdev\/common-skills/i);
});

test('skill has first-position frontmatter with the expected name', async () => {
  const skill = await fs.readFile(path.join(root, 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  const frontmatter = skill.split(/\r?\n---(?:\r?\n|$)/, 1)[0];
  assert.match(frontmatter, /^name:\s*["']?skill-doctor["']?\s*$/m);
});

test('bundle excludes the unlicensed diff bundle', async () => {
  for (const file of await files(root)) {
    assert.notEqual(path.basename(file), 'pierre-diffs.js');
  }
});

test('bundle excludes the factories URL', async () => {
  for (const file of await files(root)) {
    const content = await fs.readFile(file, 'utf8');
    assert.ok(!content.includes('warp.dev/factories'), `Factories URL found in ${file}`);
  }
});
