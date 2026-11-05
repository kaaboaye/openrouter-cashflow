// App page (/apps/:slug or /apps/url/:encoded): estimated spend of the app on OpenRouter — a header
// stat, a spend card (daily chart by model) next to the usage chart, and spend per model in "Top models".

import { useEffect, useMemo, useState } from 'preact/hooks';
import { Priority } from '../core/api.ts';
import { loadModel, loadVariantDaily, refFor, resolvePermaslugs, resolveSlug } from '../core/data.ts';
import { formatRange, PERIOD_DAYS, PERIOD_SHORT, periodDays, previousPeriodDays, type Period } from '../core/days.ts';
import { change, money, pct, perM, tokens as fmtTokens } from '../core/format.ts';
import { computeRevenue } from '../core/model.ts';
import { shortModelName } from '../core/names.ts';
import { appSpend, loadAppUsage, type AppSpend } from '../core/services.ts';
import { Change, ESTIMATE_COLOR, foldSeries, OTHER_COLOR, Segmented, StackedColumns, StatTiles, Tip, TipRow } from '../ui/components.tsx';
import { Island, IslandSet, byText, hrefPath, type Controller } from '../ui/inject.ts';
import { PERIOD_OPTIONS, usePeriod } from '../ui/period.ts';
import { useStore } from '../ui/hooks.ts';

type Spend = { cur: AppSpend; prev: AppSpend | null; d30: AppSpend };

/** Loads the app's spend for every window once, shared by all islands on the page. */
class AppStore {
  data: Partial<Record<Period, Spend>> = {};
  error = false;
  private listeners = new Set<() => void>();
  constructor(readonly path: string) {
    for (const p of ['7d', '1d', '30d'] as Period[]) this.load(p);
  }
  private async load(p: Period) {
    try {
      const prio = p === '7d' ? Priority.visible : Priority.section;
      const d30 = await appSpend(this.path, '30d', prio);
      // a short window where nothing could be priced yet uses the app's 30-day rate (shown as estimated)
      const rate = d30.tokens ? d30.spend / d30.tokens : undefined;
      const [cur, prev] = await Promise.all([
        p === '30d' ? Promise.resolve(d30) : appSpend(this.path, p, prio, rate),
        p === '30d' ? Promise.resolve(null) : appSpend(this.path, previousPeriodDays(p), prio, rate).catch(() => null),
      ]);
      // names for every model the legends and tables can show, before the data is published (a render
      // that saw the data first would keep slug labels in its memoised series)
      await resolvePermaslugs([...new Set([...d30.byModel, ...cur.byModel].map((m) => m.permaslug))]);
      this.data[p] = { cur, prev, d30 };
    } catch {
      this.error = true;
    }
    this.listeners.forEach((f) => f());
  }
  subscribe(f: () => void) {
    this.listeners.add(f);
    return () => void this.listeners.delete(f);
  }
}


const nameOf = (permaslug: string, variant = 'standard') => {
  const r = refFor(permaslug, variant);
  return r?.name ?? shortModelName(permaslug);
};

