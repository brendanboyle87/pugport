import type { MessageInput } from '../shared/types';

/** Explicit choices belong to one conversation on this device. */
export type ComposerSelection = {
  runtimeId: string;
  model: string;
  effort: string;
  mode: MessageInput['mode'];
  permission: MessageInput['permissionMode'];
  policy: MessageInput['executionPolicy'];
  /** Review mode: another executor checks each result. */
  review: boolean;
};

const key = 'comborunner.composer-selection.v1';
const conversationKey = (id: string) => `comborunner.composer-selection.v2:${id}`;
const openedAt = Date.now();
export const defaultComposerSelection: ComposerSelection = {
  runtimeId: '',
  model: '',
  effort: '',
  mode: 'auto',
  permission: 'workspace-write',
  policy: 'cli-first',
  review: false,
};

/** Restores saved choices; a pinned executor that no longer exists falls back to automatic scheduling. */
export function loadComposerSelection(
  conversationId: string | undefined,
  knownRuntime: (runtimeId: string) => boolean,
  createdAt?: string,
): ComposerSelection {
  if (!conversationId) return { ...defaultComposerSelection };
  let saved: Partial<ComposerSelection> = {};
  try {
    let raw = localStorage.getItem(conversationKey(conversationId));
    // Only the open existing conversation claims the legacy device choice; keep the old snapshot.
    if (!raw && (!createdAt || Date.parse(createdAt) < openedAt) && !localStorage.getItem(`${key}.owner`)) {
      raw = localStorage.getItem(key);
      if (raw) {
        JSON.parse(raw);
        localStorage.setItem(conversationKey(conversationId), raw);
        localStorage.setItem(`${key}.owner`, conversationId);
      }
    }
    saved = JSON.parse(raw ?? '{}') ?? {};
  } catch {
    /* Storage can be unavailable or hold something else; use defaults. */
  }
  const value = { ...defaultComposerSelection };
  // The task type starts as automatic every time: a "create or modify" left over from an earlier task
  // would otherwise turn a later question into an execution task.
  if (['read-only', 'workspace-write'].includes(saved.permission as string)) value.permission = saved.permission!;
  if (['cli-first', 'cli-only', 'api-only'].includes(saved.policy as string)) value.policy = saved.policy!;
  if (typeof saved.review === 'boolean') value.review = saved.review;
  if (typeof saved.runtimeId === 'string' && saved.runtimeId && knownRuntime(saved.runtimeId)) {
    value.runtimeId = saved.runtimeId;
    if (typeof saved.model === 'string') value.model = saved.model;
    if (typeof saved.effort === 'string') value.effort = saved.effort;
  }
  return value;
}

export function saveComposerSelection(conversationId: string | undefined, selection: ComposerSelection) {
  if (!conversationId) return;
  try {
    localStorage.setItem(conversationKey(conversationId), JSON.stringify(selection));
  } catch {
    /* Private windows may refuse storage; the choice then lasts for this session only. */
  }
}
