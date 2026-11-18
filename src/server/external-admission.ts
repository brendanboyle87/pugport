import { z } from 'zod';
import type { WorkspaceStore } from './workspace-store.ts';
export type SenderClass = 'owner' | 'trusted' | 'other' | 'bot' | 'system';
export const levelSchema = z.enum(['L1', 'L2', 'L3', 'L4', 'ignore']);
export type Level = z.infer<typeof levelSchema>;
export type Verdict = 'do-now' | 'ask-owner' | 'digest' | 'ignore';
const ruleSchema = z
  .object({
    source: z.enum(['slack', 'github']),
    scope: z.enum(['dm', 'channel-mention', 'issue', 'pr', 'comment', 'ci']),
    senderId: z.string().min(1).max(100).optional(),
    senderClass: z.enum(['owner', 'trusted', 'other', 'bot', 'system']).optional(),
    level: levelSchema,
  })
  .strict()
  .refine((rule) => !(rule.senderId && rule.senderClass), '发送者和发送者类别不能同时指定')
  .refine(
    (r) =>
      r.source === 'slack'
        ? ['dm', 'channel-mention'].includes(r.scope)
        : ['issue', 'pr', 'comment', 'ci'].includes(r.scope),
    'Scope does not belong to source',
  );
export const overridesSchema = z.object({ version: z.literal(1), rules: z.array(ruleSchema).max(1000) }).strict();
export type AdmissionInput = {
  source: 'slack' | 'github';
  scope: 'dm' | 'channel-mention' | 'issue' | 'pr' | 'comment' | 'ci';
  senderId: string;
  senderClass: SenderClass;
  rateLimited?: boolean;
  ownerRepository?: boolean;
  mentioned?: boolean;
  ownerCommit?: boolean;
  defaultBranchFailure?: boolean;
};
export function admit(input: AdmissionInput, overrides: z.infer<typeof overridesSchema> = { version: 1, rules: [] }) {
  const rules = overridesSchema
    .parse(overrides)
    .rules.filter((r) => r.source === input.source && r.scope === input.scope);
  let level: Level;
  if (input.source === 'github') {
    level = !input.ownerRepository
      ? 'ignore'
      : input.scope === 'ci'
        ? input.defaultBranchFailure
          ? input.ownerCommit
            ? 'L2'
            : 'L4'
          : 'ignore'
        : !input.mentioned || input.senderClass === 'bot' || input.senderClass === 'system'
          ? 'L4'
          : input.senderClass === 'owner'
            ? 'L1'
            : input.senderClass === 'trusted'
              ? 'L2'
              : 'L3';
  } else {
    level =
      input.senderClass === 'bot' ||
      input.senderClass === 'system' ||
      (input.scope === 'dm' && input.senderClass === 'other')
        ? 'ignore'
        : input.senderClass === 'owner'
          ? 'L1'
          : input.senderClass === 'trusted'
            ? 'L2'
            : 'L3';
  }
  // Preferences cannot open foreign repositories, bot tasks or unmentioned requests.
  if (
    level !== 'ignore' &&
    (input.source === 'slack' ||
      (input.mentioned && input.scope !== 'ci' && input.senderClass !== 'bot' && input.senderClass !== 'system'))
  )
    level =
      rules.find((r) => r.senderId === input.senderId)?.level ??
      rules.find((r) => r.senderClass === input.senderClass)?.level ??
      rules.find((r) => !r.senderId && !r.senderClass)?.level ??
      level;
  if (input.rateLimited && level !== 'ignore') level = 'L4';
  const verdict: Verdict =
    level === 'ignore' ? 'ignore' : level === 'L4' ? 'digest' : level === 'L3' ? 'ask-owner' : 'do-now';
  return { level, verdict, reason: input.rateLimited && level === 'L4' ? '太频繁' : '来源授权规则' };
}
export async function textPreference(
  level: Level,
  classify?: () => Promise<string>,
  timeoutMs = 150,
): Promise<'task' | 'reply'> {
  if (!classify || (level !== 'L1' && level !== 'L2')) return 'task';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      classify()
        .then((label) => (label === 'chit-chat' ? ('reply' as const) : ('task' as const)))
        .catch(() => 'task' as const),
      new Promise<'task'>((resolve) => {
        timer = setTimeout(() => resolve('task'), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export class AdmissionRules {
  constructor(
    private store: WorkspaceStore,
    private source: AdmissionInput['source'] = 'slack',
  ) {}
  read() {
    return overridesSchema.parse(this.store.get('external-admission', this.source) ?? { version: 1, rules: [] });
  }
  write(value: unknown) {
    const parsed = overridesSchema.parse(value);
    if (parsed.rules.some((r) => r.source !== this.source)) throw new Error('Wrong admission source');
    const keys = parsed.rules.map((r) => JSON.stringify([r.source, r.scope, r.senderId, r.senderClass]));
    if (new Set(keys).size !== keys.length) throw new Error('重复的来源授权规则');
    this.store.save('external-admission', this.source, this.source, parsed);
    return parsed;
  }
  trust(scope: AdmissionInput['scope'], senderId: string) {
    const value = this.read();
    value.rules = value.rules.filter((r) => r.scope !== scope || r.senderId !== senderId);
    value.rules.push({ source: this.source, scope, senderId, level: 'L2' });
    return this.write(value);
  }
}
