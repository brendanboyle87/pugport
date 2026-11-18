import type { ContainerRequest, ExecutionMetadata } from '@microsoft/mxc-sdk/v1';

export type HelperRequest = { type: 'probe' } | { type: 'spawn'; request: ContainerRequest } | { type: 'kill' };
export type HelperProbe = { sdkVersion?: string; tier?: string; probes?: { baseContainerSupportsDenyPaths?: boolean } };
export type HelperReply =
  | { type: 'ready'; pid: number }
  | { type: 'probe'; result: HelperProbe }
  | { type: 'done'; exitCode: number; timedOut: boolean; metadata?: ExecutionMetadata }
  | { type: 'error'; code: string; nativeCode?: string };

/** Only stable codes cross IPC; never native messages containing paths or environment values. */
export function helperError(error: unknown) {
  const value = error as { code?: unknown; nativeCode?: unknown; message?: unknown } | undefined;
  const code =
    typeof value?.code === 'string' &&
    /^(?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|backend_error|policy_validation|malformed_request|unsupported_containment|backend_unavailable|sandbox-learning-unavailable|sandbox-helper-(?:crashed|timeout|protocol|spawn|closed)|sandbox-invalid-(?:working-directory|denial-output-parent)|sandbox-path-metadata-failed)$/.test(
      value.code,
    )
      ? value.code
      : 'sandbox-helper-spawn';
  const match =
    typeof value?.nativeCode === 'string' && /^0x[\da-f]{8}$/i.test(value.nativeCode)
      ? value.nativeCode
      : typeof value?.message === 'string'
        ? /\b0x[\da-f]{8}\b/i.exec(value.message)?.[0]
        : undefined;
  return { code, ...(match ? { nativeCode: match.toUpperCase().replace('0X', '0x') } : {}) };
}

export function failureReason(error: unknown) {
  const safe = helperError(error);
  return `${safe.code}${safe.nativeCode ? ` (${safe.nativeCode})` : ''}`;
}
