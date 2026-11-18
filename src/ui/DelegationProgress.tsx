import type { AppState, ConversationMessage, RunRecord, Workflow } from '../shared/types';
import { executionModel } from '../shared/execution-model';
import { delegationRoleLabels } from '../shared/delegation';
import { runtimeIdentity } from './core-runtime';
import { workflowDisplayStatus } from './queue-utils';
import { WorkflowElapsed } from './WorkflowElapsed';
import { safeToolName } from '../shared/tool-event-data';
import { shownName, translateInterfaceText, withNames } from './i18n';
import { shownMentionName } from './Mentions';

const brief = (text?: string) => text?.replace(/\s+/g, ' ').trim().slice(0, 240);

/**
 * Who a subtask was handed to, to show as written (translate="no"): an account, device or role someone named keeps its
 * name; PugPort's own names (自动选择, "Codex · 自动选择账号", built-in roles, outside agents) translate.
 */
export function shownAgentLabel(agent: NonNullable<NonNullable<Workflow['delegation']>['agent']>) {
  const device = agent.deviceId ? /^设备「(.*)」$/su.exec(agent.label) : null;
  if (device) return withNames('设备「{0}」', [device[1]!]);
  if (agent.runtimeId) return shownName(agent.label);
  if (agent.presetId) return shownMentionName({ kind: 'role', id: agent.presetId, name: agent.label });
  return translateInterfaceText(agent.label);
}

/** Only public task reports and tool names; private reasoning is never used as a progress summary. */
export function delegationProgress(workflow: Workflow, runs: readonly RunRecord[], since?: string) {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const ownRuns = workflow.runIds.flatMap((id) => {
    const run = byId.get(id);
    return run && (!run.workflowId || run.workflowId === workflow.id) ? [run] : [];
  });
  const latest = ownRuns.at(-1);
  const afterReceipt = (at: string) => !since || Date.parse(at) >= Date.parse(since);
  const reportIsCurrent = latest && afterReceipt(latest.endedAt ?? latest.startedAt);
  const checkpoint = workflow.delegation?.checkpoints?.filter((entry) => afterReceipt(entry.at)).at(-1);
  const tools = ownRuns.flatMap((run) => run.events.filter((event) => event.type === 'tool' && afterReceipt(event.at)));
  const lastTool = tools.at(-1);
  const tool = safeToolName(lastTool?.data);
  const publicOutput =
    latest && since && !afterReceipt(latest.startedAt)
      ? latest.events
          .filter((event) => event.type === 'text' && afterReceipt(event.at))
          .map((event) => event.text ?? '')
          .join('')
      : latest?.output;
  return {
    latest,
    ownRuns,
    tools: tools.length,
    tool,
    progress: brief(checkpoint?.progress),
    next: brief(checkpoint?.next),
    blocker: brief(checkpoint?.blocker ?? (reportIsCurrent ? latest?.error : undefined)),
    // A checkpoint's blocker and an executor-reported summary are the agent's words; a run error and the other
    // outcome summaries are PugPort's own interface text.
    blockerByAgent: typeof checkpoint?.blocker === 'string',
    judgment: brief(reportIsCurrent ? latest?.taskOutcome?.summary : undefined),
    judgmentByAgent: ['executor-report', 'executor-tool'].includes(latest?.taskOutcome?.source ?? ''),
    output: brief(
      publicOutput
        ?.trim()
        .split(/\n\s*\n/)
        .at(-1),
    ),
  };
}

