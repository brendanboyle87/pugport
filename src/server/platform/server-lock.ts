import { currentHost, type Host } from './host.ts';

// Include the process birth time so a recycled PID cannot keep a crashed backend's lock alive.

/** A process's start time, or undefined when it is not running or cannot be asked. */
export function processStartTime(pid: number, host: Host = currentHost()): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    if (host.platform === 'win32') {
      const script = `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -Property CreationDate; if ($p.CreationDate) { [DateTimeOffset]::new($p.CreationDate).ToUnixTimeMilliseconds() }`;
      const started = host
        .runSync(
          host.path.join(
            host.env.SystemRoot || 'C:\\Windows',
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'powershell.exe',
          ),
          ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
          { timeout: 5000, windowsHide: true },
        )
        .trim();
      return /^\d+$/.test(started) && Number.isFinite(Number(started)) ? started : undefined;
    }
    const started = host
      .runSync('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 2000, env: { ...host.env, LC_ALL: 'C' } })
      .trim();
    return started || undefined;
  } catch {
    return undefined;
  }
}

export function serverLockText(pid: number = process.pid, host: Host = currentHost()): string {
  const started =
    host.platform === 'win32' ? String(Date.now() - Math.round(process.uptime() * 1000)) : processStartTime(pid, host);
  return started ? `${pid}\n${started}` : String(pid);
}

export function parseServerLock(text: string, _host: Host = currentHost()): { pid: number; started?: string } {
  const [first = '', ...rest] = text.split('\n');
  const started = rest.join('\n').trim();
  return { pid: Number(first.trim()), ...(started ? { started } : {}) };
}

const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

/** Whether the backend that wrote this lock text still runs. */
export function serverLockHeld(text: string, host: Host = currentHost(), alive: (pid: number) => boolean = running) {
  const { pid, started } = parseServerLock(text, host);
  if (!(pid > 0) || !alive(pid)) return false;
  if (!started) return true;
  // Another start time: the PID now belongs to a different process. Unknown: stay careful.
  const current = processStartTime(pid, host);
  if (current === undefined) return true;
  if (host.platform === 'win32')
    return !Number.isFinite(Number(started)) || Math.abs(Number(current) - Number(started)) <= 5000;
  return current === started;
}
