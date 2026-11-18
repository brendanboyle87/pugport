import { currentLocale, translateInterfaceText, withNames } from './i18n';
import { Check, CircleDashed, Compass, Puzzle, Sparkles, X } from 'lucide-react';
import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { effortName, orderedEfforts } from '../shared/effort';
import type { RouteDecision, RuntimeSnapshot } from '../shared/types';
import { workModeCopy, workModeIds, type WorkMode } from '../shared/work-modes';

const modeIcons = { normal: CircleDashed, 'mods-author': Puzzle, navigator: Compass } as const;
const modeLocked = '这一轮运行中不能切换模式；改动本来也从下一条消息开始生效';

/** The composer's mode chip: a quiet icon in Normal, a tag with × back to Normal otherwise. */
export function ModeChip({
  mode,
  open,
  disabled,
  onToggle,
  onClear,
  detail,
}: {
  mode?: WorkMode;
  open: boolean;
  disabled?: boolean;
  onToggle: () => void;
  onClear: () => void;
  /** Navigator: the saved route, e.g. "Opus 5.5 · High". */
  detail?: ReactNode;
}) {
  const Icon = modeIcons[mode ?? 'normal'];
  const label = workModeCopy[mode ?? 'normal'].label;
  const title = disabled ? translateInterfaceText(modeLocked) : withNames('模式：{0}', [translateInterfaceText(label)]);
  const trigger = {
    type: 'button' as const,
    title,
    'aria-haspopup': 'menu' as const,
    'aria-expanded': open,
    'data-names': true,
    disabled,
    onMouseDown: (event: { stopPropagation(): void }) => event.stopPropagation(),
    onClick: onToggle,
  };
  if (!mode)
    return (
      <button {...trigger} className={`composer-mode${open ? ' open' : ''}`} aria-label={title}>
        <Icon size={15} />
      </button>
    );
  return (
    <span className={`composer-tag composer-mode-tag${open ? ' open' : ''}`}>
      <button {...trigger} className="composer-mode-open">
        <Icon size={12} />
        {label}
        {detail && <span className="composer-mode-detail">· {detail}</span>}
      </button>
      <button type="button" aria-label="改回普通模式" title="改回普通模式" disabled={disabled} onClick={onClear}>
        <X size={11} />
      </button>
    </span>
  );
}

/** Three rows, one line each; the choice is saved on this chat and applies from the next message. */
export function ModeMenu({
  mode,
  menuRef,
  onPick,
  route,
  onChooseRoute,
  folder,
  onChangeFolder,
}: {
  mode?: WorkMode;
  menuRef?: RefObject<HTMLDivElement | null>;
  onPick: (mode: WorkMode | null) => void;
  /** Navigator's one setting: what the saved route is called ("自动" when none). */
  route?: ReactNode;
  onChooseRoute?: () => void;
  /** Mods author's one setting: where its folder is ("PugPort 数据 › mods-workspace" by default). */
  folder?: ReactNode;
  onChangeFolder?: () => void;
}) {
  return (
    <div className="composer-menu composer-mode-menu" role="menu" aria-label="模式" ref={menuRef}>
      <p className="composer-menu-hint">只对这个对话生效，从下一条消息开始</p>
      {(['normal', ...workModeIds] as const).map((id) => {
        const Icon = modeIcons[id];
        const checked = (mode ?? 'normal') === id;
        // The chosen mode's one setting sits directly under its own row.
        const setting =
          checked && id === 'mods-author' && onChangeFolder ? (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="composer-mode-setting"
              onClick={onChangeFolder}
            >
              <span>
                文件夹：<span className="composer-mode-route">{folder ?? 'PugPort 数据 › mods-workspace'}</span>
                <span className="composer-mode-choose"> · 更改…</span>
              </span>
            </button>
          ) : checked && id === 'navigator' && onChooseRoute ? (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="composer-mode-setting"
              onClick={onChooseRoute}
            >
              <span>
                领航员使用：<span className="composer-mode-route">{route ?? '自动'}</span>
                <span className="composer-mode-choose"> · 选择…</span>
              </span>
            </button>
          ) : null;
        return (
          <Fragment key={id}>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={checked}
              tabIndex={-1}
              onClick={() => onPick(id === 'normal' ? null : id)}
            >
              <Icon size={15} />
              <span>{workModeCopy[id].label}</span>
              <small>{workModeCopy[id].description}</small>
              {checked && <Check size={14} className="composer-menu-check" />}
            </button>
            {setting}
          </Fragment>
        );
      })}
    </div>
  );
}

