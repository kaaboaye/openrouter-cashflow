// Market-wide dataset: every paid model variant with usage in the last 30 days, loaded in order of
// OpenRouter's official spend share (so the biggest money is in after a few seconds) and aggregated
// by provider / company / model / author.

import { Priority } from './api.ts';
import { authorOf, loadModel, loadRankings, resolvePermaslugs, type ModelData } from './data.ts';
import { dataEpoch, periodDays, previousPeriodDays, type Period } from './days.ts';
import { computeRevenue, modelKey, type Revenue } from './model.ts';
import { authorName, companyOf } from './names.ts';

export interface Entry {
  key: string;
  permaslug: string;
  variant: string;
  spendShare: number; // official 30d share of OpenRouter-billed spend
  tokens30: number;
  data?: ModelData;
}

export interface Progress {
  loaded: number; // attempted (succeeded + failed)
  total: number;
  failed: number;
  failedSpend: number; // 0..1 of official spend share that failed to load (left out of every total)
  coveredSpend: number; // 0..1 of official spend share loaded successfully
  done: boolean;
  error?: string;
  /** bumped when late catalog lookups (e.g. authors of ids without an author prefix) change the grouping */
  catalogRev: number;
}

const emptyProgress = (): Progress => ({ loaded: 0, total: 0, failed: 0, failedSpend: 0, coveredSpend: 0, done: false, catalogRev: 0 });

const WORKERS = 6;

class GlobalDataset {
  entries: Entry[] = [];
  progress: Progress = emptyProgress();
  private listeners = new Set<() => void>();
  private started = false;
  private epoch = '';
  private gen = 0;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private revCache = new Map<string, Revenue>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(now = false) {
    if (now) {
      if (this.notifyTimer) clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
      this.listeners.forEach((f) => f());
      return;
    }
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.listeners.forEach((f) => f());
    }, 400);
  }

  /** Load (or, once OpenRouter has published a new UTC day, reload) the market. */
  start(): void {
    // also reload once data fetched in the post-midnight settling window may have changed
    const epoch = dataEpoch();
    if (this.started && this.epoch === epoch) return;
    this.started = true;
    this.epoch = epoch;
    const gen = ++this.gen;
    this.entries = [];
    this.revCache.clear();
    this.progress = emptyProgress();
    this.notify(true);
    this.run(gen).catch((e) => {
      if (gen !== this.gen) return;
      this.progress = { ...this.progress, error: String(e?.message ?? e), done: true };
      this.notify(true);
    });
  }

  private async run(gen: number) {
    const [tok, spend] = await Promise.all([loadRankings('month'), loadRankings('month', 'spend')]);
    if (gen !== this.gen) return;
    const share = new Map(spend.map((r) => [modelKey(r.model_permaslug, r.variant), r.rankingMetricValue || 0]));
    this.entries = tok
      .filter((r) => r.variant !== 'free' && r.total_prompt_tokens + r.total_completion_tokens > 0)
      .map((r) => {
        const key = modelKey(r.model_permaslug, r.variant);
        return {
          key,
          permaslug: r.model_permaslug,
          variant: r.variant,
          spendShare: share.get(key) ?? 0,
          tokens30: r.total_prompt_tokens + r.total_completion_tokens,
        };
      })
      .sort((a, b) => b.spendShare - a.spendShare || b.tokens30 - a.tokens30);
    this.progress = { ...emptyProgress(), total: this.entries.length };
    this.notify(true);
    // ids without an "author/" prefix get their author from the catalog
    const bare = this.entries.filter((e) => !e.permaslug.includes('/')).map((e) => e.permaslug);
    if (bare.length)
      resolvePermaslugs(bare, Priority.background).then(() => {
        if (gen !== this.gen) return;
        this.progress = { ...this.progress, catalogRev: this.progress.catalogRev + 1 };
        this.notify(true);
      });

    let next = 0;
    // Nothing loading at all means OpenRouter's stats are down: stop early and show the error.
    const outage = () => this.progress.failed >= 8 && this.progress.failed === this.progress.loaded;
    const worker = async () => {
      while (gen === this.gen && next < this.entries.length && !outage()) {
        const e = this.entries[next++];
        try {
          e.data = await loadModel(e.permaslug, e.variant, Priority.background);
          if (gen !== this.gen) return;
          this.progress.coveredSpend += e.spendShare;
        } catch {
          if (gen !== this.gen) return;
          this.progress.failed++; // left out of every total; the UI says how many and how much
          this.progress.failedSpend += e.spendShare;
        }
        this.progress.loaded++;
        this.notify();
      }
    };
    await Promise.all(Array.from({ length: WORKERS }, worker));
    if (gen !== this.gen) return;
    this.progress.done = true;
    if (this.progress.total > 0 && (this.progress.failed === this.progress.total || outage())) this.progress.error = 'OpenRouter stats unavailable';
    this.notify(true);
  }

  revenue(e: Entry, days: string[]): Revenue | null {
    if (!e.data) return null;
    const k = `${e.key}@${days[0]}..${days[days.length - 1]}`;
    let r = this.revCache.get(k);
    if (!r) {
      r = computeRevenue(e.data.base, e.data.pt, days);
      this.revCache.set(k, r);
    }
    return r;
  }
}

