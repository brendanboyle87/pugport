import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, win32 } from 'node:path';
import { prepareSandboxExecution } from '../src/server/sandbox/execution.ts';
import { containsPath } from '../src/server/sandbox/policy-builder.ts';
import { mxcRuntime } from '../src/server/sandbox/mxc-runtime.ts';
import type { RunInput, RuntimeTarget, Settings } from '../src/shared/types.ts';

test('native policy permits only the host-bound child checkout and read-only common metadata', async (t) => {
  // The MXC sandbox runs only on Windows x64 (mxc-runtime refuses other systems) and builds its policy in Windows
  // paths, so elsewhere this policy is never applied and its path comparisons do not hold.
  if (process.platform !== 'win32') return t.skip('the MXC sandbox policy is applied only on Windows');
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'managed-sandbox-policy-')));
  const dataDir = join(root, 'data');
  const home = join(dataDir, 'workspaces', 'managed-children', 'child-id');
  const checkout = join(home, 'checkout');
  const sibling = join(dataDir, 'workspaces', 'managed-children', 'other-id', 'checkout');
  const original = join(root, 'original');
  const common = join(original, '.git');
  for (const path of [checkout, sibling, common]) mkdirSync(path, { recursive: true });
  writeFileSync(join(home, 'workspace.json'), '{}');
  writeFileSync(join(dataDir, 'private.json'), '{}');
  t.after(() => {
    assert.equal(dirname(root), realpathSync.native(tmpdir()));
    assert.ok(basename(root).startsWith('managed-sandbox-policy-'));
    rmSync(root, { recursive: true, force: true });
  });
  t.mock.method(mxcRuntime, 'probe', async () => ({
    available: true,
    reason: 'ready',
    message: 'fixture',
    sdkVersion: '1.0.1',
  }));
  const target: RuntimeTarget = {
    id: 'synthetic-claude',
    provider: 'claude',
    label: 'Fixture',
    command: 'unused',
    environment: 'native',
    enabled: true,
  };
  const settings = { sandbox: { claude: 'learn' } } as Settings;
  const binding = { directory: checkout, repositoryCommonDirectory: common };
  for (const permissionMode of ['read-only', 'workspace-write'] as const) {
    const input: RunInput = { prompt: 'synthetic', projectPath: checkout, kind: 'general', permissionMode };
    const execution = await prepareSandboxExecution(target, input, settings, root, dataDir, undefined, binding);
    assert.ok(execution);
    try {
      const filesystem = execution.request.filesystem!;
      assert.equal(
        filesystem.readwritePaths?.includes(win32.normalize(checkout)) ?? false,
        permissionMode === 'workspace-write',
      );
      assert.equal(
        filesystem.readonlyPaths?.includes(win32.normalize(checkout)) ?? false,
        permissionMode === 'read-only',
      );
      assert.ok(
        filesystem.readonlyPaths?.includes(win32.normalize(common)),
        'git status/diff can read common objects and refs',
      );
      assert.equal(filesystem.readwritePaths?.some((path) => containsPath(path, common)) ?? false, false);
      assert.equal(filesystem.readwritePaths?.some((path) => containsPath(path, original)) ?? false, false);
      for (const privatePath of [sibling, join(home, 'workspace.json'), join(dataDir, 'private.json')])
        assert.ok(
          filesystem.deniedPaths?.some((path) => containsPath(path, privatePath)),
          privatePath,
        );
      assert.equal(
        filesystem.deniedPaths?.some((path) => containsPath(path, checkout)),
        false,
      );
    } finally {
      await execution.dispose();
    }
  }
  const untrustedInput = {
    prompt: 'synthetic',
    projectPath: checkout,
    kind: 'general',
    permissionMode: 'workspace-write',
    managedWorkspace: binding,
  } as RunInput;
  const unbound = await prepareSandboxExecution(target, untrustedInput, settings, root, dataDir);
  assert.ok(unbound);
  try {
    assert.equal(unbound.request.filesystem?.readwritePaths?.includes(win32.normalize(checkout)), false);
    assert.ok(unbound.request.filesystem?.deniedPaths?.some((path) => containsPath(path, checkout)));
  } finally {
    await unbound.dispose();
  }
  await assert.rejects(
    () =>
      prepareSandboxExecution(
        target,
        { ...untrustedInput, projectPath: sibling },
        settings,
        root,
        dataDir,
        undefined,
        binding,
      )!,
    /directory changed/,
  );
  const internalOriginal = join(dataDir, 'workspaces', 'original');
  const internalCommon = join(internalOriginal, '.git');
  mkdirSync(internalCommon, { recursive: true });
  writeFileSync(join(internalOriginal, 'parent-file.txt'), 'private parent file');
  const internal = await prepareSandboxExecution(target, untrustedInput, settings, root, dataDir, undefined, {
    ...binding,
    repositoryCommonDirectory: internalCommon,
  });
  assert.ok(internal);
  try {
    assert.ok(internal.request.filesystem?.readonlyPaths?.includes(win32.normalize(internalCommon)));
    assert.equal(
      internal.request.filesystem?.readwritePaths?.some((path) => containsPath(path, internalCommon)),
      false,
    );
    assert.ok(
      internal.request.filesystem?.deniedPaths?.some((path) =>
        containsPath(path, join(internalOriginal, 'parent-file.txt')),
      ),
    );
    assert.equal(internal.request.filesystem?.readonlyPaths?.includes(win32.normalize(internalOriginal)), false);
  } finally {
    await internal.dispose();
  }
  await assert.rejects(
    () =>
      prepareSandboxExecution(target, untrustedInput, settings, root, dataDir, undefined, {
        ...binding,
        repositoryCommonDirectory: dataDir,
      })!,
    /protected application data/,
  );
  const redirected = join(root, 'redirected-git');
  symlinkSync(common, redirected, 'junction');
  await assert.rejects(
    () =>
      prepareSandboxExecution(target, untrustedInput, settings, root, dataDir, undefined, {
        ...binding,
        repositoryCommonDirectory: redirected,
      })!,
    /metadata directory changed/,
  );
});

