import { render, type ComponentChildren, type VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { formatDay } from '../core/days.ts';
import { money } from '../core/format.ts';

// ---------- icons ----------

export const RevenueIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" />
    <path d="M12 18V6" />
  </svg>
);

const Arrow = ({ up }: { up: boolean }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style={{ verticalAlign: '-1px', marginRight: '2px' }}>
    {up ? <path d="M7 17 17 7M7 7h10v10" /> : <path d="M7 7l10 10M17 7v10H7" />}
  </svg>
);

export function Change({ value }: { value: number | null }) {
  if (value === null || !Number.isFinite(value)) return <span class="orcf-faint">—</span>;
  const up = value >= 0;
  const p = Math.abs(value * 100);
  const txt = p >= 999 ? '>999%' : p >= 10 ? `${p.toFixed(0)}%` : `${p.toFixed(1)}%`;
  return (
    <span class={`orcf-nowrap ${up ? 'orcf-pos' : 'orcf-neg'}`} aria-label={`${up ? 'up' : 'down'} ${txt}`}>
      <Arrow up={up} />
      {txt}
    </span>
  );
}

// ---------- tooltip (one floating element for the whole page) ----------

let tipEl: HTMLDivElement | null = null;
/**
 * Tooltips are fixed-position, so they must follow the page when it scrolls:
 *  - one opened by the pointer just hides (the next pointer move re-opens it where the pointer is);
 *  - one opened by keyboard focus moves with its element, and hides once that element leaves the screen.
 */
let anchored: { el: Element; place: 'beside' | 'below' } | null = null;
let scrollHooked = false;

function onPageScroll() {
  if (!tipEl || tipEl.style.display === 'none') return;
  if (!anchored || !anchored.el.isConnected) return hideTip();
  const r = anchored.el.getBoundingClientRect();
  if (r.bottom < 0 || r.top > window.innerHeight) return hideTip();
  // hidden behind something (OpenRouter's sticky header…): the card shouldn't float over other rows
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (!hit || !(hit === anchored.el || anchored.el.contains(hit))) return hideTip();
  position(r, anchored.place);
}

