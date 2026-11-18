import { safetySettingsSchema } from '../../shared/permission-change.ts';

export const sandboxSettingsSchema = safetySettingsSchema.pick({ sandbox: true, sandboxWhenUnavailable: true }).strip();
