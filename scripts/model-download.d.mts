export function reportProgress(phase: string, message: string, extra?: Record<string, unknown>): void;
export function downloadVerifiedFile(
  destination: string,
  urls: string[],
  sha256: string,
  options?: { fetchImpl?: typeof fetch },
): Promise<void>;
export function validateArchiveEntries(entries: string[]): void;
export function validateArchiveTypes(listing: string): void;
