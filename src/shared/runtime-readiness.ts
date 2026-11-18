import { isNativeCli, isRetiredProvider, quotaAuthAccepted } from './provider-registry.ts';
import type { AppState, RuntimeSnapshot, RuntimeTarget } from './types.ts';

/** Keep factory discovery slots in configuration, but only show an account once its CLI is found. */
export function showDiscoveredCli(target: RuntimeTarget, runtime?: RuntimeSnapshot): boolean {
  if (isRetiredProvider(target.provider)) return false;
  const factory =
    isNativeCli(target.provider) &&
    target.id === `${target.provider}-native` &&
    target.environment === 'native' &&
    !target.gateway &&
    !target.accountId &&
    !target.accountHome &&
    target.commandDiscovery === 'auto' &&
    !target.args?.length;
  // Disabled accounts are not probed by the controller. Keep their switch available after a restart.
  return (
    !factory || (!target.enabled && !runtime) || (!!runtime && !(runtime.status === 'missing' && !runtime.installed))
  );
}

/** Ready is the adapter's successful login and capability check, not a quota reading. */
export function checkedSubscriptionCli(runtime: RuntimeSnapshot): boolean {
  return (
    isNativeCli(runtime.provider) &&
    !runtime.gateway &&
    runtime.environment === 'native' &&
    runtime.installed &&
    runtime.status === 'ready' &&
    runtime.capabilities.execute &&
    runtime.models.length > 0 &&
    runtime.accounting?.mode !== 'usage' &&
    runtime.authMode !== 'apiKey' &&
    runtime.authMode !== 'unknown' &&
    (runtime.provider !== 'claude' || !!runtime.accountFingerprint || runtime.accounting?.mode === 'subscription') &&
    quotaAuthAccepted(runtime.provider, runtime.authMode)
  );
}

export function hasUsableAccount(state: Pick<AppState, 'targets' | 'runtimes'>): boolean {
  return state.targets.some((target) => {
    if (
      !target.enabled ||
      target.environment !== 'native' ||
      isRetiredProvider(target.provider) ||
      target.gateway === 'magpie'
    )
      return false;
    const runtime = state.runtimes.find((item) => item.id === target.id);
    return (
      !!runtime &&
      runtime.installed &&
      runtime.status === 'ready' &&
      runtime.capabilities.execute &&
      runtime.models.length > 0 &&
      runtime.availability?.reason !== 'authentication' &&
      (!runtime.apiBudgetState || !['expired', 'exhausted'].includes(runtime.apiBudgetState.phase))
    );
  });
}

/** Share the connection dialog's status with the first-run checklist. */
export function cliReadiness(target: RuntimeTarget, snapshot?: RuntimeSnapshot) {
  const usable = hasUsableAccount({ targets: [target], runtimes: snapshot ? [snapshot] : [] });
  const label = usable
    ? '已连接'
    : snapshot?.status === 'missing' && !snapshot.installed
      ? '未安装'
      : snapshot?.status === 'auth-required' || snapshot?.availability?.reason === 'authentication'
        ? '未登录'
        : '待检查';
  return { usable, label };
}
