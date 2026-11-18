import { uiBuildIdPattern, type UiReleaseStatus } from '../shared/ui-release';
import { uiUpdateBlocked } from './ui-update-guard';

export const failedUiBuildsKey = 'pugport-ui-failed-builds';

export function eligibleUiRelease(
  value: unknown,
  current: string,
  compatibility: string,
  failed: string[],
): string | undefined {
  if (!value || typeof value !== 'object') return;
  const candidate = value as UiReleaseStatus;
  if (
    candidate.enabled === true &&
    typeof candidate.buildId === 'string' &&
    uiBuildIdPattern.test(candidate.buildId) &&
    candidate.buildId !== current &&
    candidate.compatibility === compatibility &&
    !failed.includes(candidate.buildId)
  ) {
    return candidate.buildId;
  }
}

export function rejectedUiBuilds(storage: Pick<Storage, 'getItem'>): string[] | undefined {
  try {
    const value: unknown = JSON.parse(storage.getItem(failedUiBuildsKey) || '[]');
    if (!Array.isArray(value) || !value.every((id) => typeof id === 'string')) return;
    return value.slice(-32);
  } catch {
    return;
  }
}

type UpdateOptions = {
  buildId: string;
  compatibility: string;
  readStatus: () => Promise<unknown>;
  rejected: () => string[] | undefined;
  blocked: () => boolean;
  activate: (buildId: string) => void;
  pending: (value: boolean) => void;
};

/** Failed and overlapping polls cannot trigger a reload. Check activity again at activation. */
export function createUiUpdateCheck(options: UpdateOptions): () => Promise<void> {
  let checking = false;
  let activating = false;
  return async () => {
    if (checking || activating) return;
    checking = true;
    try {
      const failed = options.rejected();
      if (!failed) return;
      const candidate = eligibleUiRelease(await options.readStatus(), options.buildId, options.compatibility, failed);
      options.pending(Boolean(candidate));
      if (!candidate || options.blocked()) return;
      activating = true;
      try {
        options.activate(candidate);
      } catch {
        activating = false;
      }
    } catch {
      // Disconnection is not evidence that the current UI should be replaced.
    } finally {
      checking = false;
    }
  };
}

export function editingUi(document: Document): boolean {
  if (document.querySelector('[role="dialog"], dialog[open], [data-ui-update-blocked="true"]')) return true;
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.isContentEditable) return true;
  return (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && Boolean(active.value);
}

export function startUiUpdates(buildId: string, compatibility: string, pending: (value: boolean) => void): () => void {
  if (!buildId || buildId === 'development' || !compatibility || compatibility === 'development') return () => {};
  let disposed = false;
  let composing = false;
  let lastInteraction = Date.now();
  let request: AbortController | undefined;
  const interaction = () => {
    lastInteraction = Date.now();
  };
  const beginComposition = () => {
    composing = true;
    interaction();
  };
  const endComposition = () => {
    composing = false;
    interaction();
  };
  const check = createUiUpdateCheck({
    buildId,
    compatibility,
    rejected: () => {
      try {
        return rejectedUiBuilds(window.sessionStorage);
      } catch {
        return;
      }
    },
    readStatus: async () => {
      request = new AbortController();
      const timeout = window.setTimeout(() => request?.abort(), 4000);
      try {
        const response = await fetch('/api/ui-release', { cache: 'no-store', signal: request.signal });
        if (!response.ok) throw new Error('UI status unavailable');
        return await response.json();
      } finally {
        window.clearTimeout(timeout);
      }
    },
    blocked: () =>
      disposed ||
      document.visibilityState === 'hidden' ||
      composing ||
      Date.now() - lastInteraction < 2000 ||
      uiUpdateBlocked() ||
      editingUi(document),
    activate: (next) => {
      // Studio already persists navigation. Never copy private content or files for an update.
      const url = new URL(window.location.href);
      url.searchParams.set('uiBuild', next);
      window.location.replace(url.href);
    },
    pending: (value) => {
      if (!disposed) pending(value);
    },
  });
  const events = ['pointerdown', 'keydown', 'input', 'wheel'] as const;
  events.forEach((event) => document.addEventListener(event, interaction, { passive: true, capture: true }));
  document.addEventListener('compositionstart', beginComposition, true);
  document.addEventListener('compositionend', endComposition, true);
  const interval = window.setInterval(() => void check(), 10000);
  return () => {
    disposed = true;
    request?.abort();
    window.clearInterval(interval);
    events.forEach((event) => document.removeEventListener(event, interaction, true));
    document.removeEventListener('compositionstart', beginComposition, true);
    document.removeEventListener('compositionend', endComposition, true);
  };
}
