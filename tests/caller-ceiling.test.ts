import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inheritedCeiling, callerWrite, narrowCeiling } from '../src/server/caller-ceiling.ts';
import type { CallerContext } from '../src/shared/caller-signals.ts';
import { permissionLine } from '../src/shared/permission-reason.ts';

const caller = (mode: CallerContext['mode'], extra: Partial<CallerContext> = {}): CallerContext => ({
  client: 'codex',
  mode,
  roots: ['C:/synthetic/repo'],
  evidence: [],
  verified: true,
  ...extra,
});

test('verified local AI can write to another trusted project', () => {
  const path = 'C:/synthetic/other';
  assert.equal(
    inheritedCeiling(caller('write', { client: 'claude' }), path, 'inherit', () => true).mode,
    'workspace-write',
  );
  for (const context of [caller('write', { client: 'terminal' }), caller('write', { client: 'unknown' })])
    assert.equal(inheritedCeiling(context, path, 'inherit', () => true).mode, 'read-only');
  assert.equal(inheritedCeiling(caller('write', { client: 'claude' }), path, 'inherit', () => false).mode, 'read-only');
  assert.equal(inheritedCeiling(caller('write', { client: 'claude' }), path).mode, 'read-only');
  assert.equal(
    inheritedCeiling(caller('write', { client: 'claude', verified: false }), path, 'inherit', () => true).mode,
    'read-only',
  );
});

test('caller ceiling: modes and explicit requests', () => {
  assert.throws(
    () => callerWrite(inheritedCeiling(caller('unknown', { client: 'unknown' }), 'C:/synthetic/repo'), true),
    /该工具不支持写入/,
  );
  for (const [mode, expected] of [
    ['write', 'workspace-write'],
    ['read-only', 'read-only'],
    ['write-anywhere', 'workspace-write'],
    ['unknown', 'read-only'],
  ] as const) {
    const ceiling = inheritedCeiling(caller(mode), 'C:/synthetic/repo/sub');
    assert.equal(ceiling.origin.unrestricted === true, false);
    assert.equal(ceiling.mode, expected);
    assert.equal(callerWrite(ceiling), expected === 'workspace-write');
    assert.equal(callerWrite(ceiling, false), false);
    if (mode === 'read-only') assert.throws(() => callerWrite(ceiling, true), /Codex（只读沙箱）不能派可写任务/);
    else if (mode === 'unknown') assert.throws(() => callerWrite(ceiling, true), /接入其他工具.*总是可写入/);
    else assert.equal(callerWrite(ceiling, true), true);
  }
  const unknown = inheritedCeiling(undefined, 'C:/synthetic/repo');
  assert.equal(callerWrite(unknown), false);
  assert.equal(unknown.mode, 'read-only');
  assert.match(unknown.reason!, /调用方信息/);
  assert.throws(() => callerWrite(unknown, true), /调用方信息/);
  assert.equal(permissionLine(unknown.origin), '来源未知：按参数执行');
});

test('caller ceiling: containment handles separators, traversal, cwd, drive and WSL paths', () => {
  for (const project of ['C:/synthetic/repo', 'c:\\SYNTHETIC\\repo\\child', '/mnt/c/synthetic/repo/child'])
    assert.equal(inheritedCeiling(caller('write'), project).mode, 'workspace-write');
  for (const project of [
    'C:/synthetic/repo-other',
    'C:/synthetic/repo/../other',
    'D:/synthetic/repo',
    'relative/path',
    undefined,
  ]) {
    const ceiling = inheritedCeiling(caller('write'), project);
    assert.equal(ceiling.mode, 'read-only');
    assert.equal(ceiling.reason, 'project_path 在 Codex 的工作目录之外');
    assert.throws(() => callerWrite(ceiling, true), /工作目录之外/);
  }
  assert.equal(
    inheritedCeiling(caller('write', { roots: [], cwd: '/synthetic/repo' }), '/synthetic/repo/sub').mode,
    'workspace-write',
  );
  assert.equal(inheritedCeiling(caller('write', { roots: ['/synthetic/repo'] }), '/synthetic/Repo').mode, 'read-only');
  assert.equal(inheritedCeiling(caller('write-anywhere'), 'D:/elsewhere').mode, 'workspace-write');
});

test('caller ceiling: overrides stay scoped and unknown cannot bypass read-only override', () => {
  for (const mode of ['read-only', 'write', 'write-anywhere', 'unknown'] as const) {
    const context = caller(mode);
    assert.equal(inheritedCeiling(context, 'C:/synthetic/repo', 'write').mode, 'workspace-write');
    assert.equal(inheritedCeiling(context, 'C:/synthetic/repo', 'write').origin.unrestricted, true);
    assert.equal(inheritedCeiling(context, 'D:/outside', 'write').mode, 'read-only');
    const stopped = inheritedCeiling(context, 'C:/synthetic/repo', 'read-only');
    assert.equal(stopped.mode, 'read-only');
    assert.throws(() => callerWrite(stopped, true), /设为只读/);
  }
});

