import { Fragment } from 'react';
import type { ModLocalBuild } from '../shared/conversation-modes';
import { withNames } from './i18n';

/** Store › Installed: where a local build came from, and the author's actions as one quiet line of links. */
export function LocalBuildRow({
  mode,
  build,
  disabled,
  onEdit,
  onReveal,
  onExport,
}: {
  mode: { id: string; version: string };
  build: ModLocalBuild;
  disabled?: boolean;
  onEdit?: (build: ModLocalBuild) => void;
  onReveal: (build: ModLocalBuild) => void;
  onExport: () => void;
}) {
  const actions = [
    ...(onEdit ? [['在对话中编辑', () => onEdit(build)] as const] : []),
    ['打开文件夹', () => onReveal(build)] as const,
    ['导出 JSON', onExport] as const,
  ];
  return (
    <div className="store-local-build">
      <small>
        <span translate="no">{mode.id}</span> · <span translate="no">{mode.version}</span> ·{' '}
        {build.incognito ? (
          '在隐身对话中构建'
        ) : build.conversationTitle ? (
          <span data-names>{withNames('在对话「{0}」中构建', [build.conversationTitle])}</span>
        ) : (
          '原对话已删除'
        )}
      </small>
      <div className="store-local-actions">
        {actions.map(([label, action], index) => (
          <Fragment key={label}>
            {index > 0 && <span aria-hidden="true">·</span>}
            <button type="button" disabled={disabled} onClick={action}>
              {label}
            </button>
          </Fragment>
        ))}
      </div>
    </div>
  );
}
