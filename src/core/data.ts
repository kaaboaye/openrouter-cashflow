// Loaders: fetch from OpenRouter, reduce to compact records, cache.

import { api, Priority } from './api.ts';
import { cached, cacheGet, cacheSet } from './cache.ts';
import { dayOf } from './days.ts';
import { buildBase, endpointKind, hasEffectivePrices, listedPrices, modelKey, providersOf, type ModelBase, type ProviderTokens } from './model.ts';
import type { ActivityRow, CatalogModel, EffectivePricing, EndpointStat, ProviderTokenChart, RankingRow } from './types.ts';

export interface ModelData {
  base: ModelBase;
  pt: ProviderTokens;
}

export function loadBase(permaslug: string, variant: string, prio: number = Priority.section): Promise<ModelBase> {
  return cached(`base:${modelKey(permaslug, variant)}`, async () => {
    const [activity, pricing] = await Promise.all([
      api<{ analytics: ActivityRow[] }>('stats/model-activity', { permaslug, variant }, { prio, memoize: false }),
      // A failure here must not become a cached "$0": let it throw so nothing is stored and a later visit retries.
      api<EffectivePricing>('stats/effective-pricing', { permaslug, variant, shape: 'v7', range: '1m' }, { prio, memoize: false }),
    ]);
    // No effective prices (e.g. batch variants): fall back to list prices + the model's cache-read share.
    // A model whose endpoints charge nothing at all (e.g. a stealth model) is free, not "price unknown"; one
    // billed only per second or image (video, speech) is flagged as such.
    let kind: { allFree?: boolean; nonToken?: boolean } = {};
    const listed =
      variant !== 'free' && !hasEffectivePrices(pricing)
        ? await api<EndpointStat[]>('stats/endpoint', { permaslug, variant }, { prio, memoize: false }).then((eps) => {
            kind = endpointKind(eps);
            const l = listedPrices(eps.filter((e) => !e.is_free));
            // OpenRouter's stealth models are free while they run; one whose period has ended keeps its traffic
            // but loses its endpoints and prices — it was still free
            if (permaslug.startsWith('stealth/') && !kind.nonToken && !Object.values(l ?? {}).some((p) => p.in > 0 || p.out > 0)) kind = { allFree: true, nonToken: false };
            return l;
          })
        : undefined;
    return buildBase(permaslug, variant, activity?.analytics ?? [], pricing, listed, kind);
  });
}

/** Daily tokens (prompt + completion) of one model variant across OpenRouter (30 days). */
export function loadVariantDaily(permaslug: string, variant: string, prio: number = Priority.section): Promise<Record<string, number>> {
  return cached(`vd:${modelKey(permaslug, variant)}`, async () => {
    const res = await api<{ analytics: ActivityRow[] }>('stats/model-activity', { permaslug, variant }, { prio, memoize: false });
    const out: Record<string, number> = {};
    for (const a of res?.analytics ?? []) {
      const d = dayOf(a.date);
      out[d] = (out[d] ?? 0) + Number(a.total_prompt_tokens || 0) + Number(a.total_completion_tokens || 0);
    }
    return out;
  });
}

/** Daily tokens one provider served for one model (90 days). */
export function loadProviderTokens(
  provider: string,
  permaslug: string,
  variant: string,
  prio: number = Priority.section,
): Promise<Record<string, number>> {
  return cached(`pt:${provider}:${modelKey(permaslug, variant)}`, async () => {
    const res = await api<ProviderTokenChart>('stats/provider-token-chart', { provider, permaslug, variant }, { prio, memoize: false });
    const series: Record<string, number> = {};
    for (const pt of res?.chartData ?? []) {
      const total = Object.values(pt.ys).reduce((a, b) => a + (b || 0), 0);
      if (total > 0) series[dayOf(pt.x)] = total;
    }
    return series;
  });
}

