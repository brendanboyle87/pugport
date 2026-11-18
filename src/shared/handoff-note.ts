/**
 * The handoff note ("交接条") the next executor gets when a task moves to it (src/server/handoff-note.ts builds it).
 * It sits between these markers in the prompt, so the interface can show exactly what was handed over.
 */
export const handoffNoteStart = '<<<PUGPORT_HANDOFF_NOTE>>>';
export const handoffNoteEnd = '<<<END_PUGPORT_HANDOFF_NOTE>>>';

export const handoffNoteBlock = (note: string) => `${handoffNoteStart}\n${note}\n${handoffNoteEnd}`;

/** The last note a prompt carries, if any. */
export function handoffNoteIn(prompt: string | undefined): string | undefined {
  const found = [...(prompt ?? '').matchAll(/<<<PUGPORT_HANDOFF_NOTE>>>\n([\s\S]*?)\n<<<END_PUGPORT_HANDOFF_NOTE>>>/g)];
  return found.at(-1)?.[1];
}

/** Replaces the note in a prompt (the last one, if several). */
export function replaceHandoffNote(prompt: string, note: string): string {
  const current = handoffNoteIn(prompt);
  if (current === undefined) return prompt;
  const old = handoffNoteBlock(current);
  const at = prompt.lastIndexOf(old);
  return prompt.slice(0, at) + handoffNoteBlock(note) + prompt.slice(at + old.length);
}
