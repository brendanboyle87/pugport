import { apiLimitDefaults, type ApiConnection } from '../../shared/api-providers.ts';
import { currentHost, type Host } from './host.ts';

/**
 * The owner limited configurable custom API limits to macOS, where local model servers need a larger context and
 * output limit than the conservative defaults. Every other system keeps the defaults, including for a connection
 * that arrived with limits from a Mac.
 */
export function customApiLimitsConfigurable(host: Host = currentHost()): boolean {
  return host.platform === 'darwin';
}

/** The context window and output limit a custom connection reports to Pi on this machine. */
export function customApiLimits(
  connection: Pick<ApiConnection, 'limits'>,
  host: Host = currentHost(),
): { contextWindow: number; maxTokens: number } {
  const limits = customApiLimitsConfigurable(host) ? connection.limits : undefined;
  return {
    contextWindow: limits?.contextWindow ?? apiLimitDefaults.contextWindow,
    maxTokens: limits?.maxTokens ?? apiLimitDefaults.maxTokens,
  };
}
