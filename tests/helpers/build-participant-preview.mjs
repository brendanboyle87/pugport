import { build } from 'esbuild';
import { readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const out = resolve('reports/reply-ui-preview');
const result = await build({
  entryPoints: ['tests/helpers/participant-preview.tsx'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  write: false,
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [
    {
      name: 'read-local-sources',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) => {
          let path;
          if (args.kind !== 'entry-point' && !args.path.startsWith('.') && !isAbsolute(args.path))
            path = require.resolve(args.path, { paths: [dirname(args.importer)] });
          else {
            const base = resolve(args.importer ? dirname(args.importer) : process.cwd(), args.path);
            path = [
              base,
              ...['.ts', '.tsx', '.js', '.mjs', '.json', '/index.js', '/index.ts', '/index.tsx'].map(
                (ext) => base + ext,
              ),
            ].find((candidate) => statSync(candidate, { throwIfNoEntry: false })?.isFile());
          }
          return path ? { path, namespace: 'source' } : undefined;
        });
        builder.onLoad({ filter: /.*/, namespace: 'source' }, (args) => ({
          contents: readFileSync(args.path),
          loader:
            extname(args.path) === '.png'
              ? 'dataurl'
              : extname(args.path) === '.json'
                ? 'json'
                : extname(args.path) === '.tsx'
                  ? 'tsx'
                  : 'ts',
        }));
      },
    },
  ],
});
const css = (file) =>
  readFileSync(file, 'utf8').replace(/@import ['"](.+?)['"];?/g, (_, child) => css(resolve(dirname(file), child)));
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, 'fixture.js'), result.outputFiles[0].text);
const styles = css(resolve('src/ui/studio.css')) + '\n' + css(resolve('src/ui/ExternalAgents.css'));
for (const theme of ['light', 'dark'])
  writeFileSync(
    resolve(out, theme + '.html'),
    `<!doctype html><html lang="zh-CN" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reply cards ${theme}</title><style>${styles}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`,
  );
writeFileSync(
  resolve(out, 'index.html'),
  '<!doctype html><meta charset="utf-8"><title>PugPort · synthetic reply review</title><style>body{margin:16px;background:#ddd;font:14px system-ui}.frames{display:flex;gap:16px}iframe{border:0;width:360px;height:1000px}</style><p>360px · light / dark · synthetic data only</p><div class="frames"><iframe title="Light 360px" src="light.html"></iframe><iframe title="Dark 360px" src="dark.html"></iframe></div>',
);
console.log(resolve(out, 'index.html'));
