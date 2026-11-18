import { useEffect, useId, useRef, useSyncExternalStore, type ReactNode } from 'react';
import type { Confirmation } from '../shared/confirmation';
import { confirmationStore } from './confirm-dialog';
import { withNames } from './i18n';

export function ConfirmDialog({
  options,
  onAnswer,
  children,
}: {
  options: Confirmation;
  onAnswer: (answer: boolean) => void;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      dialog.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal confirm-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={options.summary || options.points?.length ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onAnswer(false);
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          onAnswer(false);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === 'Tab') {
          const elements = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
            ),
          ];
          const first = elements[0],
            last = elements.at(-1);
          if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
            event.preventDefault();
            last?.focus();
          } else if (
            !event.shiftKey &&
            (document.activeElement === last || document.activeElement === event.currentTarget)
          ) {
            event.preventDefault();
            first?.focus();
          }
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          onAnswer(false);
        }
      }}
    >
      <h2 id={titleId} translate={options.names ? 'no' : undefined}>
        {options.names ? withNames(options.title, options.names) : options.title}
      </h2>
      <div id={descriptionId} className="confirm-description">
        {options.summary && <p>{options.summary}</p>}
        {!!options.points?.length && (
          <ul>
            {options.points.map((point, index) => (
              <li key={index}>{point}</li>
            ))}
          </ul>
        )}
      </div>
      {children}
      <div className="modal-actions">
        <button type="button" className="button secondary" onClick={() => onAnswer(false)}>
          取消
        </button>
        <button
          type="button"
          className={`button ${options.tone === 'danger' ? 'danger' : ''}`}
          onClick={() => onAnswer(true)}
        >
          {options.action}
        </button>
      </div>
    </dialog>
  );
}

export function ConfirmDialogHost() {
  const request = useSyncExternalStore(confirmationStore.subscribe, confirmationStore.snapshot, () => undefined);
  return request ? (
    <ConfirmDialog
      key={request.id}
      options={request.options}
      onAnswer={(answer) => confirmationStore.resolve(request.id, answer)}
    />
  ) : null;
}
