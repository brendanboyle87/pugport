import { APP_VERSION } from '../shared/identity.ts';
import type { NetworkInterfaceInfo } from 'node:os';
import type { NodeCommand } from './args.ts';
import type { NodeStatus } from '../server/node/device-node.ts';
import { tailscaleAddress } from '../server/node/peer-listener.ts';
import { defaultDataDir, nodeDataProblem, nodeLocalPort } from '../server/node/role.ts';
import type { Host } from '../server/platform/host.ts';
import {
  ownServiceFile,
  launchAgentPath,
  launchAgentPlist,
  launchAgentLog,
  launchAgentLabel,
  launchAgentHint,
  stopLaunchAgent,
  serviceEnvironment,
  servicePath,
  systemdUnit,
  systemdUnitName,
  systemdUnitPath,
} from '../server/platform/service.ts';

/** The local backend as `pugport node` needs it (PugPortClient in practice). */
export type NodeClient = {
  health(timeoutMs?: number): Promise<boolean>;
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  delete<T>(path: string): Promise<T>;
};

export type NodeDeps = {
  host: Host;
  client: NodeClient;
  /** The PugPort folder (holding dist/server/main.js). */
  root: string;
  execPath: string;
  electron: boolean;
  nodeVersion: string;
  pause?: (ms: number) => Promise<void>;
  interfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  out: (text: string) => void;
  err: (text: string) => void;
};

type AnyStatus = NodeStatus | { role: 'desktop' };
const passedOn = [
  'PUGPORT_PORT',
  'PUGPORT_PEER_PORT',
  'PUGPORT_PEER_HOST',
  'PUGPORT_NODE_FEATURES',
  'PUGPORT_PEER_READ_ONLY',
];

export const nodeHelp = `pugport node：把这台电脑（Linux 或 macOS）当作桌面版 PugPort 的设备节点，开机自动在后台运行

  pugport node add --tunnel <alias> [--name <name>] [--now] [--dry-run]\n    pugport node add <ssh target> [--name <name>] [--now] [--dry-run]  从主电脑安装、更新并配对
  pugport node install     写入并重启 systemd 用户服务或 Mac LaunchAgent（--dry-run 只显示要写的内容）
  pugport node pair        生成一次性配对码，在桌面版「设置 → 设备」里输入
  pugport node status      查看服务是否在运行、对外地址和已配对的电脑
  pugport node unpair <名字>  移除一台已配对的电脑（--all 全部移除）
  pugport node uninstall   停止并删除这个服务（数据保留）

桌面版只通过 Tailscale 连接这台电脑（100.x.x.x 地址），端口默认 4318。本机的 pugport node 命令找的是
127.0.0.1:4319，所以这台电脑同时开着桌面版（4317）也没关系。
安装时设置的这些变量会写进服务：PUGPORT_PORT（本机端口）、PUGPORT_PEER_PORT（Tailscale 端口）、PUGPORT_NODE_FEATURES=images,memory
（打开图片、历史索引）、PUGPORT_PEER_READ_ONLY=1（关闭写权限）。设备任务可运行命令、联网安装软件和更改设置；文件夹可不填，默认使用 ~/PugPort-Workspace。聊天模式或只读开关禁止写入。
重装保留旧服务的上述变量及 COMBORUNNER_DATA_DIR；环境中的变量优先，空值移除。
使用 PUGPORT_PEER_READ_ONLY=1 关闭写权限。旧 PUGPORT_PEER_ALLOW_WRITE 变量不再生效。
pair 和 status 支持 --json。
`;

const firstLine = (error: unknown) => {
  const failure = error as { stderr?: string; message?: string };
  return (failure.stderr || failure.message || String(error)).trim().split('\n')[0]!.slice(0, 300);
};

