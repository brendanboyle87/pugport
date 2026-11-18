import type { ConversationMessage } from '../shared/types.ts';

export function messageAuthor(
  message: ConversationMessage,
  label: (runtimeId: string) => string | undefined,
  includePrivateIdentity = true,
) {
  const run = message.replyIdentity?.runs.at(-1);
  return message.role === 'user'
    ? 'user'
    : (message.externalAgent?.name ??
        (message.device
          ? [includePrivateIdentity ? message.device.name : undefined, message.device.executor]
              .filter(Boolean)
              .join(' · ') || (includePrivateIdentity ? '' : 'PugPort')
          : run
            ? [
                label(run.runtimeId) ?? (includePrivateIdentity ? (run.accountLabel ?? run.runtimeId) : 'PugPort'),
                run.model,
              ]
                .filter(Boolean)
                .join(' · ')
            : 'PugPort'));
}
