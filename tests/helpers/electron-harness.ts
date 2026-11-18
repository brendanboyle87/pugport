import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { EventEmitter } from 'node:events';

export function fakeSession() {
  return Object.assign(new EventEmitter(), {
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
    setDevicePermissionHandler() {},
    webRequest: { onBeforeRequest() {}, onHeadersReceived() {} },
  });
}

/** Import Electron modules with supplied APIs; never resolves or launches the real Electron package. */
export async function electronModule(
  entry: string,
  electron: Record<string, unknown>,
  globals: Record<string, unknown> = {},
  mocks: Record<string, string> = {},
) {
  mocks = {
    './backend-port.ts': 'export const selectDesktopPort=async()=>4317;',
    '../server/platform/desktop-endpoint.ts': 'export const publishDesktopPort=()=>()=>{};',
    ...mocks,
  };
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    packages: 'external',
    tsconfigRaw: { compilerOptions: {} },
    plugins: [
      {
        name: 'isolated-electron',
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) =>
            mocks[args.path] ? { path: args.path, namespace: 'mock' } : undefined,
          );
          builder.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({ contents: mocks[args.path]! }));
          // As in ui-harness: resolve local sources without the child process scanning restricted ancestors.
          builder.onResolve({ filter: /.*/ }, (args) => {
            if (args.namespace === 'mock') return undefined;
            if (args.kind !== 'entry-point' && !args.path.startsWith('.') && !isAbsolute(args.path))
              return { path: args.path, external: true };
            const base = resolve(args.importer ? dirname(args.importer) : process.cwd(), args.path);
            const path = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`].find((candidate) =>
              statSync(candidate, { throwIfNoEntry: false })?.isFile(),
            );
            return path ? { path, namespace: 'local-source' } : undefined;
          });
          builder.onLoad({ filter: /.*/, namespace: 'local-source' }, (args) => ({
            contents: readFileSync(args.path),
            loader: extname(args.path) === '.json' ? 'json' : 'ts',
          }));
        },
      },
    ],
  });
  const require = createRequire(import.meta.url),
    module = { exports: {} as Record<string, any> };
  const suppliedProcess = globals.process as Partial<NodeJS.Process> | undefined;
  const contextProcess = suppliedProcess
    ? {
        ...process,
        ...suppliedProcess,
        env: { ...suppliedProcess.env, PUGPORT_UNDER_TEST: '1' },
        once: process.once.bind(process),
      }
    : process;
  runInNewContext(result.outputFiles[0]!.text, {
    __filename: resolve(entry),
    module,
    exports: module.exports,
    require: (name: string) => (name === 'electron' ? electron : require(name)),
    console,
    Buffer,
    URL,
    Request,
    Response,
    fetch,
    AbortSignal,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    ...globals,
    process: contextProcess,
  });
  return module.exports;
}
