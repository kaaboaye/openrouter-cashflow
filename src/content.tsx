// Entry point: route OpenRouter pages (it's a client-side-navigated Next.js app) to page controllers.

import { cachePrune } from './core/cache.ts';
import { dataEpoch } from './core/days.ts';
import { AppController, appPathFromPath } from './pages/app.tsx';
import { AuthorController, authorSlugFromPath } from './pages/author.tsx';
import { ModelController, modelSlugFromPath } from './pages/model.tsx';
import { ProviderController, providerSlugFromPath } from './pages/provider.tsx';
import { RankingsController } from './pages/rankings.tsx';
import { injectStyles } from './ui/styles.ts';
import { asRebuild } from './ui/nav.ts';
import { holdScrollY, keepReaderInPlace, resetAnchoring, trustRestoredScroll } from './ui/anchor.ts';
import { options } from 'preact';
import type { Controller } from './ui/inject.ts';

type Factory = () => Controller;

function route(pathname: string): { key: string; make: Factory } | null {
  if (pathname === '/rankings') return { key: 'rankings', make: () => new RankingsController() };
  const app = appPathFromPath(pathname);
  if (app) return { key: 'app', make: () => new AppController(app) };
  const provider = providerSlugFromPath(pathname);
  if (provider) return { key: 'provider', make: () => new ProviderController(provider) };
  const model = modelSlugFromPath(pathname);
  if (model) return { key: 'model', make: () => new ModelController(model) };
  const author = authorSlugFromPath(pathname);
  if (author) return { key: 'author', make: () => new AuthorController(author) };
  return null;
}

let current: { key: string; ctl: Controller } | null = null;
let poppedAt = -Infinity;
let lastPath = '';
let epoch = dataEpoch();

function sync() {
  // When OpenRouter publishes a new UTC day, rebuild the page's islands so every figure, date and
  // comparison moves to the new day together (stale cache entries expire by day as well).
  let rebuild = false;
  if (dataEpoch() !== epoch) {
    epoch = dataEpoch();
    // a rebuild only if the reader is still on the same page; a navigation in the same tick is a navigation
    rebuild = !!current && location.pathname === lastPath;
    // our blocks going away above the reader mustn't move what they're reading (the rebuilt ones go through the tick)
    if (rebuild) keepReaderInPlace(() => current!.ctl.dispose());
    else current?.ctl.dispose();
    current = null;
    lastPath = '';
  }
  if (location.pathname !== lastPath) {
    lastPath = location.pathname;
    const r = route(lastPath);
    if (current && current.key !== r?.key + lastPath) {
      current.ctl.dispose();
      current = null;
    }
    resetAnchoring(); // a jump on the page we left is over
    // Back/Forward within the site (also from a page we don't touch): OpenRouter's router either restores the old
    // scroll offset, measured with our blocks on the page (trust it), or jumps to the section in the hash (then our
    // blocks appearing above it must be undone). OpenRouter almost always keeps a section hash in the URL, so which
    // one happened is read from the page: the hash's section sitting exactly at its scroll margin means a jump.
    if (performance.now() - poppedAt < 1500) trustRestoredScroll(2500, location.hash.length > 1 ? decodeURIComponent(location.hash.slice(1)) : null);
    // a rebuild of the page the reader is on must not re-honour a URL hash we may have written ourselves
    if (r && !current) current = { key: r.key + lastPath, ctl: rebuild ? asRebuild(r.make) : r.make() };
  }
  // everything a tick adds or changes must leave what the reader is looking at where it is
  if (current) keepReaderInPlace(() => current!.ctl.tick());
}

const scrollKey = () => `orcf-scroll:${location.pathname}`;
function saveScrollY() {
  try {
    sessionStorage.setItem(scrollKey(), String(Math.round(window.scrollY)));
  } catch {
    /* storage blocked */
  }
}
function savedScrollY(): number | null {
  try {
    const v = Number(sessionStorage.getItem(scrollKey()));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

// Opt-in self-profiling: localStorage.setItem('orcf-debug', '1') exposes tick stats on <html data-orcf-perf>.
const debug = (() => {
  try {
    return localStorage.getItem('orcf-debug') === '1';
  } catch {
    return false;
  }
})();
const perf = { ticks: 0, totalMs: 0, maxMs: 0 };

let scheduled = 0;
function schedule() {
  if (scheduled) return;
  scheduled = requestAnimationFrame(() => {
    scheduled = 0;
    const t0 = debug ? performance.now() : 0;
    try {
      sync();
    } catch (e) {
      console.warn('[openrouter-cashflow]', e);
    }
    if (debug) {
      const dt = performance.now() - t0;
      perf.ticks++;
      perf.totalMs += dt;
      perf.maxMs = Math.max(perf.maxMs, dt);
      document.documentElement.dataset.orcfPerf = JSON.stringify({ ...perf, totalMs: Math.round(perf.totalMs), maxMs: +perf.maxMs.toFixed(1) });
    }
  });
}

/**
 * Touching server-rendered DOM before React finishes hydrating causes hydration errors, so wait for
 * the load event and then for the main thread to go idle (React's scheduler keeps it busy until done).
 */
function whenHydrated(): Promise<void> {
  return new Promise((resolve) => {
    const idle = () => requestIdleCallback(() => resolve(), { timeout: 5000 });
    if (document.readyState === 'complete') idle();
    else window.addEventListener('load', idle, { once: true });
  });
}

// Our components re-render when their data arrives: those changes keep the reader in place too.
options.debounceRendering = (flush) => queueMicrotask(() => keepReaderInPlace(flush));

injectStyles();
cachePrune();
whenHydrated().then(() => {
  // Back/Forward that loaded the page again: the browser restored the old absolute offset, measured with our blocks
  // on the page, so don't correct while they re-appear. (A reload is different: Chrome restores relative to the
  // content, before our blocks exist, so their insertion is corrected as usual. Model pages and /rankings restore
  // an exact saved position in both cases, see SectionNav.)
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  if (nav?.type === 'back_forward') trustRestoredScroll(3000);
  // For both, the exact offset saved when the page was left is held while our blocks come back.
  if (nav?.type === 'back_forward' || nav?.type === 'reload') {
    const saved = savedScrollY();
    if (saved !== null) holdScrollY(saved, 3000);
  }
  addEventListener('pagehide', saveScrollY);
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('popstate', () => {
    poppedAt = performance.now();
    schedule();
  });
  // a tab left open across midnight UTC (or past the settling window after it): check once a minute, and
  // whenever the tab comes back
  setInterval(() => dataEpoch() !== epoch && schedule(), 60_000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && schedule());
  schedule();
});
