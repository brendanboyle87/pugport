// Opt-in offline runner for the free-source regression suite. No ambient profiles or keys.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'pugport-free-offline-'));
for (const name of [
  'COMBORUNNER_SECRETS_DIR',
  'USERPROFILE',
  'HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'CURSOR_CONFIG_DIR',
]) {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  process.env[name] = path;
}
globalThis.fetch = async () => {
  throw new Error('Offline test: inject fetch explicitly');
};
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
