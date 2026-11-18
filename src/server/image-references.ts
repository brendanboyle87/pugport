import { maxImageReferences } from './image-generation.ts';

/** Where a reference picture came from in the conversation. */
export type ReferenceSource = 'current' | 'last-generated' | 'previous-message';
export type ReferencePick = { id: string; source: ReferenceSource };

// "Keep the person from before": the picture generated last turn is meant, besides what is attached now.
const earlierPicture =
  // 刚才的图片 names the owner's own upload (see sentPicture), and 这个人物 points at what is attached now.
  /(?:刚才|刚刚|之前|前面)(?!的?(?:图|图片|照片))|上一张|上张|原来|保持不变|不变|同一个?人|\bsame\s+(?:person|character|model|woman|man|girl|guy|face)\b|\bprevious\b|\bearlier\b|\blast\s+(?:image|picture|one)\b|\bkeep\s+(?:her|him|them|the\s+(?:person|character|face|model))\b/iu;
// "The picture I sent you": an image the owner attached to their previous message.
const sentPicture =
  /刚才的?(?:图|图片|照片)|刚刚的?(?:图|图片|照片)|上一条|之前(?:发|给)的|前面(?:发|给)的|我(?:给你)?发的|那张(?:图|图片|照片)|(?:服饰|服装|衣服|造型|穿搭)参考|\b(?:image|picture|photo)\s+I\s+(?:sent|attached|gave)\b|\bprevious\s+(?:image|picture|photo|attachment)\b/iu;

/**
 * The pictures an image request draws from, in order: what the owner attaches or quotes now, then the picture generated
 * last turn when the words point back to it, then the images on the owner's previous message when the words name
 * them. A picture dragged back in from the chat is a generated one, so the last result is not added twice.
 */
export function pickImageReferences(input: {
  text: string;
  current: ReadonlyArray<{ id: string; name: string }>;
  /** Attachment ids of pictures PugPort generated in this conversation. */
  generatedIds: ReadonlySet<string>;
  lastGenerated?: string;
  previousMessageImages: readonly string[];
  edit: boolean;
}): ReferencePick[] {
  const picks: ReferencePick[] = input.current.map((file) => ({ id: file.id, source: 'current' }));
  const seen = new Set(picks.map((pick) => pick.id));
  const isGenerated = (file: { id: string; name: string }) =>
    input.generatedIds.has(file.id) || input.generatedIds.has(file.name.replace(/\.[a-z0-9]+$/i, ''));
  const add = (id: string, source: ReferenceSource) => {
    if (seen.has(id)) return;
    seen.add(id);
    picks.push({ id, source });
  };
  if (input.lastGenerated) {
    if (!picks.length) {
      if (input.edit) add(input.lastGenerated, 'last-generated');
    } else if (!input.current.some(isGenerated) && earlierPicture.test(input.text))
      add(input.lastGenerated, 'last-generated');
  }
  if (picks.length && sentPicture.test(input.text))
    for (const id of input.previousMessageImages) add(id, 'previous-message');
  return picks.slice(0, maxImageReferences);
}

export const legendWords: Record<ReferenceSource, string> = {
  current: 'attached or quoted by the owner with this message',
  'last-generated': 'the picture generated in the previous turn',
  'previous-message': "attached by the owner to their previous message (the 'picture I sent')",
};

/** Tells the image model which reference is which; empty when there is at most one picture from this message. */
export function referenceLegend(picks: readonly ReferencePick[]): string {
  if (picks.length < 2 && picks.every((pick) => pick.source === 'current')) return '';
  return [
    'Reference images, in the order given:',
    ...picks.map((pick, index) => `${index + 1}) ${legendWords[pick.source]}.`),
    'Take from each one what the request below says (for example the person from one and the clothing from another).',
  ].join('\n');
}
