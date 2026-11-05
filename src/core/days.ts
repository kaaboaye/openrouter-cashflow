// OpenRouter aggregates usage per UTC day. "Complete" days end yesterday (UTC).

export type Period = '1d' | '7d' | '30d';

export const PERIOD_DAYS: Record<Period, number> = { '1d': 1, '7d': 7, '30d': 30 };

/** For stat labels: "Revenue · 7 days" */
export const PERIOD_SHORT: Record<Period, string> = { '1d': 'yesterday', '7d': '7 days', '30d': '30 days' };

export const PERIOD_LABEL: Record<Period, string> = {
  '1d': 'Yesterday',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
};

/** "2026-11-02 00:00:00" | "2026-11-02" -> "2026-11-02" */
export const dayOf = (s: string) => s.slice(0, 10);

export function addDays(day: string, n: number): string {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * For a while after midnight UTC OpenRouter's CDN may still serve the previous day's numbers, so data
 * fetched then is only kept briefly and never persisted.
 */
export const SETTLE_MS = 20 * 60 * 1000;
export function inSettlingWindow(now = Date.now()): boolean {
  return now % (24 * 60 * 60 * 1000) < SETTLE_MS;
}

export function lastCompleteDay(now = new Date()): string {
  return addDays(now.toISOString().slice(0, 10), -1);
}

/**
 * Which data a page shows: the last complete day, marked while OpenRouter may still be settling it. Pages
 * and the market reload when this changes: at midnight UTC and again once the settling window is over.
 */
export function dataEpoch(now = new Date()): string {
  return lastCompleteDay(now) + (inSettlingWindow(now.getTime()) ? '~settling' : '');
}

/** The `n` complete days ending at `end` (inclusive), oldest first. */
export function daysEnding(end: string, n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(addDays(end, -i));
  return out;
}

export function periodDays(period: Period, end = lastCompleteDay()): string[] {
  return daysEnding(end, PERIOD_DAYS[period]);
}

/** The period immediately before `period` (same length), for change %. */
export function previousPeriodDays(period: Period, end = lastCompleteDay()): string[] {
  return daysEnding(addDays(end, -PERIOD_DAYS[period]), PERIOD_DAYS[period]);
}

export function formatDay(day: string, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }): string {
  return new Date(day + 'T00:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });
}

/**
 * "Oct 27 – Nov 2 (UTC)" or "Nov 2 (UTC)", matching the chart's date labels. Each date is glued with
 * non-breaking spaces, so narrow tiles wrap around the dash or before "(UTC)", never inside a date.
 */
export function formatRange(days: string[]): string {
  if (!days.length) return '';
  const d = (day: string) => formatDay(day).replace(/ /g, '\u00a0');
  return days.length === 1 ? `${d(days[0])} (UTC)` : `${d(days[0])} – ${d(days[days.length - 1])} (UTC)`;
}
