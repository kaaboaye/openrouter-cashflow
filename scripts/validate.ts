// Live check of the revenue model against OpenRouter's own numbers.
// OpenRouter publishes each model's *share* of billed spend (excl. BYOK). Our bottom-up dollar
// estimates, normalised the same way, should line up with it.
//
//   node --experimental-strip-types scripts/validate.ts [topN=40] [period=7d]

import { loadModel, loadRankings } from '../src/core/data.ts';
import { periodDays, type Period } from '../src/core/days.ts';
import { computeRevenue, modelKey } from '../src/core/model.ts';

const topN = Number(process.argv[2] ?? 40);
const period = (process.argv[3] ?? '7d') as Period;
const view = period === '1d' ? 'day' : period === '7d' ? 'week' : 'month';

const spend = await loadRankings(view, 'spend');
const top = spend
  .filter((r) => r.variant !== 'free')
  .sort((a, b) => b.rankingMetricValue - a.rankingMetricValue)
  .slice(0, topN);

const days = periodDays(period);
const t0 = Date.now();
const results = await Promise.all(
  top.map(async (r) => {
    const { base, pt } = await loadModel(r.model_permaslug, r.variant);
    const full = computeRevenue(base, pt, days);
    const simple = computeRevenue(base, null, days);
    return { key: modelKey(r.model_permaslug, r.variant), share: r.rankingMetricValue, full, simple };
  }),
);
console.log(`loaded ${results.length} models in ${((Date.now() - t0) / 1000).toFixed(1)}s, days ${days[0]}..${days.at(-1)}`);

const shareSum = results.reduce((s, r) => s + r.share, 0);
for (const mode of ['full', 'simple'] as const) {
  const billed = results.map((r) => r[mode].revenue - r[mode].byok);
  const sum = billed.reduce((a, b) => a + b, 0);
  const ratios = results.map((r, i) => billed[i] / sum / (r.share / shareSum));
  const sorted = [...ratios].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const within15 = ratios.filter((x) => Math.abs(x - 1) <= 0.15).length;
  console.log(
    `${mode.padEnd(6)} implied billed total ${period}: $${((sum / shareSum) / 1e6).toFixed(1)}M | ratio median ${median.toFixed(3)}, ` +
      `range ${sorted[0].toFixed(2)}–${sorted.at(-1)!.toFixed(2)}, within ±15%: ${within15}/${ratios.length}`,
  );
}
const totalFull = results.reduce((s, r) => s + r.full.revenue, 0);
const providerSum = results.reduce((s, r) => s + [...(r.full.providers?.values() ?? [])].reduce((a, p) => a + p.revenue, 0), 0);
console.log(`provider allocation sums to ${(providerSum / totalFull * 100).toFixed(2)}% of model totals`);
console.log('\nmodel'.padEnd(52), 'rev(full)'.padStart(10), 'byok%'.padStart(7), 'ratio'.padStart(7));
const sumBilled = results.reduce((s, r) => s + r.full.revenue - r.full.byok, 0);
for (const r of results.slice(0, 25)) {
  const ratio = (r.full.revenue - r.full.byok) / sumBilled / (r.share / shareSum);
  console.log(
    r.key.slice(0, 50).padEnd(51),
    `$${(r.full.revenue / 1e6).toFixed(2)}M`.padStart(10),
    `${((r.full.byok / r.full.revenue) * 100).toFixed(1)}`.padStart(7),
    ratio.toFixed(2).padStart(7),
  );
}
