import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { readFileSync, statSync } from 'node:fs';

// Component callbacks and lifecycle hooks run in memory; no browser, Electron process or HTTP request.
const react = `
const h = globalThis.__hooks;
export function useState(value) {
  const i = h.index++;
  if (!(i in h.slots)) h.slots[i] = typeof value === 'function' ? value() : value;
  return [h.slots[i], next => {
    const value = typeof next === 'function' ? next(h.slots[i]) : next;
    if (!Object.is(value, h.slots[i])) h.dirty = true;
    h.slots[i] = value;
  }];
}
export function useRef(value) { const i = h.index++; return h.slots[i] ??= { current: value }; }
export function useMemo(fn, deps) {
  const i = h.index++, previous = h.slots[i];
  if (!previous || !deps || deps.some((v, at) => !Object.is(v, previous.deps?.[at]))) h.slots[i] = { deps, value: fn() };
  return h.slots[i].value;
}
export function useCallback(fn, deps) {
  const i = h.index++, previous = h.slots[i];
  if (!previous || !deps || deps.some((v, at) => !Object.is(v, previous.deps?.[at]))) h.slots[i] = { deps, fn };
  return h.slots[i].fn;
}
export function useEffect(fn, deps) {
  const i = h.index++, previous = h.slots[i];
  if (!previous || !deps || deps.some((v, at) => !Object.is(v, previous.deps?.[at]))) {
    h.effects.push(() => { previous?.cleanup?.(); h.slots[i] = { deps, cleanup: fn() }; });
  }
}
export const useLayoutEffect = useEffect;
export function useImperativeHandle(ref, create, deps) {
  useEffect(() => { if (ref) ref.current = create(); return () => { if (ref) ref.current = null; }; }, deps);
}
export function useSyncExternalStore(subscribe, get) { h.index++; return get(); }
export function useId() { h.index++; return 'fixture'; }
export function createElement(type, props, ...children) { return { type, props: { ...props, children: children.length ? children : props?.children } }; }
export function createContext(value) { return { Provider: 'context-provider', value }; }
export function useContext(context) { h.index++; return context.value; }
export const memo = fn => fn;
export const forwardRef = fn => fn;
export const lazy = _load => function LazyFixture() { return null; };
export const Suspense = 'suspense';
export const Fragment = 'fragment';
export const Children = { toArray: value => [value].flat() };
export const isValidElement = value => !!value?.type;
`;
export type UiNode = { type: any; props: any; key?: string };
export function findNode(tree: unknown, check: (node: UiNode) => boolean): UiNode | undefined {
  if (Array.isArray(tree)) {
    for (const child of tree) {
      const found = findNode(child, check);
      if (found) return found;
    }
  } else if (tree && typeof tree === 'object') {
    const node = tree as UiNode;
    if (check(node)) return node;
    const found = findNode(node.props?.children, check);
    if (found) return found;
    // Elements passed through other props (a header's actions, a title) are part of the rendered tree too.
    for (const [key, value] of Object.entries(node.props ?? {}))
      if (key !== 'children' && isElementLike(value)) {
        const nested = findNode(value, check);
        if (nested) return nested;
      }
  }
}
const isElementLike = (value: unknown): boolean =>
  Array.isArray(value)
    ? value.some(isElementLike)
    : !!value && typeof value === 'object' && 'props' in value && 'type' in value;