/** Base record plus per-provider volumes for every provider that served the model. */
export async function loadModel(permaslug: string, variant: string, prio: number = Priority.section): Promise<ModelData> {
  const base = await loadBase(permaslug, variant, prio);
  const providers = providersOf(base);
  // If one provider's volumes can't be loaded the whole model fails: silently dropping it would hand its
  // traffic (and revenue) to the other hosts.
  const series = await Promise.all(providers.map((p) => loadProviderTokens(p, permaslug, variant, prio)));
  const pt: ProviderTokens = {};
  providers.forEach((p, i) => (pt[p] = series[i]));
  return { base, pt };
}

/** Top models of a provider by day (top 9 + "Others"), 90 days. Gives the provider's exact daily total. */
export function loadProviderTotals(provider: string, prio: number = Priority.section) {
  return cached(`ptotal:${provider}`, async () => {
    const res = await api<ProviderTokenChart>('stats/provider-token-chart', { provider }, { prio, memoize: false });
    return (res?.chartData ?? []).map((pt) => ({ day: dayOf(pt.x), ys: pt.ys }));
  });
}

export type RankingView = 'day' | 'week' | 'month';

/** Per-model token totals for a ranking window. With metric=spend, `rankingMetricValue` is the official share of spend. */
export function loadRankings(view: RankingView, metric?: 'spend'): Promise<RankingRow[]> {
  return cached(`rank:${view}:${metric ?? 'tokens'}`, () =>
    api<RankingRow[]>('rankings/models', { view, metric }, { prio: Priority.visible, memoize: false }).then((rows) =>
      // keep only what we need to save storage
      rows.map((r) => ({
        date: r.date,
        model_permaslug: r.model_permaslug,
        variant: r.variant,
        variant_permaslug: r.variant_permaslug,
        total_prompt_tokens: r.total_prompt_tokens,
        total_completion_tokens: r.total_completion_tokens,
        total_native_tokens_cached: 0,
        total_native_tokens_reasoning: 0,
        total_byok_prompt_tokens: 0,
        total_byok_completion_tokens: 0,
        count: r.count,
        rankingMetricValue: r.rankingMetricValue,
        change: r.change,
      })),
    ),
  );
}

// ---------- catalog: slug <-> permaslug, display names ----------

export interface ModelRef {
  slug: string; // variant slug as used in URLs, e.g. "anthropic/claude-opus-5.5:batch"
  permaslug: string; // e.g. "anthropic/claude-opus-5.5-20260921"
  variant: string;
  name: string; // short display name
  author: string;
  authorName: string;
  /** not found in OpenRouter's catalog: we know its id but not a page to link to */
  unresolved?: boolean;
}

const bySlug = new Map<string, ModelRef>();
const byKey = new Map<string, ModelRef>();
const looked = new Map<string, Promise<void>>(); // base id -> lookup

function ingest(models: CatalogModel[]) {
  for (const m of models) {
    const variant = m.endpoint?.variant ?? 'standard';
    const slug = m.endpoint?.model_variant_slug ?? m.slug;
    const ref: ModelRef = {
      slug,
      permaslug: m.permaslug,
      variant,
      name: m.short_name || m.name,
      author: m.author,
      authorName: m.author_display_name || m.author,
    };
    bySlug.set(slug, ref);
    byKey.set(modelKey(m.permaslug, variant), ref);
  }
}

export const stripVariant = (s: string) => s.replace(/:[a-z-]+$/, '');
export const variantOfSlug = (s: string) => s.match(/:([a-z-]+)$/)?.[1] ?? 'standard';

function slim(models: CatalogModel[]): CatalogModel[] {
  return models.map((m) => ({
    slug: m.slug,
    permaslug: m.permaslug,
    name: m.name,
    short_name: m.short_name,
    author: m.author,
    author_display_name: m.author_display_name,
    endpoint: m.endpoint
      ? {
          variant: m.endpoint.variant,
          model_variant_slug: m.endpoint.model_variant_slug,
          model_variant_permaslug: m.endpoint.model_variant_permaslug,
          is_free: m.endpoint.is_free,
        }
      : null,
  }));
}

