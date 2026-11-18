import { z } from 'zod';

/** Store absolute instants. UI converts local inputs to ISO with a timezone. */
export const taskScheduleSchema = z
  .object({
    deadlineAt: z.string().datetime({ offset: true }).optional(),
    notBefore: z.string().datetime({ offset: true }).optional(),
    priority: z.enum(['normal', 'high']).optional(),
    estimatedMinutes: z.number().finite().min(1).max(43200).optional(),
    preferExpiringQuota: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => !value.deadlineAt || !value.notBefore || Date.parse(value.notBefore) < Date.parse(value.deadlineAt),
    {
      message: '开始时间必须早于任务期限。',
      path: ['notBefore'],
    },
  );
