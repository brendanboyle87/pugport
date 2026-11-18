import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMain } from 'electron';
import { createRendererConfirmation } from '../src/electron/renderer-confirmation.ts';
import { CONFIRMATION_READY_CHANNEL, CONFIRMATION_ANSWER_CHANNEL } from '../src/electron/channels.ts';

test('desktop confirmations reject other windows, subframes and stale answers; navigation cancels safely', async () => {
  const ipc = new EventEmitter();
  const frame = { url: 'http://localhost:4317/' };
  const messages: unknown[][] = [];
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: frame,
    isDestroyed: () => false,
    send: (...args: unknown[]) => messages.push(args),
  });
  const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false });
  const bridge = createRendererConfirmation(
    ipc as IpcMain,
    window as unknown as BrowserWindow,
    'http://localhost:4317',
  );
  const event = { sender: contents, senderFrame: frame };
  const options = { title: '退出 PugPort？', action: '退出 PugPort' };
  assert.equal(bridge.ask(options), undefined, 'not ready: caller may use the native fallback');
  ipc.emit(CONFIRMATION_READY_CHANNEL, { sender: {}, senderFrame: frame }, true);
  assert.equal(bridge.ask(options), undefined, 'another window cannot register');
  ipc.emit(CONFIRMATION_READY_CHANNEL, event, true);
  const pending = bridge.ask(options)!;
  const id = messages[0]![1];
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  for (const [sender, request, answer] of [
    [{ sender: {}, senderFrame: frame }, id, true],
    [{ sender: contents, senderFrame: { url: frame.url } }, id, true],
    [event, 'stale', true],
    [event, id, 'true'],
  ])
    ipc.emit(CONFIRMATION_ANSWER_CHANNEL, sender, request, answer);
  await Promise.resolve();
  assert.equal(settled, false);
  ipc.emit(CONFIRMATION_ANSWER_CHANNEL, event, id, true);
  assert.equal(await pending, true);
  const reloading = bridge.ask(options)!;
  contents.emit('did-start-navigation', {}, frame.url, false, true);
  assert.equal(await reloading, false);
  assert.equal(bridge.ask(options), undefined);
  ipc.emit(CONFIRMATION_READY_CHANNEL, event, true);
  const crashing = bridge.ask(options)!;
  contents.emit('render-process-gone');
  assert.equal(await crashing, false);
  bridge.dispose();
  assert.equal(ipc.listenerCount(CONFIRMATION_ANSWER_CHANNEL), 0);
});
