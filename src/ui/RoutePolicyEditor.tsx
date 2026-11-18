import type { RuntimeSnapshot, RuntimeTarget } from '../shared/types';
import { isApiHarness, nativeCliProviders } from '../shared/provider-registry';
import { routeCategories, routeCategoryLabels, type RoutePolicy } from '../shared/route-policy';
import { routeKeyLabel, isFreePreset } from '../shared/api-providers';

export type RouteOption = { key: string; label: string };

/** The platforms the user actually has: installed CLIs, then each added API platform. */
export function routeOptions(targets: RuntimeTarget[], runtimes?: RuntimeSnapshot[]): RouteOption[] {
  const keys = new Set<string>();
  for (const target of targets) {
    if (
      target.enabled === false ||
      target.executionDisabledByUser ||
      target.environment === 'wsl' ||
      (runtimes &&
        !runtimes.some(
          (runtime) =>
            runtime.id === target.id &&
            runtime.installed &&
            !['missing', 'auth-required', 'error'].includes(runtime.status),
        ))
    )
      continue;
    if (!target.gateway && !isApiHarness(target.provider)) keys.add(target.provider);
    if (target.gateway === 'api' && target.apiProvider && !isFreePreset(target.apiProvider))
      keys.add(`api:${target.apiProvider}`);
  }
  return [...keys].map((key) => ({ key, label: routeKeyLabel(key) }));
}

/**
 * One row per task category. Clicking a platform adds it at the end (its priority) or removes it; with
 * several selected, the router picks the one with more quota left. None selected means any platform.
 */
export function RoutePolicyEditor({
  value,
  options,
  onChange,
}: {
  value: RoutePolicy;
  options: RouteOption[];
  onChange: (next: RoutePolicy) => void;
}) {
  const toggle = (category: keyof RoutePolicy, key: string) => {
    const current = value[category];
    onChange({
      ...value,
      [category]: current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    });
  };
  return (
    <div className="route-policy" role="group" aria-label="按任务分类路由">
      {routeCategories.map((category) => {
        const selected = value[category];
        const unavailable = selected.filter((key) => !options.some((option) => option.key === key));
        return (
          <div className="route-policy-row" key={category}>
            <span className="route-policy-label">{routeCategoryLabels[category]}</span>
            <div className="route-policy-chips">
              {options.map(({ key, label }) => {
                const index = selected.indexOf(key);
                return (
                  <button
                    type="button"
                    key={key}
                    className={`route-chip ${index >= 0 ? 'on' : ''}`}
                    aria-pressed={index >= 0}
                    aria-label={`${routeCategoryLabels[category]} 使用 ${label}`}
                    onClick={() => toggle(category, key)}
                  >
                    {index >= 0 && selected.length > 1 && <b>{index + 1}</b>}
                    {label}
                  </button>
                );
              })}
              {unavailable.map((key) => (
                <button
                  type="button"
                  key={key}
                  className="route-chip on unavailable-runtime"
                  aria-pressed="true"
                  aria-label={`${routeCategoryLabels[category]} 移除不可用的 ${routeKeyLabel(key)}`}
                  onClick={() => toggle(category, key)}
                >
                  {routeKeyLabel(key)} · 不可用
                </button>
              ))}
            </div>
            <small className="route-policy-hint">
              {selected.length > 1 ? '按剩余额度选择' : selected.length ? '固定' : '任意平台'}
            </small>
          </div>
        );
      })}
    </div>
  );
}
