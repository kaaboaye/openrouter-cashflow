// /rankings: a "Revenue Leaderboard" section next to the LLM Leaderboard, a nav entry for it, and
// revenue figures inside OpenRouter's own LLM Leaderboard and Top Apps rows.

import { useEffect, useMemo, useState } from 'preact/hooks';
import { useStickyState, useStore } from '../ui/hooks.ts';
import { api, Priority } from '../core/api.ts';
import { authorOf, refFor, resolvePermaslugs } from '../core/data.ts';
import { formatRange, PERIOD_DAYS, PERIOD_LABEL, PERIOD_SHORT, periodDays, previousPeriodDays, type Period } from '../core/days.ts';
import { change, money, pct, perM, tokens as fmtTokens } from '../core/format.ts';
import { aggregate, market, type AggRow, type Dimension, type Entry } from '../core/global.ts';
import { authorName, shortModelName } from '../core/names.ts';
import { appPathOf, appSpend } from '../core/services.ts';
import type { RankedApp } from '../core/types.ts';
import { AppBadge, ModelBadge } from '../ui/badges.tsx';
import {
  Change, foldSeries, gridCols, Progress, RevenueIcon, Segmented, ShareBar, StackedColumns, StatTiles, OTHER_COLOR, Tip, TipRow,
} from '../ui/components.tsx';
import { Island, IslandSet, hrefPath, rawPath, type Controller } from '../ui/inject.ts';
import { SectionNav } from '../ui/nav.ts';

type Dim = Dimension | 'app';

const DIMS: { value: Dim; label: string; one: string }[] = [
  { value: 'provider', label: 'Providers', one: 'Provider' },
  { value: 'company', label: 'Companies', one: 'Company' },
  { value: 'model', label: 'Models', one: 'Model' },
  { value: 'author', label: 'Authors', one: 'Author' },
  { value: 'app', label: 'Apps', one: 'App' },
];
const dimInfo = (d: Dim) => DIMS.find((x) => x.value === d)!;
const PERIODS: { value: Period; label: string }[] = [
  { value: '1d', label: 'Yesterday' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
];

const SECTION_ID = 'orcf-revenue';

function modelName(e: { permaslug: string; variant: string }) {
  const ref = refFor(e.permaslug, e.variant);
  const base = ref?.name ?? shortModelName(e.permaslug);
  return e.variant !== 'standard' && !base.toLowerCase().includes(e.variant) ? `${base} (${e.variant})` : base;
}
const entryName = (e: Entry) => modelName(e);

function useMarket() {
  useEffect(() => market.start(), []);
  return useStore(market);
}

// ---------- apps dimension ----------

interface AppRow extends AggRow {
  slug: string;
}

interface AppsState {
  rows: AppRow[] | null; // null until the first app is priced
  done: boolean;
  settled?: number; // apps finished (priced or failed)
  total?: number;
  failed: number;
  error: boolean;
  /** apps where a model's free/paid split couldn't be loaded (their spend is an upper bound) */
  splitUnknown?: number;
}

function useApps(enabled: boolean, period: Period): AppsState {
  const [state, setState] = useState<AppsState>({ rows: null, done: false, failed: 0, error: false });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setState({ rows: null, done: false, failed: 0, error: false });
    (async () => {
      const view = period === '1d' ? 'day' : period === '7d' ? 'week' : 'month';
      const data = await api<Record<string, RankedApp[]>>('rankings/apps', {}, { prio: Priority.visible });
      const apps = data[view] ?? [];
      const days = periodDays(period);
      const prev = period === '30d' ? null : previousPeriodDays(period);
      const out: AppRow[] = [];
      let failed = 0, splitUnknown = 0;
      const publish = (final: boolean) => {
        if (!live) return;
        const rows = [...out].sort((x, y) => y.revenue - x.revenue);
        setState({
          rows: rows.length || final ? rows : null, done: final, failed, splitUnknown, settled: out.length + failed, total: apps.length,
          error: final && apps.length > 0 && rows.length === 0,
        });
      };
      await Promise.all(
        apps.map(async (a) => {
          try {
            const path = appPathOf(a.app);
            const cur = await appSpend(path, days, Priority.section);
            // a comparison that can't be priced only loses the change %, never the app's current spend
            const before = prev ? await appSpend(path, prev, Priority.section).catch(() => null) : null;
            if (cur.splitUnknown > 0) splitUnknown++;
            const daily = days.map((d) => cur.daily.find((x) => x.day === d)?.spend ?? 0);
            const top = cur.byModel[0];
            out.push({
              key: path, slug: path, name: a.app.title, revenue: cur.spend, byok: 0, tokens: cur.tokens,
              prevRevenue: before ? before.spend : null, daily, count: cur.byModel.length,
              top: top ? { key: `${top.permaslug}|${top.variant}`, name: modelName(top), revenue: top.spend } : undefined,
            });
          } catch {
            failed++;
          }
          publish(false);
        }),
      );
      await resolvePermaslugs(out.map((r) => r.top?.key.split('|')[0]).filter(Boolean) as string[]).catch(() => {});
      publish(true);
    })().catch(() => live && setState({ rows: [], done: true, failed: 0, error: true }));
    return () => {
      live = false;
    };
  }, [enabled, period]);
  return state;
}

