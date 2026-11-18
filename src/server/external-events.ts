import { createHash } from 'node:crypto';
import type { WorkspaceStore } from './workspace-store.ts';
import type { AdmissionInput, Level, Verdict } from './external-admission.ts';
export type ReceiptState = 'received' | 'working' | 'done' | 'failed' | 'rejected' | 'noted';
export type ExternalEvent = AdmissionInput & {
  id: string;
  eventId: string;
  senderName: string;
  scopeLabel?: string;
  repository?: string;
  permalink?: string;
  channel: string;
  ts: string;
  threadTs?: string;
  text: string;
  quotedContext?: string;
  createdAt: string;
  updatedAt: string;
  level: Level;
  verdict: Verdict;
  reason: string;
  workflowId?: string;
  conversationId?: string;
  dispatching?: boolean;
  dispatchStartedAt?: string;
  decision?: 'approve' | 'reject' | 'always';
  decisionOrder?: number;
  receipt?: {
    identity?: 'owner' | 'app';
    authorLogin?: string;
    state: ReceiptState;
    text: string;
    messages: string[];
    delivered?: string;
    attempts: number;
    nextAttempt: number;
    history: Array<{ state: ReceiptState; at: string; error?: string }>;
  };
};
export class ExternalEvents {
  constructor(
    readonly store: WorkspaceStore,
    readonly now: () => number = Date.now,
  ) {}
  list() {
    return this.store.list<ExternalEvent>('external-event', undefined, Number.MAX_SAFE_INTEGER);
  }
  get(id: string) {
    return this.store.get<ExternalEvent>('external-event', id);
  }
  save(event: ExternalEvent) {
    event.updatedAt = new Date(this.now()).toISOString();
    this.store.save('external-event', event.id, event.source, event);
    return event;
  }
  record(input: Omit<ExternalEvent, 'id' | 'createdAt' | 'updatedAt'>) {
    this.prune();
    const id = createHash('sha256')
      .update(JSON.stringify([input.source, input.eventId]))
      .digest('hex');
    const previous = this.get(id);
    if (previous) {
      previous.text = input.text;
      previous.quotedContext = input.quotedContext;
      this.save(previous);
      return { event: previous, fresh: false };
    }
    const event = this.save({ ...input, id, createdAt: new Date(this.now()).toISOString(), updatedAt: '' });
    return { event, fresh: true };
  }
  prune() {
    for (const e of this.list())
      if (e.verdict === 'ignore' && Date.parse(e.createdAt) < this.now() - 7 * 86400000)
        this.store.deleteRecord('external-event', e.id);
  }
  receipt(id: string, state: ReceiptState, text: string) {
    const e = this.get(id)!;
    e.receipt = {
      ...e.receipt,
      state,
      text,
      messages: e.receipt?.messages ?? [],
      attempts: e.receipt?.attempts ?? 0,
      nextAttempt: 0,
      history: [...(e.receipt?.history ?? []), { state, at: new Date(this.now()).toISOString() }],
    };
    return this.save(e);
  }
  streak(e: ExternalEvent) {
    const entries = this.list()
      .filter((x) => x.source === e.source && x.senderId === e.senderId && x.scope === e.scope && x.decision)
      .sort((a, b) => (b.decisionOrder ?? 0) - (a.decisionOrder ?? 0));
    let n = 0;
    for (const x of entries) {
      if (x.decision === 'reject') break;
      n++;
    }
    return n;
  }
}
