import type { CSSProperties } from 'react';
import type { ParticipantKind } from '../shared/participants';
import { participantStyle } from './ParticipantReply';

const wide = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;

/**
 * What an avatar shows for a name: one character for Chinese, Japanese or Korean; for other names the
 * initials of the first two words ("Codex B" → "CB"), a short word whole ("Grok"), or a longer one's first
 * three letters ("Claude" → "Cla").
 */
export function avatarText(name: string): string {
  const text = name.trim();
  if (!text) return '?';
  const first = [...text][0]!;
  if (wide.test(first)) return first;
  const words = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length >= 2) return `${[...words[0]!][0]}${[...words[1]!][0]}`.toUpperCase();
  const word = words[0] ?? text;
  return word.length <= 4 ? word : word.slice(0, 3);
}

/** The same name always gets the same colour, so a member is recognisable across the strip, list and sheet. */
export function avatarTone(name: string, kind?: ParticipantKind): string {
  return participantStyle(name, kind && kind !== 'executor' ? { category: kind } : undefined)[
    '--participant-accent' as keyof CSSProperties
  ] as string;
}

export function Avatar({
  name,
  kind,
  neutral = false,
  size = 26,
  className = '',
}: {
  name: string;
  kind?: ParticipantKind;
  /** The main agent and other non-member identities stay grey. */
  neutral?: boolean;
  size?: number;
  className?: string;
}) {
  const text = neutral ? ([...name][0] ?? '?') : avatarText(name);
  return (
    <span
      className={`avatar ${neutral ? 'neutral' : ''} ${text.length > 2 ? 'long' : ''} ${className}`}
      style={{ '--avatar': avatarTone(name, kind), '--avatar-size': `${size}px` } as CSSProperties}
      aria-hidden="true"
      // A glyph cut from a name, not interface text: "第" must not become "Step".
      translate="no"
    >
      {text}
    </span>
  );
}
