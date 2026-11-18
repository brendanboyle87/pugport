import { providerIds } from './provider-registry.ts';
import { z } from 'zod';

export const routingCandidateSchema = z
  .object({
    provider: z.enum(providerIds).optional(),
    runtimeId: z.string().min(1).max(100).optional(),
    model: z.string().min(1).max(200).optional(),
    effort: z.string().min(1).max(20).optional(),
  })
  .strict();
const categoryId = z
  .string()
  .regex(/^(adult|code|writing|translation|vision|research|other|custom:[a-z0-9-]+)$/)
  .max(100);
const routingRuleSetObject = z
  .object({
    version: z.literal(2),
    roles: z
      .object({
        coordinator: routingCandidateSchema.optional(),
        merger: routingCandidateSchema.optional(),
        verifier: z.array(routingCandidateSchema).max(8).optional(),
      })
      .strict()
      .optional(),
    text: z.string().max(4000),
    rules: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            category: categoryId,
            candidates: z.array(routingCandidateSchema).max(8),
            strict: z.boolean(),
            enabled: z.boolean(),
            clause: z.string().max(4000).optional(),
            source: z.enum(['parsed', 'manual', 'migrated']),
          })
          .strict(),
      )
      .max(40),
    unparsed: z.array(z.string().max(4000)).max(100),
    selection: z.enum(['ordered', 'quota']).optional(),
    excludeModels: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(200)
          .regex(/^[a-zA-Z0-9_./:@+*\-]+$/),
      )
      .max(40)
      .optional(),
    categories: z
      .array(
        z
          .object({
            id: z
              .string()
              .regex(/^custom:[a-z0-9-]+$/)
              .max(100),
            label: z.string().min(1).max(80),
            description: z.string().max(500).optional(),
            keywords: z.array(z.string().min(1).max(80)).max(30).optional(),
          })
          .strict(),
      )
      .max(30)
      .optional(),
  })
  .strict();
const validateRules = (value: z.infer<typeof routingRuleSetObject>, ctx: z.RefinementCtx) => {
  if (
    new Set(value.rules.map((rule) => rule.category)).size !== value.rules.length ||
    new Set(value.rules.map((rule) => rule.id)).size !== value.rules.length
  )
    ctx.addIssue({ code: 'custom', message: '每类内容只能有一条规则。' });
  const ids = value.categories?.map((category) => category.id) ?? [];
  if (
    new Set(ids).size !== ids.length ||
    value.rules.some((rule) => rule.category.startsWith('custom:') && !ids.includes(rule.category))
  )
    ctx.addIssue({ code: 'custom', message: '自定义分类缺失或重复。' });
};

export const routingRuleSetSchema = routingRuleSetObject
  .extend({ updatedAt: z.string().max(100) })
  .superRefine(validateRules);
export const conversationRoutingSchema = routingRuleSetObject
  .extend({
    automaticExecutors: z.array(z.string().min(1).max(100)).min(1).max(200).optional(),
    chapterAgents: z.boolean(),
    mask: z.boolean(),
  })
  .superRefine(validateRules);
