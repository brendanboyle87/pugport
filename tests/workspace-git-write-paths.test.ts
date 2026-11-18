import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from '../src/server/platform/test-process.ts';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import type { ManagedWorktree } from '../src/shared/managed-worktrees.ts';
import type { RunInput } from '../src/shared/types.ts';

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (
    await run(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'user.name=Synthetic',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd, windowsHide: true },
    )
  ).stdout.trim();

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pugport-workspace-git-')));
  const home = join(root, 'home');
  await mkdir(home);
  const environment = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    CODEX_HOME: join(home, 'codex'),
    CLAUDE_CONFIG_DIR: join(home, 'claude'),
    COMBORUNNER_MEMORY_DIR: join(root, 'memory'),
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const data = join(root, 'data');
  const controller = new Controller(root, data, { readAccountIdentity: () => 'fixture' });
  clearInterval(controller.timer);
  controller.targets = [];
  controller.snapshots = [];
  const workspace = new Workspace(controller, { autoTick: false, memoryDebounceMs: 100000 });
  t.after(async () => {
    await workspace.close();
    await controller.close();
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  const probe = (projectPath: string, workflowId?: string) =>
    controller.gitWritePathsFor!(
      {
        prompt: 'Synthetic task',
        kind: 'general',
        permissionMode: 'workspace-write',
        projectPath,
        workflowId,
      } satisfies RunInput,
      new AbortController().signal,
    );
  return { root, data, controller, workspace, probe };
}

async function repository(root: string) {
  const main = join(root, 'main');
  await mkdir(main, { recursive: true });
  await git(main, 'init');
  await writeFile(join(main, 'fixture.txt'), 'Synthetic baseline\n');
  await git(main, 'add', '.');
  await git(main, 'commit', '-m', 'Synthetic baseline');
  return { main, common: join(main, '.git') };
}

test('workspace Git hook uses branch record paths without a Git probe and excludes snapshot records', async (t) => {
  const f = await fixture(t);
  const directory = join(f.data, 'workspaces', 'managed-children', 'child', 'checkout');
  const common = join(f.root, 'recorded-common');
  const gitDirectory = join(common, 'worktrees', 'child');
  const paths = [gitDirectory, join(common, 'objects'), join(common, 'refs'), join(common, 'logs')];
  for (const path of [directory, ...paths]) await mkdir(path, { recursive: true });
  const record: ManagedWorktree = {
    version: 1,
    id: 'child',
    projectId: 'project',
    ownerWorkflowId: 'workflow',
    parentWorkflowId: 'parent',
    directory,
    sourceDirectory: f.root,
    repositoryCommonDirectory: common,
    gitDirectory,
    branch: 'synthetic',
    mode: 'branch',
    state: 'ready',
    createdAt: '',
    updatedAt: '',
  };
  const save = () =>
    f.workspace.store.save('workflow', 'workflow', 'conversation', {
      id: 'workflow',
      projectId: 'project',
      executionWorkspaceId: 'child',
      executionWorkspace: record,
    });
  save();
  const source = {
    id: 'project',
    name: 'Synthetic',
    path: join(f.root, 'source'),
    trusted: true,
    createdAt: '',
    updatedAt: '',
  };
  f.workspace.store.save('project', source.id, source.id, source);
  const input = {
    prompt: 'Synthetic task',
    kind: 'general',
    permissionMode: 'workspace-write',
    projectPath: directory,
    workflowId: 'workflow',
  } satisfies RunInput;
  assert.equal(f.controller.managedExecutionWorkspace?.(input)?.sourceTrusted, true);
  assert.equal(f.controller.managedExecutionWorkspace?.({ ...input, projectPath: `${directory}-other` }), undefined);
  f.workspace.store.save('project', source.id, source.id, { ...source, trusted: false });
  assert.equal(f.controller.managedExecutionWorkspace?.(input)?.sourceTrusted, false);
  f.workspace.store.save('project', source.id, source.id, { ...source, removedAt: '2026-01-01' });
  assert.equal(f.controller.managedExecutionWorkspace?.(input)?.sourceTrusted, false);
  // These ordinary directories are not a repository: the known host record supplies all Git paths.
  assert.deepEqual((await f.probe(directory, 'workflow')).paths, paths);
  record.mode = 'snapshot';
  save();
  assert.deepEqual((await f.probe(directory, 'workflow')).paths, []);
});

test('workspace Git hook denies a data checkout without its matching workflow record', async (t) => {
  const f = await fixture(t);
  const { main } = await repository(f.root);
  const directory = join(f.data, 'workspaces', 'managed-children', 'snapshot', 'checkout');
  await mkdir(join(directory, '..'), { recursive: true });
  await git(main, 'worktree', 'add', '--detach', directory);
  assert.deepEqual((await f.probe(directory)).paths, []);
  assert.deepEqual((await f.probe(directory, 'missing-workflow')).paths, []);
});

test('workspace Git hook denies data metadata even when the checkout is outside data', async (t) => {
  const f = await fixture(t);
  const { main } = await repository(f.data);
  const lane = join(f.root, 'external-checkout');
  await git(main, 'worktree', 'add', '--detach', lane);
  assert.deepEqual((await f.probe(lane)).paths, []);
});

test('workspace Git hook reports a main checkout without writable metadata', async (t) => {
  const f = await fixture(t);
  const { main } = await repository(f.root);
  assert.deepEqual(await f.probe(main), { paths: [], mainCheckout: true });
});
