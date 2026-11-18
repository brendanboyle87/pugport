import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type DependencyList,
} from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft } from 'lucide-react';
import { settingsCategories, type SettingsCategory } from './settings-categories';

const HeaderActionSlot = createContext<HTMLDivElement | null>(null);

export function SettingsHeaderAction({ children }: { children: ReactNode }) {
  const slot = useContext(HeaderActionSlot);
  return slot ? createPortal(children, slot) : children;
}

export function SettingsHeaderSlot({ value, children }: { value: HTMLDivElement | null; children: ReactNode }) {
  return <HeaderActionSlot.Provider value={value}>{children}</HeaderActionSlot.Provider>;
}

export function useSettingsTarget(
  contentRef: RefObject<HTMLDivElement | null>,
  target: { id: string; request: number } | undefined,
  deps: DependencyList,
) {
  useEffect(() => {
    if (!target) return;
    const root = contentRef.current;
    if (!root) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let row: HTMLElement | undefined;
    const land = () => {
      row = [...root.querySelectorAll<HTMLElement>('[data-settings-item]')].find(
        (item) => item.dataset.settingsItem === target.id,
      );
      if (!row) return;
      // Open the target row and its containers before trying a field inside hidden details.
      for (const details of row.querySelectorAll('details')) details.open = true;
      let ancestor: HTMLElement | null = row;
      while (ancestor && ancestor !== root) {
        if (ancestor.classList.contains('settings-row'))
          ancestor
            .querySelector<HTMLButtonElement>(':scope > .settings-row-main .settings-row-expand[aria-expanded="false"]')
            ?.click();
        if (ancestor.tagName === 'DETAILS') ancestor.setAttribute('open', '');
        ancestor = ancestor.parentElement;
      }
      row.scrollIntoView({ block: 'center' });
      const control = row.querySelector<HTMLElement>('[data-settings-focus]:not(:disabled)');
      const visible = control && control.getClientRects().length > 0 && !control.closest('[hidden]');
      if (visible) control.focus();
      if (!control || !visible || document.activeElement !== control) row.focus();
      row.classList.add('is-target');
      clearTimeout(timer);
      timer = setTimeout(() => row?.classList.remove('is-target'), 1000);
      return control
        ? visible && document.activeElement === control
        : row.getClientRects().length > 0 && !row.closest('[hidden]') && document.activeElement === row;
    };
    const observer = new MutationObserver(() => {
      if (land()) observer.disconnect();
    });
    if (!land())
      observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    return () => {
      observer.disconnect();
      clearTimeout(timer);
      row?.classList.remove('is-target');
    };
  }, [contentRef, target, ...deps]);
}

export function SettingsShell({
  category,
  onCategory,
  target,
  children,
  accountConfigured = false,
}: {
  category: SettingsCategory;
  onCategory: (category: SettingsCategory) => void;
  target?: { id: string; request: number };
  children: ReactNode;
  accountConfigured?: boolean;
}) {
  const [headerAction, setHeaderAction] = useState<HTMLDivElement | null>(null);
  const [view, setView] = useState<'list' | 'detail'>(target ? 'detail' : 'list');
  const [narrow, setNarrow] = useState<boolean>();
  const shell = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const navigation = useRef<HTMLElement>(null);
  const returnFocus = useRef(false);
  const categories = settingsCategories.filter((item) => item.id !== 'account' || accountConfigured);
  const selected = categories.find((item) => item.id === category) ?? categories[0];
  useLayoutEffect(() => {
    const root = shell.current;
    if (!root) return;
    setNarrow(root.getBoundingClientRect().width < 640);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width < 640);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (view === 'list' && returnFocus.current) {
      returnFocus.current = false;
      navigation.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
    }
  }, [view]);
  useEffect(() => {
    if (target) setView('detail');
  }, [target]);
  useSettingsTarget(content, view === 'detail' ? target : undefined, [category, view]);
  return (
    <SettingsHeaderSlot value={headerAction}>
      <div className="settings-container" ref={shell}>
        <div className="settings-shell" data-view={view}>
          <nav className="settings-navigation" aria-label="设置分类" ref={navigation}>
            <h1>设置</h1>
            {categories.map((item) => (
              <button
                type="button"
                key={item.id}
                data-settings-category={item.id}
                aria-current={item.id === category ? 'page' : undefined}
                onClick={() => {
                  onCategory(item.id);
                  setView('detail');
                }}
              >
                <span>{item.name}</span>
                <small>{item.description}</small>
              </button>
            ))}
          </nav>
          <div className="settings-content" ref={content}>
            <button
              type="button"
              className="button quiet settings-back"
              onClick={() => {
                returnFocus.current = true;
                setView('list');
              }}
            >
              <ChevronLeft size={16} aria-hidden="true" />
              设置
            </button>
            <header className="settings-category-heading">
              <div className="settings-category-title">
                <h2>{selected.name}</h2>
                <div className="settings-header-action" ref={setHeaderAction} />
              </div>
              <p>{selected.description}</p>
            </header>
            {(narrow === false || view === 'detail') && (
              <div className="settings-category-body" key={category}>
                {children}
              </div>
            )}
          </div>
        </div>
      </div>
    </SettingsHeaderSlot>
  );
}
