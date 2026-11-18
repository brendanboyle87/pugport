import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { build, type BuildOptions, type Loader } from 'esbuild';

/** Resolve the supplied fixture and installed dependencies without native ancestor-directory discovery. */
export function buildRenderer(options: BuildOptions) {
  return build({
    ...options,
    tsconfigRaw: options.tsconfigRaw ?? { compilerOptions: { jsx: 'react-jsx', target: 'ES2022' } },
    plugins: [
      ...(options.plugins ?? []),
      {
        name: 'fixture-files',
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, async (args) => {
            if (args.path.startsWith('data:')) return { path: args.path, external: true };
            if (args.namespace && !['file', 'fixture-files'].includes(args.namespace)) return;
            const base =
              args.resolveDir ||
              (args.importer && !args.importer.startsWith('<') ? dirname(args.importer) : process.cwd());
            let file = '';
            if (args.path.startsWith('.') || isAbsolute(args.path)) {
              const target = resolve(base, args.path);
              const candidates = [
                target,
                ...['.ts', '.tsx', '.js', '.jsx', '.json', '/index.ts', '/index.tsx', '/index.js'].map(
                  (suffix) => target + suffix,
                ),
              ];
              for (const candidate of candidates) {
                try {
                  if ((await stat(candidate)).isFile()) {
                    file = candidate;
                    break;
                  }
                } catch {
                  /* Try the next source extension. */
                }
              }
              if (!file) throw new Error(`Missing local fixture module: ${args.path}`);
            } else file = createRequire(join(base, 'package.json')).resolve(args.path);
            return { path: file, namespace: 'fixture-files' };
          });
          builder.onLoad({ filter: /.*/, namespace: 'fixture-files' }, async (args) => {
            const extension = extname(args.path)
              .slice(1)
              .replace(/^[cm]js$/, 'js');
            const loader: Loader = ['ts', 'tsx', 'js', 'jsx', 'json', 'css'].includes(extension)
              ? (extension as Loader)
              : 'dataurl';
            return { contents: await readFile(args.path), loader, resolveDir: dirname(args.path) };
          });
        },
      },
    ],
  });
}
