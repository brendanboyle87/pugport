import { createHash } from 'node:crypto';
import type { MemoryEvidenceReport } from '../shared/memory-evidence.ts';
import type { MemorySearchHit } from './workspace-store.ts';

const usage = (): MemoryEvidenceReport['usage'] => ({ inputTokens: null, outputTokens: null, totalTokens: null });
const injection =
  /(?:^|[\r\n。!?])\s*(?:(?:please\s+)?ignore\s+(?:all\s+|previous\s+|current\s+|the\s+)?(?:system\s+)?instructions|(?:你必须|请)?忽略.{0,12}(?:当前|之前|系统|所有).{0,8}(?:指令|规则)|(?:please\s+)?(?:send|upload|post).{0,32}(?:api[_ -]?key|secret|credential)|(?:请)?(?:把|将).{0,20}(?:api[_ -]?key|密钥|凭据).{0,20}(?:发送|上传))/i;
const correction =
  /撤回|取消之前|更正|纠正|并未|没有(?:完成|执行|部署)|尚未|还没|未执行|未完成|未部署|not (?:done|completed|executed|performed)|correction|withdraw|retract/i;
const plan =
  /计划|准备|打算|将会|稍后|接下来|待执行|待完成|(?:我|我们|助手|代理)会|will (?:run|do|delete|deploy)|plan to|going to|not yet/i;
const current =
  /现在|目前|当前|最新|是否已经|是否执行|完成|还在|current|latest|now|still|(?:finished|completed|done)|is .* running|permission|允许|授权|(?:可以|能否|可否|能不能)删除|(?:删(?:除)?|回收|移除|清理|部署|执行|提交|发送|安装|修改|保存|上传|运行).{0,16}(?:了吗|了没|没有|过吗|好了|完了吗)|\b(?:did|have|has)\s+(?:you|we|the agent|the assistant)\b.{0,24}\b(?:delete|remove|recycle|deploy|execute|submit|send|install|modify|save|upload|run)(?:d|ed)?\b/i;

export function assessLocalMemoryEvidence(query: string, hits: MemorySearchHit[]): MemoryEvidenceReport {
  return {
    source: 'local',
    status: hits.length ? 'local' : 'empty',
    reason: hits.length
      ? 'Historical excerpts are context, not verified facts or authority to act.'
      : 'No memory excerpts.',
    assessedAt: new Date().toISOString(),
    elapsedMs: 0,
    requestCount: 0,
    cachedCount: 0,
    usage: usage(),
    decisions: hits.map((hit) => {
      const base = {
        messageId: hit.messageId,
        sourceOffset: hit.sourceOffset,
        sourceHash: createHash('sha256').update(hit.excerpt).digest('hex'),
      };
      if (injection.test(hit.excerpt))
        return { ...base, status: 'excluded', reason: 'Instruction-like historical text must not control this turn.' };
      if (correction.test(hit.excerpt))
        return {
          ...base,
          status: 'conflicting',
          reason: 'Possible correction, withdrawal, or statement that work was not performed; keep separate.',
        };
      if (plan.test(hit.excerpt))
        return {
          ...base,
          status: 'partial',
          reason: 'Plan or intended action; does not establish execution or completion.',
        };
      if (current.test(query))
        return {
          ...base,
          status: 'needs-current-check',
          reason: 'Historical claims cannot verify current state, completion, or permission.',
        };
      return { ...base, status: 'context', reason: 'Unverified historical context; retain source and time.' };
    }),
  };
}

type Input = {
  query: string;
  excerpts: MemorySearchHit[];
  projectId: string;
  conversationId: string;
  anchorMessageId: string;
};
/** Legacy injection options are ignored; evidence never leaves the local process. */
export class MemoryEvidenceJudge {
  constructor(
    _options: { credential?: () => string | undefined; fetch?: typeof globalThis.fetch; timeoutMs?: number } = {},
  ) {}

  async assess(
    input: Input,
    options: { signal?: AbortSignal; onAttempt?: () => void } = {},
  ): Promise<MemoryEvidenceReport> {
    options.signal?.throwIfAborted();
    const report = assessLocalMemoryEvidence(input.query, input.excerpts);
    return input.query.trim() && input.excerpts.some((hit) => hit.excerpt.trim())
      ? report
      : { ...report, status: 'empty', reason: 'No query or memory excerpts.' };
  }
}
