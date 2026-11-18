import { useEffect, useLayoutEffect, useRef } from 'react';
import { Check, Plus, Leaf, File, Folder, UserRound } from 'lucide-react';
import { type MentionTier } from '../shared/mentions';
import type { FileReference } from './FileMentions';
import { apiPreset, isFreePreset } from '../shared/api-providers';
import { builtinAgentPresets, type AgentPreset } from '../shared/agent-presets';
import { Avatar } from './avatar';
import { ProviderMark } from './App';
import type { RuntimeTarget } from '../shared/types';
import { isThirdPartyAgent, type ExternalAgentView } from '../shared/external-agents';
import { deviceMentionPrefix, type DeviceView } from '../shared/devices';
import {
  freeChainMentionId,
  participantKey,
  participantKindLabels,
  type ParticipantKind,
} from '../shared/participants';
import { shownName, translateInterfaceText } from './i18n';

const usageKey = 'pugport.mention-usage';
type MentionUsage = Record<string, { count: number; last: number }>;

/**
 * Someone you can call with @@: a role (how to answer), an executor (who answers), an agent outside PugPort
 * (a web agent) that answers itself, or one of the owner's other computers (a device node, id
 * prefixed with "device:") that picks an executor by its own quota. One message may call several of them.
 */
export type MentionItem = {
  kind: ParticipantKind;
  id: string;
  name: string;
  description?: string;
  tier?: MentionTier;
  provider?: RuntimeTarget['provider'];
  apiMark?: string;
};

/** A group of the @@ list: the most used first, then one per kind. */
export type MentionSection = { id: 'frequent' | ParticipantKind; title: string; items: MentionItem[] };

const sectionTitles: Record<MentionSection['id'], string> = { frequent: '常用', ...participantKindLabels };
const kindOrder: ParticipantKind[] = ['role', 'executor', 'device', 'external'];
/** The short tag a 常用 row carries, since that group mixes kinds. */
const kindTags: Record<ParticipantKind, string> = {
  role: '角色',
  executor: '执行器',
  external: '外部',
  device: '设备',
};
/** How many the 常用 group shows at most: a glance, not a second list. */
const frequentLimit = 4;

const usageId = (item: Pick<MentionItem, 'kind' | 'id'>) =>
  item.kind === 'role' ? item.id : `${item.kind}:${item.id}`;

/**
 * A called name as shown (translate="no"): PugPort's own (the free chain, built-in roles, agents outside PugPort,
 * default source names) translate; roles, accounts and devices people named stay as written.
 */
export function shownMentionName(item: Pick<MentionItem, 'kind' | 'id' | 'name'>) {
  if (item.kind === 'external' || item.id === freeChainMentionId) return translateInterfaceText(item.name);
  if (item.kind === 'role')
    return builtinAgentPresets.some((preset) => preset.id === item.id) ? translateInterfaceText(item.name) : item.name;
  return shownName(item.name);
}

/** "Claude · 本机" reads as plain "Claude" after an @; other account names stay as they are. */
export const executorMentionName = (target: Pick<RuntimeTarget, 'label'>) => target.label.replace(/\s*·\s*本机$/u, '');

export function mentionItems(
  presets: readonly AgentPreset[],
  executors: readonly RuntimeTarget[],
  externals: readonly ExternalAgentView[] = [],
  devices: readonly DeviceView[] = [],
  freeSources: readonly RuntimeTarget[] = executors,
): MentionItem[] {
  return [
    ...(freeSources.some(
      (target) => target.enabled && !target.executionDisabledByUser && isFreePreset(target.apiProvider),
    )
      ? [
          {
            kind: 'executor' as const,
            id: freeChainMentionId,
            name: '免费',
            description: '只用免费来源，本地优先；忙时等待，可取消',
          },
        ]
      : []),
    ...presets
      .filter((preset) => preset.id !== 'standard')
      .map((preset): MentionItem => ({
        kind: 'role',
        id: preset.id,
        name: preset.name,
        description: preset.description,
      })),
    ...executors.map((target): MentionItem => ({
      kind: 'executor',
      id: target.id,
      name: executorMentionName(target),
      provider: target.provider,
      ...(target.gateway === 'api'
        ? { apiMark: (apiPreset(target.apiProvider)?.label ?? target.label).slice(0, 1) }
        : {}),
    })),
    // Only ones ready to answer; the 外部智能体 settings card says what the others still need.
    ...externals
      .filter((agent) => agent.available)
      .map((agent): MentionItem => ({
        kind: 'external',
        id: agent.id,
        name: agent.name,
        description: isThirdPartyAgent(agent) ? `${agent.description}；它的回复来自第三方` : agent.description,
      })),
    // Ones known to be offline are left out; the 设备 card says why.
    ...devices
      .filter((device) => device.tunnel || device.online !== false)
      .map((device): MentionItem => ({
        kind: 'device',
        id: `${deviceMentionPrefix}${device.id}`,
        name: device.name,
        ...(device.tunnel ? { tier: 3 as const } : {}),
        description: '交给这台设备回答这一条（它按自己的额度挑执行器）',
      })),
  ];
}

