import { randomUUID } from 'node:crypto';
import type { BrowserWindow, IpcMain, IpcMainEvent } from 'electron';
import type { Confirmation } from '../shared/confirmation.ts';
import { CONFIRMATION_CHANNEL, CONFIRMATION_READY_CHANNEL, CONFIRMATION_ANSWER_CHANNEL } from './channels.ts';

/** Only the main window's mounted dialog host can answer a desktop question. */
export function createRendererConfirmation(ipc: IpcMain, window: BrowserWindow, origin: string) {
  let ready = false;
  let pending: { id: string; finish: (answer: boolean) => void } | undefined;
  const trusted = (event: IpcMainEvent) => {
    if (window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame)
      return false;
    try {
      return new URL(event.senderFrame.url).origin === origin;
    } catch {
      return false;
    }
  };
  const settle = (answer: boolean) => {
    const question = pending;
    pending = undefined;
    question?.finish(answer);
  };
  const unavailable = () => {
    ready = false;
    settle(false);
  };
  const readiness = (event: IpcMainEvent, value: unknown) => {
    if (!trusted(event)) return;
    ready = value === true;
    if (!ready) settle(false);
  };
  const answer = (event: IpcMainEvent, id: unknown, value: unknown) => {
    if (trusted(event) && pending?.id === id && typeof value === 'boolean') settle(value);
  };
  ipc.on(CONFIRMATION_READY_CHANNEL, readiness);
  ipc.on(CONFIRMATION_ANSWER_CHANNEL, answer);
  const contents = window.webContents;
  const navigation = (_event: unknown, _url: string, _inPlace: boolean, mainFrame: boolean) => {
    if (mainFrame) unavailable();
  };
  contents.on('did-start-navigation', navigation);
  contents.on('render-process-gone', unavailable);
  contents.on('destroyed', unavailable);
  window.on('unresponsive', unavailable);
  return {
    ask(options: Confirmation): Promise<boolean> | undefined {
      if (!ready || window.isDestroyed() || contents.isDestroyed()) return undefined;
      return new Promise((finish) => {
        pending = { id: randomUUID(), finish };
        try {
          contents.send(CONFIRMATION_CHANNEL, pending.id, options);
        } catch {
          unavailable();
        }
      });
    },
    dispose() {
      unavailable();
      ipc.off(CONFIRMATION_READY_CHANNEL, readiness);
      ipc.off(CONFIRMATION_ANSWER_CHANNEL, answer);
      contents.off('did-start-navigation', navigation);
      contents.off('render-process-gone', unavailable);
      contents.off('destroyed', unavailable);
      window.off('unresponsive', unavailable);
    },
  };
}
