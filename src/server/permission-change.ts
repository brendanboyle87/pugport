import { gateLoosening, normalizeGates } from '../shared/project-gates.ts';
import {
  permissionChangeSchema,
  relaxingSettingsPatch,
  displayCommand,
  targetCommandChanged,
} from '../shared/permission-change.ts';
import { defaultSandboxModes, sandboxProviders } from '../shared/sandbox.ts';
import type { Project } from '../shared/types.ts';
import type { Workspace } from './workspace.ts';
import { canTrustPath } from './project-trust.ts';
import { extensions } from './extensions.ts';

/** Called only by the owned parent process, never by an HTTP route. */
export async function desktopPermissionChange(
  workspace: Workspace,
  value: unknown,
  apply: boolean,
  expected?: string,
): Promise<string> {
  const change = permissionChangeSchema.parse(value);
  const controller = workspace.controller;
  let description: string;
  const confirm = () => {
    if (description !== expected) throw new Error('权限配置已变化，请重新确认。');
  };
  if (change.kind === 'approval') {
    if (!controller.approvals.has(change.id)) throw new Error('审批已失效');
    description = '';
    if (apply) {
      confirm();
      controller.answerApproval(change.id, true, change.remember);
    }
  } else if (change.kind === 'project') {
    const project = workspace.store.get<Project>('project', change.id);
    if (!project || project.removedAt || project.scope === 'chat') throw new Error('项目不存在。');
    if (change.trusted && !canTrustPath(project.path, controller.dataDir))
      throw new Error('不能信任磁盘根目录、用户主目录或 PugPort 数据目录。');
    description = `${project.name}\n${project.path}\n${change.trusted ? '信任此项目：Codex 可写任务将不使用沙箱。' : '取消信任：Codex 可写任务将使用沙箱。'}`;
    if (apply) {
      if (description !== expected) throw new Error('项目已变化，请重新确认。');
      workspace.updateProject(change.id, { trusted: change.trusted });
    }
  } else if (change.kind === 'project-gates') {
    const project = workspace.store.get<Project>('project', change.projectId);
    if (!project || project.removedAt || project.scope === 'chat') throw new Error('项目不存在。');
    const lines = gateLoosening(project.gates, normalizeGates(change.gates));
    description = lines.length
      ? [
          project.name,
          project.path,
          '放宽 GitHub 规则',
          ...lines.slice(0, 20),
          ...(lines.length > 20 ? [`另有 ${lines.length - 20} 项`] : []),
        ].join('\n')
      : '';
    if (apply) {
      if (description !== expected) throw new Error('项目已变化，请重新确认。');
      workspace.setProjectGates(project.id, change.gates);
    }
  } else if (change.kind === 'caller') {
    const names = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', grok: 'Grok' };
    const labels = { inherit: '继承调用方权限', 'read-only': '总是只读', write: '总是可写入（可信项目可不使用沙箱）' };
    description = `${names[change.tool]}\n${labels[controller.settings.externalCallers?.[change.tool] ?? 'inherit']} → ${labels[change.mode]}`;
    if (apply) {
      if (description !== expected) throw new Error('工具权限已变化，请重新确认。');
      controller.updateSettings({
        externalCallers: { ...controller.settings.externalCallers, [change.tool]: change.mode },
      });
    }
  } else if (change.kind === 'settings') {
    const current = controller.settings;
    const patch = relaxingSettingsPatch(current, change.patch);
    const defaults = defaultSandboxModes();
    const rank = { off: 0, learn: 1, enforce: 2 };
    const labels = { off: '关闭沙箱', learn: '学习模式', enforce: '强制模式' };
    const lines: string[] = [];
    if (patch.sandbox)
      for (const provider of sandboxProviders) {
        const before = current.sandbox?.[provider] ?? defaults[provider];
        const after = patch.sandbox[provider] ?? defaults[provider];
        if (rank[after] < rank[before]) lines.push(`${provider}\n${labels[before]} → ${labels[after]}`);
      }
    if (patch.sandboxWhenUnavailable) lines.push('沙箱不可用时仍然运行');
    if (patch.toolApprovalMode) lines.push('工具调用自动批准');
    if (patch.autoUseResetCards) lines.push('自动使用重置卡');
    description = lines.length ? ['放宽安全设置', ...lines].join('\n') : '';
    if (apply) {
      confirm();
      controller.updateSettings(change.patch);
    }
  } else if (change.kind === 'target-command') {
    const target = controller.targets.find((target) => target.id === change.id);
    if (!target) throw new Error('未知执行器');
    description = targetCommandChanged(target, change.patch)
      ? `${target.label}\n修改执行器启动命令\n${displayCommand(change.patch.command ?? target.command, change.patch.args ?? target.args)}`
      : '';
    if (apply) {
      confirm();
      controller.updateTarget(change.id, change.patch);
    }
  } else if (change.kind === 'extension-command') {
    const commands =
      change.action === 'install'
        ? extensions.describeInstallCommands(change.token, change.keys, change.fills, change.options)
        : change.action === 'configure'
          ? extensions.describeConfigureCommand(change.id, change.values)
          : extensions.describeApproveCommand(change.id, !apply);
    description = commands ? `允许 MCP 工具启动程序\n${commands}` : '';
    if (apply) {
      confirm();
      if (change.action === 'install')
        await extensions.install(change.token, change.keys, change.fills, change.options, { expected: commands });
      else if (change.action === 'configure') await extensions.configure(change.id, change.values, false, commands);
      else await extensions.approve(change.id, commands);
    }
  } else if (change.kind === 'sandbox-adopt') {
    const entries = controller.sandboxLearning.addedGrants(change.provider, change.ids);
    description = entries.length
      ? [
          '采用学习规则，允许所选访问',
          change.provider,
          ...entries
            .slice(0, 20)
            .map(
              (entry) =>
                `${entry.resource}（${entry.resourceType === 'network' ? '网络' : /execute/i.test(entry.accessType) ? '执行' : /write|append|delete|create/i.test(entry.accessType) ? '写' : /read|list|enumerate/i.test(entry.accessType) ? '读' : entry.accessType}）`,
            ),
          ...(entries.length > 20 ? [`另有 ${entries.length - 20} 项`] : []),
        ].join('\n')
      : '';
    if (apply) {
      confirm();
      await controller.sandboxLearning.adopt(change.provider, change.ids);
    }
  } else {
    const project = workspace.store.get<Project>('project', change.projectId);
    if (!project || project.removedAt) throw new Error('项目不存在。');
    description = project.approvedVerificationCommands?.includes(change.command)
      ? ''
      : `${project.name}\n${project.path}\n允许此项目执行验收命令\n${JSON.stringify(change.command)}`;
    if (apply) {
      confirm();
      workspace.updateProject(project.id, {
        approvedVerificationCommands: [...new Set([...(project.approvedVerificationCommands ?? []), change.command])],
      });
    }
  }
  return description;
}
