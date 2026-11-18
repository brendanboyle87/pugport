/**
 * Ends the process after writing session data, without Electron's own shutdown. Only for a quit that has finished
 * all of PugPort's cleanup while an OS keyring request is still unanswered: Electron's shutdown waits for that
 * request, so the app would otherwise stay alive (and an update installer would wait for it in vain).
 */
export async function flushThenExit(options: {
  flush: Array<() => unknown>;
  exit: () => void;
  timeoutMs?: number;
}): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(options.flush.map((flush) => Promise.resolve().then(flush))),
    new Promise((resolve) => (timer = setTimeout(resolve, options.timeoutMs ?? 3000))),
  ]);
  clearTimeout(timer);
  options.exit();
}
