import { createHash, randomUUID } from 'node:crypto';
import type { HindsightSettings } from '../shared/hindsight.ts';
import type { Conversation, ConversationMessage, Project, Workflow } from '../shared/types.ts';
import type { HindsightJob } from './hindsight-model-bridge.ts';
import { applyMemoryEvidence, fuseHits, type RetrievalInput, type RetrievedMemory } from './memory-retrieval.ts';
import { assessLocalMemoryEvidence } from './memory-evidence.ts';
import { notThirdParty, type MemorySearchHit, type WorkspaceStore } from './workspace-store.ts';

type Source = { messageId: string; hash: string };
type Document = {
  id: string;
  bank: string;
  projectId: string;
  workflowId: string;
  sources: Source[];
  state: 'queued' | 'running' | 'retained' | 'failed' | 'revoked';
  createdAt: string;
  uncertainSession?: string;
};
type RetiredBank = { projectId: string; bank: string; waitForSession?: string };
export type HindsightMemoryTrace = {
  operation: 'recall' | 'retain' | 'delete';
  status: 'found' | 'empty' | 'fallback' | 'queued' | 'completed' | 'failed';
  projectId: string;
  workflowId?: string;
  bank: string;
  documentIds: string[];
  sourceMessageIds: string[];
  elapsedMs: number;
  reason?: string;
  modelRunIds?: string[];
};
type Runtime = {
  endpoint(): { baseUrl: string; token: string } | null;
  withJob<T>(context: HindsightJob, work: () => Promise<T>): Promise<T>;
};
type Host = {
  store: WorkspaceStore;
  runtime: Runtime;
  settings(): HindsightSettings;
  idle(): boolean;
  audit(record: HindsightMemoryTrace): void;
  modelRun?(workflowId: string, runId: string): void;
  fetch?: typeof fetch;
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Remote facts select local evidence. They never become instructions or authoritative claims. */
export class HindsightMemory {
  private busy?: Promise<void>;
  private closed = false;
  private active = new Set<AbortController>();
  private nextCheck = 0;
  private retaining?: { bank: string; remoteFinished: boolean; remoteStarted: boolean };
  private retainAbort?: AbortController;
  private instance: string;

  constructor(private host: Host) {
    const old = host.store.get<{ id: string }>('hindsight-instance', 'local');
    this.instance = old?.id ?? randomUUID();
    if (!old) host.store.save('hindsight-instance', 'local', '', { id: this.instance });
    // A crashed extraction may have spent tokens. Do not silently replay it after a restart.
    for (const item of host.store.list<Document>('hindsight-document'))
      if (item.state === 'running') this.save({ ...item, state: 'failed' });
  }

  bank(projectId: string) {
    const generation = this.host.store.get<{ id: string }>('hindsight-generation', projectId)?.id ?? 'initial';
    return `pugport-${hash(`${this.instance}:${projectId}:${generation}`).slice(0, 40)}`;
  }

  private enabled(projectId: string) {
    const settings = this.host.settings();
    const project = this.host.store.get<Project>('project', projectId);
    return (
      !this.closed && settings.enabled && settings.projectIds.includes(projectId) && !!project && !project.removedAt
    );
  }

  private source(projectId: string, id: string, input?: RetrievalInput): ConversationMessage | undefined {
    const store = this.host.store;
    const message = store.get<ConversationMessage>('message', id);
    if (!message || !message.content || !['user', 'assistant'].includes(message.role)) return;
    const conversation = store.get<Conversation>('conversation', message.conversationId);
    if (
      !conversation ||
      conversation.projectId !== projectId ||
      conversation.deletedAt ||
      conversation.sideChat ||
      !store.memoryEnabled(conversation.id) ||
      store.untrustedConversation(conversation.id)
    )
      return;
    const trusted = store.db
      .prepare(
        `SELECT rowid FROM workspace_records message WHERE kind='message' AND id=? AND ${notThirdParty()}
      AND json_extract(value,'$.replyIdentity.kind') IS NOT 'system'`,
      )
      .get(id) as { rowid: number } | undefined;
    if (!trusted) return;
    if (input) {
      if (!store.memoryEnabled(input.conversationId)) return;
      const anchor = store.get<ConversationMessage>('message', input.userMessageId);
      const reader = store.get<Conversation>('conversation', input.conversationId);
      if (
        !anchor ||
        anchor.conversationId !== input.conversationId ||
        reader?.projectId !== projectId ||
        reader.deletedAt ||
        reader.sideChat
      )
        return;
      const position = store.db
        .prepare("SELECT rowid FROM workspace_records WHERE kind='message' AND id=?")
        .get(anchor.id) as { rowid: number };
      if (message.conversationId === input.conversationId) {
        if (
          trusted.rowid >= position.rowid &&
          !(message.importedFrom?.provider === 'grok' && message.createdAt <= anchor.createdAt)
        )
          return;
      } else if (message.createdAt > anchor.createdAt) return;
    }
    return message;
  }

  private current(document: Document, input?: RetrievalInput) {
    if (!this.enabled(document.projectId) || document.bank !== this.bank(document.projectId)) return [];
    const sources = document.sources.map((source) => {
      const message = this.source(document.projectId, source.messageId, input);
      return message && hash(message.content) === source.hash ? message : undefined;
    });
    return sources.every(Boolean) ? (sources as ConversationMessage[]) : [];
  }

  private save(document: Document) {
    if (!this.host.store.db.isOpen) return;
    const owner = this.host.store.get<Project>('project', document.projectId);
    if (!owner || owner.removedAt || this.host.store.get('project-purge', document.projectId)) return;
    this.host.store.save('hindsight-document', document.id, document.projectId, document);
  }

  private async request(
    path: string,
    body: unknown,
    timeout: number,
    method = 'POST',
    background = false,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const endpoint = this.host.runtime.endpoint();
    if (!endpoint) throw Error('service-unavailable');
    const abort = new AbortController();
    const cancel = () => abort.abort(signal?.reason);
    signal?.addEventListener('abort', cancel, { once: true });
    this.active.add(abort);
    if (background) this.retainAbort = abort;
    const timer = setTimeout(() => abort.abort(), timeout);
    const work = async () => {
      const response = await (this.host.fetch ?? fetch)(`${endpoint.baseUrl}${path}`, {
        method,
        redirect: 'error',
        signal: abort.signal,
        headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw Error(`service-http-${response.status}`);
      const reader = response.body?.getReader();
      if (!reader) return {};
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          bytes += item.value.byteLength;
          if (bytes > 512 * 1024) throw Error('service-response-too-large');
          chunks.push(item.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    };
    // The outer deadline also covers a transport implementation that does not honor AbortSignal.
    const deadline = new Promise<never>((_, reject) =>
      abort.signal.addEventListener('abort', () => reject(Error('service-timeout')), { once: true }),
    );
    try {
      return await Promise.race([work(), deadline]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      this.active.delete(abort);
      if (this.retainAbort === abort) this.retainAbort = undefined;
    }
  }

  async recall(
    input: RetrievalInput,
    local: RetrievedMemory,
    workflowId?: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<RetrievedMemory> {
    options.signal?.throwIfAborted();
    if (!this.enabled(input.projectId) || !this.host.store.memoryEnabled(input.conversationId)) return local;
    const started = Date.now(),
      bank = this.bank(input.projectId);
    const trace: HindsightMemoryTrace = {
      operation: 'recall',
      status: 'fallback',
      projectId: input.projectId,
      workflowId,
      bank,
      documentIds: [],
      sourceMessageIds: [],
      elapsedMs: 0,
    };
    try {
      if (!this.host.runtime.endpoint()) throw Error('service-unavailable');
      const response = (await this.request(
        `/v1/default/banks/${bank}/memories/recall`,
        {
          query: [...input.query].slice(0, 160).join(''),
          budget: 'low',
          max_tokens: 1800,
          trace: true,
          types: ['world', 'experience', 'observation'],
          include: { source_facts: { max_tokens: 3000 } },
        },
        this.host.settings().recallTimeoutMs,
        'POST',
        false,
        options.signal,
      )) as {
        results?: Array<{ id?: string; document_id?: string; source_fact_ids?: string[] }>;
        source_facts?: Record<string, { document_id?: string }>;
      };
      options.signal?.throwIfAborted();
      if (!Array.isArray(response.results)) throw Error('service-response-invalid');
      const documents = new Set<string>();
      for (const fact of response.results.slice(0, 24)) {
        if (typeof fact.document_id === 'string') documents.add(fact.document_id);
        for (const sourceId of (fact.source_fact_ids ?? []).slice(0, 24)) {
          const id = response.source_facts?.[sourceId]?.document_id;
          if (typeof id === 'string') documents.add(id);
        }
      }
      const hits: MemorySearchHit[] = [];
      for (const id of [...documents].slice(0, 24)) {
        const document = this.host.store.get<Document>('hindsight-document', id);
        if (
          !document ||
          document.projectId !== input.projectId ||
          document.bank !== bank ||
          document.state !== 'retained'
        )
          continue;
        const messages = this.current(document, input);
        if (!messages.length) continue;
        trace.documentIds.push(id);
        for (const message of messages) {
          if (hits.some((hit) => hit.messageId === message.id)) continue;
          hits.push({
            messageId: message.id,
            conversationId: message.conversationId,
            role: message.role,
            createdAt: message.createdAt,
            excerpt: message.content.slice(0, 1800),
            sourceOffset: 0,
            score: 1 / (hits.length + 1),
          });
        }
      }
      // Recheck switches and source hashes after the service await; an opt-out takes effect immediately.
      if (!this.enabled(input.projectId)) throw Error('memory-disabled');
      const excerpts = fuseHits(local.excerpts, hits, 6);
      trace.sourceMessageIds = hits.map((hit) => hit.messageId);
      trace.status = hits.length ? 'found' : 'empty';
      return hits.length
        ? applyMemoryEvidence({ ...local, excerpts }, assessLocalMemoryEvidence(input.query, excerpts))
        : local;
    } catch (error) {
      if (options.signal?.aborted) trace.reason = 'request-cancelled';
      options.signal?.throwIfAborted();
      trace.reason =
        error instanceof Error && /^(service-|memory-disabled)/.test(error.message) ? error.message : 'service-error';
      return local;
    } finally {
      trace.elapsedMs = Date.now() - started;
      this.host.audit(trace);
    }
  }

  /** Only newly completed tasks are queued. Enabling this feature never bulk-exports old history. */
  enqueue(workflow: Workflow) {
    if (
      !this.enabled(workflow.projectId) ||
      workflow.status !== 'completed' ||
      workflow.delegation ||
      workflow.deletedAt ||
      this.host.store.untrustedWorkflow(workflow) ||
      (workflow.review && workflow.review.status !== 'passed')
    )
      return;
    if (!workflow.finalMessageId) return;
    const ids = [workflow.userMessageId, workflow.finalMessageId];
    const messages = ids.map((id) => this.source(workflow.projectId, id));
    if (messages.some((item) => !item) || messages.length < 2) return;
    const sources = (messages as ConversationMessage[]).map((message) => ({
      messageId: message.id,
      hash: hash(message.content),
    }));
    const bank = this.bank(workflow.projectId);
    const id = hash(`${bank}:${workflow.id}:${JSON.stringify(sources)}`);
    if (this.host.store.get<Document>('hindsight-document', id)) return;
    const document: Document = {
      id,
      bank,
      projectId: workflow.projectId,
      workflowId: workflow.id,
      sources,
      state: 'queued',
      createdAt: new Date().toISOString(),
    };
    if (messages.reduce((size, item) => size + item!.content.length, 0) > 24000) document.state = 'failed';
    this.save(document);
    this.nextCheck = 0;
    this.host.audit({
      operation: 'retain',
      status: document.state === 'queued' ? 'queued' : 'failed',
      projectId: document.projectId,
      workflowId: workflow.id,
      bank,
      documentIds: [id],
      sourceMessageIds: ids,
      elapsedMs: 0,
      ...(document.state === 'failed' ? { reason: 'source-too-large-kept-local' } : {}),
    });
  }

  check(): Promise<void> {
    if (this.busy) return this.busy;
    if (this.closed || Date.now() < this.nextCheck || !this.host.idle() || !this.host.runtime.endpoint())
      return Promise.resolve();
    this.nextCheck = Date.now() + 30_000;
    const pending = this.pump();
    this.busy = pending;
    void pending
      .finally(() => {
        if (this.busy === pending) this.busy = undefined;
      })
      .catch(() => {});
    return pending;
  }

  private async pump() {
    const retired = this.host.store.list<RetiredBank>('hindsight-retired-bank', undefined, 16);
    for (const projectId of new Set(retired.map((item) => item.projectId))) await this.eraseRetiredBanks(projectId);
    if (this.closed || !this.host.idle()) return;
    const document = this.host.store
      .list<Document>('hindsight-document', undefined, 1000)
      .reverse()
      .find((item) => item.state === 'queued' && this.enabled(item.projectId));
    if (!document) return;
    const started = Date.now(),
      messages = this.current(document);
    const project = this.host.store.get<Project>('project', document.projectId);
    const trace: HindsightMemoryTrace = {
      operation: 'retain',
      status: 'failed',
      projectId: document.projectId,
      workflowId: document.workflowId,
      bank: document.bank,
      documentIds: [document.id],
      sourceMessageIds: document.sources.map((item) => item.messageId),
      elapsedMs: 0,
      modelRunIds: [],
    };
    if (!messages.length || !project) {
      this.save({ ...document, state: 'revoked' });
      return;
    }
    this.save({ ...document, state: 'running' });
    const retaining = { bank: document.bank, remoteFinished: false, remoteStarted: false };
    const serviceSession = this.session();
    this.retaining = retaining;
    try {
      await this.host.runtime.withJob(
        {
          projectId: project.id,
          projectPath: project.path,
          workflowId: document.workflowId,
          sourceId: document.id,
          onModelRun: (id) => {
            trace.modelRunIds!.push(id);
            this.host.modelRun?.(document.workflowId, id);
          },
        },
        async () => {
          retaining.remoteStarted = true;
          await this.request(
            `/v1/default/banks/${document.bank}/memories`,
            {
              items: [
                {
                  content: messages
                    .map(
                      (message) => `${message.role} (${message.createdAt}, message ${message.id}):\n${message.content}`,
                    )
                    .join('\n\n'),
                  timestamp: messages.at(-1)!.createdAt,
                  document_id: document.id,
                  update_mode: 'replace',
                  metadata: { projectId: document.projectId, workflowId: document.workflowId },
                  tags: ['pugport', project.id],
                },
              ],
              async: false,
            },
            240_000,
            'POST',
            true,
          );
          retaining.remoteFinished = true;
        },
      );
      if (!this.current(document).length) throw Error('memory-source-revoked');
      this.save({ ...document, state: 'retained' });
      trace.status = 'completed';
    } catch {
      this.save({
        ...document,
        state: 'failed',
        ...(retaining.remoteStarted && !retaining.remoteFinished ? { uncertainSession: serviceSession } : {}),
      });
      trace.reason = 'extraction-failed-local-memory-kept';
    } finally {
      if (this.retaining === retaining) this.retaining = undefined;
      trace.elapsedMs = Date.now() - started;
      this.host.audit(trace);
    }
  }

  async forgetProject(projectId: string) {
    const bank = this.bank(projectId);
    const retaining = this.retaining?.bank === bank ? this.retaining : undefined;
    const pending = retaining ? this.busy : undefined;
    const documents = this.host.store.list<Document>('hindsight-document', projectId, 10000);
    const uncertainSession = retaining
      ? this.session()
      : documents.find((item) => item.bank === bank && item.uncertainSession === this.session())?.uncertainSession;
    this.host.store.save('hindsight-retired-bank', bank, projectId, {
      projectId,
      bank,
      waitForSession: uncertainSession,
    } satisfies RetiredBank);
    // Rotate first: failure to reach the service can never make forgotten sources visible again.
    this.host.store.save('hindsight-generation', projectId, projectId, { id: randomUUID() });
    for (const document of documents) this.save({ ...document, state: 'revoked' });
    if (pending) {
      // A synchronous retain can lazily recreate a bank. Delete only after it has acknowledged completion.
      // An aborted/unknown extraction cannot truthfully confirm physical deletion; local revocation still holds.
      void pending
        .then(async () => {
          if (retaining?.remoteFinished && !this.closed) {
            this.host.store.save('hindsight-retired-bank', bank, projectId, { projectId, bank } satisfies RetiredBank);
            await this.eraseRetiredBanks(projectId);
          }
        })
        .catch(() => {});
      this.host.audit({
        operation: 'delete',
        status: 'queued',
        projectId,
        bank,
        documentIds: [],
        sourceMessageIds: [],
        elapsedMs: 0,
        reason: 'local-revocation-complete-waiting-for-retain',
      });
      return { revoked: true, serviceDeleted: false };
    }
    return this.eraseRetiredBanks(projectId);
  }

  private session() {
    return hash(this.host.runtime.endpoint()?.token ?? 'offline');
  }

  private async eraseRetiredBanks(projectId: string) {
    const retired = this.host.store.list<RetiredBank>('hindsight-retired-bank', projectId, 16);
    for (const item of retired) {
      if (this.closed || this.retaining?.bank === item.bank || item.waitForSession === this.session()) continue;
      const result = await this.eraseBank(projectId, item.bank);
      if (result.serviceDeleted)
        this.host.store.db
          .prepare("DELETE FROM workspace_records WHERE kind='hindsight-retired-bank' AND id=?")
          .run(item.bank);
    }
    const remaining = this.host.store.db
      .prepare("SELECT count(*) AS count FROM workspace_records WHERE kind='hindsight-retired-bank' AND owner=?")
      .get(projectId) as { count: number };
    return { revoked: true, serviceDeleted: remaining.count === 0 };
  }

  private async eraseBank(projectId: string, bank: string) {
    let status: HindsightMemoryTrace['status'] = 'completed';
    try {
      await this.request(`/v1/default/banks/${bank}`, undefined, 1200, 'DELETE');
    } catch {
      status = 'failed';
    }
    this.host.audit({
      operation: 'delete',
      status,
      projectId,
      bank,
      documentIds: [],
      sourceMessageIds: [],
      elapsedMs: 0,
      ...(status === 'failed' ? { reason: 'local-revocation-complete-service-deletion-unconfirmed' } : {}),
    });
    return { revoked: true, serviceDeleted: status === 'completed' };
  }

  async close() {
    this.closed = true;
    for (const abort of this.active) abort.abort();
    await this.busy?.catch(() => {});
  }
  /** Foreground work gets capacity immediately; background extraction is never a prerequisite. */
  yieldToForeground() {
    this.retainAbort?.abort();
  }
}
