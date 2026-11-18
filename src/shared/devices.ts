/*
 * The user's other computers running PugPort headless as device nodes (for example a Linux box or a Mac), reached
 * over Tailscale. A device is called with @@ in a conversation, or by name when an executor delegates; it routes
 * the task by its own accounts' quota.
 */

export type DeviceExecutor = {
  label: string;
  provider: string;
  status: string;
  windows: { name: string; remaining?: number; resetsAt?: string | null }[];
  plan?: string;
  stale?: boolean;
  observedAt?: string | null;
  tightest?: number;
};

export type DeviceView = {
  id: string;
  name: string;
  /** As typed when it was added: a Tailscale address or name, with the port when it is not 4318. */
  address: string;
  pairedAt: string;
  /** Neither the account's access key nor this computer's own SSH alias reaches it. */
  missingSsh?: string;
  tunnel?: { ssh: string; remotePort: number };
  /** How this computer reaches a tunnelled device: the account's tunnel-only key, or its own SSH alias. */
  route?: 'account' | 'ssh';
  /** An enrolled server without the account's access key that this computer (with its own SSH) sets up. */
  accessUpgrade?: { state: 'pending' | 'running' | 'failed'; reason?: string };
  /** Undefined until it has been checked. */
  online?: boolean;
  checkedAt?: string;
  /** Why it cannot be reached or used, in plain words. */
  reason?: string;
  hostname?: string;
  platform?: string;
  version?: string;
  arch?: string;
  lastSeenAt?: string;
  hardware?: {
    os: string;
    cpu?: string;
    gpu?: string;
    gpuOthers?: string[];
    cores?: number;
    threads?: number;
    memoryTotal?: number;
    memoryAvailable?: number;
    diskTotal?: number;
    diskFree?: number;
    readAt: string;
  };
  allowWrite?: boolean;
  resources?: {
    cpuPercent?: number;
    gpuPercent?: number;
    gpuName?: string;
    memoryUsed?: number;
    memoryTotal?: number;
    vram?: { usedMiB: number; totalMiB: number };
    observedAt: string;
  };
  folders?: string[];
  executors?: DeviceExecutor[];
  running?: number;
  /** It runs the Slack gateway. */
  slackHost?: boolean;
  githubHost?: boolean;
};

export type DevicesView = {
  devices: DeviceView[];
  /** The device chosen to run Slack; null: this computer does. */
  slackHost: string | null;
  githubHost?: string | null;
};

/** In the @@ list a device's id is prefixed, so it never collides with an external agent's. */
export const deviceMentionPrefix = 'device:';
export const deviceNameLimit = 24;

/** A name that reads well after @ and can be found again in the text. */
export function deviceNameProblem(name: string): string | undefined {
  const value = name.trim();
  if (!value) return '请给设备起个名字。';
  if (value.length > deviceNameLimit) return `名字最多 ${deviceNameLimit} 个字。`;
  if (/[\s@]/u.test(value) || /[\p{Cc}\p{Cf}]/u.test(value)) return '名字里不能有空格、@ 或控制字符。';
  return undefined;
}

export const platformNames: Record<string, string> = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' };
