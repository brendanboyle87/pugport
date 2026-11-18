import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baselineCheckCommand, failingCheckFiles, preexistingCheckFailure } from '../src/server/check-baseline.ts';
const output = (files: string[]) =>
  `Checking formatting...\n${files.map((file) => `[warn] ${file}`).join('\n')}\n[warn] Code style issues found in ${files.length} files. Run Prettier with --write to fix.`;
test('baseline excludes old failures, retains new failures and requires complete diagnostics', () => {
  const command = 'npm run format:check';
  const baseline = [{ command, files: failingCheckFiles(output(['old.ts', 'fixed.ts']))! }];
  assert.equal(preexistingCheckFailure(baseline, command, output(['old.ts'])), true);
  assert.equal(preexistingCheckFailure(baseline, command, output(['old.ts', 'new.ts'])), false);
  assert.equal(preexistingCheckFailure(undefined, command, output(['old.ts'])), false);
  assert.equal(preexistingCheckFailure(baseline, 'another command', output(['old.ts'])), false);
  assert.equal(preexistingCheckFailure(baseline, command, output(['old.ts']).slice(10)), false);
  assert.equal(preexistingCheckFailure(baseline, command, output(['old.ts']) + '\n[error] failed'), false);
});
test('only explicit format checks are eligible for baseline execution', () => {
  assert.equal(baselineCheckCommand('npm run format:check'), true);
  assert.equal(baselineCheckCommand('.runtime/node.exe node_modules/prettier/bin/prettier.cjs --check .'), true);
  for (const command of ['npm run format', 'npm run format:check; deploy', 'npm test'])
    assert.equal(baselineCheckCommand(command), false);
});
