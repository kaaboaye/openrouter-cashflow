# OpenRouter: data sources for revenue estimation

Research date: 2026-11-03. All endpoints are public, unauthenticated, and return JSON. They are the
site's internal frontend API, not documented or versioned, so they can change without notice.
Base URL: `https://openrouter.ai/api/frontend/v1`.

Load test: 120 requests at concurrency 10 finished in about 6 s, all with status 200. No Cloudflare
challenge appeared for plain `fetch`/`curl`.

## Key endpoints

| Endpoint | Params | Returns |
|---|---|---|
| `rankings/models` | `view=day\|week\|month`, optional `metric=spend` | One row per model variant (about 640–740 rows): `total_prompt_tokens`, `total_completion_tokens`, `count` (requests), `variant` (`standard`/`free`/`batch`), `rankingMetricValue`. Cached, reasoning and BYOK fields are **zeroed** here. With `metric=spend`, `rankingMetricValue` is the model's **share of spend** (sums to 1.0, excludes BYOK). |
| `stats/model-activity` | `permaslug`, `variant` | 31 days of daily rows for one model, with full fields: prompt, completion, **cached**, **reasoning**, **BYOK prompt/completion**, requests, tool calls, media. |
| `stats/effective-pricing` | `permaslug`, `variant`, `shape=v7`, optional `range=3d\|1w\|1m\|3m\|1y\|all` | `weightedInputPrice`, `weightedOutputPrice`, `weightedCacheHitRate` ($/M tokens, after caching and discounts). `providerSummaries[]` per endpoint: `effectiveInputPrice`, `effectiveOutputPrice`, `cacheHitRate`, `totalTokens` (**last 1 day**; the UI shows it as "Token share 1d"). `inputChartData`/`outputChartData` hold daily effective prices per endpoint for the chosen range. |
| `stats/provider-token-chart` | `provider`, optional `permaslug` + `variant` | 90 days of daily tokens. With a permaslug: exact tokens that the provider served for that model, BYOK included. Summing over providers matches model-activity exactly. Without a permaslug: the provider's top 9 models plus `Others`. |
| `stats/listed-pricing` | `permaslug`, `variant`, `range`, `shape=v6` | History of list prices per endpoint (input, output, cacheRead, cacheWrite, discount). |
| `stats/endpoint` | `permaslug`, `variant` | Endpoint configuration: pricing incl. tiers (`overrides` by `min_prompt_tokens`), `is_byok`, provider and region, latency and throughput stats. |
| `stats/top-apps-for-model` | `permaslug`, `variant` | Top apps by tokens and requests for a model (e.g. Claude Code). |
| `rankings/model-rankings-chart` | – | 53 weeks of weekly tokens, top models plus Others. |
| `rankings/author-market-share` | – | Weekly tokens by author, about 1 year. |
| `rankings/task-spend` | – | 30-day spend share by task category, with top models per task. |
| `all-providers` | – | 96 providers (slug, name, data policy). |
| `/api/v1/models` (public API) | – | 451 models with list prices (top endpoint). |
| `/api/v1/models/{author}/{slug}/endpoints` (public API) | – | List prices per provider endpoint. |

## Validation

Estimate: `(prompt − byok_prompt) × weightedInputPrice + (completion − byok_completion) × weightedOutputPrice`,
summed over the 7 days in the rankings `week` window.

Comparison with OpenRouter's own `metric=spend` share for the top 40 models:
- When BYOK is excluded, the median ratio is 0.98 (stdev 0.11, range 0.67–1.21). This confirms that the official spend share excludes BYOK.
- When BYOK is included, the stdev rises to 0.80. Tencent Hy4 preview is 89% BYOK.

Implied OpenRouter-billed spend is about $26–27M per week, around $1.4B annualized. BYOK usage adds about $6M per week.

Spend concentration: the top 20 models take 70% of spend, the top 100 take 96%, the top 300 take 99.7%.
Non-token models (video and similar) account for about 1%. Batch variants account for 0.2%.

## Caveats

- `prompt_tokens` includes cached tokens, and the cache hit rate is often 80–95%. Multiplying by list prices
  overestimates revenue by several times, so use the effective prices.
- `rankings/models` contains no BYOK split. A BYOK-aware number needs `model-activity` for each model.
- The prompt/completion split per provider is unknown. Use the model-level ratio.
- Without a range, effective-pricing summaries cover 1 day. For exact per-provider history, use `provider-token-chart`.
- Discounts such as "51% off" are already reflected in effective prices. It is unknown who pays for them.
