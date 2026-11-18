import type { Settings } from './types.ts';

/** Task categories the router recognizes; "mature" is adult content, which only some providers accept. */
export const routeCategories = ['design', 'architecture', 'general', 'routine', 'mature'] as const;
export type RouteCategory = (typeof routeCategories)[number];
/**
 * Ordered platforms per category: CLI providers ('codex') and API platforms ('api:deepseek'). Several mean
 * "whichever has more quota left"; none means any platform.
 */
export type RoutePolicy = Record<RouteCategory, string[]>;

export const routeCategoryLabels: Record<RouteCategory, string> = {
  design: '界面 / 前端设计',
  architecture: '后端 / 架构 / 复杂调试',
  general: '一般任务',
  routine: '日常小改动',
  mature: '成人内容',
};

/**
 * The effective policy. Categories never configured keep the earlier single-platform preferences, so routing
 * does not change until the user edits the policy; adult content defaults to Grok, which accepts it.
 */
export function routePolicy(
  settings: Pick<Settings, 'routePolicy' | 'designProvider' | 'architectureProvider'>,
): RoutePolicy {
  return {
    design: [settings.designProvider],
    architecture: [settings.architectureProvider],
    general: [],
    routine: [],
    mature: ['grok'],
    ...settings.routePolicy,
  };
}
