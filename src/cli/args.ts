/** What the user asked `pugport` to do. */
export type CliCommand =
  | { kind: 'chat'; write: boolean; continueLast: boolean }
  | { kind: 'ask'; task: string; write: boolean; agent?: string; json?: boolean; resumeId?: string; stdin?: boolean }
  | { kind: 'status'; json?: boolean }
  | { kind: 'agents'; json?: boolean }
  | { kind: 'tasks'; json?: boolean }
  | { kind: 'wait'; taskIds: string[]; timeoutMs: number; json?: boolean; port?: number }
  | { kind: 'cancel'; taskId: string; json?: boolean }
  | { kind: 'doctor' }
  | { kind: 'open' }
  | { kind: 'help' }
  | { kind: 'version' }
  | NodeCommand
  | { kind: 'error'; message: string };

/** `pugport node …`: run this computer as a headless device node of the desktop PugPort. */
export type NodeCommand =
  | { kind: 'node'; action: 'install'; dryRun: boolean; fromNodeAdd?: boolean }
  | { kind: 'node'; action: 'pair' | 'status'; json?: boolean }
  | { kind: 'node'; action: 'uninstall' | 'help' }
  | { kind: 'node'; action: 'add'; target: string; name?: string; tunnel?: boolean; now: boolean; dryRun: boolean }
  | { kind: 'node'; action: 'unpair'; target?: string; all: boolean };

const subcommands = new Set(['ask', 'status', 'open', 'help', 'agents', 'tasks', 'cancel', 'doctor', 'wait']);
const nodeActions = new Set(['add', 'install', 'pair', 'status', 'uninstall', 'unpair', 'help']);

function parseNodeArgs(argv: readonly string[]): CliCommand {
  const [action = 'help', ...rest] = argv;
  if (action === '-h' || action === '--help') return { kind: 'node', action: 'help' };
  if (!nodeActions.has(action))
    return { kind: 'error', message: `不认识的 node 命令：${action}。运行 pugport node help 查看用法。` };
  if (rest.includes('-h') || rest.includes('--help')) return { kind: 'node', action: 'help' };
  if (action === 'add') {
    const tunnel = rest[0] === '--tunnel';
    const [target, ...options] = tunnel ? rest.slice(1) : rest;
    if (!target || target.startsWith('-'))
      return { kind: 'error', message: 'pugport node add 需要 SSH target，且不能以 - 开头。' };
    let name: string | undefined;
    for (let index = 0; index < options.length; index++) {
      const option = options[index];
      if (option === '--name') {
        name = options[++index];
        if (!name || name.startsWith('-')) return { kind: 'error', message: '--name 后面需要设备名字。' };
      } else if (option !== '--now' && option !== '--dry-run')
        return { kind: 'error', message: `node add 不认识：${option}` };
    }
    return {
      kind: 'node',
      action,
      target,
      ...(tunnel ? { tunnel: true } : {}),
      ...(name !== undefined ? { name } : {}),
      now: options.includes('--now'),
      dryRun: options.includes('--dry-run'),
    };
  }
  if (action === 'install') {
    const unknown = rest.find((arg) => arg !== '--dry-run' && arg !== '--from-node-add');
    if (unknown) return { kind: 'error', message: `pugport node install 不认识：${unknown}` };
    return {
      kind: 'node',
      action: 'install',
      dryRun: rest.includes('--dry-run'),
      ...(rest.includes('--from-node-add') ? { fromNodeAdd: true } : {}),
    };
  }
  if ((action === 'pair' || action === 'status') && rest.length === 1 && rest[0] === '--json')
    return { kind: 'node', action, json: true };
  if (action === 'unpair') {
    const all = rest.includes('--all');
    const words = rest.filter((arg) => arg !== '--all');
    if (words.some((word) => word.startsWith('-')))
      return { kind: 'error', message: `pugport node unpair 不认识：${words.find((word) => word.startsWith('-'))}` };
    const target = words.join(' ').trim();
    if (all === !!target)
      return { kind: 'error', message: '请写要移除的电脑名字（pugport node status 里能看到），或用 --all 全部移除。' };
    return { kind: 'node', action: 'unpair', all, ...(target ? { target } : {}) };
  }
  if (rest.length) return { kind: 'error', message: `pugport node ${action} 后面不需要别的参数。` };
  return { kind: 'node', action: action as 'pair' | 'status' | 'uninstall' | 'help' };
}