function SpendCard({ store, appName }: { store: AppStore; appName: string }) {
  const s = useStore(store);
  const [period, setPeriod] = usePeriod();
  const d = s.data[period];
  const days = periodDays(period);

  const series = useMemo(() => {
    if (!d) return [];
    // Per-model daily spend from the app's daily usage, priced with each model's daily rate.
    const stable = d.d30.byModel.map((m) => m.permaslug + '|' + m.variant);
    const items = d.cur.byModel.map((m) => ({
      key: m.permaslug + '|' + m.variant,
      label: nameOf(m.permaslug, m.variant),
      values: days.map((day) => d.cur.dailyByModel[day]?.[m.permaslug + '|' + m.variant] ?? 0),
    }));
    const folded = foldSeries(items, 7, stable);
    // Tokens the usage chart lumps into "Others" belong in the gray bucket too.
    const others = days.map((day) => d.cur.dailyByModel[day]?.Others ?? 0);
    if (others.some((v) => v > 0)) {
      const o = folded.find((x) => x.key === '__other');
      if (o) o.values = o.values.map((v, i) => v + others[i]);
      else folded.push({ key: '__other', label: 'Other models', color: OTHER_COLOR, values: others });
    }
    // Days where none of the app's models could be priced are estimates, not spend on other models.
    const estimated = days.map((day) => d.cur.dailyByModel[day]?.Estimated ?? 0);
    if (estimated.some((v) => v > 0)) {
      folded.push({ key: '__estimated', label: 'Estimated (no model prices that day)', color: ESTIMATE_COLOR, values: estimated });
    }
    return folded;
  }, [d, period]);

  return (
    <div class="orcf" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div class="orcf-head" style={{ alignItems: 'center' }}>
        <div class="orcf-xs orcf-muted">
          {formatRange(days)}{d ? ` · ${fmtTokens(d.cur.tokens)} tokens` : ''}
        </div>
        <Segmented label="Time window" value={period} options={PERIOD_OPTIONS} onChange={setPeriod} />
      </div>
      {!d ? (
        s.error ? <div class="orcf-error" role="alert">Couldn't load this app's usage data from OpenRouter. Reload the page to try again.</div> : <span class="orcf-skel" style={{ width: '100%', height: '120px' }} />
      ) : (
        <>
          <StatTiles
            stats={[
              {
                label: `Spend · ${PERIOD_SHORT[period]}`,
                value: money(d.cur.spend),
                sub:
                  d.cur.fromFallbackRate
                    ? 'estimated at the 30-day rate'
                    : mostlyEstimated(d.cur)
                      ? `mostly estimated: ${pct(d.cur.pricedShare, 0)} priced per model`
                      : d.prev ? <><Change value={change(d.cur.spend, d.prev.spend)} /> vs previous {PERIOD_DAYS[period] === 1 ? 'day' : `${PERIOD_DAYS[period]} days`}</> : 'all models',
              },
              { label: 'Annualized', value: money((d.cur.spend / PERIOD_DAYS[period]) * 365), sub: `${money(d.cur.spend / PERIOD_DAYS[period])} per day` },
              { label: 'Avg $ / 1M tokens', value: perM(d.cur.tokens ? (d.cur.spend / d.cur.tokens) * 1e6 : 0), sub: `${pct(d.cur.pricedShare, 0)} of tokens priced per model` },
              { label: 'Top model', value: <span class="orcf-trunc" style={{ display: 'block', fontSize: '18px' }}>{d.cur.byModel[0] ? nameOf(d.cur.byModel[0].permaslug, d.cur.byModel[0].variant) : '—'}</span>, sub: d.cur.byModel[0] && d.cur.spend ? `${pct(d.cur.byModel[0].spend / d.cur.spend, 0)} of spend` : '' },
            ]}
          />
          {period !== '1d' && d.cur.spend > 0 && (
            <div>
              <div class="orcf-xs orcf-muted" style={{ marginBottom: '8px' }}>Daily spend by model</div>
              <StackedColumns days={days} series={series} label={`Daily ${appName} spend by model`} height={180} />
            </div>
          )}
          <p class="orcf-xs orcf-muted" style={{ margin: 0 }}>
            The app's daily tokens per model (OpenRouter's usage chart above) × each model's effective price that day (after
            caching and discounts, all providers). Assumes the app's caching mix matches the model's average, and that its split
            between a model and that model's free variant (which the chart doesn't separate) matches OpenRouter's that day. Includes
            bring-your-own-key traffic, which the app's users pay to the provider directly. Tokens in “Others”
            are priced at the app's average for the day, and days where none of its models could be priced at its average for
            the whole period.
            {d.cur.fromFallbackRate
              ? ' No day in this window could be priced from its models yet, so all of it is estimated at the app’s 30-day average rate.'
              : mostlyEstimated(d.cur)
                ? ` Only ${pct(d.cur.pricedShare, 0)} of this window’s tokens could be priced per model (the rest went to models with no price data or in “Others”), so the total is mostly an estimate.`
                : ''}
            {d.cur.splitUnknown > 0
              ? ' For some models OpenRouter’s free/paid split couldn’t be loaded; their tokens are counted as paid up to what the paid variant served in total, so the spend may be high.'
              : ''}
          </p>
        </>
      )}
    </div>
  );
}

