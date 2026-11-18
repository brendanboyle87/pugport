import { createHash } from 'node:crypto';
import type { RuntimeSnapshot, RuntimeTarget } from '../shared/types.ts';

export type ResponseLatencySample = {
  runId: string;
  runtimeId: string;
  key: string;
  model: string;
  effort?: string;
  sessionMode: 'new' | 'resume';
  firstTextMs: number;
  observedAt: string;
};
export type ResponseLatencyEstimate = {
  milliseconds: number;
  samples: number;
  lastObservedAt: string;
  scope: 'model' | 'runtime';
};
type Lookup = Pick<ResponseLatencySample, 'runtimeId' | 'key' | 'model' | 'effort' | 'sessionMode'>;

const secretOption = /token|key|password|secret|credential|auth|headers?|env|mcp[-_]config/i;

function endpointIdentity(value: string | undefined): string | undefined {
  if (!value) return value;
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (secretOption.test(key)) url.searchParams.set(key, '[redacted]');
    return url.toString();
  } catch {
    return value;
  }
}

function connectionArgs(args: readonly string[] = []): string[] {
  let redactNext = false;
  return args.map((arg) => {
    if (redactNext) {
      redactNext = false;
      return '[redacted]';
    }
    const equal = arg.indexOf('=');
    const name = equal < 0 ? arg : arg.slice(0, equal);
    if ((name.startsWith('-') || equal >= 0) && secretOption.test(name)) {
      if (equal >= 0) return name + '=[redacted]';
      redactNext = true;
      return name;
    }
    if (equal >= 0 && /^[a-z][a-z0-9+.-]*:\/\//i.test(arg.slice(equal + 1)))
      return name + '=' + endpointIdentity(arg.slice(equal + 1));
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(arg) ? endpointIdentity(arg)! : arg;
  });
}

export function responseLatencyKey(target: RuntimeTarget, snapshot: RuntimeSnapshot): string {
  const connection = (value: RuntimeTarget['apiConnection']) =>
    value && { protocol: value.protocol, baseUrl: endpointIdentity(value.baseUrl), model: value.model };
  return createHash('sha256')
    .update(
      JSON.stringify({
        provider: target.provider,
        environment: target.environment,
        command: target.command,
        args: connectionArgs(target.args),
        agentDir: target.agentDir,
        accountId: target.accountId,
        accountHome: target.accountHome,
        accountFingerprint: target.accountFingerprint,
        responseLatencyEpoch: target.responseLatencyEpoch,
        verifiedAccountFingerprint: snapshot.accountFingerprint,
        gateway: target.gateway,
        apiProvider: target.apiProvider,
        apiBaseUrl: endpointIdentity(target.apiBaseUrl),
        apiConnection: connection(target.apiConnection),
        apiWorkspaceId: target.apiWorkspaceId,
        verifiedGateway: snapshot.gateway,
        verifiedApiProvider: snapshot.apiProvider,
        verifiedApiConnection: connection(snapshot.apiConnection),
        authMode: snapshot.authMode,
        version: snapshot.version,
      }),
    )
    .digest('hex');
}

export function estimateResponseLatency(
  samples: readonly ResponseLatencySample[],
  lookup: Lookup,
  now: number,
): ResponseLatencyEstimate | undefined {
  if (!Number.isFinite(now)) return undefined;
  const ttl = 7 * 24 * 60 * 60 * 1000;
  const seen = new Set<string>();
  const valid = samples
    .filter((sample) => {
      if (
        !sample ||
        typeof sample.observedAt !== 'string' ||
        typeof sample.runId !== 'string' ||
        !sample.runId ||
        typeof sample.model !== 'string' ||
        !sample.model ||
        (sample.effort !== undefined && typeof sample.effort !== 'string')
      )
        return false;
      const at = Date.parse(sample.observedAt);
      return (
        sample.runtimeId === lookup.runtimeId &&
        sample.key === lookup.key &&
        sample.sessionMode === lookup.sessionMode &&
        Number.isFinite(sample.firstTextMs) &&
        sample.firstTextMs > 0 &&
        Number.isFinite(at) &&
        at <= now &&
        now - at < ttl
      );
    })
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))
    .filter((sample) => {
      if (seen.has(sample.runId)) return false;
      seen.add(sample.runId);
      return true;
    });
  const exact = valid.filter((sample) => sample.model === lookup.model && sample.effort === lookup.effort);
  const lowOrMedium = (effort: string | undefined) => effort === 'low' || effort === 'medium';
  const candidates =
    exact.length >= 2 ? exact : lowOrMedium(lookup.effort) ? valid.filter((sample) => lowOrMedium(sample.effort)) : [];
  const scope = exact.length >= 2 ? 'model' : 'runtime';
  if (candidates.length < (scope === 'model' ? 2 : 3)) return undefined;
  const recent = candidates.slice(0, 8);
  const ordered = recent.map((sample) => sample.firstTextMs).sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  const milliseconds = ordered.length % 2 ? ordered[middle]! : ordered[middle - 1]! / 2 + ordered[middle]! / 2;
  return { milliseconds, samples: recent.length, lastObservedAt: recent[0]!.observedAt, scope };
}