// ---------- section ----------

function linkFor(dim: Dim, row: AggRow): string | null {
  switch (dim) {
    case 'provider': return `/provider/${row.key}`;
    case 'author': return row.key ? `/${row.key}` : null;
    case 'app': return row.key;
    default: return null;
  }
}

/** A row's top model or provider by its display name (a resolved catalog name beats the slug fallback). */
function topName(row: AggRow, names: Record<string, string>): string {
  if (!row.top) return '';
  const ref = row.top.key.includes('|') ? refFor(row.top.key.split('|')[0], row.top.key.split('|')[1]) : undefined;
  return ref?.name ?? names[row.top.key] ?? row.top.name;
}

function subtitle(dim: Dim, row: AggRow, names: Record<string, string>): string {
  const top = topName(row, names);
  switch (dim) {
    case 'provider':
      return `${row.count} model${row.count === 1 ? '' : 's'}${top ? ` · top: ${top}` : ''}`;
    case 'company':
      return (row.members?.length ?? 0) > 1
        ? (row.members ?? []).map((s) => names['p:' + s] ?? s).join(' + ')
        : `${row.count} model${row.count === 1 ? '' : 's'}${top ? ` · top: ${top}` : ''}`;
    case 'model':
      return `${authorName(authorOf(row.permaslug ?? row.key.split('|')[0], row.variant)) || 'Unknown author'}${row.top ? ` · top host: ${row.top.name}` : ''}`;
    case 'author':
      return `${row.count} paid model${row.count === 1 ? '' : 's'}${top ? ` · top: ${top}` : ''}`;
    case 'app':
      return top ? `top model: ${top}` : '';
  }
}