export async function uiBundle(entry: string, mockBackend = false) {
  const result = await build({
    entryPoints: [resolve(entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    packages: 'external',
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
    // The logo imports a PNG, as Vite allows; inline it so the bundle stays self-contained.
    loader: { '.png': 'dataurl', '.webp': 'dataurl' },
    plugins: [
      {
        name: 'in-memory-hooks',
        setup(builder) {
          // Callback-only tests do not render styles or activate lazily opened desktop tools.
          builder.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: 'empty-css' }));
          builder.onLoad({ filter: /.*/, namespace: 'empty-css' }, () => ({ contents: '', loader: 'js' }));
          builder.onResolve({ filter: /^react(?:\/jsx-runtime)?$/ }, (args) => ({
            path: args.path,
            namespace: 'mock',
          }));
          if (mockBackend)
            builder.onResolve({ filter: /^\.\/App$/ }, (args) =>
              args.importer.endsWith('Studio.tsx') ? { path: 'backend', namespace: 'mock' } : undefined,
            );
          builder.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({
            contents:
              args.path === 'react'
                ? react
                : args.path === 'backend'
                  ? `export const useBackend=()=>globalThis.__backend;
            export const ApprovalCard=()=>null, EmptyState=()=>null, HandoffModal=()=>null, QuotaCard=()=>null,
            RunOutput=()=>null, SettingsPage=()=>null, StatusPill=()=>null, TargetEditor=()=>null;
            export const dateLabel=x=>x, readableError=x=>String(x);`
                  : `export function jsx(type,props,key){return {type,props:props??{},key};}
             export const jsxs=jsx, Fragment='fragment';`,
          }));
          // Resolve local sources in Node: the sandboxed esbuild child cannot enumerate worktree ancestors.
          builder.onResolve({ filter: /.*/ }, (args) => {
            if (args.namespace === 'mock') return undefined;
            if (args.kind !== 'entry-point' && !args.path.startsWith('.') && !isAbsolute(args.path))
              return { path: args.path, external: true };
            const base = resolve(args.importer ? dirname(args.importer) : process.cwd(), args.path);
            const path = [
              base,
              `${base}.ts`,
              `${base}.tsx`,
              `${base}.js`,
              `${base}/index.ts`,
              `${base}/index.tsx`,
            ].find((candidate) => statSync(candidate, { throwIfNoEntry: false })?.isFile());
            return path ? { path, namespace: 'local-source' } : undefined;
          });
          builder.onLoad({ filter: /.*/, namespace: 'local-source' }, (args) => ({
            contents: readFileSync(args.path),
            loader: ['.png', '.webp'].includes(extname(args.path))
              ? 'dataurl'
              : extname(args.path) === '.tsx'
                ? 'tsx'
                : extname(args.path) === '.json'
                  ? 'json'
                  : 'ts',
          }));
        },
      },
    ],
  });
  return result.outputFiles[0]!.text;
}
export function uiHarness(code: string, globals: Record<string, unknown> = {}) {
  const hooks = { slots: [] as any[], index: 0, effects: [] as (() => void)[], dirty: false };
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const module = { exports: {} as Record<string, any> };
  runInNewContext(code, {
    module,
    exports: module.exports,
    require: createRequire(import.meta.url),
    __hooks: hooks,
    console,
    crypto: webcrypto,
    URL,
    URLSearchParams,
    performance,
    structuredClone,
    File,
    Blob,
    ArrayBuffer,
    TextEncoder,
    AbortController,
    btoa,
    atob,
    localStorage: { getItem: () => null, setItem() {} },
    window: {
      addEventListener() {},
      removeEventListener() {},
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    },
    document: {
      hasFocus: () => true,
      documentElement: { dataset: {}, style: {} },
      // Open menus listen for outside clicks; the harness never dispatches them.
      addEventListener() {},
      removeEventListener() {},
    },
    navigator: { languages: ['zh-CN'], language: 'zh-CN' },
    location: { search: '' },
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    ...globals,
  });
  return {
    exports: module.exports,
    render(name: string, props: unknown = {}) {
      let tree: UiNode;
      for (let at = 0; at < 15; at++) {
        hooks.index = 0;
        hooks.dirty = false;
        tree = module.exports[name](props);
        for (const effect of hooks.effects.splice(0)) effect();
        if (!hooks.dirty) return tree;
      }
      throw new Error('Fixture did not settle');
    },
    unmount() {
      for (const slot of hooks.slots) slot?.cleanup?.();
    },
    remount() {
      for (const slot of hooks.slots) slot?.cleanup?.();
      hooks.slots = [];
    },
    flushTimers() {
      for (const timer of timers.splice(0)) if (timer.ms === 0) timer.fn();
    },
  };
}
export const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

export const text = (node: unknown): string => {
  if (Array.isArray(node)) return node.map(text).join('');
  if (node && typeof node === 'object')
    return (
      text((node as UiNode).props?.children) +
      (typeof (node as UiNode).type === 'function'
        ? text([(node as UiNode).props.title, (node as UiNode).props.description, (node as UiNode).props.status])
        : '')
    );
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
};
