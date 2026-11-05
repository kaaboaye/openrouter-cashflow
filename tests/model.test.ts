import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBase, computeRevenue, listedPrices, providerPrice, providerRevenue, providersOf, endpointKind } from '../src/core/model.ts';
import type { ActivityRow, EffectivePricing, EndpointStat } from '../src/core/types.ts';

const day = (d: string) => `${d} 00:00:00`;

function activity(d: string, p: number, c: number, bp = 0, bc = 0): ActivityRow {
  return {
    date: day(d),
    model_permaslug: 'acme/m-1',
    variant: 'standard',
    total_prompt_tokens: p,
    total_completion_tokens: c,
    total_native_tokens_cached: 0,
    total_native_tokens_reasoning: 0,
    total_byok_prompt_tokens: bp,
    total_byok_completion_tokens: bc,
    count: 1,
  };
}

const pricing: EffectivePricing = {
  weightedInputPrice: 1,
  weightedOutputPrice: 10,
  weightedCacheHitRate: 0.5,
  providerSummaries: [
    { endpointId: 'a1', providerName: 'Alpha (1)', providerSlug: 'alpha', effectiveInputPrice: 0.5, effectiveOutputPrice: 8, cacheHitRate: 0.9, totalTokens: 300 },
    { endpointId: 'a2', providerName: 'Alpha (2)', providerSlug: 'alpha', effectiveInputPrice: 1.5, effectiveOutputPrice: 8, cacheHitRate: 0.5, totalTokens: 100 },
    { endpointId: 'b1', providerName: 'Beta', providerSlug: 'beta', effectiveInputPrice: 2, effectiveOutputPrice: 12, cacheHitRate: 0.1, totalTokens: 600 },
  ],
  endpointNames: { a1: 'Alpha (1)', a2: 'Alpha (2)', b1: 'Beta' },
  endpointRawNames: { a1: 'Alpha', a2: 'Alpha', b1: 'Beta' },
  endpointProviderSlugs: { a1: 'alpha', a2: 'alpha', b1: 'beta' },
  inputChartData: [{ x: day('2026-01-02'), y: { a1: 0.4, a2: 1.6, b1: 2.2 } }],
  outputChartData: [{ x: day('2026-01-02'), y: { a1: 8, a2: 8, b1: 12 } }],
};

test('provider price blends endpoints by 1d volume, using the daily chart when present', () => {
  const base = buildBase('acme/m-1', 'standard', [], pricing);
  const onChartDay = providerPrice(base, 'alpha', '2026-01-02');
  assert.equal(onChartDay.in, (0.4 * 300 + 1.6 * 100) / 400);
  assert.equal(onChartDay.out, 8);
  const offChart = providerPrice(base, 'alpha', '2026-01-01');
  assert.equal(offChart.in, (0.5 * 300 + 1.5 * 100) / 400);
});

test('model revenue = prompt × blended input + completion × blended output; providers sum to the total', () => {
  const base = buildBase('acme/m-1', 'standard', [activity('2026-01-02', 900_000_000, 100_000_000, 90_000_000, 10_000_000)], pricing);
  const pt = { alpha: { '2026-01-02': 400_000_000 }, beta: { '2026-01-02': 600_000_000 } };
  const r = computeRevenue(base, pt, ['2026-01-02']);

  const alphaIn = (0.4 * 300 + 1.6 * 100) / 400;
  const pin = (0.4 * alphaIn + 0.6 * 2.2);
  const pout = 0.4 * 8 + 0.6 * 12;
  const expected = (900 * pin + 100 * pout); // tokens in millions
  assert.ok(Math.abs(r.revenue - expected) < 1e-6, `${r.revenue} vs ${expected}`);
  assert.ok(Math.abs(r.byok - expected * 0.1) < 1e-6);

  const sum = [...r.providers!.values()].reduce((s, p) => s + p.revenue, 0);
  assert.ok(Math.abs(sum - r.revenue) < 1e-6);
  const tok = [...r.providers!.values()].reduce((s, p) => s + p.tokens, 0);
  assert.equal(tok, 1_000_000_000);
  // Beta is pricier per token, so it takes more than its 60% token share of revenue.
  assert.ok(r.providers!.get('beta')!.revenue / r.revenue > 0.6);
});

