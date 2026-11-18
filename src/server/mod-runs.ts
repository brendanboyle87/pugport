import {
  canAttachMod,
  MOD_RUN_RESULT_MAX,
  modRunRequestSchema,
  type ModRunView,
} from '../shared/conversation-modes.ts';
import type { Conversation, ConversationMessage, MessageInput, Workflow } from '../shared/types.ts';
import type { ConversationModes } from './conversation-modes.ts';
import type { WorkspaceStore } from './workspace-store.ts';
import type { Locale } from '../shared/i18n/index.ts';

export class ModRunError extends Error {
  readonly status: number;
  constructor(readonly code: 'E_INVALID' | 'E_PERMISSION' | 'E_UNAVAILABLE' | 'E_LIMIT') {
    super(
      {
        E_INVALID: 'Invalid request.',
        E_PERMISSION: 'Permission is not declared.',
        E_UNAVAILABLE: 'Mod is unavailable.',
        E_LIMIT: 'Request limit exceeded.',
      }[code],
    );
    this.status = code === 'E_INVALID' ? 400 : code === 'E_PERMISSION' ? 403 : code === 'E_LIMIT' ? 429 : 409;
  }
}
type RunRecord = ModRunView & {
  conversationId: string;
  modeId: string;
  instanceId: string;
  helperId: string;
  format: 'text' | 'json';
};
type Helper = { conversationId: string; modeId: string; helperId: string };
type Host = {
  store: WorkspaceStore;
  modes: ConversationModes;
  requireConversation(id: string): Conversation;
  createHelper(title: string, incognito: boolean): Promise<Conversation>;
  send(conversationId: string, input: MessageInput): Promise<{ workflow?: Workflow }>;
  cancel(workflowId: string): void;
  discardHelper(conversationId: string): void;
  notify(): void;
};
export const MOD_RUNS_ACTIVE_MAX = 2;
export const MOD_RUNS_PER_HOUR = 60;
const terminal = new Set(['completed', 'failed', 'blocked', 'cancelled', 'interrupted']);

/** Shared by Mods and extension metadata: ordinary automatic routing, with no executable third-party input. */
export function hiddenModelInput(content: string): MessageInput {
  return {
    content,
    mode: 'chat',
    permissionMode: 'read-only',
    permissionOrigin: { mode: 'read-only', source: 'untrusted' },
    untrustedContent: true,
    executionPolicy: 'cli-first',
    autoEscalate: true,
    allowExecutorFallback: true,
  };
}

export async function runHiddenModel(
  host: Pick<Host, 'store' | 'createHelper' | 'send' | 'cancel'> & {
    waitForWorkflow(id: string, ms: number, signal?: AbortSignal): Promise<Workflow | undefined>;
  },
  prompt: string,
  language: Locale,
  signal: AbortSignal,
  options: { title?: string; suggestedEffort?: string } = {},
): Promise<string> {
  if (signal.aborted) throw new Error('Helper cancelled');
  const helper = await host.createHelper(options.title ?? 'Skill summaries', false);
  let workflow: Workflow | undefined;
  try {
    if (signal.aborted) throw new Error('Helper cancelled');
    ({ workflow } = await host.send(helper.id, {
      ...hiddenModelInput(prompt),
      uiLocale: language,
      // A target for automatic selection, not a pin: routing still chooses the executor.
      ...(options.suggestedEffort ? { suggestedEffort: options.suggestedEffort } : {}),
    }));
    if (!workflow) throw new Error('Helper unavailable');
    const settled = await host.waitForWorkflow(workflow.id, 120_000, signal);
    if (signal.aborted || settled?.status !== 'completed') throw new Error('Helper did not complete');
    const message = settled.finalMessageId && host.store.get<ConversationMessage>('message', settled.finalMessageId);
    if (!message || message.role !== 'assistant' || message.conversationId !== helper.id)
      throw new Error('Helper returned no answer');
    return message.content;
  } finally {
    if (workflow && !terminal.has(host.store.get<Workflow>('workflow', workflow.id)?.status ?? workflow.status))
      host.cancel(workflow.id);
    host.store.archiveConversation(helper.id, true);
  }
}

/**
 * Model runs a Mod starts with the approved `model:run` permission. Each run is an ordinary tool-less task in a
 * hidden helper chat, so routing, the checklist, billed-card rules and usage work as for anything typed.
 */
export class ModRuns {
  constructor(private readonly host: Host) {}