test('stored ceilings never widen default writes or sandbox bypass privileges', () => {
  const path = 'C:/synthetic/repo';
  const full = inheritedCeiling(caller('write-anywhere'), path);
  const sandboxed = inheritedCeiling(caller('write'), path);
  const readonly = inheritedCeiling(caller('read-only'), path);
  const legacy = inheritedCeiling(undefined, path);
  assert.equal(narrowCeiling(full, sandboxed).origin.unrestricted, false);
  assert.equal(narrowCeiling(sandboxed, full).origin.unrestricted, false);
  assert.equal(callerWrite(narrowCeiling(full, legacy)), false);
  assert.throws(() => callerWrite(narrowCeiling(full, readonly), true), /只读/);
});

test('caller ceiling: permission lines identify inherited scope and unverified callers', () => {
  const writable = inheritedCeiling(caller('write', { client: 'claude' }), 'C:/synthetic/repo');
  assert.equal(permissionLine(writable.origin), '继承自 Claude Code：可写入 · C:/synthetic/repo');
  assert.equal(
    permissionLine(inheritedCeiling(caller('read-only'), 'C:/synthetic/repo').origin),
    '继承自 Codex（只读沙箱）：只读',
  );
  const wsl = inheritedCeiling(
    caller('write', { verified: false, roots: ['/mnt/c/synthetic/repo'] }),
    'C:/synthetic/repo',
  );
  assert.equal(wsl.mode, 'read-only');
  assert.match(permissionLine(wsl.origin), /未核验/);
});

test('Claude client roots widen location only; stored refusals still require a new dispatch', () => {
  const project = 'D:/synthetic/added/project';
  const roots = ['C:/synthetic/repo', 'D:/synthetic/added'];
  const writable = caller('write', { client: 'claude', roots, cwd: 'C:/synthetic/repo' });
  assert.equal(inheritedCeiling(writable, project, 'inherit').mode, 'workspace-write');
  for (const mode of ['read-only', 'unknown'] as const) {
    const context = { ...writable, mode };
    assert.equal(inheritedCeiling(context, project, 'inherit').mode, 'read-only');
    assert.equal(inheritedCeiling(context, project, 'write').mode, 'workspace-write');
  }
  assert.equal(inheritedCeiling({ ...writable, client: 'unknown' }, project).mode, 'read-only');
  const refused = inheritedCeiling({ ...writable, roots: ['C:/synthetic/repo'] }, project);
  const allowed = inheritedCeiling(writable, project);
  assert.equal(narrowCeiling(allowed, refused), refused);
  assert.throws(() => callerWrite(narrowCeiling(allowed, refused), true), /工作目录之外/);
  assert.equal(narrowCeiling(refused, allowed).mode, 'read-only');
});

test('caller ceiling: network is carried from the caller context and only narrows', () => {
  const project = 'C:/synthetic/repo';
  assert.equal(inheritedCeiling(caller('write', { network: true }), project).origin.network, true);
  assert.equal(inheritedCeiling(caller('write'), project).origin.network, false);
  assert.equal(inheritedCeiling(caller('write-anywhere', { network: true }), project).origin.network, true);
  assert.equal(inheritedCeiling(caller('read-only', { network: true }), project).origin.network, undefined);
  const on = inheritedCeiling(caller('write', { network: true }), project);
  const off = inheritedCeiling(caller('write'), project);
  assert.equal(narrowCeiling(on, off).origin.network, false);
  assert.equal(narrowCeiling(on, on).origin.network, true);
  assert.equal(narrowCeiling(off, on).origin.network, false);
});

test('missing caller context cannot request write', () => {
  assert.throws(() => callerWrite(inheritedCeiling(undefined, 'C:/synthetic/repo'), true), /调用方信息/);
});

test('legacy unverified client cannot inherit write but override still applies', () => {
  const legacy = caller('write', { client: 'claude', verified: false });
  assert.equal(inheritedCeiling(legacy, 'C:/synthetic/repo').mode, 'read-only');
  assert.equal(callerWrite(inheritedCeiling(legacy, 'C:/synthetic/repo'), false), false);
  assert.equal(inheritedCeiling(legacy, 'C:/synthetic/repo', 'write').mode, 'workspace-write');
});

test('terminal has scoped write and timeout requests retry', () => {
  const context = caller('write', { client: 'terminal', verified: false });
  const allowed = inheritedCeiling(context, 'C:/synthetic/repo/sub');
  assert.equal(allowed.mode, 'workspace-write');
  assert.equal(permissionLine(allowed.origin), '继承自 终端：可写入 · C:/synthetic/repo/sub');
  assert.deepEqual(context.roots, ['C:/synthetic/repo']);
  assert.throws(
    () => callerWrite(inheritedCeiling(caller('unknown', { evidence: ['probe: timeout'] }), 'C:/synthetic/repo'), true),
    /请重试/,
  );
});
