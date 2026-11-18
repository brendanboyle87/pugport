import { isRetiredProvider } from '../shared/provider-registry.ts';
import type { Provider, RuntimeTarget } from '../shared/types.ts';
import { providerNames } from '../shared/delegation.ts';
import type { ExternalAgentId } from '../shared/external-agents.ts';

/**
 * Who an agent may hand a sub-task to: one card, a provider with automatic account choice, or neither (PugPort
 * chooses); a device; a role (agent preset), which leaves the executor to routing unless one is named too; or an
 * agent outside PugPort the user called.
 */
export type AgentChoice = {
  label: string;
  provider?: Provider;
  runtimeId?: string;
  deviceId?: string;
  presetId?: string;
  externalAgentId?: ExternalAgentId;
};
/** A named card or provider, as the directory lists it. */
export type NamedAgent = AgentChoice & { provider: Provider };

const callable = (target: RuntimeTarget) =>
  !isRetiredProvider(target.provider) &&
  target.environment !== 'wsl' &&
  target.id !== 'codex-wsl' &&
  target.gateway !== 'magpie' &&
  target.id !== 'pi-magpie';

/** "Grok · 本机", "grok本机" and "GROK 本机" are the same name; so are full-width and half-width forms. */
export function normalizeAgentName(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s·•・\-_.:：,，()（）[\]【】"'“”‘’]/gu, '');
}

/** Names an executor may use, built from the current card labels so a renamed card is recognized at once. */
export function agentDirectory(targets: RuntimeTarget[]): NamedAgent[] {
  const cards = targets
    .filter((target) => target.enabled && callable(target))
    .map((target) => ({ label: target.label, provider: target.provider, runtimeId: target.id }));
  const providers = [...new Set(cards.map((card) => card.provider))]
    .filter((provider) => cards.filter((card) => card.provider === provider).length > 1)
    .map((provider) => ({ label: `${providerNames[provider]} · 自动选择账号`, provider }));
  return [...cards, ...providers];
}

export function resolveAgent(name: string, targets: RuntimeTarget[]): NamedAgent {
  const wanted = normalizeAgentName(name);
  const directory = agentDirectory(targets);
  const known = () => directory.map((agent) => agent.label).join('、') || '（没有已启用的执行器）';
  if (!wanted) throw new Error(`请指定执行器名称。可用：${known()}`);
  const exact = directory.filter(
    (agent) => normalizeAgentName(agent.label) === wanted || (agent.runtimeId && agent.runtimeId === name.trim()),
  );
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) throw new Error(`有多个执行器叫“${name}”，请先在执行器卡片中重命名区分。`);
  const provider = (Object.keys(providerNames) as Provider[]).find(
    (key) => normalizeAgentName(key) === wanted || normalizeAgentName(providerNames[key]) === wanted,
  );
  if (provider) {
    const cards = directory.filter((agent) => agent.runtimeId && agent.provider === provider);
    if (cards.length === 1) return cards[0]!;
    if (cards.length > 1) return { label: `${providerNames[provider]} · 自动选择账号`, provider };
  }
  const partial = directory.filter((agent) => agent.runtimeId && normalizeAgentName(agent.label).includes(wanted));
  if (partial.length === 1) return partial[0]!;
  const disabled = targets.find(
    (target) => !target.enabled && callable(target) && normalizeAgentName(target.label) === wanted,
  );
  if (disabled) throw new Error(`执行器“${disabled.label}”已停用，请先在用量与连接页启用。`);
  throw new Error(`没有找到名为“${name}”的执行器。可用：${known()}`);
}

/** Whether a message names another executor; only then is the bridge described in the prompt. */
export function mentionsAgent(text: string, targets: RuntimeTarget[]): boolean {
  const haystack = normalizeAgentName(text);
  return (
    /codex|claude|grok|cursor/.test(haystack) ||
    agentDirectory(targets).some((agent) => {
      const label = normalizeAgentName(agent.label);
      return label.length >= 3 && haystack.includes(label);
    })
  );
}
