import { cleanReasoning } from './trajectory.ts';
import { presentationPreview } from './activity-vocabulary.ts';

/** Keep the previous paragraph headline until the next first line is complete. */
export function reasoningPreview(text: string, streaming = false): string {
  const paragraphs = text.replace(/\r\n/g, '\n').split(/\n[ \t]*\n/);
  let headline = '';
  for (const [index, paragraph] of paragraphs.entries()) {
    const content = paragraph.trimStart();
    if (streaming && index === paragraphs.length - 1 && !content.includes('\n')) break;
    const first = content.split('\n')[0];
    if (first?.trim()) headline = first;
  }
  return presentationPreview(cleanReasoning(headline).replace(/\*\*/g, ''));
}
