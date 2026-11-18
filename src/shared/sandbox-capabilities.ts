export function captureDenialsStreamingSupported(version: string | undefined): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return false;
  return major > 1 || (major === 1 && (minor > 0 || patch > 0));
}

export function captureDenialsStreamingUnavailableReason(version: string | undefined): string {
  return version === '1.0.0'
    ? '学习模式暂不可用：当前 MXC SDK（1.0.0）在记录拒绝时会崩溃，SDK 修复后自动恢复'
    : '学习模式暂不可用：尚未确认当前 MXC SDK 支持流式拒绝记录';
}
