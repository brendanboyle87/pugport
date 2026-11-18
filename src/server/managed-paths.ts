import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { RuntimeTarget } from '../shared/types.ts';
import { managedNodeRuntime } from './platform/node-runtime.ts';

const piEntryParts = ['node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js'];
const samePath = (left: string, right: string) => {
  const a = resolve(left),
    b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
};

function legacyExecutable(command: string, oldRoot: string): boolean {
  if (!isAbsolute(command)) return false;
  return [
    process.execPath,
    join(oldRoot, '.runtime', 'node.exe'),
    join(oldRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
    join(oldRoot, 'node_modules', 'electron', 'dist', 'electron'),
    join(oldRoot, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
  ].some((expected) => samePath(command, expected));
}

/** Repair a relocated bundled Pi entry without replacing custom launch options or session history. */
export function repairManagedPiTarget(targets: RuntimeTarget[], root: string, dataDir: string): boolean {
  const nextEntry = join(root, ...piEntryParts);
  if (!existsSync(nextEntry)) return false;
  let changed = false;
  for (const target of targets) {
    if (
      target.id !== 'pi-local' ||
      target.provider !== 'pi' ||
      target.environment !== 'native' ||
      target.commandDiscovery === 'fixed'
    )
      continue;
    const args = target.args;
    if (!args || args.length !== 3 || args[1] !== '--session-dir' || !isAbsolute(args[0]) || !isAbsolute(args[2]))
      continue;
    let oldRoot = resolve(args[0]);
    for (const _ of piEntryParts) oldRoot = dirname(oldRoot);
    if (!samePath(args[0], join(oldRoot, ...piEntryParts))) continue;
    const missingEntry = !existsSync(args[0]);
    if (!missingEntry && (process.platform !== 'win32' || !samePath(args[0], nextEntry))) continue;
    // Auto is an explicit managed-path choice. Legacy unmarked targets must also match
    // the original runtime command, including Electron inside the relocated checkout.
    if ((!missingEntry || target.commandDiscovery !== 'auto') && !legacyExecutable(target.command, oldRoot)) continue;
    const command = managedNodeRuntime(root);
    if (!missingEntry) {
      if (samePath(target.command, command)) continue;
      target.command = command;
      target.commandDiscovery = 'auto';
      changed = true;
      continue;
    }
    let sessions = args[2];
    if (!existsSync(sessions) && samePath(sessions, join(oldRoot, '.data', 'pi', 'sessions')))
      sessions = join(dataDir, 'pi', 'sessions');
    target.command = command;
    target.args = [nextEntry, '--session-dir', sessions];
    target.commandDiscovery = 'auto';
    changed = true;
  }
  return changed;
}
