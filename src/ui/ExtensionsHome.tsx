import { useEffect, useRef, useState } from 'react';
import type { Conversation, Settings } from '../shared/types';
import type { Api, Notice } from './Workspace';
import { ExtensionsPage } from './Extensions';
import { StorePage } from './StorePage';
import { SettingsHeaderSlot, useSettingsTarget } from './SettingsShell';
import { OverlayLayer } from './SideSheet';

export type ExtensionsTab = 'mods' | 'skills' | 'connections' | 'components';
const tabs = [
  ['mods', 'Mods'],
  ['skills', '技能'],
  ['connections', '连接与服务'],
] as const;

export function readExtensionsTab(): ExtensionsTab {
  try {
    const saved = localStorage.getItem('pugport-extensions-tab');
    if (saved === 'components') return 'connections';
    return tabs.find(([id]) => id === saved)?.[0] ?? 'mods';
  } catch {
    return 'mods';
  }
}

export function ExtensionsHome({
  api,
  notify,
  tab,
  onTab,
  target,
  defaultFolder,
  externalCallers,
  onOpenMod,
  onOpenConversation,
}: {
  api: Api;
  notify: (notice: Notice) => void;
  tab?: ExtensionsTab;
  onTab?: (tab: ExtensionsTab) => void;
  target?: { id: string; request: number };
  defaultFolder?: string;
  externalCallers?: Settings['externalCallers'];
  onOpenMod?: (mode: { id: string; version: string; title: string }) => void | Promise<void>;
  onOpenConversation?: (conversation: Conversation) => void | Promise<void>;
}) {
  const [remembered, setRemembered] = useState<ExtensionsTab>(readExtensionsTab);
  const selected = (tab ?? remembered) === 'components' ? 'connections' : (tab ?? remembered);
  const [headerAction, setHeaderAction] = useState<HTMLDivElement | null>(null);
  // Sheets and menus render here, outside the tab body's size container, so they anchor like Settings' sheets.
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const content = useRef<HTMLDivElement>(null);
  useSettingsTarget(content, selected === 'connections' ? target : undefined, [selected]);
  useEffect(() => {
    try {
      localStorage.setItem('pugport-extensions-tab', selected);
    } catch {
      /* Storage can be unavailable. */
    }
  }, [selected]);
  const select = (value: ExtensionsTab) => {
    setRemembered(value);
    onTab?.(value);
  };
  return (
    <SettingsHeaderSlot value={headerAction}>
      <OverlayLayer value={layer}>
        <div className={'extensions-home' + (selected === 'mods' ? ' extensions-home-mods' : '')}>
          <header className="extensions-heading">
            <h1>扩展</h1>
            <div className="settings-header-action" ref={setHeaderAction} />
          </header>
          <div
            className="page-tabs"
            role="tablist"
            aria-label="扩展"
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
              const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
              const index = buttons.indexOf(event.target as HTMLButtonElement);
              if (index < 0) return;
              event.preventDefault();
              const next = (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
              select(tabs[next]![0]);
              buttons[next]?.focus();
            }}
          >
            {tabs.map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={'extensions-tab-' + id}
                aria-controls="extensions-body"
                aria-selected={selected === id}
                tabIndex={selected === id ? 0 : -1}
                className={selected === id ? 'active' : ''}
                onClick={() => select(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <div
            ref={content}
            id="extensions-body"
            role="tabpanel"
            aria-labelledby={'extensions-tab-' + selected}
            className={selected === 'mods' ? 'extensions-body' : 'extensions-body settings-content'}
          >
            {selected === 'mods' ? (
              <StorePage
                api={api}
                notify={notify}
                target={target}
                onOpenMod={onOpenMod}
                onOpenConversation={onOpenConversation}
              />
            ) : (
              <ExtensionsPage
                section={selected}
                api={api}
                notify={notify}
                defaultFolder={defaultFolder}
                externalCallers={externalCallers}
              />
            )}
          </div>
          <div ref={setLayer} />
        </div>
      </OverlayLayer>
    </SettingsHeaderSlot>
  );
}
