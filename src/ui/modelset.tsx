// Shared UI for pages that list a set of models (provider pages, author pages): a revenue block with
// totals, a daily chart by model and a ranked table, plus a figure inside each model card.

import { useEffect, useMemo, useState } from 'preact/hooks';
import { Priority } from '../core/api.ts';
import { loadRankings, refFor, resolvePermaslugs, resolveSlug, type ModelRef } from '../core/data.ts';
import { formatRange, PERIOD_DAYS, PERIOD_LABEL, PERIOD_SHORT, periodDays, previousPeriodDays } from '../core/days.ts';
import { change, money, pct, perM, tokens as fmtTokens } from '../core/format.ts';
import type { ModelBase, ProviderModelRevenue } from '../core/model.ts';
import { shortModelName } from '../core/names.ts';
import {
  Change, foldSeries, gridCols, OTHER_COLOR, Progress, Segmented, ShareBar, StackedColumns, StatTiles, Tip, TipRow,
} from './components.tsx';
import { Island, IslandSet, hrefPath } from './inject.ts';
import { useStore, useStickyState } from './hooks.ts';
import { PERIOD_OPTIONS, usePeriod } from './period.ts';

export interface SetItem {
  ref: ModelRef;
  base: ModelBase;
  /** opaque per-kind payload (provider series, full provider tokens, …) */
  extra: unknown;
}

export interface SetConfig {
  /** Short noun for copy, e.g. "DeepInfra" */
  name: string;
  load(ref: ModelRef): Promise<SetItem>;
  revenue(item: SetItem, days: string[]): ProviderModelRevenue;
  /** tokens per day for a coverage note (optional) */
  totals?: () => Promise<Record<string, number>>;
  /** models to price even without a card on the page (e.g. ones a provider served recently but no longer lists) */
  extraModels?: () => Promise<{ permaslug: string; variant: string }[]>;
  copy: { title: string; method: string; tilesSub: string; cardTitle: (model: string) => string };
}

export class SetStore {
  items = new Map<string, SetItem>(); // by ref key
  bySlug = new Map<string, SetItem>();
  total = 0;
  done = 0;
  failed = 0;
  finished = false;
  dailyTotals: Record<string, number> = {};
  failedSlugs = new Set<string>();
  /** the page's own token chart couldn't be loaded: coverage unknown, unlisted models may be missing */
  chartUnavailable = false;
  private listeners = new Set<() => void>();
  private started = false;

  constructor(readonly cfg: SetConfig) {}

  subscribe(f: () => void) {
    this.listeners.add(f);
    return () => void this.listeners.delete(f);
  }
  private emit() {
    this.listeners.forEach((f) => f());
  }

  start(slugs: string[]) {
    if (this.started) return;
    this.started = true;
    if (!slugs.length && !this.cfg.extraModels) {
      // e.g. an author with no models: nothing to price, but the block must still finish
      this.finished = true;
      this.emit();
      return;
    }
    // (a provider without cards may still have served models recently: run() prices those from its chart)
    this.run(slugs).catch(() => {
      this.finished = true;
      this.emit();
    });
  }

