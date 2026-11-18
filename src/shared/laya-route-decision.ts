import type { LayaChoices } from './laya.ts';

export type LayaRouteDecision = {
  handling: 'reply' | 'task';
  writes: boolean;
  web: boolean;
  plan: boolean;
};

/** Handling advice only; the caller reapplies permission and scope boundaries. */
export function layaRouteDecision(choices: LayaChoices): LayaRouteDecision | undefined {
  const task =
    choices.project_access === 'write' ||
    choices.run_commands === 'yes' ||
    choices.browser_use === 'yes' ||
    !['none', 'unclear'].includes(choices.media_output);
  // Nothing to write, run, browse or render leaves only an answer, whatever the topic (coding questions too).
  // Automation may still need PugPort tools such as schedules, so it stays with the rules.
  const reply =
    !['automation', 'unclear'].includes(choices.task_type) &&
    ['none', 'read'].includes(choices.project_access) &&
    choices.run_commands === 'no' &&
    choices.browser_use === 'no' &&
    choices.media_output === 'none';
  if (!task && !reply) return undefined;
  return {
    handling: task ? 'task' : 'reply',
    writes: choices.project_access === 'write',
    web: choices.web_search === 'yes',
    plan: task && choices.difficulty === 'complex',
  };
}
