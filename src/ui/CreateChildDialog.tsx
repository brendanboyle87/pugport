import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { Delegation, Workflow } from '../shared/types';
import type { Api, Notice } from './Workspace';
import { useUiUpdateBlocker } from './ui-update-guard';

/** One manual delegation path for the conversation toolbar and a selected member. */
export function CreateChildDialog({
  parent,
  initialRole = 'worker',
  api,
  notify,
  onClose,
  onCreated,
}: {
  parent: Workflow;
  initialRole?: Delegation['role'];
  api: Api;
  notify: (notice: Notice) => void;
  onClose: () => void;
  onCreated?: (workflow: Workflow) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [role, setRole] = useState(initialRole);
  const [task, setTask] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<{ key: string; id: string } | undefined>(undefined);
  const busy = useRef(false);
  const mounted = useRef(true);
  useUiUpdateBlocker(() => Boolean(task.trim()) || busy.current, 'create-child');
  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    return () => {
      mounted.current = false;
    };
  }, []);
  async function submit() {
    if (busy.current || !task.trim()) return;
    const key = JSON.stringify([parent.id, role, task.trim()]);
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
    busy.current = true;
    setPending(true);
    setError('');
    try {
      const result = await api<{ workflow: Workflow }>(`/api/workflows/${encodeURIComponent(parent.id)}/delegate`, {
        role,
        task: task.trim(),
        requestId: request.current.id,
      });
      if (
        !result.workflow?.id ||
        result.workflow.conversationId !== parent.conversationId ||
        result.workflow.delegation?.parentId !== parent.id
      )
        throw Error('服务器尚未确认子任务记录，请保留任务后重试。');
      if (!mounted.current) return;
      onCreated?.(result.workflow);
      onClose();
      notify({ tone: 'info', message: '子任务已创建；执行进展和改动交付会分别显示。' });
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="native-dialog"
      aria-label="创建子代理"
      onContextMenu={(event) => event.stopPropagation()}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy.current) onClose();
      }}
    >
      <div className="dialog-inner">
        <div className="dialog-title">
          <h2>创建子代理</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭创建子代理"
            disabled={pending}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <p>独立完成这里的任务，结果保留在当前对话。写入权限不会超过父任务。</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <fieldset className="settings-fields" disabled={pending}>
            <label className="field">
              <span>角色</span>
              <select
                aria-label="子代理角色"
                value={role}
                onChange={(event) => setRole(event.target.value as Delegation['role'])}
              >
                <option value="worker">实现</option>
                <option value="scout">调查（只读）</option>
                <option value="reviewer">审查（独立核验，只读）</option>
              </select>
            </label>
            <p className="quiet-text">
              {role === 'worker' && parent.input.permissionMode === 'workspace-write'
                ? 'Git 项目会使用独立工作目录，普通文件夹沿用共享目录的权限与排队。完成后会单独显示改动交付结果。'
                : '此子代理只读，不会修改项目文件。'}
            </p>
            <label className="field">
              <span>具体任务</span>
              <textarea
                autoFocus
                aria-label="子代理任务"
                value={task}
                maxLength={10000}
                required
                rows={6}
                onChange={(event) => setTask(event.target.value)}
              />
            </label>
          </fieldset>
          {error && <p role="alert">{error}</p>}
          <div className="dialog-actions">
            <button type="button" className="button secondary" disabled={pending} onClick={onClose}>
              取消
            </button>
            <button type="submit" className="button primary" disabled={pending || !task.trim()}>
              {pending ? '正在创建…' : '创建子代理'}
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
}
