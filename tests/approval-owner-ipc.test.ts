import assert from 'node:assert/strict';
import test from 'node:test';
import { electronModule } from './helpers/electron-harness.ts';
import { desktopPermissionChange } from '../src/server/permission-change.ts';
import type { Workspace } from '../src/server/workspace.ts';

test('approval IPC requires the owned main frame and forwards allow and remember', async () => {
  const { createPermissionChange } = await electronModule('src/electron/permission-change.ts', { app: {} });
  const calls: unknown[] = [];
  const approvals = new Map([
    ['a', {}],
    ['b', {}],
  ]);
  const workspace = {
    controller: {
      approvals,
      answerApproval: (...args: unknown[]) => {
        calls.push(args);
        approvals.delete(args[0] as string);
      },
    },
  } as unknown as Workspace;
  const frame = { url: 'http://127.0.0.1:4317/' };
  const window = { isDestroyed: () => false, webContents: { mainFrame: frame } };
  const event = { sender: window.webContents, senderFrame: frame };
  const handler = createPermissionChange(
    () => window,
    new URL(frame.url).origin,
    async () => {
      throw Error('unexpected dialog');
    },
    (value: unknown, apply: boolean, expected?: string) => desktopPermissionChange(workspace, value, apply, expected),
  );
  await assert.rejects(
    handler({ ...event, senderFrame: { url: frame.url } }, { kind: 'approval', id: 'a', allow: true }),
    /\u4e3b\u7a97\u53e3/,
  );
  assert.equal(await handler(event, { kind: 'approval', id: 'a', allow: true }), true);
  assert.equal(await handler(event, { kind: 'approval', id: 'b', allow: true, remember: true }), true);
  assert.deepEqual(calls, [
    ['a', true, undefined],
    ['b', true, true],
  ]);
  await assert.rejects(handler(event, { kind: 'approval', id: 'a', allow: true }), /\u5931\u6548/);
  await assert.rejects(handler(event, { kind: 'approval', id: 'unknown', allow: true }), /\u5931\u6548/);
});
