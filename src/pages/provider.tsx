// Provider page (/provider/:slug): what this provider earns on OpenRouter, per model.

import { Priority } from '../core/api.ts';
import { loadBase, loadProviderTokens, loadProviderTotals } from '../core/data.ts';
import { providerRevenue } from '../core/model.ts';
import type { Controller } from '../ui/inject.ts';
import { SetMount, SetStore } from '../ui/modelset.tsx';

export class ProviderController implements Controller {
  private mount: SetMount;

  constructor(provider: string) {
    const name = () => document.querySelector('h1')?.textContent?.trim() || provider;
    const store = new SetStore({
      get name() {
        return name();
      },
      async load(ref) {
        const [base, series] = await Promise.all([
          loadBase(ref.permaslug, ref.variant, Priority.section),
          loadProviderTokens(provider, ref.permaslug, ref.variant, Priority.section),
        ]);
        return { ref, base, extra: series };
      },
      revenue: (item, days) => providerRevenue(item.base, provider, item.extra as Record<string, number>, days),
      // Models this provider served (per its own token chart) but no longer lists still earned it money.
      extraModels: async () => {
        const keys = new Set<string>();
        for (const d of await loadProviderTotals(provider, Priority.section)) for (const k of Object.keys(d.ys)) if (k !== 'Others') keys.add(k);
        return [...keys].map((k) => {
          const m = k.match(/^(.*):([a-z-]+)$/);
          return m ? { permaslug: m[1], variant: m[2] } : { permaslug: k, variant: 'standard' };
        });
      },
      totals: async () => {
        const out: Record<string, number> = {};
        for (const d of await loadProviderTotals(provider, Priority.section)) out[d.day] = Object.values(d.ys).reduce((a, b) => a + b, 0);
        return out;
      },
      get copy() {
        return {
          cardTitle: (model: string) => `${name()} revenue from ${model}`,
          title: 'Revenue on OpenRouter',
          tilesSub: `${name()} via OpenRouter`,
          method: `Daily tokens ${name()} served per model × its effective price for that model (after caching and discounts), incl. BYOK.`,
        };
      },
    });
    this.mount = new SetMount(store);
  }

  tick() {
    this.mount.tick(/^Tokens processed on OpenRouter$/);
  }

  dispose() {
    this.mount.dispose();
  }
}

export function providerSlugFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/provider\/([^/]+)\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
}