function tipNode() {
  if (!scrollHooked) {
    window.addEventListener('scroll', onPageScroll, { passive: true, capture: true });
    scrollHooked = true;
  }
  if (!tipEl || !tipEl.isConnected) {
    tipEl = document.createElement('div');
    tipEl.className = 'orcf orcf-tip';
    tipEl.setAttribute('role', 'tooltip');
    tipEl.style.display = 'none';
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

/** Pointer tooltips follow the pointer. */
export function showTip(content: VNode, x: number, y: number) {
  anchored = null;
  const el = tipNode();
  render(content, el);
  el.style.display = 'block';
  const r = measure(el);
  const pad = 12;
  let left = x + 14, top = y + 14;
  if (left + r.width + pad > r.right) left = x - r.width - 14;
  if (top + r.height + pad > window.innerHeight) top = y - r.height - 14;
  el.style.left = `${Math.max(pad, left)}px`;
  el.style.top = `${Math.max(pad, top)}px`;
}

/**
 * The card's natural size (measured at the viewport's corner: near the right edge it would wrap narrower and
 * taller than it ends up) and the right edge it can actually reach (pinned with right: 0 — narrower than
 * innerWidth when the page reserves a scrollbar gutter).
 */
function measure(el: HTMLElement) {
  el.style.right = '';
  el.style.left = '0px';
  el.style.top = '0px';
  const r = el.getBoundingClientRect();
  el.style.left = 'auto';
  el.style.right = '0px';
  const right = el.getBoundingClientRect().right;
  el.style.right = '';
  el.style.left = '0px';
  return { width: r.width, height: r.height, right };
}

function position(anchor: DOMRect, place: 'beside' | 'below') {
  const el = tipEl!;
  const r = measure(el);
  const pad = 12, gap = 10;
  let left = 0, top = 0;
  if (place === 'beside') {
    // right of the element, else left of it: never on top of what it describes
    left = anchor.right + gap;
    if (left + r.width + pad > r.right) left = anchor.left - r.width - gap;
    // no room on either side (a phone): go below or above it instead
    if (left < pad) place = 'below';
    else top = anchor.top;
  }
  if (place === 'below') {
    left = Math.min(anchor.left, r.right - r.width - pad);
    top = anchor.bottom + 6;
    if (top + r.height + pad > window.innerHeight) top = anchor.top - r.height - 6;
  }
  if (top + r.height + pad > window.innerHeight) top = window.innerHeight - r.height - pad;
  el.style.left = `${Math.max(pad, left)}px`;
  el.style.top = `${Math.max(pad, top)}px`;
}

/** Keyboard-focus tooltips are anchored to their element (beside it, or below it). */
export function showTipAt(content: VNode, anchor: Element, place: 'beside' | 'below') {
  anchored = { el: anchor, place };
  const el = tipNode();
  render(content, el);
  el.style.display = 'block';
  position(anchor.getBoundingClientRect(), place);
}

export function hideTip() {
  anchored = null;
  if (tipEl) tipEl.style.display = 'none';
}

export function Tip({ content, children, class: cls }: { content: () => VNode | null; children: ComponentChildren; class?: string }) {
  const show = (x: number, y: number) => {
    const c = content();
    if (c) showTip(c, x, y);
  };
  return (
    <span
      class={cls}
      tabIndex={0}
      onPointerEnter={(e) => show(e.clientX, e.clientY)}
      onPointerMove={(e) => show(e.clientX, e.clientY)}
      onPointerLeave={hideTip}
      onFocus={(e) => {
        const c = content();
        if (c) showTipAt(c, e.currentTarget as HTMLElement, 'below');
      }}
      onBlur={hideTip}
    >
      {children}
    </span>
  );
}

export function TipRow({ label, value, color }: { label: ComponentChildren; value: ComponentChildren; color?: string }) {
  return (
    <div class="orcf-tip-row">
      <span>
        {color && <i class="orcf-tip-key" style={{ background: color }} />}
        {label}
      </span>
      <b>{value}</b>
    </div>
  );
}

// ---------- controls ----------

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  // A radio group is one Tab stop; arrow keys move (and select), like native radios.
  const onKeyDown = (e: KeyboardEvent) => {
    const i = options.findIndex((o) => o.value === value);
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    let next = -1;
    if (step) next = (i + step + options.length) % options.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = options.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onChange(options[next].value);
    const group = e.currentTarget as HTMLElement;
    requestAnimationFrame(() => (group.querySelectorAll('button')[next] as HTMLButtonElement | undefined)?.focus());
  };
  return (
    <div class="orcf-seg" role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      {options.map((o) => (
        <button type="button" role="radio" aria-checked={o.value === value} tabIndex={o.value === value ? 0 : -1} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Progress({ ratio, label }: { ratio: number; label: ComponentChildren }) {
  return (
    <div class="orcf-progress" aria-live="polite">
      <div class="orcf-progress-track">
        <div class="orcf-progress-fill" style={{ width: `${Math.max(2, Math.min(100, ratio * 100))}%` }} />
      </div>
      <span>{label}</span>
    </div>
  );
}

export function ShareBar({ share }: { share: number }) {
  return (
    <span class="orcf-share-bar" aria-hidden="true">
      <i style={{ width: `${Math.max(0, Math.min(100, share * 100))}%` }} />
    </span>
  );
}

export interface Stat {
  label: string;
  value: ComponentChildren;
  sub?: ComponentChildren;
}

export function StatTiles({ stats }: { stats: Stat[] }) {
  return (
    <div class="orcf-stats">
      {stats.map((s) => (
        <div class="orcf-stat">
          <div class="orcf-stat-label">{s.label}</div>
          <div class="orcf-stat-value">{s.value}</div>
          {s.sub !== undefined && <div class="orcf-stat-sub">{s.sub}</div>}
        </div>
      ))}
    </div>
  );
}

// ---------- stacked column chart ----------

export const SERIES_COLORS = [1, 2, 3, 4, 5, 6, 7].map((i) => `var(--orcf-s${i})`);
export const OTHER_COLOR = 'var(--orcf-other)';
/** estimated (not measured) amounts: a lighter neutral than "Other" */
export const ESTIMATE_COLOR = 'var(--orcf-estimate)';

export interface Series {
  key: string;
  label: string;
  color: string;
  values: number[];
}

function niceMax(v: number): { max: number; step: number } {
  if (v <= 0) return { max: 1, step: 0.25 };
  const raw = v / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  return { max: Math.ceil(v / step) * step, step };
}

function useWidth<T extends HTMLElement>(): [preact.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Rect with only the top corners rounded (data-end), square at the baseline. */
function topRounded(x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export function StackedColumns({
  days,
  series,
  height = 220,
  label,
}: {
  days: string[];
  series: Series[];
  height?: number;
  label: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  // keyboard: the chart is one Tab stop (the latest day); arrow keys move between days
  const [focusIdx, setFocusIdx] = useState(days.length - 1);
  const [focused, setFocused] = useState(false);
  // a new time window starts keyboard focus on its latest day again
  useEffect(() => setFocusIdx(days.length - 1), [days.length, days[days.length - 1]]);
  const n = days.length;
  const totals = days.map((_, i) => series.reduce((s, x) => s + (x.values[i] || 0), 0));
  const { max, step } = niceMax(Math.max(...totals, 0));
  const axisW = 52;
  const bottom = 24;
  const plotW = Math.max(0, width - axisW);
  const plotH = height - bottom - 8;
  const slot = n ? plotW / n : 0;
  const barW = Math.max(2, Math.min(24, slot - Math.max(2, slot * 0.35)));
  const y = (v: number) => 8 + plotH - (v / max) * plotH;
  const ticks: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) ticks.push(v);
  // "Oct 27" needs ~48px; thin the date labels out when they would collide
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 56))));

  const tip = (i: number) => (
    <div>
      <div class="orcf-tip-title">{formatDay(days[i], { weekday: 'short', month: 'short', day: 'numeric' })}</div>
      <TipRow label="Total" value={money(totals[i], { precise: true })} />
      <div class="orcf-tip-sep" />
      {[...series]
        .reverse()
        .filter((s) => (s.values[i] || 0) > 0)
        .map((s) => (
          <TipRow label={s.label} value={money(s.values[i], { precise: true })} color={s.color} />
        ))}
    </div>
  );

  return (
    <div class="orcf-chart" ref={ref}>
      {width > 0 && (
        <svg
          height={height}
          role="group"
          aria-label={label}
          onPointerLeave={() => { setActive(null); if (!focused) hideTip(); }}
          onKeyDown={(e) => {
            const next =
              e.key === 'ArrowRight' ? Math.min(n - 1, focusIdx + 1)
              : e.key === 'ArrowLeft' ? Math.max(0, focusIdx - 1)
              : e.key === 'Home' ? 0
              : e.key === 'End' ? n - 1
              : -1;
            if (next < 0) return;
            e.preventDefault();
            setFocusIdx(next);
            ((e.currentTarget as SVGSVGElement).querySelectorAll('g.col')[next] as SVGGElement | undefined)?.focus();
          }}
        >
          {ticks.map((t) => (
            <g>
              <line class="grid" x1={axisW} x2={width} y1={Math.round(y(t)) + 0.5} y2={Math.round(y(t)) + 0.5} />
              <text class="tick" x={axisW - 8} y={y(t) + 4} text-anchor="end">
                {money(t)}
              </text>
            </g>
          ))}
          {days.map((d, i) => {
            const cx = axisW + slot * i + slot / 2;
            const x = cx - barW / 2;
            let acc = 0;
            const visible = series.filter((s) => (s.values[i] || 0) > 0);
            const segs = visible.map((s, j) => {
              const v = s.values[i] || 0;
              const y0 = y(acc), y1 = y(acc + v);
              acc += v;
              const gap = j > 0 ? 2 : 0; // 2px surface gap between stacked segments
              const h = Math.max(0, y0 - y1 - gap);
              if (h <= 0) return null;
              const top = j === visible.length - 1;
              return top ? (
                <path class="seg" d={topRounded(x, y1, barW, h, 4)} fill={s.color} />
              ) : (
                <rect class="seg" x={x} y={y1} width={barW} height={h} fill={s.color} />
              );
            });
            return (
              <g
                class={`col ${active === i ? 'is-active' : ''}`}
                role="img"
                // SVG needs the lowercase attribute: Preact would set a literal "tabIndex" attribute that SVG ignores
                {...{ tabindex: i === Math.min(focusIdx, n - 1) ? 0 : -1 }}
                aria-label={`${formatDay(d)}: ${money(totals[i])}${series
                  .filter((x) => x.key !== '__other' && (x.values[i] || 0) > 0)
                  .sort((a, b) => (b.values[i] || 0) - (a.values[i] || 0))
                  .slice(0, 3)
                  .map((x) => `, ${x.label} ${money(x.values[i])}`)
                  .join('')}`}
                onPointerMove={(e) => { setActive(i); showTip(tip(i), e.clientX, e.clientY); }}
                onFocus={(e) => {
                  setActive(i);
                  setFocused(true);
                  setFocusIdx(i);
                  showTipAt(tip(i), e.currentTarget as SVGGElement, 'beside');
                }}
                onBlur={() => { setActive(null); setFocused(false); hideTip(); }}
              >
                <rect class="hit" x={axisW + slot * i} y={0} width={slot} height={height - bottom} />
                {focused && i === focusIdx && (
                  <rect class="focus-ring" x={axisW + slot * i + 1} y={1} width={Math.max(0, slot - 2)} height={height - bottom - 2} rx={4} />
                )}
                {segs}
                {i % labelEvery === 0 && (
                  <text class="tick" x={cx} y={height - 6} text-anchor="middle">
                    {formatDay(d)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      {series.length > 1 && (
        <div class="orcf-legend">
          {series.map((s) => (
            <span>
              <i style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Keep the first `k` series by total and fold the rest into "Other" (never more than 8 hues).
 * Colors follow the entity: `stableOrder` (e.g. the 30-day ranking) decides who owns which hue, so
 * switching the time window never repaints a series; newcomers take the first free hue.
 */
export function foldSeries(items: { key: string; label: string; values: number[] }[], k = 7, stableOrder: string[] = []): Series[] {
  const sorted = [...items].sort((a, b) => sum(b.values) - sum(a.values));
  const head = sorted.slice(0, k);
  const tail = sorted.slice(k);
  const colors = assignColors(head.map((h) => h.key), stableOrder);
  const out: Series[] = head.map((s) => ({ ...s, color: colors.get(s.key)! }));
  if (tail.length) {
    const len = items[0]?.values.length ?? 0;
    out.push({
      key: '__other',
      label: `Other (${tail.length})`,
      color: OTHER_COLOR,
      values: Array.from({ length: len }, (_, i) => tail.reduce((s, x) => s + (x.values[i] || 0), 0)),
    });
  }
  return out;
}

export function assignColors(keys: string[], stableOrder: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<number>();
  for (const key of keys) {
    const idx = stableOrder.indexOf(key);
    if (idx >= 0 && idx < SERIES_COLORS.length && !used.has(idx)) {
      out.set(key, SERIES_COLORS[idx]);
      used.add(idx);
    }
  }
  for (const key of keys) {
    if (out.has(key)) continue;
    const free = SERIES_COLORS.findIndex((_, i) => !used.has(i));
    out.set(key, free >= 0 ? SERIES_COLORS[free] : OTHER_COLOR);
    if (free >= 0) used.add(free);
  }
  return out;
}

const sum = (a: number[]) => a.reduce((s, x) => s + (x || 0), 0);

/**
 * Grid template for table rows. Columns flagged `md: false` are hidden when the table itself is narrow
 * (container query, cells carry .orcf-hide-md); `sm: false` ones are also hidden on phones (.orcf-hide-sm).
 * Each case gets its own template so hidden columns don't leave empty tracks behind.
 */
export function gridCols(cols: { w: string; sm?: boolean; md?: boolean; when?: boolean }[]): Record<string, string> {
  const live = cols.filter((c) => c.when !== false);
  const md = live.filter((c) => c.md !== false);
  return {
    '--cols': live.map((c) => c.w).join(' '),
    '--cols-md': md.map((c) => c.w).join(' '),
    // on phones fixed number columns would squeeze the name column, so they size to their content
    '--cols-sm': md
      .filter((c) => c.sm !== false)
      .map((c) => (c.w.includes('fr') ? c.w : /^\d+px$/.test(c.w) && parseInt(c.w) <= 32 ? c.w : 'auto'))
      .join(' '),
  };
}
