import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve, join, parse } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { isTrustedPath, projectPatchSchema, projectTrusted, projectTrustReader } from '../src/server/project-trust.ts';
import { userFolders } from '../src/server/platform/dirs.ts';
import { ProjectMcpControl, ProjectTrustControl } from '../src/ui/Workspace.tsx';
import type { Project } from '../src/shared/types.ts';

const project: Project = {
  id: 'synthetic-project',
  name: 'Synthetic',
  path: resolve('SyntheticProject'),
  trusted: true,
  createdAt: '',
  updatedAt: '',
};

test('snapshot trust batching preserves individual authorization decisions', () => {
  const read = projectTrustReader(tmpdir());
  for (const path of [project.path, homedir(), tmpdir(), parse(project.path).root, join(homedir(), '.private')])
    for (const trusted of [true, false, undefined]) {
      const value = { ...project, path, trusted };
      assert.equal(read(value), projectTrusted(value, tmpdir()));
    }
});

test('project trust covers resolved descendants and worktrees, but not siblings or traversal outside', () => {
  for (const path of [
    project.path,
    join(project.path, 'src'),
    join(project.path, '.claude/worktrees/task'),
    join(project.path, 'src/../tests'),
  ])
    assert.equal(isTrustedPath(path, [project]), true, path);
  for (const path of [project.path + '-other', join(project.path, '../outside'), resolve('elsewhere')])
    assert.equal(isTrustedPath(path, [project]), false, path);
  assert.equal(isTrustedPath(project.path.toUpperCase(), [project]), process.platform === 'win32');
  assert.equal(isTrustedPath(project.path, [{ ...project, trusted: undefined }]), true);
  assert.equal(isTrustedPath(project.path, [{ ...project, trusted: false }]), false);
  assert.equal(isTrustedPath(project.path, [{ ...project, scope: 'chat' }]), false);
  assert.equal(isTrustedPath(project.path, [{ ...project, trusted: false }, project]), false);
});

test('effective trust excludes sensitive default paths and honors the most specific project', () => {
  const data = join(homedir(), 'synthetic-data');
  const at = (path: string, trusted?: boolean) => ({ ...project, path, trusted });
  for (const path of [
    join(homedir(), '.ssh'),
    join(homedir(), 'AppData', 'x'),
    userFolders().documents,
    join(data, 'x'),
    join(tmpdir(), 'x'),
    join(userFolders().downloads, 'x'),
  ])
    assert.equal(projectTrusted(at(path), data), false, path);
  assert.equal(projectTrusted(at(join(userFolders().documents, 'sub')), data), true);
  assert.equal(projectTrusted(at(join(tmpdir(), 'x'), true), data), true);
  for (const path of [parse(homedir()).root, homedir(), data])
    assert.equal(projectTrusted(at(path, true), data), false);
  const parent = at(join(userFolders().documents, 'parent'));
  const child = at(join(parent.path, 'child'), false);
  assert.equal(isTrustedPath(join(child.path, 'file'), [parent, child], data), false);
  assert.equal(isTrustedPath(parent.path + '-sibling', [parent], data), false);
  assert.equal(
    isTrustedPath(join(parent.path, 'file'), [{ ...parent, removedAt: '2026-10-28T00:00:00.000Z' }], data),
    false,
  );
});

test('project PATCH permits removing trust, rejects granting trust, and preserves rename validation', () => {
  assert.equal(projectPatchSchema.safeParse({ trusted: true }).success, false);
  assert.deepEqual(projectPatchSchema.parse({ trusted: false }), { trusted: false });
  assert.equal(projectPatchSchema.safeParse({ name: ' Renamed ', trusted: true }).success, false);
  assert.deepEqual(projectPatchSchema.parse({ name: 'Renamed' }), { name: 'Renamed' });
  for (const trusted of ['true', 'false', 1, 0, null, [], {}])
    assert.equal(projectPatchSchema.safeParse({ trusted }).success, false);
  for (const patch of [{}, { trusted: true, path: 'elsewhere' }, { name: '' }])
    assert.equal(projectPatchSchema.safeParse(patch).success, false);
});

test('project trust toggle renders its label, explanation, off/on and disabled states', () => {
  const render = (trusted: boolean, disabled = false) =>
    renderToStaticMarkup(createElement(ProjectTrustControl, { trusted, disabled, onChange() {} }));
  const off = render(false);
  assert.match(off, /信任此项目（Codex 不使用沙箱）/);
  assert.match(off, /在你自己的项目里，测试可以开端口、联网；别人的文字和只读任务不受影响/);
  assert.match(off, /type="checkbox"/);
  assert.doesNotMatch(off, /checked=""/);
  assert.match(render(true), /checked=""/);
  assert.match(render(true, true), /disabled=""/);
});

test('project MCP PATCH distinguishes inheritance, empty scope and selected stable IDs', () => {
  for (const mcpServers of [null, [], ['installed'], ['disabled', 'installed']])
    assert.deepEqual(projectPatchSchema.parse({ mcpServers }), { mcpServers });
  for (const mcpServers of [
    '',
    {},
    [1],
    [''],
    ['same', 'same'],
    ['x'.repeat(129)],
    Array.from({ length: 257 }, (_, i) => String(i)),
  ])
    assert.equal(projectPatchSchema.safeParse({ mcpServers }).success, false);
  assert.equal(projectPatchSchema.safeParse({ trusted: true, mcpServers: [] }).success, false);
});

test('project MCP settings show effective global intersection and preserve selected disabled servers', () => {
  const servers = [
    { id: 'on', name: 'Enabled server', enabled: true },
    { id: 'off', name: 'Disabled server', enabled: false },
  ];
  const render = (selected?: string[], disabled = false) =>
    renderToStaticMarkup(createElement(ProjectMcpControl, { servers, selected, disabled, onChange() {} }));
  assert.match(render(), /继承全局已启用的 MCP/);
  assert.match(render(), /当前生效：Enabled server/);
  assert.match(render(['off']), /当前生效：无/);
  assert.match(render(['off']), /全局已停用，当前不生效/);
  assert.match(render(['off']), /checked=""/);
  assert.match(render([]), /本项目已禁用全部 MCP/);
  assert.match(render(['removed']), /已卸载，请取消选择/);
  assert.match(render(['on'], true), /fieldset[^>]*disabled=""/);
});