// Lookups from many components within a few ms are batched into one catalog request. Each id gets its
// own promise: it rejects when its catalog request fails (so callers can tell "OpenRouter is down" from
// "no such model") and is then forgotten, so a later lookup tries again.
interface Pending {
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: unknown) => void;
}
let batch: Map<string, Pending> | null = null;
let batchPrio: number = Priority.visible;

function deferred(): Pending {
  let resolve!: () => void, reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => ((resolve = res), (reject = rej)));
  promise.catch(() => {}); // callers may not be listening yet
  return { promise, resolve, reject };
}

async function flush(pending: Map<string, Pending>, prio: number) {
  const ids = [...pending.keys()];
  const fromCache = await Promise.all(ids.map((id) => cacheGet<CatalogModel[]>(`cat:${id}`).catch(() => undefined)));
  const toFetch: string[] = [];
  ids.forEach((id, i) => {
    if (fromCache[i]) {
      ingest(fromCache[i]!);
      pending.get(id)!.resolve();
    } else toFetch.push(id);
  });
  for (let i = 0; i < toFetch.length; i += 20) {
    const chunk = toFetch.slice(i, i + 20);
    try {
      const got = await api<CatalogModel[]>('catalog/models', { slug: chunk }, { prio, memoize: false });
      ingest(got);
      for (const id of chunk) {
        cacheSet(`cat:${id}`, slim(got.filter((m) => m.slug === id || m.permaslug === id)));
        pending.get(id)!.resolve();
      }
    } catch (e) {
      for (const id of chunk) {
        looked.delete(id);
        pending.get(id)!.reject(e);
      }
    }
  }
}

function lookup(ids: string[], prio: number): Promise<void> {
  const waits: Promise<void>[] = [];
  for (const raw of ids) {
    const id = stripVariant(raw);
    const known = looked.get(id);
    if (known) {
      waits.push(known);
      continue;
    }
    if (!batch) {
      batch = new Map();
      batchPrio = prio;
      setTimeout(() => {
        const b = batch!;
        batch = null;
        flush(b, batchPrio).catch((e) => b.forEach((p, id) => (looked.delete(id), p.reject(e))));
      }, 30);
    }
    const d = deferred();
    batch.set(id, d);
    batchPrio = Math.max(batchPrio, prio);
    looked.set(id, d.promise);
    waits.push(d.promise);
  }
  return Promise.all(waits).then(() => {});
}

/** URL slug (e.g. "anthropic/claude-opus-5.5:batch") -> model ref */
export async function resolveSlug(slug: string, prio: number = Priority.visible): Promise<ModelRef | undefined> {
  await lookup([slug], prio);
  const exact = bySlug.get(slug);
  if (exact) return exact;
  const variant = variantOfSlug(slug);
  // A link to the plain slug of a model that only exists as its free variant (common in app rows).
  if (variant === 'standard') return bySlug.get(`${slug}:free`);
  const base = bySlug.get(stripVariant(slug));
  // A free variant the catalog no longer lists is still free: never show the paid model's revenue for it.
  // Other variants (e.g. :nitro, :exacto) share the standard model's traffic, so they fall back to it.
  if (base && variant === 'free') return { ...base, slug, variant: 'free' };
  return base;
}

/** Make display names available for these permaslugs (see refFor). */
export function resolvePermaslugs(permaslugs: string[], prio: number = Priority.section): Promise<void> {
  // names are cosmetic: on failure callers fall back to short names from the permaslug
  return lookup(permaslugs, prio).catch(() => {});
}

/** A model's author slug: the permaslug's prefix, or (for ids without one) the catalog's author, else "". */
export function authorOf(permaslug: string, variant = 'standard'): string {
  // author slugs are lowercase; Hugging Face-style ids ("Qwen/Qwen3-Embedding-8B") aren't
  return permaslug.includes('/') ? permaslug.split('/')[0].toLowerCase() : refFor(permaslug, variant)?.author ?? '';
}

export function refFor(permaslug: string, variant: string): ModelRef | undefined {
  return byKey.get(modelKey(permaslug, variant)) ?? byKey.get(modelKey(permaslug, 'standard'));
}
