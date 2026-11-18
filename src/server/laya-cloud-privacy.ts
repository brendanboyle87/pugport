import { sanitizeLayaReviewValue } from './laya-review-store.ts';

// Keep public web URLs; remove quoted paths with spaces and recognizable absolute filesystem paths.
const paths =
  /https?:\/\/[^\s"'`<>]+|(["'`])(?:file:\/\/|[a-z]:[\\/]|\\\\|\/(?!\/))[^\r\n]*?\1|\bfile:\/\/[^\s"'`<>]+|\b[a-z]:[\\/][^\s"'`<>|]+|(?:\\\\|(?<!:)\/\/)[^\s\\/"'`<>]+[\\/][^\s"'`<>|]+|(?<![\w:/.~])\/(?!\/)[^\s"'`<>()[\]{},;!?]+/giu;

function redactPaths(value: string): string {
  return value.replace(paths, (match, quote: string | undefined) =>
    /^https?:\/\//i.test(match) ? match : quote ? `${quote}[path]${quote}` : '[path]',
  );
}

/** Outbound inference and training share credential/path scrubbing before any text truncation. */
export function sanitizeLayaCloudValue<T>(value: T): T {
  return sanitizeLayaReviewValue(value, 64_000, true, redactPaths).value;
}