export function RevenueSection() {
  const m = useMarket();
  // kept for the tab, so Back from one of our rows (or a reload) shows the same table and rows
  const [dim, setDim] = useStickyState<Dim>('dim', 'provider', (v): v is Dim => DIMS.some((d) => d.value === v));
  const [period, setPeriod] = useStickyState<Period>('period', '7d', (v): v is Period => PERIODS.some((o) => o.value === v));
  const [limit, setLimit] = useStickyState<number>('limit', 10, (v): v is number => typeof v === 'number' && v >= 10);
  const [namesTick, setNamesTick] = useState(0);
  const p = m.progress;
  const apps = useApps(dim === 'app', period);

  const agg = useMemo(
    () => (dim === 'app' ? null : aggregate(dim, period, entryName)),
    [dim, period, p.loaded, p.done, p.catalogRev, namesTick],
  );
  // Colors follow the entity: owners are decided by the 30-day ranking, so switching periods never repaints a row.
  const stableOrder = useMemo(() => {
    const ranked = dim === 'app' ? apps.rows ?? [] : aggregate(dim, '30d', entryName).rows;
    return ranked.map((r) => r.key);
  }, [dim, p.done, Math.floor(p.loaded / 25), p.catalogRev, apps.rows?.length]);

  const rows: AggRow[] = dim === 'app' ? apps.rows ?? [] : agg?.rows ?? [];
  const total = dim === 'app' ? rows.reduce((s, r) => s + r.revenue, 0) : agg?.total ?? 0;
  const prevTotal = dim === 'app' ? null : agg?.prevTotal ?? null;
  const error = dim === 'app' ? apps.error : !!p.error;

  // Resolve display names for what's on screen.
  const nameMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const e of m.entries) if (e.data) for (const [slug, n] of Object.entries(e.data.base.providerNames)) map['p:' + slug] = n;
    for (const e of m.entries) map[e.key] = entryName(e);
    return map;
  }, [p.loaded, namesTick]);
  useEffect(() => {
    const want = new Set<string>();
    for (const r of rows.slice(0, limit)) {
      if (dim === 'model' && r.permaslug) want.add(r.permaslug);
      if (r.top && r.top.key.includes('|')) want.add(r.top.key.split('|')[0]);
    }
    const missing = [...want].filter((ps) => !refFor(ps, 'standard'));
    if (missing.length) resolvePermaslugs(missing, Priority.visible).then(() => setNamesTick((x) => x + 1));
  }, [dim, rows.length, limit, p.done]);

  const loading = !error && (dim === 'app' ? !apps.done : !p.done);
  const days = periodDays(period);
  const chartSeries = useMemo(() => {
    if (rows.length === 0) return null;
    const items = rows.map((r) => ({ key: r.key, label: dim === 'model' ? nameMap[r.key] ?? r.name : r.name, values: r.daily }));
    return foldSeries(items, 7, stableOrder);
  }, [rows, period, stableOrder, nameMap]);
  const colorOf = useMemo(() => new Map((chartSeries ?? []).filter((s) => s.key !== '__other').map((s) => [s.key, s.color])), [chartSeries]);

  const runRate = (total / PERIOD_DAYS[period]) * 365;
  // the market's tokens, the same in every grouping (rows that earned nothing are hidden but still count)
  const totalTokens = dim === 'app' ? rows.reduce((s, r) => s + r.tokens, 0) : agg?.totalTokens ?? 0;
  const byok = dim === 'app' ? null : agg?.totalByok ?? 0;
  const dimOne = dimInfo(dim).one.toLowerCase();

  return (
    <>
      <div class="orcf-head">
        <div class="orcf-head-text">
          <div class="orcf-title">
            <RevenueIcon />
            <a class="orcf-link" href={`#${SECTION_ID}`}>
              <h2 class="orcf-h2">Revenue Leaderboard</h2>
            </a>
            <span class="orcf-badge">Estimate</span>
          </div>
          <p class="orcf-desc">
            Who earns what on OpenRouter. Tokens each provider served × the effective price paid after prompt caching and
            discounts, incl. BYOK traffic.
          </p>
        </div>
        <div class="orcf-controls">
          <Segmented label="Group revenue by" value={dim} options={DIMS.map(({ value, label }) => ({ value, label }))} onChange={(v) => { if (v !== dim) { setDim(v); setLimit(10); } }} />
          <Segmented label="Time window" value={period} options={PERIODS} onChange={setPeriod} />
        </div>
      </div>

      {error && (
        <div class="orcf-card orcf-error" role="alert">
          Couldn't load OpenRouter's usage data{dim === 'app' ? ' for apps' : ''}. Reload the page to try again.
        </div>
      )}

      {!error && dim !== 'app' && (
        <StatTiles
          stats={[
            {
              label: `Revenue · ${PERIOD_SHORT[period]}`,
              value: total || !loading ? money(total) : <span class="orcf-skel" style={{ width: '90px', height: '22px' }} />,
              sub: !p.done
                ? 'still loading, will grow…'
                : p.failedSpend >= 0.01
                  ? <span class="orcf-neg">⚠ {pct(p.failedSpend, 0)} of spend couldn't be loaded</span>
                  : prevTotal !== null
                  ? <><Change value={change(total, prevTotal)} /> vs previous {PERIOD_DAYS[period] === 1 ? 'day' : `${PERIOD_DAYS[period]} days`}</>
                  : 'all models on OpenRouter',
            },
            { label: 'Annualized run-rate', value: total ? money(runRate) : '—', sub: total ? `${money(total / PERIOD_DAYS[period])} per day` : '' },
            { label: 'Paid via BYOK', value: byok ? money(byok) : '—', sub: byok && total ? `${pct(byok / total, 0)} billed by providers directly` : 'customers using their own keys' },
            {
              label: 'Avg $ / 1M tokens',
              value: total && totalTokens ? perM((total / totalTokens) * 1e6) : '—',
              sub: `${totalTokens ? `${fmtTokens(totalTokens)}\u00a0tokens · ` : ''}${formatRange(days)}`,
            },
          ]}
        />
      )}

      {loading && (
        <Progress
          ratio={dim === 'app' ? (apps.total ? (apps.settled ?? 0) / apps.total : 0.03) : p.total ? Math.max(p.coveredSpend, p.loaded / p.total) : 0.02}
          label={
            dim === 'app'
              ? `Pricing app traffic model by model… ${apps.settled ?? 0} / ${apps.total ?? 20} apps`
              : p.total
                ? `Loading models ${p.loaded} / ${p.total} · ${pct(p.coveredSpend, 1)} of spend covered`
                : 'Loading rankings…'
          }
        />
      )}

      {!error && <div class="orcf-card">
        {period !== '1d' && chartSeries && chartSeries.length > 0 && (
          <div style={{ marginBottom: '20px' }}>
            <div class="orcf-xs orcf-muted" style={{ marginBottom: '8px' }}>
              Daily {dim === 'app' ? 'spend' : 'revenue'} by {dimOne}
            </div>
            <StackedColumns days={days} series={chartSeries} label={`Daily ${dim === 'app' ? 'spend' : 'revenue'} by ${dimOne}`} height={200} />
          </div>
        )}
        <RankTable dim={dim} rows={rows} total={total} limit={limit} colorOf={colorOf} names={nameMap} period={period} />
        {rows.length > limit && (
          <button class="orcf-more" onClick={() => setLimit(limit < 25 ? 25 : limit < 50 ? 50 : 1000)}>
            Show more
          </button>
        )}
        {!loading && rows.length === 0 && <div class="orcf-empty">No revenue data for this window.</div>}
      </div>}
      {!error && (
        <p class="orcf-xs orcf-muted" style={{ margin: 0 }}>
          {dim === 'app'
            ? `Top 20 apps by tokens (OpenRouter rankings), ranked by estimated spend: each day’s tokens per model × that model’s effective price.${apps.failed ? ` ${apps.failed} app${apps.failed === 1 ? '' : 's'} couldn't be loaded and ${apps.failed === 1 ? 'is' : 'are'} left out.` : ''}${apps.splitUnknown ? ` For ${apps.splitUnknown} app${apps.splitUnknown === 1 ? '' : 's'}, a model's free/paid traffic split couldn't be loaded, so ${apps.splitUnknown === 1 ? 'its' : 'their'} spend may be high.` : ''}`
            : !p.done
              ? 'Loading OpenRouter’s paid models; totals grow until every model is in.'
              : `Based on ${p.loaded - p.failed} paid model variants covering ${pct(p.coveredSpend, 1)} of OpenRouter’s official spend share${p.failed ? `; ${p.failed} couldn't be loaded (${pct(p.failedSpend, 1)} of spend) and are left out, so totals are low by about that much` : ''}. Validated against that share: most models within ±15%.`}
        </p>
      )}
    </>
  );
}

