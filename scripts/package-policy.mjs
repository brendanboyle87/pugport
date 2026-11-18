import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** Native Mac builds use the host architecture; the established Windows target stays x64. */
export function packageTarget(argv = process.argv.slice(2), host = process) {
  const option = (name) => {
    const index = argv.indexOf(`--${name}`);
    if (index !== -1) {
      if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`Missing --${name} value`);
      return argv[index + 1];
    }
    return argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  };
  const platform = option('platform') ?? (host.platform === 'darwin' ? 'darwin' : 'win32');
  const arch = option('arch') ?? (platform === 'darwin' ? host.arch : 'x64');
  if (!['win32/x64', 'darwin/arm64', 'darwin/x64'].includes(`${platform}/${arch}`))
    throw new Error(`Unsupported desktop package target: ${platform}/${arch}`);
  return { platform, arch };
}

/** Accept either Packager's output directory or the .app that a Mac user copies to Applications. */
export function packageLayout(directory) {
  const root = resolve(directory);
  const bundle = basename(root).endsWith('.app')
    ? root
    : existsSync(join(root, 'PugPort.app', 'Contents'))
      ? join(root, 'PugPort.app')
      : undefined;
  const resources = bundle ? join(bundle, 'Contents', 'Resources') : join(root, 'resources');
  return {
    platform: bundle ? 'darwin' : 'win32',
    bundle,
    resources,
    app: join(resources, 'app'),
    executable: bundle ? join(bundle, 'Contents', 'MacOS', 'PugPort') : join(root, 'PugPort.exe'),
    electronLicense: bundle ? join(resources, 'LICENSE.electron.txt') : join(root, 'LICENSE'),
    chromiumLicense: bundle ? join(resources, 'LICENSES.chromium.html') : join(root, 'LICENSES.chromium.html'),
  };
}

const roots = new Set(['dist', 'node_modules', 'assets', 'licenses', 'docs', 'scripts']);
const files = new Set(['package.json', 'package-lock.json', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']);
const installerScripts = new Set([
  'setup-voice.mjs',
  'setup-image-search.mjs',
  'setup-memory-search.mjs',
  'setup-markitdown.mjs',
  'runtime-paths.mjs',
  'model-download.mjs',
]);

/** Shipping is opt-in: scratch diagnostics, profiles and source never enter the desktop archive. */
export function packageIgnore(path, target = { platform: 'win32', arch: 'x64' }) {
  const normalized = path.replaceAll('\\', '/').replace(/^\//, '');
  if (!normalized) return false;
  const parts = normalized.split('/');
  if (!roots.has(parts[0]) && !files.has(normalized)) return true;
  if (
    parts.some(
      (part) =>
        /^\.tmp(?:[.-]|$)/i.test(part) ||
        /^(?:\.env(?:\..*)?|\.data|\.runtime|\.git|\.claude|\.comborunner)$/i.test(part),
    )
  )
    return true;
  if (/\.pyc$/i.test(normalized)) return true;
  if (/\.(?:log|db|sqlite|sqlite3|db-wal|db-shm)$/i.test(normalized)) return true;
  // Vite and other development tools write caches inside node_modules. They are
  // neither locked dependencies nor application assets and must not ship.
  if (
    parts[0] === 'node_modules' &&
    parts.some((part) => /^(?:\.vite(?:-temp)?|\.cache|\.turbo|\.parcel-cache|\.rollup\.cache|_cacache)$/i.test(part))
  )
    return true;
  if (
    /^node_modules\/\.bin(?:\/|$)/.test(normalized) ||
    /(?:^|\/)node_gyp_bins(?:\/|$)/.test(normalized) ||
    /\.o(?:bj)?$/i.test(normalized)
  )
    return true;
  if (parts[0] === 'scripts' && parts.length > 1 && !installerScripts.has(parts.slice(1).join('/'))) return true;
  const onnx = /^node_modules\/onnxruntime-node\/bin\/[^/]+\/([^/]+)(?:\/([^/]+))?/.exec(normalized);
  if (onnx && (onnx[1] !== target.platform || (onnx[2] && onnx[2] !== target.arch))) return true;
  const nativePackage =
    /^node_modules\/(?:@img\/sharp(?:-libvips)?|@vscode\/ripgrep|sherpa-onnx)-((?:darwin|linux|linuxmusl|win32|win|freebsd|android|wasm32)(?:-[^/]+)?)(?:\/|$)/.exec(
      normalized,
    );
  if (nativePackage) {
    const expected = `${normalized.startsWith('node_modules/sherpa-onnx-') && target.platform === 'win32' ? 'win' : target.platform}-${target.arch}`;
    if (nativePackage[1] !== expected) return true;
  }
  const pty = /^node_modules\/node-pty\/prebuilds\/([^/]+)(?:\/|$)/.exec(normalized);
  if (pty && pty[1] !== `${target.platform}-${target.arch}`) return true;
  if (/^node_modules\/@img\/sharp-wasm32(?:\/|$)/.test(normalized)) return true;
  // Ignore only matching package entries during copying. Never prune the source node_modules junction.
  const mxc = /^node_modules\/@microsoft\/mxc-sdk\/(.+)$/.exec(normalized)?.[1];
  if (
    mxc &&
    ((target.platform !== 'win32' && /^bin(?:\/|$)/.test(mxc)) ||
      /^bin\/(?!x64(?:\/|$))/.test(mxc) ||
      /(?:^|\/)(?:tests?|__tests__)(?:\/|$)/i.test(mxc) ||
      /^bin\/x64\/.*(?:test|benchmark|\.pdb$)/i.test(mxc) ||
      /^bin\/x64\/.*\.(?:so(?:\.\d+)*|dylib)$/i.test(mxc))
  )
    return true;
  return false;
}

export function localComponentsRequested(argv = process.argv) {
  return argv.includes('--with-local-components') || argv.includes('--with-local-models');
}

/** Explicit offline packages can reuse complete local assets; this function never downloads anything. */
export function copyLocalComponents(root, output, { includeComponents = false } = {}) {
  const copied = [];
  if (!includeComponents) return copied;
  const components = [
    {
      name: 'voice/sense-voice',
      required: ['model.int8.onnx', 'tokens.txt'],
      optional: ['README.txt', 'LICENSE', 'LICENSE.txt'],
    },
    {
      name: 'image-search',
      required: ['model.onnx', 'vocab.txt', 'ocr/det.onnx', 'ocr/rec.onnx', 'ocr/keys.txt'],
      optional: ['README.txt'],
    },
    { name: 'memory-search', required: ['model.onnx', 'tokenizer.json'], optional: ['README.txt'] },
  ];
  for (const component of components) {
    const source = join(root, '.runtime', component.name);
    if (!existsSync(source)) continue;
    if (!component.required.every((file) => existsSync(join(source, file))))
      throw new Error(`Incomplete local component: ${component.name}`);
    const target = join(packageLayout(output).resources, component.name);
    for (const file of [...component.required, ...component.optional]) {
      if (!existsSync(join(source, file))) continue;
      mkdirSync(dirname(join(target, file)), { recursive: true });
      copyFileSync(join(source, file), join(target, file));
    }
    copied.push(component.name);
  }
  return copied;
}
