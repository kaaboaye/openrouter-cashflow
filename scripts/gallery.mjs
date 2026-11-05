// Capture every view the extension adds (light/dark/mobile, tooltips, edge cases) in one browser
// session, plus per-page performance stats. Output: shots/gallery/*.png and shots/gallery/perf.json
//
//   node scripts/gallery.mjs [--only=substring]
// A persistent profile (ORCF_PROFILE, default /tmp/orcf-gallery-profile) keeps the extension's cache
// between runs, so re-runs don't reload the whole market.

import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
const ext = resolve('dist');
const outDir = 'shots/gallery';
mkdirSync(outDir, { recursive: true });

const GROUP = '#orcf-revenue [aria-label="Group revenue by"]';
const WINDOW = '#orcf-revenue [aria-label="Time window"]';

/** @type {{name:string,path:string,dark?:boolean,width?:number,height?:number,sheet?:boolean,sel?:string,clicks?:string[],hover?:string,wait?:number,full?:boolean,ready?:string}[]} */
const VIEWS = [
  { name: '01-rankings-providers-7d', path: '/rankings', sel: '#orcf-revenue', ready: '#orcf-revenue .orcf-stat-value', wait: 60000 },
  { name: '02-rankings-companies-7d', path: '/rankings', sel: '#orcf-revenue', clicks: [`${GROUP} button:has-text("Companies")`] },
  { name: '03-rankings-models-30d', path: '/rankings', sel: '#orcf-revenue', clicks: [`${GROUP} button:has-text("Models")`, `${WINDOW} button:has-text("30 days")`] },
  { name: '04-rankings-authors-7d', path: '/rankings', sel: '#orcf-revenue', clicks: [`${GROUP} button:has-text("Authors")`] },
  { name: '05-rankings-apps-7d', path: '/rankings', sel: '#orcf-revenue', clicks: [`${GROUP} button:has-text("Apps")`], wait: 15000 },
  { name: '06-rankings-providers-yesterday', path: '/rankings', sel: '#orcf-revenue', clicks: [`${WINDOW} button:has-text("Yesterday")`] },
  { name: '07-rankings-llm-leaderboard', path: '/rankings', sel: '#leaderboard-table' },
  { name: '08-rankings-top-apps', path: '/rankings', sel: '#apps', wait: 12000 },
  { name: '09-rankings-badge-tooltip', path: '/rankings', hover: '#leaderboard-table [data-orcf] .orcf-inline' },
  { name: '10-rankings-chart-tooltip', path: '/rankings', hover: '#orcf-revenue .orcf-chart g.col:nth-of-type(5)' },
  { name: '11-rankings-dark', path: '/rankings', dark: true, sel: '#orcf-revenue' },
  { name: '12-rankings-mobile', path: '/rankings', width: 400, sel: '#orcf-revenue' },
  { name: '13-model-header', path: '/anthropic/claude-opus-5.5', sel: '.lg\\:grid-cols-5' },
  { name: '14-model-revenue-7d', path: '/anthropic/claude-opus-5.5', sel: '#orcf-model-revenue' },
  { name: '15-model-revenue-30d', path: '/anthropic/claude-opus-5.5', sel: '#orcf-model-revenue', clicks: ['#orcf-model-revenue button:has-text("30 days")'] },
  { name: '16-model-apps', path: '/anthropic/claude-opus-5.5', sel: '#apps' },
  { name: '17-model-provider-tooltip', path: '/anthropic/claude-opus-5.5', hover: '#orcf-model-revenue .orcf-tr:not(.is-head) .orcf-strong' },
  { name: '18-model-dark', path: '/anthropic/claude-opus-5.5', dark: true, sel: '#orcf-model-revenue' },
  { name: '19-model-mobile', path: '/anthropic/claude-opus-5.5', width: 400, sel: '#orcf-model-revenue' },
  { name: '20-model-multi-provider', path: '/moonshotai/kimi-k3', sel: '#orcf-model-revenue' },
  { name: '21-model-batch-variant', path: '/anthropic/claude-haiku-5.5:batch', sel: '#orcf-model-revenue' },
  { name: '22-model-free-variant', path: '/nvidia/nemotron-3.5-super-vl:free', sel: '#orcf-model-revenue' },
  { name: '23-provider-deepinfra', path: '/provider/deepinfra', full: true, wait: 30000 },
  { name: '24-provider-bedrock-dark', path: '/provider/amazon-bedrock', dark: true, full: true, wait: 30000 },
  { name: '25-author-anthropic', path: '/anthropic', full: true, wait: 30000 },
  { name: '26-author-deepseek-mobile', path: '/deepseek', width: 400, full: true, wait: 25000 },
  { name: '27-app-claude-code', path: '/apps/claude-code', full: true, wait: 15000 },
  { name: '28-app-url-omp', path: '/apps/url/https%3A%2F%2Fomp.sh%2F', full: true, wait: 15000 },
  { name: '29-app-dark', path: '/apps/hermes-agent', dark: true, full: true, wait: 15000 },
  // OpenRouter's phone/tablet section sheet, opened while the Revenue section is current
  { name: '30-rankings-mobile-sheet', path: '/rankings', width: 390, height: 844, sel: '#orcf-revenue', sheet: true },
  { name: '31-model-mobile-sheet', path: '/anthropic/claude-opus-5.5', width: 390, height: 844, sel: '#orcf-model-revenue', sheet: true },
];

