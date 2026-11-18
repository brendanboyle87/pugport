/** The app's windows only ever load its root page; any other in-app destination is refused. */
export function appNavigationAllowed(destination: string, origin: string): boolean {
  try {
    const url = new URL(destination);
    return url.origin === origin && url.pathname === '/';
  } catch {
    return false;
  }
}
