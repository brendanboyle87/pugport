import assert from 'node:assert/strict';
import test from 'node:test';
import { homedir } from 'node:os';
import { resolve, parse } from 'node:path';
import { electronModule } from './helpers/electron-harness.ts';
import { assertCallerNarrowing } from '../src/shared/permission-change.ts';
import { desktopPermissionChange } from '../src/server/permission-change.ts';
import { canTrustPath, isTrustedPath } from '../src/server/project-trust.ts';
import type { Workspace } from '../src/server/workspace.ts';
import type { Project, Settings } from '../src/shared/types.ts';

test('HTTP settings permit narrowing but reject widening, including omission of a read-only setting', () => {
  assertCallerNarrowing({ codex: 'write' }, { codex: 'inherit' });
  assertCallerNarrowing({ codex: 'inherit' }, { codex: 'read-only' });
  assertCallerNarrowing({ codex: 'read-only' }, undefined);
  assert.throws(() => assertCallerNarrowing({}, { codex: 'write' }), /桌面应用/);
  assert.throws(() => assertCallerNarrowing({ codex: 'read-only' }, {}), /桌面应用/);
  assert.throws(() => assertCallerNarrowing({ codex: 'read-only' }, { codex: 'inherit' }), /桌面应用/);
});

test('trust rejects broad folders both when granting and when reading old grants', () => {
  const appData = process.env.APPDATA ?? resolve('synthetic-appdata');
  const dataDir = resolve(appData, 'PugPort', 'data');
  for (const path of [parse(process.cwd()).root, homedir(), resolve(homedir(), '..'), appData, dataDir]) {
    assert.equal(canTrustPath(path, dataDir), false);
    assert.equal(isTrustedPath(path, [{ path, trusted: true } as Project], dataDir), false);
    assert.equal(isTrustedPath(dataDir, [{ path, trusted: true } as Project], dataDir), false);
  }
  assert.equal(canTrustPath(resolve('synthetic-project'), dataDir), true);
});

test('native permission IPC accepts/cancels, validates ownership and writes only after the dialog', async () => {
  const { createPermissionChange } = await electronModule('src/electron/permission-change.ts', { app: {} });
  const project: Project = {
    id: 'project',
    name: 'Synthetic project',
    path: resolve('synthetic-project'),
    createdAt: '',
    updatedAt: '',
  };
  const settings = { externalCallers: { codex: 'read-only' } } as Settings;
  const writes: unknown[] = [];
  const workspace = {
    store: { get: () => project },
    controller: {
      dataDir: resolve('synthetic-data'),
      settings,
      updateSettings(patch: Partial<Settings>) {
        writes.push(patch);
        Object.assign(settings, patch);
      },
    },
    updateProject(_id: string, patch: Partial<Project>) {
      writes.push(patch);
      Object.assign(project, patch);
    },
  } as unknown as Workspace;
  const frame = { url: 'http://127.0.0.1:4317' };
  const window = { isDestroyed: () => false, webContents: { mainFrame: frame } };
  const event = { sender: window.webContents, senderFrame: frame };
  for (const change of [
    { kind: 'project', id: 'project', trusted: true },
    { kind: 'caller', tool: 'codex', mode: 'write' },
  ]) {
    let response = 0;
    const handler = createPermissionChange(
      () => window,
      frame.url,
      async (_owner: unknown, options: any) => {
        assert.match(
          options.message,
          change.kind === 'project' ? /Synthetic project.*\n.*synthetic-project/ : /Codex.*\n.*总是可写入/,
        );
        assert.equal(options.cancelId, 0);
        return { response };
      },
      (value: unknown, apply: boolean, expected?: string) =>
        Promise.resolve(desktopPermissionChange(workspace, value, apply, expected)),
    );
    const count = writes.length;
    assert.equal(await handler(event, change), false);
    assert.equal(writes.length, count);
    response = 1;
    assert.equal(await handler(event, change), true);
    assert.equal(writes.length, count + 1);
    await assert.rejects(handler({ ...event, senderFrame: { url: frame.url } }, change), /主窗口/);
    assert.equal(writes.length, count + 1);
  }
  assert.equal(project.trusted, true);
  assert.equal(settings.externalCallers?.codex, 'write');
  await assert.rejects(
    () => desktopPermissionChange(workspace, { kind: 'project', id: 'project', trusted: false }, true, 'stale'),
    /重新确认/,
  );
});
