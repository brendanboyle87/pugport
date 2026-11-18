/*
 * Who the user called by name in one message (`@` roles and executors, `@@` devices and bots). One called
 * participant answers that message as before; two or more make it a coordinated task, where a coordinator hands
 * each of them the part the user's words give it.
 */
import { deviceMentionPrefix } from './devices.ts';
import { findMentions, withoutMentionName, type MentionTier } from './mentions.ts';

export const freeChainMentionId = 'free-chain';

export type ParticipantKind = 'role' | 'executor' | 'external' | 'device';

/** One called participant, as the composer keeps it: the name is what follows the @ in the text. */
export type CalledParticipant = { kind: ParticipantKind; id: string; name: string; tier?: MentionTier };

/** As the server resolved it for the coordinator: what to pass as `agent`, and what it is in a line. */
export type Participant = CalledParticipant & {
  /** The exact name for `delegate` / `delegate_many` (an executor's full card name, a role's name, …). */
  agent: string;
  description?: string;
  /** A web agent: its reply is a third party's words, never handed to an executor that has tools. */
  thirdParty?: boolean;
  /** Desktop hand-off: delivery only, with no reply channel. */
  handoff?: boolean;
};

/** How many may be called in one message; more would be a crowd, not a team. */
export const participantLimit = 6;

export const participantKindLabels: Record<ParticipantKind, string> = {
  role: '角色',
  executor: '执行器',
  external: '外部智能体',
  device: '设备',
};

/** How many @ a kind needs at least: bots and devices need two, so a passing "@Muse" stays plain text. */
export const participantTiers: Record<ParticipantKind, MentionTier> = { role: 1, executor: 1, external: 2, device: 2 };

export const participantKey = (item: Pick<CalledParticipant, 'kind' | 'id'>) => `${item.kind}:${item.id}`;

/** Adds one at the end, in the order they were called; calling the same one again keeps it once. */
export function withParticipant(list: readonly CalledParticipant[], item: CalledParticipant): CalledParticipant[] {
  const key = participantKey(item);
  return list.some((entry) => participantKey(entry) === key)
    ? [...list]
    : [...list, { kind: item.kind, id: item.id, name: item.name, ...(item.tier ? { tier: item.tier } : {}) }];
}

/** Who the text calls by name, in the order they appear, each with enough @ for its kind. */
export function namedIn<T extends CalledParticipant>(text: string, list: readonly T[]): T[] {
  return findMentions(
    text,
    list.map((item) => ({
      item,
      name: item.name,
      minTier: Math.max(participantTiers[item.kind], item.tier ?? 1) as MentionTier,
    })),
  ).map(({ item }) => item.item);
}

/**
 * The ones whose `@名字` is still in the text; deleting a name, or one @ of a device's `@@`, takes its call back.
 * Longer names are found first, so "@Codex B" never keeps a separately called "Codex" alive.
 */
export function stillNamed(list: readonly CalledParticipant[], text: string): CalledParticipant[] {
  const kept = namedIn(text, list);
  return list.filter((item) => kept.includes(item));
}

/** The text without one called name and its whole prefix, for the × on its tag. */
export const withoutCalledName = (text: string, name: string, called: readonly CalledParticipant[] = []) =>
  withoutMentionName(
    text,
    name,
    called.map((item) => item.name),
  );

/**
 * What the called participants add to the message body. One: the same fields as calling it alone always did. Two
 * or more: the list, for the server to look up and hand to a coordinator; no single pin is set then.
 */
export function calledFields(called: readonly CalledParticipant[] = []): {
  agentPresetId?: string;
  runtimeId?: string;
  externalAgentId?: string;
  deviceId?: string;
  participants?: { kind: ParticipantKind; id: string }[];
} {
  const plainId = (item: CalledParticipant) =>
    item.kind === 'device' && item.id.startsWith(deviceMentionPrefix)
      ? item.id.slice(deviceMentionPrefix.length)
      : item.id;
  if (called.length > 1) return { participants: called.map((item) => ({ kind: item.kind, id: plainId(item) })) };
  const [one] = called;
  if (!one) return {};
  if (one.kind === 'role') return { agentPresetId: one.id };
  if (one.kind === 'executor') return { runtimeId: one.id };
  if (one.kind === 'external') return { externalAgentId: one.id };
  return { deviceId: plainId(one) };
}