export function DelegationProgress({
  workflow,
  state,
  sequence,
  historical,
  messages,
  since,
}: {
  workflow: Workflow;
  state: AppState;
  sequence: number;
  historical?: boolean;
  messages: ConversationMessage[];
  since?: string;
}) {
  const progress = delegationProgress(workflow, state.runs, since);
  const model = progress.latest && executionModel(progress.latest);
  const target = progress.latest && runtimeIdentity(state, progress.latest.route.runtimeId);
  const relay = progress.latest?.relay;
  const prior = relay && progress.ownRuns.find((run) => run.id === relay.fromRunId);
  const priorModel = prior && executionModel(prior);
  const priorAccount =
    relay && (prior?.account?.label ?? runtimeIdentity(state, relay.fromRuntimeId)?.label ?? relay.fromRuntimeId);
  const account = progress.latest?.account?.label ?? target?.label;
  // Account labels can be names the user chose; PugPort's default ones (Codex · 本机) still translate.
  const accountName = (label: string) => <span translate="no">{shownName(label)}</span>;
  const checkpoint = progress.latest?.handoffCheckpoint;
  const request = messages.find((message) => message.role === 'user')?.content ?? workflow.input.content;
  const task = brief(request.replace(/^.*?请你?完成以下子任务：\s*/, '').replace(/^子任务（[^）]+）：\s*/, ''));
  return (
    <header className="delegation-task-progress" data-child-id={workflow.id} data-child-sequence={sequence}>
      <div className="delegation-progress-heading">
        <strong>
          子任务 {sequence} · {delegationRoleLabels[workflow.delegation!.role]}
        </strong>
        <span>{historical ? '此前活动' : workflowDisplayStatus(workflow, progress.ownRuns).label}</span>
        {!historical && <WorkflowElapsed workflow={workflow} runs={progress.ownRuns} />}
      </div>
      <p className="delegation-task-title" translate="no">
        {task}
      </p>
      {!historical && (
        <>
          <p className="delegation-executor">
            {account ? (
              accountName(account)
            ) : workflow.delegation?.agent ? (
              <span translate="no">{shownAgentLabel(workflow.delegation.agent)}</span>
            ) : (
              '尚未分配执行器'
            )}
            {model && (
              <>
                {' '}
                · <code>{model.model}</code> · {model.effort ?? '强度未报告'}
              </>
            )}
          </p>
          {relay && (
            <p className="delegation-relay">
              账号接力：{accountName(priorAccount!)}
              {priorModel ? ` · ${priorModel.model} · ${priorModel.effort ?? '强度未报告'}` : ''} →{' '}
              {accountName(account ?? progress.latest!.route.runtimeId)}
              {model ? ` · ${model.model} · ${model.effort ?? '强度未报告'}` : ''} ·{' '}
              {relay.reason === 'quota'
                ? '原账号额度受限'
                : relay.reason === 'content'
                  ? '原模型无法处理此内容'
                  : '原账号认证被拒绝'}
            </p>
          )}
          {checkpoint && (relay || !checkpoint.safe) && (
            <p className="delegation-checkpoint">
              交接记录：已确认工具 {checkpoint.completedToolIds.length} 项 · 待核验 {checkpoint.unconfirmedTools.length}{' '}
              项
            </p>
          )}
          {progress.progress && (
            <p>
              进展：<span translate="no">{progress.progress}</span>
            </p>
          )}
          {progress.next && (
            <p>
              下一步：<span translate="no">{progress.next}</span>
            </p>
          )}
          {progress.blocker && (
            <p className="delegation-blocker">
              需要处理：<span translate={progress.blockerByAgent ? 'no' : undefined}>{progress.blocker}</span>
            </p>
          )}
          {progress.judgment && (
            <p className="delegation-judgment">
              执行器报告：<span translate={progress.judgmentByAgent ? 'no' : undefined}>{progress.judgment}</span>
            </p>
          )}
          {!progress.judgment && progress.output && (
            <p className="delegation-output">
              最新输出：<span translate="no">{progress.output}</span>
            </p>
          )}
          {progress.tools > 0 && (
            <p className="delegation-tool">
              工具记录 {progress.tools} 条
              {progress.tool ? (
                <>
                  {' '}
                  · <code>{progress.tool}</code>
                </>
              ) : null}
            </p>
          )}
          {!progress.progress && !progress.judgment && !progress.output && !progress.blocker && (
            <p className="quiet-text">等待执行器报告进展</p>
          )}
        </>
      )}
    </header>
  );
}
