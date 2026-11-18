import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { AppState, Workflow } from '../shared/types';
import type { ConversationPresentation } from '../shared/conversation-presentation';
import type { Api } from './Workspace';

type Request = { id: string; conversationId: string; key: string; revision?: string };
type Entry = { key: string; value: ConversationPresentation };

export class ConversationPresentationClient {
  private entries = new Map<string, Entry>();
  private wanted = new Map<string, Request>();
  private pending = new Map<string, Request>();
  private inFlight = new Map<string, string>();
  private attempted = new Map<string, string>();
  private listeners = new Set<() => void>();
  private draining = false;
  private version = 0;
  constructor(private api: Api) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.version;
  key(workflow: Workflow, revision?: string) {
    return revision ?? JSON.stringify([workflow.updatedAt, workflow.status, workflow.runIds]);
  }
  get(workflow: Workflow, revision?: string) {
    const entry = this.entries.get(workflow.id);
    return entry?.key === this.key(workflow, revision) ? entry.value : undefined;
  }
  request(workflow: Workflow, revision?: string, retry = false) {
    if (workflow.deletedAt) return;
    const key = this.key(workflow, revision);
    const request = { id: workflow.id, conversationId: workflow.conversationId, key, revision };
    if (this.get(workflow, revision)) return;
    if (
      this.attempted.get(workflow.id) === key &&
      (!retry || this.pending.has(workflow.id) || this.inFlight.has(workflow.id))
    )
      return;
    this.wanted.set(workflow.id, request);
    this.attempted.set(workflow.id, key);
    this.pending.set(workflow.id, request);
    if (!this.draining) {
      this.draining = true;
      void Promise.resolve().then(() => this.drain());
    }
  }
  private async drain() {
    try {
      while (this.pending.size) {
        const conversationId = this.pending.values().next().value!.conversationId;
        const batch = [...this.pending.values()].filter((item) => item.conversationId === conversationId).slice(0, 30);
        for (const item of batch) {
          this.pending.delete(item.id);
          this.inFlight.set(item.id, item.key);
        }
        try {
          const result = await this.api<{ presentations: Record<string, ConversationPresentation> }>(
            `/api/conversations/${encodeURIComponent(conversationId)}/presentations?workflows=${batch.map((item) => encodeURIComponent(item.id)).join(',')}`,
          );
          let changed = false;
          for (const item of batch) {
            const value = result?.presentations?.[item.id];
            if (!value || value.workflowId !== item.id || this.wanted.get(item.id)?.key !== item.key) continue;
            if (item.revision && value.revision !== item.revision) continue;
            this.entries.delete(item.id);
            this.entries.set(item.id, { key: item.key, value });
            changed = true;
          }
          while (this.entries.size > 1000) {
            const oldest = this.entries.keys().next().value!;
            this.entries.delete(oldest);
            if (!this.pending.has(oldest) && !this.inFlight.has(oldest)) this.attempted.delete(oldest);
          }
          if (changed) {
            this.version++;
            for (const listener of this.listeners) listener();
          }
        } catch {
          // Keep the existing workflow display; a remount or revision change can retry.
        } finally {
          for (const item of batch) {
            this.inFlight.delete(item.id);
            if (this.wanted.get(item.id)?.key === item.key) this.wanted.delete(item.id);
          }
          for (const id of this.attempted.keys()) {
            if (this.attempted.size <= 1000) break;
            if (!this.pending.has(id) && !this.inFlight.has(id)) this.attempted.delete(id);
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }
}

const clients = new WeakMap<Api, ConversationPresentationClient>();
export function presentationClient(api: Api) {
  let client = clients.get(api);
  if (!client) clients.set(api, (client = new ConversationPresentationClient(api)));
  return client;
}

export function useConversationPresentations(api: Api, state: AppState, workflows: Workflow[], requested: Workflow[]) {
  const client = presentationClient(api);
  const version = useSyncExternalStore(client.subscribe, client.snapshot, client.snapshot);
  const revisions = state.conversationPresentationRevisions;
  const attempted = useRef(new Map<string, string>());
  useEffect(() => {
    attempted.current.clear();
  }, [client]);
  const requestKey = JSON.stringify(
    requested.map((workflow) => [
      workflow.id,
      client.key(workflow, revisions?.[workflow.id]),
      state.conversationPresentations?.[workflow.id]?.revision ?? !!state.conversationPresentations?.[workflow.id],
    ]),
  );
  useEffect(() => {
    const visible = new Set(requested.map((workflow) => workflow.id));
    for (const id of attempted.current.keys()) if (!visible.has(id)) attempted.current.delete(id);
    for (const workflow of requested) {
      const revision = revisions?.[workflow.id];
      const supplied = state.conversationPresentations?.[workflow.id];
      const key = client.key(workflow, revision);
      if (supplied && (!revision || supplied.revision === revision)) {
        attempted.current.delete(workflow.id);
      } else if (attempted.current.get(workflow.id) !== key) {
        attempted.current.set(workflow.id, key);
        client.request(workflow, revision, true);
      }
    }
  }, [client, requestKey]);
  return useMemo(() => {
    const presentations = { ...state.conversationPresentations };
    for (const workflow of workflows) {
      const revision = revisions?.[workflow.id];
      const cached = client.get(workflow, revision);
      const supplied = presentations[workflow.id];
      if (supplied && revision && supplied.revision !== revision) delete presentations[workflow.id];
      if (!presentations[workflow.id] && cached) presentations[workflow.id] = cached;
    }
    return { ...state, conversationPresentations: presentations };
  }, [state, workflows, revisions, client, version]);
}
