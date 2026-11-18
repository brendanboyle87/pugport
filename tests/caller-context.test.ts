import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { clientRootPath, createCallerContext } from '../src/mcp/caller-context.ts';
import { createClientRoots, ROOTS_TIMEOUT_MS } from '../src/mcp/client-roots.ts';
import type { CallerProbeInput } from '../src/shared/caller-signals.ts';
import { callerWrite, inheritedCeiling } from '../src/server/caller-ceiling.ts';

test('MCP caller context emits only derived fields and fixed evidence labels', async () => {
  const raw: CallerProbeInput = {
    chain: [{ exe: 'codex.exe', args: ['--sandbox', 'workspace-write', '--prompt', 'SECRET_PROMPT'] }],
    envNames: ['SECRET_ENV_VALUE'],
    cwd: 'C:/synthetic/repo',
    config: { codexToml: 'sandbox_mode = "workspace-write"\napi_key = "SECRET_CONFIG"' },
  };
  const provider = createCallerContext(async () => raw, 'codex');
  provider.initialize({ name: 'codex', version: '1.2.3' });
  const context = await provider.get();
  assert.deepEqual(Object.keys(context).sort(), ['client', 'cwd', 'evidence', 'mode', 'roots', 'verified', 'version']);
  assert.equal(context.mode, 'write');
  assert.equal(context.verified, true);
  assert.doesNotMatch(JSON.stringify(context), /SECRET|api_key|--prompt|codex\.exe|"chain":|envNames|codexToml/);
  assert.deepEqual(context.evidence, [
    'identity: PUGPORT_CALLER',
    'identity: process chain',
    'identity: clientInfo',
    'config: sandbox_mode',
    'permission: write',
  ]);
});

test('MCP initialize does not wait; first tool waits at most ten seconds and late probes can recover', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let finish!: (value: CallerProbeInput) => void;
  const provider = createCallerContext(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    'claude',
  );
  assert.equal(provider.initialize({ name: 'claude-code', version: '1' }), undefined);
  const pending = provider.get();
  await Promise.resolve();
  t.mock.timers.tick(10_000);
  const unknown = await pending;
  assert.equal(unknown.client, 'claude');
  assert.equal(unknown.mode, 'unknown');
  assert.deepEqual(unknown.roots, []);
  for (const override of ['inherit', 'write'] as const)
    assert.throws(() => callerWrite(inheritedCeiling(unknown, 'C:/synthetic/repo', override), true), /请重试/);
  finish({ chain: [{ exe: 'claude', args: [] }], envNames: [], cwd: 'C:/synthetic/repo' });
  await Promise.resolve();
  assert.equal((await provider.get()).mode, 'write');
});

test('probe disabled or rejected remains unknown even with a writable-default client identity', async () => {
  for (const disabled of [true, false]) {
    const provider = createCallerContext(
      async () => {
        if (!disabled) throw Error('synthetic');
        return { chain: [], envNames: [] };
      },
      'claude',
      disabled,
    );
    provider.initialize({ name: 'claude-code', version: '1' });
    const context = await provider.get([
      { uri: process.platform === 'win32' ? 'file:///C:/synthetic/extra' : 'file:///synthetic/extra' },
    ]);
    assert.equal(context.mode, 'unknown');
    assert.deepEqual(context.roots, []);
    for (const override of ['inherit', 'write'] as const)
      assert.throws(
        () => callerWrite(inheritedCeiling(context, 'C:/synthetic/repo', override), true),
        disabled ? /关闭调用方检测时不能写入/ : /请重试/,
      );
  }
});

