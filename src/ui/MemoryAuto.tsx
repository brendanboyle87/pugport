import { currentLocale } from './i18n';
import type { MemoryAutoView, Settings } from '../shared/types';

export function MemoryDistillationSwitch({
  settings,
  disabled,
  onChange,
}: {
  settings: Settings;
  disabled?: boolean;
  onChange(value: NonNullable<Settings['memoryDistillation']>): void;
}) {
  return (
    <label className="setting-row">
      <span className="setting-label">
        自动整理项目记忆<small>空闲时用快要浪费的额度，把大项目的进展整理成笔记；默认不用 Claude 和付费 API。</small>
      </span>
      <span className="switch">
        <input
          type="checkbox"
          checked={settings.memoryDistillation?.enabled === true}
          disabled={disabled}
          onChange={(event) => onChange({ ...settings.memoryDistillation, enabled: event.target.checked })}
        />
        <span />
      </span>
    </label>
  );
}

export function MemoryTabs({
  value,
  disabled,
  onChange,
}: {
  value: 'owner' | 'auto';
  disabled: boolean;
  onChange(value: 'owner' | 'auto'): void;
}) {
  return (
    <div className="memory-tabs" role="tablist" aria-label="项目记忆来源">
      <button
        type="button"
        role="tab"
        aria-selected={value === 'owner'}
        disabled={disabled}
        onClick={() => onChange('owner')}
      >
        我写的
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={value === 'auto'}
        disabled={disabled}
        onClick={() => onChange('auto')}
      >
        自动整理
      </button>
    </div>
  );
}

export function MemoryAutoPanel({
  view,
  busy,
  onRun,
  onClear,
}: {
  view: MemoryAutoView;
  busy: boolean;
  onRun(): void;
  onClear(): void;
}) {
  // Section keys are a storage format. Show localized headings in the Chinese interface.
  const content = view.note?.content
    .replace(/^facts:/im, '事实：')
    .replace(/^decisions:/im, '决定：')
    .replace(/^pitfalls:/im, '注意事项：');
  return (
    <section className="memory-auto-panel" aria-label="自动整理">
      <p className="quiet-text">机器生成，仅供参考，手写记忆优先。</p>
      {view.note ? (
        <>
          <div className="memory-auto-content" translate="no">
            {content}
          </div>
          <div className="memory-meta">
            <span>整理时间：{new Date(view.note.updatedAt).toLocaleString(currentLocale())}</span>
            <span>执行器：{view.sourceLabel}</span>
          </div>
        </>
      ) : (
        <p className="panel-intro">还没有自动整理的笔记。</p>
      )}
      <p className="quiet-text" role="status">
        {busy ? '正在整理项目记忆…' : view.reason}
      </p>
      <div className="dialog-actions">
        <button type="button" className="button secondary" disabled={busy || !view.note} onClick={onClear}>
          清除
        </button>
        <button
          type="button"
          className="button primary"
          disabled={busy || !view.eligible}
          title={view.reason}
          onClick={onRun}
        >
          重新整理
        </button>
      </div>
    </section>
  );
}
