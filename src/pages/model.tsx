// Model page (/author/model[:variant]): a Revenue section after Pricing (per-provider breakdown + daily
// chart), a "Revenue" stat card in the header grid, a nav entry, and spend figures on the Apps list.

import { useMemo, useState } from 'preact/hooks';
import { api, Priority } from '../core/api.ts';
import { loadModel, resolveSlug, type ModelData, type ModelRef } from '../core/data.ts';
import { formatRange, PERIOD_DAYS, PERIOD_SHORT, periodDays, previousPeriodDays, type Period } from '../core/days.ts';
import { change, money, pct, perM, tokens as fmtTokens } from '../core/format.ts';
import { blendedPrice, computeRevenue } from '../core/model.ts';
import type { TopAppsForModel } from '../core/types.ts';
import { appPathOf } from '../core/services.ts';
import {
  Change, foldSeries, gridCols, hideTip, OTHER_COLOR, Segmented, ShareBar, StackedColumns, StatTiles, Tip, TipRow,
} from '../ui/components.tsx';
import { Island, IslandSet, rawPath, type Controller } from '../ui/inject.ts';
import { SectionNav } from '../ui/nav.ts';
import { PERIOD_OPTIONS, usePeriod } from '../ui/period.ts';
import { useStore } from '../ui/hooks.ts';

const SECTION_ID = 'orcf-model-revenue';

// undefined = loading, null = not a model we know, 'error' = OpenRouter's stats couldn't be loaded
type Loaded = { ref: ModelRef; data: ModelData } | null | undefined | 'error';

/** Shared loader so the section, the header card and the app badges use one fetch. */
class ModelStore {
  value: Loaded = undefined;
  private listeners = new Set<() => void>();
  constructor(slug: string) {
    resolveSlug(slug, Priority.visible)
      .then(async (ref) => {
        if (!ref) return null;
        return { ref, data: await loadModel(ref.permaslug, ref.variant, Priority.visible) };
      })
      .catch((): 'error' => 'error')
      .then((v) => {
        this.value = v;
        this.listeners.forEach((f) => f());
      });
  }
  subscribe(f: () => void) {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }
}

function useModel(store: ModelStore): Loaded {
  return useStore(store).value;
}

/** the loaded model, or null while loading / on error / when unknown */
const ok = (m: Loaded) => (m && m !== 'error' ? m : null);

// ---------- section ----------

function RevenueBody({ store }: { store: ModelStore }) {
  const m = useModel(store);
  const [period, setPeriod] = usePeriod();
  if (m === undefined) return <Skeleton />;
  if (m === 'error') return <div class="orcf-error" role="alert">Couldn't load this model's usage data from OpenRouter. Reload the page to try again.</div>;
  if (m === null) return <div class="orcf-empty">No usage data for this model.</div>;
  return <ModelRevenueView m={m} period={period} setPeriod={setPeriod} />;
}

function Skeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <span class="orcf-skel" style={{ width: '40%', height: '22px' }} />
      <span class="orcf-skel" style={{ width: '100%', height: '160px' }} />
      <span class="orcf-skel" style={{ width: '70%' }} />
    </div>
  );
}

