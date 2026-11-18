import type { Gh } from './maintainer/gh.ts';

/** Keep gh credential handling in the existing adapter, retaining REST rate-limit headers. */
export function githubChannelTransport(owner: Gh, app: Gh) {
  return async (path: string, options: { method?: string; body?: unknown; identity?: 'owner' | 'app' } = {}) => {
    if (!/^(?:user$|repos\/[\w.-]+\/[\w.-]+(?:\/|$))/.test(path)) throw new Error('Invalid GitHub channel path');
    const gh = options.identity === 'app' ? app : owner;
    const result = await gh.run(
      ['api', '--include', '--method', options.method ?? 'GET', path, ...(options.body ? ['--input', '-'] : [])],
      options.body ? { input: JSON.stringify(options.body) } : undefined,
    );
    const output = result.stdout;
    const split = /\r?\n\r?\n/.exec(output);
    if (!split) throw new Error('Missing GitHub response headers');
    const statusLine = /^HTTP\/\d(?:\.\d)? ([1-5]\d{2})(?:[^\r\n]*)\r?\n/.exec(output);
    if (!statusLine) throw new Error('Invalid GitHub HTTP status');
    const status = Number(statusLine[1]);
    if (result.code !== 0 && status < 400) throw new Error('GitHub CLI failed without an HTTP error');
    const headers: Record<string, string> = {};
    for (const line of output.slice(0, split.index).split(/\r?\n/)) {
      const colon = line.indexOf(':');
      if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
    }
    const body = output.slice(split.index + split[0].length).trim();
    return {
      status,
      data: body ? (JSON.parse(body) as unknown) : null,
      headers,
      identity: options.identity ?? ('owner' as const),
    };
  };
}