  private async run(slugs: string[]) {
    const [refs, month] = await Promise.all([
      Promise.all(
        slugs.map((s) =>
          resolveSlug(s, Priority.visible).catch(() => {
            this.failed++;
            this.failedSlugs.add(s);
            return undefined;
          }),
        ),
      ),
      loadRankings('month').catch(() => []),
      this.cfg.totals?.().then((t) => (this.dailyTotals = t)).catch(() => void (this.chartUnavailable = true)),
    ]);
    // Models with traffic in the page's own chart but no card (e.g. no longer listed) still count.
    const known = new Set((refs.filter(Boolean) as ModelRef[]).map((r) => `${r.permaslug}|${r.variant}`));
    const extras = (
      (await this.cfg.extraModels?.().catch(() => {
        this.chartUnavailable = true;
        return [];
      })) ?? []
    ).filter((m) => !known.has(`${m.permaslug}|${m.variant}`));
    if (extras.length) await resolvePermaslugs(extras.map((m) => m.permaslug), Priority.section);
    const extraRefs: ModelRef[] = extras.map((m) => {
      const r = refFor(m.permaslug, m.variant);
      return r && r.variant === m.variant
        ? r
        : { slug: m.permaslug, permaslug: m.permaslug, variant: m.variant, name: shortModelName(m.permaslug), author: m.permaslug.split('/')[0], authorName: m.permaslug.split('/')[0], unresolved: true };
    });
    const extraKeys = new Set(extraRefs.map((r) => `${r.permaslug}|${r.variant}`));
    // Biggest models first so totals settle quickly.
    const weight = new Map(month.map((r) => [`${r.model_permaslug}|${r.variant}`, r.total_prompt_tokens + r.total_completion_tokens]));
    const list = [...(refs.filter(Boolean) as ModelRef[]), ...extraRefs].sort(
      (a, b) => (weight.get(`${b.permaslug}|${b.variant}`) ?? 0) - (weight.get(`${a.permaslug}|${a.variant}`) ?? 0),
    );
    this.total = list.length;
    this.emit();
    let next = 0;
    // If the first several models all fail and none succeeds, OpenRouter's stats are down: stop and say so
    // instead of retrying every model for minutes.
    const outage = () => this.items.size === 0 && this.failed >= 6;
    const worker = async () => {
      while (next < list.length && !outage()) {
        const ref = list[next++];
        // Skip models with no usage this month, unless the rankings couldn't be loaded (then try them all).
        const key = `${ref.permaslug}|${ref.variant}`;
        if (!month.length || extraKeys.has(key) || (weight.get(key) ?? 0) > 0) {
          try {
            const item = await this.cfg.load(ref);
            this.items.set(`${ref.permaslug}|${ref.variant}`, item);
            this.bySlug.set(ref.slug, item);
          } catch {
            this.failed++;
            this.failedSlugs.add(ref.slug);
          }
        }
        this.done++;
        this.emit();
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    this.finished = true;
    this.emit();
  }
}

export function itemName(ref: ModelRef) {
  const r = refFor(ref.permaslug, ref.variant);
  const n = r?.name ?? ref.name ?? shortModelName(ref.permaslug);
  return ref.variant !== 'standard' && !n.toLowerCase().includes(ref.variant) ? `${n} (${ref.variant})` : n;
}

interface Row {
  item: SetItem;
  key: string;
  name: string;
  cur: ProviderModelRevenue;
  prev: ProviderModelRevenue | null;
}

export function SetRevenue({ store }: { store: SetStore }) {
  const s = useStore(store, 250);
  const cfg = store.cfg;
  const [period, setPeriod] = usePeriod();
  // kept for the tab like the time window, so a reload (or Back) shows the same rows where the reader left them
  const [limit, setLimit] = useStickyState<number>('limit', 10, (v): v is number => typeof v === 'number' && v >= 10);
  const [, setNames] = useState(0);
  const days = periodDays(period);
  const prevDays = period === '30d' ? null : previousPeriodDays(period);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    for (const [key, item] of s.items) {
      const cur = cfg.revenue(item, days);
      if (!(cur.tokens > 0) || item.base.priceUnknown) continue;
      out.push({ item, key, name: itemName(item.ref), cur, prev: prevDays ? cfg.revenue(item, prevDays) : null });
    }
    return out.sort((a, b) => b.cur.revenue - a.cur.revenue || b.cur.tokens - a.cur.tokens);
  }, [s.done, s.finished, period]);

  const stableOrder = useMemo(() => {
    const d30 = periodDays('30d');
    return [...s.items.entries()]
      .map(([k, it]) => ({ k, v: cfg.revenue(it, d30).revenue }))
      .sort((a, b) => b.v - a.v)
      .map((x) => x.k);
  }, [s.finished, Math.floor(s.done / 20)]);

  useEffect(() => {
    resolvePermaslugs(rows.slice(0, limit).map((r) => r.item.ref.permaslug)).then(() => setNames((x) => x + 1));
  }, [rows.length, limit]);

