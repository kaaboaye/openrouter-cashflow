// Pure revenue model. No I/O here, so it can be unit-tested.
//
// Revenue for one model on one day:
//   tokens served by each provider            (stats/provider-token-chart, exact, incl. BYOK)
//   × that provider's effective $/M that day  (stats/effective-pricing daily chart: list price after
//                                              caching, cache writes and discounts, per endpoint)
//   split into prompt/completion using the model's daily prompt/completion mix (stats/model-activity).
// Without per-provider volumes we fall back to OpenRouter's 30-day weighted average price.

import { dayOf } from './days.ts';
import type { ActivityRow, DisplayPrice, EffectivePricing, EndpointStat } from './types.ts';

export interface DayUsage {
  p: number; // prompt tokens (incl. cached)
  c: number; // completion tokens (incl. reasoning)
  bp: number; // BYOK prompt tokens
  bc: number; // BYOK completion tokens
  cached: number;
  req: number;
}

export interface EndpointInfo {
  id: string;
  provider: string; // provider slug
  label: string; // e.g. "Amazon Bedrock (2)"
  effIn?: number; // $/M, last day
  effOut?: number;
  cacheHit?: number;
  tokens1d: number;
}

export interface ModelBase {
  permaslug: string;
  variant: string;
  free: boolean;
  /** billed per second / image / … rather than per token (implies priceUnknown) */
  nonToken?: boolean;
  usage: Record<string, DayUsage>;
  weightedIn: number; // $/M, 30d, volume weighted across endpoints
  weightedOut: number;
  weightedCacheHit: number;
  endpoints: EndpointInfo[];
  providerNames: Record<string, string>;
  /** endpointId -> day -> $/M */
  dailyIn: Record<string, Record<string, number>>;
  dailyOut: Record<string, Record<string, number>>;
  /**
   * List prices per provider ($/M), only fetched when OpenRouter has no effective prices for the model
   * (e.g. batch variants). Turned into an effective price with the model's own cache-read share.
   */
  listed?: Record<string, { in: number; out: number; cacheRead: number; name?: string }>;
  /** a paid model OpenRouter has no price data for any more (no effective or list prices): revenue unknown, not $0 */
  priceUnknown?: boolean;
}

/** provider slug -> day -> tokens */
export type ProviderTokens = Record<string, Record<string, number>>;

export const modelKey = (permaslug: string, variant: string) => `${permaslug}|${variant}`;

export function hasEffectivePrices(p: EffectivePricing | null): boolean {
  return !!p && (p.weightedInputPrice > 0 || p.weightedOutputPrice > 0);
}

export const displayPrices = (e: EndpointStat): DisplayPrice[] => e.display_pricing ?? e.pricing?.display_pricing ?? [];

const shownToken = (e: EndpointStat) => displayPrices(e).some((d) => d.kind === 'token' && Number(d.price) > 0);
const shownOther = (e: EndpointStat) => displayPrices(e).some((d) => d.kind !== 'token' && Number(d.price) > 0);
/**
 * Billed only per second / minute / image: OpenRouter shows unit prices and no token price. Such an endpoint
 * may still fill `completion` with its unit price (e.g. text-to-speech at $/second), which is not per token.
 */
const unitOnly = (e: EndpointStat) => shownOther(e) && !shownToken(e);

/** What a model's endpoints say about it when OpenRouter has no effective prices for it. */
export function endpointKind(eps: EndpointStat[]): { allFree: boolean; nonToken: boolean } {
  if (!eps.length) return { allFree: false, nonToken: false };
  const tokenPrice = (e: EndpointStat) => shownToken(e) || (!unitOnly(e) && (Number(e.pricing?.prompt) > 0 || Number(e.pricing?.completion) > 0));
  const otherPrice = shownOther;
  return {
    // free only if nothing is charged at all, in any unit
    allFree: eps.every((e) => e.is_free || (!tokenPrice(e) && !otherPrice(e))),
    // billed per second / image / … but never per token: not something this extension prices
    nonToken: eps.some((e) => !e.is_free && otherPrice(e)) && !eps.some((e) => !e.is_free && tokenPrice(e)),
  };
}

