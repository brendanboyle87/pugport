import { spawn } from './test-process.ts';
import { currentHost, type Host } from './host.ts';

export const powerShellValue = (value: string) =>
  `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value, 'utf8').toString('base64')}')))`;

export function runPowerShell(
  script: string,
  failureTemplate: string,
  signal?: AbortSignal,
  timeoutMs = 120_000,
  host: Host = currentHost(),
) {
  return new Promise<string>((resolveRun, reject) => {
    const exe = host.path.join(
      host.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const child = spawn(
      exe,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-2000)));
    const stop = () => child.kill();
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      if (code === 0) resolveRun(stdout);
      else
        reject(
          new Error(failureTemplate.replace('{0}', () => (stderr.trim() ? `：${stderr.trim().slice(-300)}` : ''))),
        );
    });
  });
}