function ModelRevenueView({ m, period, setPeriod }: { m: { ref: ModelRef; data: ModelData }; period: Period; setPeriod: (p: Period) => void }) {
  const { base, pt } = m.data;
  const days = periodDays(period);
  const cur = useMemo(() => computeRevenue(base, pt, days), [m, period]);
  const prev = useMemo(() => (period === '30d' ? null : computeRevenue(base, pt, previousPeriodDays(period))), [m, period]);
  const r30 = useMemo(() => computeRevenue(base, pt, periodDays('30d')), [m]);

  const stableOrder = useMemo(() => [...(r30.providers?.entries() ?? [])].sort((a, b) => b[1].revenue - a[1].revenue).map(([k]) => k), [r30]);
  const providers = [...(cur.providers?.entries() ?? [])].sort((a, b) => b[1].revenue - a[1].revenue);
  const names = base.providerNames;
  const series = useMemo(
    () => foldSeries(
      providers.map(([slug]) => ({ key: slug, label: names[slug] ?? slug, values: cur.daily.map((d) => d.byProvider[slug] ?? 0) })),
      7,
      stableOrder,
    ),
    [cur, stableOrder],
  );
  const colorOf = new Map(series.map((s) => [s.key, s.color]));
  const blend = blendedPrice(cur) ?? { in: base.weightedIn, out: base.weightedOut };
  const cacheShare = cur.prompt ? cur.cached / cur.prompt : 0;

  if (base.free) {
    return (
      <div class="orcf-empty">
        {base.variant === 'free' ? 'This is a free variant' : 'This model is free'}: providers earn nothing on it through OpenRouter.
      </div>
    );
  }
  if (base.nonToken) {
    return <div class="orcf-empty">OpenRouter bills this model per second, image or other unit rather than per token, so this extension doesn't estimate its revenue.</div>;
  }
  if (base.priceUnknown) {
    return (
      <div class="orcf-empty">
        {r30.tokens > 0 ? `It served ${fmtTokens(r30.tokens)} tokens in the last 30 days, but ` : ''}
        OpenRouter has no price data for this model any more (no provider lists a price for it), so its revenue can't be estimated.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div class="orcf-head" style={{ alignItems: 'center' }}>
        <div class="orcf-xs orcf-muted">
          {formatRange(days)} · {fmtTokens(cur.tokens)} tokens · {fmtTokens(cur.requests)} requests
        </div>
        <Segmented label="Time window" value={period} options={PERIOD_OPTIONS} onChange={setPeriod} />
      </div>
      <StatTiles
        stats={[
          {
            label: `Revenue · ${PERIOD_SHORT[period]}`,
            value: money(cur.revenue),
            sub: prev ? <><Change value={change(cur.revenue, prev.revenue)} /> vs previous {PERIOD_DAYS[period] === 1 ? 'day' : `${PERIOD_DAYS[period]} days`}</> : 'all providers',
          },
          { label: 'Annualized run-rate', value: money((cur.revenue / PERIOD_DAYS[period]) * 365), sub: `${money(cur.revenue / PERIOD_DAYS[period])} per day` },
          { label: 'Paid via BYOK', value: money(cur.byok), sub: `${pct(cur.revenue ? cur.byok / cur.revenue : 0, 0)} of revenue, ${pct(cur.tokens ? cur.byokTokens / cur.tokens : 0, 0)} of tokens` },
          {
            label: 'Effective $/M · in / out',
            value: <span class="orcf-price-pair"><span>{perM(blend.in)}</span><span class="orcf-muted" aria-hidden="true">/</span><span>{perM(blend.out)}</span></span>,
            sub: `${pct(cacheShare, 0)} of input from cache`,
          },
        ]}
      />
      {period !== '1d' && cur.revenue > 0 && (
        <div>
          <div class="orcf-xs orcf-muted" style={{ marginBottom: '8px' }}>Daily revenue by provider</div>
          <StackedColumns days={days} series={series} label="Daily revenue by provider" height={180} />
        </div>
      )}
      <ProviderTable m={m} providers={providers} total={cur.revenue} prev={prev} colorOf={colorOf} showSwatch={period !== '1d'} />
      <p class="orcf-xs orcf-muted" style={{ margin: 0 }}>
        {base.listed
          ? `OpenRouter publishes no effective prices for this ${base.variant === 'standard' ? 'model' : 'variant'}, so each provider's list prices are used` +
            (cur.cached > 0 ? ", with cached input priced at the cache-read rate using this model's daily share of cached tokens. " : '. ')
          : "Tokens each provider served (OpenRouter provider charts) × that provider's effective price for the day (list price after " +
            "prompt caching, cache writes and discounts, from OpenRouter's effective-pricing data), split into input/output by this " +
            "model's daily mix. "}
        BYOK requests are included at the same prices.
      </p>
    </div>
  );
}

function ProviderTable({
  m, providers, total, prev, colorOf, showSwatch,
}: {
  m: { ref: ModelRef; data: ModelData };
  providers: [string, { revenue: number; byok: number; tokens: number; priceIn: number; priceOut: number }][];
  total: number;
  prev: ReturnType<typeof computeRevenue> | null;
  colorOf: Map<string, string>;
  showSwatch: boolean;
}) {
  const names = m.data.base.providerNames;
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? providers : providers.slice(0, 8);
  const cols = gridCols([
    { w: 'minmax(0,1fr)' }, { w: '80px', sm: false }, { w: '120px', sm: false }, { w: '96px' },
    { w: 'minmax(64px,120px)', sm: false, md: false }, { w: '72px', when: !!prev },
  ]);
  if (!providers.length) return <div class="orcf-empty">No provider volumes for this window.</div>;
  return (
    <div class="orcf-table" role="table" aria-label="Revenue by provider">
      <div class="orcf-tr is-head" role="row" style={cols}>
        <span>Provider</span>
        <span class="r orcf-hide-sm">Tokens</span>
        <span class="r orcf-hide-sm">Effective $/M in · out</span>
        <span class="r">Revenue</span>
        <span class="r orcf-hide-sm orcf-hide-md">Share</span>
        {prev && <span class="r">Change</span>}
      </div>
      {visible.map(([slug, p]) => {
        const eps = m.data.base.endpoints.filter((e) => e.provider === slug);
        const before = prev?.providers?.get(slug)?.revenue ?? 0;
        return (
          <div class="orcf-tr" role="row" style={cols}>
            <div class="orcf-name">
              <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
                {showSwatch && <i class="orcf-swatch" style={{ background: colorOf.get(slug) ?? OTHER_COLOR }} aria-hidden="true" />}
                <a href={`/provider/${slug}`} title={names[slug] ?? slug}>{names[slug] ?? slug}</a>
              </div>
              <span class="orcf-sub" title="Cache hit rate over the last 24 hours, from OpenRouter's effective-pricing data">
                {eps.length} endpoint{eps.length === 1 ? '' : 's'}
                {eps.some((e) => e.cacheHit !== undefined) ? ` · ${pct(weighted(eps, (e) => e.cacheHit ?? 0), 0)} cache hit (24h)` : ''}
              </span>
            </div>
            <span class="r orcf-muted orcf-num orcf-hide-sm">{fmtTokens(p.tokens)}</span>
            <span class="r orcf-muted orcf-num orcf-hide-sm orcf-nowrap">{perM(p.priceIn)} · {perM(p.priceOut)}</span>
            <span class="r">
              <Tip
                class="orcf-strong orcf-num"
                content={() => (
                  <div>
                    <div class="orcf-tip-title">{names[slug] ?? slug}</div>
                    <TipRow label="Revenue" value={money(p.revenue, { precise: true })} />
                    <TipRow label="of which BYOK (est.)" value={money(p.byok)} />
                    <TipRow label="Tokens" value={fmtTokens(p.tokens)} />
                    <div class="orcf-tip-sep" />
                    {eps.map((e) => (
                      <TipRow
                        label={e.label}
                        value={e.effIn !== undefined ? `${perM(e.effIn)} · ${perM(e.effOut ?? 0)} · ${pct(e.cacheHit ?? 0, 0)} hit` : 'no recent traffic'}
                      />
                    ))}
                    <div class="orcf-tip-note">Endpoint rows: effective $/M in · out and cache hit over the last 24 hours (OpenRouter's latest snapshot, may include today).</div>
                  </div>
                )}
              >
                {money(p.revenue)}
              </Tip>
            </span>
            <span class="r orcf-hide-sm orcf-hide-md">
              <span class="orcf-share">
                <span class="orcf-muted orcf-num orcf-xs">{pct(total ? p.revenue / total : 0)}</span>
                <ShareBar share={providers[0][1].revenue ? p.revenue / providers[0][1].revenue : 0} />
              </span>
            </span>
            {prev && (
              <span class="r orcf-xs">
                <Change value={change(p.revenue, before)} />
              </span>
            )}
          </div>
        );
      })}
      {providers.length > visible.length && (
        <button class="orcf-more" onClick={() => setShowAll(true)}>
          Show all {providers.length} providers
        </button>
      )}
    </div>
  );
}

function weighted<T extends { tokens1d: number }>(xs: T[], f: (x: T) => number) {
  const w = xs.reduce((s, x) => s + x.tokens1d, 0);
  return w ? xs.reduce((s, x) => s + f(x) * x.tokens1d, 0) / w : xs.reduce((s, x) => s + f(x), 0) / Math.max(1, xs.length);
}

// ---------- header stat card ----------

function HeaderCard({ store, classes }: { store: ModelStore; classes: { label: string; value: string } }) {
  const raw = useModel(store);
  const m = ok(raw);
  const [period] = usePeriod();
  const r = useMemo(() => (m ? computeRevenue(m.data.base, m.data.pt, periodDays(period)) : null), [m, period]);
  return (
    <a href={`#${SECTION_ID}`} style={{ color: 'inherit', textDecoration: 'none', display: 'block' }} onClick={hideTip}>
      <div class="flex min-h-5 items-center justify-between gap-1.5">
        <div class={classes.label}>Revenue · {PERIOD_SHORT[period]}</div>
      </div>
      <div class={classes.value}>
        {raw === undefined ? (
          <span class="orcf-skel" style={{ width: '64px' }} />
        ) : !r || m?.data.base.free || m?.data.base.priceUnknown ? (
          <span class="orcf-muted" title={raw === 'error' ? "Couldn't load OpenRouter's usage data" : m?.data.base.nonToken ? 'Billed per second, image or other unit; not estimated' : m?.data.base.priceUnknown ? 'OpenRouter has no price data for this model any more' : undefined}>
            {m?.data.base.free ? 'free · $0' : m?.data.base.nonToken ? 'not per token' : m?.data.base.priceUnknown ? 'price unknown' : '—'}
          </span>
        ) : (
          <>
            {money(r.revenue)}
            <span class="ml-1 text-xs font-normal text-muted-foreground" style={{ marginLeft: '4px', fontSize: '12px', fontWeight: 400, color: 'hsl(var(--muted-foreground))' }}>
              ≈{money((r.revenue / PERIOD_DAYS[period]) * 365)}/yr
            </span>
          </>
        )}
      </div>
    </a>
  );
}

/** The innermost element holding a header card's label ("Released", "Context", …). */
function cardLabel(card: Element): Element | null {
  const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) });
  return walker.nextNode()?.parentElement ?? null;
}

