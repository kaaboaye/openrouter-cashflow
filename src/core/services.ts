// Higher-level questions the UI asks: "what did this model / app / provider earn in this period?"

import { Priority, rsc } from './api.ts';
import { cached } from './cache.ts';
import { loadModel, loadVariantDaily, resolveSlug, type ModelData, type ModelRef } from './data.ts';
import { dayOf, periodDays, type Period } from './days.ts';
import { computeRevenue, type Revenue } from './model.ts';

export interface ModelRevenue {
  ref: ModelRef;
  data: ModelData;
  revenue: Revenue;
}

export async function modelRevenueBySlug(slug: string, period: Period, prio: number = Priority.visible): Promise<ModelRevenue | null> {
  const ref = await resolveSlug(slug, prio);
  if (!ref) return null;
  const data = await loadModel(ref.permaslug, ref.variant, prio);
  return { ref, data, revenue: computeRevenue(data.base, data.pt, periodDays(period)) };
}

// ---------- apps ----------

export interface AppUsage {
  /** day -> model permaslug (or "Others") -> tokens; last 30 days incl. today */
  daily: { day: string; ys: Record<string, number> }[];
}

/** Path of an app's page: "/apps/claude-code", or "/apps/url/<encoded origin url>" for apps without a slug. */
export function appPathOf(app: { slug: string | null; origin_url: string | null }): string {
  return app.slug ? `/apps/${app.slug}` : `/apps/url/${encodeURIComponent(app.origin_url ?? '')}`;
}

/** Pull the app's daily per-model token chart out of its page's RSC payload. */
export function loadAppUsage(appPath: string, prio: number = Priority.section): Promise<AppUsage> {
  return cached(`app:${appPath}`, async () => {
    const text = await rsc(appPath, prio);
    const daily = extractArray(text, '"daily":');
    // A 200 response without the usage chart (streamed error, redirect…) is a failure, not an idle app:
    // throwing keeps it out of the cache.
    if (!daily) throw new Error(`no usage data in ${appPath}`);
    return { daily: daily.map((p: { x: string; ys: Record<string, number> }) => ({ day: dayOf(p.x), ys: p.ys })) };
  });
}

/** Find `key` in a flight payload and JSON-parse the array that follows it; null when it isn't there or doesn't parse. */
export function extractArray(text: string, key: string): any[] | null {
  const i = text.indexOf(key);
  if (i < 0) return null;
  // the value right after the key must be an array (e.g. not `null` followed by some other array)
  let start = i + key.length;
  while (start < text.length && /\s/.test(text[start])) start++;
  if (text[start] !== '[') return null;
  let depth = 0, inStr = false, esc = false;
  for (let k = start; k < text.length; k++) {
    const ch = text[k];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) {
      try {
        const v = JSON.parse(text.slice(start, k + 1));
        return Array.isArray(v) ? v : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export interface AppSpend {
  spend: number;
  tokens: number;
  /** tokens priced with a known model price (rest uses the app's own average) */
  pricedShare: number;
  /** tokens on models whose free/paid split couldn't be loaded (counted as paid up to the paid variant's total) */
  splitUnknown: number;
  /** nothing in the window could be priced from its models: all of it is at the caller's fallback rate */
  fromFallbackRate: boolean;
  /** freeTokens: the part of `tokens` estimated to have gone to the model's free variant (see priceApp) */
  byModel: { permaslug: string; variant: string; tokens: number; spend: number; freeTokens: number; splitUnknown: number }[];
  daily: { day: string; spend: number }[];
  /** day -> "permaslug|variant", "Others" (unnamed models) or "Estimated" (no model priceable that day) -> spend */
  dailyByModel: Record<string, Record<string, number>>;
}

const splitKey = (k: string) => {
  const m = k.match(/^(.*):(free|batch)$/);
  return m ? { permaslug: m[1], variant: m[2] } : { permaslug: k, variant: 'standard' };
};

/**
 * Spend of an app = Σ over days and models of (tokens the app sent to the model that day) × (the
 * model's revenue per token that day). Tokens in the "Others" bucket use the app's own average for the day.
 */
export async function appSpend(
  appPath: string,
  period: Period | string[],
  prio: number = Priority.section,
  /** $/token to use when no day in the window can be priced (instead of failing) */
  fallbackRate?: number,
): Promise<AppSpend> {
  const usage = await loadAppUsage(appPath, prio);
  const days = new Set(Array.isArray(period) ? period : periodDays(period));
  const rows = usage.daily.filter((d) => days.has(d.day));
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r.ys)).filter((k) => k !== 'Others'))];
  const models = new Map<string, ModelData | null>();
  // null: the lookup failed (not the same as "no free traffic")
  const freeDaily = new Map<string, Record<string, number> | null>();
  await Promise.all(
    keys.map(async (k) => {
      const { permaslug, variant } = splitKey(k);
      const [m, free] = await Promise.all([
        loadModel(permaslug, variant, prio).catch(() => null),
        // an app's chart files a model's free-variant traffic under the plain key too
        variant === 'standard' ? loadVariantDaily(permaslug, 'free', prio).catch(() => null) : undefined,
      ]);
      models.set(k, m);
      if (free !== undefined) freeDaily.set(k, free);
    }),
  );
  return priceApp(appPath, rows, models, fallbackRate, freeDaily);
}

