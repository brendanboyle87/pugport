import { APP_VERSION } from './identity.ts';
import type { AppState } from './types.ts';

export type DiagnosticInput = {
  version?: string;
  commit?: string;
  os?: string;
  arch?: string;
  packaged?: boolean;
  clis?: readonly { provider: string; version?: string; status: string }[];
};

/** Last-resort filtering preserves diagnostic lines; logs and account labels never enter the builder. */
export function redactDiagnosticText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/https?:\/\/[^\s"<>]+/gi, (url) => url.replace(/[?#].*/, ''))
        .replace(/\b[A-Z]:[\\/][^\r\n"<>|]*/gi, '[path]')
        .replace(/(?:\\\\|(?<!:)\/\/)[^\r\n"<>|]+/g, '[path]')
        .replace(/\/(?:home|Users|root)(?:\/[^\r\n"<>|]*|(?=\s|$))/g, '[path]')
        .replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
        .replace(/\bBearer[ \t]+[^\s,;]+/gi, 'Bearer [secret]')
        .replace(/\b(?:gh[pousr]_|sk-|xai-)[A-Za-z0-9_-]+/g, '[secret]')
        .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[secret]')
        .replace(/\b[\w-]*(?:key|token|secret|password)["']?\s*[:=]\s*["']?[^\s,;"']+/gi, '[secret]'),
    )
    .join('\n');
}

const providers: Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude',
  grok: 'Grok',
  cursor: 'Cursor',
  gemini: 'Gemini',
  pi: 'Pi',
  dsh: 'DSH',
};
const statuses = new Set(['ready', 'unknown', 'auth-required', 'error', 'missing', 'refreshing']);
const field = (value: string | undefined, fallback = 'unknown') =>
  typeof value === 'string' && value.trim() ? value.replace(/[\r\n\t\x00-\x1f]/g, ' ').slice(0, 120) : fallback;

export function diagnosticText(input: DiagnosticInput): string {
  const lines = [`PugPort: ${field(input.version, APP_VERSION)}`];
  if (input.commit !== undefined) lines.push(`Commit: ${field(input.commit, 'dev')}`);
  lines.push(`OS: ${field(input.os)}${input.arch ? ` / ${field(input.arch)}` : ''}`);
  if (input.packaged !== undefined) lines.push(`Build: ${input.packaged ? 'packaged' : 'source'}`);
  for (const cli of input.clis ?? []) {
    if (!Object.hasOwn(providers, cli.provider)) continue;
    lines.push(
      `CLI: ${providers[cli.provider]} / ${typeof cli.version === 'string' && /^[\w.+-]{1,40}(?![\s\S])/.test(cli.version) ? cli.version : 'unknown'} / ${statuses.has(cli.status) ? cli.status : 'unknown'}`,
    );
  }
  return redactDiagnosticText(lines.join('\n'));
}

/** Explicit projection: no spread, data directory, account label, identity, command, or error detail. */
export function diagnosticInput(state: Pick<AppState, 'app' | 'runtimes'>): DiagnosticInput {
  return {
    version: state.app.version,
    commit: state.app.commit ?? 'dev',
    os: state.app.platform,
    arch: state.app.arch,
    packaged: state.app.packaged ?? false,
    clis: state.runtimes
      .filter((runtime) => runtime.installed && !runtime.gateway)
      .map((runtime) => ({
        provider: runtime.provider,
        version: runtime.version,
        status: runtime.status,
      })),
  };
}
