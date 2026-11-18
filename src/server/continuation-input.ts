import type { RunInput } from '../shared/types.ts';

/** Keep every native-session prompt in sync; no suffix clears all continuation candidates. */
export function withContinuationSuffix(input: RunInput, suffix?: string | ((prompt: string) => string)): RunInput {
  if (suffix === undefined)
    return { ...input, continuationRunId: undefined, continuationPrompt: undefined, continuationAlternates: undefined };
  const append = typeof suffix === 'function' ? suffix : (prompt: string) => prompt + suffix;
  return {
    ...input,
    prompt: append(input.prompt),
    ...(input.continuationPrompt ? { continuationPrompt: append(input.continuationPrompt) } : {}),
    ...(input.continuationAlternates
      ? {
          continuationAlternates: input.continuationAlternates.map((candidate) => ({
            ...candidate,
            prompt: append(candidate.prompt),
          })),
        }
      : {}),
  };
}
