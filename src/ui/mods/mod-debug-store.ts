import { useSyncExternalStore } from 'react';
import type { ModDiagnostic } from '../../shared/mod-debug';

/** Per chat: what its Mod frames reported, newest last (ring of 200), plus Reload requests from the Debug menu. */
export type ModDebugSnapshot = {
  entries: readonly ModDiagnostic[];
  /** Counts since the bound version last connected ("since load"). */
  errors: number;
  logs: number;
  reloads: number;
};
type Chat = ModDebugSnapshot & { loadedAt: number; version?: string; unsent: ModDiagnostic[] };

export const MOD_DEBUG_BUFFER = 200;
const empty: ModDebugSnapshot = Object.freeze({ entries: [], errors: 0, logs: 0, reloads: 0 });
const chats = new Map<string, Chat>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

const chat = (conversationId: string) => {
  let value = chats.get(conversationId);
  if (!value) chats.set(conversationId, (value = { ...empty, entries: [], loadedAt: 0, unsent: [] }));
  return value;
};
const count = (value: Chat) => {
  const recent = value.entries.filter((entry) => entry.at >= value.loadedAt);
  value.errors = recent.filter((entry) => entry.level === 'error').length;
  value.logs = recent.length - value.errors;
};
/** Snapshots are replaced, never mutated, so React sees every change. */
const replace = (conversationId: string, next: Chat) => {
  chats.set(conversationId, next);
  changed();
};

export function recordModDiagnostic(conversationId: string, entry: ModDiagnostic) {
  const value = chat(conversationId);
  const next: Chat = {
    ...value,
    entries: [...value.entries, entry].slice(-MOD_DEBUG_BUFFER),
    unsent: [...value.unsent, entry].slice(-MOD_DEBUG_BUFFER),
  };
  count(next);
  replace(conversationId, next);
}

/** A frame connected; a new version starts the "since load" counts again. */
export function markModLoaded(conversationId: string, version: string, now = Date.now()) {
  const value = chat(conversationId);
  if (value.version === version) return;
  const next: Chat = { ...value, version, loadedAt: now };
  count(next);
  replace(conversationId, next);
}

export function requestModReload(conversationId: string) {
  const value = chat(conversationId);
  replace(conversationId, { ...value, reloads: value.reloads + 1 });
}

/** Entries not yet sent to the server; the caller puts them back on failure. */
export function takeUnsentModDiagnostics(conversationId: string): ModDiagnostic[] {
  const value = chats.get(conversationId);
  if (!value?.unsent.length) return [];
  chats.set(conversationId, { ...value, unsent: [] });
  return value.unsent;
}
export function returnUnsentModDiagnostics(conversationId: string, entries: ModDiagnostic[]) {
  const value = chat(conversationId);
  chats.set(conversationId, { ...value, unsent: [...entries, ...value.unsent].slice(-MOD_DEBUG_BUFFER) });
}

export function modDebugSnapshot(conversationId: string | undefined): ModDebugSnapshot {
  return (conversationId && chats.get(conversationId)) || empty;
}
export function subscribeModDebug(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function useModDebug(conversationId: string | undefined) {
  return useSyncExternalStore(
    subscribeModDebug,
    () => modDebugSnapshot(conversationId),
    () => empty,
  );
}
