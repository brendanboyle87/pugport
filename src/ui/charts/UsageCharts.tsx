import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { currentLocale, translateInterfaceText as tr, withNames } from '../i18n';

export const executorColors = ['#287ab8', '#c77b18', '#26958b', '#b86292', '#786ac2', '#8c8037', '#79838e'];
export type Series = { id: string; label: string; color: string; dashed?: boolean; values: (number | null)[] };
export const number = (v: number | null | undefined, digits = 1) =>
  v == null ? '—' : v.toLocaleString(currentLocale(), { maximumFractionDigits: digits });
export const money = (v: number | null | undefined) => (v == null ? '—' : `$${number(v, 2)}`);
export const percent = (v: number | null | undefined) => (v == null ? '—' : `${number(v)}%`);
export const seconds = (v: number | null | undefined) => (v == null ? '—' : `${number(v / 1000)} s`);

/** Smallest "nice" axis maximum (a whole number of 1/2/2.5/5 × 10^k steps) that covers the data. */
export function niceAxis(
  data: number,
  intervalOptions: number[],
  options: { integer?: boolean; cap?: number } = {},
): { max: number; intervals: number } {
  const { integer = false, cap } = options;
  if (!(data > 0)) return { max: cap ? cap / 10 : 1, intervals: intervalOptions.at(-1) ?? 2 };
  let best: { max: number; intervals: number } | undefined;
  for (const intervals of intervalOptions) {
    const exponent = Math.floor(Math.log10(data / intervals));
    for (const power of [exponent, exponent + 1]) {
      for (const base of [1, 2, 2.5, 5]) {
        const step = base * 10 ** power;
        if (integer && !Number.isInteger(step)) continue;
        const max = step * intervals;
        if (max >= data * (1 - 1e-9) && (!best || max < best.max - 1e-12)) best = { max, intervals };
      }
    }
  }
  best ??= { max: Math.ceil(data), intervals: 1 };
  return cap && best.max > cap ? { max: cap, intervals: cap === 1 ? 4 : best.intervals } : best;
}

/** Muted note naming how much data is missing; undefined when nothing is. Template uses {0} missing and {1} total. */
export function gapNote(template: string, missing: number, total: number) {
  return missing > 0 && total > 0 ? withNames(template, [number(missing, 0), number(total, 0)]) : undefined;
}

