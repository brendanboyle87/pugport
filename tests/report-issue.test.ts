import assert from 'node:assert/strict';
import test from 'node:test';
import { reportIssue } from '../src/shared/report-issue.ts';

test('report uses the repository, template, and exact displayed prefill values', () => {
  const report = reportIssue({ version: '0.0.34 + dev', os: 'Windows & Linux', arch: 'x64' });
  const url = new URL(report.url);
  assert.equal(url.origin + url.pathname, 'https://github.com/pugport/pugport/issues/new');
  assert.equal(url.searchParams.get('template'), 'bug.yml');
  assert.equal(url.searchParams.get('version'), report.version);
  assert.equal(url.searchParams.get('os'), report.os);
  assert.ok(report.detail.includes(report.version));
  assert.ok(report.detail.includes(report.os));
  assert.match(report.url, /%26/);
  assert.deepEqual([...url.searchParams.keys()], ['template', 'os', 'version']);
});
test('report bounds encoded Unicode and shows the same truncated values', () => {
  const report = reportIssue({ version: '🚀'.repeat(1000), os: '界'.repeat(1000) });
  const url = new URL(report.url);
  assert.ok(report.url.length < 2000);
  assert.ok(report.detail.includes(url.searchParams.get('version')!));
  assert.ok(report.detail.includes(url.searchParams.get('os')!));
});
test('report redacts prefilled values and never sends CLI details in the URL', () => {
  const report = reportIssue({
    version: 'sk-secret',
    os: 'test@example.com',
    clis: [{ provider: 'grok', version: '1.2.3', status: 'ready' }],
  });
  assert.ok(!report.url.includes('sk-secret'));
  assert.ok(!report.url.includes('example'));
  assert.ok(!report.url.includes('grok'));
  assert.ok(!report.detail.includes('test@example.com'));
});

test('report control characters and empty fields match the visible confirmation', () => {
  for (const value of ['version\twith\0controls', '\n\t']) {
    const report = reportIssue({ version: value, os: value });
    const url = new URL(report.url);
    assert.ok(report.detail.includes('PugPort: ' + url.searchParams.get('version')));
    assert.ok(report.detail.includes('OS: ' + url.searchParams.get('os')));
  }
});

test('report redacts tokens after joining control-separated fields', () => {
  const report = reportIssue({ version: 'Bearer\nsynthetic-token', os: 'key=\nsynthetic-key' });
  const url = new URL(report.url);
  assert.doesNotMatch(report.url, /synthetic-token|synthetic-key/);
  assert.ok(report.detail.includes('PugPort: ' + url.searchParams.get('version')));
  assert.ok(report.detail.includes('OS: ' + url.searchParams.get('os')));
});
