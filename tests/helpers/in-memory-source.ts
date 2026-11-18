import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import type { Loader, Plugin } from 'esbuild';

/** Read fixture sources through Node, without esbuild walking inaccessible parent folders in a worktree. */
export const inMemorySource: Plugin = {
  name: 'fixture-sources',
  setup(builder) {
    builder.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind !== 'entry-point' && !args.path.startsWith('.')) return { path: args.path, external: true };
      const path = resolve(args.importer ? dirname(args.importer) : process.cwd(), args.path);
      const found = [
        path,
        `${path}.ts`,
        `${path}.tsx`,
        `${path}.js`,
        resolve(path, 'index.ts'),
        resolve(path, 'index.tsx'),
      ].find((candidate) => existsSync(candidate) && extname(candidate));
      return found ? { path: found, namespace: 'fixture-source' } : undefined;
    });
    builder.onLoad({ filter: /.*/, namespace: 'fixture-source' }, (args) => ({
      contents: readFileSync(args.path),
      loader: ({ '.ts': 'ts', '.tsx': 'tsx', '.json': 'json', '.png': 'dataurl' }[extname(args.path)] ??
        'js') as Loader,
    }));
  },
};