export const market = new GlobalDataset();

// ---------- aggregation ----------

export interface AggRow {
  key: string;
  name: string;
  revenue: number;
  byok: number;
  tokens: number;
  prevRevenue: number | null;
  /** daily revenue over the period (oldest first) */
  daily: number[];
  /** for providers: number of models served; for authors: number of models */
  count: number;
  /** biggest contributor (model for providers/authors, provider for models) */
  top?: { key: string; name: string; revenue: number };
  /** e.g. provider slugs merged into a company, or model permaslug */
  members?: string[];
  permaslug?: string;
  variant?: string;
}

export interface Aggregate {
  rows: AggRow[];
  total: number;
  totalByok: number;
  /** every model's tokens, including rows left out for earning nothing: the same in every grouping */
  totalTokens: number;
  /** previous period's total over every model, including ones that earned nothing this period */
  prevTotal: number | null;
  hasPrev: boolean;
}

function periodsFor(period: Period) {
  const days = periodDays(period);
  // model-activity only reaches back ~30 days, so a previous 30d window isn't available.
  const prev = period === '30d' ? null : previousPeriodDays(period);
  return { days, prev };
}

export type Dimension = 'provider' | 'company' | 'model' | 'author';

export function aggregate(dim: Dimension, period: Period, nameOfModel: (e: Entry) => string): Aggregate {
  const { days, prev } = periodsFor(period);
  const rows = new Map<string, AggRow & { _top: Map<string, { name: string; revenue: number }>; _members: Set<string> }>();
  let total = 0, totalByok = 0, totalTokens = 0, prevTotal = 0;

  const row = (key: string, name: string) => {
    let r = rows.get(key);
    if (!r) {
      r = {
        key, name, revenue: 0, byok: 0, tokens: 0, prevRevenue: prev ? 0 : null,
        daily: new Array(days.length).fill(0), count: 0, _top: new Map(), _members: new Set(),
      };
      rows.set(key, r);
    }
    return r;
  };
  const bump = (r: ReturnType<typeof row>, key: string, name: string, v: number) => {
    const t = r._top.get(key) ?? { name, revenue: 0 };
    t.revenue += v;
    r._top.set(key, t);
  };

  for (const e of market.entries) {
    const cur = market.revenue(e, days);
    if (!cur) continue;
    const before = prev ? market.revenue(e, prev) : null;
    total += cur.revenue;
    totalByok += cur.byok;
    totalTokens += cur.tokens;
    if (before) prevTotal += before.revenue;
    const modelName = nameOfModel(e);

    if (dim === 'model' || dim === 'author') {
      const key = dim === 'model' ? e.key : authorOf(e.permaslug, e.variant);
      const r = row(key, dim === 'model' ? modelName : key ? authorName(key) : 'Unknown author');
      r.revenue += cur.revenue;
      r.byok += cur.byok;
      r.tokens += cur.tokens;
      if (r.prevRevenue !== null && before) r.prevRevenue += before.revenue;
      cur.daily.forEach((d, i) => (r.daily[i] += d.revenue));
      if (dim === 'model') {
        r.permaslug = e.permaslug;
        r.variant = e.variant;
        cur.providers?.forEach((p, slug) => bump(r, slug, e.data!.base.providerNames[slug] ?? slug, p.revenue));
        r.count = cur.providers?.size ?? 0;
      } else {
        bump(r, e.key, modelName, cur.revenue);
        if (cur.revenue > 0) r._members.add(e.key);
      }
      continue;
    }

    // provider / company
    const names = e.data!.base.providerNames;
    cur.providers?.forEach((p, slug) => {
      const pname = names[slug] ?? slug;
      const key = dim === 'company' ? companyOf(slug, pname) : slug;
      const r = row(key, dim === 'company' ? key : pname);
      r.revenue += p.revenue;
      r.byok += p.byok;
      r.tokens += p.tokens;
      r._members.add(slug);
      bump(r, e.key, modelName, p.revenue);
      cur.daily.forEach((d, i) => (r.daily[i] += d.byProvider[slug] ?? 0));
    });
    before?.providers?.forEach((p, slug) => {
      const pname = names[slug] ?? slug;
      const key = dim === 'company' ? companyOf(slug, pname) : slug;
      const r = row(key, dim === 'company' ? key : pname);
      if (r.prevRevenue !== null) r.prevRevenue += p.revenue;
    });
  }

  const out: AggRow[] = [...rows.values()].map(({ _top, _members, ...r }) => {
    let top: AggRow['top'];
    for (const [key, t] of _top) if (!top || t.revenue > top.revenue) top = { key, ...t };
    if (dim !== 'model') r.count = dim === 'author' ? _members.size : [..._top.values()].filter((t) => t.revenue > 0).length;
    return { ...r, top, members: [..._members] };
  });
  out.sort((a, b) => b.revenue - a.revenue);
  return { rows: out.filter((r) => r.revenue > 0), total, totalByok, totalTokens, prevTotal: prev ? prevTotal : null, hasPrev: !!prev };
}
