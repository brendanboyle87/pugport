import { currentLocale } from './i18n';
import type { CSSProperties, ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { externalAgentCatalog, type ExternalAgentId } from '../shared/external-agents';
import type { ConversationMessage } from '../shared/types';
import { renderMarkdown } from './markdown';

export type ParticipantIdentity = { id?: string; category: 'external' | 'device' | 'role' };

export function participantIdentity(message?: ConversationMessage, presetId?: string): ParticipantIdentity | undefined {
  if (message?.device) return { id: message.device.id, category: 'device' };
  if (message?.externalAgent) return { id: message.externalAgent.agentId, category: 'external' };
  if (presetId && presetId !== 'standard') return { id: presetId, category: 'role' };
  return undefined;
}

const participantPalette = ['violet', 'amber', 'blue', 'teal', 'slate', 'rose'];
const participantHues: Record<string, string> = {
  muse: 'violet',
  'grok-bot': 'amber',
  'grok bot': 'amber',
};

/** Shared identity keeps cards, avatars and mini-chat turns on the same theme-aware hue. */
export function participantStyle(name: string, identity?: ParticipantIdentity): CSSProperties {
  const canonical = name.split(' · ')[0]!.trim().toLowerCase();
  const key = identity?.id ?? canonical;
  const hash = Array.from(key).reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0);
  const hue =
    identity?.category === 'device'
      ? 'slate'
      : identity?.category === 'role'
        ? 'rose'
        : (participantHues[key] ??
          (!identity?.id ? participantHues[canonical] : undefined) ??
          participantPalette[hash % participantPalette.length]);
  return { '--participant-accent': `var(--participant-${hue})` } as CSSProperties;
}

export function ParticipantAvatar({ name, identity }: { name: string; identity?: ParticipantIdentity }) {
  return (
    <span className="participant-avatar" style={participantStyle(name, identity)} aria-hidden="true" translate="no">
      {Array.from(name)[0]?.toUpperCase()}
    </span>
  );
}

export function participantKind(message: ConversationMessage) {
  if (message.device) return '设备';
  const kind = message.externalAgent && externalAgentCatalog[message.externalAgent.agentId as ExternalAgentId]?.kind;
  if (message.externalAgent && !kind) return '历史消息';
  if (message.externalAgent?.routine) return '例程';
  return kind === 'handoff' ? '桌面应用' : message.externalAgent ? '网页 · 第三方' : '角色';
}

/** `name` and `to` are shown as written (translate="no"): pass them already shown, PugPort's own names translated. */
export function ParticipantHeading({
  name,
  identity,
  kind,
  at,
  to,
  children,
}: {
  name: string;
  identity?: ParticipantIdentity;
  kind?: string;
  at: string;
  to?: string;
  children?: ReactNode;
}) {
  return (
    <div className="participant-heading">
      <ParticipantAvatar name={name} identity={identity} />
      <strong translate="no">{name}</strong>
      {to && (
        <span className="participant-addressee" translate="no">
          → {to}
        </span>
      )}
      {kind && <small className="participant-kind">{kind}</small>}
      <time dateTime={at}>
        {new Date(at).toLocaleTimeString(currentLocale(), { hour: '2-digit', minute: '2-digit' })}
      </time>
      {children}
    </div>
  );
}

export function ParticipantBody({ children }: { children: ReactNode }) {
  return <div className="participant-body">{children}</div>;
}

/** Match only known names and only at mention boundaries; unknown @text stays literal. */
export function MentionText({ text, names }: { text: string; names: string[] }) {
  const escaped = [...new Set(names)]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(^|[\\s（(])@{1,3}(${escaped.join('|')})(?=$|[\\s，。！？、:：;；)）])`, 'gu');
  const plainText = (text: string, key: string) => {
    const parts: ReactNode[] = [];
    let last = 0;
    for (const match of text.matchAll(pattern)) {
      parts.push(text.slice(last, match.index) + match[1]);
      parts.push(
        <span key={`${key}-chip-${match.index}`} className="participant-mention" style={participantStyle(match[2]!)}>
          → {match[2]}
        </span>,
      );
      last = match.index! + match[0].length;
    }
    parts.push(text.slice(last));
    return parts;
  };
  return (
    <div className="message-text markdown" data-path-scope>
      {renderMarkdown(text, { plainText: escaped.length ? plainText : undefined })}
    </div>
  );
}

/** `names` and `preview` (what was said) are shown as written: pass names already shown, like ParticipantHeading. */
export function ConversationExchange({
  names,
  identities,
  count,
  at,
  preview,
  children,
  className = '',
}: {
  names: string[];
  identities?: (ParticipantIdentity | undefined)[];
  count: number;
  at: string;
  preview: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details className={`conversation-exchange ${className}`} style={participantStyle(names[0] ?? '', identities?.[0])}>
      <summary>
        <span className="exchange-avatars">
          {names.map((name, index) => (
            <ParticipantAvatar key={name} name={name} identity={identities?.[index]} />
          ))}
        </span>
        <strong>
          {/* "1 轮" is its own key, so English says "1 turn". */}
          <span translate="no">{names.join(' ↔ ')}</span> · {count === 1 ? '1 轮' : `${count} 轮`}
        </strong>
        <small>对话串</small>
        <time dateTime={at}>
          {new Date(at).toLocaleTimeString(currentLocale(), { hour: '2-digit', minute: '2-digit' })}
        </time>
        <ChevronDown size={13} aria-hidden="true" />
        <span className="exchange-preview" translate="no">
          {preview.replace(/\s+/g, ' ').slice(0, 140)}
        </span>
      </summary>
      <div className="exchange-turns">{children}</div>
    </details>
  );
}