/** How often each was called here; a missing or blocked store simply means no history yet. */
export function readMentionUsage(): MentionUsage {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(usageKey) ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as MentionUsage) : {};
  } catch {
    return {};
  }
}

export function recordMentionUse(item: Pick<MentionItem, 'kind' | 'id'>, now = Date.now()) {
  try {
    const usage = readMentionUsage();
    const key = usageId(item);
    usage[key] = { count: (usage[key]?.count ?? 0) + 1, last: now };
    localStorage.setItem(usageKey, JSON.stringify(usage));
  } catch {
    // Ranking is a convenience; sending never depends on it.
  }
}

/** The ones you call most come first, then the most recent, then the usual list order. */
export function rankMentions(items: readonly MentionItem[], query: string, usage: MentionUsage): MentionItem[] {
  const wanted = query.trim().toLowerCase();
  return items
    .filter((item) => !wanted || item.name.toLowerCase().includes(wanted) || item.id.toLowerCase().includes(wanted))
    .map((item, index) => ({ item, index, used: usage[usageId(item)] }))
    .sort(
      (a, b) =>
        (b.used?.count ?? 0) - (a.used?.count ?? 0) || (b.used?.last ?? 0) - (a.used?.last ?? 0) || a.index - b.index,
    )
    .map((entry) => entry.item);
}

/**
 * The @@ list in groups: 常用 (the few called most, across every kind; only once something has been called), then
 * 角色, 执行器, 外部智能体 and 设备, each by use and then by how recently. What is typed filters every group, and a
 * group left empty is not shown. Ones already called in this message stay in their group, last, to be marked.
 */
export function mentionSections(
  items: readonly MentionItem[],
  query: string,
  usage: MentionUsage,
  called: ReadonlySet<string> = new Set(),
): MentionSection[] {
  const ranked = rankMentions(items, query, usage);
  const frequent = ranked
    .filter((item) => (usage[usageId(item)]?.count ?? 0) > 0 && !called.has(participantKey(item)))
    .slice(0, frequentLimit);
  const shown = new Set(frequent.map(participantKey));
  const sections: MentionSection[] = frequent.length ? [{ id: 'frequent', title: '常用', items: frequent }] : [];
  for (const kind of kindOrder) {
    const rest = ranked.filter((item) => item.kind === kind && !shown.has(participantKey(item)));
    const list = [
      ...rest.filter((item) => !called.has(participantKey(item))),
      ...rest.filter((item) => called.has(participantKey(item))),
    ];
    if (list.length) sections.push({ id: kind, title: sectionTitles[kind], items: list });
  }
  return sections;
}

