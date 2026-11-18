import { z } from 'zod';
import { routingRuleSetSchema } from './routing-schema.ts';
import type { Conversation, ConversationRoutingData, Project, RoutingRuleSet, Settings } from './types.ts';
import { upgradeRouting } from './conversation-routing.ts';

export type RoutingProfile = { id: string; name: string; rules: RoutingRuleSet };
export const routingProfileIdSchema = z.string().uuid();
export const routingProfileSchema = z
  .object({
    id: routingProfileIdSchema,
    name: z.string().trim().min(1).max(60),
    rules: routingRuleSetSchema,
  })
  .strict();
export const routingProfileLimit = 30;

/** Save the shared routing contract, including its planner and verifier roles. */
export function routingRuleDraft(value: Omit<RoutingRuleSet, 'updatedAt'>): Omit<RoutingRuleSet, 'updatedAt'> {
  const { version, text, rules, unparsed, categories, selection, excludeModels, roles } = value;
  return {
    version,
    text,
    rules,
    unparsed,
    ...(roles === undefined ? {} : { roles }),
    ...(categories === undefined ? {} : { categories }),
    ...(selection === undefined ? {} : { selection }),
    ...(excludeModels === undefined ? {} : { excludeModels }),
  };
}

/** Only a literal model ID or '*' wildcard, never executable regular expressions. */
export function routingModelExcluded(id: string, patterns: readonly string[] = []): boolean {
  const model = id.toLowerCase();
  return patterns.some((pattern) => {
    const parts = pattern.toLowerCase().split('*');
    if (parts.length === 1) return model === parts[0];
    if (!model.startsWith(parts[0]!)) return false;
    let cursor = parts[0]!.length;
    for (const part of parts.slice(1, -1)) {
      const at = model.indexOf(part, cursor);
      if (at < 0) return false;
      cursor = at + part.length;
    }
    const tail = parts.at(-1)!;
    return model.length - tail.length >= cursor && model.endsWith(tail);
  });
}

/** A chat's explicit automatic selection must not accidentally inherit its project's profile. */
export function effectiveRoutingProfileId(
  conversation: Pick<Conversation, 'routingProfileId'>,
  project?: Pick<Project, 'routingProfileId'>,
): string | undefined {
  return (
    (conversation.routingProfileId === undefined ? project?.routingProfileId : conversation.routingProfileId) ??
    undefined
  );
}

/** Selected profiles replace rules and roles; chapter and masking options remain conversation-local. */
export function profileConversationRouting(
  settings: Pick<Settings, 'routingProfiles'>,
  conversation: Pick<Conversation, 'routingProfileId' | 'routing'>,
  project?: Pick<Project, 'routingProfileId'>,
): ConversationRoutingData | undefined {
  const profileId = effectiveRoutingProfileId(conversation, project);
  if (!profileId) return conversation.routing;
  const profile = settings.routingProfiles?.find((item) => item.id === profileId);
  if (!profile) throw Error('此路由方案已不可用，请选择自动或另一套路由方案。');
  const local = conversation.routing ? upgradeRouting(conversation.routing) : undefined;
  return structuredClone({
    ...local,
    ...profile.rules,
    roles: profile.rules.roles,
    categories: profile.rules.categories,
    selection: profile.rules.selection,
    excludeModels: profile.rules.excludeModels,
    chapterAgents: local?.chapterAgents ?? false,
    mask: local?.mask ?? false,
  });
}

/** Shared merge used when capturing a new task, so later profile edits cannot change that task's rules. */
export function conversationRuleSet(
  settings: Pick<Settings, 'routingProfiles' | 'routingRules'>,
  conversation: Pick<Conversation, 'routingProfileId' | 'routing'>,
  project?: Pick<Project, 'routingProfileId'>,
) {
  const selected = profileConversationRouting(settings, conversation, project);
  const local = selected ? upgradeRouting(selected) : undefined;
  const global = effectiveRoutingProfileId(conversation, project) ? undefined : settings.routingRules;
  if (!global) return local;
  return {
    chapterAgents: false,
    mask: false,
    ...global,
    ...local,
    categories: [
      ...new Map(
        [...(global.categories ?? []), ...(local?.categories ?? [])].map((category) => [category.id, category]),
      ).values(),
    ],
    rules: [
      ...new Map([...(global.rules ?? []), ...(local?.rules ?? [])].map((rule) => [rule.category, rule])).values(),
    ],
  };
}
