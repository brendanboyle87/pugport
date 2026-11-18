import { createContext, useContext, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Conversation } from '../shared/types';
import { ContextMenu } from './DesktopFeatures';
import { executorStatus, type ExecutorTask } from './executor-activity';
import { formatElapsedDuration } from './WorkflowElapsed';
import { translateInterfaceText } from './i18n';

export const ExecutorActivityContext = createContext<
  | {
      tasks: Map<string, ExecutorTask[]>;
      conversations: Conversation[];
      now: number;
      onConversation?: (id: string) => void;
    }
  | undefined
>(undefined);

export function ExecutorActivity({
  id,
  error,
  idle = '就绪',
  warning = false,
}: {
  id: string;
  error?: string;
  idle?: string;
  warning?: boolean;
}) {
  const activity = useContext(ExecutorActivityContext);
  const tasks = activity?.tasks.get(id) ?? [];
  const { status, count } = executorStatus(tasks, error);
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setMenu(undefined);
    trigger.current?.focus({ preventScroll: true });
  };
  const label =
    error || (status === 'running' ? `运行中 · ${count}` : status === 'waiting' ? `等待中 · ${count}` : idle);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`quota-status executor-activity ${status}${warning && status === 'error' ? ' request-limited' : ''}`}
        aria-haspopup="menu"
        aria-expanded={!!menu}
        onKeyDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          if (menu) return close();
          const box = event.currentTarget.getBoundingClientRect();
          setMenu({ x: box.left, y: box.bottom + 4 });
        }}
      >
        <span className={`runtime-dot ${status}`} aria-hidden="true" />
        <span>{label}</span>
      </button>
      {menu &&
        createPortal(
          <ContextMenu
            {...menu}
            onClose={close}
            items={
              tasks.length
                ? tasks.map((task) => {
                    const conversation = activity?.conversations.find((item) => item.id === task.conversationId);
                    const elapsed = formatElapsedDuration((activity?.now ?? Date.now()) - Date.parse(task.startedAt));
                    return {
                      icon: <span className={`runtime-dot executor-task-dot ${task.status}`} aria-hidden="true" />,
                      label: (
                        <span className="executor-task-label" translate="no">
                          <span>{conversation?.title ?? translateInterfaceText('未关联对话')}</span>
                          <small>{translateInterfaceText(task.phase)}</small>
                        </span>
                      ),
                      shortcut: translateInterfaceText(elapsed),
                      disabled: !conversation || !activity?.onConversation,
                      onSelect: () => activity?.onConversation?.(conversation!.id),
                    };
                  })
                : [{ label: '暂无活动任务', disabled: true, onSelect() {} }]
            }
          />,
          trigger.current?.closest('dialog') ?? document.body,
        )}
    </>
  );
}
