/**
 * The one place that decides how terminal messages are routed. Everything goes through PugPort's own automatic
 * routing, exactly as the desktop composer sends in its default 自动 state: no runtime, model or effort unless
 * the user @-pins a role or executor for that one message. Routing rules the app gains later then apply to the
 * terminal without changes here; a terminal rules option would also be added here.
 */
import { inferCaller, type CallerContext, type CallerProbeInput } from '../shared/caller-signals.ts';
import type { MessageInput } from '../shared/types.ts';
import { defaultComposerSelection } from '../ui/composer-memory.ts';

/** The routing fields of `POST /api/conversations/:id/messages`. */
export function messageRouting(options: { write: boolean }) {
  return {
    mode: defaultComposerSelection.mode,
    // Read-only unless the terminal was started with --write.
    permissionMode: options.write ? 'workspace-write' : 'read-only',
    executionPolicy: defaultComposerSelection.policy,
    allowUnknownQuota: false,
    autoEscalate: true,
  } satisfies Omit<MessageInput, 'content'>;
}

/** `POST /api/external/tasks` for `pugport ask`; PugPort routes it like any other task from outside. */
export async function askCallerContext(
  projectPath: string,
  probe: () => Promise<CallerProbeInput>,
): Promise<CallerContext> {
  const observed = inferCaller(await probe());
  if (observed.client !== 'unknown') return observed;
  return {
    client: 'terminal',
    mode: 'write',
    roots: [projectPath],
    cwd: projectPath,
    evidence: ['identity: pugport command'],
    verified: false,
  };
}

export function askRequest(options: {
  task: string;
  projectPath: string;
  write: boolean;
  agent?: string;
  callerContext?: CallerContext;
}) {
  return {
    task: options.task,
    projectPath: options.projectPath,
    caller: 'Terminal',
    ...(options.write
      ? {
          write: true,
          callerContext:
            options.callerContext ??
            ({
              client: 'terminal',
              mode: 'write',
              roots: [options.projectPath],
              cwd: options.projectPath,
              evidence: ['identity: pugport command'],
              verified: false,
            } satisfies CallerContext),
        }
      : {}),
    ...(options.agent ? { agent: options.agent } : {}),
  };
}