test('without provider volumes the 30d weighted price is used', () => {
  const base = buildBase('acme/m-1', 'standard', [activity('2026-01-02', 2_000_000, 1_000_000)], pricing);
  const r = computeRevenue(base, null, ['2026-01-02', '2026-01-03']);
  assert.equal(r.revenue, 2 * 1 + 1 * 10);
  assert.equal(r.providers, null);
  assert.equal(r.daily.length, 2);
});

test('free variants earn nothing', () => {
  const base = buildBase('acme/m-1', 'free', [activity('2026-01-02', 2_000_000, 1_000_000)], pricing);
  assert.equal(computeRevenue(base, null, ['2026-01-02']).revenue, 0);
});


test('providerRevenue matches the provider slice of computeRevenue when volumes add up', () => {
  const base = buildBase('acme/m-1', 'standard', [activity('2026-01-02', 900_000_000, 100_000_000)], pricing);
  const pt = { alpha: { '2026-01-02': 400_000_000 }, beta: { '2026-01-02': 600_000_000 } };
  const all = computeRevenue(base, pt, ['2026-01-02']);
  for (const slug of ['alpha', 'beta']) {
    const one = providerRevenue(base, slug, pt[slug as 'alpha'], ['2026-01-02']);
    assert.ok(Math.abs(one.revenue - all.providers!.get(slug)!.revenue) < 1e-9);
  }
});

test('without effective prices (batch), list prices are used with the cache-read share', () => {
  const zero: EffectivePricing = { ...pricing, weightedInputPrice: 0, weightedOutputPrice: 0, providerSummaries: [], inputChartData: [], outputChartData: [], endpointProviderSlugs: { x1: 'alpha' } };
  const row = { ...activity('2026-01-02', 1_000_000, 1_000_000), total_native_tokens_cached: 800_000 };
  const base = buildBase('acme/m-1', 'batch', [row], zero, { alpha: { in: 2, out: 10, cacheRead: 0.2 } });
  const r = computeRevenue(base, { alpha: { '2026-01-02': 2_000_000 } }, ['2026-01-02']);
  // input: 20% uncached at $2 + 80% cached at $0.2 = $0.56/M; output $10/M
  assert.ok(Math.abs(r.revenue - (0.56 + 10)) < 1e-9, String(r.revenue));
  const noPt = computeRevenue(base, null, ['2026-01-02']);
  assert.ok(Math.abs(noPt.revenue - (0.56 + 10)) < 1e-9);
});

test('BYOK is priced by its own input/output split, the same way on every page', () => {
  // 900M in + 100M out; all of the output is BYOK
  const base = buildBase('acme/m-1', 'standard', [activity('2026-01-02', 900_000_000, 100_000_000, 0, 100_000_000)], pricing);
  const pt = { alpha: { '2026-01-02': 400_000_000 }, beta: { '2026-01-02': 600_000_000 } };
  const all = computeRevenue(base, pt, ['2026-01-02']);
  const pout = 0.4 * 8 + 0.6 * 12;
  assert.ok(Math.abs(all.byok - 100 * pout) < 1e-9, String(all.byok));
  let sum = 0;
  for (const slug of ['alpha', 'beta'] as const) {
    const one = providerRevenue(base, slug, pt[slug], ['2026-01-02']);
    assert.ok(Math.abs(one.byok - all.providers!.get(slug)!.byok) < 1e-9, `${slug} ${one.byok} vs ${all.providers!.get(slug)!.byok}`);
    sum += one.byok;
  }
  assert.ok(Math.abs(sum - all.byok) < 1e-9);
});

test('providers known only from list prices are still discovered', () => {
  const none: EffectivePricing = { ...pricing, weightedInputPrice: 0, weightedOutputPrice: 0, providerSummaries: [], inputChartData: [], outputChartData: [], endpointProviderSlugs: {}, endpointNames: {}, endpointRawNames: {} };
  const base = buildBase('acme/m-1', 'batch', [activity('2026-01-02', 1_000_000, 0)], none, { gamma: { in: 1, out: 2, cacheRead: 0.1, name: 'Gamma' } });
  assert.deepEqual(providersOf(base), ['gamma']);
  assert.equal(base.providerNames.gamma, 'Gamma');
  const r = computeRevenue(base, { gamma: { '2026-01-02': 1_000_000 } }, ['2026-01-02']);
  assert.ok(Math.abs(r.providers!.get('gamma')!.revenue - 1) < 1e-9);
});


