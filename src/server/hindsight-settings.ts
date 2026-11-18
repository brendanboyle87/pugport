import { z } from 'zod';
import { defaultHindsightSettings, type HindsightSettings } from '../shared/hindsight.ts';

const identifier = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);
export const hindsightSettingsSchema = z
  .object({
    enabled: z.boolean(),
    pythonExecutable: z
      .string()
      .trim()
      .max(4000)
      .regex(/^[^\x00-\x1f\x7f]*$/),
    runtimeId: z.union([identifier, z.literal('')]),
    projectIds: z
      .array(identifier)
      .max(200)
      .refine((ids) => new Set(ids).size === ids.length),
    dailyModelCalls: z.number().int().min(1).max(100),
    recallTimeoutMs: z.number().int().min(200).max(3000),
  })
  .strict()
  .refine((value) => !value.enabled || !!(value.pythonExecutable && value.runtimeId && value.projectIds.length), {
    message: '开启 Hindsight 前，先选择 Python、API 账号和项目。',
  });

export function loadHindsightSettings(value: unknown): { settings: HindsightSettings; invalid: boolean } {
  const parsed = hindsightSettingsSchema.safeParse(value);
  return {
    settings: parsed.success ? parsed.data : { ...defaultHindsightSettings, projectIds: [] },
    invalid: value !== undefined && !parsed.success,
  };
}
