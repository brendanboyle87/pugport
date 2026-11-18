import { learningProviders, type LearningFailures, type LearningProvider } from '../../shared/sandbox.ts';

const failureLimit = 3;
const safeCodes = new Set([
  'backend_error',
  'sandbox-helper-crashed',
  'sandbox-helper-timeout',
  'sandbox-helper-protocol',
  'sandbox-helper-spawn',
  'sandbox-invalid-working-directory',
  'sandbox-invalid-denial-output-parent',
  'sandbox-path-metadata-failed',
  'EACCES',
  'EPERM',
  'ENOENT',
  'ETIMEDOUT',
  'ERR_MODULE_NOT_FOUND',
  'MODULE_NOT_FOUND',
]);

function failureCode(error: unknown): string | undefined {
  if (typeof error === 'string') {
    return safeCodes.has(error) || /^0x[0-9a-f]{8}$/i.test(error) ? error : undefined;
  }
  if (!error || typeof error !== 'object') return undefined;
  // Ignore SDK messages: they may contain prompts, environment values or local paths.
  try {
    const { code, nativeCode } = error as { code?: unknown; nativeCode?: unknown };
    if (typeof nativeCode === 'string' && /^0x[0-9a-f]{8}$/i.test(nativeCode)) return nativeCode;
    return typeof code === 'string' && safeCodes.has(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/** Process-local failures, bounded to one short entry per learning provider. */
export class LearningHealth {
  private failures: LearningFailures = {};

  constructor(saved?: unknown) {
    if (!saved || typeof saved !== 'object') return;
    for (const provider of learningProviders) {
      const value = (saved as Record<string, unknown>)[provider];
      if (!value || typeof value !== 'object') continue;
      const { consecutiveFailures, code } = value as { consecutiveFailures?: unknown; code?: unknown };
      if (
        typeof consecutiveFailures !== 'number' ||
        !Number.isInteger(consecutiveFailures) ||
        consecutiveFailures < 1 ||
        consecutiveFailures > failureLimit
      )
        continue;
      for (let i = 0; i < consecutiveFailures; i++) this.failure(provider, code);
    }
  }

  /** True only when this failure first reaches the automatic-disable threshold. */
  failure(provider: LearningProvider, error: unknown): boolean {
    const previous = this.failures[provider];
    const consecutiveFailures = Math.min((previous?.consecutiveFailures ?? 0) + 1, failureLimit);
    const autoDisabled = consecutiveFailures === failureLimit;
    const code = failureCode(error);
    this.failures[provider] = {
      consecutiveFailures,
      autoDisabled,
      reason: '沙箱启动失败',
      ...(code ? { code } : {}),
    };
    return autoDisabled && !previous?.autoDisabled;
  }

  success(provider: LearningProvider): void {
    this.reset(provider);
  }

  /** Clear when the owner turns learning off or explicitly re-enables it. */
  reset(provider: LearningProvider): void {
    delete this.failures[provider];
  }

  snapshot(): LearningFailures {
    return Object.fromEntries(Object.entries(this.failures).map(([provider, failure]) => [provider, { ...failure }]));
  }
}
