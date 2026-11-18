import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { broadDirectory, inferCaller, type CallerContext, type CallerProbeInput } from '../shared/caller-signals.ts';

/** Only local, bounded project directories are eligible. */
export function clientRootPath(uri: unknown, windows = process.platform === 'win32'): string | undefined {
  if (typeof uri !== 'string') return undefined;
  const allowed = (path: string) =>
    path.length <= 4000 && (windows ? /^[A-Za-z]:\\/ : /^\/(?!\/)/).test(path) && !broadDirectory(path);
  try {
    if (new URL(uri).protocol !== 'file:') return undefined;
    const path = fileURLToPath(uri, { windows });
    // The ceiling check resolves links, so a junction or 8.3 name (C:\Documents and Settings, C:\PROGRA~1)
    // must pass as its target too.
    return allowed(path) && allowed(existsSync(path) ? realpathSync.native(path) : path) ? path : undefined;
  } catch {
    return undefined;
  }
}

/** The only probe-to-wire boundary. Raw probe data never becomes a request body. */
export function createCallerContext(probe: () => Promise<CallerProbeInput>, hint?: string, disabled = false) {
  let info: CallerProbeInput['clientInfo'];
  let pending: Promise<CallerProbeInput | undefined> | undefined;
  let deadline: number | undefined;
  const start = () =>
    (pending ??= Promise.resolve()
      .then(probe)
      .catch(() => undefined));
  const firstTool = () => {
    deadline ??= Date.now() + 10_000;
  };
  return {
    initialize(clientInfo: unknown) {
      const value = clientInfo as Record<string, unknown> | undefined;
      info =
        value && typeof value.name === 'string'
          ? { name: value.name, version: typeof value.version === 'string' ? value.version.slice(0, 100) : '' }
          : undefined;
      void start();
    },
    firstTool,
    async get(clientRoots: unknown[] = []): Promise<CallerContext> {
      firstTool();
      const wait = async (until: number) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            start(),
            new Promise<undefined>((resolve) => {
              timer = setTimeout(() => resolve(undefined), Math.max(0, until - Date.now()));
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      let probeInput = await wait(deadline!);
      if (probeInput?.timedOut && !probeInput.chain.length) {
        pending = undefined;
        deadline = Date.now() + 10_000;
        probeInput = await wait(deadline);
      }
      const derived = inferCaller({
        ...(probeInput ?? { chain: [], envNames: [] }),
        clientRoots: clientRoots
          .map((root) => clientRootPath((root as { uri?: unknown } | null)?.uri))
          .filter((root): root is string => root !== undefined),
        clientInfo: info,
        pugportCaller: hint,
      });
      const unknown = disabled || !probeInput;
      return {
        client: derived.client,
        ...(derived.version ? { version: derived.version.slice(0, 100) } : {}),
        mode: unknown ? 'unknown' : derived.mode,
        ...(!unknown && derived.network ? { network: true } : {}),
        roots: unknown ? [] : derived.roots.filter((root) => root.length <= 4000).slice(0, 100),
        ...(!unknown && derived.cwd && derived.cwd.length <= 4000 ? { cwd: derived.cwd } : {}),
        evidence: unknown ? [disabled ? 'probe: disabled' : 'probe: unavailable'] : derived.evidence.slice(0, 32),
        verified: !unknown && derived.verified,
      };
    },
  };
}
