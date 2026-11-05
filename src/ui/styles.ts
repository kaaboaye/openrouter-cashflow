// All styling is namespaced under .orcf and built on OpenRouter's own design tokens
// (hsl(var(--foreground)), --muted-foreground, --border, …) so light/dark follow the site.

export const CSS = /* css */ `
.orcf { color: hsl(var(--foreground)); font-family: inherit; }
.orcf *, .orcf *::before, .orcf *::after { box-sizing: border-box; }
.orcf svg { display: inline-block; vertical-align: middle; }
.orcf .orcf-chart svg { display: block; }
.orcf {
  --orcf-s1: #2a78d6; --orcf-s2: #eb6834; --orcf-s3: #1baf7a; --orcf-s4: #eda100;
  --orcf-s5: #e87ba4; --orcf-s6: #008300; --orcf-s7: #6250d6; --orcf-s8: #e34948;
  --orcf-other: #a3a29c;
  --orcf-estimate: #d4d3ce;
  --orcf-revenue: var(--chart-cost, #6366f1);
  --orcf-byok: var(--chart-byok, #fbbf24);
  --orcf-surface: hsl(var(--background));
  --orcf-grid: hsl(var(--border));
}
.dark .orcf {
  --orcf-s1: #3987e5; --orcf-s2: #d95926; --orcf-s3: #199e70; --orcf-s4: #c98500;
  --orcf-s5: #d55181; --orcf-s6: #008300; --orcf-s7: #9085e9; --orcf-s8: #e66767;
  --orcf-other: #6f6e69;
  --orcf-estimate: #45443f;
}

.orcf-muted { color: hsl(var(--muted-foreground)); }
.orcf-faint { color: var(--text-faint, hsl(var(--muted-foreground))); }
.orcf-pos { color: var(--positive-text, #007544); }
.orcf-neg { color: var(--negative-text, #bf0024); }
.orcf-num { font-variant-numeric: tabular-nums; }
.orcf-strong { color: hsl(var(--foreground)); font-weight: 500; }
.orcf-xs { font-size: 12px; line-height: 1.625; }
.orcf-link { color: inherit; text-decoration: none; }
.orcf-link:hover { color: hsl(var(--accent-foreground)); }
.orcf-nowrap { white-space: nowrap; }
.orcf-trunc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }

/* ---------- inline badges inside OpenRouter's own rows ---------- */
.orcf-inline { display: inline-flex; vertical-align: top; align-items: center; gap: 4px; color: hsl(var(--foreground)); font-weight: 500; white-space: nowrap; cursor: help; }
.orcf-row-extra { display: block; margin-top: 2px; }
.orcf-card-extra { flex-basis: 100%; display: flex; justify-content: flex-end; margin-top: 2px; }
.orcf-inline-dot { width: 6px; height: 6px; border-radius: 999px; background: var(--orcf-revenue); flex: none; }
.orcf-inline.is-loading { color: hsl(var(--muted-foreground)); font-weight: 450; }
/* a zero-width character gives the placeholder a full line box, so rows don't grow when the figure arrives */
.orcf-inline.is-loading::after { content: '\\200b'; }
.orcf-inline.is-free { color: hsl(var(--muted-foreground)); font-weight: 450; }

/* ---------- section shell (mirrors OpenRouter's section blocks) ---------- */
.orcf-section { display: flex; flex-direction: column; gap: 24px; padding-bottom: 20px; position: relative; }
.orcf-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.orcf-head-text { display: flex; flex-direction: column; gap: 8px; min-width: 0; max-width: 640px; }
.orcf-title { display: flex; align-items: center; gap: 8px; }
.orcf-title svg { width: 20px; height: 20px; flex: none; color: hsl(var(--foreground)); }
.orcf-h2 { font-size: 20px; line-height: 24px; font-weight: 600; margin: 0; }
.orcf-h2-sm { font-size: 16px; line-height: 1.35; font-weight: 500; margin: 0; }
.orcf-desc { font-size: 14px; line-height: 22.75px; font-weight: 500; color: hsl(var(--muted-foreground)); margin: 0; }
.orcf-badge { display: inline-flex; align-items: center; height: 20px; padding: 0 6px; border-radius: 4px; font-size: 11px; font-weight: 600; letter-spacing: .02em; text-transform: uppercase; color: hsl(var(--accent-foreground)); background: hsl(var(--accent)); }
.orcf-controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.orcf-card { border: 1px solid hsl(var(--border)); border-radius: 8px; padding: 20px; background: hsl(var(--card)); }

/* segmented control, same anatomy as OpenRouter's Absolute/Percentage toggle */
.orcf-seg { position: relative; display: inline-flex; align-items: center; gap: 2px; padding: 2px; border-radius: 6px; border: 1px solid hsl(var(--border)); background: hsl(var(--muted)); max-width: 100%; overflow-x: auto; scrollbar-width: none; }
.orcf-seg::-webkit-scrollbar { display: none; }
.orcf-controls { min-width: 0; max-width: 100%; }
.orcf-seg button { all: unset; box-sizing: border-box; height: 24px; padding: 0 8px; border-radius: 4px; font-size: 12px; line-height: 19.5px; font-weight: 500; color: hsl(var(--muted-foreground)); cursor: pointer; display: inline-flex; align-items: center; white-space: nowrap; transition: color .15s, background .15s; }
.orcf-seg button:hover { color: hsl(var(--accent-foreground)); }
.orcf-seg button[aria-checked="true"] { background: hsl(var(--background)); color: hsl(var(--accent-foreground)); box-shadow: 0 1px 2px rgb(0 0 0 / .06), 0 0 0 .5px hsl(var(--border)); }
.orcf-seg button:focus-visible { outline: 2px solid hsl(var(--ring)); outline-offset: 1px; }

/* ---------- stat tiles ---------- */
.orcf-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(176px, 1fr)); gap: 1px; background: hsl(var(--border)); border: 1px solid hsl(var(--border)); border-radius: 8px; overflow: hidden; }
.orcf-stat { background: hsl(var(--background)); padding: 14px 16px; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.orcf-stat-label { font-size: 12px; line-height: 1.5; font-weight: 500; color: hsl(var(--muted-foreground)); }
.orcf-stat-value { font-size: 24px; line-height: 1.2; font-weight: 600; letter-spacing: -.01em; min-width: 0; overflow-wrap: anywhere; }
.orcf-price-pair { display: inline-flex; flex-wrap: wrap; align-items: baseline; column-gap: .3em; }
.orcf-price-pair .orcf-muted { font-weight: 450; }
.orcf-stat-sub { font-size: 12px; line-height: 1.5; color: hsl(var(--muted-foreground)); }

/* ---------- progress ---------- */
.orcf-progress { display: flex; align-items: center; gap: 10px; font-size: 12px; color: hsl(var(--muted-foreground)); }
.orcf-progress-track { flex: 1; max-width: 220px; height: 4px; border-radius: 999px; background: hsl(var(--muted)); overflow: hidden; box-shadow: inset 0 0 0 1px hsl(var(--border)); }
.orcf-progress-fill { height: 100%; border-radius: 999px; background: hsl(var(--primary)); transition: width .3s ease; }

/* ---------- ranked table ---------- */
.orcf-table { display: flex; flex-direction: column; container-type: inline-size; }
.orcf-tr { display: grid; grid-template-columns: var(--cols); align-items: center; gap: 12px; padding: 10px 4px; border-bottom: 1px solid hsl(var(--border)); font-size: 14px; line-height: 22.75px; }
.orcf-tr:last-child { border-bottom: 0; }
.orcf-tr.is-head { padding-top: 0; font-size: 12px; line-height: 1.5; font-weight: 500; color: hsl(var(--muted-foreground)); }
.orcf-tr .r { text-align: right; justify-self: end; }
.orcf-rank { color: hsl(var(--muted-foreground)); font-weight: 450; }
.orcf-name { display: flex; flex-direction: column; min-width: 0; }
.orcf-name a, .orcf-name span.orcf-primary { color: hsl(var(--foreground)); font-weight: 500; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.orcf-name a:hover { color: hsl(var(--accent-foreground)); }
.orcf-sub { font-size: 12px; line-height: 1.5; color: hsl(var(--muted-foreground)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.orcf-swatch { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 8px; flex: none; vertical-align: 1px; }
.orcf-share { display: flex; align-items: center; gap: 8px; justify-content: flex-end; }
.orcf-share-bar { width: 64px; height: 6px; border-radius: 999px; background: hsl(var(--muted)); box-shadow: inset 0 0 0 1px hsl(var(--border)); overflow: hidden; flex: none; }
.orcf-share-bar > i { display: block; height: 100%; border-radius: 999px; background: var(--orcf-revenue); }
.orcf-more { all: unset; box-sizing: border-box; cursor: pointer; display: block; width: fit-content; align-self: center; margin: 12px auto 0; font-size: 14px; font-weight: 500; color: hsl(var(--muted-foreground)); padding: 4px 10px; border-radius: 6px; }
.orcf-more:hover { color: hsl(var(--accent-foreground)); background: hsl(var(--accent)); }
.orcf-more:focus-visible, .orcf-inline:focus-visible { outline: 2px solid hsl(var(--ring)); outline-offset: 2px; }
.orcf-chart .col:focus, .orcf-chart .col:focus-visible { outline: none; }
.orcf-chart .focus-ring { fill: none; stroke: hsl(var(--ring)); stroke-width: 2; pointer-events: none; }
.orcf-error { padding: 16px 18px; border-radius: 8px; border: 1px solid var(--negative, #ff2d55); background: var(--negative-bg, #ff2d5514); color: hsl(var(--foreground)); font-size: 14px; line-height: 1.5; }
.orcf-empty { padding: 24px 0; text-align: center; color: hsl(var(--muted-foreground)); font-size: 14px; }
.orcf-skel { display: inline-block; height: 10px; border-radius: 4px; background: hsl(var(--muted)); box-shadow: inset 0 0 0 1px hsl(var(--border)); animation: orcf-pulse 1.4s ease-in-out infinite; }
@keyframes orcf-pulse { 50% { opacity: .45; } }
.orcf-dim { opacity: .55; transition: opacity .2s; }

/* ---------- chart ---------- */
.orcf-chart { position: relative; width: 100%; }
.orcf-chart svg { display: block; width: 100%; overflow: visible; }
.orcf-chart .tick { font-size: 11px; fill: hsl(var(--muted-foreground)); font-variant-numeric: tabular-nums; }
.orcf-chart .grid { stroke: var(--orcf-grid); stroke-width: 1; shape-rendering: crispEdges; }
.orcf-chart .col { cursor: default; }
.orcf-chart .col:hover .seg, .orcf-chart .col.is-active .seg { filter: brightness(1.08) saturate(1.05); }
.orcf-chart .hit { fill: transparent; }
.orcf-legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12px; line-height: 1.5; color: hsl(var(--muted-foreground)); margin-top: 12px; }
.orcf-legend span { display: inline-flex; align-items: center; gap: 6px; }
.orcf-legend i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }

/* ---------- tooltip ---------- */
.orcf-tip { position: fixed; z-index: 2147483000; pointer-events: none; min-width: 180px; max-width: 320px; padding: 10px 12px; border-radius: 8px; background: hsl(var(--popover, var(--card))); color: hsl(var(--popover-foreground, var(--foreground))); border: 1px solid hsl(var(--border)); box-shadow: 0 8px 24px rgb(0 0 0 / .12), 0 2px 6px rgb(0 0 0 / .06); font-size: 12px; line-height: 1.5; font-family: inherit; }
.orcf-tip-title { font-weight: 600; font-size: 12px; margin-bottom: 6px; color: hsl(var(--foreground)); }
.orcf-tip-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.orcf-tip-row b { font-weight: 600; color: hsl(var(--foreground)); font-variant-numeric: tabular-nums; }
.orcf-tip-row span { color: hsl(var(--muted-foreground)); display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.orcf-tip-key { width: 10px; height: 2px; border-radius: 1px; display: inline-block; flex: none; }
.orcf-tip-sep { height: 1px; background: hsl(var(--border)); margin: 6px 0; }
.orcf-tip-note { color: hsl(var(--muted-foreground)); margin-top: 6px; }

/* ---------- nav link we add to OpenRouter's section nav ---------- */
.orcf-nav-dot { width: 6px; height: 6px; border-radius: 999px; background: var(--orcf-revenue); margin-left: auto; }

/* ---------- stat chip in model header ---------- */
.orcf-headstat { display: flex; flex-direction: column; gap: 2px; }

/* narrow tables (container query) — must come after the base .orcf-tr rule to win */
@container (max-width: 860px) {
  .orcf-tr { grid-template-columns: var(--cols-md, var(--cols)); }
  .orcf-hide-md { display: none !important; }
}

/* app pages: 4 native stat tiles; ours joins them as a 5th column on desktop, a full row below that */
@media (min-width: 1024px) { .orcf-grid5 { grid-template-columns: repeat(5, minmax(0, 1fr)) !important; } }
@media (max-width: 1023.98px) { .orcf-grid5 > [data-orcf] { grid-column: 1 / -1; } }
/* model pages with 5 native header cards: a 6th column while everything still fits, else ours takes its own
   full row (the model page measures OpenRouter's values and labels to choose) */
@media (min-width: 1024px) {
  .orcf-grid6 { grid-template-columns: repeat(6, minmax(0, 1fr)) !important; }
  .orcf-own-row > [data-orcf] { grid-column: 1 / -1; }
}

/* phones: all five group-by options stay visible (tighter buttons, wrap on the narrowest screens) */
@media (max-width: 400px) { .orcf-seg button { padding: 0 6px; } }
@media (max-width: 370px) { .orcf-seg { flex-wrap: wrap; overflow-x: visible; } }

@media (max-width: 768px) {
  .orcf-hide-sm { display: none !important; }
  .orcf-tr { grid-template-columns: var(--cols-sm, var(--cols)); gap: 8px; padding-left: 0; padding-right: 0; }
  .orcf-card { padding: 14px; }
}
`;

export function injectStyles(): void {
  if (document.getElementById('orcf-style')) return;
  const style = document.createElement('style');
  style.id = 'orcf-style';
  style.textContent = CSS;
  (document.head || document.documentElement).appendChild(style);
}
