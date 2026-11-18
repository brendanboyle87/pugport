import type { AppState, MessageInput } from '../shared/types';
import { executionModel, replayModelSelection } from '../shared/execution-model';

type Selection = Pick<MessageInput, 'provider' | 'runtimeId' | 'model' | 'effort' | 'executionPolicy'>;
/** Resolve a group/automatic main selection to its actual account, without copying native session identifiers. */
export function inheritSideChatSelection(state: AppState, conversationId: string, selected: Selection): Selection {
  const own = new Set(
    (state.workflows ?? [])
      .filter((workflow) => workflow.conversationId === conversationId && !workflow.deletedAt && !workflow.delegation)
      .map((workflow) => workflow.id),
  );
  const latest = state.runs
    .filter((run) => run.stepId && run.workflowId && own.has(run.workflowId))
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
  const provider = state.targets.find((target) => target.id === latest?.route.runtimeId)?.provider;
  const sameRuntime =
    !!latest &&
    (selected.runtimeId
      ? selected.runtimeId === latest.route.runtimeId
      : !selected.provider || selected.provider === provider);
  const actual = latest ? executionModel(latest) : undefined;
  const replay = actual ? replayModelSelection(provider, actual) : undefined;
  const sameModel =
    sameRuntime && (!selected.model || selected.model === actual?.model || selected.model === replay?.model);
  const inherited = actual
    ? replayModelSelection(provider, { ...actual, effort: selected.effort || actual.effort })
    : undefined;
  return {
    // Omit unset fields: a stored selection may also carry retired keys such as saveMoney.
    ...(selected.provider ? { provider: selected.provider } : {}),
    ...(selected.runtimeId ? { runtimeId: selected.runtimeId } : {}),
    executionPolicy: selected.executionPolicy,
    ...(sameRuntime ? { runtimeId: latest.route.runtimeId } : {}),
    model: sameModel ? inherited?.model : selected.model || undefined,
    effort: selected.effort || (sameModel ? actual?.effort : undefined),
  };
}
