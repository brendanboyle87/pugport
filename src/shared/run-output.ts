/** The controller's existing trailing output window, in UTF-16 characters. */
export const runOutputLimit = 1_000_000;

/** Copy only oversized parents; small streamed appends may retain at most twice the output window. */
export function runOutputTail(text: string, limit = runOutputLimit): string {
  if (text.length <= limit) return text;
  const tail = text.slice(-limit);
  return text.length <= 2 * limit ? tail : Buffer.from(tail, 'utf16le').toString('utf16le');
}