/** Pure part of appSpend: price an app's daily per-model tokens with each model's daily revenue per token. */
export function priceApp(
  appPath: string,
  rows: { day: string; ys: Record<string, number> }[],
  models: Map<string, ModelData | null>,
  fallbackRate?: number,
  /** per plain key: the model's free variant's daily tokens across OpenRouter (null: couldn't be loaded) */
  freeDaily?: Map<string, Record<string, number> | null>,
): AppSpend {
  const byModel = new Map<string, { tokens: number; spend: number; freeTokens: number; splitUnknown: number }>();
  const daily: AppSpend['daily'] = [];
  const dailyByModel: AppSpend['dailyByModel'] = {};
  let spend = 0, tokens = 0, priced = 0, pricedSpend = 0, splitUnknown = 0;
  const unpricedDays: { day: string; tokens: number; perModel: Record<string, number> }[] = [];
  for (const r of rows) {
    let daySpend = 0, dayPricedTok = 0, dayTok = 0;
    const perModel: Record<string, number> = (dailyByModel[r.day] = {});
    for (const [k, tok] of Object.entries(r.ys)) {
      dayTok += tok;
      if (k === 'Others') continue;
      const m = models.get(k);
      // no data: priced like "Others" (the day's average)
      if (!m) continue;
      // App charts don't separate a model's free variant: split the app's tokens by the market's paid/free
      // mix that day, and never count more as paid than the paid variant served in total.
      const fd = freeDaily?.get(k);
      const freeMarket = fd?.[r.day] ?? 0;
      const u = m.base.usage[r.day];
      const paidMarket = u ? u.p + u.c : 0;
      if (m.base.priceUnknown) {
        // No price for the paid side (any more): its share is priced like "Others", but the free variant's
        // share is known to cost $0 (e.g. models offered only as :free, filed under their plain name).
        if (freeMarket > 0) {
          const freeTok = tok - Math.min((tok * paidMarket) / (paidMarket + freeMarket), paidMarket);
          dayPricedTok += freeTok;
        }
        continue;
      }
      const rev = computeRevenue(m.base, m.pt, [r.day]);
      // If the free variant's traffic couldn't be loaded the split is unknown: count as paid at most what the
      // paid variant served in total (an upper bound) and flag it (`splitUnknown`: "may be high").
      const unknownSplit = fd === null && !m.base.free;
      if (unknownSplit) splitUnknown += tok;
      const paidTok = m.base.free
        ? 0
        : unknownSplit
          ? Math.min(tok, paidMarket)
          : freeMarket > 0
            ? Math.min((tok * paidMarket) / (paidMarket + freeMarket), paidMarket)
            : tok;
      if (!(rev.tokens > 0) && !m.base.free && paidTok > 0) continue;
      const s = paidTok > 0 ? (paidTok * rev.revenue) / rev.tokens : 0;
      daySpend += s;
      dayPricedTok += tok;
      const { permaslug, variant } = splitKey(k);
      perModel[`${permaslug}|${variant}`] = s;
      const acc = byModel.get(k) ?? { tokens: 0, spend: 0, freeTokens: 0, splitUnknown: 0 };
      acc.tokens += tok;
      acc.spend += s;
      if (!m.base.free) acc.freeTokens += tok - paidTok;
      if (unknownSplit) acc.splitUnknown += tok;
      byModel.set(k, acc);
    }
    priced += dayPricedTok;
    pricedSpend += daySpend;
    tokens += dayTok;
    if (dayTok > 0 && dayPricedTok === 0) {
      // nothing this app used that day could be priced: fill it in below at the period's average rate
      unpricedDays.push({ day: r.day, tokens: dayTok, perModel });
      daily.push({ day: r.day, spend: 0 });
      continue;
    }
    const avg = dayPricedTok ? daySpend / dayPricedTok : 0;
    const rest = (dayTok - dayPricedTok) * avg;
    if (rest > 0) perModel.Others = rest;
    daySpend += rest;
    spend += daySpend;
    daily.push({ day: r.day, spend: daySpend });
  }
  // Every consumer (badges, app page, rankings) must see a pricing outage as a failure, never as "$0".
  if (tokens > 0 && priced === 0 && !(fallbackRate && fallbackRate > 0)) throw new Error(`no model of ${appPath} could be priced`);
  // Days with traffic but no priceable model get the period's average $/token (or, if nothing in the window
  // could be priced, the caller's longer-run rate) instead of a silent $0; pricedShare discloses the share.
  const periodRate = priced ? pricedSpend / priced : fallbackRate ?? 0;
  for (const u of unpricedDays) {
    const est = u.tokens * periodRate;
    u.perModel.Estimated = est; // shown as its own "estimated" series, not as other models
    spend += est;
    const d = daily.find((x) => x.day === u.day);
    if (d) d.spend = est;
  }
  return {
    spend,
    tokens,
    // tokens with an unknown free/paid split were priced from their model (capped): they count as priced, and
    // `splitUnknown` carries the "may be high" warning instead
    pricedShare: tokens ? priced / tokens : 0,
    splitUnknown,
    fromFallbackRate: tokens > 0 && priced === 0,
    byModel: [...byModel.entries()]
      .map(([k, v]) => ({ ...splitKey(k), ...v }))
      .sort((a, b) => b.spend - a.spend),
    daily,
    dailyByModel,
  };
}
