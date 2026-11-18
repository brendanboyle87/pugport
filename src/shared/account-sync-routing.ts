import type { SyncValue } from './account-sync.ts';

/** Rewrite operational routing references only, never text or immutable execution history. */
export function mapApiRouting(kind: string, source: SyncValue, resolve: (id: string) => string): SyncValue {
  const value = structuredClone(source);
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const object = node as SyncValue;
    if (typeof object.runtimeId === 'string') object.runtimeId = resolve(object.runtimeId);
    if (Array.isArray(object.automaticExecutors))
      object.automaticExecutors = object.automaticExecutors.map((id) => (typeof id === 'string' ? resolve(id) : id));
    for (const child of Object.values(object)) visit(child);
  };
  if (kind === 'settings') {
    visit(value.routingRules);
    visit(value.routingProfiles);
  }
  if (kind === 'conversation') {
    visit(value.routing);
    visit(value.navigatorRoute);
    visit((value.sideChat as SyncValue | undefined)?.selection);
  }
  return value;
}