/** Most of the window's tokens couldn't be priced from their own model (but some could). */
function mostlyEstimated(cur: { tokens: number; pricedShare: number; fromFallbackRate: boolean }) {
  return cur.tokens > 0 && !cur.fromFallbackRate && cur.pricedShare < 0.5;
}

function HeaderStat({ store, classes }: { store: AppStore; classes: { label: string; value: string } }) {
  const s = useStore(store);
  const [period] = usePeriod();
  const d = s.data[period];
  return (
    <>
      <div class={classes.label}>Spend · {PERIOD_SHORT[period]}</div>
      <div class={classes.value}>
        {d ? (
          <>
            {money(d.cur.spend)}
            <span
              style={{ marginLeft: '6px', fontSize: '12px', fontWeight: 400, color: 'hsl(var(--muted-foreground))' }}
              title={
                mostlyEstimated(d.cur) || d.cur.fromFallbackRate
                  ? `Only ${pct(d.cur.pricedShare, 0)} of these tokens could be priced per model; the rest is estimated at the app’s average rate.`
                  : d.cur.splitUnknown > 0
                    ? 'For some models OpenRouter’s free/paid split couldn’t be loaded; their tokens count as paid up to what the paid variant served, so this may be high.'
                    : undefined
              }
            >
              {mostlyEstimated(d.cur) || d.cur.fromFallbackRate
                ? 'estimate'
                : d.cur.splitUnknown > 0
                  ? 'may be high'
                  : `≈${money((d.cur.spend / PERIOD_DAYS[period]) * 365)}/yr`}
            </span>
          </>
        ) : s.error ? (
          <span style={{ color: 'hsl(var(--muted-foreground))' }} title="Couldn't load this app's usage data">—</span>
        ) : (
          <span class="orcf-skel" style={{ width: '64px' }} />
        )}
      </div>
    </>
  );
}

