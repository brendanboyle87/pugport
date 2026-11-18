import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, isAbsolute, sep, basename } from 'node:path';
import type { RuntimeTarget } from '../shared/types.ts';
import { defaultAccountLabels } from '../shared/accounts.ts';
import { nativeCliProviders } from '../shared/provider-registry.ts';
import { findExecutable, isDirectExecutable } from './platform/executables.ts';

export { findExecutable };

function exists(path: string) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
function refreshCommand(target: RuntimeTarget, next: RuntimeTarget): boolean {
  if (target.command === next.command) return false;
  // A failed search returns a bare fallback name. Do not discard an installed
  // launcher when this process has a stale PATH or an incomplete environment.
  if (isAbsolute(target.command) && exists(target.command) && !(isAbsolute(next.command) && exists(next.command)))
    return false;
  target.command = next.command;
  return true;
}

function officialCodexVersionPath(command: string, platform: NodeJS.Platform, root: string) {
  if (platform !== 'win32' || !isAbsolute(command) || !isAbsolute(root)) return false;
  const parts = relative(root, command).split(sep);
  return parts.length === 2 && /^[a-f0-9]{16}$/i.test(parts[0]!) && parts[1]!.toLowerCase() === 'codex.exe';
}
export function findClaudeExecutable(): string | undefined {
  // Prefer the installed official binary over older PATH wrappers that can inject
  // a different provider. The npm distribution also ships a native executable.
  for (const path of [
    join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'),
    ...(process.platform === 'win32'
      ? [join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')]
      : []),
  ]) {
    if (exists(path)) return path;
  }
  return findExecutable('claude');
}
export function findCursorExecutable(): string | undefined {
  // "agent" is also Grok's binary name. Use Cursor's unique launcher only.
  if (process.platform === 'win32') {
    const root = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'cursor-agent');
    for (const name of ['cursor-agent.exe', 'cursor-agent.cmd']) {
      const command = join(root, name);
      if (exists(command)) return command;
    }
  }
  return findExecutable('cursor-agent');
}
export function defaultTargets(): RuntimeTarget[] {
  let codex = findExecutable('codex');
  if (process.platform === 'win32') {
    const root = join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
    try {
      const binaries = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(root, e.name, 'codex.exe'))
        .filter(exists);
      binaries.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      codex = binaries[0] || codex;
    } catch {
      /* A standalone CLI can still be found on PATH. */
    }
  }
  const targets: RuntimeTarget[] = nativeCliProviders.map((provider) => {
    const target: RuntimeTarget = {
      id: `${provider}-native`,
      provider,
      label:
        defaultAccountLabels[provider as keyof typeof defaultAccountLabels] ??
        `${provider[0]!.toUpperCase()}${provider.slice(1)} · 本机`,
      command: findExecutable(provider) || provider,
      environment: 'native',
      enabled: true,
      commandDiscovery: 'auto',
    };
    if (provider === 'codex') target.command = codex || 'codex';
    if (provider === 'claude') target.command = findClaudeExecutable() || 'claude';
    if (provider === 'cursor')
      Object.assign(target, {
        command: findCursorExecutable() || 'cursor-agent',
        accountingMode: 'subscription' as const,
      });
    return target;
  });
  return targets;
}

/** Add the new factory entry once at application startup, never during dispatch repairs. */
export function addMissingCursorTarget(targets: RuntimeTarget[], discovered = defaultTargets()): boolean {
  const cursor = discovered.find((target) => target.id === 'cursor-native');
  if (!cursor || targets.some((target) => target.id === cursor.id)) return false;
  targets.push({ ...cursor });
  return true;
}

// Older releases stored a version-specific bundled Codex path. Repair only that managed path,
// or an explicit auto-discovery target; preserve custom fixed commands and argument lists.
export function refreshManagedTargets(
  targets: RuntimeTarget[],
  discovered = defaultTargets(),
  platform = process.platform,
  codexRoot = join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin'),
): boolean {
  let changed = false;
  const cursor = discovered.find((target) => target.id === 'cursor-native');
  for (const target of targets) {
    if (
      target.provider === 'grok' &&
      target.id === 'grok-native' &&
      target.environment === 'native' &&
      !target.gateway &&
      !target.accountId &&
      !target.args?.length &&
      target.commandDiscovery !== 'fixed'
    ) {
      const next = discovered.find((value) => value.id === target.id);
      // Older factory Grok entries had no discovery marker. Only adopt a bare default or the
      // exact command rediscovered now; an unrelated custom path is still the owner's choice.
      if (
        next &&
        (target.commandDiscovery === 'auto' || target.command === 'grok' || target.command === next.command)
      ) {
        changed = refreshCommand(target, next) || changed;
        if (target.commandDiscovery !== 'auto') {
          target.commandDiscovery = 'auto';
          changed = true;
        }
      }
      continue;
    }
    if (
      target.provider === 'cursor' &&
      target.id === 'cursor-native' &&
      target.environment === 'native' &&
      !target.gateway &&
      target.commandDiscovery === 'auto' &&
      !target.args?.length
    ) {
      if (cursor) changed = refreshCommand(target, cursor) || changed;
      continue;
    }
    if (
      target.environment === 'native' &&
      target.provider === 'codex' &&
      !target.gateway &&
      target.accountId &&
      target.id === `codex-account-${target.accountId}`
    ) {
      const legacyMissing = !exists(target.command) && officialCodexVersionPath(target.command, platform, codexRoot);
      if (target.commandDiscovery !== 'auto' && !legacyMissing) continue;
      const next = discovered.find((value) => value.id === 'codex-native');
      // Independent account creation requires a direct binary. Never replace it
      // with a PATH wrapper or an executable that has already disappeared.
      if (!next || !isDirectExecutable(next.command)) continue;
      if (target.command !== next.command || target.commandDiscovery !== 'auto') {
        target.command = next.command;
        target.commandDiscovery = 'auto';
        changed = true;
      }
      continue;
    }
    if (
      target.environment === 'native' &&
      target.provider === 'claude' &&
      target.id === 'claude-native' &&
      target.commandDiscovery === 'auto' &&
      !target.args?.length
    ) {
      const next = discovered.find((t) => t.id === target.id);
      if (next) changed = refreshCommand(target, next) || changed;
      continue;
    }
    if (
      target.environment !== 'native' ||
      target.provider !== 'codex' ||
      target.id !== 'codex-native' ||
      target.commandDiscovery === 'fixed' ||
      target.args?.length
    )
      continue;
    const rel = relative(codexRoot, target.command);
    const legacyManaged =
      platform === 'win32' &&
      !isAbsolute(rel) &&
      !rel.startsWith(`..${sep}`) &&
      rel.split(sep).length === 2 &&
      basename(target.command).toLowerCase() === 'codex.exe';
    if (target.commandDiscovery !== 'auto' && !legacyManaged && target.command !== 'codex') continue;
    const next = discovered.find((t) => t.id === target.id);
    if (!next) continue;
    changed = refreshCommand(target, next) || changed;
    if (target.commandDiscovery !== 'auto') {
      target.commandDiscovery = 'auto';
      changed = true;
    }
  }
  return changed;
}
