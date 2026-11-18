/**
 * How many sub-task members may run at once: per account (stage 3, "smart scoring", of
 * docs/ROUTING-RULES-DESIGN.md) and on this computer. Pure and synchronous; routing and the controller supply the
 * readings.
 */

export const memberLimits = {
  /** Members one account takes at most; light read-only members may add `lightExtra`. */
  perAccount: 5,
  lightExtra: 2,
  /** Quota resetting within this many hours is used first: what is left is lost at the reset. */
  soonHours: 24,
  /** After a rate-limit cooldown ends, one more member is allowed back per step. */
  recoveryStepMinutes: 10,
} as const;

export type MemberAllowanceInput = {
  /** Percent left on the tightest window the chosen model draws from; absent when the provider reports none. */
  headroom?: number;
  /** When that window resets (ms since epoch). */
  resetAt?: number;
  reservePercent: number;
  /** The provider reports no limit for this period. */
  unlimited?: boolean;
  /** Pays per use (an API platform) instead of drawing on a subscription window. */
  usage?: boolean;
  /** End of the account's latest quota or rate-limit cooldown (ms): none before it, a few at a time after. */
  cooldownUntil?: number;
  /** A read-only light member: quick and cheap, so a healthy account may take a couple more. */
  light?: boolean;
  now: number;
};
export type MemberAllowance = { members: number; reason: string };

const hoursText = (hours: number) =>
  hours < 1 ? `${Math.max(1, Math.round(hours * 60))} 分钟` : `${Math.round(hours)} 小时`;

/**
 * Plenty left takes several members, more when it resets soon; little left takes one (the router's own reserve check
 * then decides whether even that one fits); an account just rate-limited takes none, then one more every few minutes.
 */
export function memberAllowance(input: MemberAllowanceInput): MemberAllowance {
  const { now } = input;
  if (input.cooldownUntil !== undefined && input.cooldownUntil > now)
    return { members: 0, reason: '刚返回限流或额度不足，冷却结束前不再派成员' };
  let members: number;
  let reason: string;
  let healthy = true;
  if (input.unlimited) {
    members = memberLimits.perAccount;
    reason = '本账期不限量';
  } else if (input.headroom === undefined || !Number.isFinite(input.headroom)) {
    members = input.usage ? 4 : 2;
    reason = input.usage ? '按量计费，没有额度窗口' : '额度未知，少放几个';
    healthy = !!input.usage;
  } else {
    const spare = input.headroom - input.reservePercent;
    if (spare <= 0) return { members: 0, reason: `剩 ${Math.round(input.headroom)}%，已到保留线` };
    members = Math.min(4, Math.ceil(spare / 20));
    healthy = spare > 20;
    const hours =
      input.resetAt !== undefined && Number.isFinite(input.resetAt) && input.resetAt > now
        ? (input.resetAt - now) / 3_600_000
        : undefined;
    const soon = hours !== undefined && hours <= memberLimits.soonHours && spare > 10;
    if (soon) members++;
    reason =
      hours === undefined
        ? `剩 ${Math.round(input.headroom)}%`
        : soon
          ? `剩 ${Math.round(input.headroom)}%，约 ${hoursText(hours)}后重置，快重置的额度多用`
          : `剩 ${Math.round(input.headroom)}%，约 ${hoursText(hours)}后重置`;
  }
  if (input.light && healthy) members += memberLimits.lightExtra;
  if (input.cooldownUntil !== undefined) {
    const steps = Math.floor((now - input.cooldownUntil) / (memberLimits.recoveryStepMinutes * 60_000));
    if (steps + 1 < members) {
      members = steps + 1;
      reason = `${reason}；限流后恢复中，先放 ${members} 个`;
    }
  }
  return { members: Math.min(members, memberLimits.perAccount + memberLimits.lightExtra), reason };
}

export type MachineReading = {
  totalBytes: number;
  cpus: number;
  /** Epoch milliseconds when these OS counters were sampled, not when a cached reading was requested. */
  sampledAt?: number;
  /** Total CPU usage averaged over the most recent 15 seconds of samples. */
  cpuPercent?: number;
  /**
   * Memory a new process could use without the system paging (Windows' available memory, Linux's MemAvailable).
   * Absent when the platform has no trustworthy reading: then only the fixed limit applies.
   */
  availableMemoryBytes?: number;
};
const GB = 1024 ** 3;
export const localRunMemoryBytes = 0.6 * GB;
/** Keep system headroom plus one estimated executor footprint for the first foreground conversation. */
export const firstRunHeadroomBytes = GB;
export const busyCpuPercent = 85;

/** Keep both pressure flags: a busy CPU must not hide simultaneous memory pressure. */
export function localRunPressure(machine: MachineReading) {
  const memoryReserveBytes = Math.max(2 * GB, Number.isFinite(machine.totalBytes) ? machine.totalBytes * 0.06 : 0);
  return {
    cpuBusy:
      machine.cpuPercent !== undefined && Number.isFinite(machine.cpuPercent) && machine.cpuPercent >= busyCpuPercent,
    memoryBusy:
      machine.availableMemoryBytes !== undefined &&
      Number.isFinite(machine.availableMemoryBytes) &&
      machine.availableMemoryBytes <= memoryReserveBytes,
    memoryReserveBytes,
  };
}

/**
 * Executor processes this computer can hold at once. Each CLI takes a few hundred MB and some CPU, so the limit
 * follows memory and cores. Live pressure is reported separately; the controller decides whether a new start fits.
 */
export function localRunLimit(machine: MachineReading): { limit: number; reason: 'machine' | 'memory' | 'cpu' } {
  const byMemory = Math.floor((machine.totalBytes - 3 * GB) / localRunMemoryBytes);
  const limit = [machine.totalBytes, machine.cpus].every((value) => Number.isFinite(value) && value > 0)
    ? Math.max(2, Math.min(32, byMemory, machine.cpus * 2))
    : 16;
  const pressure = localRunPressure(machine);
  if (pressure.cpuBusy) return { limit, reason: 'cpu' };
  if (pressure.memoryBusy) return { limit, reason: 'memory' };
  return { limit, reason: 'machine' };
}

/** Lane turns that may run at once, by available memory alone (the CPU counter is not trusted); unknown allows one. */
export function laneSlots(availableMemoryBytes?: number): 0 | 1 | 3 {
  if (availableMemoryBytes === undefined || !Number.isFinite(availableMemoryBytes)) return 1;
  return availableMemoryBytes >= 8 * GB ? 3 : availableMemoryBytes >= 4 * GB ? 1 : 0;
}
