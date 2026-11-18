import { listAgentPresets, type AgentPreset } from '../shared/agent-presets.ts';
import { isFreePreset } from '../shared/api-providers.ts';
import { mentionPrefixAt } from '../shared/mentions.ts';
import { freeChainMentionId, participantKindLabels, type CalledParticipant } from '../shared/participants.ts';
import type { DeviceView } from '../shared/devices.ts';
import type { ExternalAgentView } from '../shared/external-agents.ts';
import type { RuntimeTarget } from '../shared/types.ts';
import { availableCoreTargets } from '../ui/core-runtime.ts';
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from './pi-tui.ts';

/** Someone you can call with @, as in the desktop composer: a role (how to answer) or an executor (who answers). */
export type MentionItem = CalledParticipant & { description?: string };
export type SlashCommand = { name: string; description: string };

/** "Claude · 本机" reads as plain "Claude" after an @ (same rule as the desktop app). */
const executorName = (target: Pick<RuntimeTarget, 'label'>) => target.label.replace(/\s*·\s*本机$/u, '');

export function mentionItems(
  customPresets: readonly AgentPreset[] = [],
  targets: RuntimeTarget[] = [],
  externals: readonly ExternalAgentView[] = [],
  devices: readonly DeviceView[] = [],
): MentionItem[] {
  return [
    ...(targets.some((target) => target.enabled && !target.executionDisabledByUser && isFreePreset(target.apiProvider))
      ? [{ kind: 'executor' as const, id: freeChainMentionId, name: '免费', description: '只用免费来源' }]
      : []),
    ...listAgentPresets(customPresets)
      .filter((preset) => preset.id !== 'standard')
      .map((preset): MentionItem => ({
        kind: 'role',
        id: preset.id,
        name: preset.name,
        description: preset.description,
      })),
    ...externals
      .filter((agent) => agent.available)
      .map((agent): MentionItem => ({
        kind: 'external',
        id: agent.id,
        name: agent.name,
        description: agent.description,
      })),
    ...devices
      .filter((device) => device.tunnel || device.online !== false)
      .map((device): MentionItem => ({
        kind: 'device',
        id: device.id,
        name: device.name,
        ...(device.tunnel ? { tier: 3 as const } : {}),
        description: '交给这台设备回答这一条',
      })),
    ...availableCoreTargets(targets).map((target): MentionItem => ({
      kind: 'executor',
      id: target.id,
      name: executorName(target),
      description: '直接交给它回答这一条',
    })),
  ];
}

/** Names that start with what was typed come first, then any that contain it. */
export function rankMentions(items: readonly MentionItem[], query: string): MentionItem[] {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return [...items];
  const starts = items.filter((item) => item.name.toLowerCase().startsWith(wanted));
  const contains = items.filter(
    (item) =>
      !starts.includes(item) && (item.name.toLowerCase().includes(wanted) || item.id.toLowerCase().includes(wanted)),
  );
  return [...starts, ...contains];
}

/** Completes `/commands` at the start of the message and `@role` / `@executor` anywhere. */
export class PugAutocomplete implements AutocompleteProvider {
  readonly triggerCharacters = ['@'];
  constructor(
    private readonly commands: readonly SlashCommand[],
    private readonly items: () => readonly MentionItem[],
    private readonly loadOutside: () => Promise<void> = async () => {},
  ) {}

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): Promise<AutocompleteSuggestions | null> {
    const before = (lines[cursorLine] ?? '').slice(0, cursorCol);
    const slash = cursorLine === 0 ? /^\/(\S*)$/u.exec(before) : null;
    if (slash) {
      const items = this.commands
        .filter((command) => command.name.startsWith(slash[1]!.toLowerCase()))
        .map((command) => ({ value: `/${command.name}`, label: `/${command.name}`, description: command.description }));
      return items.length ? { items, prefix: before } : null;
    }
    const mention = mentionPrefixAt(before, before.length);
    if (!mention || mention.query.length > 24) return null;
    if (mention.tier >= 2) {
      try {
        await this.loadOutside();
      } catch {
        return null;
      }
    }
    const prefix = '@'.repeat(mention.tier);
    const items: AutocompleteItem[] = rankMentions(
      this.items().filter((item) =>
        mention.tier === 1
          ? item.kind === 'role' || item.kind === 'executor'
          : mention.tier === 2
            ? (item.kind === 'device' && item.tier !== 3) || item.kind === 'external'
            : item.kind === 'device' && item.tier === 3,
      ),
      mention.query,
    ).map((item) => ({
      value: `${prefix}${item.name}`,
      label: item.name,
      description: `${participantKindLabels[item.kind]} · ${item.description ?? ''}`
        .replace(/\s+/g, ' ')
        .replace(/ · $/, ''),
    }));
    return items.length ? { items, prefix: `${prefix}${mention.query}` } : null;
  }

  applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string) {
    const line = lines[cursorLine] ?? '';
    const start = cursorCol - prefix.length;
    const rest = line.slice(cursorCol).replace(/^ /, '');
    const inserted = item.value.startsWith('/') ? item.value : `${item.value} `;
    const next = [...lines];
    next[cursorLine] = line.slice(0, start) + inserted + rest;
    return { lines: next, cursorLine, cursorCol: start + inserted.length };
  }
}