function labelWrapped(label: Element | null): boolean {
  if (!label) return false;
  const cs = getComputedStyle(label);
  const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.25 || 16;
  return label.getBoundingClientRect().height > lh * 1.5;
}

// ---------- apps list ----------

function AppSpendLine({ store, appName, tokens, failed }: { store: ModelStore; appName: string; tokens: number | undefined; failed: boolean }) {
  const m = ok(useModel(store));
  const rpt = useMemo(() => {
    if (!m) return 0;
    const r = computeRevenue(m.data.base, m.data.pt, periodDays('30d'));
    return r.tokens ? r.revenue / r.tokens : 0;
  }, [m]);
  if (m && tokens === undefined && failed)
    return <span class="orcf-inline is-free" title="Couldn't load this model's app usage from OpenRouter">—</span>;
  if (!m || tokens === undefined) return null;
  if (m.data.base.free) return <span class="orcf-inline is-free">free · $0</span>;
  if (m.data.base.nonToken)
    return <span class="orcf-inline is-free" title="Billed per second, image or other unit; not estimated">not per token</span>;
  if (m.data.base.priceUnknown)
    return <span class="orcf-inline is-free" title="OpenRouter has no price data for this model any more">price unknown</span>;
  const spend = tokens * rpt;
  return (
    <Tip
      class="orcf-inline"
      content={() => (
        <div>
          <div class="orcf-tip-title">{appName} on this model · last 30 days</div>
          <TipRow label="Est. spend" value={money(spend, { precise: true })} />
          <TipRow label="Tokens" value={fmtTokens(tokens)} />
          <TipRow label="Model avg $/M" value={perM(rpt * 1e6)} />
          <div class="orcf-tip-note">App tokens × this model's average effective price over 30 days.</div>
        </div>
      )}
    >
      <i class="orcf-inline-dot" aria-hidden="true" />
      <span class="orcf-num">{money(spend)}</span>
    </Tip>
  );
}