test('client root conversion explicitly handles Windows and POSIX without filesystem access', () => {
  assert.equal(clientRootPath('file:///C:/synthetic/project%20one', true), 'C:\\synthetic\\project one');
  assert.equal(clientRootPath('file:///synthetic/project%20one', false), '/synthetic/project one');
  for (const uri of [undefined, null, 42, 'invalid', 'https://example.test/project', 'data:text/plain,hi'])
    for (const windows of [true, false]) assert.equal(clientRootPath(uri, windows), undefined, String(uri));
  for (const uri of [
    'file://host/share/project',
    'file://wsl.localhost/Ubuntu/project',
    'file:////host/share/project',
    'file:////?/C:/project',
    'file:////./C:/project',
    'file:///C:/',
    'file:///C:/Users',
    'file:///c:/users/',
    'file:///C:/Users/Synthetic',
    'file:///C:/Users/Synthetic/',
    'file:///C:/Windows/System32',
    'file:///C:/WINNT',
    'file:///C:/Program%20Files/app',
    'file:///C:/Program%20Files%20(x86)/app',
    'file:///C:/synthetic/%2Fescape',
    `file:///C:/synthetic/${'x'.repeat(4000)}`,
  ])
    assert.equal(clientRootPath(uri, true), undefined, uri);
  for (const uri of [
    'file://host/share/project',
    'file:////host/share/project',
    'file:///',
    'file:///home',
    'file:///home/',
    'file:///Users',
    'file:///home/synthetic',
    'file:///Users/synthetic/',
    'file:///root',
    'file:///mnt/c/Users',
    'file:///synthetic/%5c..%5c..%5chome',
    `file:///synthetic/${'x'.repeat(4000)}`,
  ])
    assert.equal(clientRootPath(uri, false), undefined, uri);
});