export function listedPrices(stats: EndpointStat[]): ModelBase['listed'] {
  const acc: Record<string, { in: number; out: number; cacheRead: number; n: number; name?: string }> = {};
  for (const e of stats) {
    const pr = e.pricing ?? {};
    // `prompt`/`completion` are already the prices charged; `discount` only says how far below list they are.
    const k = 1e6;
    // some models (rerankers) carry their per-token price only in display_pricing
    const shown = (re: RegExp) => Number(displayPrices(e).find((d) => d.kind === 'token' && re.test(d.sku_label ?? ''))?.price ?? 0) * k;
    if (unitOnly(e)) continue; // its prompt/completion fields hold a unit price, not a token price
    const pin = Number(pr.prompt ?? 0) * k || shown(/input/i);
    const pout = Number(pr.completion ?? 0) * k || shown(/output/i);
    const pcr = pr.input_cache_read !== undefined ? Number(pr.input_cache_read) * k : pin;
    const slug = e.provider_slug.split('/')[0];
    const a = (acc[slug] ??= { in: 0, out: 0, cacheRead: 0, n: 0, name: e.provider_name });
    a.in += pin; a.out += pout; a.cacheRead += pcr; a.n++;
  }
  const out: NonNullable<ModelBase['listed']> = {};
  for (const [slug, a] of Object.entries(acc)) out[slug] = { in: a.in / a.n, out: a.out / a.n, cacheRead: a.cacheRead / a.n, name: a.name };
  return out;
}

export function buildBase(
  permaslug: string,
  variant: string,
  activity: ActivityRow[],
  pricing: EffectivePricing | null,
  listed?: ModelBase['listed'],
  kind: { allFree?: boolean; nonToken?: boolean } = {},
): ModelBase {
  const allFree = !!kind.allFree;
  const usage: Record<string, DayUsage> = {};
  for (const a of activity) {
    usage[dayOf(a.date)] = {
      p: a.total_prompt_tokens || 0,
      c: a.total_completion_tokens || 0,
      bp: a.total_byok_prompt_tokens || 0,
      bc: a.total_byok_completion_tokens || 0,
      cached: a.total_native_tokens_cached || 0,
      req: a.count || 0,
    };
  }

  const endpoints = new Map<string, EndpointInfo>();
  const providerNames: Record<string, string> = {};
  const dailyIn: ModelBase['dailyIn'] = {};
  const dailyOut: ModelBase['dailyOut'] = {};

  if (pricing) {
    const slugs = pricing.endpointProviderSlugs ?? {};
    const raw = pricing.endpointRawNames ?? {};
    const labels = pricing.endpointNames ?? {};
    for (const id of Object.keys(slugs)) {
      endpoints.set(id, { id, provider: slugs[id], label: labels[id] ?? raw[id] ?? slugs[id], tokens1d: 0 });
      if (raw[id]) providerNames[slugs[id]] = raw[id];
    }
    for (const s of pricing.providerSummaries ?? []) {
      const e = endpoints.get(s.endpointId) ?? { id: s.endpointId, provider: s.providerSlug, label: s.providerName, tokens1d: 0 };
      e.effIn = s.effectiveInputPrice;
      e.effOut = s.effectiveOutputPrice;
      e.cacheHit = s.cacheHitRate;
      e.tokens1d = s.totalTokens || 0;
      endpoints.set(s.endpointId, e);
      providerNames[s.providerSlug] ??= s.providerName.replace(/\s*\(\d+\)$/, '');
    }
    for (const pt of pricing.inputChartData ?? []) {
      const d = dayOf(pt.x);
      for (const [id, v] of Object.entries(pt.y)) if (Number.isFinite(v)) (dailyIn[id] ??= {})[d] = v;
    }
    for (const pt of pricing.outputChartData ?? []) {
      const d = dayOf(pt.x);
      for (const [id, v] of Object.entries(pt.y)) if (Number.isFinite(v)) (dailyOut[id] ??= {})[d] = v;
    }
  }

  // Without effective-pricing data the providers come from the list-price response.
  for (const [slug, l] of Object.entries(listed ?? {})) {
    if (![...endpoints.values()].some((e) => e.provider === slug)) {
      endpoints.set(`listed:${slug}`, { id: `listed:${slug}`, provider: slug, label: l.name ?? slug, tokens1d: 0 });
    }
    if (l.name) providerNames[slug] ??= l.name;
  }

  return {
    permaslug,
    variant,
    free: variant === 'free' || allFree,
    nonToken: !!kind.nonToken && variant !== 'free' && !allFree,
    priceUnknown:
      (!!kind.nonToken && variant !== 'free' && !allFree) ||
      (variant !== 'free' &&
      !allFree &&
      !hasEffectivePrices(pricing) &&
      !Object.values(listed ?? {}).some((l) => l.in > 0 || l.out > 0)),
    usage,
    weightedIn: pricing?.weightedInputPrice ?? 0,
    weightedOut: pricing?.weightedOutputPrice ?? 0,
    weightedCacheHit: pricing?.weightedCacheHitRate ?? 0,
    endpoints: [...endpoints.values()],
    providerNames,
    dailyIn,
    dailyOut,
    listed,
  };
}