// ---------- controller ----------

export class ModelController implements Controller {
  private store: ModelStore;
  private section: HTMLElement | null = null;
  private body = new Island({ className: 'orcf' });
  private card = new Island({ className: 'orcf' });
  private nav = new SectionNav({ sectionId: SECTION_ID, afterHref: ['#pricing', '#providers', '#activity'], menuAfter: ['Pricing', 'Providers', 'Activity'], label: 'Revenue' });
  private appBadges = new IslandSet<Element>(() => new Island({ className: 'orcf orcf-row-extra' }));
  private appTokens: Promise<Map<string, number>> | null = null;
  private appTokenMap = new Map<string, number>();
  private appTokensFailed = false;
  private appTokensRetried = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(slug: string) {
    this.store = new ModelStore(slug);
  }

  tick() {
    // Free variants have no Pricing section; then the Revenue section follows Providers. Models nobody
    // hosts any more (no endpoints) have neither, but may still have traffic: then it follows Activity.
    const pricing = document.getElementById('pricing') ?? document.getElementById('providers') ?? document.getElementById('activity');
    if (!pricing) return;
    this.ensureSection(pricing);
    this.ensureCard();
    this.nav.tick();
    this.ensureApps();
  }

  private ensureSection(pricing: HTMLElement) {
    if (!this.section) {
      // Mirror OpenRouter's section markup by copying class names from the Pricing section.
      const s = document.createElement('section');
      s.id = SECTION_ID;
      s.className = pricing.className;
      s.setAttribute('data-orcf', '');
      s.setAttribute('data-orcf-block', ''); // one of our blocks: see ui/anchor.ts
      const [head, desc, card] = [...pricing.children] as HTMLElement[];
      const h = document.createElement('div');
      h.className = head?.className ?? '';
      h.innerHTML = `<div class="${head?.firstElementChild?.className ?? ''}"><svg class="${pricing.querySelector('svg')?.getAttribute('class') ?? ''}" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 18V6"/></svg><h2 class="${pricing.querySelector('h2')?.className ?? ''}">Revenue</h2><span class="orcf orcf-badge" style="margin-left:2px">Estimate</span></div>`;
      const p = document.createElement('p');
      p.className = desc?.className ?? '';
      p.textContent =
        'What providers earn serving this model through OpenRouter: tokens each provider served × the price customers actually paid (after caching and discounts), including BYOK traffic.';
      const c = document.createElement('div');
      c.className = card?.className ?? '';
      c.appendChild(this.body.el);
      s.append(h, p, c);
      this.section = s;
      this.body.render(<RevenueBody store={this.store} />);
    }
    if (pricing.nextElementSibling !== this.section) pricing.after(this.section);
  }

