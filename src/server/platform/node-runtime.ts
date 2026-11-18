import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Electron's Windows process launch is costly even in Node mode; use the installed Node when available. */
export function managedNodeRuntime(
  appRoot: string,
  platform = process.platform,
  electron = !!process.versions.electron,
): string {
  const bundledNode = join(appRoot, '.runtime', 'node.exe');
  return platform === 'win32' && electron && existsSync(bundledNode) ? bundledNode : process.execPath;
}