export function composerEfforts(runtime: RuntimeSnapshot | undefined, model: string, proposal?: RouteDecision) {
  if (!runtime) return { levels: [], title: undefined };
  const selected = model
    ? runtime.models.find((item) => item.id === model)
    : (runtime.models.find((item) => item.id === (proposal?.runtimeId === runtime.id ? proposal.model : undefined)) ??
      runtime.models.find((item) => item.id === runtime.defaultModel) ??
      (runtime.models.length === 1 ? runtime.models[0] : undefined));
  return {
    levels: orderedEfforts(selected?.efforts ?? (model ? [] : runtime.models.flatMap((item) => item.efforts))),
    title: !model && !selected ? '模型由路由选择，将使用所选模型支持的最近强度' : undefined,
  };
}

/**
 * Reasoning effort as a stepped slider (automatic, then the model's levels). The strongest level is
 * tinted purple with a quiet shimmer and a small sparkle, without changing the chip's size.
 */
export function EffortSlider({
  levels,
  value,
  onChange,
  disabled,
  title,
}: {
  levels: string[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  title?: string;
}) {
  const stops = ['', ...orderedEfforts(levels)];
  const index = Math.max(0, stops.indexOf(value));
  const top = index > 0 && index === stops.length - 1;
  const label = stops[index] ? effortName(stops[index]) : '自动';
  const fill = stops.length > 1 ? index / (stops.length - 1) : 0;
  return (
    <label
      className={`effort-slider ${top ? 'effort-top' : ''}`}
      style={{ '--fill': fill } as CSSProperties}
      title={title}
    >
      <span>思考</span>
      <span className="effort-track">
        <input
          type="range"
          min={0}
          max={stops.length - 1}
          step={1}
          value={index}
          disabled={disabled}
          aria-label="思考强度"
          aria-valuetext={label}
          onChange={(event) => onChange(stops[Number(event.target.value)] ?? '')}
        />
      </span>
      <strong>
        {top && <Sparkles size={12} aria-hidden="true" />}
        {label}
      </strong>
    </label>
  );
}

const rowHeight = 28;

/**
 * A scroll wheel like the iPhone timer: drag, scroll or use the arrow keys; double-click to type a number.
 */
export function WheelPicker({
  value,
  max,
  unit,
  onChange,
}: {
  value: number;
  max: number;
  unit: string;
  onChange: (value: number) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; top: number } | undefined>(undefined);
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const clamp = (number: number) => Math.min(max, Math.max(0, Math.round(number)));
  useEffect(() => {
    const element = list.current;
    if (element && !drag.current && Math.round(element.scrollTop / rowHeight) !== value)
      element.scrollTop = value * rowHeight;
  }, [value]);
  useEffect(() => () => clearTimeout(settle.current), []);
  const commitScroll = () => {
    const element = list.current;
    if (!element) return;
    const next = clamp(element.scrollTop / rowHeight);
    element.scrollTo({ top: next * rowHeight, behavior: 'smooth' });
    if (next !== value) onChange(next);
  };
  const commitText = () => {
    const parsed = Number(text);
    if (text.trim() !== '' && Number.isFinite(parsed)) onChange(clamp(parsed));
    setEditing(false);
  };
  return (
    <div className="wheel">
      <div
        ref={list}
        className="wheel-list"
        role="spinbutton"
        tabIndex={0}
        aria-label={unit}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        title="拖动或滚动选择，双击输入数字"
        onScroll={() => {
          clearTimeout(settle.current);
          if (!drag.current) settle.current = setTimeout(commitScroll, 90);
        }}
        onPointerDown={(event) => {
          drag.current = { y: event.clientY, top: event.currentTarget.scrollTop };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (drag.current) event.currentTarget.scrollTop = drag.current.top - (event.clientY - drag.current.y);
        }}
        onPointerUp={() => {
          drag.current = undefined;
          commitScroll();
        }}
        onPointerCancel={() => {
          drag.current = undefined;
          commitScroll();
        }}
        onDoubleClick={() => {
          setText(String(value));
          setEditing(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            onChange(clamp(value + (event.key === 'ArrowDown' ? 1 : -1)));
          } else if (event.key === 'Enter') {
            setText(String(value));
            setEditing(true);
          }
        }}
      >
        <div className="wheel-pad" />
        {Array.from({ length: max + 1 }, (_, number) => (
          <div key={number} className={`wheel-item ${number === value ? 'current' : ''}`}>
            {String(number).padStart(2, '0')}
          </div>
        ))}
        <div className="wheel-pad" />
      </div>
      {editing && (
        <input
          className="wheel-input"
          type="number"
          min={0}
          max={max}
          autoFocus
          value={text}
          aria-label={`输入${unit}`}
          onChange={(event) => setText(event.target.value)}
          onBlur={commitText}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitText();
            if (event.key === 'Escape') setEditing(false);
          }}
        />
      )}
      <span className="wheel-unit">{unit}</span>
    </div>
  );
}

