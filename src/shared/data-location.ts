import { underTest, testDirectory, insideDirectory, canonicalTestPath } from '../server/platform/under-test.ts';
import { tmpdir } from 'node:os';
import * as fs from 'node:fs';
import path from 'node:path';

export class DataLocationError extends Error {
  readonly path: string;
  constructor(dataPath: string, reason: string) {
    super(
      `Cannot find PugPort's data folder: ${dataPath}. Please check .data\\data-location.json, or put the folder back in its original location. (${reason})`,
    );
    this.path = dataPath;
  }
}

/** Resolve before opening storage. A location file is a move marker, never a new-folder request. */
export function resolveDataLocation(options: {
  root: string;
  env?: NodeJS.ProcessEnv;
  packaged?: boolean;
  defaultDir?: string;
  cwd?: string;
  // File protection also runs against the existing simulated platform hosts.
  fs?: Pick<typeof fs, 'statSync' | 'readFileSync'>;
  path?: typeof path;
}): { dataDir: string; source: string; locationFile?: string } {
  const files = options.fs ?? fs;
  const paths = options.path ?? path;
  const env = options.env ?? process.env;
  const isolated = underTest() && !insideDirectory(canonicalTestPath(options.root), canonicalTestPath(tmpdir()));
  const locationFile = paths.join(options.root, '.data', 'data-location.json');
  const stat = (file: string) => {
    try {
      return files.statSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new DataLocationError(file, 'cannot read path');
    }
  };
  const readLocation = (file: string): string => {
    try {
      const value = JSON.parse(files.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')).dataDir;
      if (typeof value !== 'string' || !value.trim() || !paths.isAbsolute(value)) throw Error();
      return paths.resolve(value);
    } catch {
      throw new DataLocationError(file, 'expected JSON with an absolute, non-empty dataDir');
    }
  };
  const source = env.COMBORUNNER_DATA_DIR
    ? 'COMBORUNNER_DATA_DIR'
    : env.AGENT_STUDIO_DATA_DIR
      ? 'AGENT_STUDIO_DATA_DIR'
      : isolated
        ? 'under-test'
        : !options.packaged && stat(locationFile)
          ? 'location-file'
          : 'application-root';
  const dataDir =
    source === 'under-test'
      ? paths.join(testDirectory(), 'data')
      : source === 'location-file'
        ? readLocation(locationFile)
        : paths.resolve(
            options.cwd ?? process.cwd(),
            env.COMBORUNNER_DATA_DIR ||
              env.AGENT_STUDIO_DATA_DIR ||
              options.defaultDir ||
              paths.join(options.root, '.data'),
          );
  if (source === 'location-file' && !stat(dataDir)?.isDirectory())
    throw new DataLocationError(dataDir, 'the existing folder must contain studio.sqlite');
  const movedFile = paths.join(dataDir, 'data-location.json');
  if (!(isolated && paths.relative(paths.resolve(locationFile), paths.resolve(movedFile)) === '') && stat(movedFile))
    throw new DataLocationError(dataDir, `${source}: this data folder has moved to ${readLocation(movedFile)}`);
  if (source === 'location-file') {
    if (!stat(paths.join(dataDir, 'studio.sqlite'))?.isFile())
      throw new DataLocationError(dataDir, 'the existing folder must contain studio.sqlite');
    if (stat(paths.join(options.root, '.data', 'studio.sqlite')) && !warned.has(locationFile)) {
      warned.add(locationFile);
      console.warn(
        `PugPort: old data is still inside the repo at ${paths.join(options.root, '.data')}. Using ${dataDir}.`,
      );
    }
  }
  return { dataDir, source, ...(source === 'location-file' ? { locationFile } : {}) };
}

const warned = new Set<string>();
