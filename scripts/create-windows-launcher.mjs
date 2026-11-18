import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Keep the hidden development launcher reproducible without changing desktop shortcuts or taskbar IDs. */
export function createWindowsLauncher(root) {
  const directory = join(root, '.data', 'launchers');
  mkdirSync(directory, { recursive: true });
  const target = join(directory, 'start-pugport.vbs');
  copyFileSync(join(root, 'launchers', 'Start-PugPort.vbs'), target);
  return target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  console.log(`Hidden Windows launcher ready: ${createWindowsLauncher(root)}`);
}