test('client roots merge after probed roots, dedupe, and share the final 100-entry cap', async () => {
  const windows = process.platform === 'win32';
  const cwd = windows ? 'C:/synthetic/repo' : '/synthetic/repo';
  const extra = windows ? 'C:/synthetic/probed' : '/synthetic/probed';
  const uri = (path: string) => `file:///${path.replace(/^\//, '')}`;
  const provider = createCallerContext(async () => ({
    chain: [{ exe: 'claude', args: ['--add-dir', extra] }],
    envNames: [],
    cwd,
  }));
  const client = Array.from({ length: 110 }, (_, i) => ({ uri: uri(`${cwd}-${i}`) }));
  const context = await provider.get([{ uri: uri(extra) }, ...client]);
  assert.equal(context.roots.length, 100);
  assert.deepEqual(
    context.roots.slice(0, 3),
    [cwd, extra, `${cwd}-0`].map((path) => (windows ? path.replace(/\//g, '\\') : path)),
  );
  assert.equal(context.roots.at(-1), windows ? 'C:\\synthetic\\repo-97' : '/synthetic/repo-97');
  assert.ok(context.evidence.includes('roots: client'));
  const removed = await provider.get([]);
  assert.equal(removed.roots.length, 2);
  assert.ok(!removed.evidence.includes('roots: client'));
});

test('client roots are trusted only for inferred Claude clients and never change permission mode', async () => {
  const uri = process.platform === 'win32' ? 'file:///C:/synthetic/extra' : 'file:///synthetic/extra';
  for (const [exe, args, mode] of [
    ['claude', ['--permission-mode', 'plan'], 'read-only'],
    ['codex', ['--sandbox', 'workspace-write'], 'write'],
    ['gemini', [], 'write'],
    ['grok', [], 'write'],
    ['cursor', [], 'write'],
    ['other', [], 'unknown'],
  ] as const) {
    const provider = createCallerContext(async () => ({
      chain: [{ exe, args: [...args] }],
      envNames: [],
      cwd: '/synthetic/repo',
    }));
    const context = await provider.get([{ uri }]);
    assert.equal(context.mode, mode);
    assert.equal(context.evidence.includes('roots: client'), exe === 'claude');
    assert.equal(context.roots.length, exe === 'claude' ? 2 : 1);
  }
  // A clientInfo name alone is not Claude Code: an unrecognized process chain keeps its roots out.
  const spoof = createCallerContext(async () => ({
    chain: [{ exe: 'Code.exe', args: [] }],
    envNames: [],
    cwd: '/synthetic/repo',
  }));
  spoof.initialize({ name: 'claude-code', version: '1' });
  const context = await spoof.get([{ uri }]);
  assert.equal(context.client, 'claude');
  assert.equal(context.mode, 'unknown');
  assert.equal(context.verified, false);
  assert.ok(!context.evidence.includes('roots: client'));
  assert.equal(context.roots.length, 1);
});

test('client roots are checked again at the target of a junction or symlink', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pugport-roots-'));
  const plain = join(dir, 'plain');
  mkdirSync(plain);
  const links: string[] = [];
  const link = (target: string, name: string) => {
    symlinkSync(target, join(dir, name), 'junction');
    return links[links.push(join(dir, name)) - 1];
  };
  // Remove only the links, never recursively.
  t.after(() => {
    for (const path of links) unlinkSync(path);
    rmdirSync(plain);
    rmdirSync(dir);
  });
  const alias = link(plain, 'plain-alias');
  assert.equal(clientRootPath(pathToFileURL(alias).href), alias);
  if (process.platform === 'win32')
    // Every Windows has this junction to C:\Users. Never create a junction to a real broad folder here: a test killed
    // before cleanup would leave it in Temp, and some recursive deletes follow junctions.
    assert.equal(clientRootPath('file:///C:/Documents%20and%20Settings'), undefined);
  // POSIX recursive deletes do not follow symlinks, so a leftover link to home is harmless there.
  else assert.equal(clientRootPath(pathToFileURL(link(homedir(), 'home-alias')).href), undefined);
});

test('roots cache shares requests, times out without cancelling, and accepts ordered late answers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: Record<string, unknown>[] = [];
  const roots = createClientRoots((message) => sent.push(message));
  await roots.get();
  assert.equal(sent.length, 0);
  roots.initialize({ roots: {} });
  const prefetch = roots.refresh();
  const first = roots.get();
  const concurrent = roots.get();
  assert.equal(sent.length, 1);
  roots.response({ id: 1, result: { roots: [{ uri: 'file:///wrong-id-type' }] } });
  roots.response({ id: 'pugport-roots-9999', result: { roots: [{ uri: 'file:///unknown-id' }] } });
  t.mock.timers.tick(ROOTS_TIMEOUT_MS);
  assert.deepEqual(await first, []);
  assert.deepEqual(await concurrent, []);
  const second = roots.get();
  assert.equal(sent.length, 2);
  roots.response({ id: sent[0].id, result: { roots: [{ uri: 'file:///late' }] } });
  await prefetch;
  roots.response({ id: sent[1].id, error: { code: -32601 } });
  assert.deepEqual(await second, [{ uri: 'file:///late' }]);

  const older = roots.refresh();
  const newer = roots.refresh(true);
  roots.response({ id: sent[3].id, result: { roots: [] } });
  await newer;
  roots.response({ id: sent[2].id, result: { roots: [{ uri: 'file:///stale' }] } });
  await older;
  const afterRemoval = roots.get();
  roots.response({ id: sent.at(-1)!.id, result: { roots: 'invalid' } });
  assert.deepEqual(await afterRemoval, []);

  const capped = roots.get();
  roots.response({
    id: sent.at(-1)!.id,
    result: { roots: Array.from({ length: 201 }, (_, i) => ({ uri: `file:///root-${i}` })) },
  });
  assert.equal((await capped).length, 200);
  assert.ok(sent.every((message, i) => message.method === 'roots/list' && message.id === `pugport-roots-${i + 1}`));
});

test('a roots change drops the old list at once; a timeout or a late pre-change answer cannot bring it back', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: Record<string, unknown>[] = [];
  const roots = createClientRoots((message) => sent.push(message));
  roots.initialize({ roots: {} });
  const known = roots.get();
  roots.response({ id: sent[0].id, result: { roots: [{ uri: 'file:///revoked' }] } });
  assert.deepEqual(await known, [{ uri: 'file:///revoked' }]);
  // A request is in flight when the client reports a change; the client never answers the request sent after it.
  const beforeChange = roots.get();
  void roots.refresh(true);
  roots.response({ id: sent[1].id, result: { roots: [{ uri: 'file:///revoked' }] } });
  assert.deepEqual(await beforeChange, []);
  const afterTimeout = roots.get();
  t.mock.timers.tick(ROOTS_TIMEOUT_MS);
  assert.deepEqual(await afterTimeout, []);
  // The first answer to a request sent after the change is used.
  const current = roots.get();
  roots.response({ id: sent.at(-1)!.id, result: { roots: [{ uri: 'file:///kept' }] } });
  assert.deepEqual(await current, [{ uri: 'file:///kept' }]);
});

test('a completed empty timeout is retried in the same call after 30 seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let finish!: (value: CallerProbeInput) => void;
  let count = 0;
  const provider = createCallerContext(
    () =>
      ++count === 1
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve({ chain: [{ exe: 'claude', args: [] }], envNames: [], cwd: 'C:/synthetic/repo' }),
    'claude',
  );
  provider.initialize({ name: 'claude-code' });
  const first = provider.get();
  await Promise.resolve();
  t.mock.timers.tick(10_000);
  assert.equal((await first).mode, 'unknown');
  finish({ chain: [], envNames: [], timedOut: true });
  await Promise.resolve();
  t.mock.timers.tick(30_000);
  assert.equal((await provider.get()).mode, 'write');
  assert.equal(count, 2);
});