  private releasedLabel: Element | null = null;

  private ensureCard() {
    if (!this.releasedLabel?.isConnected) {
      const released = [...document.querySelectorAll('.rounded-lg')].find(
        (c) => !c.hasAttribute('data-orcf') && /^released$/i.test(c.firstElementChild?.textContent?.trim() ?? ''),
      );
      this.releasedLabel = released ? cardLabel(released) : null;
    }
    const label = this.releasedLabel;
    const card = label?.closest('.rounded-lg');
    const grid = card?.parentElement;
    if (!card || !grid) return;
    if (!this.card.el.className.includes('rounded-lg')) {
      this.card.el.className = card.className + ' orcf';
      const valueEl = card.querySelector('.mt-1');
      this.card.render(<HeaderCard store={this.store} classes={{ label: label!.className, value: valueEl?.className ?? '' }} />);
    }
    this.card.appendTo(grid);
    this.layoutHeader(grid);
    if (this.observedGrid !== grid) {
      this.gridObserver?.disconnect();
      this.observedGrid = grid;
      // re-decide on width changes only (our own class toggles change the height, not the width)
      let lastWidth = -1;
      this.gridObserver = new ResizeObserver(([entry]) => {
        const w = Math.round(entry.contentRect.width);
        if (w === lastWidth) return;
        lastWidth = w;
        this.layoutHeader(grid);
      });
      this.gridObserver.observe(grid);
    }
  }

  private observedGrid: Element | null = null;
  private gridObserver: ResizeObserver | null = null;

