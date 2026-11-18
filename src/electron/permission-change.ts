import type { BrowserWindow, IpcMainInvokeEvent, MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import { ownedMainFrame } from './directory-picker.ts';
import { permissionChangeSchema, type PermissionChange } from '../shared/permission-change.ts';
import { t } from './locale.ts';

export function createPermissionChange(
  getWindow: () => BrowserWindow | undefined,
  origin: string,
  show: (window: BrowserWindow, options: MessageBoxOptions) => Promise<MessageBoxReturnValue>,
  request: (change: PermissionChange, apply: boolean, expected?: string) => Promise<string>,
) {
  let pending = false;
  return async (event: IpcMainInvokeEvent, value: unknown): Promise<boolean> => {
    const window = getWindow();
    if (!ownedMainFrame(event, window, origin)) throw new Error('权限修改仅允许由本应用主窗口发起。');
    if (pending) return false;
    const change = permissionChangeSchema.parse(value);
    pending = true;
    try {
      const description = await request(change, false);
      if (!description) {
        if (!ownedMainFrame(event, window, origin)) return false;
        await request(change, true, description);
        return true;
      }
      const answer = await show(window!, {
        type: 'warning',
        title: t('确认权限修改'),
        message: description
          .split('\n')
          .map((line) =>
            line
              .split(' → ')
              .map((part) => t(part))
              .join(' → '),
          )
          .join('\n'),
        buttons: [t('取消'), t('确认')],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (answer.response !== 1 || !ownedMainFrame(event, window, origin)) return false;
      await request(change, true, description);
      return true;
    } finally {
      pending = false;
    }
  };
}
