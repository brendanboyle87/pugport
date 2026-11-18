import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  compareText,
  connectorReadback,
  connectorWrite,
  decide,
  effectiveGates,
  scanMessage,
  scanOutbound,
  type RuleId,
} from '../src/server/github-gate.ts';

const scan = (value: unknown, only?: RuleId[]) => scanOutbound([{ field: 'body', value, only }]);
test('scan catches sensitive text and ignores product and harmless examples', () => {
  for (const value of [
    'git@github.com:o/r.git',
    'ubuntu@192.168.0.5',
    '/home/runner/work/x',
    'src/server/x.ts',
    '~/b',
    '%APPDATA%\\c',
    '.claude/skills/x',
    'log.jsonl',
    'scratchpad',
    'MEMORY.md',
    "password: ''",
    'token = undefined',
    'data:image/png;base64,AAAA',
    '"role": "assistant"',
  ])
    assert.deepEqual(scan(value), [], value);
  for (const [value, rule] of [
    ['C:\\Users\\x\\notes.md', 'local-path'],
    ['/home/x/a', 'local-path'],
    ['/Users/x/b', 'local-path'],
    ['k@example.test', 'email'],
    ['ghp_' + 'a'.repeat(36), 'secret'],
    ['-----BEGIN RSA PRIVATE KEY-----', 'secret'],
    ['coordinator-handover-3.md', 'record-file'],
    ['Claude-Data', 'record-file'],
    ['claude_abcdefghij12', 'record-file'],
    ['> user: hi', 'chat-quote'],
    ['「主人：你好」', 'chat-quote'],
    ['[项目规则更新]', 'chat-quote'],
  ] as [string, RuleId][])
    assert.ok(
      scan(value).some((hit) => hit.rule === rule),
      value,
    );
  assert.equal(scan('k@example.test-extra')[0]?.rule, 'email');
  assert.equal(scan('「主人：请看“内容”」')[0]?.rule, 'chat-quote');
  assert.equal(scan('line\nBearer ' + 'a'.repeat(24))[0]?.line, 2);
  for (const path of ['/home/alice/', '/Users/alice/', 'C:\\Users\\alice\\']) {
    const result = scan(path);
    assert.equal(result[0]?.rule, 'local-path');
    assert.ok(!result[0]!.shown.includes('alice'));
  }
  assert.equal(
    scanOutbound([{ field: 'body', value: 'sensitive phrase' }], { block: ['Sensitive'] })[0]?.rule,
    'chat-quote',
  );
});
test('review: REST routes are not local user paths', () => {
  assert.equal(
    scan('/users/me/profile').some((hit) => hit.rule === 'local-path'),
    false,
  );
  assert.ok(scan('c:\\users\\x\\a').some((hit) => hit.rule === 'local-path'));
});
test('review: escaped Windows paths are scanned', () => {
  assert.ok(scan(String.raw`C:\\Users\\x\\notes.md`).some((hit) => hit.rule === 'local-path'));
});
test('review: Codex co-author email is allowed', () => {
  assert.deepEqual(scan('Co-Authored-By: Codex <noreply@openai.com>'), []);
});
test('review: record names wrapped in punctuation are scanned', () => {
  for (const value of ['`Claude-Data`', 'notes/AI_STATE.md,', '**AI_STATE.md**', '_Claude-Data_', '|Claude-Data|'])
    assert.ok(
      scan(value).some((hit) => hit.rule === 'record-file'),
      value,
    );
});
test('review: blocked terms cannot be released by allow entries', () => {
  assert.ok(
    scanOutbound([{ field: 'body', value: 'pugport-internal' }], {
      allow: ['pug'],
      block: ['pugport-internal'],
    }).some((hit) => hit.rule === 'chat-quote'),
  );
});
test('review: state-only changes do not have a text readback', () => {
  assert.equal(
    connectorReadback('update_pull_request', { owner: 'o', repo: 'r', state: 'closed' }, { content: [] }),
    undefined,
  );
});
test('allow, restricted rules, redaction and fail closed', () => {
  const key = 'ghp_' + 'a'.repeat(36);
  const body = `C:\\Users\\x\\notes.md k@example.test ${key}`;
  const hits = scanOutbound([{ field: 'body', value: body }], { allow: ['C:\\Users\\x', 'k@example.test', key] });
  assert.deepEqual(
    hits.map((h) => h.rule),
    ['secret'],
  );
  assert.deepEqual(
    scanOutbound([{ field: 'x', value: 'owner@example.test' }], { allowEmails: ['OWNER@example.test'] }),
    [],
  );
  assert.deepEqual(scan('/home/x/a', ['secret']), []);
  assert.equal(scan('notes/AI_STATE.md', ['record-file'])[0]?.rule, 'record-file');
  assert.deepEqual(scan(null), [{ rule: 'secret', field: 'body', line: 0, shown: '外发文本检查器出错' }]);
  const message = scanMessage(scan(body));
  for (const raw of ['C:\\Users\\x\\notes.md', 'k@example.test', key]) assert.ok(!message.includes(raw));
  assert.equal(
    scanMessage(Array(8).fill(scan(key)[0]))
      .split('\n')
      .filter((line) => line.startsWith('·')).length,
    5,
  );
});
test('each scanner rule completes promptly on a 64KB body', () => {
  for (const rule of ['local-path', 'email', 'secret', 'record-file', 'chat-quote'] as RuleId[]) {
    const start = performance.now();
    scan('a'.repeat(65536), [rule]);
    assert.ok(performance.now() - start < 500, rule);
  }
  const start = performance.now();
  scan('a'.repeat(65535) + '@', ['email']);
  assert.ok(performance.now() - start < 500, 'email with incomplete address');
  for (const [rule, input] of [
    ['record-file', 'x-handover'.repeat(6000)],
    ['chat-quote', '「主人：'.repeat(10000)],
  ] as [RuleId, string][]) {
    const before = performance.now();
    scan(input, [rule]);
    assert.ok(performance.now() - before < 500, rule);
  }
});
test('comparison normalizes whitespace and unicode', () => {
  assert.equal(compareText('  é\r\nline  \r\n', 'e\u0301\nline'), 'match');
  assert.equal(compareText('a', 'b'), 'mismatch');
  assert.equal(compareText('a', undefined), 'unverified');
});
test('default lists can be replaced but the remote default branch remains protected', () => {
  const gates = effectiveGates({ version: 1, alwaysAsk: { paths: ['secret/**'], branches: ['special'] } });
  assert.deepEqual(gates.alwaysAsk, { paths: ['secret/**'], branches: ['special'] });
  const empty = { version: 1 as const, alwaysAsk: { paths: [], branches: [] } };
  assert.equal(decide({ op: 'file', repo: 'o/r', paths: ['db/migrations/x'] }, empty, new Date()).outcome, 'pass');
  assert.equal(
    decide({ op: 'file', repo: 'o/r', branch: 'main', defaultBranch: 'main' }, empty, new Date()).outcome,
    'ask',
  );
  for (const branch of ['Develop', 'refs/heads/develop', 'release/1.2'])
    assert.equal(decide({ op: 'file', repo: 'o/r', branch }, undefined, new Date()).outcome, 'ask');
  assert.equal(decide({ op: 'file', repo: 'o/r', branch: 'release/1/2' }, undefined, new Date()).outcome, 'pass');
  for (const path of ['db/migrations/0001.sql', 'migrations/x', 'CODEOWNERS', '.github/workflows/a'])
    assert.equal(decide({ op: 'file', repo: 'o/r', paths: [path] }, undefined, new Date()).outcome, 'ask');
  assert.equal(decide({ op: 'file', repo: 'o/r', pathsUnverified: true }, undefined, new Date()).outcome, 'ask');
  assert.equal(decide({ op: 'push', repo: 'o/r', commitsTruncated: true }, undefined, new Date()).outcome, 'ask');
  assert.equal(decide({ op: 'open-pr', repo: 'o/r' }, undefined, new Date()).outcome, 'pass');
});
test('author checks are explicit and redact mismatches', () => {
  const commits = [
    {
      sha: 'abcdef123456',
      authorName: 'Other',
      authorEmail: 'other@example.invalid',
      committerName: 'Other',
      committerEmail: 'other@example.invalid',
      message: 'Synthetic',
    },
  ];
  const write = { op: 'push' as const, repo: 'o/r', commits };
  const gates = { version: 1 as const, commitAuthor: { emails: ['owner@example.test'] } };
  assert.equal(decide(write, undefined, new Date()).outcome, 'pass');
  const refused = decide(write, gates, new Date());
  assert.equal(refused.outcome, 'refuse');
  assert.match(refused.error!, /abcdef1/);
  assert.match(refused.error!, /o\*\*\*@example\.invalid/);
  assert.ok(!refused.error!.includes('other@example.invalid'));
  assert.equal(
    decide(write, { ...gates, commitAuthor: { ...gates.commitAuthor, onMismatch: 'ask' } }, new Date()).outcome,
    'ask',
  );
  assert.equal(decide({ op: 'file', repo: 'o/r' }, gates, new Date()).outcome, 'refuse');
});
test('night windows, endpoints and invalid configuration', () => {
  const check = (from: string, to: string, tz: string, date: string) =>
    decide({ op: 'merge', repo: 'o/r' }, { version: 1, windows: { noMerge: { from, to, tz } } }, new Date(date))
      .outcome;
  assert.equal(check('22:00', '07:00', 'America/New_York', '2026-10-28T03:41:00Z'), 'refuse');
  assert.equal(check('22:00', '07:00', 'America/New_York', '2026-10-28T10:59:00Z'), 'refuse');
  assert.equal(check('22:00', '07:00', 'America/New_York', '2026-10-28T11:00:00Z'), 'pass');
  assert.equal(check('12:00', '13:00', 'UTC', '2026-10-28T12:30:00Z'), 'refuse');
  assert.equal(check('12:00', '12:00', 'UTC', '2026-10-28T12:00:00Z'), 'pass');
  assert.equal(check('22:00', '07:00', 'Invalid/Zone', '2026-10-28T03:41:00Z'), 'pass');
  assert.equal(
    decide(
      { op: 'file', repo: 'o/r', branch: 'main' },
      { version: 1, alwaysAsk: { branches: 42 as never } },
      new Date(),
    ).outcome,
    'ask',
  );
  assert.equal(
    decide({ op: 'file', repo: 'o/r' }, { version: 1, commitAuthor: { emails: null as never } }, new Date()).outcome,
    'pass',
  );
});
test('connector mapping reads only present fields and validates readback identifiers', () => {
  const args = { owner: 'o', repo: 'r', title: 'T', body: 'B' };
  const result = (value: unknown) => ({ content: [{ text: JSON.stringify(value) }] });
  assert.deepEqual(connectorWrite('update_pull_request', { state: 'closed' }).texts, []);
  assert.equal(connectorWrite('create_pull_request', args).write.op, 'open-pr');
  assert.equal(connectorReadback('create_pull_request', args, result({ number: 4 }))?.path, '/repos/o/r/pulls/4');
  assert.equal(connectorReadback('create_pull_request', args, result({ number: '../../user' }))?.path, undefined);
  assert.equal(
    connectorReadback('create_pull_request', { ...args, owner: '../x' }, result({ number: 4 }))?.path,
    undefined,
  );
  assert.equal(connectorReadback('create_branch', args, result({})), undefined);
  const sha = 'a'.repeat(40);
  assert.equal(
    connectorReadback('push_files', { ...args, message: 'M' }, result({ object: { sha } }))?.path,
    `/repos/o/r/git/commits/${sha}`,
  );
  assert.equal(connectorReadback('add_issue_comment', args, result({ id: 8 }))?.path, '/repos/o/r/issues/comments/8');
  assert.equal(
    connectorReadback('add_reply_to_pull_request_comment', args, result({ id: 8 }))?.path,
    '/repos/o/r/pulls/comments/8',
  );
  assert.equal(connectorReadback('issue_write', args, result({ number: 9 }))?.path, '/repos/o/r/issues/9');
  const mapped = connectorWrite('push_files', {
    ...args,
    branch: 'feature',
    files: [{ path: 'notes/AI_STATE.md', content: 'hello' }],
  });
  assert.equal(mapped.write.op, 'file');
  assert.deepEqual(mapped.write.paths, ['notes/AI_STATE.md']);
  assert.equal(scanOutbound(mapped.texts)[0]?.rule, 'record-file');
  for (const name of ['create_pull_request', 'update_pull_request'])
    assert.equal(connectorWrite(name, args).write.op, 'open-pr');
  for (const name of [
    'add_issue_comment',
    'update_issue_comment',
    'add_reply_to_pull_request_comment',
    'add_comment_to_pending_review',
    'pull_request_review_write',
    'issue_write',
  ])
    assert.equal(connectorWrite(name, args).write.op, 'comment');
  for (const name of ['push_files', 'create_or_update_file', 'delete_file'])
    assert.equal(connectorWrite(name, args).write.op, 'file');
  assert.equal(connectorWrite('create_branch', args).write.op, 'branch');
  assert.equal(connectorWrite('merge_pull_request', args).write.op, 'merge');
  assert.equal(connectorWrite('unknown', args).write.op, 'other');
  assert.equal(connectorReadback('pull_request_review_write', args, result({})), undefined);
  assert.equal(connectorReadback('merge_pull_request', args, result({})), undefined);
  assert.equal(
    connectorReadback('update_pull_request', { ...args, pull_number: 7 }, result({}))?.path,
    '/repos/o/r/pulls/7',
  );
  assert.equal(
    connectorReadback('update_issue_comment', args, result({ id: 4 }))?.path,
    '/repos/o/r/issues/comments/4',
  );
  assert.equal(
    connectorReadback('add_comment_to_pending_review', args, result({ id: 4 }))?.path,
    '/repos/o/r/pulls/comments/4',
  );
  for (const name of ['create_or_update_file', 'delete_file'])
    assert.equal(
      connectorReadback(name, { ...args, message: 'M' }, result({ commit: { sha } }))?.path,
      `/repos/o/r/git/commits/${sha}`,
    );
});
test('scan messages never echo secrets embedded in paths or record names', () => {
  const token = 'ghp_' + 'a'.repeat(36);
  for (const text of [`C:\\Users\\alice\\${token}`, `coordinator-handover-${token}`]) {
    const hits = scan(text);
    assert.ok(hits.some((hit) => hit.rule === 'secret'));
    assert.ok(!scanMessage(hits).includes(token));
  }
});
test('chat and configured block checks span lines and report the first line', () => {
  for (const value of ['start\n「主人：第一行\n第二行」', 'start\n[调用方第一行\n的消息]']) {
    const hit = scan(value).find((item) => item.rule === 'chat-quote');
    assert.equal(hit?.line, 2);
  }
  const hits = scanOutbound([{ field: 'body', value: 'start\nphrase\nblocked' }], { block: ['phrase\nblocked'] });
  assert.equal(hits[0]?.line, 2);
});
test('readback normalizes numeric string IDs', () => {
  const result = { content: [{ text: JSON.stringify({ number: '001' }) }] };
  assert.equal(
    connectorReadback('create_pull_request', { owner: 'o', repo: 'r', title: 'T' }, result)?.path,
    '/repos/o/r/pulls/1',
  );
});
test('pure module has no execution or network endpoint', async () => {
  assert.doesNotMatch(
    await readFile(new URL('../src/server/github-gate.ts', import.meta.url), 'utf8'),
    /execFile\('gh'|'gh',|api\.github\.com|githubcopilot\.com/,
  );
});
