import type { RuntimeTarget, Settings } from '../shared/types.ts';
import { relaxingSettingsPatch, targetCommandChanged } from '../shared/permission-change.ts';

export class DesktopPermissionRequired extends Error {
  readonly status = 403;
  constructor() {
    super('放宽安全设置或修改执行命令需要在桌面应用中确认。');
  }
}

export function assertSettingsNarrowing(current: Settings, next: Partial<Settings>) {
  if (Object.keys(relaxingSettingsPatch(current, next)).length) throw new DesktopPermissionRequired();
}

export function assertTargetCommandNarrowing(current: RuntimeTarget, next: Partial<RuntimeTarget>) {
  if (targetCommandChanged(current, next)) throw new DesktopPermissionRequired();
}
