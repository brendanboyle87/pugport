import type { ExecuteContext } from '../../shared/types.js';
import { trustedCommandTurn } from '../../shared/permission-reason.ts';

/**
 * A write task a paired PugPort sent to this computer, which the owner runs as their own: the CLI skips its own
 * approval classifier, as Codex runs with danger-full-access. Local tasks keep their usual modes.
 */
export const deviceFullAccess = (ctx: ExecuteContext): boolean =>
  trustedCommandTurn(ctx.input, ctx.trustedProject === true) && ctx.input.permissionOrigin?.source === 'device';

/** The shared Codex trust decision for both the status line and the native turn policy. */
export const codexFullAccess = (ctx: Pick<ExecuteContext, 'input' | 'trustedProject'>): boolean =>
  trustedCommandTurn(ctx.input, ctx.trustedProject === true);
