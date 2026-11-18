import type { ModeCatalogEntry } from '../../shared/conversation-modes';
import { ModeIcon } from './mod-icons';

export function ModBadge({ mode }: { mode?: Pick<ModeCatalogEntry, 'icon' | 'title' | 'logo'> }) {
  const label = mode?.title ? `Mod：${mode.title}` : 'Mod';
  return (
    <span className="mod-badge" role="img" aria-label={label} title={label}>
      <ModeIcon mode={mode} size={13} />
    </span>
  );
}
