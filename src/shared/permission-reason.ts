export type PermissionOrigin = {
  mode: 'read-only' | 'workspace-write';
  source:
    | 'user'
    | 'text'
    | 'role'
    | 'untrusted'
    | 'privacy'
    | 'device'
    | 'external'
    | 'parent'
    | 'caller'
    /** A work mode's own folder (Mods author); the user's chat, so network follows the user as usual. */
    | 'mode';
  note?: string;
  /** Project scope for an inherited caller grant. */
  scope?: string;
  /** Set by a desktop "Connect other tools" override; kept for display and older records. */
  unrestricted?: boolean;
  /** Derived from the caller probe, like its write mode; never set by a task request field. */
  network?: boolean;
};

type CeilingInput = {
  permissionMode?: PermissionOrigin['mode'];
  permissionOrigin?: PermissionOrigin;
  untrustedContent?: boolean;
  untrustedQuotesOnly?: boolean;
  prohibitCommands?: boolean;
  textOnly?: boolean;
  backgroundTrigger?: unknown;
  webDriven?: boolean;
};

/** A run may write, commit or use the network only in a plain, owner-visible write turn. */
export const runMayWrite = (input: CeilingInput): boolean =>
  input.permissionMode === 'workspace-write' &&
  !input.untrustedContent &&
  !input.untrustedQuotesOnly &&
  !input.prohibitCommands &&
  !input.textOnly &&
  !input.backgroundTrigger;

/**
 * True when PugPort leaves the CLI unnarrowed for this turn (Codex full access, a device's bypass, Pi's shell): a
 * write turn in a project the owner trusts, not acting on web or search results. A local caller's writable task
 * counts: PugPort's own executors are refused writable dispatch before a task exists. Callers
 * add nothing of their own; a turn that follows search results keeps the CLI's own sandbox.
 */
export const trustedCommandTurn = (input: CeilingInput, trustedProject: boolean): boolean =>
  trustedProject &&
  input.permissionMode === 'workspace-write' &&
  !input.untrustedContent &&
  !input.untrustedQuotesOnly &&
  !input.prohibitCommands &&
  !input.textOnly &&
  !input.webDriven &&
  // A lane answer carries the coordinator's words into a background turn; it keeps the CLI's own sandbox.
  (input.backgroundTrigger as { kind?: string } | undefined)?.kind !== 'lane-answer';

/** Network follows the dispatcher: never more than its own grant, and off whenever the run cannot write. */
export function runNetworkAllowed(input: CeilingInput): boolean {
  if (!runMayWrite(input)) return false;
  const origin = input.permissionOrigin;
  switch (origin?.source ?? 'user') {
    case 'user':
    case 'text':
    case 'device':
    case 'mode':
      return true;
    case 'caller':
      return origin?.network === true;
    default:
      return false;
  }
}

export type CeilingLine = {
  write: boolean;
  network: boolean;
  /** Local Git commits: allowed in this worktree, blocked in a main checkout, or simply off. */
  git: 'worktree' | 'main-checkout' | 'on' | 'off';
  /** Codex trusted project or device full access: PugPort does not limit network or Git. */
  fullAccess?: boolean;
  /** Only a non-trusted Codex run is limited by PugPort's own sandbox. */
  enforced: boolean;
  pi?: boolean;
};

/** The once-per-run status line saying what this run inherited from its dispatcher. */
export function permissionCeilingLine(line: CeilingLine): string {
  const write = line.write ? '开' : '关';
  const network = line.fullAccess ? '完全访问' : line.network ? '开' : '关';
  const git = line.fullAccess
    ? '完全访问'
    : line.git === 'worktree'
      ? '本工作树'
      : line.git === 'main-checkout'
        ? '关（主检出：直接提交需要放开整个 .git，含 config 和 hooks；请用工作线，或由派单方提交）'
        : line.git === 'on'
          ? '开'
          : '关';
  if (line.pi)
    return `权限上限：写入 ${write} · 网络 ${network} · Git 提交 ${git}（Pi 自动模式不运行命令，不能提交或联网）`;
  if (!line.enforced)
    return `权限上限：写入 ${write} · 网络 ${network} · Git 提交 ${git}（该执行器没有沙箱，不受 PugPort 控制）`;
  return `权限上限：写入 ${write} · 网络 ${network} · Git 提交 ${git}`;
}

/** Paired devices also carry automated dispatches, without preserving the original sender. */
export const isExternalPermissionOrigin = (origin: PermissionOrigin | undefined): boolean =>
  origin !== undefined && ['external', 'caller', 'device'].includes(origin.source);

/** One presentation for the permission already decided by the host. */
export function permissionLine(origin: PermissionOrigin): string {
  const note = origin.note?.replace(/\s+/g, ' ').trim();
  if (origin.source === 'caller' && note)
    return note === '来源未知：按参数执行'
      ? note
      : `继承自 ${note}：${origin.mode === 'workspace-write' ? '可写入' : '只读'}${origin.mode === 'workspace-write' && origin.scope ? ` · ${origin.scope.replace(/\s+/g, ' ')}` : ''}`;
  if (origin.source === 'text')
    return origin.mode === 'workspace-write'
      ? `范围限制（来自你的消息）：${note ?? ''}`
      : `只读 · 你的消息要求只读${note ? `：${note}` : ''}`;
  const reasons: Record<Exclude<PermissionOrigin['source'], 'text'>, string> = {
    user: origin.mode === 'workspace-write' ? '可写入 · 你的选择' : '只读 · 你的选择',
    role: '只读 · 你点名的只读角色',
    untrusted: '只读 · 对话里有别人写的文字，只看文字不用工具',
    privacy: '纯文字 · 这个免费来源可能记录内容',
    device: origin.mode === 'workspace-write' ? '可写入 · 任务在另一台电脑上执行' : '只读 · 任务在另一台电脑上执行',
    external: '只读 · 外部智能体不能修改本机文件',
    parent: '只读 · 上级任务是只读的',
    caller: '只读 · 调用方限制了写入权限',
    mode: '可写入 · Mod 作者模式：只写这个对话的 Mod 工作文件夹',
  };
  return reasons[origin.source];
}
