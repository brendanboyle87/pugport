import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { execFileSync } from 'node:child_process';
import {
  buildUiOnly,
  checkedUiStaging,
  finishUiDirectory,
  newUiBuildId,
  saveUiBaseline,
  uiCompatibility,
} from './ui-release.mjs';
if (process.argv.includes('--ui-only')) {
  const release = await buildUiOnly(process.cwd(), viteBuild);
  console.log(
    `Activated UI ${release.buildId}. Existing windows update when safe; backend and desktop were not rebuilt.`,
  );
  process.exit(0);
}
let commit = 'dev';
try {
  commit =
    execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim() || 'dev';
} catch {
  /* Source archives may not include Git metadata. */
}
const uiRelease = { buildId: newUiBuildId(), compatibility: await uiCompatibility(process.cwd()) };
const uiStaging = await checkedUiStaging(
  process.cwd(),
  `dist/ui-releases/.staging-${uiRelease.buildId}`,
  uiRelease.buildId,
);
await viteBuild({
  configFile: 'src/ui/vite.config.ts',
  base: `/ui-releases/${uiRelease.buildId}/`,
  build: { outDir: uiStaging, emptyOutDir: true },
  define: {
    __PUGPORT_UI_BUILD_ID__: JSON.stringify(uiRelease.buildId),
    __PUGPORT_UI_COMPATIBILITY__: JSON.stringify(uiRelease.compatibility),
  },
});
await finishUiDirectory(uiStaging, uiRelease);
await build({
  entryPoints: ['src/server/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  target: 'node24',
  outfile: 'dist/server/main.js',
  sourcemap: true,
  define: {
    __PUGPORT_UI_COMPATIBILITY__: JSON.stringify(uiRelease.compatibility),
    __PUGPORT_UI_BASELINE_BUILD_ID__: JSON.stringify(uiRelease.buildId),
    __PUGPORT_COMMIT__: JSON.stringify(commit),
  },
});
await build({
  entryPoints: ['src/server/bootstrap.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['./main.js'],
  target: 'node24',
  outfile: 'dist/server/bootstrap.js',
});
await build({
  entryPoints: ['src/server/sandbox/helper-entry.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  target: 'node24',
  outfile: 'dist/server/mxc-helper.js',
});
await build({
  entryPoints: ['src/server/local-memory-worker.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  target: 'node24',
  outfile: 'dist/server/local-memory-worker.js',
});
await build({
  entryPoints: ['src/server/local-memory-cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  target: 'node24',
  outfile: 'dist/server/local-memory-cli.js',
});
await build({
  entryPoints: [
    'src/server/vector-cache-worker.ts',
    'src/server/memory-retrieval-worker.ts',
    'src/server/image-search-worker.ts',
    'src/server/memory-vector-worker.ts',
  ],
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  target: 'node24',
  outdir: 'dist/server',
});
await build({
  entryPoints: ['src/server/image-match-worker.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  target: 'node24',
  outfile: 'dist/server/image-match-worker.js',
});
await build({
  entryPoints: [
    'src/server/grok-history-worker.ts',
    'src/server/native-discovery-helper.ts',
    'src/server/native-discovery-worker.ts',
  ],
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  target: 'node24',
  outdir: 'dist/server',
});
// The pugport MCP server other AI agents launch; standalone (Node built-ins only), next to the server bundle.
await build({
  entryPoints: ['src/mcp/pugport-mcp.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  outfile: 'dist/server/pugport-mcp.js',
});
// The pugport terminal command, standalone with its terminal UI bundled in; its launchers go inside dist so the
// packaged app ships them (resources/app/dist/bin), which is the folder users add to PATH.
await build({
  entryPoints: ['src/cli/pugport.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  outfile: 'dist/cli/pugport.js',
  banner: { js: '#!/usr/bin/env node' },
});
await mkdir('dist/bin', { recursive: true });
await copyFile('bin/pugport.cmd', 'dist/bin/pugport.cmd');
await copyFile('bin/pugport', 'dist/bin/pugport');
await chmod('dist/bin/pugport', 0o755);
await build({
  entryPoints: ['src/electron/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  target: 'node24',
  outfile: 'dist/electron/main.cjs',
  sourcemap: true,
  define: { __PUGPORT_COMMIT__: JSON.stringify(commit) },
});
await build({
  entryPoints: ['src/electron/preload.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  target: 'node24',
  outfile: 'dist/electron/preload.cjs',
  sourcemap: true,
});
await build({
  entryPoints: ['src/server/pi-extension.mjs'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  // Pi resolves its own QuickJS worker/assets relative to the installed package.
  packages: 'external',
  target: 'node22',
  outfile: 'dist/server/pi-extension.mjs',
});
await copyFile('scripts/hindsight-service.py', 'dist/server/hindsight-service.py');
await copyFile('scripts/laya-worker.py', 'dist/server/laya-worker.py');
await saveUiBaseline(process.cwd(), uiRelease, uiStaging);
console.log(`Built UI ${uiRelease.buildId}, local server and Electron desktop.`);
// Optional and last: branding the development Electron must never stop the UI release above from publishing.
try {
  await (await import('./brand-electron.mjs')).brandElectron();
} catch (error) {
  console.warn(`Could not brand Electron (${error?.message ?? error}).`);
}