/** Share of prompt tokens served from cache on `day` (falls back to the whole window). */
function cacheShare(base: ModelBase, day: string): number {
  const u = base.usage[day];
  if (u && u.p > 0) return Math.min(1, u.cached / u.p);
  let p = 0, c = 0;
  for (const x of Object.values(base.usage)) { p += x.p; c += x.cached; }
  return p ? Math.min(1, c / p) : 0;
}

/** Effective price from list prices: uncached input at list, cached input at the cache-read price. */
function listedPrice(base: ModelBase, provider: string | null, day: string): Price | null {
  if (!base.listed) return null;
  const rows = provider ? [base.listed[provider]].filter(Boolean) : Object.values(base.listed);
  if (!rows.length) return null;
  const h = cacheShare(base, day);
  const pin = rows.reduce((s, r) => s + (1 - h) * r.in + h * r.cacheRead, 0) / rows.length;
  const pout = rows.reduce((s, r) => s + r.out, 0) / rows.length;
  return { in: pin, out: pout };
}

/** Model-wide fallback price for a day when no per-provider volumes are known. */
export function modelPrice(base: ModelBase, day: string): Price {
  if (base.weightedIn > 0 || base.weightedOut > 0) return { in: base.weightedIn, out: base.weightedOut };
  return listedPrice(base, null, day) ?? { in: 0, out: 0 };
}

export function providersOf(base: ModelBase): string[] {
  return [...new Set(base.endpoints.map((e) => e.provider))];
}

export interface Price {
  in: number;
  out: number;
}

