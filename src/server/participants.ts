import type { AgentPreset } from '../shared/agent-presets.ts';
import { providerNames } from '../shared/delegation.ts';
import { isThirdPartyAgent, type ExternalAgentView } from '../shared/external-agents.ts';
import {
  participantKey,
  participantKindLabels,
  participantLimit,
  type Participant,
  type ParticipantKind,
} from '../shared/participants.ts';
import type { RuntimeTarget } from '../shared/types.ts';
import { resolveAgent } from './agent-names.ts';

/** Everyone a message may call, as the server knows them right now. */
export type ParticipantSources = {
  presets: readonly AgentPreset[];
  targets: RuntimeTarget[];
  externals: readonly ExternalAgentView[];
  /** Absent on a device node, which cannot hand work to devices itself. */
  devices?: readonly { id: string; name: string; online?: boolean; reason?: string; tunnel?: true }[];
};

/** "Claude · 本机" reads as plain "Claude" after an @ (the composer's rule). */
const shortName = (label: string) => label.replace(/\s*·\s*本机$/u, '');

function resolveOne(item: { kind: ParticipantKind; id: string }, sources: ParticipantSources): Participant {
  if (item.kind === 'role') {
    const preset = sources.presets.find((candidate) => candidate.id === item.id && candidate.id !== 'standard');
    if (!preset) throw new Error('叫的角色已经不存在了，请重新选择。');
    return {
      kind: 'role',
      id: preset.id,
      name: preset.name,
      agent: preset.name,
      ...(preset.description ? { description: preset.description } : {}),
    };
  }
  if (item.kind === 'executor') {
    const target = sources.targets.find((candidate) => candidate.id === item.id);
    if (!target?.enabled) throw new Error('叫的执行器已经停用或移除了，请重新选择。');
    // The card name when it names exactly this card; else its id, which delegate also takes.
    let agent = target.id;
    try {
      if (resolveAgent(target.label, sources.targets).runtimeId === target.id) agent = target.label;
    } catch {
      /* Two cards share the name: the id still names this one. */
    }
    return {
      kind: 'executor',
      id: target.id,
      name: shortName(target.label),
      agent,
      description: `${providerNames[target.provider]} 执行器`,
    };
  }
  if (item.kind === 'external') {
    const view = sources.externals.find((candidate) => candidate.id === item.id);
    if (!view) throw new Error('不认识这个外部智能体。');
    if (!view.available) throw new Error(`${view.name} 现在不能用：${view.reason}。`);
    return {
      kind: 'external',
      id: view.id,
      name: view.name,
      agent: view.name,
      description: view.description,
      ...(isThirdPartyAgent(view) ? { thirdParty: true } : {}),
      ...(view.kind === 'handoff' && !view.routine ? { handoff: true } : {}),
    };
  }
  if (!sources.devices) throw new Error('设备节点本身不能再把任务交给设备。');
  const device = sources.devices.find((candidate) => candidate.id === item.id);
  if (!device) throw new Error('没有这台设备，它可能已经被移除了。');
  if (device.online === false && !device.tunnel)
    throw new Error(`设备「${device.name}」现在连不上：${device.reason ?? '它可能关机或断网了'}`);
  return {
    kind: 'device',
    id: device.id,
    name: device.name,
    agent: device.name,
    description:
      '另一台电脑上的 PugPort，按它自己的额度挑执行器；可以接可写子任务，在那台电脑上改文件、运行命令；看不到这台电脑的文件',
  };
}

/**
 * The participants a message called, checked against what exists now: names and descriptions come from here, not
 * from the composer. The same one twice counts once; one that cannot take work now is refused in plain words.
 */
export function resolveParticipants(
  called: readonly { kind: ParticipantKind; id: string }[],
  sources: ParticipantSources,
): Participant[] {
  const seen = new Set<string>();
  const resolved: Participant[] = [];
  for (const item of called) {
    const key = participantKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push(resolveOne(item, sources));
  }
  if (resolved.length > participantLimit) throw new Error(`一条消息最多叫 ${participantLimit} 位。`);
  if (resolved.length < 2) throw new Error('要分工至少得叫两位；只叫一位时它会直接回答这一条。');
  return resolved;
}

/** What the coordinator of a message that called several participants is told, after the user's own words. */
export function participantsNote(participants: readonly Participant[]): string {
  if (participants.length < 2) return '';
  const line = (item: Participant) => {
    const what = `${participantKindLabels[item.kind]}${item.description ? `（${item.description}）` : ''}`;
    const how =
      item.kind === 'role'
        ? `派活时 agent 填「${item.agent}」，PugPort 按额度挑执行器来担任这个角色。`
        : `派活时 agent 填「${item.agent}」。`;
    return `- @${item.name}：${what}${item.thirdParty ? '，第三方网站' : ''}。${how}`;
  };
  const thirdParty = participants.filter((item) => item.thirdParty).map((item) => item.name);
  const steps = [
    '照用户的原话分工：用户说谁做什么，就把那一部分交给谁；没说清的，按各自擅长的分。被点名的每一位都要分到事，除非用户说了不用它。',
    '用 delegate 或 delegate_many 派活，agent 照上面填，一项交给一位；用户把角色和执行器连在一起说（比如“让 Codex B 当代码审查”）时，agent 填执行器、role 填角色。值得列清单时先用 set_plan，assignee 写参与者的名字。',
    '不要另找没被点名的执行器或成员，除非用户自己要求；没分给任何人的零碎事你自己做。',
    '读写权限照常：要改文件的部分才传 write=true；files 只用于这台电脑上的执行器，必须写明要改的文件。设备只有 write=true 时才接可写的部分，在那台电脑上改文件、运行命令；外部智能体只接只读的部分。',
    ...participants
      .filter((item) => item.handoff)
      .map(
        (item) =>
          `${item.name} 只做桌面交接：delegate 会复制它负责的那部分并打开应用，由用户粘贴发送；你不会收到它的回复。汇总时只说明已交接，不要等待、猜测结果或说它已完成任务。`,
      ),
    ...(thirdParty.length
      ? [
          `${thirdParty.join('、')} 是第三方网站：交给它的 task 只写用户要它做的那一部分，不附项目文件内容、本机路径、账号或其他个人信息。它的回复不会交给你，也不会交给其他能用工具的成员，用户会在对话里直接看到；你的答复里写明这部分由它完成，不要转述或猜测它说了什么。`,
          `大家都交回后，PugPort 会让一个不带工具的执行器读它的回复、各位的结果和你的答复，照用户的原话写最终答复（会尽量让用户点名的执行器来写）。所以要用到它回复内容的活（改它写的稿、接着它写、把它的方案和别人的比较或合并）不要派给别的成员，答复里说明留到最后这一步；用户点名让某个执行器处理它的回复时，那一份就在这一步完成。用户只是让它们各自回答、不需要再改写、比较或合并时，在答复最后单独写一行「无需合并」，就不会多这一步。`,
        ]
      : []),
    '全部交回后汇总：答复按参与者分段，每段用参与者的名字作小标题，写清它做了什么、结论是什么；没完成的照实说。',
  ];
  return [
    `用户在这条消息里点名叫了 ${participants.length} 位参与者，由你来分工协调：`,
    ...participants.map(line),
    '',
    '怎么做：',
    ...steps.map((step, index) => `${index + 1}. ${step}`),
  ].join('\n');
}
