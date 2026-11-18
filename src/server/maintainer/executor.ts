import type { ExternalTasks } from '../external-tasks.ts';
import type { Controller } from '../controller.ts';
import { supportsToolless } from '../routing.ts';
import { settledStatuses } from '../node/peer-protocol.ts';
import { executorCards } from '../../shared/automatic-executors.ts';
import type { JudgePin } from './config.ts';

export type NoToolsRun = { taskId: string };
export type NoToolsRunner = {
  dispatch(input: { prompt: string; title: string }): Promise<NoToolsRun>;
  result(
    taskId: string,
    waitSeconds: number,
    signal?: AbortSignal,
  ): Promise<{ status: string; result?: string; error?: string; executor?: string; model?: string }>;
  cancel(taskId: string): Promise<void>;
  toollessReady(): boolean;
  /** Only while a pinned judge without fallback cannot take a run: the reason the owner sees in the bot status. */
  unavailable?(): string | undefined;
};
/** The pinned judge could not take or finish the run. Nothing went to another executor; a later poll retries. */
export class JudgeUnavailableError extends Error {}

/** Why the pinned card cannot take a no-tools run with the pinned model now; undefined when it can. */
export function pinnedJudgeProblem(
  pin: Pick<JudgePin, 'executor' | 'model'>,
  controller: Pick<Controller, 'snapshots' | 'targets'>,
  now = Date.now(),
): string | undefined {
  const target = controller.targets.find((item) => item.id === pin.executor);
  // The ids are shown so the owner can correct maintainer.json; cards have no other place that shows them.
  if (!target) {
    const toolless = controller.snapshots.filter((item) => supportsToolless(item)).map((item) => item.id);
    return `executor ${pin.executor} not found (tool-less cards: ${toolless.join(', ') || 'none'})`;
  }
  const name = `${target.label} (${target.id})`;
  if (!executorCards([target]).length) return `${name} is disabled`;
  const snapshot = controller.snapshots.find((item) => item.id === target.id);
  if (!snapshot) return `${name} is not ready yet`;
  if (!supportsToolless(snapshot)) return `${name} cannot run without tools`;
  if (!snapshot.installed || !snapshot.capabilities.execute) return `${name} is not installed`;
  if (snapshot.status !== 'ready') return `${name} is not ready (${snapshot.status})`;
  // The same account states routing refuses for a named card.
  if (snapshot.availability?.reason === 'authentication') return `${name} needs to sign in again`;
  if (snapshot.availability?.reason === 'quota' && !(Date.parse(snapshot.availability.retryAt ?? '') <= now))
    return `${name} is rate-limited`;
  if (!snapshot.models.some((model) => model.id === pin.model))
    return `${name} does not offer model ${pin.model} (offers: ${snapshot.models.map((model) => model.id).join(', ') || 'none'})`;
  return undefined;
}

export function externalNoToolsRunner(
  tasks: ExternalTasks,
  controller: Pick<Controller, 'snapshots' | 'targets'> & Partial<Pick<Controller, 'refresh'>>,
  caller: string,
  judge?: () => JudgePin | undefined,
): NoToolsRunner {
  const ready = () => controller.snapshots.some((s) => supportsToolless(s) && s.status === 'ready');
  // Neither pin nor problem: automatic routing, exactly as without a pin.
  const choice = (): { pin?: JudgePin; problem?: string } => {
    const pin = judge?.();
    if (!pin) return {};
    const problem = pinnedJudgeProblem(pin, controller);
    if (!problem) return { pin };
    return pin.fallback === 'automatic' ? {} : { problem };
  };
  const pinnedRuns = new Map<string, JudgePin>();
  return {
    toollessReady() {
      const { pin, problem } = choice();
      return pin ? true : problem ? false : ready();
    },
    unavailable() {
      const { problem } = choice();
      return problem && `Pinned judge unavailable: ${problem}`.slice(0, 300);
    },
    async dispatch(input) {
      const { pin, problem } = choice();
      if (problem) throw new JudgeUnavailableError(problem);
      if (!pin && !ready()) throw new Error('noToollessExecutor');
      const run = await tasks.dispatch({
        task: input.prompt,
        title: input.title,
        caller,
        readOnly: true,
        untrusted: true,
        ...(pin ? { pin: { runtimeId: pin.executor, model: pin.model } } : {}),
      });
      if (pin) pinnedRuns.set(run.taskId, pin);
      return { taskId: run.taskId };
    },
    async result(id, wait, signal) {
      const result = await tasks.result(id, wait, signal);
      const pin = pinnedRuns.get(id);
      if (pin && (!result || settledStatuses.has(result.status))) {
        pinnedRuns.delete(id);
        if (result?.status !== 'completed') {
          // Discovery may not have seen the card go away yet, such as a local server that just stopped.
          await controller.refresh?.({ runtimeIds: [pin.executor], fresh: true }).catch(() => {});
          // The card went away during the run: report it as unavailable, never as a review verdict.
          const problem = pinnedJudgeProblem(pin, controller);
          if (problem) throw new JudgeUnavailableError(problem);
        }
      }
      if (!result) return { status: 'failed', error: 'Judge task is no longer available' };
      const status = tasks.status(id);
      return { ...result, executor: status?.executor, model: status?.model };
    },
    async cancel(id) {
      pinnedRuns.delete(id);
      tasks.cancel(id);
    },
  };
}