function RankTable({
  dim, rows, total, limit, colorOf, names, period,
}: {
  dim: Dim; rows: AggRow[]; total: number; limit: number; colorOf: Map<string, string>; names: Record<string, string>; period: Period;
}) {
  const showChange = period !== '30d';
  const cols = gridCols([
    { w: '28px' }, { w: 'minmax(0,1fr)' }, { w: '96px' }, { w: 'minmax(64px,120px)', sm: false },
    { w: '72px', when: showChange }, { w: '64px', sm: false, md: false, when: dim !== 'app' },
  ]);
  return (
    <div class="orcf-table" role="table" aria-label={`${dim === 'app' ? 'Spend' : 'Revenue'} by ${dimInfo(dim).one.toLowerCase()}`}>
      <div class="orcf-tr is-head" role="row" style={cols}>
        <span>#</span>
        <span>{dimInfo(dim).one}</span>
        <span class="r">{dim === 'app' ? 'Spend' : 'Revenue'}</span>
        <span class="r orcf-hide-sm">Share</span>
        {showChange && <span class="r">Change</span>}
        {dim !== 'app' && <span class="r orcf-hide-sm orcf-hide-md">BYOK</span>}
      </div>
      {rows.slice(0, limit).map((r, i) => {
        const href = dim === 'model' ? null : linkFor(dim, r);
        const swatch = colorOf.get(r.key) ?? OTHER_COLOR;
        const name = dim === 'model' ? names[r.key] ?? r.name : r.name;
        return (
          <div class="orcf-tr" role="row" style={cols}>
            <span class="orcf-rank orcf-num">{i + 1}.</span>
            <div class="orcf-name">
              <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
                {period !== '1d' && <i class="orcf-swatch" style={{ background: swatch }} aria-hidden="true" />}
                {href ? <a href={href} title={name}>{name}</a> : dim === 'model' ? <ModelLink row={r} name={name} /> : <span class="orcf-primary" title={name}>{name}</span>}
              </div>
              <span class="orcf-sub" title={subtitle(dim, r, names)}>{subtitle(dim, r, names)}</span>
            </div>
            <span class="r">
              <Tip
                class="orcf-strong orcf-num"
                content={() => (
                  <div>
                    <div class="orcf-tip-title">{name} · {PERIOD_LABEL[period]}</div>
                    <TipRow label={dim === 'app' ? 'Spend' : 'Revenue'} value={money(r.revenue, { precise: true })} />
                    {dim !== 'app' && <TipRow label="of which BYOK" value={money(r.byok)} />}
                    <TipRow label="Annualized" value={`${money((r.revenue / PERIOD_DAYS[period]) * 365)}/yr`} />
                    <TipRow label="Tokens" value={fmtTokens(r.tokens)} />
                    <TipRow label="Avg $/M tokens" value={`$${((r.revenue / Math.max(1, r.tokens)) * 1e6).toFixed(3)}`} />
                    {r.top && <TipRow label="Top contributor" value={topName(r, names)} />}
                  </div>
                )}
              >
                {money(r.revenue)}
              </Tip>
            </span>
            <span class="r orcf-hide-sm">
              <span class="orcf-share">
                <span class="orcf-muted orcf-num orcf-xs">{pct(total ? r.revenue / total : 0)}</span>
                <ShareBar share={rows[0]?.revenue ? r.revenue / rows[0].revenue : 0} />
              </span>
            </span>
            {showChange && (
              <span class="r orcf-xs">
                <Change value={r.prevRevenue !== null ? change(r.revenue, r.prevRevenue) : null} />
              </span>
            )}
            {dim !== 'app' && <span class="r orcf-muted orcf-num orcf-xs orcf-hide-sm orcf-hide-md">{r.revenue ? pct(r.byok / r.revenue, 0) : '—'}</span>}
          </div>
        );
      })}
      {rows.length === 0 &&
        Array.from({ length: 5 }, () => (
          <div class="orcf-tr" style={cols}>
            <span class="orcf-skel" style={{ width: '14px' }} />
            <span class="orcf-skel" style={{ width: '40%' }} />
            <span class="r"><span class="orcf-skel" style={{ width: '56px' }} /></span>
          </div>
        ))}
    </div>
  );
}

