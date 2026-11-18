import { useEffect, useId, useRef, useState } from 'react';
import type { ConversationModeView as ModeView } from '../shared/conversation-modes';
import { composeModePrompt } from '../shared/mods-manifest';
import { renderMarkdown } from './markdown';
import { useUiUpdateBlocker } from './ui-update-guard';
import { friendlyModError } from './mod-errors';

export type ModFormViewProps = {
  view: ModeView;
  busy: boolean;
  error?: string;
  onSave: (values: Record<string, string>) => Promise<void>;
  onCompose: (text: string) => void;
  onStore: () => void;
  onReload?: () => Promise<ModeView>;
};

/** The host renders a declarative surface. Imported packages never execute UI code. */
export function ModFormView({ view, busy, error, onSave, onCompose, onStore, onReload }: ModFormViewProps) {
  const { manifest, instance } = view;
  const panel = manifest?.contributions?.rightPanel;
  const form = panel?.kind === 'form' ? panel.form : undefined;
  const prefix = useId();
  const alive = useRef(true);
  const operation = useRef(false);
  const [values, setValues] = useState(instance?.state ?? {});
  const [pending, setPending] = useState(false);
  const [localError, setLocalError] = useState<string>();
  useUiUpdateBlocker(
    () =>
      busy ||
      pending ||
      operation.current ||
      Boolean(form?.fields.some((field) => (values[field.id] ?? '') !== (instance?.state[field.id] ?? ''))),
    'mod',
  );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  if (!manifest || !instance || !form) return null;
  const disabled = busy || pending || !view.installed;
  const dirty = form.fields.some((field) => (values[field.id] ?? '') !== (instance.state[field.id] ?? ''));
  async function act(actionId?: string) {
    if (disabled || operation.current) return;
    operation.current = true;
    setPending(true);
    setLocalError(undefined);
    const captured = { ...values };
    try {
      await onSave(captured);
      if (alive.current && actionId) {
        const formValues = Object.fromEntries(
          form!.fields.map((field) => [field.id, captured[field.id] ?? field.initialValue ?? '']),
        );
        onCompose(composeModePrompt(form!, actionId, formValues));
      }
    } catch (failure) {
      if (alive.current) setLocalError(friendlyModError(failure).text);
    } finally {
      operation.current = false;
      if (alive.current) setPending(false);
    }
  }
  return (
    <section className="conversation-mode-view" aria-label={manifest.title}>
      {!view.installed && (
        <p role="status">
          模式已卸载，已保存的内容仍可阅读。
          <button type="button" className="text-button" onClick={onStore}>
            打开 Mods Store
          </button>
        </p>
      )}
      {form.markdown && <div className="markdown">{renderMarkdown(form.markdown)}</div>}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void act();
        }}
      >
        {form.fields.map((field) => (
          <label key={field.id} htmlFor={`${prefix}-${field.id}`}>
            <span>{field.label}</span>
            {field.type === 'textarea' ? (
              <textarea
                id={`${prefix}-${field.id}`}
                rows={4}
                readOnly={disabled}
                value={values[field.id] ?? ''}
                onChange={(event) => setValues((previous) => ({ ...previous, [field.id]: event.target.value }))}
              />
            ) : (
              <input
                id={`${prefix}-${field.id}`}
                readOnly={disabled}
                value={values[field.id] ?? ''}
                onChange={(event) => setValues((previous) => ({ ...previous, [field.id]: event.target.value }))}
              />
            )}
            {field.help && <small>{field.help}</small>}
          </label>
        ))}
        {view.installed && (
          <div className="conversation-mode-actions">
            {!form.actions.some((action) => action.type === 'save') && form.fields.length > 0 && (
              <button className="button secondary" type="submit" disabled={disabled || !dirty}>
                保存
              </button>
            )}
            {form.actions.map((action) => (
              <button
                key={action.id}
                type="button"
                className="button secondary"
                disabled={disabled}
                title={action.type === 'compose' ? '填入输入框，确认后再发送' : undefined}
                onClick={() => void act(action.type === 'compose' ? action.id : undefined)}
              >
                {action.label}
              </button>
            ))}
            <small role="status">{pending || busy ? '正在保存…' : dirty ? '更改尚未保存' : '内容已保存'}</small>
          </div>
        )}
        {(localError || error) && (
          <div className="conversation-mode-error" role="alert">
            <p>{friendlyModError(localError || error).text}</p>
            {onReload && (
              <button
                type="button"
                className="button secondary"
                disabled={disabled}
                onClick={() => {
                  void onReload()
                    .then((fresh) => {
                      if (alive.current && fresh.instance?.id === instance.id) {
                        setValues({ ...fresh.instance.state });
                        setLocalError(undefined);
                      }
                    })
                    .catch((failure) => {
                      if (alive.current) setLocalError(friendlyModError(failure).text);
                    });
                }}
              >
                重新读取模式状态
              </button>
            )}
          </div>
        )}
      </form>
    </section>
  );
}
