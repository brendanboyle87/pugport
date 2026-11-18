import type { LayaInference, LayaPolicy, LayaState } from '../shared/laya.ts';
import type { ConversationMessage, RunInput, RuntimeTarget, Workflow } from '../shared/types.ts';
import { agentDirectory } from './agent-names.ts';

/** Keep the actual final question when bounding transport size before token-aware worker packing. */
export function layaTextWindow(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = '\n[...middle omitted...]\n';
  const head = Math.floor((limit - marker.length) / 3);
  return text.slice(0, head) + marker + text.slice(-(limit - marker.length - head));
}

export function withLayaSourceBudget(inference: LayaInference, message: ConversationMessage): LayaInference {
  if (inference.status !== 'ok' && inference.reason !== 'input_too_large') return inference;
  if (message.content.length <= 12_000 && (message.quotes ?? []).map((quote) => quote.text).join('\n\n').length <= 6000)
    return inference;
  return {
    ...inference,
    raw: {
      ...inference.raw,
      usage: { ...(inference.raw?.usage as Record<string, unknown> | undefined), source_compacted: true },
    },
  };
}

/** Context stays separate from the current instruction; attachment contents are never read for classification. */
export function workflowLayaState(
  message: ConversationMessage,
  history: ConversationMessage[],
  targets: RuntimeTarget[],
  userOnly = false,
): LayaState {
  return {
    message: layaTextWindow(message.content, 12_000),
    recent_context: history
      .filter((item) => item.id !== message.id && !item.untrustedContent && (!userOnly || item.role === 'user'))
      .slice(-4)
      .map((item) => `${item.role}: ${item.content.slice(-1500)}`)
      .join('\n')
      .slice(-6000),
    reference_text: layaTextWindow((message.quotes ?? []).map((quote) => quote.text).join('\n\n'), 6000),
    attachments: (message.attachments ?? []).slice(0, 20).map((file) => ({ kind: file.kind, name: file.name })),
    candidate_executors: agentDirectory(targets)
      .slice(0, 32)
      .map((agent) => agent.label.slice(0, 128)),
  };
}

export function skippedLaya(reason: string): LayaInference {
  return { status: 'skipped', reason, modelVersion: 'pugport-laya-v4', latencyMs: 0 };
}

export const emptyLayaPolicy = (): LayaPolicy => ({
  applied: false,
  reasons: [],
  conflicts: [],
  excludeRuntimeIds: [],
});

/** Advice never loosens a grant, leaves a human pin, or replaces an approved/strict route. */
export function applyLayaRunHints(input: RunInput, workflow: Workflow): RunInput {
  if (workflow.input?.prohibitCommands) input = { ...input, prohibitCommands: true, verificationCommand: undefined };
  // Laya says the turn runs commands: routing then needs an executor that can run local programs here. A video link
  // alone does not: the workspace pre-reads its transcript, and a Pi command refusal still hands the task off.
  const choices = workflow.laya?.inference.status === 'ok' ? workflow.laya.inference.choices : undefined;
  if (choices?.run_commands === 'yes') input = { ...input, needsLocalPrograms: true };
  const policy = workflow.laya?.policy;
  if (!policy) return input;
  const excludes = [...new Set([...(input.excludeRuntimeIds ?? []), ...policy.excludeRuntimeIds])];
  if (input.runtimeId && excludes.includes(input.runtimeId)) {
    if (!input.runtimeIdFromMode) throw new Error('当前固定执行器也被本轮要求排除；请更改执行器选择或取消排除。');
    input = { ...input, runtimeId: undefined, model: undefined, effort: undefined, runtimeIdFromMode: undefined };
  }
  const result: RunInput = {
    ...input,
    ...(excludes.length ? { excludeRuntimeIds: excludes } : {}),
    ...(policy.permissionMode === 'read-only' &&
    !workflow.input?.permissionReauthorized &&
    !workflow.input?.explicitWrite
      ? { permissionMode: 'read-only' }
      : {}),
    ...(policy.prohibitCommands ? { prohibitCommands: true } : {}),
  };
  const automatic =
    !input.runtimeId &&
    !input.provider &&
    !input.model &&
    !input.effort &&
    !input.routeRule &&
    !input.confirmedRoute &&
    !input.coordinator &&
    !workflow.requiresConfirmation;
  if (automatic && workflow.laya?.inference.status === 'ok' && policy.runtimeId) {
    result.runtimeId = policy.runtimeId;
    result.runtimeIdFromMessage = true;
  }
  const adviceAllowed =
    !input.runtimeId &&
    !input.provider &&
    !input.routeRule &&
    !input.confirmedRoute &&
    !input.coordinator &&
    !workflow.requiresConfirmation;
  if (adviceAllowed) {
    if (!input.model && !result.suggestedTier && policy.suggestedTier) result.suggestedTier = policy.suggestedTier;
    if (!input.effort && !result.suggestedEffort && policy.suggestedEffort)
      result.suggestedEffort = policy.suggestedEffort;
    if ((!result.category || result.category.confidence === 'low') && policy.category)
      result.category = policy.category;
  }
  return result;
}

/**
 * Outside quality mode Laya's difficulty decides the tier. A request the local text classifier reads as
 * complex while Laya says simple or standard is flagged as a conflict and checked by the assessment, not raised.
 */
export function flagLocalComplexity(
  policy: LayaPolicy,
  inference: LayaInference,
  goal: string | undefined,
  locallyComplex: boolean,
): void {
  if (
    inference.status !== 'ok' ||
    !policy.suggestedTier ||
    policy.suggestedTier === 'strong' ||
    goal === 'quality' ||
    !locallyComplex
  )
    return;
  policy.conflicts.push('Local text classifier reads the request as complex; Laya decides, the assessment checks.');
  policy.needsAssessment = true;
}