function ModelLink({ row, name }: { row: AggRow; name: string }) {
  const ref = row.permaslug ? refFor(row.permaslug, row.variant ?? 'standard') : undefined;
  if (!ref) return <span class="orcf-primary" title={name}>{name}</span>;
  return <a href={`/${ref.slug}`} title={name}>{name}</a>;
}

// ---------- controller ----------

const WINDOW_VALUES: Record<string, Period> = { day: '1d', today: '1d', week: '7d', trending: '7d', month: '30d' };

/**
 * The time window an OpenRouter section is set to. Its dropdowns keep their value in a hidden input
 * next to the trigger; other dropdowns (e.g. "All models") have hidden inputs too, so match by value.
 */
function periodFromSelect(root: Element | null): Period {
  const trigger = root?.querySelector('button[aria-label="Filter by time window"]');
  const own = trigger?.nextElementSibling;
  if (own instanceof HTMLInputElement && WINDOW_VALUES[own.value]) return WINDOW_VALUES[own.value];
  for (const input of root?.querySelectorAll<HTMLInputElement>('input[aria-hidden="true"]') ?? []) {
    if (WINDOW_VALUES[input.value]) return WINDOW_VALUES[input.value];
  }
  return '7d';
}

export class RankingsController implements Controller {
  private section = new Island({ className: 'orcf orcf-section', id: SECTION_ID });
  private nav = new SectionNav({ sectionId: SECTION_ID, afterHref: ['#leaderboard-table'], menuAfter: ['Leaderboard'], label: 'Revenue' });
  private modelBadges = new IslandSet<Element>(() => new Island({ className: 'orcf orcf-row-extra' }));
  private appBadges = new IslandSet<Element>(() => new Island({ className: 'orcf orcf-row-extra' }));
  private rendered = false;