  const total = rows.reduce((a, r) => a + r.cur.revenue, 0);
  const totalTok = rows.reduce((a, r) => a + r.cur.tokens, 0);
  const byok = rows.reduce((a, r) => a + r.cur.byok, 0);
  // every loaded model counts, including ones with no traffic in the current window
  const prevTotal = useMemo(
    () => (prevDays ? [...s.items.values()].reduce((a, it) => a + cfg.revenue(it, prevDays).revenue, 0) : null),
    [s.done, s.finished, period],
  );
  const chartTok = days.reduce((a, d) => a + (s.dailyTotals[d] ?? 0), 0);
  const paid = rows.filter((r) => !r.item.base.free);
  const series = useMemo(
    () => foldSeries(paid.map((r) => ({ key: r.key, label: r.name, values: r.cur.daily })), 7, stableOrder),
    [rows, stableOrder],
  );
  const colorOf = new Map(series.map((x) => [x.key, x.color]));
  const loading = !s.finished;
  const perDay = PERIOD_DAYS[period];
  // models with traffic in this window that OpenRouter no longer has any price for
  const unpriced = useMemo(
    () => [...s.items.values()].filter((it) => it.base.priceUnknown && !it.base.nonToken && cfg.revenue(it, days).tokens > 0).map((it) => itemName(it.ref)),
    [s.done, s.finished, period],
  );
  // nothing token-priced in this window (e.g. a provider of video or speech models billed per second)
  const nothingPriced = s.finished && s.total > 0 && rows.length === 0;
  const error = s.finished && s.failed > 0 && s.items.size === 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div class="orcf-head" style={{ alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <p class="text-sm text-muted-foreground" style={{ margin: 0 }}>{cfg.copy.title}</p>
          <span class="orcf-badge">Estimate</span>
        </div>
        <Segmented label="Time window" value={period} options={PERIOD_OPTIONS} onChange={setPeriod} />
      </div>
      {error && (
        <div class="orcf-error" role="alert">Couldn't load OpenRouter's usage data for these models. Reload the page to try again.</div>
      )}
      {!error && s.finished && s.total === 0 && <div class="orcf-empty">No models with usage to price on this page.</div>}
      {!error && nothingPriced && (
        <div class="orcf-empty">
          {unpriced.length
            ? `${unpriced.join(', ')} had traffic in this window, but OpenRouter no longer lists a price for ${unpriced.length === 1 ? 'it' : 'them'}, so revenue can't be estimated.`
            : 'No token usage in this window. Video, image and speech models (billed per second or per item) aren’t counted.'}
        </div>
      )}
      {!error && !(s.finished && s.total === 0) && !nothingPriced && <StatTiles
        stats={[
          {
            label: `Revenue · ${PERIOD_SHORT[period]}`,
            value: total || !loading ? money(total) : <span class="orcf-skel" style={{ width: '80px', height: '22px' }} />,
            sub: loading
              ? 'still loading, will grow…'
              : prevTotal !== null
                ? <><Change value={change(total, prevTotal)} /> vs previous {perDay === 1 ? 'day' : `${perDay} days`}</>
                : cfg.copy.tilesSub,
          },
          { label: 'Annualized', value: total ? money((total / perDay) * 365) : '—', sub: total ? `${money(total / perDay)} per day` : '' },
          { label: 'Via BYOK', value: total ? money(byok) : '—', sub: total ? `${pct(byok / total, 0)} of revenue` : '' },
          { label: 'Avg $ / 1M tokens', value: totalTok ? perM((total / totalTok) * 1e6) : '—', sub: totalTok || !loading ? `${fmtTokens(totalTok)}\u00a0tokens · ${formatRange(days)}` : formatRange(days) },
        ]}
      />}
      {loading && <Progress ratio={s.total ? s.done / s.total : 0.03} label={s.total ? `Pricing ${s.done} / ${s.total} models…` : 'Finding models…'} />}
      {period !== '1d' && total > 0 && (
        <div>
          <div class="orcf-xs orcf-muted" style={{ marginBottom: '8px' }}>Daily revenue by model</div>
          <StackedColumns days={days} series={series} label={`Daily ${cfg.name} revenue by model`} height={180} />
        </div>
      )}
      {rows.length > 0 && <ModelTable rows={rows.slice(0, limit)} total={total} showChange={!!prevDays} colorOf={colorOf} showSwatch={period !== '1d'} />}
      {rows.length > limit && (
        <button class="orcf-more" onClick={() => setLimit(limit < 25 ? 25 : 1000)}>
          Show more ({rows.length - limit})
        </button>
      )}
      {!error && (
        <p class="orcf-xs orcf-muted" style={{ margin: 0 }}>
          {cfg.copy.method}
          {!nothingPriced ? ' Models billed only per second or per item (e.g. speech-to-text, video) aren’t included.' : ''}
          {chartTok > 0 && !loading && !nothingPriced ? ` Covers ${pct(Math.min(1, totalTok / chartTok), 1)} of the tokens in the chart above.` : ''}
          {chartTok > 0 && !loading && !nothingPriced && totalTok / chartTok < 0.95
            ? ' The rest (models the chart groups as “Others”, or that couldn’t be identified) isn’t priced, so these totals are low.'
            : ''}
          {s.failed > 0 ? ` ${s.failed} model${s.failed === 1 ? '' : 's'} couldn't be loaded and ${s.failed === 1 ? 'is' : 'are'} left out, so totals are low.` : ''}
          {!loading && s.chartUnavailable && cfg.extraModels
            ? ' This page’s own token chart couldn’t be loaded, so models no longer listed here may be missing and the totals may be low.'
            : ''}
          {!loading && unpriced.length && !nothingPriced
            ? ` ${unpriced.join(', ')} ${unpriced.length === 1 ? 'has' : 'have'} traffic but no price data on OpenRouter any more, so ${unpriced.length === 1 ? 'it is' : 'they are'} left out.`
            : ''}
        </p>
      )}
    </div>
  );
}

function ModelTable({ rows, total, showChange, colorOf, showSwatch }: { rows: Row[]; total: number; showChange: boolean; colorOf: Map<string, string>; showSwatch: boolean }) {
  const cols = gridCols([
    { w: 'minmax(0,1fr)' }, { w: '72px', sm: false }, { w: '112px', sm: false }, { w: '84px' }, { w: '64px', when: showChange },
  ]);
  const top = rows[0]?.cur.revenue || 1;
  return (
    <div class="orcf-table" role="table" aria-label="Revenue by model">
      <div class="orcf-tr is-head" role="row" style={cols}>
        <span>Model</span>
        <span class="r orcf-hide-sm">Tokens</span>
        <span class="r orcf-hide-sm">Eff. $/M in · out</span>
        <span class="r">Revenue</span>
        {showChange && <span class="r">Change</span>}
      </div>
      {rows.map((r) => (
        <div class="orcf-tr" role="row" style={cols}>
          <div class="orcf-name">
            <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
              {showSwatch && <i class="orcf-swatch" style={{ background: colorOf.get(r.key) ?? OTHER_COLOR }} aria-hidden="true" />}
              {r.item.ref.unresolved ? <span class="orcf-primary" title={r.name}>{r.name}</span> : <a href={`/${r.item.ref.slug}`} title={r.name}>{r.name}</a>}
            </div>
            <span class="orcf-sub" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <ShareBar share={r.cur.revenue / top} />
              {r.item.base.free ? (r.item.base.variant === 'free' ? 'free variant' : 'free model') : `${pct(total ? r.cur.revenue / total : 0)} of revenue`}
            </span>
          </div>
          <span class="r orcf-muted orcf-num orcf-hide-sm">{fmtTokens(r.cur.tokens)}</span>
          <span class="r orcf-muted orcf-num orcf-hide-sm orcf-nowrap">{perM(r.cur.priceIn)} · {perM(r.cur.priceOut)}</span>
          <span class="r orcf-strong orcf-num">{money(r.cur.revenue)}</span>
          {showChange && (
            <span class="r orcf-xs">
              <Change value={r.prev ? change(r.cur.revenue, r.prev.revenue) : null} />
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

const NOT_PER_TOKEN = <span class="orcf-inline is-free" title="Billed per second, image or other unit; not estimated">not per token</span>;

function CardFigure({ store, slug, unitPriced }: { store: SetStore; slug: string; unitPriced?: boolean }) {
  const s = useStore(store, 250);
  const [period] = usePeriod();
  const item = s.bySlug.get(slug);
  if (!item) return s.finished ? (unitPriced ? NOT_PER_TOKEN : null) : <span class="orcf-inline is-loading"><span class="orcf-skel" style={{ width: '40px' }} /></span>;
  if (item.base.free) return <span class="orcf-inline is-free">free · $0</span>;
  if (item.base.nonToken) return NOT_PER_TOKEN;
  if (item.base.priceUnknown) return <span class="orcf-inline is-free" title="OpenRouter has no price data for this model any more">price unknown</span>;
  const r = store.cfg.revenue(item, periodDays(period));
  if (!(r.tokens > 0)) return unitPriced ? NOT_PER_TOKEN : null;
  return (
    <Tip
      class="orcf-inline"
      content={() => (
        <div>
          <div class="orcf-tip-title">{store.cfg.copy.cardTitle(itemName(item.ref))} · {PERIOD_LABEL[period]}</div>
          <TipRow label="Revenue" value={money(r.revenue, { precise: true })} />
          <TipRow label="of which BYOK" value={money(r.byok)} />
          <TipRow label="Tokens" value={fmtTokens(r.tokens)} />
          <TipRow label="Effective $/M in · out" value={`${perM(r.priceIn)} · ${perM(r.priceOut)}`} />
        </div>
      )}
    >
      <i class="orcf-inline-dot" aria-hidden="true" />
      <span class="orcf-num">{money(r.revenue)}</span>
      <span class="orcf-muted" style={{ fontWeight: 450 }}>· {period}</span>
    </Tip>
  );
}

function blockIsland() {
  const i = new Island({ className: 'orcf' });
  i.el.setAttribute('data-orcf-block', ''); // one of our blocks: see ui/anchor.ts
  return i;
}

/** Mounts the revenue block after the page's token chart and a figure into every model card. */
export class SetMount {
  private block = blockIsland();
  private cards = new IslandSet<Element>(() => new Island({ className: 'orcf orcf-card-extra' }));
  private rendered = false;

  constructor(readonly store: SetStore) {}

  private anchor: Element | null = null;
  private emptyTimer: ReturnType<typeof setTimeout> | null = null;
  private slugOf = new WeakMap<Element, string | null>();

  tick(chartLabel: RegExp) {
    // Place the block right after the token chart that follows the page's "... tokens processed" label.
    if (!this.anchor?.isConnected || this.block.el.previousElementSibling !== this.anchor) {
      const label = [...document.querySelectorAll('main p')].find((p) => p.childElementCount === 0 && chartLabel.test(p.textContent?.trim() ?? ''));
      let scope: Element | null | undefined = label;
      while (scope && !scope.querySelector('.recharts-responsive-container')) scope = scope.parentElement;
      let anchor: Element | null = scope?.querySelector('.recharts-responsive-container') ?? null;
      while (anchor && scope && anchor.parentElement !== scope) anchor = anchor.parentElement;
      this.anchor = anchor && anchor !== this.block.el ? anchor : null;
      if (this.anchor) {
        this.block.after(this.anchor);
        if (!this.rendered) {
          this.rendered = true;
          this.block.render(<SetRevenue store={this.store} />);
        }
      }
    }
    const slugs: string[] = [];
    for (const card of document.querySelectorAll('[data-testid="model-list-item"]')) {
      let slug = this.slugOf.get(card);
      if (slug === undefined) {
        const link = [...card.querySelectorAll('a[href]')].find((a) => (hrefPath(a)?.split('/').filter(Boolean).length ?? 0) === 2);
        slug = hrefPath(link ?? null)?.replace(/^\//, '') ?? null;
        this.slugOf.set(card, slug);
      }
      if (!slug) continue;
      slugs.push(slug);
      const island = this.cards.get(card);
      if (island.el.dataset.key === slug && island.el.parentElement?.closest('[data-testid="model-list-item"]') === card) continue;
      const slot = card.querySelector<HTMLElement>('.justify-end');
      if (!slot) continue;
      if (slot.style.flexWrap !== 'wrap') slot.style.flexWrap = 'wrap';
      island.inside(slot);
      if (island.el.dataset.key !== slug) {
        island.el.dataset.key = slug;
        // OpenRouter's card shows the model's price: billed per second/minute/image/… and not per token means
        // it's never token-priced (speech-to-text reports 0 tokens, so it isn't even loaded)
        const text = card.textContent ?? '';
        const unitPriced = /\/\s*(second|minute|hour|image|character|request|song|video)\b/i.test(text) && !/tokens\b/i.test(text.replace(/[\d.,]+\s*[KMBT]?\s*tokens/gi, ''));
        island.render(<CardFigure store={this.store} slug={slug} unitPriced={unitPriced} />);
      }
    }
    this.cards.sweep();
    if (slugs.length) this.store.start([...new Set(slugs)]);
    else if (this.anchor && !this.emptyTimer) {
      // no model cards (yet): if none show up shortly, the page simply has none
      this.emptyTimer = setTimeout(() => {
        if (!document.querySelector('[data-testid="model-list-item"]')) this.store.start([]);
      }, 3000);
    }
  }

  dispose() {
    if (this.emptyTimer) clearTimeout(this.emptyTimer);
    this.block.dispose();
    this.cards.dispose();
  }
}
