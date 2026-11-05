// Dev helper: open openrouter.ai in Chromium with the built extension loaded and take screenshots.
//   node scripts/shot.mjs <path> [--dark] [--wait=ms] [--sel=css] [--full] [--out=name] [--width=1440] [--scroll=css] [--click=css]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const a = args.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : args.includes(`--${n}`) ? true : d;
};
const path = args.find((a) => !a.startsWith('--')) ?? '/rankings';
const dark = !!flag('dark', false);
const wait = Number(flag('wait', 20000));
const sels = String(flag('sel', '')).split(',').filter(Boolean);
const out = flag('out', path.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'home') + (dark ? '-dark' : '');
const width = Number(flag('width', 1440));
const ext = resolve('dist');
mkdirSync('shots', { recursive: true });

const ctx = await chromium.launchPersistentContext(process.env.ORCF_PROFILE ?? '', {
  executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium',
  headless: true,
  viewport: { width, height: 1000 },
  colorScheme: dark ? 'dark' : 'light',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on('console', (m) => { if (/orcf|openrouter-cashflow|error/i.test(m.text()) && m.type() !== 'log') console.log('[console]', m.type(), m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)));
await page.addInitScript((d) => { try { localStorage.setItem('theme', d ? 'dark' : 'light'); } catch {} }, dark);
await page.goto('https://openrouter.ai' + path, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('[data-orcf]', { timeout: 30000, state: 'attached' }).catch(() => console.log('no [data-orcf] found'));
await page.getByRole('button', { name: 'Decline' }).first().click({ timeout: 3000 }).catch(() => {});
const clickSel = flag('click', '');
if (clickSel) { for (const c of String(clickSel).split('|')) { await page.waitForTimeout(800); await page.locator(c).first().click().catch((e) => console.log('click failed', c, e.message.slice(0, 120))); } }
await page.waitForTimeout(wait);
const t0 = Date.now();
if (args.includes('--full')) await page.screenshot({ path: `shots/${out}-full.png`, fullPage: true });
for (const [i, s] of sels.entries()) {
  const el = page.locator(s).first();
  if (!(await el.count())) { console.log('missing', s); continue; }
  await el.evaluate((n) => window.scrollTo(0, n.getBoundingClientRect().top + window.scrollY - 160));
  await page.waitForTimeout(400);
  await el.screenshot({ path: `shots/${out}-${i}.png` });
  console.log('saved', `shots/${out}-${i}.png`, s);
}
const hoverSel = flag('hover', '');
if (hoverSel) {
  const h = page.locator(String(hoverSel)).first();
  await h.evaluate((n) => window.scrollTo(0, n.getBoundingClientRect().top + window.scrollY - 300));
  await page.waitForTimeout(300);
  await h.hover({ force: true }).catch((e) => console.log('hover failed', e.message.slice(0, 100)));
  await page.waitForTimeout(500);
  await page.screenshot({ path: `shots/${out}-hover.png` });
  console.log('saved', `shots/${out}-hover.png`);
}
const evalSrc = flag('eval', '');
if (evalSrc) console.log('eval:', JSON.stringify(await page.evaluate(new Function('return (' + evalSrc + ')()')), null, 1));
const diag = await page.evaluate(() => ({ orcf: document.querySelectorAll('[data-orcf]').length, theme: document.documentElement.className.split(' ').pop() }));
console.log('diag', JSON.stringify(diag), 'shot in', Date.now() - t0, 'ms');
await ctx.close();
