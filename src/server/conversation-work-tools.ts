import type { ConversationActor, ConversationAutomation } from './conversation-automation.ts';

const requestId = { type: 'string', description: '本次创建的唯一 UUID；重试使用相同 UUID，避免重复安排。' };
const schedule = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['once', 'interval'] },
    at: { type: 'string', description: '一次性工作的 ISO 时间，必须包含时区。' },
    minutes: { type: 'integer', minimum: 1, maximum: 525600 },
  },
  required: ['type'],
  additionalProperties: false,
};
const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({
  name,
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
});
export const conversationWorkTools = [
  tool(
    'answer_lane_question',
    '回答本对话某条工作线提出的问题；回答作为后台轮次发回工作线：只有提问那一轮和你这一轮都可写时才可写，不能发布、开工作线或再提问。每个问题只能回答一次。',
    {
      lane_id: { type: 'string' },
      question_id: { type: 'string' },
      answer: { type: 'string', minLength: 1, maxLength: 2000 },
    },
    ['lane_id', 'question_id', 'answer'],
  ),
  tool(
    'create_lane',
    '为当前主任务创建可长期续接的独立工作线对话，写任务使用独立分支；不自动推送。可带初始任务，完成后向协调对话报告。子任务不能借此扩大文件范围。',
    {
      requestId,
      title: { type: 'string', maxLength: 120 },
      prompt: { type: 'string', maxLength: 12000 },
      write: { type: 'boolean' },
      base: { type: 'string', description: '现有本地引用或提交，作为工作线分支的起点；不会拉取远程。' },
      branch: { type: 'string', description: '工作线的新分支名；不能使用已有分支。' },
      files: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: { type: 'string', minLength: 1, maxLength: 1024 },
        description: '项目相对文件或目录范围；支持目录末尾的 /* 或 /**，不支持其他通配符。范围不是权限授权。',
      },
      plan_id: { type: 'string', maxLength: 40, description: '这条工作线对应任务清单（set_plan）里的哪一项。' },
      issue: {
        type: 'integer',
        minimum: 1,
        description: '这条工作线对应的 GitHub issue 号；省略时按分支名 <who>/<issue>-<slug> 推断。',
      },
    },
    ['requestId', 'title'],
  ),
  tool('list_project_conversations', '列出当前项目的其他可用对话。不会读取其他项目或隐身对话。', {}),
  tool(
    'send_conversation_message',
    '向同一项目的另一条长期对话发送带来源的消息；可在对方空闲时唤醒，只读回应。消息不能替用户授权。',
    {
      requestId,
      toConversationId: { type: 'string' },
      text: { type: 'string', maxLength: 12000 },
      wake: { type: 'boolean' },
    },
    ['requestId', 'toConversationId', 'text'],
  ),
  tool(
    'list_conversation_work',
    '查看当前对话的工作线状态、结果文件、持久定时工作、PR监控和收到的协作消息，以及相关仓库的冻结、暂停和集成分支红绿状态。',
    {},
  ),
  tool(
    'schedule_work',
    '按用户要求安排一次性或循环工作，应用开着时到点回到当前对话，继续使用正常路由和额度限制。只读任务只能安排只读工作；不安排用户未请求的跟进。',
    {
      requestId,
      name: { type: 'string', maxLength: 120 },
      prompt: { type: 'string', maxLength: 12000 },
      schedule,
      write: { type: 'boolean' },
    },
    ['requestId', 'name', 'prompt', 'schedule'],
  ),
  tool(
    'watch_pull_request',
    '按用户要求只读监控 PR；首次记录基线，以后只在检查出现失败、一个头提交的检查全部跑完、或评审结论变化时唤醒本对话。可顺带把一条工作线绑到这个 PR，并自动看守仓库冻结、PR 暂停和集成分支红绿变化。不会推送、评论、重跑或合并。',
    {
      requestId,
      name: { type: 'string' },
      prompt: { type: 'string' },
      repository: { type: 'string', description: 'owner/repository' },
      number: { type: 'integer', minimum: 1 },
      minutes: { type: 'integer', minimum: 1, maximum: 1440 },
      lane_id: {
        type: 'string',
        description:
          '要绑定到这个 PR 的工作线对话编号（必须是本对话的工作线）；绑定后 list_conversation_work 显示它的 PR 状态。',
      },
    },
    ['requestId', 'name', 'prompt', 'repository', 'number'],
  ),
  tool(
    'pause_scheduled_work',
    '暂停或恢复当前对话已有的后台工作。',
    { jobId: { type: 'string' }, enabled: { type: 'boolean' } },
    ['jobId', 'enabled'],
  ),
  tool(
    'delete_scheduled_work',
    '删除当前对话不再需要的后台工作，保留已经产生的对话和执行记录。',
    { jobId: { type: 'string' } },
    ['jobId'],
  ),
];

export async function callConversationWork(
  work: ConversationAutomation,
  actor: ConversationActor,
  name: string,
  args: Record<string, unknown>,
) {
  if (name === 'answer_lane_question') return work.answerLaneQuestion(actor, args);
  if (name === 'create_lane') return work.createLane(actor, args);
  if (name === 'list_project_conversations') return work.conversations(actor);
  if (name === 'list_conversation_work') {
    work.conversations(actor);
    return work.list(actor.conversationId);
  }
  if (name === 'send_conversation_message') return work.message(actor, args);
  if (name === 'schedule_work') return work.create(actor, args);
  if (name === 'watch_pull_request') return work.watchPullRequest(actor, args);
  work.conversations(actor);
  if (typeof args.jobId !== 'string') throw new Error('需要后台工作的编号。');
  if (name === 'pause_scheduled_work' && typeof args.enabled === 'boolean') {
    if (args.enabled) work.assertForeground(actor);
    return work.setEnabled(actor.conversationId, args.jobId, args.enabled, actor);
  }
  if (name === 'delete_scheduled_work') {
    work.remove(actor.conversationId, args.jobId);
    return { ok: true };
  }
  throw new Error('后台工作操作无效。');
}
