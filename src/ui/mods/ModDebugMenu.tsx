import { useId, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, Lock, MessageSquarePlus, RotateCw, X } from 'lucide-react';
import { modDiagnosticLine, type ModDiagnostic } from '../../shared/mod-debug';
import type { ModPermission } from '../../shared/mods-manifest';
import { useDismiss } from '../use-dismiss';
import { withNames } from '../i18n';

export type ModDebugInfo = {
  errors: number;
  logs: number;
  /** Newest last; the menu shows the last few errors. */
  entries: readonly ModDiagnostic[];
  permissions: { declared: readonly ModPermission[]; approval: 'none' | 'approved' | 'waiting' };
  /** The last mod_load result for this Local build. */
  validation?: { ok: boolean; warnings: readonly string[]; issues: readonly string[] };
  onReload(): void;
  onSendToChat(): void;
};

const approvalLabel = { none: '（无需批准）', approved: '（已批准）', waiting: '（等你批准）' } as const;

/** Mod workspace bar › Debug: one menu, shown only for a Local build. Everything here also reaches the next turn. */
export function ModDebugMenu({ debug, defaultOpen = false }: { debug: ModDebugInfo; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useDismiss(
    open,
    wrap,
    () => setOpen(false),
    () => trigger.current,
  );
  const recent = debug.entries.filter((entry) => entry.level === 'error').slice(-3);
  const close = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  const validation = debug.validation;
  return (
    <div className="mod-panel-menu mod-debug" ref={wrap}>
      <button
        type="button"
        className={`mod-debug-toggle${debug.errors ? ' has-errors' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        ref={trigger}
        onClick={() => setOpen(!open)}
      >
        <span>调试</span>
        {debug.errors > 0 && (
          <span className="mod-debug-count" aria-label={withNames('{0} 个错误', [String(debug.errors)])} data-names>
            {debug.errors}
          </span>
        )}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="mod-menu mod-debug-panel" id={id} role="dialog" aria-label="调试信息">
          <button type="button" onClick={close(debug.onReload)}>
            <RotateCw size={15} aria-hidden="true" />
            <span>重新加载 Mod 画面</span>
          </button>
          <div className="mod-debug-row">
            <AlertTriangle size={15} aria-hidden="true" />
            <span data-names>{withNames('错误 {0} · 日志 {1}', [String(debug.errors), String(debug.logs)])}</span>
            <small>（自加载起）</small>
          </div>
          {recent.length > 0 && (
            <ul className="mod-debug-lines" translate="no">
              {recent.map((entry, index) => (
                <li key={`${entry.at}:${index}`}>{modDiagnosticLine(entry)}</li>
              ))}
            </ul>
          )}
          <div className="mod-debug-row">
            <Lock size={15} aria-hidden="true" />
            <span>
              <span data-names>
                {withNames('权限：{0}', [
                  debug.permissions.declared.length ? debug.permissions.declared.join(', ') : '—',
                ])}
              </span>{' '}
              <small>{approvalLabel[debug.permissions.approval]}</small>
            </span>
          </div>
          <div className="mod-debug-row">
            {validation?.ok ? <Check size={15} aria-hidden="true" /> : <X size={15} aria-hidden="true" />}
            <span>
              {!validation ? (
                '还没加载过'
              ) : validation.ok ? (
                <>
                  清单有效
                  {validation.warnings.length > 0 && (
                    <>
                      {' · '}
                      {validation.warnings.length === 1 ? (
                        '1 条警告'
                      ) : (
                        <span data-names>{withNames('{0} 条警告', [String(validation.warnings.length)])}</span>
                      )}
                    </>
                  )}
                </>
              ) : (
                <span data-names>{withNames('清单有 {0} 个问题', [String(validation.issues.length)])}</span>
              )}
            </span>
          </div>
          {validation && !validation.ok && validation.issues[0] && (
            <ul className="mod-debug-lines" translate="no">
              <li>{validation.issues[0]}</li>
            </ul>
          )}
          <hr />
          <button type="button" className="mod-debug-send" onClick={close(debug.onSendToChat)}>
            <MessageSquarePlus size={15} aria-hidden="true" />
            <span>发到聊天</span>
            <small>作为草稿填入输入框</small>
          </button>
          <p className="mod-debug-note">这里的内容也会自动带进下一轮。</p>
        </div>
      )}
    </div>
  );
}

/** The draft "Send to chat" inserts: newest lines since load, so the user can add a note and send. */
export function modDebugDraft(title: string, version: string, entries: readonly ModDiagnostic[]) {
  const lines = entries.slice(-20).map(modDiagnosticLine);
  return [`Mod debug · ${title} ${version}`, ...(lines.length ? lines : ['(no errors or logs)'])].join('\n');
}
