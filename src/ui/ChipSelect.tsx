import {
  Children,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Check, ChevronDown, ChevronRight, Search } from 'lucide-react';
import { openPickerGroups, pickerMatches, shortPickerItems } from '../shared/model-groups';
import { translateInterfaceText } from './i18n';

type Group = { id: string; label: string; title?: string };
type Option = { value: string; label: string; disabled: boolean; discovered?: boolean; title?: string; group?: Group };

const groupStorage = (key: string) => `pugport.picker-groups.${key}`;
function rememberedGroups(key: string | undefined): Record<string, boolean> {
  if (!key) return {};
  try {
    const value: unknown = JSON.parse(localStorage.getItem(groupStorage(key)) ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter(([, open]) => typeof open === 'boolean'))
      : {};
  } catch {
    return {};
  }
}
function rememberGroup(key: string | undefined, id: string, open: boolean) {
  if (!key) return;
  try {
    localStorage.setItem(groupStorage(key), JSON.stringify({ ...rememberedGroups(key), [id]: open }));
  } catch {
    /* Storage unavailable: the choice lasts while the menu is open. */
  }
}

/**
 * Reads <option> children (as they would be written for a native select) into menu items. An <optgroup> becomes a
 * collapsible group; its data-group attribute is the stable id its collapse state is remembered under.
 */
function readOptions(children: ReactNode): Option[] {
  const out: Option[] = [];
  const text = (node: ReactNode): string =>
    Children.toArray(node)
      .map((part) => (typeof part === 'string' || typeof part === 'number' ? String(part) : ''))
      .join('');
  const visit = (node: ReactNode, group?: Group) =>
    Children.forEach(node, (child) => {
      if (!isValidElement(child)) return;
      const element = child as ReactElement<{
        value?: unknown;
        children?: ReactNode;
        disabled?: boolean;
        title?: string;
        label?: string;
        'data-discovered'?: boolean;
        'data-group'?: string;
      }>;
      if (element.type === 'option')
        out.push({
          value: String(element.props.value ?? ''),
          label: text(element.props.children),
          disabled: !!element.props.disabled,
          discovered: element.props['data-discovered'],
          title: element.props.title,
          ...(group ? { group } : {}),
        });
      else if (element.type === 'optgroup') {
        const label = String(element.props.label ?? '');
        const title = element.props.title;
        visit(element.props.children, { id: element.props['data-group'] ?? label, label, ...(title ? { title } : {}) });
      } else visit(element.props.children, group);
    });
  visit(children);
  return out;
}

/** What a typed filter is matched against: the name as written and as shown in the interface language, and the id. */
const optionMatches = (option: Option, query: string) =>
  pickerMatches([option.label, translateInterfaceText(option.label), option.value], query);

/**
 * A composer chip with its own menu, styled like the rest of the app instead of the system dropdown. The
 * native select stays in the markup (hidden) so forms, tests and assistive tools still see the same choices.
 * Options inside an <optgroup> show under a collapsible header: the selection's group is always open when the menu
 * opens, other groups start open only in a short list, and the owner's choice is remembered under groupMemory.
 * A long list also gets a filter field on the side of the menu nearest the chip; typing searches every group.
 */