/** Effective $/M for one provider of a model on a given day, blending its endpoints. */
export function providerPrice(base: ModelBase, provider: string, day: string): Price {
  const eps = base.endpoints.filter((e) => e.provider === provider);
  const weightOf = (e: EndpointInfo) => (eps.some((x) => x.tokens1d > 0) ? e.tokens1d : 1);
  // OpenRouter reports 0 effective prices for some variants (e.g. batch); treat those as unknown.
  const usable = (v: number | undefined) => v !== undefined && (v > 0 || !base.listed);

  // Blend the endpoints that have a price for this day, weighted by recent volume. An endpoint that served
  // this day but has no traffic now still counts: if none of the priced ones has recent volume, weigh them equally.
  const blend = (prices: (e: EndpointInfo) => number | undefined) => {
    const priced = eps.filter((e) => usable(prices(e)));
    if (!priced.length) return null;
    const recent = priced.some((e) => e.tokens1d > 0);
    let w = 0, sum = 0;
    for (const e of priced) {
      const k = recent ? e.tokens1d : 1;
      sum += prices(e)! * k;
      w += k;
    }
    return w ? sum / w : null;
  };
  const dayIn = blend((e) => base.dailyIn[e.id]?.[day]);
  const dayOut = blend((e) => base.dailyOut[e.id]?.[day]);
  let si = dayIn ?? 0, wi = dayIn === null ? 0 : 1, so = dayOut ?? 0, wo = dayOut === null ? 0 : 1;
  if (!wi || !wo) {
    // Fall back to the endpoint's latest effective price, then list prices, then the model average.
    let fi = 0, fo = 0, fw = 0;
    for (const e of eps) {
      if (!usable(e.effIn) || !usable(e.effOut)) continue;
      const w = weightOf(e) || 1;
      fi += e.effIn! * w; fo += e.effOut! * w; fw += w;
    }
    const fallback = fw ? { in: fi / fw, out: fo / fw } : listedPrice(base, provider, day) ?? modelPrice(base, day);
    if (!wi) { si = fallback.in; wi = 1; }
    if (!wo) { so = fallback.out; wo = 1; }
  }
  return { in: si / wi, out: so / wo };
}

export interface ProviderSlice {
  revenue: number;
  byok: number;
  tokens: number;
  /** token-weighted effective prices, for display */
  priceIn: number;
  priceOut: number;
}

export interface Revenue {
  revenue: number; // USD, incl. BYOK
  byok: number; // USD paid directly to providers via BYOK keys
  tokens: number;
  prompt: number;
  completion: number;
  cached: number;
  byokTokens: number;
  requests: number;
  /** null when per-provider volumes weren't loaded */
  providers: Map<string, ProviderSlice> | null;
  daily: { day: string; revenue: number; byProvider: Record<string, number> }[];
}

export function emptyRevenue(): Revenue {
  return { revenue: 0, byok: 0, tokens: 0, prompt: 0, completion: 0, cached: 0, byokTokens: 0, requests: 0, providers: null, daily: [] };
}

export function computeRevenue(base: ModelBase, pt: ProviderTokens | null, days: string[]): Revenue {
  const out = emptyRevenue();
  if (pt) out.providers = new Map();
  const acc = new Map<string, { rev: number; byok: number; tok: number; inW: number; outW: number }>();

  for (const day of days) {
    const u = base.usage[day];
    const T = u ? u.p + u.c : 0;
    if (!u || T <= 0) {
      out.daily.push({ day, revenue: 0, byProvider: {} });
      continue;
    }
    out.tokens += T;
    out.prompt += u.p;
    out.completion += u.c;
    out.cached += u.cached;
    out.byokTokens += u.bp + u.bc;
    out.requests += u.req;

    // Per-provider volumes and prices for this day.
    const slices: { slug: string; tok: number; price: Price }[] = [];
    if (pt) {
      for (const [slug, series] of Object.entries(pt)) {
        const tok = series[day] ?? 0;
        if (tok > 0) slices.push({ slug, tok, price: providerPrice(base, slug, day) });
      }
    }
    const S = slices.reduce((s, x) => s + x.tok, 0);
    const mp = modelPrice(base, day);
    let pin = mp.in, pout = mp.out;
    if (S > 0) {
      pin = slices.reduce((s, x) => s + x.tok * x.price.in, 0) / S;
      pout = slices.reduce((s, x) => s + x.tok * x.price.out, 0) / S;
    }
    const rev = base.free ? 0 : (u.p * pin + u.c * pout) / 1e6;
    const byok = base.free ? 0 : (u.bp * pin + u.bc * pout) / 1e6;
    out.revenue += rev;
    out.byok += byok;

    const byProvider: Record<string, number> = {};
    if (S > 0) {
      const r = u.p / T;
      slices.forEach((x) => {
        // This provider's slice of the day's tokens (scaled so slices add up to the model's total),
        // priced at its own rates. The slices sum exactly to `rev` and `byok` above.
        const tok = (T * x.tok) / S;
        const pRev = base.free ? 0 : (tok * (r * x.price.in + (1 - r) * x.price.out)) / 1e6;
        const pByok = base.free ? 0 : ((x.tok / S) * (u.bp * x.price.in + u.bc * x.price.out)) / 1e6;
        byProvider[x.slug] = pRev;
        const a = acc.get(x.slug) ?? { rev: 0, byok: 0, tok: 0, inW: 0, outW: 0 };
        a.rev += pRev;
        a.byok += pByok;
        a.tok += tok;
        a.inW += tok * x.price.in;
        a.outW += tok * x.price.out;
        acc.set(x.slug, a);
      });
    }
    out.daily.push({ day, revenue: rev, byProvider });
  }

  if (out.providers) {
    for (const [slug, a] of acc) {
      out.providers.set(slug, {
        revenue: a.rev,
        byok: a.byok,
        tokens: a.tok,
        priceIn: a.tok ? a.inW / a.tok : 0,
        priceOut: a.tok ? a.outW / a.tok : 0,
      });
    }
  }
  return out;
}

