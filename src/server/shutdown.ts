/** Stop process owners while waiting for workflows, then close their shared database last. */
export async function closeExecutionResources(resources: {
  workspace: () => Promise<unknown>;
  processes: () => Promise<unknown>;
  extensions: () => Promise<unknown>;
  controller: () => Promise<unknown>;
  progress?: (phase: string) => void;
}): Promise<void> {
  const call = (phase: string, close: () => Promise<unknown>) => {
    resources.progress?.(phase);
    try {
      return Promise.resolve(close());
    } catch (error) {
      return Promise.reject(error);
    }
  };
  // workspace.close synchronously rejects new work and aborts its running workflows. Its
  // promise can depend on a CLI exiting, so waiting for it before closing CLI processes hangs.
  const workspace = call('workspace', resources.workspace);
  const processes = call('processes', resources.processes);
  const extensions = call('extensions', resources.extensions);
  const results = await Promise.allSettled([workspace, processes, extensions]);
  // Workflows may still save their interrupted results while the above promises settle.
  // Controller.close owns the database and must run after those final writes.
  results.push(...(await Promise.allSettled([call('controller', resources.controller)])));
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failures.length)
    throw Object.assign(
      new AggregateError(
        failures.map((result) => result.reason),
        '后台资源清理未完整完成。',
      ),
      {
        ...(failures.some((result) => result.reason?.code === 'owned-processes-still-running')
          ? { code: 'owned-processes-still-running' }
          : {}),
      },
    );
  resources.progress?.('complete');
}
