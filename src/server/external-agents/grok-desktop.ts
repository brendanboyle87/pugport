import { setTimeout as sleep } from 'node:timers/promises';
import { currentHost, type Host } from '../platform/host.ts';

export const grokDesktopRequiredNote = 'Grok Bot 桌面应用没有运行，回复送不回来。请先打开 Grok Bot 再重试。';

const systemTool = (host: Host, name: string) => host.path.join(host.env.SystemRoot || 'C:\\Windows', 'System32', name);

async function isRunning() {
  const host = currentHost();
  const { stdout } = await host.run(
    systemTool(host, 'tasklist.exe'),
    ['/FI', 'IMAGENAME eq Grok Bot.exe', '/FO', 'CSV', '/NH'],
    {
      windowsHide: true,
      timeout: 10_000,
    },
  );
  return /^"Grok Bot\.exe",/im.test(stdout);
}

export async function ensureGrokBotRunning(
  options: {
    platform?: NodeJS.Platform;
    isRunning?: () => Promise<boolean>;
    start?: () => Promise<void>;
    stopped?: () => boolean;
    sleep?: (ms: number) => Promise<unknown>;
    now?: () => number;
  } = {},
): Promise<boolean> {
  if (options.stopped?.()) return false;
  if ((options.platform ?? process.platform) !== 'win32') return true;
  const running = options.isRunning ?? isRunning;
  const wait = options.sleep ?? sleep;
  const now = options.now ?? (() => performance.now());
  try {
    if (await running()) return !options.stopped?.();
    if (!options.start || options.stopped?.()) return false;
    await options.start();
    const deadline = now() + 20_000;
    while (now() < deadline) {
      if (options.stopped?.()) return false;
      if (await running()) {
        if (options.stopped?.()) return false;
        await wait(5000);
        if (options.stopped?.()) return false;
        return (await running()) && !options.stopped?.();
      }
      await wait(Math.min(1000, Math.max(0, deadline - now())));
    }
  } catch {
    // Do not bill a routine when its desktop reply path is unavailable.
  }
  return false;
}
