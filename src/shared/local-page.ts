/** Pages a page test may open: on this computer only (localhost addresses and local files). */
export function localPageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'file:') return true;
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.localhost');
  } catch {
    return false;
  }
}

/** The page-test browser must never acquire PugPort's operator UI/session authority. */
export function isAppPageRequest(value: string, appPort: number): boolean {
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) &&
      Number(url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80)) === appPort &&
      (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.localhost'))
    );
  } catch {
    return false;
  }
}
