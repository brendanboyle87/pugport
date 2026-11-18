import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnosticInput, diagnosticText, redactDiagnosticText } from '../src/shared/diagnostics.ts';
import type { AppState } from '../src/shared/types.ts';

test('redaction hides entire home paths and URL credentials in queries and fragments', () => {
  for (const path of [
    String.raw`C:\Users\alice\Documents\Acme-private\plan.docx`,
    '/Users/alice/Acme-private/plan.docx',
    '/home/alice/Acme-private/plan.docx',
  ]) {
    assert.equal(redactDiagnosticText(path), '[path]');
  }
  for (const suffix of ['?access_token=private#refresh_token=private', '#access_token=private&refresh_token=private'])
    assert.equal(redactDiagnosticText('https://example.test/callback' + suffix), 'https://example.test/callback');
});

test('redaction catches prefixed credentials and quoted JSON values', () => {
  for (const value of [
    'refresh_token=private-value',
    'client_secret=private-value',
    '"token":"private-value"',
    "'api-key': 'private-value'",
    'password="private-value"',
  ]) {
    assert.doesNotMatch(redactDiagnosticText(value), /private-value/);
    assert.match(redactDiagnosticText(value), /\[secret\]/);
  }
});

test('diagnostics project only allowed fields, replacing account labels with providers', () => {
  const state = {
    app: {
      version: '0.0.34',
      commit: 'abc1234',
      platform: 'win32',
      arch: 'x64',
      packaged: true,
      dataDir: 'C:/private/dataDir',
    },
    runtimes: [
      {
        installed: true,
        provider: 'grok',
        version: '1.2.3',
        status: 'ready',
        label: 'Private Owner',
        accountFingerprint: 'secret',
        command: 'C:/private/bin',
        errorDetail: 'token',
      },
      { installed: false, provider: 'cursor', status: 'missing' },
    ],
  } as unknown as AppState;
  const input = diagnosticInput(state);
  assert.equal(
    diagnosticText(input),
    'PugPort: 0.0.34\nCommit: abc1234\nOS: win32 / x64\nBuild: packaged\nCLI: Grok / 1.2.3 / ready',
  );
  assert.doesNotMatch(JSON.stringify(input), /dataDir|private|Owner|Fingerprint|command|errorDetail/);
});

test('last-resort redaction removes user paths, emails and every supported token without joining lines', () => {
  const values = [
    String.raw`C:\Users\Different Owner\private\log.txt`,
    '/home/another/private/file',
    String.raw`\\server\share\private`,
    String.raw`D:\private\file`,
    'E:/other-drive/file',
    '//server/share/private',
    '/root/private/file',
    '/root',
    '/Users/macowner/private',
    'name@example.test',
    'ghp_exampleSecret',
    'gho_exampleSecret',
    'ghu_exampleSecret',
    'ghs_exampleSecret',
    'ghr_exampleSecret',
    'sk-exampleSecret',
    'xai-exampleSecret',
    'Bearer opaqueCredential',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature',
    'key=value',
    'api_key=secret',
  ];
  const output = redactDiagnosticText(values.join('\n'));
  assert.equal(output.split('\n').length, values.length);
  for (const value of values) assert.ok(!output.includes(value), value);
  assert.doesNotMatch(output, /Different Owner|another|macowner/);
});

test('unexpected fields and unknown providers/statuses cannot add diagnostic content', () => {
  const input = {
    version: '0.0.34',
    os: 'linux',
    dataDir: '/private/data',
    label: 'Private Owner',
    clis: [
      { provider: 'Private Owner', status: 'ready' },
      { provider: 'codex', version: 'ghp_secret', status: 'Private Owner' },
    ],
  };
  const output = diagnosticText(input);
  assert.doesNotMatch(output, /Private Owner|dataDir|private|ghp_secret/);
  assert.match(output, /CLI: Codex \/ \[secret\] \/ unknown/);
});

test('offline diagnostics omit unavailable commit, build and CLI data', () => {
  assert.equal(diagnosticText({ version: '0.0.34', os: 'win32', arch: 'x64' }), 'PugPort: 0.0.34\nOS: win32 / x64');
});

test('CLI versions accept only short version tokens', () => {
  for (const version of ['1.2.3', 'v1.0-rc.2+build', 'a'.repeat(40)])
    assert.ok(diagnosticText({ clis: [{ provider: 'grok', status: 'ready', version }] }).includes(` / ${version} / `));
  for (const version of [
    '',
    'a'.repeat(41),
    'version 1',
    '/root/private',
    'D:/private',
    '1.0\n',
    '1.0\r',
    'name@example.test',
  ])
    assert.match(
      diagnosticText({ clis: [{ provider: 'grok', status: 'ready', version }] }),
      /CLI: Grok \/ unknown \/ ready/,
    );
});