/** Spend for one row of "Top models used by X this month" (30 days). */
function ModelRowSpend({ store, slug, tokensText }: { store: AppStore; slug: string; tokensText: string }) {
  const s = useStore(store);
  const [rpt, setRpt] = useState<number | null>(null);
  const [ref, setRef] = useState<{ permaslug: string; variant: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const [kind, setKind] = useState<'free' | 'unknown' | 'unit' | null>(null);
  // the model's paid share of its own traffic over 30 days (its free variant is $0); null: couldn't be loaded
  const [paidShare, setPaidShare] = useState<number | null | undefined>(undefined);
  // the paid variant's own 30-day tokens across OpenRouter: an app can't have sent it more than that
  const [paidTotal, setPaidTotal] = useState<number>(Infinity);
  useEffect(() => {
    let live = true;
    setFailed(false);
    setKind(null);
    setPaidShare(undefined);
    resolveSlug(slug)
      .then(async (r) => {
        if (!r) throw new Error('unknown model');
        if (!live) return;
        setRef(r);
        const m = await loadModel(r.permaslug, r.variant, Priority.section);
        if (!live) return;
        setKind(m.base.free ? 'free' : m.base.nonToken ? 'unit' : m.base.priceUnknown ? 'unknown' : null);
        const rev = computeRevenue(m.base, m.pt, periodDays('30d'));
        setRpt(rev.tokens ? rev.revenue / rev.tokens : 0);
        if (r.variant !== 'standard' || m.base.free) return setPaidShare(1);
        const free = await loadVariantDaily(r.permaslug, 'free', Priority.section).catch(() => null);
        if (!live) return;
        const days = periodDays('30d');
        const paid = days.reduce((a, d) => a + (m.base.usage[d] ? m.base.usage[d].p + m.base.usage[d].c : 0), 0);
        const fr = free ? days.reduce((a, d) => a + (free[d] ?? 0), 0) : null;
        setPaidTotal(paid);
        setPaidShare(fr === null ? null : paid + fr > 0 ? paid / (paid + fr) : 1);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [slug]);
  const d30 = (s.data['30d'] ?? s.data['7d'] ?? s.data['1d'])?.d30;
  // until the app's own daily data is in (or has failed), any other figure would be a guess that then jumps
  const settled = !!d30 || s.error;
  const fromDaily = ref && d30?.byModel.find((m) => m.permaslug === ref.permaslug && m.variant === ref.variant);
  const tokens = parseTokens(tokensText);
  // Not in the app's daily chart (or that failed): the row's monthly tokens × the model's 30-day price, with the
  // share OpenRouter served on its free variant at $0 (if that split couldn't be loaded, all of it, may be high).
  const share = paidShare ?? 1;
  // split unknown: at most what the paid variant served in total (an upper bound, shown as "≤")
  const upperBound = !fromDaily && paidShare === null;
  const spend = fromDaily
    ? fromDaily.spend
    : settled && rpt !== null && tokens !== null && paidShare !== undefined
      ? (upperBound ? Math.min(tokens, paidTotal) : tokens * share) * rpt
      : null;
  if (kind === 'free') return <span class="orcf-inline is-free">free · $0</span>;
  if (kind === 'unit') return <span class="orcf-inline is-free" title="Billed per second, image or other unit; not estimated">not per token</span>;
  if (kind === 'unknown')
    return (
      <span
        class="orcf-inline is-free"
        title="OpenRouter has no price data for this model any more. Tokens that went to its free variant count as $0 in the app’s spend; the rest is counted at the app’s average rate."
      >
        price unknown
      </span>
    );
  if (spend === null && failed) return <span class="orcf-inline is-free" title="Couldn't load this model's usage data">—</span>;
  if (spend === null) return <span class="orcf-inline is-loading"><span class="orcf-skel" style={{ width: '40px' }} /></span>;
  return (
    <Tip
      class="orcf-inline"
      content={() => (
        <div>
          <div class="orcf-tip-title">Spend on this model · last 30 days</div>
          <TipRow label="Spend" value={money(spend, { precise: true })} />
          {fromDaily && <TipRow label="Tokens (daily chart)" value={fmtTokens(fromDaily.tokens)} />}
          {fromDaily && fromDaily.freeTokens > 0 && (
            <TipRow
              label={fromDaily.splitUnknown > 0 ? 'beyond the paid variant’s total' : 'of which free variant (est.)'}
              value={fmtTokens(fromDaily.freeTokens)}
            />
          )}
          {!fromDaily && tokens !== null && share < 1 && <TipRow label="of which free variant (est.)" value={fmtTokens(tokens * (1 - share))} />}
          {rpt !== null && <TipRow label="Model avg $/M" value={perM(rpt * 1e6)} />}
          <div class="orcf-tip-note">
            {!fromDaily
              ? `Monthly tokens × the model’s 30-day average price${share < 1 ? ', with the share OpenRouter served on its free variant at $0' : ''}.${paidShare === null ? ' Its free/paid split couldn’t be loaded, so this counts at most the paid variant’s own 30-day tokens as paid: an upper bound.' : ''}`
              : fromDaily.splitUnknown > 0
                ? 'Priced day by day from the app’s usage chart. OpenRouter’s free/paid split for this model couldn’t be loaded, so its tokens count as paid up to what the paid variant served in total; this may be high.'
                : `Priced day by day from the app’s usage chart.${fromDaily.freeTokens > 0 ? ' The chart doesn’t separate the model’s free variant, so its tokens are split by OpenRouter’s free/paid mix that day; free tokens cost $0.' : ''}`}
          </div>
        </div>
      )}
    >
      <i class="orcf-inline-dot" aria-hidden="true" />
      <span class="orcf-num">{upperBound || fromDaily?.splitUnknown ? '≤ ' : ''}{money(spend)}</span>
    </Tip>
  );
}

function parseTokens(t: string): number | null {
  const m = t.replace(/,/g, '').match(/([\d.]+)\s*([KMBT]?)/i);
  if (!m) return null;
  const mult: Record<string, number> = { '': 1, K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  return Number(m[1]) * (mult[m[2].toUpperCase()] ?? 1);
}

export class AppController implements Controller {
  private store: AppStore;
  private card: HTMLElement | null = null;
  private body = new Island({ className: 'orcf' });
  private stat = new Island({ className: 'orcf' });
  private rows = new IslandSet<Element>(() => new Island({ className: 'orcf orcf-row-extra' }));

  constructor(path: string) {
    this.store = new AppStore(path);
    loadAppUsage(path, Priority.visible).catch(() => {});
  }

  private appName() {
    return document.querySelector('h1')?.textContent?.trim() || 'This app';
  }

  tick() {
    this.ensureCard();
    this.ensureStat();
    this.ensureRows();
  }

  private ensureCard() {
    const usageTitle = byText('h2', /OpenRouter Usage$/);
    const usageCard = usageTitle?.closest('.rounded-lg');
    if (!usageCard || !usageTitle) return;
    if (!this.card) {
      const header = usageTitle.parentElement!;
      const card = document.createElement('div');
      card.className = usageCard.className;
      card.setAttribute('data-orcf-block', ''); // one of our blocks: see ui/anchor.ts
      card.setAttribute('data-orcf', '');
      const h = document.createElement('div');
      h.className = header.className;
      const h2 = document.createElement('h2');
      h2.className = usageTitle.className;
      h2.textContent = `${this.appName()} spend on OpenRouter`;
      const badge = document.createElement('span');
      badge.className = 'orcf orcf-badge';
      badge.textContent = 'Estimate';
      const left = document.createElement('div');
      left.style.cssText = 'display:flex;align-items:center;gap:8px';
      left.append(h2, badge);
      h.append(left);
      const bodyWrap = document.createElement('div');
      bodyWrap.style.cssText = 'padding:16px 20px 20px';
      bodyWrap.appendChild(this.body.el);
      card.append(h, bodyWrap);
      this.card = card;
      this.body.render(<SpendCard store={this.store} appName={this.appName()} />);
    }
    if (usageCard.nextElementSibling !== this.card) usageCard.after(this.card);
  }

  private statLabel: Element | null = null;

  private ensureStat() {
    if (!this.statLabel?.isConnected) {
      this.statLabel = [...document.querySelectorAll('main div.uppercase, main div')].find((e) => e.childElementCount === 0 && /^total tokens$/i.test(e.textContent?.trim() ?? '')) ?? null;
    }
    const lab = this.statLabel;
    const card = lab?.parentElement;
    const grid = card?.parentElement;
    if (!lab || !card || !grid) return;
    if (!this.stat.el.dataset.ready) {
      this.stat.el.dataset.ready = '1';
      this.stat.el.className = card.className + ' orcf';
      this.stat.render(<HeaderStat store={this.store} classes={{ label: lab.className, value: card.lastElementChild?.className ?? '' }} />);
    }
    this.stat.appendTo(grid);
    if (grid.children.length === 5 && !grid.classList.contains('orcf-grid5')) grid.classList.add('orcf-grid5');
  }

  private ensureRows() {
    const title = byText('h2', /^Top models used by/);
    const card = title?.closest('.rounded-lg');
    if (!card) return;
    for (const link of card.querySelectorAll('a[href]')) {
      const path = hrefPath(link);
      if (!path || path.split('/').filter(Boolean).length !== 2) continue;
      const row = link.closest('.justify-between');
      const right = row?.querySelector('.text-right');
      if (!row || !right || right.closest('[data-orcf]')) continue;
      const slug = path.replace(/^\//, '');
      const island = this.rows.get(row);
      island.inside(right);
      if (island.el.dataset.key !== slug) {
        island.el.dataset.key = slug;
        const tokensText = right.firstElementChild?.textContent ?? '';
        island.render(<ModelRowSpend store={this.store} slug={slug} tokensText={tokensText} />);
      }
    }
    this.rows.sweep();
  }

  dispose() {
    this.body.dispose();
    this.card?.remove();
    this.stat.dispose();
    this.rows.dispose();
    document.querySelector('.orcf-grid5')?.classList.remove('orcf-grid5');
  }
}

export function appPathFromPath(pathname: string): string | null {
  return /^\/apps\/(url\/[^/]+|[^/]+)\/?$/.test(pathname) ? pathname.replace(/\/$/, '') : null;
}