  constructor() {
    this.section.el.setAttribute('data-orcf-block', ''); // one of our blocks: see ui/anchor.ts
    this.section.el.style.scrollMarginTop = 'calc(var(--navbar-height, 64px) + 112px)';
    market.start();
  }

  tick() {
    if (location.pathname !== '/rankings') return;
    const lb = document.getElementById('leaderboard-table');
    if (lb) {
      this.matchScrollMargin(lb);
      this.section.after(lb);
      if (!this.rendered) {
        this.section.render(<RevenueSection />);
        this.rendered = true;
      }
    }
    this.nav.tick();
    this.ensureModelBadges(lb);
    this.ensureAppBadges();
  }

  /** Land where OpenRouter's own sections land: reuse their responsive scroll-margin classes. */
  private matchScrollMargin(lb: Element) {
    const el = this.section.el;
    if (el.dataset.orcfMargin) return;
    const cls = [...lb.classList].filter((c) => /(^|:)scroll-mt-/.test(c));
    if (!cls.length) return;
    el.classList.add(...cls);
    el.style.scrollMarginTop = '';
    el.dataset.orcfMargin = '1';
  }

  private ensureModelBadges(lb: Element | null) {
    if (!lb) return;
    const period = periodFromSelect(lb);
    for (const row of lb.querySelectorAll('[data-testid="model-rankings-leaderboard-row"]')) {
      const link = row.querySelector('a[href]');
      const path = hrefPath(link);
      if (!path) continue;
      const slug = path.replace(/^\//, '');
      const cell = row.lastElementChild;
      const tokensLine = cell?.querySelector(':scope > div > div:first-child') ?? cell?.firstElementChild;
      if (!tokensLine) continue;
      const island = this.modelBadges.get(row);
      island.after(tokensLine);
      const key = `${slug}@${period}`;
      if (island.el.dataset.key !== key) {
        island.el.dataset.key = key;
        island.render(<ModelBadge slug={slug} period={period} compact />);
      }
    }
    this.modelBadges.sweep();
  }

  private ensureAppBadges() {
    const apps = document.getElementById('apps');
    if (!apps) return;
    const period = periodFromSelect(apps);
    for (const link of apps.querySelectorAll('a[href^="/apps/"]')) {
      const path = rawPath(link);
      if (!path || link.closest('[data-orcf]')) continue;
      const row = link.closest('.grid');
      const tokensLine = row?.lastElementChild?.firstElementChild;
      if (!row || !tokensLine) continue;
      const island = this.appBadges.get(row);
      island.inside(tokensLine);
      const key = `${path}@${period}`;
      if (island.el.dataset.key !== key) {
        island.el.dataset.key = key;
        island.render(<AppBadge path={path} period={period} />);
      }
    }
    this.appBadges.sweep();
  }

  dispose() {
    this.section.dispose();
    this.nav.dispose();
    this.modelBadges.dispose();
    this.appBadges.dispose();
  }
}