export function Sparkline({ values, color = 'var(--accent-text)' }: { values: (number | null)[]; color?: string }) {
  const max = Math.max(1, ...values.map((v) => v ?? 0));
  const segments: string[][] = [];
  values.forEach((value, index) => {
    if (value === null) return;
    if (index === 0 || values[index - 1] === null) segments.push([]);
    segments.at(-1)!.push(`${(index * 100) / Math.max(1, values.length - 1)},${22 - (value / max) * 20}`);
  });
  return (
    <svg className="insight-sparkline" viewBox="0 0 100 24" aria-hidden="true">
      {segments.map((points, index) => (
        <polyline
          key={index}
          points={points.join(' ')}
          fill="none"
          stroke={color}
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

export function ChartCard({
  title,
  description,
  gap,
  empty,
  children,
  action,
  id,
}: {
  title: string;
  description: string;
  /** Already translated note describing missing data; omit when coverage is complete. */
  gap?: string;
  empty?: boolean;
  children: ReactNode;
  action?: ReactNode;
  id: string;
}) {
  return (
    <section className="insight-chart" aria-labelledby={`${id}-title`}>
      <header>
        <div>
          <h2 id={`${id}-title`}>{title}</h2>
          <p>{description}</p>
        </div>
        {action}
      </header>
      {gap && !empty && <p className="insight-partial">{gap}</p>}
      {empty ? <div className="insight-empty">此时间范围内没有运行记录</div> : children}
    </section>
  );
}

export function TimeChart({
  labels,
  series,
  mode = 'line',
  format = number,
  onSelect,
  overlay,
  height = 170,
  cap,
  legendGroups,
}: {
  labels: string[];
  series: Series[];
  mode?: 'line' | 'bar' | 'area';
  format?: (v: number | null) => string;
  onSelect?: (index: number, seriesId: string) => void;
  overlay?: (number | null)[];
  height?: number;
  /** Hard ceiling for the axis, e.g. 1 for ratios so percentages never exceed 100 %. */
  cap?: number;
  /** Legend sections in display order; series not listed are shown ungrouped first. */
  legendGroups?: { label: string; ids: string[] }[];
}) {
  const id = useId().replace(/:/g, '');
  const [active, setActive] = useState<{ index: number; seriesId?: string }>();
  const plot = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(760);
  useEffect(() => {
    if (!plot.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(250, entry.contentRect.width)));
    observer.observe(plot.current);
    return () => observer.disconnect();
  }, []);
  const left = 58,
    right = 14,
    top = 15,
    bottom = 28;
  const innerW = width - left - right,
    innerH = height - top - bottom;
  const totals = labels.map((_, i) => {
    const known = series.map((s) => s.values[i]).filter((value) => value != null);
    return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
  });
  const dataValues = [
    ...(mode === 'line' ? series.flatMap((s) => s.values.map((v) => v ?? 0)) : totals.map((v) => v ?? 0)),
    ...(overlay?.map((v) => v ?? 0) ?? []),
  ];
  const { max, intervals } = niceAxis(Math.max(0, ...dataValues), innerH >= 110 ? [4, 2] : [2], {
    integer: dataValues.every(Number.isInteger),
    cap,
  });
  const x = (i: number) => left + ((i + 0.5) * innerW) / Math.max(1, labels.length);
  const y = (v: number) => top + innerH - (v / max) * innerH;
  const tip = (i: number) =>
    [
      labels[i],
      ...series.map((s) => `${tr(s.label)}: ${format(s.values[i] ?? null)}`),
      ...(mode === 'bar' ? [`${tr('合计')}: ${format(totals[i])}`] : []),
      ...(overlay ? [`${tr('累计')}: ${format(overlay[i] ?? null)}`] : []),
    ].join(' · ');
  const events = (i: number, seriesId?: string) => ({
    tabIndex: 0,
    role: onSelect ? 'button' : 'img',
    'aria-label': tip(i),
    onFocus: () => setActive({ index: i, seriesId }),
    onMouseEnter: () => setActive({ index: i, seriesId }),
    onBlur: () => setActive(undefined),
    onMouseLeave: () => setActive(undefined),
    onClick: () => seriesId && onSelect?.(i, seriesId),
    onKeyDown: (event: React.KeyboardEvent) => {
      if ((event.key === 'Enter' || event.key === ' ') && seriesId && onSelect) {
        event.preventDefault();
        onSelect(i, seriesId);
      }
      if (event.key === 'Escape') setActive(undefined);
    },
  });
  return (
    <div className="insight-plot" ref={plot}>
      <div className="insight-legend">
        {legendGroups
          ? legendGroups.map((group) => (
              <div className="insight-legend-group" key={group.label} role="group" aria-label={group.label}>
                <strong>{group.label}</strong>
                {series
                  .filter((s) => group.ids.includes(s.id))
                  .map((s) => (
                    <span key={s.id}>
                      <i style={{ background: s.color }} />
                      {s.label}
                    </span>
                  ))}
              </div>
            ))
          : series.map((s) => (
              <span key={s.id}>
                <i style={{ background: s.color, borderStyle: s.dashed ? 'dashed' : 'solid' }} />
                {s.label}
              </span>
            ))}
        {overlay && (
          <span>
            <i className="cumulative-key" />
            累计
          </span>
        )}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="insight-svg" aria-label={tr('时间趋势')}>
        <defs>
          {series
            .filter((s) => s.dashed)
            .map((s, i) => (
              <pattern key={s.id} id={`${id}-${i}`} width="5" height="5" patternUnits="userSpaceOnUse">
                <rect width="5" height="5" fill={s.color} />
                <path d="M0 5L5 0" stroke="var(--surface-1)" strokeOpacity=".5" />
              </pattern>
            ))}
        </defs>
        {Array.from({ length: intervals + 1 }, (_, n) => n / intervals).map((t) => (
          <g key={t}>
            <line x1={left} x2={width - right} y1={y(max * t)} y2={y(max * t)} className="chart-grid" />
            <text x={left - 8} y={y(max * t) + 4} textAnchor="end">
              {format(max * t)}
            </text>
          </g>
        ))}
        {series.map((s, si) => {
          const base = (i: number) => series.slice(0, si).reduce((sum, previous) => sum + (previous.values[i] ?? 0), 0);
          const fill = s.dashed ? `url(#${id}-${series.filter((v) => v.dashed).indexOf(s)})` : s.color;
          if (mode === 'bar')
            return (
              <g key={s.id}>
                {s.values.map(
                  (v, i) =>
                    v != null &&
                    v > 0 && (
                      <rect
                        key={i}
                        x={x(i) - (innerW / labels.length) * 0.34}
                        width={Math.max(1, (innerW / labels.length) * 0.68)}
                        y={y(base(i) + v)}
                        height={(v / max) * innerH}
                        fill={fill}
                        {...events(i, s.id)}
                      >
                        <title>{tip(i)}</title>
                      </rect>
                    ),
                )}
              </g>
            );
          const segments: number[][] = [];
          s.values.forEach((value, i) => {
            if (value == null) return;
            if (i === 0 || s.values[i - 1] == null) segments.push([]);
            segments.at(-1)!.push(i);
          });
          return (
            <g key={s.id}>
              {mode === 'area'
                ? segments.map((indices, index) => (
                    <polygon
                      key={index}
                      points={`${indices.map((i) => `${x(i)},${y(s.values[i]! + base(i))}`).join(' ')} ${[...indices]
                        .reverse()
                        .map((i) => `${x(i)},${y(base(i))}`)
                        .join(' ')}`}
                      fill={fill}
                      fillOpacity=".75"
                    />
                  ))
                : s.values.map(
                    (v, i) =>
                      v != null &&
                      i > 0 &&
                      s.values[i - 1] != null && (
                        <line
                          key={i}
                          x1={x(i - 1)}
                          x2={x(i)}
                          y1={y(s.values[i - 1]!)}
                          y2={y(v)}
                          stroke={s.color}
                          strokeWidth="2"
                          strokeDasharray={s.dashed ? '5 4' : undefined}
                        />
                      ),
                  )}
              {s.values.map(
                (v, i) =>
                  v != null && (
                    <circle
                      key={i}
                      cx={x(i)}
                      cy={y(v + (mode === 'area' ? base(i) : 0))}
                      r={labels.length > 80 ? 2 : 3}
                      fill={s.color}
                      {...events(i, s.id)}
                    >
                      <title>{tip(i)}</title>
                    </circle>
                  ),
              )}
            </g>
          );
        })}
        {overlay?.map(
          (value, i) =>
            value != null && (
              <g key={i}>
                {i > 0 && overlay[i - 1] != null && (
                  <line
                    x1={x(i - 1)}
                    y1={y(overlay[i - 1]!)}
                    x2={x(i)}
                    y2={y(value)}
                    stroke="var(--text)"
                    strokeWidth="2"
                    strokeDasharray="3 3"
                  />
                )}
                <circle cx={x(i)} cy={y(value)} r="3" fill="var(--text)" {...events(i)}>
                  <title>{tip(i)}</title>
                </circle>
              </g>
            ),
        )}
        {[...new Set([0, Math.floor((labels.length - 1) / 2), labels.length - 1])]
          .filter((i) => i >= 0)
          .map((i) => (
            <text
              key={i}
              x={x(i)}
              y={height - 5}
              textAnchor={i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle'}
            >
              {labels[i]}
            </text>
          ))}
      </svg>
      <div className="insight-tooltip" role="status" aria-live="polite">
        {active ? tip(active.index) : <span>悬停或聚焦数据点查看详情</span>}
      </div>
      <table className="sr-only">
        <caption>图表数据</caption>
        <thead>
          <tr>
            <th>时间</th>
            {series.map((s) => (
              <th key={s.id}>{s.label}</th>
            ))}
            {overlay && <th>累计</th>}
          </tr>
        </thead>
        <tbody>
          {labels.map((label, i) => (
            <tr key={i}>
              <th>{label}</th>
              {series.map((s) => (
                <td key={s.id}>{format(s.values[i] ?? null)}</td>
              ))}
              {overlay && <td>{format(overlay[i] ?? null)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export type RangeRow = {
  id: string;
  label: string;
  color: string;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  n: number;
  dashed?: boolean;
};
export function RangePlot({ rows }: { rows: RangeRow[] }) {
  const [active, setActive] = useState<string>();
  const max = Math.max(1, ...rows.map((r) => r.p95 ?? 0));
  const tip = (row: RangeRow) =>
    `${row.label} · p50 ${seconds(row.p50)} · p95 ${seconds(row.p95)} · p99 ${seconds(row.p99)} · n = ${row.n}`;
  return (
    <div className="range-plot">
      <div className="insight-legend">
        <span>● p50</span>
        <span>━ p95</span>
        <span>n = 样本数</span>
      </div>
      {rows.map((row) => (
        <div
          className="range-row"
          key={row.id}
          tabIndex={0}
          role="img"
          aria-label={tip(row)}
          title={tip(row)}
          onFocus={() => setActive(row.id)}
          onBlur={() => setActive(undefined)}
          onMouseEnter={() => setActive(row.id)}
          onMouseLeave={() => setActive(undefined)}
        >
          <span className="range-name" translate="no">
            {row.label}
          </span>
          <svg viewBox="0 0 400 22" preserveAspectRatio="none" aria-hidden="true">
            <line x1="2" x2="398" y1="11" y2="11" className="chart-grid" />
            {row.p50 != null && row.p95 != null && (
              <>
                <line
                  x1={2 + (row.p50 / max) * 390}
                  x2={2 + (row.p95 / max) * 390}
                  y1="11"
                  y2="11"
                  stroke={row.color}
                  strokeWidth="4"
                  strokeDasharray={row.dashed ? '4 3' : undefined}
                />
                <circle cx={2 + (row.p50 / max) * 390} cy="11" r="5" fill={row.color} />
                <path d={`M${2 + (row.p95 / max) * 390} 5v12`} stroke={row.color} strokeWidth="2" />
              </>
            )}
          </svg>
          <span className="range-values">
            {seconds(row.p50)} / {seconds(row.p95)}
          </span>
          <small>n = {row.n}</small>
        </div>
      ))}
      <div className="insight-tooltip" role="status">
        {active ? tip(rows.find((r) => r.id === active)!) : <span>悬停或聚焦数据点查看详情</span>}
      </div>
      <table className="sr-only">
        <caption>运行时间分位数</caption>
        <thead>
          <tr>
            <th>执行器 / 模型</th>
            <th>p50</th>
            <th>p95</th>
            <th>p99</th>
            <th>n</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <th>{row.label}</th>
              <td>{seconds(row.p50)}</td>
              <td>{seconds(row.p95)}</td>
              <td>{seconds(row.p99)}</td>
              <td>{row.n}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
