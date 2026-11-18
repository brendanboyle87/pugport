import { useRef, useState } from 'react';
import type { Workflow } from '../shared/types';
import type { Api, Notice } from './Workspace';

export function PlanReview({
  workflow,
  api,
  notify,
}: {
  workflow: Workflow;
  api: Api;
  notify: (notice: Notice) => void;
}) {
  const [steps, setSteps] = useState(() => workflow.plan.map(({ title, instruction }) => ({ title, instruction })));
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  async function submit(action: 'approve-plan' | 'cancel') {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    try {
      await api(`/api/workflows/${workflow.id}/${action}`, action === 'approve-plan' ? { steps } : {});
    } catch (error) {
      notify({ tone: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  const valid =
    steps.length >= 1 && steps.length <= 6 && steps.every((step) => step.title.trim() && step.instruction.trim());
  return (
    <section className="routing-confirmation plan-review" aria-label="计划确认">
      <strong>计划确认</strong>
      <p>检查并编辑步骤，批准后开始执行。</p>
      {workflow.input.permissionMode === 'read-only' && (
        <p className="route-policy-hint">当前只读：批准后也不会改文件</p>
      )}
      <ol>
        {steps.map((step, index) => (
          <li key={index}>
            <label className="field">
              <span>步骤标题</span>
              <input
                value={step.title}
                maxLength={150}
                disabled={pending}
                onChange={(event) =>
                  setSteps((list) =>
                    list.map((item, i) => (i === index ? { ...item, title: event.target.value } : item)),
                  )
                }
              />
            </label>
            <label className="field">
              <span>步骤说明</span>
              <textarea
                value={step.instruction}
                maxLength={50000}
                rows={3}
                disabled={pending}
                onChange={(event) =>
                  setSteps((list) =>
                    list.map((item, i) => (i === index ? { ...item, instruction: event.target.value } : item)),
                  )
                }
              />
            </label>
            <button
              type="button"
              className="button tiny secondary"
              disabled={pending || steps.length <= 1}
              onClick={() => setSteps((list) => list.filter((_, i) => i !== index))}
            >
              删除步骤
            </button>
          </li>
        ))}
      </ol>
      <div className="plan-review-actions">
        <button
          type="button"
          className="button secondary"
          disabled={pending || steps.length >= 6}
          onClick={() => setSteps((list) => [...list, { title: '', instruction: '' }])}
        >
          添加步骤
        </button>
        <button
          type="button"
          className="button primary"
          disabled={pending || !valid}
          onClick={() => void submit('approve-plan')}
        >
          批准并执行
        </button>
        <button type="button" className="button secondary" disabled={pending} onClick={() => void submit('cancel')}>
          取消
        </button>
      </div>
    </section>
  );
}
