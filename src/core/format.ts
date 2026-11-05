// Number formatting via Intl (compact notation handles units, rounding and unit rollover: 999,999 -> "1M").

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumSignificantDigits: 3 });
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumSignificantDigits: 3 });
const usdPrecise = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumSignificantDigits: 4 });
const price2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const price3 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 3, maximumFractionDigits: 3 });

/** "$6.03M", "$450K", "$540"; amounts under a dollar show as "<$1". */
export function money(v: number, opts: { precise?: boolean } = {}): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '$0';
  if (Math.abs(v) < 1) return v < 0 ? '−<$1' : '<$1';
  return (opts.precise ? usdPrecise : usd).format(v);
}

/** $/M price, like OpenRouter shows it: "$20.00", "$0.675" */
export function perM(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '$0';
  return (v >= 1 ? price2 : price3).format(v);
}

/** "6.67T", "450B", "999" */
export function tokens(v: number): string {
  return compact.format(Math.abs(v));
}

export function pct(v: number, digits = 1): string {
  if (!Number.isFinite(v)) return '—';
  if (v > 0 && v < 0.001) return '<0.1%';
  return new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
}

export function change(cur: number, prev: number): number | null {
  if (!(prev > 0)) return null;
  return cur / prev - 1;
}
