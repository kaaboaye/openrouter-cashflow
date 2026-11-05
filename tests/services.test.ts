import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractArray } from '../src/core/services.ts';

test('extractArray tells "missing or broken" (null) from "empty" ([])', () => {
  assert.deepEqual(extractArray('xx"daily":[{"x":"a","ys":{"m":1}}],"weekly":[]', '"daily":'), [{ x: 'a', ys: { m: 1 } }]);
  assert.deepEqual(extractArray('"daily":[]', '"daily":'), []);
  assert.equal(extractArray('no chart here', '"daily":'), null);
  assert.equal(extractArray('"daily":[{"x":', '"daily":'), null);
  assert.deepEqual(extractArray('"daily":[{"s":"a ] b"}]', '"daily":'), [{ s: 'a ] b' }]);
});

test('extractArray does not borrow a later array when the key holds something else', () => {
  assert.equal(extractArray('"daily":null,"weekly":[]', '"daily":'), null);
  assert.deepEqual(extractArray('"daily": [1]', '"daily":'), [1]);
});

import { priceApp } from '../src/core/services.ts';
import { buildBase } from '../src/core/model.ts';
import type { EffectivePricing } from '../src/core/types.ts';

test('a day whose models could not be priced is estimated at the period rate, not $0', () => {
  const pricing = {
    weightedInputPrice: 1, weightedOutputPrice: 1, weightedCacheHitRate: 0, providerSummaries: [],
    endpointNames: {}, endpointRawNames: {}, endpointProviderSlugs: {}, inputChartData: [], outputChartData: [],
  } as EffectivePricing;
  const act = (d: string) => ({
    date: `${d} 00:00:00`, model_permaslug: 'a/ok', variant: 'standard', total_prompt_tokens: 1_000_000, total_completion_tokens: 0,
    total_native_tokens_cached: 0, total_native_tokens_reasoning: 0, total_byok_prompt_tokens: 0, total_byok_completion_tokens: 0, count: 1,
  });
  const ok = { base: buildBase('a/ok', 'standard', [act('2026-01-01'), act('2026-01-02')], pricing), pt: {} };
  const models = new Map([['a/ok', ok], ['b/broken', null]]);
  const r = priceApp('/apps/x', [
    { day: '2026-01-01', ys: { 'a/ok': 2_000_000 } }, // $1/M -> $2
    { day: '2026-01-02', ys: { 'b/broken': 3_000_000 } }, // unpriceable -> period rate $1/M -> $3
  ], models);
  assert.equal(r.spend, 5);
  assert.equal(r.daily.find((d) => d.day === '2026-01-02')!.spend, 3);
  assert.ok(Math.abs(r.pricedShare - 0.4) < 1e-9);
  // shown as an estimate, not as spend on other models
  assert.equal(r.dailyByModel['2026-01-02'].Estimated, 3);
  assert.equal(r.dailyByModel['2026-01-02'].Others, undefined);
});

test('a window with no priceable day uses the fallback rate instead of failing', () => {
  const models = new Map([['b/broken', null]]);
  const rows = [{ day: '2026-01-02', ys: { 'b/broken': 2_000_000 } }];
  assert.throws(() => priceApp('/apps/x', rows, models));
  const r = priceApp('/apps/x', rows, models, 1.5 / 1e6);
  assert.equal(r.spend, 3);
  assert.equal(r.pricedShare, 0);
  assert.equal(r.dailyByModel['2026-01-02'].Estimated, 3);
});

test('a model with no price data any more is priced like "Others", never as a priced $0', () => {
  const priced = {
    weightedInputPrice: 1, weightedOutputPrice: 1, weightedCacheHitRate: 0, providerSummaries: [],
    endpointNames: {}, endpointRawNames: {}, endpointProviderSlugs: {}, inputChartData: [], outputChartData: [],
  } as EffectivePricing;
  const none = { ...priced, weightedInputPrice: 0, weightedOutputPrice: 0 } as EffectivePricing;
  const act = (slug: string) => ({
    date: '2026-01-01 00:00:00', model_permaslug: slug, variant: 'standard', total_prompt_tokens: 1_000_000, total_completion_tokens: 0,
    total_native_tokens_cached: 0, total_native_tokens_reasoning: 0, total_byok_prompt_tokens: 0, total_byok_completion_tokens: 0, count: 1,
  });
  const gone = { base: buildBase('c/gone', 'standard', [act('c/gone')], none, {}), pt: {} };
  assert.equal(gone.base.priceUnknown, true);
  const ok = { base: buildBase('a/ok', 'standard', [act('a/ok')], priced), pt: {} };
  const r = priceApp('/apps/x', [{ day: '2026-01-01', ys: { 'a/ok': 1_000_000, 'c/gone': 1_000_000 } }], new Map([['a/ok', ok], ['c/gone', gone]]));
  assert.equal(r.spend, 2); // the unknown model's tokens at the day's average ($1/M), not $0
  assert.equal(r.pricedShare, 0.5);
  assert.equal(r.byModel.some((m) => m.permaslug === 'c/gone'), false);
  assert.equal(r.dailyByModel['2026-01-01'].Others, 1);
});

