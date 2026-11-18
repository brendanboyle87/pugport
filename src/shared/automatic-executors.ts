import { apiCreditPace, isFreePreset } from './api-providers.ts';
import { isRetiredProvider } from './provider-registry.ts';
import type { RunInput, RuntimeSnapshot, RuntimeTarget, Settings } from './types.ts';

export function automaticApiTarget(snapshot: RuntimeSnapshot, now: number): boolean {
  return (
    snapshot.gateway !== 'api' ||
    snapshot.costTier === 'free' ||
    isFreePreset(snapshot.apiProvider) ||
    (apiCreditPace(snapshot.apiBudgetState, now)?.priority ?? 0) > 0
  );
}

export const emptyExecutorReason = '自动路由至少需要一个已启用的执行器。';
export const paidApiAutoSkipReason = '按次计费的 API 卡默认不参与自动选择，钉选后可用';

export function executorCards(targets: RuntimeTarget[]): RuntimeTarget[] {
  return targets.filter(
    (target) =>
      target.enabled &&
      !target.executionDisabledByUser &&
      !isRetiredProvider(target.provider) &&
      target.environment !== 'wsl' &&
      target.gateway !== 'magpie' &&
      target.id !== 'pi-magpie' &&
      target.id !== 'codex-wsl',
  );
}

/** Internal rules and failover choices are automatic even when they name a card. */
export function automaticExecutorAllowed(
  input: Pick<
    RunInput,
    'automaticExecutors' | 'automaticExecutorSelection' | 'runtimeId' | 'provider' | 'relayReason' | 'routeRule'
  >,
  settings: Pick<Settings, 'excludedExecutors'>,
  runtimeId: string,
): boolean {
  const explicit =
    input.routeRule?.derived !== true &&
    input.automaticExecutorSelection !== true &&
    (!input.relayReason || input.relayReason === 'selection') &&
    !!(input.runtimeId || input.provider);
  if (explicit) return true;
  const excluded = settings.excludedExecutors?.includes(runtimeId) === true;
  const allowed = input.automaticExecutors;
  return allowed === undefined ? !excluded : allowed.includes(runtimeId);
}

export function validateAutomaticExecutors(
  ids: string[] | undefined,
  targets: RuntimeTarget[],
  explicitPin = false,
): void {
  if (ids === undefined) return;
  for (const id of ids) if (!targets.some((target) => target.id === id)) throw new Error(`未知执行器：${id}`);
  if (!explicitPin && !executorCards(targets).some((target) => ids.includes(target.id)))
    throw new Error(emptyExecutorReason);
}