/** Average revenue per token over the given days ($ per token). Useful for pricing app traffic. */
export function revenuePerToken(base: ModelBase, pt: ProviderTokens | null, days: string[]): number {
  const r = computeRevenue(base, pt, days);
  return r.tokens ? r.revenue / r.tokens : 0;
}

export interface ProviderModelRevenue {
  revenue: number;
  byok: number; // estimated: this provider's share of the model's BYOK input/output tokens, at its prices
  tokens: number;
  priceIn: number;
  priceOut: number;
  daily: number[];
}

/**
 * Revenue one provider earned on one model: its daily token volume × its own effective price that day,
 * split into input/output by the model's daily mix. Equals that provider's slice of computeRevenue().
 */
export function providerRevenue(base: ModelBase, provider: string, series: Record<string, number>, days: string[]): ProviderModelRevenue {
  const out: ProviderModelRevenue = { revenue: 0, byok: 0, tokens: 0, priceIn: 0, priceOut: 0, daily: [] };
  let tp = 0, tc = 0;
  for (const u of Object.values(base.usage)) { tp += u.p; tc += u.c; }
  const avgR = tp + tc ? tp / (tp + tc) : 0.9;
  let inW = 0, outW = 0;
  for (const day of days) {
    const tok = series[day] ?? 0;
    if (!(tok > 0)) { out.daily.push(0); continue; }
    const u = base.usage[day];
    const T = u ? u.p + u.c : 0;
    const r = T ? u!.p / T : avgR;
    const price = providerPrice(base, provider, day);
    const rev = base.free ? 0 : (tok * (r * price.in + (1 - r) * price.out)) / 1e6;
    out.revenue += rev;
    out.byok += T && !base.free ? ((tok / T) * (u!.bp * price.in + u!.bc * price.out)) / 1e6 : 0;
    out.tokens += tok;
    inW += tok * price.in;
    outW += tok * price.out;
    out.daily.push(rev);
  }
  out.priceIn = out.tokens ? inW / out.tokens : 0;
  out.priceOut = out.tokens ? outW / out.tokens : 0;
  return out;
}

/** Token-weighted effective price across the providers in a revenue result (null without provider data). */
export function blendedPrice(r: Revenue): Price | null {
  if (!r.providers?.size) return null;
  let tok = 0, pin = 0, pout = 0;
  r.providers.forEach((p) => {
    tok += p.tokens;
    pin += p.priceIn * p.tokens;
    pout += p.priceOut * p.tokens;
  });
  return tok ? { in: pin / tok, out: pout / tok } : null;
}
