import type { Express } from 'express';
import { terminalPath } from './platform/terminal-path.ts';

export function shouldAutoAddTerminalPath(
  root: string,
  role: string,
  discovery: string | undefined,
  decided: boolean | undefined,
  testing: boolean,
) {
  return (
    role === 'desktop' &&
    discovery === '1' &&
    !testing &&
    /[\\/]resources[\\/]app$/i.test(root) &&
    !/[\\/](AppTranslocation|Volumes)[\\/]/.test(root) &&
    !decided
  );
}

export function autoAddTerminalPath(
  root: string,
  role: string,
  discovery: string | undefined,
  decided: boolean | undefined,
  testing: boolean,
  deps: { save: () => void; add: () => Promise<unknown>; schedule?: (callback: () => void) => void },
) {
  if (!shouldAutoAddTerminalPath(root, role, discovery, decided, testing)) return;
  deps.save();
  const schedule =
    deps.schedule ??
    ((callback: () => void) => {
      setTimeout(callback, 3000).unref();
    });
  schedule(() => void deps.add().catch((error) => console.error('Terminal PATH:', error)));
}

export function terminalCommandRoutes(
  app: Express,
  options: { root: string; path?: typeof terminalPath; save?: () => void | Promise<void> },
) {
  const run = options.path ?? terminalPath;
  for (const [method, action] of [
    ['get', 'status'],
    ['post', 'add'],
    ['delete', 'remove'],
  ] as const) {
    app[method]('/api/external/terminal-command', async (_req, res) => {
      try {
        const result = await run(options.root, action);
        if (action === 'remove') await options.save?.();
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
      }
    });
  }
}
