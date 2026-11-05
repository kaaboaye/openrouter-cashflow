// Small revenue figures injected into OpenRouter's own rows (leaderboards, app lists, model cards).

import { useEffect, useState } from 'preact/hooks';
import { Priority } from '../core/api.ts';
import { PERIOD_DAYS, PERIOD_LABEL, type Period } from '../core/days.ts';
import { money, pct, perM } from '../core/format.ts';
import { appSpend, modelRevenueBySlug, type AppSpend, type ModelRevenue } from '../core/services.ts';
import { refFor, resolvePermaslugs } from '../core/data.ts';
import { blendedPrice } from '../core/model.ts';
import { shortModelName } from '../core/names.ts';
import { Tip, TipRow } from './components.tsx';

type Load<T> = { state: 'loading' } | { state: 'error' } | { state: 'ok'; value: T };

function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): Load<T> {
  const [s, set] = useState<Load<T>>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    set({ state: 'loading' });
    fn().then(
      (value) => live && set({ state: 'ok', value }),
      () => live && set({ state: 'error' }),
    );
    return () => {
      live = false;
    };
  }, deps);
  return s;
}

const runRate = (v: number, period: Period) => (v / PERIOD_DAYS[period]) * 365;

export function ModelBadge({ slug, period, compact }: { slug: string; period: Period; compact?: boolean }) {
  const s = useAsync(() => modelRevenueBySlug(slug, period, Priority.visible), [slug, period]);
  if (s.state === 'loading') return <span class="orcf-inline is-loading"><span class="orcf-skel" style={{ width: '44px' }} /></span>;
  if (s.state === 'error' || !s.value) return <span class="orcf-inline is-free" title="Couldn't load this model's revenue from OpenRouter's stats">—</span>;
  const { revenue, data } = s.value;
  if (data.base.free) return <span class="orcf-inline is-free">free · $0</span>;
  if (data.base.priceUnknown)
    return (
      <span class="orcf-inline is-free" title={data.base.nonToken ? 'Billed per second, image or other unit; not estimated' : 'OpenRouter has no price data for this model any more'}>
        —
      </span>
    );
  return (
    <Tip class="orcf-inline" content={() => <ModelTip m={s.value!} period={period} />}>
      <i class="orcf-inline-dot" aria-hidden="true" />
      <span class="orcf-num">{money(revenue.revenue)}</span>
      {!compact && <span class="orcf-muted" style={{ fontWeight: 450 }}>revenue</span>}
    </Tip>
  );
}

function ModelTip({ m, period }: { m: ModelRevenue; period: Period }) {
  const r = m.revenue;
  const providers = [...(r.providers?.entries() ?? [])].sort((a, b) => b[1].revenue - a[1].revenue);
  const blend = blendedPrice(r);
  return (
    <div>
      <div class="orcf-tip-title">
        {m.ref.name} · {PERIOD_LABEL[period]}
      </div>
      <TipRow label="Revenue" value={money(r.revenue, { precise: true })} />
      <TipRow label="of which BYOK" value={`${money(r.byok)} (${pct(r.revenue ? r.byok / r.revenue : 0, 0)})`} />
      <TipRow label="Annualized" value={`${money(runRate(r.revenue, period))}/yr`} />
      {blend && <TipRow label="Effective $/M in · out" value={`${perM(blend.in)} · ${perM(blend.out)}`} />}
      {providers.length > 0 && <div class="orcf-tip-sep" />}
      {providers.slice(0, 5).map(([slug, p]) => (
        <TipRow label={m.data.base.providerNames[slug] ?? slug} value={`${money(p.revenue)} · ${pct(p.revenue / r.revenue, 0)}`} />
      ))}
      <div class="orcf-tip-note">Tokens × effective price after caching & discounts. Includes BYOK.</div>
    </div>
  );
}

export function AppBadge({ path, period, onValue }: { path: string; period: Period; onValue?: (v: AppSpend) => void }) {
  const s = useAsync(() => appSpend(path, period, Priority.visible), [path, period]);
  const [, setNames] = useState(0);
  useEffect(() => {
    if (s.state !== 'ok') return;
    onValue?.(s.value);
    // the tooltip lists the app's top models: fetch their display names
    resolvePermaslugs(s.value.byModel.slice(0, 5).map((m) => m.permaslug)).then(() => setNames((x) => x + 1));
  }, [s]);
  if (s.state === 'loading') return <span class="orcf-inline is-loading"><span class="orcf-skel" style={{ width: '44px' }} /></span>;
  if (s.state === 'error') return <span class="orcf-inline is-free" title="Couldn't load this app's spend from OpenRouter's stats">—</span>;
  const a = s.value;
  return (
    <Tip class="orcf-inline" content={() => <AppTip a={a} period={period} />}>
      <i class="orcf-inline-dot" aria-hidden="true" />
      <span class="orcf-num">{money(a.spend)}</span>
      <span class="orcf-muted" style={{ fontWeight: 450 }}>spend</span>
    </Tip>
  );
}

function AppTip({ a, period }: { a: AppSpend; period: Period }) {
  return (
    <div>
      <div class="orcf-tip-title">Estimated spend · {PERIOD_LABEL[period]}</div>
      <TipRow label="Spend" value={money(a.spend, { precise: true })} />
      <TipRow label="Annualized" value={`${money(runRate(a.spend, period))}/yr`} />
      <TipRow label="Avg $/M tokens" value={perM(a.tokens ? (a.spend / a.tokens) * 1e6 : 0)} />
      <div class="orcf-tip-sep" />
      {a.byModel.slice(0, 5).map((m) => (
        <TipRow label={refFor(m.permaslug, m.variant)?.name ?? shortModelName(m.permaslug)} value={money(m.spend)} />
      ))}
      <div class="orcf-tip-note">
        App tokens per model per day × that model's effective price. {pct(a.pricedShare, 0)} of
        tokens matched to a model.
        {a.splitUnknown > 0 ? " A model's free/paid traffic split couldn't be loaded, so this may be high." : ''}
      </div>
    </div>
  );
}