const ctx = await chromium.launchPersistentContext(process.env.ORCF_PROFILE ?? '/tmp/orcf-gallery-profile', {
  executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium',
  headless: true,
  viewport: { width: 1440, height: 1000 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
const errors = [];
page.on('pageerror', (e) => errors.push(`${page.url()} :: ${e.message.slice(0, 200)}`));
let apiRequests = 0;
page.on('request', (r) => { if (r.url().includes('/api/frontend/v1/')) apiRequests++; });

const perf = {};
for (const v of VIEWS) {
  if (only && !v.name.includes(only)) continue;
  const t0 = Date.now();
  const req0 = apiRequests;
  // groupings, windows and "Show more" are kept per tab: start every view from the defaults
  await page.evaluate(() => sessionStorage.clear()).catch(() => {});
  await page.setViewportSize({ width: v.width ?? 1440, height: v.height ?? 1000 });
  await page.emulateMedia({ colorScheme: v.dark ? 'dark' : 'light' });
  await page.addInitScript(([d]) => {
    try { localStorage.setItem('theme', d ? 'dark' : 'light'); localStorage.setItem('orcf-debug', '1'); } catch {}
  }, [!!v.dark]);
  await page.goto('https://openrouter.ai' + v.path, { waitUntil: 'load', timeout: 60000 }).catch((e) => console.log('goto', e.message.slice(0, 100)));
  await page.evaluate((d) => { localStorage.setItem('theme', d ? 'dark' : 'light'); localStorage.setItem('orcf-debug', '1'); }, !!v.dark);
  // the init script only applies from the next navigation on; reload if the theme didn't take
  const themeOk = await page.evaluate((d) => document.documentElement.classList.contains(d ? 'dark' : 'light'), !!v.dark);
  if (!themeOk) await page.reload({ waitUntil: 'load' });
  await page.getByRole('button', { name: 'Decline' }).first().click({ timeout: 2500 }).catch(() => {});
  await page.waitForSelector('[data-orcf]', { state: 'attached', timeout: 30000 }).catch(() => console.log(v.name, 'no [data-orcf]'));
  if (v.ready) await page.waitForSelector(v.ready, { timeout: 60000 }).catch(() => {});
  for (const c of v.clicks ?? []) {
    await page.waitForTimeout(600);
    await page.locator(c).first().click({ timeout: 10000 }).catch((e) => console.log(v.name, 'click failed', c, e.message.slice(0, 80)));
  }
  await page.waitForTimeout(v.wait ?? 6000);
  // let any market-wide loading finish (bounded)
  await page.waitForFunction(() => !document.querySelector('.orcf-progress'), null, { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(500);
  const file = `${outDir}/${v.name}.png`;
  if (v.sheet) {
    await page.locator(v.sel).first().evaluate((n) => window.scrollTo(0, n.getBoundingClientRect().top + window.scrollY - 120));
    await page.waitForTimeout(1500);
    await page.locator('button[aria-haspopup="dialog"], button[aria-haspopup="menu"]').filter({ hasText: /Revenue/ }).first().click().catch((e) => console.log(v.name, 'sheet trigger', e.message.slice(0, 80)));
    await page.waitForTimeout(900);
    await page.screenshot({ path: file });
    await page.keyboard.press('Escape');
  } else if (v.hover) {
    const h = page.locator(v.hover).first();
    await h.evaluate((n) => window.scrollTo(0, n.getBoundingClientRect().top + window.scrollY - 350)).catch(() => {});
    await page.waitForTimeout(300);
    await h.hover({ force: true }).catch((e) => console.log(v.name, 'hover failed', e.message.slice(0, 80)));
    await page.waitForTimeout(500);
    await page.screenshot({ path: file });
  } else if (v.sel) {
    const el = page.locator(v.sel).first();
    if (await el.count()) {
      // an element taller than the screen is captured in pieces, with the page's fixed bars painted over it:
      // make the window tall enough to hold it instead
      const h = await el.evaluate((n) => Math.ceil(n.getBoundingClientRect().height));
      const vh = v.height ?? 1000;
      if (h > vh - 220) {
        await page.setViewportSize({ width: v.width ?? 1440, height: h + 420 });
        await page.waitForTimeout(800);
      }
      await el.evaluate((n) => window.scrollTo(0, n.getBoundingClientRect().top + window.scrollY - 160));
      await page.waitForTimeout(400);
      await el.screenshot({ path: file });
    } else console.log(v.name, 'missing', v.sel);
  } else {
    await page.screenshot({ path: file, fullPage: !!v.full });
  }
  const stats = await page.evaluate(() => ({
    orcfNodes: document.querySelectorAll('[data-orcf]').length,
    perf: JSON.parse(document.documentElement.dataset.orcfPerf || '{}'),
    heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null,
  }));
  perf[v.name] = { ...stats, seconds: Math.round((Date.now() - t0) / 1000), apiRequests: apiRequests - req0 };
  console.log(v.name, JSON.stringify(perf[v.name]));
}
writeFileSync(`${outDir}/perf.json`, JSON.stringify({ perf, errors }, null, 1));
console.log('page errors:', errors.length ? errors : 'none');
await ctx.close();