export function parseArgs(argv: readonly string[]): CliCommand {
  if (argv[0] === 'node') return parseNodeArgs(argv.slice(1));
  let timeoutMs: number | undefined;
  let port: number | undefined;
  let write = false;
  let continueLast = false;
  let resumeId: string | undefined;
  let json = false;
  let help = false;
  let version = false;
  let agent: string | undefined;
  let subcommand: string | undefined;
  const words: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '--') {
      words.push(...argv.slice(index + 1));
      break;
    }
    if (arg === '--json') json = true;
    else if (arg === '--timeout') {
      const match = /^(\d+)([smh]?)$/.exec(argv[++index] ?? '');
      timeoutMs = match ? Number(match[1]) * { s: 1000, m: 60000, h: 3600000 }[match[2] || 's']! : NaN;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 86400000)
        return { kind: 'error', message: '--timeout 的格式是 90s、25m 或 2h，最长 24h。' };
    } else if (arg === '--port') {
      const value = argv[++index] ?? '';
      port = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(port) || port < 1 || port > 65535)
        return { kind: 'error', message: '--port 需要 1 到 65535 之间的端口。' };
    } else if (arg === '-r' || arg === '--resume') {
      resumeId = argv[++index];
      if (!resumeId || resumeId.startsWith('-')) return { kind: 'error', message: '--resume 后面需要对话 ID。' };
    } else if (arg === '-w' || arg === '--write') write = true;
    else if (arg === '-c' || arg === '--continue') continueLast = true;
    else if (arg === '-h' || arg === '--help') help = true;
    else if (arg === '-v' || arg === '-V' || arg === '--version') version = true;
    else if (arg === '--agent' || arg.startsWith('--agent=')) {
      const value = arg === '--agent' ? argv[++index] : arg.slice('--agent='.length);
      if (!value?.trim()) return { kind: 'error', message: '--agent 后面要写执行器的名字，例如 --agent Claude。' };
      agent = value.trim();
    } else if (arg.startsWith('-') && arg.length > 1)
      return { kind: 'error', message: `不认识的选项：${arg}。运行 pugport --help 查看用法。` };
    else if (!subcommand && !words.length && subcommands.has(arg)) subcommand = arg;
    else words.push(arg);
  }
  if (help || subcommand === 'help') return { kind: 'help' };
  if (version) return { kind: 'version' };
  if (timeoutMs !== undefined && subcommand !== 'wait')
    return { kind: 'error', message: '--timeout 只用于 pugport wait。' };
  if (port !== undefined && subcommand !== 'wait') return { kind: 'error', message: '--port 只用于 pugport wait。' };
  if (subcommand === 'ask') {
    const stdin = words.includes('-');
    const task = words
      .filter((word) => word !== '-')
      .join(' ')
      .trim();
    if (!task && !stdin) return { kind: 'error', message: '请写上要做的事，例如：pugport ask "总结这个项目"' };
    if (continueLast) return { kind: 'error', message: '--continue 不能用于 ask。' };
    return {
      kind: 'ask',
      task,
      write,
      ...(agent ? { agent } : {}),
      ...(json ? { json } : {}),
      ...(resumeId ? { resumeId } : {}),
      ...(stdin ? { stdin } : {}),
    };
  }
  if (resumeId) return { kind: 'error', message: '--resume 只用于 ask。' };
  if (agent) return { kind: 'error', message: '--agent 只用于 pugport ask。对话里可以用 @ 指定执行器。' };
  if (subcommand === 'wait') {
    if (!words.length) return { kind: 'error', message: 'pugport wait 需要任务 ID。' };
    if (words.length > 20 || words.some((id) => !/^[A-Za-z0-9-]{1,80}$/.test(id)))
      return { kind: 'error', message: 'wait 需要 1–20 个任务 ID，每个只能包含字母、数字和连字符，最长 80 字符。' };
    if (write || continueLast) return { kind: 'error', message: '--write 和 --continue 不能和 wait 一起用。' };
    return {
      kind: 'wait',
      taskIds: words,
      timeoutMs: timeoutMs ?? 540000,
      ...(json ? { json } : {}),
      ...(port !== undefined ? { port } : {}),
    };
  }
  if (subcommand === 'cancel') {
    if (words.length !== 1 || write || continueLast) return { kind: 'error', message: 'cancel 需要一个任务 ID。' };
    return { kind: 'cancel', taskId: words[0]!, ...(json ? { json } : {}) };
  }
  if (words.length)
    return {
      kind: 'error',
      message: `不认识的命令：${words[0]}。要直接提问请用 pugport ask "${words.join(' ')}"。`,
    };
  if (
    subcommand === 'status' ||
    subcommand === 'open' ||
    subcommand === 'agents' ||
    subcommand === 'tasks' ||
    subcommand === 'doctor'
  ) {
    if (write || continueLast) return { kind: 'error', message: `--write 和 --continue 不能和 ${subcommand} 一起用。` };
    if (json && (subcommand === 'open' || subcommand === 'doctor'))
      return { kind: 'error', message: '--json 不适用于此命令。' };
    return subcommand === 'open' || subcommand === 'doctor'
      ? { kind: subcommand }
      : { kind: subcommand, ...(json ? { json } : {}) };
  }
  if (json) return { kind: 'error', message: '--json 不适用于对话。' };
  return { kind: 'chat', write, continueLast };
}