  async start(conversationId: string, request: unknown): Promise<{ runId: string }> {
    const parsed = modRunRequestSchema.safeParse(request);
    if (!parsed.success) throw new ModRunError('E_INVALID');
    const input = parsed.data;
    let conversation: Conversation;
    try {
      conversation = this.host.requireConversation(conversationId);
    } catch {
      throw new ModRunError('E_UNAVAILABLE');
    }
    const binding = conversation.modeBinding;
    if (!canAttachMod(conversation) || conversation.closedAt || binding?.instanceId !== input.instanceId)
      throw new ModRunError('E_UNAVAILABLE');
    let view: ReturnType<ConversationModes['view']>;
    try {
      view = this.host.modes.view(conversationId);
    } catch {
      throw new ModRunError('E_UNAVAILABLE');
    }
    if (!view.installed || !view.manifest) throw new ModRunError('E_UNAVAILABLE');
    if (!view.granted?.includes('model:run')) throw new ModRunError('E_PERMISSION');
    if (input.saveTo && !view.manifest.state?.keys.some((key) => key.id === input.saveTo))
      throw new ModRunError('E_INVALID');
    const recent = this.host.store.list<RunRecord>('mod-run', conversationId, MOD_RUNS_PER_HOUR + 1);
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    if (
      recent.filter((run) => run.status === 'running').length >= MOD_RUNS_ACTIVE_MAX ||
      recent.filter((run) => run.createdAt > hourAgo).length >= MOD_RUNS_PER_HOUR
    )
      throw new ModRunError('E_LIMIT');
    const helper = await this.helper(conversation, view.manifest.title, input.fresh === true);
    const message: MessageInput = {
      ...hiddenModelInput(
        [
          `This request comes from the Mod "${view.manifest.title}" in a PugPort chat. Answer from the text below only.`,
          input.format === 'json' ? 'Reply with one JSON value only, without Markdown fences or other text.' : '',
          input.prompt,
        ]
          .filter(Boolean)
          .join('\n\n'),
      ),
      ...(conversation.routing?.automaticExecutors
        ? { automaticExecutors: conversation.routing.automaticExecutors }
        : {}),
    };
    let workflow: Workflow | undefined;
    try {
      ({ workflow } = await this.host.send(helper.id, message));
    } catch {
      if (helper.incognito) this.host.discardHelper(helper.id);
      throw new ModRunError('E_UNAVAILABLE');
    }
    if (!workflow) throw new ModRunError('E_UNAVAILABLE');
    const record: RunRecord = {
      id: workflow.id,
      status: 'running',
      ...(input.saveTo ? { saveTo: input.saveTo } : {}),
      createdAt: new Date().toISOString(),
      conversationId,
      modeId: binding.modeId,
      instanceId: binding.instanceId,
      helperId: helper.id,
      format: input.format ?? 'text',
    };
    this.host.store.save('mod-run', record.id, conversationId, record);
    // A task that could not start at all has already settled.
    const current = this.host.store.get<Workflow>('workflow', workflow.id) ?? workflow;
    if (terminal.has(current.status)) this.settled(current);
    return { runId: record.id };
  }

  cancel(conversationId: string, runId: string): void {
    const record = this.host.store.get<RunRecord>('mod-run', runId);
    if (!record || record.conversationId !== conversationId) throw new ModRunError('E_INVALID');
    if (record.status !== 'running') return;
    this.host.cancel(runId);
    this.finish(record, { status: 'cancelled', error: 'E_CANCELLED' });
  }

  /** Called for every settled workflow; only Mod runs are recorded here. */
  settled(workflow: Workflow): void {
    if (!terminal.has(workflow.status)) return;
    const record = this.host.store.get<RunRecord>('mod-run', workflow.id);
    if (!record || record.status !== 'running') return;
    if (workflow.status !== 'completed') {
      this.finish(record, {
        status: workflow.status === 'cancelled' ? 'cancelled' : 'failed',
        error: workflow.status === 'cancelled' ? 'E_CANCELLED' : 'E_FAILED',
      });
      return;
    }
    const final = workflow.finalMessageId
      ? this.host.store.get<ConversationMessage>('message', workflow.finalMessageId)
      : undefined;
    let text = final?.role === 'assistant' && final.conversationId === workflow.conversationId ? final.content : '';
    if (record.format === 'json') {
      text = text
        .trim()
        .replace(/^```(?:json)?\s*\n?/i, '')
        .replace(/\n?```$/, '')
        .trim();
      try {
        JSON.parse(text);
      } catch {
        this.finish(record, { status: 'failed', error: 'E_FORMAT', text: text.slice(0, MOD_RUN_RESULT_MAX) });
        return;
      }
    }
    if (text.length > MOD_RUN_RESULT_MAX) {
      this.finish(record, { status: 'failed', error: 'E_LIMIT' });
      return;
    }
    if (record.saveTo && !this.host.modes.saveRunOutput(record.conversationId, record.modeId, record.saveTo, text)) {
      this.finish(record, { status: 'failed', error: 'E_LIMIT', text });
      return;
    }
    this.finish(record, { status: 'completed', text });
  }

  private finish(record: RunRecord, outcome: Pick<RunRecord, 'status' | 'error' | 'text'>) {
    const finished: RunRecord = { ...record, ...outcome, finishedAt: new Date().toISOString() };
    this.host.store.save('mod-run', record.id, record.conversationId, finished);
    const conversation = this.host.store.get<Conversation>('conversation', record.conversationId);
    if (conversation && !conversation.deletedAt) {
      conversation.modeRunsAt = finished.finishedAt;
      this.host.store.save('conversation', conversation.id, conversation.projectId, conversation);
    }
    // An incognito chat's helper keeps nothing once its answer is collected.
    if (this.host.store.get<Conversation>('conversation', record.helperId)?.incognito)
      this.host.discardHelper(record.helperId);
    this.host.notify();
  }

  /** One hidden helper chat per chat and Mod keeps follow-up runs in context; incognito chats get a new one each run. */
  private async helper(conversation: Conversation, title: string, fresh: boolean) {
    const modeId = conversation.modeBinding!.modeId;
    const key = `${conversation.id}:${modeId}`;
    const saved = this.host.store.get<Helper>('mod-helper', key);
    const existing = saved && this.host.store.get<Conversation>('conversation', saved.helperId);
    if (!conversation.incognito && !fresh && existing && !existing.deletedAt && !existing.closedAt)
      // Settled helpers are archived like other hidden dispatches; the next run brings this one back.
      return existing.archivedAt ? this.host.store.archiveConversation(existing.id, false) : existing;
    const helper = await this.host.createHelper(`${title} · Mod`, !!conversation.incognito);
    if (!conversation.incognito)
      this.host.store.save('mod-helper', key, conversation.id, {
        conversationId: conversation.id,
        modeId,
        helperId: helper.id,
      } satisfies Helper);
    return helper;
  }
}
