import type { Settings } from '../shared/types.ts';
import { relaxingSettingsPatch } from '../shared/permission-change.ts';
import type { Api } from './Workspace';
import { desktopBridge } from './desktop';

/** All settings controls use the same split. Cancellation writes nothing. */
export async function saveSettings(api: Api, current: Partial<Settings>, next: Partial<Settings>): Promise<boolean> {
  const patch = relaxingSettingsPatch(current, next);
  if (Object.keys(patch).length) {
    const change = desktopBridge()?.changePermission;
    if (!change) throw new Error('请在桌面应用中修改权限。');
    if (!(await change({ kind: 'settings', patch }))) return false;
  }
  const rest = { ...next };
  for (const key of Object.keys(patch) as (keyof typeof patch)[]) delete rest[key];
  if (Object.keys(rest).length) await api('/api/settings', rest, 'PATCH');
  return true;
}
