import { diagnosticText, redactDiagnosticText, type DiagnosticInput } from './diagnostics.ts';
import { APP_VERSION, GITHUB_REPO_URL } from './identity.ts';

/** Keep the displayed prefill and URL identical, with room for percent-encoded Unicode. */
export function reportIssue(input: DiagnosticInput) {
  const field = (value: string) =>
    Array.from(redactDiagnosticText(value.replace(/[\x00-\x1f\x7f]/g, ' ')).trim() || 'unknown')
      .slice(0, 60)
      .join('');
  const version = field(input.version || APP_VERSION);
  const os = field([input.os || 'unknown', input.arch].filter(Boolean).join(' '));
  const url = new URL(`${GITHUB_REPO_URL}/issues/new`);
  url.searchParams.set('template', 'bug.yml');
  url.searchParams.set('os', os);
  url.searchParams.set('version', version);
  return { url: url.href, version, os, detail: diagnosticText({ ...input, version, os, arch: undefined }) };
}
