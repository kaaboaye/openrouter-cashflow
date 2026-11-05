// Shapes of the OpenRouter frontend API responses we rely on (only the fields we use).

export type Variant = 'standard' | 'free' | 'batch' | (string & {});

export interface ActivityRow {
  date: string; // "2026-11-02 00:00:00"
  model_permaslug: string;
  variant: Variant;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_native_tokens_cached: number;
  total_native_tokens_reasoning: number;
  total_byok_prompt_tokens: number;
  total_byok_completion_tokens: number;
  count: number;
}

export interface RankingRow extends ActivityRow {
  variant_permaslug: string;
  rankingMetricValue: number;
  change: number | null;
}

export interface ProviderSummary {
  endpointId: string;
  providerName: string;
  providerSlug: string;
  effectiveInputPrice: number;
  effectiveOutputPrice: number;
  cacheHitRate: number;
  totalTokens: number;
}

export interface ChartPoint<V = number> {
  x: string;
  y: Record<string, V>;
}

export interface EffectivePricing {
  weightedInputPrice: number;
  weightedOutputPrice: number;
  weightedCacheHitRate: number;
  providerSummaries: ProviderSummary[];
  endpointNames: Record<string, string>;
  endpointRawNames: Record<string, string>;
  endpointProviderSlugs: Record<string, string>;
  inputChartData: ChartPoint[];
  outputChartData: ChartPoint[];
}

export interface ProviderTokenChart {
  chartData: { x: string; ys: Record<string, number> }[];
}

export interface CatalogModel {
  slug: string;
  permaslug: string;
  name: string;
  short_name: string;
  author: string;
  author_display_name?: string;
  endpoint: null | {
    variant: Variant;
    model_variant_slug: string;
    model_variant_permaslug: string;
    is_free: boolean;
  };
}

export interface AppInfo {
  id: number;
  title: string;
  slug: string | null;
  origin_url: string | null;
  favicon_url: string | null;
}

export interface RankedApp {
  app_id: number;
  total_tokens: string;
  total_requests: number;
  rank: number;
  app: AppInfo;
}

export interface TopAppsForModel {
  top_apps: RankedApp[];
}

export interface EndpointStat {
  id: string;
  provider_slug: string;
  provider_name?: string;
  variant: Variant;
  is_free: boolean;
  pricing: { prompt?: string; completion?: string; input_cache_read?: string; discount?: number; display_pricing?: DisplayPrice[] };
  /** what OpenRouter shows; the only place some prices live (rerank: per input token; video: per second) */
  display_pricing?: DisplayPrice[];
}

export interface DisplayPrice {
  kind: string; // "token", "unit", …
  sku_label?: string; // e.g. "Input tokens", "Video Output"
  price: string; // $ per token (kind "token") or per unit
}
