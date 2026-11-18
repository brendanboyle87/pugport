/*
 * Cloud machines the user rents (trial credits, VPSes), listed by hand in remote-servers.json in the data folder
 * so a trial running out does not shut a box down unnoticed. The list holds no addresses or keys: a box with an
 * `ssh` alias from the user's own SSH config is read over SSH (load, memory, disk, services), nothing is installed
 * or written there.
 */

export type RemoteServer = {
  name: string;
  enrollmentDisabled?: boolean;
  provider?: string;
  region?: string;
  spec?: string;
  purpose?: string;
  /** The local calendar day it stops or is reclaimed, YYYY-MM-DD. */
  expiresOn?: string;
  /** Trial credit or balance left, as the owner last read it. */
  credit?: string;
  /** What to do before then. */
  note?: string;
  /** A Host alias in the owner's SSH config; without one there is no live status. */
  ssh?: string;
  /** systemd service names or patterns (actions.runner.*) whose state is shown. */
  services?: string[];
  /** A short read-only command on the box; the first line of its output is shown. */
  statusCommand?: string;
};

/** What the last SSH check read; the readings stay from the last success when a check fails. */
export type RemoteServerLive = {
  online: boolean;
  checkedAt: string;
  lastSeenAt?: string;
  /** Why the last check failed, in plain words. */
  reason?: string;
  cpuPercent?: number;
  cores?: number;
  arch?: string;
  memoryTotal?: number;
  memoryAvailable?: number;
  diskTotal?: number;
  diskFree?: number;
  services?: { name: string; state: string }[];
  status?: string;
};

export type RemoteServerView = RemoteServer & { live?: RemoteServerLive; missingSsh?: string };

export type InstaboxMachineView = {
  source: 'instabox';
  ssh?: string;
  live?: RemoteServerLive;
  cooldownUntil?: string | null;
  machineId: string;
  name: string;
  state: string;
  checkedAt: string;
  stale?: boolean;
  spec?: { vcpus?: number; memMiB?: number; persistentDiskGiB?: number };
  template?: string;
  free?: boolean;
  autoSuspendAfterSeconds?: number;
  runStartedAt?: string;
  maxRunMinutes?: number;
  pendingAction?: 'pause' | 'resume';
};

export type InstaboxView = {
  machines: InstaboxMachineView[];
  error?: string;
  sshManaged?: boolean;
};

export type RemoteServersView = {
  servers: RemoteServerView[];
  instabox?: InstaboxView;
  /** Where the list is read from, so the owner knows what to edit. */
  file: string;
  /** Why the file could not be read; the list is then empty. */
  error?: string;
  /** Where in the file the first problem is, such as servers.1.expiresOn. */
  errorAt?: string;
};

/** Expiries this close are highlighted. */
export const remoteServerSoonDays = 14;

export type RemoteServerExpiry =
  { state: 'unknown' } | { state: 'expired' | 'soon' | 'later'; days: number; date: string };

const dayPattern = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar day as UTC midnight, or undefined (2026-02-30 is not a day). */
export function calendarDay(value: string | undefined): number | undefined {
  const match = dayPattern.exec(value ?? '');
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const at = Date.UTC(year, month - 1, day);
  const date = new Date(at);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? at
    : undefined;
}

/** Whole days from today on this computer's calendar to the expiry day: 0 on the day itself, negative after. */
export function remoteServerExpiry(expiresOn: string | undefined, now: number): RemoteServerExpiry {
  const end = calendarDay(expiresOn);
  if (end === undefined) return { state: 'unknown' };
  const today = new Date(now);
  const days = Math.round((end - Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) / 86_400_000);
  return {
    state: days < 0 ? 'expired' : days <= remoteServerSoonDays ? 'soon' : 'later',
    days,
    date: expiresOn!,
  };
}