  /**
   * The header grid has 5 columns on desktop. With 4 native cards ours fills the 5th slot. With 5 we try a
   * 6th column, but only while every one of OpenRouter's values still fits (prices vary in length per
   * model); otherwise our card takes its own full row so theirs keep their size.
   */
  private layoutHeader(grid: Element) {
    const native = [...grid.children].filter((c) => c !== this.card.el);
    const desktop = window.innerWidth >= 1024;
    if (native.length < 5 || !desktop) {
      grid.classList.remove('orcf-grid6', 'orcf-own-row');
      return;
    }
    // a value cut to an ellipsis, or a label pushed onto a second line, means six columns are too tight
    const clipped = () =>
      [...grid.children].some(
        (c) =>
          [...c.querySelectorAll<HTMLElement>('.truncate')].some((t) => t.scrollWidth > t.clientWidth + 1) ||
          labelWrapped(cardLabel(c)),
      );
    const tallest = () => Math.max(...native.map((c) => c.getBoundingClientRect().height));
    // OpenRouter's own layout (ours on a row of its own) is the reference…
    grid.classList.remove('orcf-grid6');
    grid.classList.add('orcf-own-row');
    const reference = tallest();
    // …and six columns are kept only if nothing gets cut, wrapped or taller (e.g. a row of modality icons)
    grid.classList.remove('orcf-own-row');
    grid.classList.add('orcf-grid6');
    if (clipped() || tallest() > reference + 1) {
      grid.classList.remove('orcf-grid6');
      grid.classList.add('orcf-own-row');
    }
  }

  private ensureApps() {
    const apps = document.getElementById('apps');
    if (!apps) return;
    const links = [...apps.querySelectorAll('a[href^="/apps/"]')];
    if (!links.length) return;
    if (!this.appTokens) {
      this.appTokens = this.store.value === undefined
        ? new Promise<void>((r) => { const off = this.store.subscribe(() => { off(); r(); }); }).then(() => this.fetchAppTokens())
        : this.fetchAppTokens();
      this.appTokens.then(
        (map) => {
          this.appTokenMap = map;
          this.appTokensFailed = false;
          this.appBadges.forEach((i) => i.rerender());
        },
        () => {
          // say so on every row, and try once more a little later (a new page visit retries anyway)
          this.appTokensFailed = true;
          this.appBadges.forEach((i) => i.rerender());
          if (!this.appTokensRetried) {
            this.appTokensRetried = true;
            this.retryTimer = setTimeout(() => {
              this.appTokens = null;
              if (!this.disposed) this.ensureApps();
            }, 20_000);
          }
        },
      );
    }
    for (const link of links) {
      const path = rawPath(link);
      const row = link.closest('.grid');
      const tokensLine = row?.lastElementChild?.firstElementChild;
      if (!path || !row || !tokensLine || link.closest('[data-orcf]')) continue;
      const island = this.appBadges.get(row);
      island.inside(tokensLine);
      if (island.el.dataset.key !== path) {
        island.el.dataset.key = path;
        const name = link.textContent?.trim() ?? path;
        const self = this;
        function Line() {
          return <AppSpendLine store={self.store} appName={name} tokens={self.appTokenMap.get(path!)} failed={self.appTokensFailed} />;
        }
        island.render(<Line />);
      }
    }
    this.appBadges.sweep();
  }

  private async fetchAppTokens(): Promise<Map<string, number>> {
    const v = ok(this.store.value);
    if (!v) return new Map();
    const res = await api<TopAppsForModel>('stats/top-apps-for-model', { permaslug: v.ref.permaslug, variant: v.ref.variant }, { prio: Priority.section });
    return new Map(res.top_apps.map((a) => [appPathOf(a.app), Number(a.total_tokens)]));
  }

  private disposed = false;

  dispose() {
    this.disposed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.gridObserver?.disconnect();
    this.observedGrid?.classList.remove('orcf-grid6', 'orcf-own-row');
    this.body.dispose();
    this.section?.remove();
    this.card.dispose();
    this.nav.dispose();
    this.appBadges.dispose();
  }
}

/** "/anthropic/claude-opus-5.5" -> "anthropic/claude-opus-5.5" if it looks like a model page. */
const RESERVED = new Set([
  'docs', 'chat', 'models', 'rankings', 'apps', 'provider', 'providers', 'settings', 'api', 'pricing', 'enterprise', 'about',
  'privacy', 'terms', 'login', 'sign-in', 'sign-up', 'keys', 'credits', 'activity', 'logs', 'workspaces', 'ori', 'benchmarks',
  'announcements', 'careers', 'compare', 'labs', 'arena', 'sso', 'organization', 'support', 'status',
]);
export function modelSlugFromPath(pathname: string): string | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length !== 2 || RESERVED.has(parts[0])) return null;
  return decodeURIComponent(`${parts[0]}/${parts[1]}`);
}
