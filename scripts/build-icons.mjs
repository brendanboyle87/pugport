// Regenerates assets/icons and the in-app logo from the artwork in assets/brand (see render-icons.cjs), using the project's Electron.
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(
  process.execPath,
  [join(root, 'node_modules', 'electron', 'cli.js'), join(root, 'scripts', 'render-icons.cjs')],
  {
    stdio: 'inherit',
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'ELECTRON_RUN_AS_NODE')),
  },
);
process.exit(result.status ?? 1);