test('learn mode adds host-decided Git paths to the writable set and leaves everything else as is', async (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'managed-sandbox-git-')));
  const dataDir = join(root, 'data');
  const checkout = join(root, 'lane');
  const common = join(root, 'repo', '.git');
  const gitDirectory = join(common, 'worktrees', 'lane');
  for (const path of [dataDir, checkout, gitDirectory, join(common, 'objects'), join(common, 'refs')])
    mkdirSync(path, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.mock.method(mxcRuntime, 'probe', async () => ({
    available: true,
    reason: 'ready',
    message: 'fixture',
    sdkVersion: '1.0.1',
  }));
  const target: RuntimeTarget = {
    id: 'synthetic-claude',
    provider: 'claude',
    label: 'Fixture',
    command: 'unused',
    environment: 'native',
    enabled: true,
  };
  const settings = { sandbox: { claude: 'learn' } } as Settings;
  const gitWritePaths = [gitDirectory, join(common, 'objects'), join(common, 'refs')];
  const input: RunInput = {
    prompt: 'synthetic',
    projectPath: checkout,
    kind: 'general',
    permissionMode: 'workspace-write',
  };
  const plain = await prepareSandboxExecution(target, input, settings, root, dataDir);
  const withGit = await prepareSandboxExecution(target, { ...input, gitWritePaths }, settings, root, dataDir);
  assert.ok(plain && withGit);
  try {
    const writable = withGit.request.filesystem!.readwritePaths ?? [];
    for (const path of gitWritePaths) assert.ok(writable.includes(win32.normalize(path)), path);
    assert.ok(!(plain.request.filesystem!.readwritePaths ?? []).includes(win32.normalize(gitDirectory)));
    assert.ok(!writable.includes(win32.normalize(common)), 'the common directory itself is never writable');
    assert.deepEqual(withGit.request.network, plain.request.network);
  } finally {
    await plain.dispose();
    await withGit.dispose();
  }
});