test("an app's tokens on a model with a free variant are split by the market's paid/free mix", () => {
  const pricing = {
    weightedInputPrice: 1, weightedOutputPrice: 1, weightedCacheHitRate: 0, providerSummaries: [],
    endpointNames: {}, endpointRawNames: {}, endpointProviderSlugs: {}, inputChartData: [], outputChartData: [],
  } as EffectivePricing;
  const act = {
    date: '2026-01-01 00:00:00', model_permaslug: 'n/ultra', variant: 'standard', total_prompt_tokens: 10_000_000, total_completion_tokens: 0,
    total_native_tokens_cached: 0, total_native_tokens_reasoning: 0, total_byok_prompt_tokens: 0, total_byok_completion_tokens: 0, count: 1,
  };
  const m = { base: buildBase('n/ultra', 'standard', [act], pricing), pt: {} };
  // market that day: 10M paid, 990M free -> 1% paid
  const free = new Map([['n/ultra', { '2026-01-01': 990_000_000 }]]);
  const r = priceApp('/apps/x', [{ day: '2026-01-01', ys: { 'n/ultra': 100_000_000 } }], new Map([['n/ultra', m]]), undefined, free);
  assert.ok(Math.abs(r.spend - 1) < 1e-9); // 1M paid tokens at $1/M, not 100M
  assert.equal(r.pricedShare, 1);
  assert.equal(r.byModel[0].freeTokens, 99_000_000);
  // never more paid tokens than the paid variant served in total
  const big = priceApp('/apps/x', [{ day: '2026-01-01', ys: { 'n/ultra': 5_000_000_000 } }], new Map([['n/ultra', m]]), undefined, free);
  assert.ok(big.spend <= 10 + 1e-9);
});

test('a failed free-variant lookup caps paid tokens at the paid variant and flags the split as unknown', () => {
  const pricing = {
    weightedInputPrice: 1, weightedOutputPrice: 1, weightedCacheHitRate: 0, providerSummaries: [],
    endpointNames: {}, endpointRawNames: {}, endpointProviderSlugs: {}, inputChartData: [], outputChartData: [],
  } as EffectivePricing;
  const act = {
    date: '2026-01-01 00:00:00', model_permaslug: 'n/ultra', variant: 'standard', total_prompt_tokens: 10_000_000, total_completion_tokens: 0,
    total_native_tokens_cached: 0, total_native_tokens_reasoning: 0, total_byok_prompt_tokens: 0, total_byok_completion_tokens: 0, count: 1,
  };
  const m = { base: buildBase('n/ultra', 'standard', [act], pricing), pt: {} };
  const r = priceApp('/apps/x', [{ day: '2026-01-01', ys: { 'n/ultra': 100_000_000 } }], new Map([['n/ultra', m]]), undefined, new Map([['n/ultra', null]]));
  assert.ok(Math.abs(r.spend - 10) < 1e-9); // at most the paid variant's 10M tokens, not 100M
  assert.equal(r.splitUnknown, 100_000_000);
  assert.equal(r.byModel[0].splitUnknown, 100_000_000);
  assert.equal(r.pricedShare, 1); // priced from its own model (capped); the "may be high" note covers it
});

test('a model offered only as :free (no price for its plain variant) adds its free share at $0, not at the average', () => {
  const pricing = {
    weightedInputPrice: 1, weightedOutputPrice: 1, weightedCacheHitRate: 0, providerSummaries: [],
    endpointNames: {}, endpointRawNames: {}, endpointProviderSlugs: {}, inputChartData: [], outputChartData: [],
  } as EffectivePricing;
  const none = { ...pricing, weightedInputPrice: 0, weightedOutputPrice: 0 } as EffectivePricing;
  const act = (slug: string, p: number) => ({
    date: '2026-01-01 00:00:00', model_permaslug: slug, variant: 'standard', total_prompt_tokens: p, total_completion_tokens: 0,
    total_native_tokens_cached: 0, total_native_tokens_reasoning: 0, total_byok_prompt_tokens: 0, total_byok_completion_tokens: 0, count: 1,
  });
  const ok = { base: buildBase('a/ok', 'standard', [act('a/ok', 1_000_000)], pricing), pt: {} };
  const dots = { base: buildBase('d/dots', 'standard', [act('d/dots', 1_000_000)], none, {}), pt: {} };
  assert.equal(dots.base.priceUnknown, true);
  const r = priceApp(
    '/apps/x',
    [{ day: '2026-01-01', ys: { 'a/ok': 1_000_000, 'd/dots': 100_000_000 } }],
    new Map([['a/ok', ok], ['d/dots', dots]]),
    undefined,
    new Map([['d/dots', { '2026-01-01': 99_000_000 }]]), // 1% paid, 99% free in the market
  );
  // a/ok: $1; dots: 99M free at $0 (priced), 1M unpriced at the day's average ($1 / 100M priced tokens) -> $0.01
  assert.ok(Math.abs(r.spend - 1.01) < 1e-9, String(r.spend));
  assert.ok(Math.abs(r.pricedShare - 100 / 101) < 1e-9);
});
