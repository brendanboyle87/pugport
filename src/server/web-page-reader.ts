import { lookup as systemLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * Reads a public web page straight from this computer, for when the search provider cannot. It only ever talks to
 * public addresses: the URL, every redirect and every address its host resolves to are checked first, so a page cannot
 * point the reader at the owner's router or another machine on their network.
 */

const privateAddresses = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const)
  privateAddresses.addSubnet(address, prefix);
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
] as const)
  privateAddresses.addSubnet(address, prefix, 'ipv6');

const publicIpv6 = (address: string) => /^[23][0-9a-f]{3}:/.test(address) && !privateAddresses.check(address, 'ipv6');

export function publicUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192 || /[\s\x00-\x1f\x7f]/.test(value))
    throw new Error('Use a public HTTP or HTTPS URL.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Use a public HTTP or HTTPS URL.');
  }
  const host = url.hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '');
  const ip = isIP(host);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (ip === 4 && privateAddresses.check(host)) ||
    (ip === 6 && !publicIpv6(host)) ||
    (!ip && (!host.includes('.') || /(?:^|\.)(?:localhost|local|internal|lan|home|invalid|test)$/.test(host)))
  )
    throw new Error('Use a public HTTP or HTTPS URL.');
  return url.href;
}

export type PageReaderDependencies = {
  fetch?: typeof fetch;
  lookup?: (hostname: string) => Promise<ReadonlyArray<{ address: string }>>;
  timeoutMs?: number;
};
export type ReadPage = { url: string; title: string; content: string; truncated: boolean };

/** Messages written here, safe to show: never a transport error's own text. */
export class PageReadError extends Error {}

const maximumRedirects = 5;
const maximumPageBytes = 4 * 1024 * 1024;
const maximumContentChars = 32000;
const notPublic = 'Page address is not public.';

async function assertPublicHost(url: string, lookup: NonNullable<PageReaderDependencies['lookup']>) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return;
  const addresses = await lookup(host);
  const safe = (address: string) => {
    const family = isIP(address);
    return family === 4 ? !privateAddresses.check(address) : family === 6 && publicIpv6(address.toLowerCase());
  };
  // One private answer is enough to refuse: the connection could land on any of them.
  if (!addresses.length || !addresses.every((item) => safe(item.address))) throw new PageReadError(notPublic);
}

const entities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};
function decodeEntities(value: string): string {
  return value.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] !== '#') return entities[body.toLowerCase()] ?? whole;
    const code = body[1]?.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
  });
}
function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\b[^>]*>/gi, '\n')
      .replace(/<\/(?:p|div|section|article|main|h[1-6]|li|tr|blockquote|pre|ul|ol|table)\s*>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\r\v ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
/** The page's main text: its article or main element when that holds real content, otherwise the whole page. */
export function pageTextFromHtml(html: string): { title: string; content: string } {
  const title = htmlToText(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1] ?? '').slice(0, 300);
  const clean = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|head|nav|footer|aside|form)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  for (const tag of ['article', 'main']) {
    const inner = new RegExp(`<${tag}\\b[\\s\\S]*</${tag}\\s*>`, 'i').exec(clean)?.[0];
    const text = inner ? htmlToText(inner) : '';
    if (text.length >= 200) return { title, content: text };
  }
  return { title, content: htmlToText(clean) };
}

async function pageBody(response: Response): Promise<{ bytes: Buffer; complete: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) throw new PageReadError('Page has no readable text.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return { bytes: Buffer.concat(chunks), complete: true };
    size += chunk.value.byteLength;
    chunks.push(chunk.value);
    if (size >= maximumPageBytes) {
      void reader.cancel().catch(() => undefined);
      return { bytes: Buffer.concat(chunks).subarray(0, maximumPageBytes), complete: false };
    }
  }
}
function decodeBody(bytes: Buffer, contentType: string): string {
  const charset =
    /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ??
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(bytes.subarray(0, 4096).toString('latin1'))?.[1] ??
    'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

export async function readPublicPage(
  value: string,
  deps: PageReaderDependencies = {},
  signal?: AbortSignal,
): Promise<ReadPage> {
  const timeout = AbortSignal.timeout(deps.timeoutMs ?? 15000);
  const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const lookup = deps.lookup ?? ((hostname: string) => systemLookup(hostname, { all: true }));
  try {
    let url = publicUrl(value);
    for (let hop = 0; hop <= maximumRedirects; hop++) {
      await assertPublicHost(url, lookup);
      const response = await (deps.fetch ?? fetch)(url, {
        redirect: 'manual',
        signal: abort,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; PugPort; +https://pugport.com)',
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        },
      });
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => undefined);
        const location = response.headers.get('location');
        if (!location) throw new PageReadError(`Page answered HTTP ${response.status}.`);
        url = publicUrl(new URL(location, url).href);
        continue;
      }
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => undefined);
        throw new PageReadError(`Page answered HTTP ${response.status}.`);
      }
      const contentType = (response.headers.get('content-type') ?? 'text/html').toLowerCase();
      if (!/text\/|html|xml|json/.test(contentType)) {
        void response.body?.cancel().catch(() => undefined);
        throw new PageReadError('Page is not readable text.');
      }
      const { bytes, complete } = await pageBody(response);
      const body = decodeBody(bytes, contentType);
      const page = /html|xml/.test(contentType)
        ? pageTextFromHtml(body)
        : { title: '', content: body.replace(/\r\n?/g, '\n').trim() };
      if (!page.content) throw new PageReadError('Page has no readable text.');
      return {
        url,
        title: page.title,
        content: page.content.slice(0, maximumContentChars),
        truncated: !complete || page.content.length > maximumContentChars,
      };
    }
    throw new PageReadError('Page redirects too many times.');
  } catch (error) {
    if (signal?.aborted) throw new PageReadError('Page request was cancelled.');
    if (error instanceof PageReadError) throw error;
    if (timeout.aborted) throw new PageReadError('Page request timed out.');
    if (error instanceof Error && error.message === 'Use a public HTTP or HTTPS URL.')
      throw new PageReadError(notPublic);
    throw new PageReadError('Page could not be reached.');
  }
}
