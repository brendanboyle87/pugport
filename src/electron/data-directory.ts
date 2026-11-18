import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDataLocation } from '../shared/data-location.ts';

export function desktopDataDirectory(options: {
  root: string;
  appData: string;
  packaged: boolean;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}): string {
  const env = options.env ?? process.env;
  const current = join(options.appData, 'ComboRunner', 'data');
  const legacy = join(options.appData, 'Agent Studio', 'data');
  const exists = options.exists ?? existsSync;
  return resolveDataLocation({
    root: options.root,
    env,
    packaged: options.packaged,
    defaultDir: options.packaged ? (!exists(current) && exists(legacy) ? legacy : current) : undefined,
  }).dataDir;
}
