export type ToolStep = {
  id: string;
  label: string;
  status: 'running' | 'completed' | 'failed';
  detail?: Record<string, unknown>;
};
export type ToolStepOptions = { onStep?: (step: ToolStep) => void };

/** Observers never change an operation's result or exception. Times belong to the receiving recorder. */
export function startToolStep(
  options: ToolStepOptions | undefined,
  id: string,
  label: string,
  detail?: Record<string, unknown>,
) {
  const emit = (status: ToolStep['status'], extra?: Record<string, unknown>) => {
    try {
      options?.onStep?.({ id, label, status, ...(detail || extra ? { detail: { ...detail, ...extra } } : {}) });
    } catch {
      /* Logging must not interrupt work. */
    }
  };
  emit('running');
  let ended = false;
  return {
    complete(extra?: Record<string, unknown>) {
      if (!ended) {
        ended = true;
        emit('completed', extra);
      }
    },
    fail(error: unknown, extra?: Record<string, unknown>) {
      if (!ended) {
        ended = true;
        emit('failed', { ...extra, error: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}
export async function traceToolStep<T>(
  options: ToolStepOptions | undefined,
  id: string,
  label: string,
  operation: () => T | Promise<T>,
  detail?: Record<string, unknown>,
  summary?: (result: T) => Record<string, unknown>,
): Promise<T> {
  const step = startToolStep(options, id, label, detail);
  try {
    const result = await operation();
    let extra: Record<string, unknown> | undefined;
    try {
      extra = summary?.(result);
    } catch {
      /* A reporting summary cannot change the operation. */
    }
    step.complete(extra);
    return result;
  } catch (error) {
    step.fail(error);
    throw error;
  }
}
