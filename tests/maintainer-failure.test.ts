import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as audit from '../src/server/maintainer/audit.ts';
import { createReadGh } from '../src/server/maintainer/gh.ts';
import { hostFixture } from './helpers/maintainer-host.ts';

test('failureReason keeps only the first non-empty line and clamps after redaction', () => {
  assert.equal(
    audit.failureReason(new Error('\r\n \t\n HTTP 403:\tpermission denied\r\nprivate body')),
    'HTTP 403: permission denied',
  );
  assert.equal(audit.failureReason('  \n failure\tmessage\nbody'), 'failure message');
  for (const value of ['', ' \n\t', new Error('')]) assert.equal(audit.failureReason(value), 'unknown error');
  assert.equal(audit.failureReason(undefined), 'undefined');
  assert.equal(audit.failureReason(null), 'null');
  assert.equal(audit.failureReason('x'.repeat(200)), 'x'.repeat(159) + '…');
});

for (const secret of [
  ...['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_'].map((prefix) => prefix + 'a'.repeat(30)),
  'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxMjMifQ.signature',
  'Bearer opaque-value',
  '-----BEGIN RSA PRIVATE KEY-----\nprivate material\n-----END RSA PRIVATE KEY-----',
  '-----BEGIN PRIVATE KEY----- inline-material -----END PRIVATE KEY-----',
  'https://api.github.com/graphql?token=private-value',
]) {
  test(`failureReason redacts credential form ${secret.split(/[ _.:]/)[0]}`, () => {
    const reason = audit.failureReason(new Error(`Failed: ${secret}`));
    assert.ok(reason.startsWith('Failed: '));
    assert.ok(reason.includes('[redacted'));
    assert.doesNotMatch(reason, /gh[pousr]_|github_pat_|eyJ|opaque-value|PRIVATE KEY|material|private-value/);
  });
}

for (const path of [
  '/private/keys/app.pem',
  'C:\\private\\app.pem',
  'app.pem',
  '"C:\\private folder\\key.pem"',
  "'/private folder/app.pem'",
  '/private/github-app/config.json',
  'C:\\private\\github-app.json',
  '/srv/secrets/app-key',
  'C:\\secrets\\app-key',
]) {
  test(`failureReason hides private path ${path}`, () => {
    assert.equal(audit.failureReason(`Cannot read ${path}`), 'Cannot read [path]');
  });
}

test('failureReason replaces the host home directory', () => {
  for (const home of [homedir(), homedir().replaceAll('\\', '/')]) {
    assert.equal(audit.failureReason(`Failed in ${home}/work`), 'Failed in ~/work');
    assert.equal(audit.failureReason(`Failed in ${home}/secrets/key.pem`), 'Failed in [path]');
  }
});

test('poll failure shows the gh reason in status and audit, then a good cycle clears it', async (t) => {
  const f = await hostFixture(t);
  f.data.readWait = async () => {
    throw new Error('HTTP 403: Resource not accessible by integration (https://api.github.com/graphql)\nprivate body');
  };
  await f.poll();
  const prefix = 'GitHub poll failed: HTTP 403: Resource not accessible by integration';
  const problem = (await f.host.status()).ready.problem!;
  assert.ok(problem.startsWith(prefix), problem);
  const line = f.audit.recent().find((line) => line.event === 'poll' && line.action === 'error')!;
  assert.ok(line.detail?.startsWith(prefix), String(line.detail));
  assert.equal(line.detail, problem);
  assert.ok(!problem.includes('private body'));
  f.data.readWait = undefined;
  await f.poll();
  assert.equal((await f.host.status()).ready.problem, undefined);
});

test('PR item errors include a reason and dedupe by PR and sha, independent of reason', async (t) => {
  const f = await hostFixture(t);
  const pr = f.addPr();
  let message = 'HTTP 403: integration permission missing';
  f.data.readWait = async (args) => {
    if (args[0] === 'pr' && args[1] === 'view') throw new Error(`${message}\nprivate body`);
  };
  await f.poll();
  message = 'HTTP 502: try again';
  await f.poll();
  const errors = () => f.audit.recent(200).filter((line) => line.event === 'pr' && line.action === 'error');
  assert.equal(errors().length, 1);
  assert.equal(errors()[0].detail, 'PR processing failed: HTTP 403: integration permission missing');
  pr.view.headRefOid = 'f'.repeat(40);
  await f.poll();
  assert.equal(errors().length, 2);
  assert.equal(errors()[1].detail, 'PR processing failed: HTTP 502: try again');
  f.addPr(2).view.headRefOid = pr.view.headRefOid;
  await f.poll();
  assert.equal(errors().length, 3);
});

test('poll secrets never reach status JSON or the audit file', async (t) => {
  const f = await hostFixture(t);
  const token = 'ghs_' + 's'.repeat(30);
  const path = '/private/keys/app.pem';
  f.data.readWait = async () => {
    throw new Error(`HTTP 403: ${token} ${path}\nprivate body`);
  };
  await f.poll();
  assert.match((await f.host.status()).ready.problem!, /^GitHub poll failed: HTTP 403:/);
  for (const text of [
    JSON.stringify(await f.host.status()),
    await readFile(join(f.dir, 'maintainer-audit.jsonl'), 'utf8'),
  ]) {
    assert.ok(!text.includes(token));
    assert.ok(!text.includes(path));
    assert.ok(!text.includes('private body'));
    assert.ok(text.includes('[path]'));
  }
});

test('gh adapter keeps only the first error line and still redacts its exact App token', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'maintainer-failure-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const gh = createReadGh({
    tmpRoot: dir,
    credential: async () => ({ kind: 'app', token: 'synthetic-app-token' }),
    exec: ((
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: unknown, stdout: string, stderr: string) => void,
    ) => {
      callback({ code: 1 }, '', '\nHTTP 403: synthetic-app-token\nprivate body');
      return { stdin: { on() {}, end() {} } };
    }) as unknown as NonNullable<Parameters<typeof createReadGh>[0]['exec']>,
  });
  await assert.rejects(gh.text(['api', 'rate_limit']), { message: 'HTTP 403: [redacted]' });
});
