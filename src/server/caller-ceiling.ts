import { realpathSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import type { CallerContext } from '../shared/caller-signals.ts';
import type { PermissionOrigin } from '../shared/permission-reason.ts';

export type CallerOverride = 'inherit' | 'read-only' | 'write';
export type CallerCeiling = { mode: PermissionOrigin['mode']; origin: PermissionOrigin; reason?: string };
const names = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini',
  grok: 'Grok',
  cursor: 'Cursor',
  unknown: '调用方',
  terminal: '终端',
};

function absolute(path: string): string | undefined {
  let value = path.replace(/\\/g, '/').replace(/^\/mnt\/([a-z])(?=\/|$)/i, (_, drive: string) => `${drive}:`);
  if (!/^(?:[a-z]:\/|\/)/i.test(value) || /^\/\/[?.]/.test(value)) return undefined;
  try {
    value = realpathSync.native(value).replace(/\\/g, '/');
  } catch {
    /* Synthetic or not yet created. */
  }
  return /^[a-z]:\//i.test(value) || value.startsWith('//')
    ? win32.normalize(value).replace(/\\/g, '/').toLowerCase().replace(/\/$/, '')
    : posix.normalize(value).replace(/\/$/, '');
}

function inside(project: string | undefined, context: CallerContext | undefined): boolean {
  if (!project || !context) return false;
  const target = absolute(project);
  return (
    target !== undefined &&
    [...context.roots, ...(context.cwd ? [context.cwd] : [])].some((root) => {
      const base = absolute(root);
      return base !== undefined && (target === base || target.startsWith(`${base}/`));
    })
  );
}

export function inheritedCeiling(
  context: CallerContext | undefined,
  projectPath: string | undefined,
  override: CallerOverride = 'inherit',
  trusted?: (path: string) => boolean,
): CallerCeiling {
  const client = names[context?.client ?? 'unknown'];
  const label = `${client}${context?.client === 'codex' && context.mode === 'read-only' ? '（只读沙箱）' : ''}${context && context.client !== 'terminal' && !context.verified ? '（未核验）' : ''}`;
  const origin: PermissionOrigin = { mode: 'read-only', source: 'caller', note: label, scope: projectPath };
  const readonly = (reason: string): CallerCeiling => ({ mode: 'read-only', origin, reason });
  if (override === 'read-only') return readonly(`${client} 在 PugPort 的「接入其他工具」中被设为只读`);
  if (context?.evidence.includes('probe: disabled')) return readonly('关闭调用方检测时不能写入');
  if (context?.evidence.includes('probe: unavailable') || context?.evidence.includes('probe: timeout'))
    return readonly('调用方检测未完成；请重试');
  if (context?.client === 'unknown') return readonly('该工具不支持写入');
  if (override === 'inherit' && !context)
    return {
      mode: 'read-only',
      origin: { mode: 'read-only', source: 'caller', note: '来源未知：按参数执行' },
      reason:
        '发起方没有发送调用方信息，只能只读；要改文件，请更新 pugport 命令后用 pugport ask --write，或经 pugport MCP 重新派一条任务',
    };
  if (override === 'inherit' && context && context.client !== 'terminal' && !context.verified)
    return readonly('无法识别调用方权限；请在「接入其他工具」中把该工具设为「总是可写入」');
  if (override === 'inherit' && context?.mode === 'unknown')
    return readonly('无法识别调用方权限；请在「接入其他工具」中把该工具设为「总是可写入」');
  if (override === 'inherit' && context?.mode === 'read-only')
    return readonly(
      `${label}不能派可写任务；用可写沙箱运行 ${client}，或在 PugPort 的「接入其他工具」里把它设为总是可写入`,
    );
  if (
    !(override === 'inherit' && context?.mode === 'write-anywhere') &&
    !inside(projectPath, context) &&
    !(context?.verified === true && context.client !== 'terminal' && projectPath && trusted?.(projectPath) === true)
  )
    return readonly(`project_path 在 ${client} 的工作目录之外`);
  return {
    mode: 'workspace-write',
    origin: {
      ...origin,
      mode: 'workspace-write',
      unrestricted: override === 'write',
      network: context?.network === true,
    },
  };
}

/** Stored grants only narrow, including the ability to bypass the sandbox. */
export function narrowCeiling(current: CallerCeiling, stored?: CallerCeiling): CallerCeiling {
  if (!stored) return current;
  if (stored.reason) return stored;
  if (current.reason) return current;
  return {
    ...current,
    mode: stored.mode === 'read-only' ? 'read-only' : current.mode,
    origin: {
      ...current.origin,
      mode: stored.mode === 'read-only' ? 'read-only' : current.mode,
      unrestricted: current.origin.unrestricted === true && stored.origin.unrestricted === true,
      network: current.origin.network === true && stored.origin.network !== false,
    },
  };
}

/** Explicit writes cannot exceed a caller ceiling with a refusal reason. */
export function callerWrite(ceiling: CallerCeiling, requested?: boolean): boolean {
  if (requested === true && ceiling.mode === 'read-only' && ceiling.reason) throw new Error(ceiling.reason);
  return requested ?? ceiling.mode === 'workspace-write';
}
