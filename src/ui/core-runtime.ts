import type { AppState, MessageInput, Provider, RuntimeTarget } from '../shared/types';
import { activeProviders, isApiHarness } from '../shared/provider-registry';

export const coreProviders: Provider[] = activeProviders;
export const isCoreProvider = (provider: Provider) => coreProviders.includes(provider);
export const isCoreRuntime = (runtime: Pick<RuntimeTarget, 'provider' | 'environment' | 'id'>) =>
  isCoreProvider(runtime.provider) && runtime.environment !== 'wsl' && runtime.id !== 'codex-wsl';
export const availableCoreTargets = (targets: RuntimeTarget[], policy?: MessageInput['executionPolicy']) =>
  targets.filter(
    (target) =>
      target.enabled &&
      isCoreRuntime(target) &&
      (policy !== 'cli-only' || !isApiHarness(target.provider)) &&
      (policy !== 'api-only' || isApiHarness(target.provider)),
  );

// Keep the saved target's identity visible even after its runtime is retired.
export const runtimeIdentity = (state: Pick<AppState, 'runtimes' | 'targets'>, id?: string) =>
  state.runtimes.find((runtime) => runtime.id === id) ?? state.targets.find((target) => target.id === id);
export const unavailableRuntimeLabel = (state: Pick<AppState, 'runtimes' | 'targets'>, id: string) =>
  `${runtimeIdentity(state, id)?.label ?? id} · 不可用`;
