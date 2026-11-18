export function composerEnterAction(
  key: {
    key: string;
    shiftKey: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    repeat?: boolean;
    isComposing?: boolean;
    keyCode?: number;
  },
  composition: { active: boolean; endedAt: number },
  now: number,
  sendKey: 'enter' | 'ctrl-enter' = 'enter',
): 'send' | 'newline' | 'composition' | 'ignore' | 'other' {
  if (key.key !== 'Enter') return 'other';
  if (key.isComposing || key.keyCode === 229 || composition.active) return 'composition';
  // Some Windows IMEs end composition before dispatching the Enter that confirmed a candidate; that Enter
  // arrives within a few milliseconds. A longer guard swallowed a quick typist's real Enter after the last
  // character was chosen.
  if (now - composition.endedAt < 40 || key.repeat || key.altKey) return 'ignore';
  if (sendKey === 'ctrl-enter') return key.ctrlKey || key.metaKey ? 'send' : 'newline';
  return key.shiftKey ? 'newline' : 'send';
}