export function ChipSelect({
  label,
  ariaLabel,
  value,
  onChange,
  onOpen,
  disabled,
  title,
  className = '',
  groupMemory,
  children,
}: {
  label: string;
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
  onOpen?: () => void;
  disabled?: boolean;
  title?: string;
  className?: string;
  /** Where this picker's collapsed groups are remembered in local UI storage, for example `executor`. */
  groupMemory?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<CSSProperties>({});
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const options = readOptions(children);
  const searchable = options.length > shortPickerItems;
  const filtering = searchable && !!query.trim();
  const current = options.find((option) => option.value === value);
  const groups = options.reduce<Array<Group & { count: number }>>((list, option) => {
    if (!option.group) return list;
    const found = list.find((group) => group.id === option.group!.id);
    if (found) found.count++;
    else list.push({ ...option.group, count: 1 });
    return list;
  }, []);
  // While filtering, every group shows its matches, collapsed or not.
  const shown = options.map((option) =>
    filtering ? optionMatches(option, query) : !option.group || openGroups.has(option.group.id),
  );
  const upward = place.bottom !== undefined;
  const toggleGroup = (id: string) => {
    const next = new Set(openGroups);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpenGroups(next);
    rememberGroup(groupMemory, id, next.has(id));
  };
  const filter = (next: string) => {
    setQuery(next);
    // The first match is ready for Enter.
    setActive(
      options.findIndex(
        (option) =>
          !option.disabled &&
          (next.trim() ? optionMatches(option, next) : !option.group || openGroups.has(option.group.id)),
      ),
    );
  };
  useLayoutEffect(() => {
    if (!open || !root.current) return;
    // Open upward near the bottom of the window (the composer usually sits there).
    // Fixed to the window, so a container that clips its overflow (the composer) cannot hide the menu.
    // It opens upward near the bottom of the window, where the composer usually sits.
    const box = root.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(box.left, window.innerWidth - 328));
    setPlace(
      box.bottom > window.innerHeight * 0.55
        ? { left, bottom: window.innerHeight - box.top + 6 }
        : { left, top: box.bottom + 6 },
    );
    setOpenGroups(
      openPickerGroups({ groups, selectedGroup: current?.group?.id, remembered: rememberedGroups(groupMemory) }),
    );
    setActive(
      Math.max(
        0,
        options.findIndex((option) => option.value === value),
      ),
    );
    field.current?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);
  // Keep the highlighted item in view, including the selection when the menu opens.
  useEffect(() => {
    if (open)
      menu.current?.querySelector<HTMLElement>('[role="option"].active')?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active, query, openGroups]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [open]);
  const choose = (option?: Option) => {
    if (!option || option.disabled) return;
    setOpen(false);
    if (option.value !== value) onChange(option.value);
  };
  // Arrow keys pass over what a collapsed group or the filter hides, as over disabled items.
  const move = (step: number) => {
    if (!options.some((option, index) => !option.disabled && shown[index])) return;
    let next = active < 0 ? (step > 0 ? -1 : 0) : active;
    do next = (next + step + options.length) % options.length;
    while (options[next]!.disabled || !shown[next]);
    setActive(next);
  };
  const item = (option: Option, index: number) => (
    <button
      type="button"
      role="option"
      key={option.value || `option-${index}`}
      aria-selected={option.value === value}
      title={option.title}
      // aria-disabled rather than disabled: a listed but unavailable choice still shows its tooltip on hover.
      aria-disabled={option.disabled || undefined}
      className={`${index === active ? 'active' : ''}${option.disabled ? ' unavailable' : ''}`}
      onMouseEnter={() => !option.disabled && setActive(index)}
      onClick={() => choose(option)}
    >
      <span>{option.label}</span>
      {option.discovered && <small className="model-new">新模型</small>}
      {option.discovered && <small className="model-price-unknown">价格未知</small>}
      {option.value === value && <Check size={13} />}
    </button>
  );
  const search = searchable && (
    <label className="chip-search">
      <Search size={13} aria-hidden="true" />
      <input
        ref={field}
        type="text"
        value={query}
        placeholder="搜索"
        aria-label="搜索"
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => filter(event.target.value)}
        onKeyDown={(event) => {
          // An input method still composing (pinyin, kana) owns Enter, the arrows and Escape.
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            move(event.key === 'ArrowDown' ? 1 : -1);
          } else if (event.key === 'Enter') {
            event.preventDefault();
            choose(shown[active] ? options[active] : undefined);
          } else if (event.key === 'Escape' && query) {
            // The first Escape clears the filter; the next one closes the menu.
            event.stopPropagation();
            filter('');
          }
        }}
      />
    </label>
  );
  const matchesIn = (id: string) => shown.filter((on, index) => on && options[index]!.group?.id === id).length;
  const listed = filtering ? groups.filter((group) => matchesIn(group.id) > 0) : groups;
  return (
    <div
      className={`chip-select ${open ? 'open' : ''} ${className}`}
      ref={root}
      title={current?.title ?? title}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          setOpen(false);
          root.current?.querySelector<HTMLButtonElement>('.chip-value')?.focus();
        }
      }}
    >
      <span>{label}</span>
      <button
        type="button"
        className="chip-value"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (!open) onOpen?.();
          setOpen(!open);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) {
              onOpen?.();
              setOpen(true);
            } else move(event.key === 'ArrowDown' ? 1 : -1);
          } else if ((event.key === 'Enter' || event.key === ' ') && open) {
            event.preventDefault();
            choose(options[active]);
          }
        }}
      >
        <span className="chip-current-label">{current?.label ?? ''}</span>
        {current?.discovered && <small className="model-new">新模型</small>}
        <ChevronDown size={12} />
      </button>
      <select
        aria-label={ariaLabel}
        disabled={disabled}
        className="chip-native"
        value={value}
        tabIndex={-1}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
      {open && (
        <div
          className={`chip-menu${searchable ? ' searchable' : ''}${upward ? ' upward' : ''}`}
          ref={menu}
          style={place}
          role="listbox"
          aria-label={ariaLabel}
        >
          {/* Always first in the markup, so it keeps focus; an upward menu shows it last, by the chip (CSS order). */}
          {search}
          {options.map((option, index) => (option.group || !shown[index] ? null : item(option, index)))}
          {listed.map((group) => {
            const expanded = filtering || openGroups.has(group.id);
            return (
              <div className="chip-group" role="group" aria-label={group.label} key={`group-${group.id}`}>
                <button
                  type="button"
                  className="chip-group-header"
                  aria-expanded={expanded}
                  title={group.title}
                  onClick={() => !filtering && toggleGroup(group.id)}
                >
                  <ChevronRight size={12} aria-hidden="true" />
                  <span>{group.label}</span>
                  <small>{filtering ? matchesIn(group.id) : group.count}</small>
                </button>
                {expanded &&
                  options.map((option, index) =>
                    option.group?.id === group.id && shown[index] ? item(option, index) : null,
                  )}
              </div>
            );
          })}
          {filtering && !shown.some(Boolean) && <p className="chip-empty">没有匹配的结果</p>}
        </div>
      )}
    </div>
  );
}
