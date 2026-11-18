import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export function createLogFolderHandler<Event>(
  dataDir: string,
  fromApp: (event: Event) => boolean,
  openPath: (path: string) => Promise<string>,
) {
  return async (event: Event, ..._payload: unknown[]): Promise<string> => {
    if (!fromApp(event)) return 'invalid';
    try {
      const directory = join(dataDir, 'logs');
      await mkdir(directory, { recursive: true });
      return await openPath(directory);
    } catch {
      return 'failed';
    }
  };
}
