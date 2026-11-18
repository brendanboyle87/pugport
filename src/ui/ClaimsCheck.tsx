import { AlertCircle, Check, CircleHelp, Minus, X } from 'lucide-react';
import type { RunRecord, Workflow, WorkflowStep } from '../shared/types';

type Claim = { claim: string; evidence?: string; status?: 'verified' | 'unverified' | 'false'; note?: string };

/** The executor's claims (from its last report that listed any), each with the reviewer's finding when there is one. */
export function workflowClaims(workflow: Workflow, runs: RunRecord[]): Claim[] {
  const claimed = runs
    .map((run) => run.taskOutcome?.claims ?? [])
    .filter((list) => list.length)
    .at(-1);
  if (!claimed) return [];
  const checked = new Map((workflow.review?.claims ?? []).map((item) => [item.claim.trim(), item]));
  return claimed.map((item) => {
    const finding = checked.get(item.claim.trim());
    return { ...item, ...(finding ? { status: finding.status, ...(finding.note ? { note: finding.note } : {}) } : {}) };
  });
}

/** One step's own claims: the last report of that step's runs that listed any. A later step never replaces it. */
export function stepClaims(workflow: Workflow, step: WorkflowStep, runs: RunRecord[]): Claim[] {
  // The task reviewer receives only the last report; equal text in another step is not the same evidence.
  const reviewedRun = runs.filter((run) => run.taskOutcome?.claims?.length).at(-1);
  return workflowClaims(
    reviewedRun && step.runIds.includes(reviewedRun.id) ? workflow : { ...workflow, review: undefined },
    runs.filter((run) => step.runIds.includes(run.id)),
  );
}

/** What the executor said this step came to: its last report with a summary. */
export function stepSummary(step: WorkflowStep, runs: RunRecord[]): string | undefined {
  return runs
    .filter((run) => step.runIds.includes(run.id))
    .map((run) => run.taskOutcome?.summary?.trim())
    .filter(Boolean)
    .at(-1);
}

/** "Says it did 3 things · 2 checked": what the executor says, kept apart from what a check confirmed. */
export function claimsSummary(claims: Claim[], reviewed: boolean): string {
  if (!claims.length) return '';
  const verified = claims.filter((item) => item.status === 'verified').length;
  return reviewed
    ? `说完成 ${claims.length} 项 · 检查通过 ${verified} 项`
    : `说完成 ${claims.length} 项 · ${claims.filter((item) => item.evidence).length} 项给了依据`;
}

const labels = { verified: '检查通过', unverified: '未证实', false: '不成立' } as const;
const factLabels = { verified: '已核实', wrong: '有误', unverifiable: '无法核实' } as const;

