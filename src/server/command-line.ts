/** Splits a command line the way a shell would for plain arguments: spaces separate, quotes group. */
export function splitCommandLine(line: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | undefined;
  let started = false;
  for (const char of line.trim()) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started || current) parts.push(current);
      current = '';
      started = false;
    } else current += char;
  }
  if (started || current) parts.push(current);
  return parts;
}
