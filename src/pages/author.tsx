// Author page (/:author, e.g. /anthropic): what all hosts earned on this author's models.

import { Priority } from '../core/api.ts';
import { loadModel, type ModelData } from '../core/data.ts';
import { blendedPrice, computeRevenue, type ProviderModelRevenue } from '../core/model.ts';
import type { Controller } from '../ui/inject.ts';
import { SetMount, SetStore } from '../ui/modelset.tsx';

function modelTotal(d: ModelData, days: string[]): ProviderModelRevenue {
  const r = computeRevenue(d.base, d.pt, days);
  const blend = blendedPrice(r);
  return {
    revenue: r.revenue,
    byok: r.byok,
    tokens: r.tokens,
    priceIn: blend?.in ?? d.base.weightedIn,
    priceOut: blend?.out ?? d.base.weightedOut,
    daily: r.daily.map((x) => x.revenue),
  };
}

export class AuthorController implements Controller {
  private mount: SetMount;
  private label: RegExp;

  constructor(author: string) {
    const name = () => document.querySelector('h1')?.textContent?.trim() || author;
    this.label = /tokens processed on OpenRouter$/;
    const store = new SetStore({
      get name() {
        return name();
      },
      async load(ref) {
        const data = await loadModel(ref.permaslug, ref.variant, Priority.section);
        return { ref, base: data.base, extra: data };
      },
      revenue: (item, days) => modelTotal(item.extra as ModelData, days),
      get copy() {
        return {
          cardTitle: (model: string) => `${model}, all hosts`,
          title: `Revenue on ${name()} models`,
          tilesSub: 'all hosts, via OpenRouter',
          method: `What every provider earned serving ${name()} models: tokens × each provider's effective price (after caching and discounts), incl. BYOK. The share that reaches ${name()} itself depends on its deals with the hosts.`,
        };
      },
    });
    this.mount = new SetMount(store);
  }

  tick() {
    this.mount.tick(this.label);
  }

  dispose() {
    this.mount.dispose();
  }
}

/** Single-segment paths that are OpenRouter author pages (anything not reserved). */
const RESERVED = new Set([
  'docs', 'chat', 'models', 'rankings', 'apps', 'provider', 'providers', 'settings', 'api', 'pricing', 'enterprise', 'about',
  'privacy', 'terms', 'login', 'sign-in', 'sign-up', 'keys', 'credits', 'activity', 'logs', 'workspaces', 'ori', 'benchmarks',
  'announcements', 'careers', 'compare', 'labs', 'arena', 'sso', 'organization', 'support', 'status', 'blog', 'works-with-openrouter',
]);
export function authorSlugFromPath(pathname: string): string | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length !== 1 || RESERVED.has(parts[0])) return null;
  return decodeURIComponent(parts[0]);
}
