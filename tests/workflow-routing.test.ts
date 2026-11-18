import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

function jobCondition(file: string, job: string) {
  const workflow = readFileSync(`.github/workflows/${file}.yml`, 'utf8');
  return workflow
    .split(`  ${job}:\n`)[1]!
    .match(/    if: (.+)/)![1]!
    .replace(/^'|'$/g, '');
}

function evaluate(expression: string, github: object, needs: object = {}, inputs: object = {}) {
  const startsWith = (value: string, prefix: string) => (value ?? '').toLowerCase().startsWith(prefix.toLowerCase());
  const always = () => true;
  return Boolean(
    Function(
      'github',
      'needs',
      'inputs',
      'startsWith',
      'always',
      `return (${expression})`,
    )(github, needs, inputs, startsWith, always),
  );
}

test('workflow job conditions route synthetic events to the intended runners', () => {
  const light = jobCondition('ci', 'private-check');
  const full = jobCondition('ci', 'check');
  const download = jobCondition('ci', 'windows-download');
  for (const isPrivate of [true, false]) {
    for (const [event, ref] of [
      ['pull_request', 'refs/pull/1/merge'],
      ['push', 'refs/heads/main'],
      ['push', 'refs/tags/v1'],
      ['workflow_dispatch', 'refs/heads/main'],
    ]) {
      const github = { event: { repository: { private: isPrivate } }, event_name: event, ref };
      assert.equal(
        evaluate(light, github),
        isPrivate && (event === 'pull_request' || (ref === 'refs/heads/main' && event === 'push')),
      );
      assert.equal(evaluate(full, github), !isPrivate && ref !== 'refs/tags/v1');
      // A manual run with full_checks runs the matrix once while the repository is private.
      assert.equal(
        evaluate(full, github, {}, { full_checks: true }),
        ref !== 'refs/tags/v1' && (!isPrivate || event === 'workflow_dispatch'),
      );
      assert.equal(evaluate(full, github, {}, { full_checks: false }), !isPrivate && ref !== 'refs/tags/v1');
      assert.equal(
        evaluate(download, github, { check: { result: isPrivate ? 'skipped' : 'success' } }),
        isPrivate ? event === 'workflow_dispatch' || ref === 'refs/tags/v1' : event === 'workflow_dispatch',
      );
    }
  }
  const cla = jobCondition('cla', 'cla');
  const lifecycle = jobCondition('issue-lifecycle', 'reconcile');
  for (const [body, pr, claExpected, lifecycleExpected] of [
    ['recheck', true, true, false],
    ['I have read the CLA Document and I hereby sign the CLA', true, true, false],
    ['recheck', false, false, false],
    ['/claim', false, false, true],
    ['/unclaim', false, false, true],
    ['/renew', false, false, true],
    ['ordinary comment', false, false, false],
    ['/claim', true, false, false],
  ] as const) {
    const github = { event_name: 'issue_comment', event: { issue: { pull_request: pr }, comment: { body } } };
    assert.equal(evaluate(cla, github), claExpected, body);
    assert.equal(evaluate(lifecycle, github), lifecycleExpected, body);
  }
  assert.equal(evaluate(lifecycle, { event_name: 'schedule', event: {} }), true);
  assert.equal(evaluate(cla, { event_name: 'pull_request_target', event: {} }), true);
  // Full reconciliation replaces PR triggers; pull_request_target is blocked by default in public repositories.
  assert.doesNotMatch(readFileSync('.github/workflows/issue-lifecycle.yml', 'utf8'), /^\s+pull_request_target:/m);
  assert.equal(
    evaluate(
      download,
      { event: { repository: { private: false } }, event_name: 'workflow_dispatch' },
      { check: { result: 'failure' } },
    ),
    false,
  );
});