function fileText(host: Host, file: string): string | undefined {
  try {
    return host.fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * The 127.0.0.1 port `pugport node` uses to reach this computer's node, never the desktop app's: PUGPORT_PORT when
 * set here, else the installed service's, else 4319. Not COMBORUNNER_PORT: the desktop app sets it to its own port,
 * and every CLI it runs inherits it.
 */
export function nodeBackendPort(host: Host): number {
  const mac = host.platform === 'darwin';
  let text: string | undefined;
  try {
    text = fileText(host, mac ? launchAgentPath(host) : systemdUnitPath(host));
  } catch {}
  const installed =
    text !== undefined && ownServiceFile(text) ? serviceEnvironment(text, mac, () => {}).PUGPORT_PORT : undefined;
  const port = Number(host.env.PUGPORT_PORT || installed || nodeLocalPort);
  return Number.isSafeInteger(port) && port > 0 && port < 65536 ? port : nodeLocalPort;
}

function where(status: NodeStatus['peer']): string {
  if (status.status === 'listening' && status.host)
    return `${status.host.includes(':') ? `[${status.host}]` : status.host}:${status.port}`;
  if (status.status === 'error') return `监听出错（${status.error ?? '未知'}），正在重试`;
  return '正在等 Tailscale 地址（先连上 Tailscale：sudo tailscale up）';
}

/** One-time steps the owner runs themselves; each is only shown when it is still needed. */
async function chores(deps: NodeDeps): Promise<string[]> {
  const { host } = deps;
  const lines: string[] = [];
  if (host.platform === 'darwin')
    return [
      '· 让 Mac 保持唤醒并在断电后重启（只需一次）：',
      '    sudo pmset -a sleep 0',
      '    sudo pmset -a autorestart 1',
      '· 登录 Mac 桌面（可设置自动登录），连接 Tailscale：sudo tailscale up',
      '· 首次运行时批准隐私权限提示；节点项目放在 ~/Documents 之外。',
    ];
  const user = host.env.USER || host.env.LOGNAME;
  let linger: string | undefined;
  if (user)
    linger = await host
      .run('loginctl', ['show-user', user, '--property=Linger', '--value'], { timeout: 5000 })
      .then((result) => result.stdout.trim())
      .catch(() => undefined);
  if (linger !== 'yes')
    lines.push(
      '· 让它在没登录时也运行、开机自动启动（只需一次，可能要输入密码）：',
      '    loginctl enable-linger "$USER"',
    );
  const venv = await host.run('python3', ['-c', 'import ensurepip'], { timeout: 5000 }).then(
    () => true,
    () => false,
  );
  if (!venv) lines.push('· 要在这台电脑上转换文档（MarkItDown）时，先装好：', '    sudo apt install python3-venv');
  if (!tailscaleAddress(deps.interfaces())) lines.push('· 还没连上 Tailscale：装好 Tailscale 后运行 sudo tailscale up');
  lines.push(
    '· 开了 ufw 防火墙的话，放行 Tailscale 上的端口：',
    '    sudo ufw allow in on tailscale0 to any port 4318',
  );
  return lines;
}

async function install(deps: NodeDeps, dryRun: boolean): Promise<number> {
  const { host, out, err } = deps;
  const mac = host.platform === 'darwin';
  if (!mac && host.platform !== 'linux') {
    err('设备节点目前只支持 Linux 和 macOS。\n');
    return 1;
  }
  const script = host.path.join(deps.root, 'dist', 'server', 'main.js');
  if (!host.fs.existsSync(script)) {
    err(`PugPort 还没构建：先在 ${deps.root} 里运行 node scripts/build.mjs。\n`);
    return 1;
  }
  const major = Number(deps.nodeVersion.replace(/^v/, '').split('.')[0]);
  if (!deps.electron && major < 24) err(`注意：这个 Node 是 ${deps.nodeVersion}，PugPort 需要 Node 24 或更新。\n`);
  const file = mac ? launchAgentPath(host) : systemdUnitPath(host);
  const existing = fileText(host, file);
  if (existing !== undefined && !ownServiceFile(existing)) {
    err(`${file} 已经存在，而且不是 pugport 写的，没有覆盖。\n`);
    return 1;
  }
  const old = serviceEnvironment(existing ?? '', mac, (line) => err(`无法读取服务配置：${line}\n`));
  const settings: Record<string, string> = {};
  for (const name of [...passedOn, 'COMBORUNNER_DATA_DIR']) {
    const useEnv = Object.hasOwn(host.env, name);
    const value = useEnv ? host.env[name] : old[name];
    if (value) settings[name] = value;
  }
  // Paired nodes are the owner's computers; only the new read-only opt-out restricts writes.
  const dataExplicitlyRemoved = Object.hasOwn(host.env, 'COMBORUNNER_DATA_DIR') && host.env.COMBORUNNER_DATA_DIR === '';
  const dataDir =
    settings.COMBORUNNER_DATA_DIR ??
    (dataExplicitlyRemoved || existing !== undefined
      ? undefined
      : defaultDataDir(deps.root, { PUGPORT_ROLE: 'node' }, host));
  delete settings.COMBORUNNER_DATA_DIR;
  const sharedData = dataDir === undefined ? undefined : nodeDataProblem(deps.root, dataDir, host);
  if (sharedData) {
    err(`${sharedData}\n`);
    return 1;
  }
  const spec = {
    runtime: deps.execPath,
    script,
    workingDirectory: deps.root,
    dataDir,
    path: servicePath(deps.execPath, host),
    electron: deps.electron,
    env: settings,
  };
  const unit = mac ? launchAgentPlist(spec, host) : systemdUnit(spec);
  const domain = `gui/${host.uid()}`;
  if (dryRun) {
    out(
      `会写入 ${file}：\n\n${unit}\n然后运行：\n${
        mac
          ? `  launchctl print ${domain}/${launchAgentLabel}\n  launchctl bootout ${domain}/${launchAgentLabel}（若已加载，等待消失，最多 70 秒）\n  launchctl bootstrap ${domain} ${file}`
          : `  systemctl --user daemon-reload\n  systemctl --user enable ${systemdUnitName}\n  systemctl --user restart ${systemdUnitName}`
      }\n`,
    );
    return 0;
  }
  host.fs.mkdirSync(host.path.dirname(file), { recursive: true });
  if (mac) host.fs.mkdirSync(host.path.dirname(launchAgentLog(host)), { recursive: true });
  host.fs.writeFileSync(file, unit, { mode: 0o644 });
  out(`已写入 ${file}\n`);
  try {
    if (mac) {
      await stopLaunchAgent(host, deps.pause);
      await host.run('launchctl', ['bootstrap', domain, file], { timeout: 70_000 });
    } else {
      await host.run('systemctl', ['--user', 'daemon-reload'], { timeout: 30_000 });
      await host.run('systemctl', ['--user', 'enable', systemdUnitName], { timeout: 60_000 });
      await host.run('systemctl', ['--user', 'restart', systemdUnitName], { timeout: 90_000 });
    }
  } catch (error) {
    err(
      `没能启动设备节点：${firstLine(error)}${mac ? `\n${launchAgentHint}` : `\n可以手动运行：systemctl --user restart ${systemdUnitName}`}\n`,
    );
    return 1;
  }
  out(
    [
      `PugPort 设备节点已启动。日志：${mac ? launchAgentLog(host) : 'journalctl --user -u pugport-node -f'}`,
      '',
      '还需要你自己做的事：',
      ...(await chores(deps)),
      '',
      '然后运行 pugport node pair，把配对码填到桌面版 PugPort 里。',
      '',
    ].join('\n'),
  );
  return 0;
}

async function backend(deps: NodeDeps): Promise<NodeStatus | undefined> {
  if (!(await deps.client.health())) {
    deps.err(
      deps.host.platform === 'darwin'
        ? '设备节点没有在运行。先运行 pugport node install。\n'
        : `设备节点没有在运行。先运行 pugport node install，或 systemctl --user start ${systemdUnitName}。\n`,
    );
    return undefined;
  }
  const status = await deps.client.get<AnyStatus>('/api/node');
  if (status.role !== 'node') {
    deps.err('这台电脑上运行的是桌面版 PugPort，不是设备节点。\n');
    return undefined;
  }
  return status;
}

async function pair(deps: NodeDeps, json = false): Promise<number> {
  const status = await backend(deps);
  if (!status) return 1;
  const created = await deps.client.post<{ code: string; expiresAt: string; peer: NodeStatus['peer'] }>(
    '/api/node/pairing',
    {},
  );
  if (json) {
    deps.out(`${JSON.stringify({ code: created.code, expiresAt: created.expiresAt })}\n`);
    return 0;
  }
  const minutes = Math.max(1, Math.round((Date.parse(created.expiresAt) - Date.now()) / 60_000));
  deps.out(
    [
      `配对码：${created.code}（${minutes} 分钟内有效，只能用一次）`,
      '',
      '在桌面版 PugPort 打开「设置 → 设备」，点「添加设备」，填：',
      `  地址：${created.peer.status === 'listening' ? where(created.peer) : '这台电脑在 Tailscale 里的名字或 100.x.x.x 地址'}`,
      `  配对码：${created.code}`,
      ...(created.peer.status !== 'listening'
        ? ['', `注意：${where(created.peer)}，桌面版现在还连不上这台电脑。`]
        : []),
      '',
    ].join('\n'),
  );
  return 0;
}

async function status(deps: NodeDeps, json = false): Promise<number> {
  const { host, out } = deps;
  const mac = host.platform === 'darwin';
  const file = mac ? launchAgentPath(host) : systemdUnitPath(host);
  const text = fileText(host, file);
  let service = '没有安装（运行 pugport node install）';
  if (text !== undefined && !ownServiceFile(text)) service = `${file} 不是 pugport 写的`;
  else if (text !== undefined) {
    const active = await host
      .run(
        mac ? 'launchctl' : 'systemctl',
        mac ? ['print', `gui/${host.uid()}/${launchAgentLabel}`] : ['--user', 'is-active', systemdUnitName],
        { timeout: 10_000 },
      )
      .then((result) => result.stdout.trim())
      .catch((error: { stdout?: string }) => error.stdout?.trim() || 'unknown');
    service = (mac ? /state = running/.test(active) : active === 'active')
      ? '已安装，正在运行'
      : `已安装，没有在运行（${active}）`;
  }
  const lines = [`服务：${service}`];
  const running = await deps.client.health();
  const node = running ? await deps.client.get<AnyStatus>('/api/node').catch(() => undefined) : undefined;
  if (json) {
    if (node?.role !== 'node') {
      deps.err('设备节点没有在运行。\n');
      return 1;
    }
    const tasks = await deps.client.get<{ total: number }>('/api/external/tasks?active=1');
    const commit = await host
      .run('git', ['-C', deps.root, 'rev-parse', 'HEAD'], { timeout: 60_000 })
      .then((result) => result.stdout.trim())
      .catch(() => null);
    out(
      `${JSON.stringify({ name: node.name, peer: node.peer, running: tasks.total, version: APP_VERSION, commit })}\n`,
    );
    return 0;
  }
  if (!running) lines.push('设备节点：没有在运行');
  else if (node?.role !== 'node') lines.push('PugPort：在运行，但是桌面版，不是设备节点');
  else {
    lines.push(`对外地址：${where(node.peer)}（只接受 Tailscale）`);
    lines.push(
      node.peers.length
        ? `已配对 ${node.peers.length} 台电脑：${node.peers
            .map(
              (peer) =>
                `${peer.name}${peer.lastSeenAt ? `（最近连接 ${new Date(peer.lastSeenAt).toLocaleString()}）` : ''}`,
            )
            .join('、')}`
        : '还没有配对的电脑：运行 pugport node pair',
    );
    if (node.pairingExpiresAt)
      lines.push(`有一个配对码在等待输入，${new Date(node.pairingExpiresAt).toLocaleTimeString()} 失效`);
    lines.push(`Slack：${node.slackHost ? '由这台电脑运行' : '不在这台电脑上运行'}`);
    lines.push(`允许改文件的任务：${node.allowWrite ? '已打开' : '已关闭（PUGPORT_PEER_READ_ONLY=1）'}`);
    if (node.execPath) lines.push(`Node 可执行文件：${node.execPath}`);
  }
  out(`${lines.join('\n')}\n`);
  return 0;
}

async function unpair(deps: NodeDeps, command: Extract<NodeCommand, { action: 'unpair' }>): Promise<number> {
  const status = await backend(deps);
  if (!status) return 1;
  if (command.all) {
    await deps.client.delete('/api/node/peers');
    deps.out(`已移除全部 ${status.peers.length} 台已配对的电脑。\n`);
    return 0;
  }
  const wanted = command.target!.toLowerCase();
  const matches = status.peers.filter((peer) => peer.name.toLowerCase() === wanted || peer.id === command.target);
  if (matches.length !== 1) {
    deps.err(
      matches.length
        ? `有 ${matches.length} 台电脑都叫“${command.target}”，请用 --all，或在桌面版里移除。\n`
        : `没有叫“${command.target}”的已配对电脑。已配对：${status.peers.map((peer) => peer.name).join('、') || '（没有）'}\n`,
    );
    return 1;
  }
  await deps.client.delete(`/api/node/peers/${encodeURIComponent(matches[0]!.id)}`);
  deps.out(`已移除“${matches[0]!.name}”：它不能再把任务交给这台电脑。\n`);
  return 0;
}

async function uninstall(deps: NodeDeps): Promise<number> {
  const { host, out, err } = deps;
  const mac = host.platform === 'darwin';
  const file = mac ? launchAgentPath(host) : systemdUnitPath(host);
  const text = fileText(host, file);
  if (text === undefined) {
    out('没有安装 PugPort 设备节点服务。\n');
    return 0;
  }
  if (!ownServiceFile(text)) {
    err(`${file} 不是 pugport 写的，没有动它。\n`);
    return 1;
  }
  try {
    if (mac) await stopLaunchAgent(host, deps.pause);
    else await host.run('systemctl', ['--user', 'disable', '--now', systemdUnitName], { timeout: 90_000 });
  } catch (error) {
    err(`没能停止设备节点：${firstLine(error)}${mac ? `\n${launchAgentHint}` : ''}\n`);
    return 1;
  }
  host.fs.rmSync(file, { force: true });
  if (!mac) await host.run('systemctl', ['--user', 'daemon-reload'], { timeout: 30_000 }).catch(() => undefined);
  const data =
    host.env.COMBORUNNER_DATA_DIR ||
    serviceEnvironment(text, mac, (line) => err(`无法读取服务配置：${line}\n`)).COMBORUNNER_DATA_DIR ||
    defaultDataDir(deps.root, { PUGPORT_ROLE: 'node' }, host);
  out(
    [
      '已停止并删除 PugPort 设备节点服务。',
      `数据还在 ${data}；已配对电脑的记录在同一层的 secrets 文件夹里。`,
      ...(mac ? [] : ['不再需要开机自动运行用户服务的话，可以运行：loginctl disable-linger "$USER"']),
      '',
    ].join('\n'),
  );
  return 0;
}

export async function runNode(command: Exclude<NodeCommand, { action: 'add' }>, deps: NodeDeps): Promise<number> {
  switch (command.action) {
    case 'help':
      deps.out(nodeHelp);
      return 0;
    case 'install':
      return install(deps, command.dryRun);
    case 'pair':
      return pair(deps, command.json);
    case 'status':
      return status(deps, command.json);
    case 'unpair':
      return unpair(deps, command);
    case 'uninstall':
      return uninstall(deps);
  }
}