test('list prices are taken as charged (the discount field is informational)', () => {
  const l = listedPrices([
    { id: 'e1', provider_slug: 'google-vertex/global', provider_name: 'Google Vertex', variant: 'batch', is_free: false, pricing: { prompt: '0.000001', completion: '0.000005', input_cache_read: '0.00000005', discount: 0.5 } },
  ])!;
  const g = l['google-vertex'];
  assert.equal(g.in, 1);
  assert.equal(g.out, 5);
  assert.ok(Math.abs(g.cacheRead - 0.05) < 1e-12);
  assert.equal(g.name, 'Google Vertex');
});

test('a historical price survives when its endpoint has no recent traffic', () => {
  // old endpoint o1 served Jan 1 at $1/M and is idle now; its replacement o2 is busy now at $10/M
  const p: EffectivePricing = {
    ...pricing,
    providerSummaries: [{ endpointId: 'o2', providerName: 'Old (2)', providerSlug: 'old', effectiveInputPrice: 10, effectiveOutputPrice: 10, cacheHitRate: 0, totalTokens: 500 }],
    endpointProviderSlugs: { o1: 'old', o2: 'old' },
    endpointNames: { o1: 'Old (1)', o2: 'Old (2)' },
    endpointRawNames: { o1: 'Old', o2: 'Old' },
    inputChartData: [{ x: day('2026-01-01'), y: { o1: 1 } }],
    outputChartData: [{ x: day('2026-01-01'), y: { o1: 1 } }],
  };
  const base = buildBase('acme/m-1', 'standard', [], p);
  assert.deepEqual(providerPrice(base, 'old', '2026-01-01'), { in: 1, out: 1 });
});

test('a paid model with no effective or list prices is "price unknown", not $0', () => {
  const none: EffectivePricing = { ...pricing, weightedInputPrice: 0, weightedOutputPrice: 0, providerSummaries: [], inputChartData: [], outputChartData: [], endpointProviderSlugs: {}, endpointNames: {}, endpointRawNames: {} };
  assert.equal(buildBase('acme/m-1', 'standard', [], none, {}).priceUnknown, true);
  assert.equal(buildBase('acme/m-1', 'free', [], none, {}).priceUnknown, false);
  assert.equal(buildBase('acme/m-1', 'standard', [], pricing).priceUnknown, false);
  assert.equal(buildBase('acme/m-1', 'batch', [], none, { a: { in: 1, out: 2, cacheRead: 0.1 } }).priceUnknown, false);
});

test('a model whose every endpoint is free is free ($0), not "price unknown"', () => {
  const none: EffectivePricing = { ...pricing, weightedInputPrice: 0, weightedOutputPrice: 0, providerSummaries: [], inputChartData: [], outputChartData: [], endpointProviderSlugs: {}, endpointNames: {}, endpointRawNames: {} };
  const b = buildBase('stealth/crouton-alpha', 'standard', [], none, {}, { allFree: true });
  assert.equal(b.free, true);
  assert.equal(b.priceUnknown, false);
});

test('rerank prices that live only in display_pricing are list prices; per-second video is not "free"', () => {
  const rerank = {
    id: 'e1', provider_slug: 'voyageai', variant: 'standard', is_free: false,
    pricing: { prompt: '0', completion: '0' },
    display_pricing: [{ kind: 'token', sku_label: 'Input tokens', price: '0.00000002' }],
  } as EndpointStat;
  const video = {
    id: 'e2', provider_slug: 'runway', variant: 'standard', is_free: false,
    pricing: { prompt: '0', completion: '0' },
    display_pricing: [{ kind: 'unit', sku_label: 'Video Output', price: '0.12' }],
  } as EndpointStat;
  const stealth = { id: 'e3', provider_slug: 'stealth', variant: 'standard', is_free: true, pricing: { prompt: '0', completion: '0' } } as EndpointStat;
  assert.ok(Math.abs(listedPrices([rerank])!.voyageai.in - 0.02) < 1e-9);
  assert.deepEqual(endpointKind([rerank]), { allFree: false, nonToken: false });
  assert.deepEqual(endpointKind([video]), { allFree: false, nonToken: true });
  assert.deepEqual(endpointKind([stealth]), { allFree: true, nonToken: false });
  assert.deepEqual(endpointKind([]), { allFree: false, nonToken: false });
});
