import type { BrowserWindow, IpcMainInvokeEvent, OpenDialogOptions, OpenDialogReturnValue } from 'electron';

export const DIRECTORY_PICK_CHANNEL = 'combo-runner:pick-directory';
export const FILES_PICK_CHANNEL = 'combo-runner:pick-files';

export function ownedMainFrame(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  window: BrowserWindow | undefined,
  origin: string,
): boolean {
  if (
    !window ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    !event.senderFrame
  )
    return false;
  try {
    return new URL(event.senderFrame.url).origin === origin;
  } catch {
    return false;
  }
}

export function createDirectoryPicker(
  getWindow: () => BrowserWindow | undefined,
  origin: string,
  show: (window: BrowserWindow, options: OpenDialogOptions) => Promise<OpenDialogReturnValue>,
) {
  const pending = new WeakMap<BrowserWindow, Promise<string | null>>();
  return (event: IpcMainInvokeEvent): Promise<string | null> => {
    const window = getWindow();
    if (!ownedMainFrame(event, window, origin)) return Promise.reject(new Error('目录选择仅允许由本应用主窗口发起。'));
    const owner = window!;
    const previous = pending.get(owner);
    if (previous) return previous;
    const result = Promise.resolve()
      .then(async () => {
        if (owner.isDestroyed()) return null;
        if (owner.isMinimized()) owner.restore();
        owner.show();
        owner.focus();
        const selection = await show(owner, {
          title: '选择项目目录',
          properties: ['openDirectory', 'createDirectory'],
        });
        return owner.isDestroyed() || selection.canceled ? null : (selection.filePaths[0] ?? null);
      })
      .finally(() => {
        pending.delete(owner);
      });
    pending.set(owner, result);
    return result;
  };
}

export function createFilesPicker(
  getWindow: () => BrowserWindow | undefined,
  origin: string,
  show: (window: BrowserWindow, options: OpenDialogOptions) => Promise<OpenDialogReturnValue>,
) {
  const pending = new WeakMap<BrowserWindow, Promise<string[]>>();
  return (event: IpcMainInvokeEvent): Promise<string[]> => {
    const window = getWindow();
    if (!ownedMainFrame(event, window, origin)) return Promise.reject(new Error('文件选择仅允许由本应用主窗口发起。'));
    const owner = window!;
    const previous = pending.get(owner);
    if (previous) return previous;
    const result = Promise.resolve()
      .then(async () => {
        if (owner.isDestroyed()) return [];
        if (owner.isMinimized()) owner.restore();
        owner.show();
        owner.focus();
        const selection = await show(owner, { title: '选择要发送的文件', properties: ['openFile', 'multiSelections'] });
        return owner.isDestroyed() || selection.canceled ? [] : selection.filePaths;
      })
      .finally(() => pending.delete(owner));
    pending.set(owner, result);
    return result;
  };
}