export function MentionMenu({
  items,
  active,
  onHover,
  onPick,
  onCreate,
  frequent = 0,
  called,
  externalAgentsStatus,
  tier = 1,
  files,
  fileError,
  unconnectedServers = [],
  onPickFile,
  onPickServer,
}: {
  /** In the order shown: the 常用 rows first (see `frequent`), then grouped by kind. */
  items: readonly MentionItem[];
  active: number;
  onHover: (index: number) => void;
  onPick: (item: MentionItem) => void;
  onCreate: () => void;
  /** How many of the first rows form the 常用 group. */
  frequent?: number;
  /** Already called in this message (participant keys): shown marked, and not offered again. */
  called?: ReadonlySet<string>;
  externalAgentsStatus?: 'loading' | 'retrying' | 'failed';
  tier?: MentionTier;
  files?: readonly FileReference[];
  fileError?: string;
  unconnectedServers?: readonly { name: string; ssh?: string; machineId?: string; note?: string }[];
  onPickFile?: (item: FileReference) => void;
  onPickServer?: (server: { name: string; ssh?: string; machineId?: string; note?: string }) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  // Never taller than the room above the composer, so the top rows (常用) are not cut off by the window edge.
  useLayoutEffect(() => {
    const node = list.current;
    const room = node?.parentElement?.getBoundingClientRect().top;
    if (node && room !== undefined) node.style.maxHeight = `${Math.max(150, Math.min(360, Math.floor(room - 16)))}px`;
  });
  // Keyboard moves keep the active row in sight.
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [active, items]);
  const groups: { id: MentionSection['id']; rows: { item: MentionItem; index: number }[] }[] = [];
  items.forEach((item, index) => {
    const id = index < frequent ? 'frequent' : item.kind;
    const last = groups.at(-1);
    if (last?.id === id) last.rows.push({ item, index });
    else groups.push({ id, rows: [{ item, index }] });
  });
  // mousedown is cancelled so the text box keeps focus and the caret stays where you were typing.
  return (
    <div
      className="mention-menu composer-command-menu"
      role="listbox"
      aria-label="叫一个角色、执行器、外部智能体或设备来回答"
      ref={list}
    >
      {groups.map((group) => (
        <div
          className="mention-group"
          role="group"
          aria-label={tier === 3 && group.id === 'device' ? '服务器' : sectionTitles[group.id]}
          key={`${group.id}:${group.rows[0]!.index}`}
        >
          <div className="mention-section" aria-hidden="true">
            {tier === 3 && group.id === 'device' ? '服务器' : sectionTitles[group.id]}
            {group.id === 'executor' && <small> · 直接交给它回答这一条</small>}
          </div>
          {group.rows.map(({ item, index }) => {
            const taken = called?.has(participantKey(item)) ?? false;
            return (
              <button
                type="button"
                role="option"
                key={`${item.kind}:${item.id}`}
                aria-selected={index === active}
                aria-disabled={taken || undefined}
                className={`mention-row ${item.kind} ${index === active ? 'active' : ''} ${taken ? 'called' : ''}`}
                title={taken ? '这条消息已经叫了它' : undefined}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => {
                  if (!taken) onHover(index);
                }}
                onClick={() => {
                  if (!taken) onPick(item);
                }}
              >
                {item.id === freeChainMentionId ? (
                  <Leaf size={28} aria-hidden="true" />
                ) : item.kind === 'role' ? (
                  <UserRound size={28} aria-hidden="true" />
                ) : item.kind === 'executor' && item.apiMark ? (
                  <span className="provider-mark small provider-api" aria-hidden="true" translate="no">
                    {item.apiMark}
                  </span>
                ) : item.kind === 'executor' && item.provider ? (
                  <ProviderMark provider={item.provider} small />
                ) : (
                  <Avatar name={item.name} kind={item.kind} size={28} />
                )}
                <span className="mention-text">
                  <strong translate="no">{shownMentionName(item)}</strong>
                  {item.description && <small>{item.description}</small>}
                </span>
                {taken ? (
                  <span className="mention-called">
                    <Check size={12} aria-hidden="true" />
                    已叫
                  </span>
                ) : (
                  group.id === 'frequent' && <span className="mention-kind">{kindTags[item.kind]}</span>
                )}
              </button>
            );
          })}
        </div>
      ))}
      {unconnectedServers.map((server, index) => {
        const position = items.length + (files?.length ?? 0) + index;
        return (
          <div
            className="mention-group"
            key={server.machineId ?? server.ssh ?? server.name}
            role="group"
            aria-label="服务器"
          >
            <button
              type="button"
              role="option"
              aria-selected={position === active}
              className={`mention-row ${position === active ? 'active' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => onHover(position)}
              onClick={() => onPickServer?.(server)}
            >
              <span className="mention-text">
                <strong>{server.name}</strong>
                <small>{server.note ?? '未接入 · 点一下接入'}</small>
              </span>
            </button>
          </div>
        );
      })}
      {externalAgentsStatus && (
        <div className="mention-group" role="group" aria-label="外部智能体">
          <div className="mention-section" aria-hidden="true">
            外部智能体
          </div>
          <p className="mention-empty" role="status">
            {externalAgentsStatus === 'loading'
              ? '正在加载外部智能体…'
              : externalAgentsStatus === 'retrying'
                ? '外部智能体暂时没加载出来，正在重试…'
                : '外部智能体没加载出来，关掉再打开 @@ 重试'}
          </p>
        </div>
      )}
      {!!(files?.length || fileError) && (
        <div className="mention-group" role="group" aria-label="项目文件">
          <div className="mention-section" aria-hidden="true">
            项目文件
          </div>
          {files?.map((item, index) => (
            <button
              type="button"
              role="option"
              key={item.path}
              aria-selected={items.length + index === active}
              className={`mention-row ${items.length + index === active ? 'active' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => onHover(items.length + index)}
              onClick={() => onPickFile?.(item)}
            >
              {item.kind === 'folder' ? <Folder size={16} /> : <File size={16} />}
              <span className="mention-text">
                {item.path}
                {item.kind === 'folder' ? '/' : ''}
              </span>
            </button>
          ))}
          {!files?.length && fileError && <p className="mention-empty">{fileError}</p>}
        </div>
      )}
      {!items.length && !files?.length && !fileError && !unconnectedServers.length && (
        <p className="mention-empty">{files ? '没有匹配的文件或文件夹' : '没有匹配的角色或智能体'}</p>
      )}
      {tier === 1 && (
        <button
          type="button"
          className="mention-create"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onCreate}
        >
          <Plus size={13} aria-hidden="true" />
          新建角色
        </button>
      )}
      {tier === 1 && <p className="mention-empty">再打一个 @ 叫设备或 Bot</p>}
    </div>
  );
}