/** Independent web checks stay with the answer; details reuse the step report disclosure. */
export function FactCheck({ result }: { result: NonNullable<NonNullable<Workflow['review']>['factCheck']> }) {
  const verified = result.claims.filter((claim) => claim.status === 'verified').length;
  const unverifiable = result.claims.filter((claim) => claim.status === 'unverifiable').length;
  const wrong = result.claims.filter((claim) => claim.status === 'wrong').length;
  return (
    <details className="claims-check step-claims fact-check">
      <summary className="claims-title">
        {result.status === 'incomplete' ? (
          '核验未完成'
        ) : (
          <>
            {`核验：已核实 ${verified} 条 · 无法核实 ${unverifiable} 条`}
            {result.corrected ? ` · 已更正 ${result.corrected} 条` : wrong ? ` · 有误 ${wrong} 条` : ''}
          </>
        )}
      </summary>
      {result.reason && (
        <p className="claims-title" translate="no">
          {result.reason}
        </p>
      )}
      <ul>
        {result.claims.map((item, index) => (
          <li
            key={index}
            className={`claim claim-${item.status === 'wrong' ? 'false' : item.status === 'unverifiable' ? 'unverified' : 'verified'}`}
          >
            <span className="claim-state">
              {item.status === 'verified' ? (
                <Check size={12} />
              ) : item.status === 'wrong' ? (
                <X size={12} />
              ) : (
                <CircleHelp size={12} />
              )}
              {factLabels[item.status]}
            </span>
            <span className="claim-text" translate="no">
              {item.claim}
              {item.correction && <small>{item.correction}</small>}
              {item.reason && <small>{item.reason}</small>}
              {item.source && (
                <small>
                  {/^https?:\/\//i.test(item.source) ? (
                    <a href={item.source} target="_blank" rel="noopener noreferrer">
                      {item.source}
                    </a>
                  ) : (
                    item.source
                  )}
                </small>
              )}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

const severities = {
  must: { label: '必须改', tone: 'false', icon: <X size={12} /> },
  should: { label: '建议改', tone: 'unverified', icon: <AlertCircle size={12} /> },
  nit: { label: '小问题', tone: 'stated', icon: <Minus size={12} /> },
} as const;

function ClaimList({ claims }: { claims: Claim[] }) {
  return (
    <ul>
      {claims.map((item) => (
        <li key={item.claim} className={`claim claim-${item.status ?? (item.evidence ? 'stated' : 'bare')}`}>
          <span className="claim-state">
            {item.status === 'verified' ? (
              <Check size={12} />
            ) : item.status === 'false' ? (
              <X size={12} />
            ) : (
              <CircleHelp size={12} />
            )}
            {item.status ? labels[item.status] : item.evidence ? '有依据' : '没给依据'}
          </span>
          <span className="claim-text" translate="no">
            {item.claim}
            {item.note || item.evidence ? <small>{item.note ?? item.evidence}</small> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** With a plan, each step carries its own list (StepReport); the task-level box keeps a planless list and the rules. */
export function ClaimsCheck({ workflow, runs }: { workflow: Workflow; runs: RunRecord[] }) {
  const claims = workflow.plan?.length ? [] : workflowClaims(workflow, runs);
  const rules = workflow.review?.rules ?? [];
  const order = Object.keys(severities);
  const findings = [...(workflow.review?.findings ?? [])].sort(
    (a, b) => order.indexOf(a.severity) - order.indexOf(b.severity),
  );
  if (!claims.length && !rules.length && !findings.length) return null;
  const reviewed = !!workflow.review?.claims;
  return (
    <div className="claims-check">
      {claims.length ? (
        <>
          <p className="claims-title">
            执行器说完成了 {claims.length} 项{reviewed ? '，审核逐条核对：' : '（未经审核，依据由执行器自己给出）：'}
          </p>
          <ClaimList claims={claims} />
        </>
      ) : null}
      {rules.length ? (
        <>
          <p className="claims-title">项目规则检查：</p>
          <ul>
            {rules.map((rule) => (
              <li key={rule.rule} className={`claim claim-${rule.ok ? 'verified' : 'false'}`}>
                <span className="claim-state">
                  {rule.ok ? <Check size={12} /> : <X size={12} />}
                  {rule.ok ? '遵守' : '违反'}
                </span>
                <span className="claim-text" translate="no">
                  {rule.rule}
                  {rule.note ? <small>{rule.note}</small> : null}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {findings.length ? (
        <>
          <p className="claims-title">审核意见：</p>
          <ul>
            {findings.map((item, index) => (
              <li key={index} className={`claim claim-${severities[item.severity].tone}`}>
                <span className="claim-state">
                  {severities[item.severity].icon}
                  {severities[item.severity].label}
                </span>
                <span className="claim-text" translate="no">
                  {item.text}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

/** Under each step: what the executor said the step came to, and that step's own list, folded unless it is the latest. */
export function StepReport({
  workflow,
  step,
  runs,
  open,
}: {
  workflow: Workflow;
  step: WorkflowStep;
  runs: RunRecord[];
  open: boolean;
}) {
  const summary = stepSummary(step, runs);
  const claims = stepClaims(workflow, step, runs);
  if (!summary && !claims.length) return null;
  const reviewed = claims.some((claim) => claim.status !== undefined);
  return (
    <div className="step-report">
      {summary && (
        <p className="step-summary" translate="no">
          {summary}
        </p>
      )}
      {claims.length ? (
        <details className="claims-check step-claims" open={open}>
          <summary className="claims-title">
            执行器说完成了 {claims.length} 项{reviewed ? '，审核逐条核对' : '（未经审核，依据由执行器自己给出）'}
          </summary>
          <ClaimList claims={claims} />
        </details>
      ) : null}
    </div>
  );
}
