import { execFile } from 'node:child_process';
import { join } from 'node:path';

/** One bounded OS query, only after a hang; CPU time is cumulative, not utilization. */
export function backendCpuTime(pid: number): Promise<string> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve('unavailable');
  const windows = process.platform === 'win32';
  const command = windows
    ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : '/bin/ps';
  const args = windows
    ? [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `[Math]::Round((Get-Process -Id ${pid} -ErrorAction Stop).TotalProcessorTime.TotalMilliseconds)`,
      ]
    : ['-p', String(pid), '-o', 'time='];
  return new Promise((done) => {
    execFile(command, args, { windowsHide: true, timeout: 3000, maxBuffer: 1024 }, (error, stdout) => {
      const value = stdout.trim();
      done(!error && /^[\d:. -]+$/.test(value) ? `${value}${windows ? 'ms' : ''}` : 'unavailable');
    });
  });
}

function cpuMilliseconds(value: string): number {
  if (/^\d+(?:\.\d+)?ms$/.test(value)) return Number(value.slice(0, -2));
  const time = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(value);
  return time
    ? ((Number(time[1] ?? 0) * 24 + Number(time[2] ?? 0)) * 3600 + Number(time[3]) * 60 + Number(time[4])) * 1000
    : NaN;
}

/** Sample cumulative OS CPU time twice; a core spinning is about 1000 ms/s. */
export async function sampleBackendCpu(
  pid: number,
  sample: (pid: number) => Promise<string>,
  now: () => number = () => performance.now(),
): Promise<string> {
  const first = await sample(pid);
  const started = now();
  await new Promise<void>((resolve) => setTimeout(resolve, 2000));
  const last = await sample(pid);
  const elapsed = now() - started;
  const delta = cpuMilliseconds(last) - cpuMilliseconds(first);
  const rate =
    Number.isFinite(delta) && delta >= 0 && elapsed > 0 ? `${Math.round((delta * 1000) / elapsed)}ms/s` : 'unavailable';
  return `${last}, cpuRate=${rate}`;
}