type Span = { days: number; hours: number; minutes: number };
const zero: Span = { days: 0, hours: 0, minutes: 0 };
const spanMs = (span: Span) => ((span.days * 24 + span.hours) * 60 + span.minutes) * 60_000;

/** `datetime-local` text for a moment, in this device's time zone. */
export function localInputAt(time: number): string {
  const date = new Date(time);
  const two = (number: number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** The remaining time until a saved `datetime-local` value, rounded up to whole minutes. */
export function spanUntil(local: string, now: number): Span {
  const target = Date.parse(local);
  if (!local || !Number.isFinite(target) || target <= now) return zero;
  const minutes = Math.ceil((target - now) / 60_000);
  return {
    days: Math.min(30, Math.floor(minutes / 1440)),
    hours: Math.floor(minutes / 60) % 24,
    minutes: minutes % 60,
  };
}

/**
 * Scheduling as durations from now: "start after" and "finish within", set with timer wheels.
 * Values are stored as the same `datetime-local` strings the queue already understands.
 */
export function SchedulePanel({
  notBefore,
  deadline,
  priority,
  preferExpiringQuota,
  onNotBefore,
  onDeadline,
  onPriority,
  onPreferExpiringQuota,
}: {
  notBefore: string;
  deadline: string;
  priority: 'normal' | 'high';
  preferExpiringQuota: boolean;
  onNotBefore: (value: string) => void;
  onDeadline: (value: string) => void;
  onPriority: (value: 'normal' | 'high') => void;
  onPreferExpiringQuota: (value: boolean) => void;
}) {
  const [tab, setTab] = useState<'start' | 'deadline'>(notBefore || !deadline ? 'start' : 'deadline');
  const [now] = useState(() => Date.now());
  const current = tab === 'start' ? notBefore : deadline;
  const set = tab === 'start' ? onNotBefore : onDeadline;
  const span = spanUntil(current, now);
  const update = (patch: Partial<Span>) => {
    const next = { ...span, ...patch };
    set(spanMs(next) ? localInputAt(Date.now() + spanMs(next)) : '');
  };
  const at = Date.parse(current);
  const date = new Date(at).toLocaleString(currentLocale(), {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return (
    <div className="schedule-panel">
      <div className="schedule-tabs" role="tablist">
        {(
          [
            ['start', '延后开始', notBefore],
            ['deadline', '完成期限', deadline],
          ] as const
        ).map(([key, label, value]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? 'selected' : ''}
            onClick={() => setTab(key)}
          >
            {label}
            {value && <i aria-hidden="true" />}
          </button>
        ))}
      </div>
      <div className="schedule-wheels">
        <WheelPicker value={span.days} max={30} unit="天" onChange={(days) => update({ days })} />
        <WheelPicker value={span.hours} max={23} unit="时" onChange={(hours) => update({ hours })} />
        <WheelPicker value={span.minutes} max={59} unit="分" onChange={(minutes) => update({ minutes })} />
      </div>
      <p className="schedule-result">
        {current && Number.isFinite(at)
          ? tab === 'start'
            ? `最早 ${date} 开始`
            : `最晚 ${date} 完成（尽量，不保证）`
          : tab === 'start'
            ? '不延后：资源可用时立即开始'
            : '不设期限'}
        {current && (
          <button type="button" className="schedule-clear" onClick={() => set('')}>
            清除
          </button>
        )}
      </p>
      <div className="schedule-options">
        <button
          type="button"
          className={`chip-more ${priority === 'high' ? 'active' : ''}`}
          aria-pressed={priority === 'high'}
          onClick={() => onPriority(priority === 'high' ? 'normal' : 'high')}
        >
          高优先级
        </button>
        <label className="chip-check">
          <input
            type="checkbox"
            checked={preferExpiringQuota}
            onChange={(event) => onPreferExpiringQuota(event.target.checked)}
          />
          优先用快重置的额度
        </label>
      </div>
    </div>
  );
}
