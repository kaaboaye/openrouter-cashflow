// Browser regression suite: drives openrouter.ai in Chromium with the built extension and checks the
// behaviour every review round asked for. Needs network access to openrouter.ai.
//
//   node scripts/verify.mjs warmup            # load the market once into a reusable profile (run first)
//   node scripts/verify.mjs <suite> [...]     # main | layout | errors | nav | a11y | data | outage | all
//
// Env: CHROMIUM (default /usr/bin/chromium). Screenshots go to shots/verify/.

import { chromium } from 'playwright-core';
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const EXT = resolve('dist');
const OUT = resolve('shots/verify');
const WARM = '/tmp/orcf-verify-warm';
mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(ok ? 'PASS' : 'FAIL', name, typeof detail === 'string' ? detail : JSON.stringify(detail));
};

async function launch(profile, viewport = { width: 1440, height: 900 }) {
  return chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium',
    headless: true,
    viewport,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
}
function profile(name, warm = true) {
  const p = `/tmp/orcf-verify-${name}`;
  rmSync(p, { recursive: true, force: true });
  if (warm && existsSync(WARM)) cpSync(WARM, p, { recursive: true });
  return p;
}
async function open(page, path) {
  await page.goto('https://openrouter.ai' + path, { waitUntil: 'load', timeout: 60000 });
  await page.getByRole('button', { name: 'Decline' }).first().click({ timeout: 2000 }).catch(() => {});
}
const settled = (page, sel = '[data-orcf] .orcf-stat-value', timeout = 180000) =>
  page.waitForFunction((s) => document.querySelector(s) && !document.querySelector('.orcf-progress'), sel, { timeout }).catch(() => {});

// OpenRouter's phone/tablet section control: a dropdown menu, or (since Nov 2026) a bottom sheet of radio options
const PHONE_TRIGGER = 'button[aria-haspopup="menu"], button[aria-haspopup="dialog"]';
const PHONE_ITEMS = '[role=menu] [role=menuitem], [role=dialog] [role=radiogroup] > [data-option-value]';
const PHONE_OURS = '[role=menu] [data-orcf], [role=dialog] [role=radiogroup] > [data-orcf]';
const phoneTrigger = (page, re) => page.locator(PHONE_TRIGGER).filter({ hasText: re }).first();
/** the phone control's state: open?, item labels, highlighted labels (background unlike most), checked labels */
const phoneMenu = (page) =>
  page.evaluate((sel) => {
    const items = [...document.querySelectorAll(sel)];
    const label = (i) => i.textContent.trim();
    const bg = (i) => getComputedStyle(i).backgroundColor;
    const count = new Map();
    for (const i of items) count.set(bg(i), (count.get(bg(i)) ?? 0) + 1);
    const plain = [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
    const radio = (i) => i.querySelector('[role=radio]');
    const tick = (i) => { const c = i.lastElementChild; return !!c?.querySelector('svg') && getComputedStyle(c).visibility !== 'hidden'; };
    return {
      open: !!document.querySelector('[role=menu], [role=dialog] [role=radiogroup]'),
      sheet: !!document.querySelector('[role=dialog] [role=radiogroup]'),
      items: items.map(label),
      highlighted: items.filter((i) => bg(i) !== plain).map(label),
      checked: items.filter((i) => radio(i)?.getAttribute('aria-checked') === 'true').map(label),
      ticked: items.filter((i) => radio(i) && tick(i)).map(label),
      triggers: [...document.querySelectorAll('button[aria-haspopup="menu"], button[aria-haspopup="dialog"]')].map((b) => b.innerText.trim()).filter(Boolean),
    };
  }, PHONE_ITEMS);
/** the label of the focused phone-control item */
const focusedItem = (page) => page.evaluate(() => document.activeElement?.closest('[role=menuitem], [data-option-value]')?.textContent.trim() ?? document.activeElement?.textContent?.trim());

const SUITES = {
  async warmup() {
    rmSync(WARM, { recursive: true, force: true });
    const ctx = await launch(WARM);
    const page = ctx.pages()[0];
    await open(page, '/rankings');
    await settled(page, '#orcf-revenue .orcf-stat-value', 400000);
    check('warmup: market loaded', !!(await page.$('#orcf-revenue .orcf-stat-value')));
    await ctx.close();
  },

  /** periods, navigation, back/forward, header grid */
  async main() {
    const ctx = await launch(profile('main'));
    const page = ctx.pages()[0];
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message.slice(0, 150)));

    await open(page, '/rankings');
    await page.waitForSelector('#leaderboard-table [data-orcf] .orcf-inline', { timeout: 30000 });
    const keyOf = () => page.evaluate(() => [...document.querySelectorAll('#leaderboard-table [data-orcf]')].map((e) => e.dataset.key).filter(Boolean)[0]);
    check('LLM Leaderboard figures default to 7 days', /@7d$/.test((await keyOf()) ?? ''), await keyOf());
    for (const [label, want] of [['Today', '1d'], ['This Month', '30d']]) {
      await page.locator('#leaderboard-table button[aria-label="Filter by time window"]').click();
      await page.getByRole('option', { name: label }).click().catch(async () => page.locator(`[role=option]:has-text("${label}")`).first().click());
      await page.waitForTimeout(1500);
      check(`LLM Leaderboard "${label}" -> ${want}`, ((await keyOf()) ?? '').endsWith('@' + want), await keyOf());
    }

    await open(page, '/anthropic/claude-sonnet-4.5');
    await page.waitForSelector('#orcf-model-revenue .orcf-stat-value', { timeout: 30000 });
    const otherHref = await page.evaluate(() =>
      [...document.querySelectorAll('main a[href]')].map((a) => a.getAttribute('href')).find((h) => /^\/anthropic\/claude-[^/:#?]+$/.test(h) && h !== '/anthropic/claude-sonnet-4.5'),
    );
    const other = page.locator(`main a[href="${otherHref}"]`).first();
    await other.scrollIntoViewIfNeeded();
    await other.click();
    await page.waitForURL('**' + otherHref, { timeout: 15000, waitUntil: 'commit' }).catch(() => {});
    await page.waitForTimeout(4000);
    await page.goBack();
    await page.waitForTimeout(5000);
    const back = await page.evaluate(() => ({ path: location.pathname, stats: document.querySelectorAll('#orcf-model-revenue .orcf-stat-value').length, skel: document.querySelectorAll('#orcf-model-revenue .orcf-skel').length }));
    check('model page after Back shows figures', back.path.endsWith('claude-sonnet-4.5') && back.stats > 0 && back.skel === 0, back);

    await open(page, '/anthropic');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="model-list-item"] .orcf-inline:not(.is-loading)').length > 10, null, { timeout: 90000 }).catch(() => {});
    await page.locator('[data-testid="model-list-item"] a[href="/anthropic/claude-sonnet-5.5"]').first().click();
    await page.waitForTimeout(3000);
    await page.goBack();
    await page.waitForTimeout(5000);
    const a = await page.evaluate(() => ({ figs: document.querySelectorAll('[data-testid="model-list-item"] .orcf-inline:not(.is-loading)').length, skel: document.querySelectorAll('[data-testid="model-list-item"] .is-loading').length }));
    check('author cards after Back', a.figs > 10 && a.skel === 0, a);

    await open(page, '/apps/claude-code');
    await page.waitForFunction(() => document.querySelectorAll('.orcf-stat-value').length > 0, null, { timeout: 30000 }).catch(() => {});
    await page.locator('xpath=//h2[starts-with(normalize-space(.),"Top models used")]/ancestor::div[contains(@class,"rounded-lg")][1]//a[@href]').first().click();
    await page.waitForTimeout(3000);
    await page.goBack();
    await page.waitForTimeout(5000);
    const app = await page.evaluate(() => ({ stats: document.querySelectorAll('.orcf-stat-value').length, skel: document.querySelectorAll('[data-orcf] .orcf-skel').length }));
    check('app page after Back', app.stats > 0 && app.skel === 0, app);

    await open(page, '/provider/deepinfra');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="model-list-item"] .orcf-inline:not(.is-loading)').length > 10, null, { timeout: 120000 }).catch(() => {});
    await page.locator('[data-testid="model-list-item"] a[href="/deepseek"]').first().click();
    await page.waitForTimeout(3000);
    await page.goBack();
    await page.waitForTimeout(5000);
    const p = await page.evaluate(() => ({ figs: document.querySelectorAll('[data-testid="model-list-item"] .orcf-inline:not(.is-loading)').length, skel: document.querySelectorAll('[data-testid="model-list-item"] .is-loading').length }));
    check('provider cards after Back', p.figs > 10 && p.skel === 0, p);

    // model header: never cut, wrapped or taller than OpenRouter's own layout
    for (const path of ['/meta-llama/llama-3.3-70b-instruct', '/deepseek/deepseek-chat-v3.1', '/anthropic/claude-sonnet-4.5', '/google/gemini-2.5-pro']) {
      await open(page, path);
      await page.waitForSelector('.orcf-grid6, .orcf-own-row, [data-orcf].rounded-lg', { timeout: 30000 }).catch(() => {});
      for (const w of [1024, 1050, 1100, 1180, 1440]) {
        await page.setViewportSize({ width: w, height: 900 });
        await page.waitForTimeout(400);
        const r = await page.evaluate(() => {
          const g = document.querySelector('[data-orcf].rounded-lg')?.parentElement;
          if (!g) return null;
          const cut = [...g.querySelectorAll('.truncate')].filter((t) => t.scrollWidth > t.clientWidth + 1).length;
          const label = (c) => { const w = document.createTreeWalker(c, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent.trim() ? 1 : 3) }); return w.nextNode()?.parentElement; };
          const wrapped = [...g.children].map(label).filter((t) => t && t.getBoundingClientRect().height > (parseFloat(getComputedStyle(t).lineHeight) || 16) * 1.5).length;
          const max = Math.max(...[...g.children].filter((c) => !c.hasAttribute('data-orcf')).map((c) => Math.round(c.getBoundingClientRect().height)));
          return { mode: g.classList.contains('orcf-grid6') ? '6col' : g.classList.contains('orcf-own-row') ? 'own-row' : 'native', cut, wrapped, max };
        });
        check(`header ${path.split('/')[2]} @${w}`, !!r && r.cut === 0 && r.wrapped === 0 && (r.max <= 72 || r.mode === 'own-row'), r);
      }
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    check('main: no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  },

  /** clipping/overflow at many widths, phone menu, app header grid */
  async layout() {
    const ctx = await launch(profile('layout'));
    const page = ctx.pages()[0];
    for (const w of [1440, 1024, 820, 769, 600, 390]) {
      await page.setViewportSize({ width: w, height: 900 });
      await open(page, '/anthropic/claude-sonnet-4.5');
      await page.waitForSelector('#orcf-model-revenue .orcf-stat-value', { timeout: 30000 });
      await page.waitForTimeout(800);
      const o = await page.evaluate(() => [...document.querySelectorAll('[data-orcf] .orcf-stats, [data-orcf] .orcf-stat, [data-orcf] .orcf-stat-value, [data-orcf] .orcf-tr:not(.is-head) .orcf-sub')].filter((e) => e.offsetParent && e.scrollWidth > e.clientWidth + 1).map((e) => e.className.split(' ')[0] + ' ' + e.textContent.trim().slice(0, 30)));
      const doc = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(`model section unclipped @${w}`, o.length === 0 && doc <= 0, `${o.join('; ')} doc+${doc}`);
    }
    for (const [path, w] of [['/provider/deepinfra', 1440], ['/provider/deepinfra', 820], ['/rankings', 820], ['/rankings', 1024], ['/anthropic', 1024]]) {
      await page.setViewportSize({ width: w, height: 900 });
      await open(page, path);
      await settled(page);
      await page.waitForTimeout(800);
      const clipped = await page.evaluate(() => [...document.querySelectorAll('[data-orcf] .orcf-stat-sub, [data-orcf] .orcf-stat-value, [data-orcf] .orcf-stats, [data-orcf] .orcf-tr:not(.is-head) .orcf-sub')].filter((e) => e.offsetParent && e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent.trim().slice(0, 40)));
      check(`nothing clipped ${path} @${w}`, clipped.length === 0, clipped.slice(0, 4).join(' | '));
    }
    for (const w of [390, 360, 320]) {
      await page.setViewportSize({ width: w, height: 800 });
      await open(page, '/rankings');
      await page.waitForSelector('#orcf-revenue .orcf-seg', { timeout: 30000 });
      await page.waitForTimeout(800);
      const r = await page.evaluate(() => {
        const seg = document.querySelector('#orcf-revenue [aria-label="Group revenue by"]');
        const c = seg.getBoundingClientRect();
        const cut = [...seg.querySelectorAll('button')].filter((b) => { const r = b.getBoundingClientRect(); return r.right > c.right + 0.5 || r.left < c.left - 0.5; }).map((b) => b.textContent);
        return { cut, scroll: seg.scrollWidth - seg.clientWidth, sectionOut: Math.round(document.getElementById('orcf-revenue').getBoundingClientRect().right - document.documentElement.clientWidth) };
      });
      check(`rankings controls fit @${w}`, r.cut.length === 0 && r.scroll <= 0 && r.sectionOut <= 0, r);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, '/anthropic/claude-opus-5.5');
    await page.waitForSelector('#orcf-model-revenue', { state: 'attached', timeout: 30000 });
    await page.waitForTimeout(1000);
    await phoneTrigger(page, /Providers|Pricing/).click();
    await page.waitForTimeout(600);
    const { items } = await phoneMenu(page);
    check('phone menu lists Revenue after Pricing', items.indexOf('Revenue') === items.indexOf('Pricing') + 1, items.join(','));
    await page.locator(PHONE_OURS).click();
    await page.waitForTimeout(1500);
    const pm = await phoneMenu(page);
    const after = { menu: pm.open, top: Math.round(await page.evaluate(() => document.getElementById('orcf-model-revenue').getBoundingClientRect().top)), trigger: pm.triggers };
    check('phone menu item closes and scrolls', !after.menu && after.top < 400 && after.top > -50, after);
    check('phone menu button says Revenue', after.trigger.includes('Revenue'), after.trigger);
    for (const w of [1440, 820, 390]) {
      await page.setViewportSize({ width: w, height: 900 });
      await open(page, '/apps/claude-code');
      await page.waitForSelector('.orcf-grid5', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const g = await page.evaluate(() => { const g = document.querySelector('.orcf-grid5'); return g ? [...g.children].map((c) => Math.round(c.getBoundingClientRect().height)) : null; });
      check(`app header tiles even @${w}`, !!g && new Set(g.slice(0, 4)).size === 1, g);
    }
    await ctx.close();
  },

  /** OpenRouter's stats failing: errors instead of $0, nothing cached, quick */
  async errors() {
    const prof = profile('errors', false);
    let ctx = await launch(prof);
    let page = ctx.pages()[0];
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message.slice(0, 120)));
    await ctx.route(/\/api\/frontend\/v1\/(stats|rankings\/models|rankings\/apps|catalog\/models)/, (r) => r.fulfill({ status: 500, body: '{}' }));
    for (const path of ['/rankings', '/anthropic/claude-haiku-4.5', '/apps/claude-code', '/provider/deepinfra', '/nace-ai']) {
      const t0 = Date.now();
      await open(page, path);
      await page.waitForSelector('.orcf-error', { timeout: 120000 }).catch(() => {});
      const r = await page.evaluate(() => ({ err: !!document.querySelector('.orcf-error'), zero: [...document.querySelectorAll('[data-orcf] .orcf-stat-value')].map((e) => e.textContent).includes('$0') }));
      check(`error shown on ${path} within 45s`, r.err && !r.zero && Date.now() - t0 < 45000, `${Math.round((Date.now() - t0) / 1000)}s`);
    }
    check('no uncaught page errors while failing', errs.length === 0, errs.join(' | '));
    await ctx.close();
    ctx = await launch(prof);
    page = ctx.pages()[0];
    await open(page, '/anthropic/claude-haiku-4.5');
    await page.waitForSelector('#orcf-model-revenue .orcf-stat-value', { timeout: 60000 }).catch(() => {});
    const v = await page.evaluate(() => document.querySelector('#orcf-model-revenue .orcf-stat-value')?.textContent);
    check('recovers after failure (nothing cached as $0)', !!v && v !== '$0', v);
    await ctx.close();
  },

  /** section nav: highlight, hash, deep links, no snapping, keyboard in the phone menu */
  async nav() {
    const ctx = await launch(profile('nav'));
    const page = ctx.pages()[0];
    const navState = (id) => page.evaluate((id) => ({ ours: document.querySelector(`a[data-orcf][href="#${id}"]`)?.getAttribute('aria-current'), cur: [...document.querySelectorAll('a[aria-current="page"]')].map((a) => a.getAttribute('href')), hash: location.hash }), id);

    await open(page, '/rankings');
    await settled(page, '#orcf-revenue .orcf-stat-value');
    await page.waitForTimeout(1500);
    await page.locator('a[data-orcf][href="#orcf-revenue"]').first().click();
    await page.waitForTimeout(1500);
    const n1 = await navState('orcf-revenue');
    check('sidebar: Revenue current after click, hash ours', n1.ours === 'page' && n1.cur.length === 1 && n1.hash === '#orcf-revenue', n1);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(800);
    const n2 = await navState('orcf-revenue');
    check('sidebar: highlight handed back at the top', n2.ours !== 'page' && n2.cur.length === 1, n2);

    // entering the section (no hash in the URL) never snaps back to its top
    await open(page, '/rankings');
    await settled(page, '#orcf-revenue .orcf-stat-value');
    await page.waitForTimeout(2000);
    await page.evaluate(() => { const s = document.getElementById('orcf-revenue'); window.scrollTo(0, s.getBoundingClientRect().top + window.scrollY + 600); });
    await page.waitForTimeout(2500);
    const jump = await page.evaluate(() => Math.round(document.getElementById('orcf-revenue').getBoundingClientRect().top));
    check('jumping into the section stays put', jump < -500 && jump > -700, `top=${jump}`);
    await page.evaluate(() => { const s = document.getElementById('orcf-revenue'); window.scrollTo(0, s.getBoundingClientRect().top + window.scrollY - 300); });
    await page.waitForTimeout(800);
    await page.mouse.click(5, 500).catch(() => {});
    const y0 = await page.evaluate(() => scrollY);
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(1200);
    const y1 = await page.evaluate(() => scrollY);
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(1200);
    const y2 = await page.evaluate(() => scrollY);
    check('PageDown steps are not shortened', y1 - y0 > 600 && y2 - y1 > 600, `steps ${y1 - y0}, ${y2 - y1}`);

    await open(page, '/rankings#orcf-revenue');
    await page.waitForTimeout(6000);
    const dl = await page.evaluate(() => Math.round(document.getElementById('orcf-revenue')?.getBoundingClientRect().top ?? -9999));
    const dln = await navState('orcf-revenue');
    check('deep link lands on the section, Revenue current', dl > -50 && dl < 400 && dln.ours === 'page' && dln.hash === '#orcf-revenue', { top: dl, ...dln });

    await open(page, '/anthropic/claude-sonnet-4.5#orcf-model-revenue');
    await page.waitForTimeout(5000);
    const mt = await page.evaluate(() => Math.round(document.getElementById('orcf-model-revenue')?.getBoundingClientRect().top ?? -9999));
    const mn = await navState('orcf-model-revenue');
    check('model deep link + Revenue current', mt > -50 && mt < 400 && mn.ours === 'page' && mn.cur.length === 1, { top: mt, ...mn });

    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, '/anthropic/claude-opus-5.5');
    await page.waitForSelector('#orcf-model-revenue', { state: 'attached', timeout: 30000 });
    await page.waitForTimeout(1200);
    const trig = phoneTrigger(page, /Providers|Pricing/);
    await trig.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    const seen = [];
    for (let k = 0; k < 4; k++) {
      seen.push(await focusedItem(page));
      if (seen.at(-1) === 'Revenue') break;
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(150);
    }
    check('phone menu: ArrowDown reaches Revenue', seen.includes('Revenue'), seen.join(' > '));
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1800);
    const mob = { menu: (await phoneMenu(page)).open, top: Math.round(await page.evaluate(() => document.getElementById('orcf-model-revenue').getBoundingClientRect().top)) };
    check('phone menu: Enter chooses Revenue', !mob.menu && mob.top < 400 && mob.top > -50, mob);
    await ctx.close();
  },

  /** keyboard, focus, tooltips, aria */
  async a11y() {
    const ctx = await launch(profile('a11y'));
    const page = ctx.pages()[0];
    await open(page, '/rankings');
    await settled(page, '#orcf-revenue .orcf-stat-value');
    await page.locator('#orcf-revenue [aria-label="Time window"] [aria-checked="true"]').focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
    const sel = await page.evaluate(() => document.querySelector('#orcf-revenue [aria-label="Time window"] [aria-checked="true"]')?.textContent);
    check('radio group: ArrowRight moves the selection', sel === '30 days', sel);
    const lastCol = await page.evaluate(() => [...document.querySelectorAll('#orcf-revenue g.col')].at(-1)?.getAttribute('aria-label'));
    check('chart labels name the biggest series, not Other', /OpenAI|Google|Anthropic/.test(lastCol ?? '') && !/Other/.test(lastCol ?? ''), lastCol);

    // tooltips: pointer hides on scroll; keyboard follows, hides off-screen and under the sticky header
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(3000);
    const fig = page.locator('#orcf-revenue .orcf-tr:not(.is-head) .orcf-strong').nth(3);
    const tip = () => page.evaluate(() => { const t = document.querySelector('.orcf-tip'); return t ? { shown: getComputedStyle(t).display === 'block', top: Math.round(t.getBoundingClientRect().top) } : { shown: false }; });
    let p0 = { shown: false };
    for (let i = 0; i < 6 && !p0.shown; i++) {
      await fig.evaluate((n) => window.scrollTo(0, n.getBoundingClientRect().top + window.scrollY - 400));
      await page.waitForTimeout(700);
      const bb = await fig.boundingBox();
      if (!(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.orcf-strong'), [bb.x + bb.width / 2, bb.y + bb.height / 2]))) continue;
      await page.mouse.move(bb.x + bb.width / 2 - 6, bb.y + bb.height / 2, { steps: 2 });
      await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2, { steps: 2 });
      await page.waitForTimeout(300);
      p0 = await tip();
    }
    await page.mouse.move(5, 5);
    await page.evaluate(() => window.scrollBy(0, 120));
    await page.waitForTimeout(400);
    const p1 = await tip();
    check('pointer tooltip hides on scroll', p0.shown && !p1.shown, `${JSON.stringify(p0)} -> ${JSON.stringify(p1)}`);
    await fig.evaluate((n) => window.scrollTo(0, n.getBoundingClientRect().top + window.scrollY - 400));
    await page.waitForTimeout(300);
    await fig.focus();
    await page.waitForTimeout(300);
    const k0 = await tip();
    await page.evaluate(() => window.scrollBy(0, 120));
    await page.waitForTimeout(400);
    const k1 = await tip();
    check('keyboard tooltip follows its figure', k0.shown && k1.shown && Math.abs(k0.top - k1.top - 120) <= 4, `${JSON.stringify(k0)} -> ${JSON.stringify(k1)}`);
    await fig.evaluate((n) => window.scrollTo(0, n.getBoundingClientRect().top + window.scrollY - 60));
    await page.waitForTimeout(500);
    const k2 = await tip();
    check('keyboard tooltip hides under the sticky header', !k2.shown, k2);

    await page.locator('#orcf-revenue [aria-label="Group revenue by"] button:has-text("Apps")').click();
    await page.waitForSelector('#orcf-revenue .orcf-table[aria-label="Spend by app"]', { timeout: 120000 }).catch(() => {});
    const aria = await page.evaluate(() => document.querySelector('#orcf-revenue .orcf-table')?.getAttribute('aria-label'));
    check('apps aria wording says spend', aria === 'Spend by app', aria);

    await open(page, '/anthropic/claude-sonnet-4.5');
    await page.waitForSelector('#orcf-model-revenue .orcf-stat-value', { timeout: 30000 });
    await page.locator('#orcf-model-revenue button:has-text("30 days")').click();
    await page.waitForTimeout(800);
    const stop = await page.evaluate(() => { const c = [...document.querySelectorAll('#orcf-model-revenue g.col')]; return { stops: c.filter((g) => g.getAttribute('tabindex') === '0').length, i: c.findIndex((g) => g.getAttribute('tabindex') === '0'), n: c.length }; });
    check('chart: one Tab stop, on the latest day', stop.stops === 1 && stop.i === stop.n - 1, stop);
    await page.locator('#orcf-model-revenue g.col[tabindex="0"]').focus();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(300);
    const ov = await page.evaluate(() => { const g = document.activeElement.getBoundingClientRect(); const t = document.querySelector('.orcf-tip').getBoundingClientRect(); return { ring: !!document.querySelector('#orcf-model-revenue .focus-ring'), overlap: Math.round(Math.min(g.right, t.right) - Math.max(g.left, t.left)) }; });
    check('chart: focus ring, tooltip beside the column', ov.ring && ov.overlap <= 0, ov);
    await ctx.close();
  },

  /** coverage, unknown prices, non-token providers, empty pages */
  async data() {
    const ctx = await launch(profile('data'));
    const page = ctx.pages()[0];
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message.slice(0, 150)));
    await open(page, '/provider/novita');
    await settled(page);
    await page.waitForTimeout(1500);
    const n = await page.evaluate(() => ({ foot: [...document.querySelectorAll('[data-orcf] p.orcf-xs')].map((p) => p.textContent).join(' '), rows: [...document.querySelectorAll('[data-orcf] .orcf-tr:not(.is-head) .orcf-name')].map((a) => a.textContent) }));
    const cov = Number((n.foot.match(/Covers ([\d.]+)%/) ?? [])[1]);
    check('novita: chart covered (or the note says totals are low)', cov >= 95 || /totals are low/.test(n.foot), `cov=${cov}`);
    check('novita: models it no longer lists are priced (MiMo)', n.rows.some((t) => /mimo/i.test(t)), n.rows.slice(0, 10));
    await open(page, '/provider/ai21');
    await page.waitForTimeout(9000);
    const ai = await page.evaluate(() => ({ empty: document.querySelector('[data-orcf] .orcf-empty')?.textContent, progress: !!document.querySelector('[data-orcf] .orcf-progress') }));
    check('provider without models finishes', !!ai.empty && !ai.progress, ai);
    await open(page, '/provider/runway');
    await page.waitForTimeout(9000);
    const rw = await page.evaluate(() => ({ empty: document.querySelector('[data-orcf] .orcf-empty')?.textContent?.trim(), zero: [...document.querySelectorAll('[data-orcf] .orcf-stat-value')].map((e) => e.textContent).includes('$0') }));
    check('runway (per-second video) explains instead of $0', /aren’t counted|no longer lists a price/i.test(rw.empty ?? '') && !rw.zero, rw);
    await open(page, '/poolside');
    await settled(page, '[data-orcf] .orcf-stat-value, [data-orcf] .orcf-empty', 90000);
    await page.waitForTimeout(1500);
    const pl = await page.evaluate(() => ({
      said: /Laguna S 2\.1[\s\S]{0,80}(no longer lists a price|no price data)/.test([...document.querySelectorAll('[data-orcf]')].map((e) => e.innerText).join(' ')),
      zeroRow: [...document.querySelectorAll('[data-orcf] .orcf-tr:not(.is-head)')].some((r) => /Laguna S 2\.1/.test(r.textContent) && /\$0(?![.\d])/.test(r.textContent)),
      cards: [...document.querySelectorAll('[data-testid="model-list-item"] [data-orcf]')].map((e) => e.textContent.trim()),
    }));
    check('poolside: unpriceable model named, not shown as $0', pl.said && !pl.zeroRow && !pl.cards.some((t) => /^\$0/.test(t)), pl);
    await open(page, '/apps/claude-code');
    await page.waitForSelector('.orcf-stat-value', { timeout: 60000 });
    const badge = page.locator('#apps [data-orcf] .orcf-inline');
    check('app page renders spend', (await page.$$('.orcf-stat-value')).length >= 4);
    await open(page, '/rankings');
    await page.waitForSelector('#apps [data-orcf] .orcf-inline', { timeout: 60000 });
    await page.waitForTimeout(2500);
    await badge.first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(1500);
    await badge.first().hover();
    await page.waitForTimeout(600);
    const names = await page.evaluate(() => [...document.querySelectorAll('.orcf-tip .orcf-tip-row span')].map((e) => e.textContent.trim()));
    check('app tooltips show model names, not slugs', names.length > 0 && !names.some((t) => /^[a-z0-9]+(-[a-z0-9.]+)+$/.test(t)), names);
    check('data: no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();

    const ctx2 = await launch(profile('data-chartfail'));
    const p2 = ctx2.pages()[0];
    await ctx2.route(/stats\/provider-token-chart\?provider=novita$/, (r) => r.fulfill({ status: 500, body: '{}' }));
    await open(p2, '/provider/novita');
    await settled(p2);
    await p2.waitForTimeout(1500);
    const foot = await p2.evaluate(() => [...document.querySelectorAll('[data-orcf] p.orcf-xs')].map((p) => p.textContent).join(' '));
    check('provider chart failure is disclosed', /token chart couldn’t be loaded/.test(foot), foot.slice(-200));
    await ctx2.close();
  },

  /** partial failures and full outages */
  async outage() {
    const ctx = await launch(profile('outage', false));
    const page = ctx.pages()[0];
    await ctx.route(/stats\/model-activity\?.*claude-opus-5\.5/, (r) => r.fulfill({ status: 500, body: '{}' }));
    await open(page, '/rankings');
    await settled(page, '#orcf-revenue .orcf-stat-value', 400000);
    const t = await page.evaluate(() => document.querySelector('#orcf-revenue .orcf-stat-sub')?.textContent);
    check('failed share of spend flagged in the tile', /couldn't be loaded/.test(t ?? ''), t);
    const opus = await page.evaluate(() => [...document.querySelectorAll('[data-testid="model-rankings-leaderboard-row"]')].find((r) => /Claude Opus 5\.5/.test(r.textContent))?.querySelector('[data-orcf]')?.textContent?.trim());
    check('failed leaderboard figure shows a dash', opus === '—', opus);
    await ctx.unroute(/stats\/model-activity/);
    await ctx.route(/stats\/(model-activity|effective-pricing|provider-token-chart)/, (r) => r.fulfill({ status: 500, body: '{}' }));
    const p2 = await ctx.newPage();
    await open(p2, '/rankings');
    await p2.waitForSelector('#apps [data-orcf]', { timeout: 30000 }).catch(() => {});
    await p2.waitForFunction(() => ![...document.querySelectorAll('#apps [data-orcf]')].some((e) => e.querySelector('.is-loading')), null, { timeout: 120000 }).catch(() => {});
    const apps = await p2.evaluate(() => [...document.querySelectorAll('#apps [data-orcf]')].map((e) => e.textContent.trim()));
    check('app figures never $0 on failure', apps.length > 0 && !apps.some((x) => /^\$0/.test(x)), apps.slice(0, 6));
    await ctx.close();

    const ctx2 = await launch(profile('outage2', false));
    const q = ctx2.pages()[0];
    await ctx2.route(/\/api\/frontend\/v1\/stats\//, (r) => r.abort());
    for (const path of ['/provider/deepinfra', '/rankings']) {
      const t0 = Date.now();
      await open(q, path);
      await q.waitForSelector('.orcf-error', { timeout: 240000 }).catch(() => {});
      const secs = Math.round((Date.now() - t0) / 1000);
      check(`full outage error on ${path} within 45s`, secs <= 45 && !!(await q.$('.orcf-error')), `${secs}s`);
    }
    await ctx2.close();
  },

  /** round 7: menu highlight, landing line, models nobody prices, app rows, loading copy */
  async r7() {
    const ctx = await launch(profile('r7'));
    const page = ctx.pages()[0];
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message.slice(0, 150)));

    // U20: our section lands where OpenRouter's own sections land
    await open(page, '/rankings');
    await page.waitForSelector('#orcf-revenue', { state: 'attached', timeout: 30000 });
    await page.waitForTimeout(1500);
    const m = await page.evaluate(() => ['orcf-revenue', 'leaderboard-table', 'apps'].map((id) => getComputedStyle(document.getElementById(id)).scrollMarginTop));
    check('desktop: Revenue scroll margin = OpenRouter sections', m[0] === m[1] && m[1] === m[2], m);
    await page.locator('a[data-orcf][href="#orcf-revenue"]').first().click();
    await page.waitForTimeout(1500);
    const tops = await page.evaluate(() => Math.round(document.getElementById('orcf-revenue').getBoundingClientRect().top));
    await page.locator('a[href="#apps"]:not([data-orcf])').first().click();
    await page.waitForTimeout(1500);
    const topApps = await page.evaluate(() => Math.round(document.getElementById('apps').getBoundingClientRect().top));
    check('desktop: Revenue lands level with Top Apps', Math.abs(tops - topApps) <= 2, { revenue: tops, apps: topApps });

    // U19: one highlighted item in the phone menu
    await page.setViewportSize({ width: 390, height: 844 });
    const menuState = async (id) => {
      await page.evaluate((id) => { const s = document.getElementById(id); window.scrollTo(0, s.getBoundingClientRect().top + scrollY - 120); }, id);
      await page.waitForTimeout(1500);
      await phoneTrigger(page, /Leaderboard|Revenue|Top|Market|Apps|Benchmarks|Cost/).click();
      await page.waitForTimeout(700);
      const m = await phoneMenu(page);
      // the sheet also marks the choice with its radio and a check: exactly one of each, on the same item
      const r = m.sheet ? (m.checked.join() === m.highlighted.join() && m.ticked.join() === m.highlighted.join() ? m.highlighted : [...m.highlighted, '|checked:', ...m.checked, '|ticked:', ...m.ticked]) : m.highlighted;
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      return r;
    };
    await open(page, '/rankings');
    await page.waitForSelector('#orcf-revenue .orcf-stat-value', { timeout: 60000 });
    const inLb = await menuState('leaderboard-table');
    check('phone menu in Leaderboard: only Leaderboard highlighted', inLb.length === 1 && inLb[0] === 'Leaderboard', inLb);
    const inRev = await menuState('orcf-revenue');
    check('phone menu in Revenue: only Revenue highlighted', inRev.length === 1 && inRev[0] === 'Revenue', inRev);
    const back = await menuState('leaderboard-table');
    check('phone menu back in Leaderboard: highlight handed back', back.length === 1 && back[0] === 'Leaderboard', back);
    await page.setViewportSize({ width: 1440, height: 900 });

    // V23 + V24: a model nobody prices any more still gets the card and section, after Activity
    await open(page, '/poolside/laguna-s-2.1');
    await page.waitForSelector('#orcf-model-revenue', { state: 'attached', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(4000);
    const v = await page.evaluate(() => ({
      card: document.querySelector('[data-orcf].rounded-lg')?.innerText.replace(/\s+/g, ' '),
      after: document.getElementById('orcf-model-revenue')?.previousElementSibling?.id,
      body: document.querySelector('#orcf-model-revenue .orcf-empty')?.textContent,
      nav: [...document.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute('href')).filter((h) => h !== '#skip').join(','),
    }));
    check('unpriced model: header card says price unknown', /price unknown/.test(v.card ?? ''), v.card);
    check('unpriced model: section after Activity explains', v.after === 'activity' && /no price data/.test(v.body ?? ''), v);
    check('unpriced model: nav entry after Activity', /#activity,#orcf-model-revenue/.test(v.nav), v.nav);
    await open(page, '/anthropic/claude-sonnet-4.5');
    await page.waitForSelector('#orcf-model-revenue', { state: 'attached', timeout: 30000 });
    await page.waitForTimeout(1500);
    const icons = await page.evaluate(() => [document.querySelector('#orcf-model-revenue svg'), document.querySelector('a[data-orcf][href="#orcf-model-revenue"] svg')].map((s) => [...(s?.children ?? [])].map((c) => c.outerHTML).join('')));
    check('section heading and nav entry share the icon', !!icons[0] && icons[0] === icons[1], icons.map((x) => x.slice(0, 60)));
    const placed = await page.evaluate(() => document.getElementById('orcf-model-revenue')?.previousElementSibling?.id);
    check('priced model: section still follows Pricing', placed === 'pricing', placed);

    // W18 / Y20: an app's row for a model with no price says so instead of $0
    await open(page, '/apps/claude-code');
    await page.waitForSelector('.orcf-stat-value', { timeout: 60000 });
    const more = page.locator('xpath=//h2[starts-with(normalize-space(.),"Top models used")]/ancestor::div[contains(@class,"rounded-lg")][1]//button[contains(.,"Show more")]');
    if (await more.count()) await more.first().click();
    await page.waitForTimeout(6000);
    const rows = await page.evaluate(() => [...document.querySelectorAll('.orcf-row-extra')].map((e) => e.closest('a,li,div[class*="flex"]')?.innerText.replace(/\s+/g, ' ').slice(0, 80)));
    const zero = rows.filter((t) => /\$0(?![.\d])/.test(t ?? '') && !/free/.test(t ?? ''));
    check('app rows: no paid model shown as $0', zero.length === 0, zero);
    // a stealth model whose free period ended counts as free (W37); other unpriced models say "price unknown"
    check('app rows: unpriced models labelled, not $0', rows.filter((t) => /Space Bunny/.test(t ?? '')).every((t) => /price unknown|free · \$0/.test(t ?? '')), rows.filter((t) => /Space Bunny|price unknown/.test(t ?? '')));
    check('r7: no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();

    // W19: no "0 tokens" while a cold provider page is still loading
    const cold = await launch(profile('r7-cold', false));
    const q = cold.pages()[0];
    await open(q, '/provider/novita');
    await q.waitForSelector('[data-orcf] .orcf-stats', { timeout: 30000 });
    let sawZero = false;
    for (let i = 0; i < 20; i++) {
      const t = await q.evaluate(() => ({ loading: !!document.querySelector('[data-orcf] .orcf-progress'), text: document.querySelector('[data-orcf] .orcf-stats')?.innerText ?? '' }));
      if (t.loading && /(^|\s)0\s*tokens/.test(t.text)) sawZero = true;
      if (!t.loading) break;
      await q.waitForTimeout(500);
    }
    check('loading tiles never claim 0 tokens', !sawZero);
    await cold.close();
  },

  /** round 8: free models, app-token failures, menu hover, layout shift, tooltip fit, grouping totals */
  async r8() {
    const ctx = await launch(profile('r8'));
    const page = ctx.pages()[0];
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message.slice(0, 150)));
    const text = () => page.evaluate(() => [...document.querySelectorAll('[data-orcf]')].map((e) => e.innerText).join(' \n '));

    // W20: a stealth model with only free endpoints is free, not "price unknown"
    await open(page, '/provider/stealth');
    await settled(page, '[data-orcf] .orcf-stat-value, [data-orcf] .orcf-empty', 90000);
    await page.waitForTimeout(2000);
    const st = await text();
    const cards = await page.evaluate(() => [...document.querySelectorAll('[data-testid="model-list-item"]')].map((c) => c.innerText.replace(/\s+/g, ' ')).filter((t) => /Crouton/.test(t)));
    check('free stealth model is not "price unknown"', !/Crouton Alpha[^.]*no longer lists a price/.test(st) && !cards.some((t) => /price unknown/.test(t)), cards);
    check('free stealth model card says free', cards.some((t) => /free · \$0/.test(t)), cards);
    // W22: no coverage claim under a "nothing priced" message
    await open(page, '/poolside');
    await settled(page, '[data-orcf] .orcf-stat-value, [data-orcf] .orcf-empty', 90000);
    await page.waitForTimeout(2000);
    const pl = await text();
    check('nothing-priced page has no coverage/low-totals footnote', !/Covers [\d.]+%/.test(pl) || !/no longer lists a price/.test(pl), pl.slice(-300));

    // V25: a retired :free page is free, never the paid model's revenue
    for (const path of ['/openai/gpt-oss-120b:free', '/meta-llama/llama-3.3-70b-instruct:free']) {
      await open(page, path);
      await page.waitForSelector('[data-orcf].rounded-lg', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(4000);
      const v = await page.evaluate(() => ({ card: document.querySelector('[data-orcf].rounded-lg')?.innerText.replace(/\s+/g, ' '), sec: document.querySelector('#orcf-model-revenue .orcf-empty')?.textContent }));
      check(`retired free variant ${path} shows free`, /free · \$0/.test(v.card ?? '') && /free variant/.test(v.sec ?? ''), v);
    }

    // W21 + W23: free-only rows and mostly-estimated spend on an app
    await open(page, '/apps/url/https%3A%2F%2Fcommandcode.ai%2F');
    await page.waitForSelector('.orcf-stat-value', { timeout: 60000 });
    const more = page.locator('xpath=//h2[starts-with(normalize-space(.),"Top models used")]/ancestor::div[contains(@class,"rounded-lg")][1]//button[contains(.,"Show more")]');
    if (await more.count()) await more.first().click();
    await page.waitForTimeout(8000);
    const rows = await page.evaluate(() => [...document.querySelectorAll('.orcf-row-extra')].map((e) => ({ t: e.closest('a,li,div[class*="flex"]')?.innerText.replace(/\s+/g, ' ').slice(0, 80), title: e.querySelector('[title]')?.getAttribute('title') })));
    const failedFree = rows.filter((r) => /\(free\)/.test(r.t ?? '') && /—/.test(r.t ?? ''));
    check('free-only models in app rows say free, not a load failure', failedFree.length === 0, failedFree);
    check('no app row shows a load failure', !rows.some((r) => /Couldn't load/.test(r.title ?? '')), rows.filter((r) => /Couldn't load/.test(r.title ?? '')));
    for (const label of ['Yesterday', '7 days', '30 days']) {
      await page.locator(`.orcf [aria-label="Time window"] button:has-text("${label}")`).first().click();
      await page.waitForTimeout(2500);
      const a = await page.evaluate(() => ({ share: Number(([...document.querySelectorAll('.orcf-stat-sub')].map((e) => e.textContent).join(' ').match(/(\d+)% (of tokens )?priced per model/) ?? [])[1]), tile: document.querySelector('.orcf-stat-sub')?.textContent, header: document.querySelector('.orcf-grid5 [data-orcf]')?.innerText.replace(/\s+/g, ' ') }));
      if (a.share < 50) check(`commandcode ${label}: ${a.share}% priced is marked as estimate`, /mostly estimated|30-day rate/.test(a.tile ?? '') && /estimate/.test(a.header ?? ''), a);
      else check(`commandcode ${label}: ${a.share}% priced (no estimate marker needed)`, !/mostly estimated/.test(a.tile ?? ''), a);
    }

    // U24: the same token total in every grouping
    await open(page, '/rankings');
    await settled(page, '#orcf-revenue .orcf-stat-value');
    const avg = [];
    for (const dim of ['Providers', 'Companies', 'Models', 'Authors']) {
      await page.locator(`#orcf-revenue [aria-label="Group revenue by"] button:has-text("${dim}")`).click();
      await page.waitForTimeout(700);
      avg.push(await page.evaluate(() => [...document.querySelectorAll('#orcf-revenue .orcf-stat')].at(-1)?.innerText.replace(/\s+/g, ' ')));
    }
    check('Avg $/1M tile identical across groupings', new Set(avg).size === 1, avg);

    // U21: hovering our phone-menu item looks like hovering theirs
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, document.getElementById('leaderboard-table').getBoundingClientRect().top + scrollY - 120));
    await page.waitForTimeout(1500);
    await phoneTrigger(page, /Leaderboard|Top/).click();
    await page.waitForTimeout(600);
    await page.locator(PHONE_ITEMS).filter({ hasText: 'Market Share' }).hover();
    await page.waitForTimeout(250);
    const theirHover = await page.locator(PHONE_ITEMS).filter({ hasText: 'Market Share' }).evaluate((e) => getComputedStyle(e).backgroundColor);
    await page.locator(PHONE_OURS).hover();
    await page.waitForTimeout(250);
    const ourHover = await page.locator(PHONE_OURS).evaluate((e) => getComputedStyle(e).backgroundColor);
    const sel = await page.evaluate((s) => getComputedStyle([...document.querySelectorAll(s)].find((i) => i.textContent.trim() === 'Leaderboard')).backgroundColor, PHONE_ITEMS);
    check('phone menu: our hover looks like theirs, not like selected', ourHover === theirHover && ourHover !== sel, { ourHover, theirHover, sel });
    await page.keyboard.press('Escape');

    // U23: a keyboard card never covers its figure on a phone
    await page.evaluate(() => window.scrollTo(0, document.getElementById('orcf-revenue').getBoundingClientRect().top + scrollY - 100));
    await page.waitForTimeout(800);
    const overlaps = [];
    const figs = page.locator('#orcf-revenue .orcf-tr:not(.is-head) [tabindex="0"]');
    const n = Math.min(6, await figs.count());
    for (let i = 0; i < n; i++) {
      await figs.nth(i).focus();
      await page.waitForTimeout(250);
      const o = await figs.nth(i).evaluate((f) => { const t = document.querySelector('.orcf-tip'); if (!t || getComputedStyle(t).display === 'none') return 0; const a = f.getBoundingClientRect(), b = t.getBoundingClientRect(); return Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) * Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)); });
      if (o > 0) overlaps.push(i);
    }
    check('phone: keyboard cards never cover their figure', overlaps.length === 0, { checked: n, overlaps });
    check('r8: no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();

    // U22: a cold deep link lands where it should even though row figures load afterwards
    const cold = await launch(profile('r8-cold', false));
    const q = cold.pages()[0];
    await open(q, '/rankings#orcf-revenue');
    await q.waitForSelector('#leaderboard-table [data-orcf] .orcf-inline:not(.is-loading)', { timeout: 120000 }).catch(() => {});
    await q.waitForTimeout(3000);
    const top = await q.evaluate(() => Math.round(document.getElementById('orcf-revenue').getBoundingClientRect().top));
    const h = await q.evaluate(() => { const r = document.querySelector('[data-testid="model-rankings-leaderboard-row"]'); return Math.round(r.getBoundingClientRect().height); });
    check('cold deep link still lands at the section line after figures load', Math.abs(top - 128) <= 3, { top, rowHeight: h });
    await cold.close();

    // Y22: the model page says so when app usage can't be loaded
    const ctx3 = await launch(profile('r8-apps'));
    await ctx3.route(/stats\/top-apps-for-model/, (r) => r.fulfill({ status: 500, body: '{}' }));
    const p3 = ctx3.pages()[0];
    await open(p3, '/anthropic/claude-sonnet-4.5');
    await p3.waitForSelector('#apps', { timeout: 30000 });
    await p3.evaluate(() => document.getElementById('apps').scrollIntoView());
    await p3.waitForTimeout(12000);
    const lines = await p3.evaluate(() => [...document.querySelectorAll('#apps .orcf-row-extra')].map((e) => e.querySelector('[title]')?.getAttribute('title') ?? e.textContent));
    check('app usage failure shown on model page rows', lines.length > 0 && lines.every((t) => /Couldn't load/.test(t ?? '')), lines.slice(0, 3));
    await ctx3.close();
  },

  /** round 9: free-variant split in app spend, rerank/video pricing, names, authors, retry, tooltip fit */
  async r9() {
    const ctx = await launch(profile('r9'));
    const page = ctx.pages()[0];
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message.slice(0, 150)));

    // U29: free-variant traffic isn't priced as paid (Kilo Code on Nemotron 3 Ultra)
    await open(page, '/apps/kilo-code');
    await page.waitForSelector('.orcf-stat-value', { timeout: 90000 });
    await page.locator('.orcf [aria-label="Time window"] button:has-text("Yesterday")').first().click();
    await page.waitForTimeout(3000);
    const row = page.locator('.orcf-row-extra').filter({ has: page.locator('.orcf-num') });
    const kilo = await page.evaluate(() => [...document.querySelectorAll('.orcf-row-extra')].map((e) => e.closest('a,li,div[class*="flex"]')?.innerText.replace(/\s+/g, ' ').slice(0, 90)));
    const ultra = kilo.find((t) => /Nemotron 3 Ultra/.test(t ?? ''));
    const usd = (t) => { const m = (t ?? '').match(/\$([\d.]+)([KMB]?)/); return m ? Number(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[m[2]] ?? 1) : NaN; };
    check('Kilo Code: Nemotron 3 Ultra (mostly free traffic) not priced as paid', !ultra || usd(ultra) < 50_000, ultra);
    const ultraEl = page.locator('.orcf-row-extra').filter({ hasText: '$' }).locator('xpath=ancestor::*[contains(., "Nemotron 3 Ultra")][1]//*[contains(@class,"orcf-inline")]').first();
    if (ultra && (await ultraEl.count())) {
      await ultraEl.focus();
      await page.waitForTimeout(400);
      const tip = await page.evaluate(() => document.querySelector('.orcf-tip')?.innerText ?? '');
      check('row tooltip discloses the free-variant share', /free variant/.test(tip), tip.slice(0, 200));
    }

    // W24 / Y25: reranks are priced, video models aren't called free
    await open(page, '/mongodb');
    await settled(page, '[data-orcf] .orcf-stat-value, [data-orcf] .orcf-empty', 90000);
    await page.waitForTimeout(2000);
    const rr = await page.evaluate(() => [...document.querySelectorAll('[data-testid="model-list-item"]')].map((c) => c.innerText.replace(/\s+/g, ' ')).filter((t) => /rerank/i.test(t)).map((t) => t.slice(0, 60) + ' … ' + (t.match(/(free · \$0|\$[\d.]+[KMB]?\s*·\s*\w+|price unknown)/)?.[0] ?? '')));
    check('rerank models priced, not "free"', rr.length > 0 && rr.every((t) => !/free · \$0/.test(t)) && rr.some((t) => /\$[\d.]+[KMB]?\s*·/.test(t)), rr);
    await open(page, '/runway/gen-4.5');
    await page.waitForSelector('[data-orcf].rounded-lg', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(4000);
    const vid = await page.evaluate(() => ({ card: document.querySelector('[data-orcf].rounded-lg')?.innerText.replace(/\s+/g, ' '), sec: document.querySelector('#orcf-model-revenue .orcf-empty')?.textContent }));
    check('per-second video model is not "free"', !/free/.test((vid.card ?? '') + (vid.sec ?? '')), vid);

    // V27 / W25: a standalone free model isn't "a free variant"
    await open(page, '/stealth/crouton-alpha');
    await page.waitForSelector('#orcf-model-revenue', { state: 'attached', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);
    const cr = await page.evaluate(() => document.querySelector('#orcf-model-revenue .orcf-empty')?.textContent ?? '');
    check('standalone free model says "This model is free"', /This model is free/.test(cr), cr);
    await open(page, '/provider/stealth');
    await settled(page);
    await page.waitForTimeout(1500);
    const stl = await page.evaluate(() => [...document.querySelectorAll('[data-orcf] .orcf-tr:not(.is-head)')].map((r) => r.innerText.replace(/\s+/g, ' ')).filter((t) => /Crouton/.test(t)));
    check('provider table: "free model", not "free variant"', stl.length > 0 && stl.every((t) => /free model/.test(t)), stl);

    // W27: legend names on an app page
    await open(page, '/apps/roo-code');
    // the window is one for the tab (W45) and was set to Yesterday above, which has no daily chart
    await page.locator('.orcf [aria-label="Time window"] button:has-text("7 days")').first().click({ timeout: 30000 });
    await page.waitForSelector('.orcf-chart', { timeout: 90000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const legend = await page.evaluate(() => [...document.querySelectorAll('.orcf .orcf-legend > *')].map((e) => e.textContent.trim()));
    const slugs = legend.filter((t) => /^[a-z0-9]+([.-][a-z0-9]+)+$/.test(t));
    check('app legend shows names, not slugs', legend.length > 0 && slugs.length === 0, legend);

    // U26 / U27 / U28 on /rankings
    await open(page, '/rankings');
    await settled(page, '#orcf-revenue .orcf-stat-value');
    await page.locator('#orcf-revenue [aria-label="Group revenue by"] button:has-text("Apps")').click();
    await page.waitForSelector('#orcf-revenue .orcf-table[aria-label="Spend by app"]', { timeout: 120000 }).catch(() => {});
    await page.waitForTimeout(4000);
    const more = page.locator('#orcf-revenue .orcf-more');
    if (await more.count()) await more.click();
    await page.waitForTimeout(1500);
    const subs = await page.evaluate(() => [...document.querySelectorAll('#orcf-revenue .orcf-tr:not(.is-head) .orcf-sub')].map((e) => e.textContent.trim()));
    const raw = subs.filter((t) => /top model: [a-z0-9]+([.-][a-z0-9]+)+$/.test(t));
    check('Apps grouping: top models by name', raw.length === 0, raw);
    await page.locator('#orcf-revenue [aria-label="Group revenue by"] button:has-text("Authors")').click();
    await page.waitForTimeout(800);
    for (let i = 0; i < 3 && (await more.count()); i++) { await more.click(); await page.waitForTimeout(500); }
    const links = await page.evaluate(() => [...document.querySelectorAll('#orcf-revenue .orcf-tr:not(.is-head) a[href]')].map((a) => a.getAttribute('href')));
    const bad = links.filter((h) => /^\/(text-embedding|gpt-|o\d)/.test(h));
    check('Authors grouping: no model id posing as an author', bad.length === 0, bad);

    // U25: phone keyboard cards never cover figures, also near the bottom of the screen
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#orcf-revenue [aria-label="Group revenue by"] button:has-text("Providers")').click();
    await page.waitForTimeout(800);
    const figs = page.locator('#orcf-revenue .orcf-tr:not(.is-head) [tabindex="0"]');
    const n = Math.min(10, await figs.count());
    const covered = [];
    for (let i = 0; i < n; i++) {
      await figs.nth(i).evaluate((f) => window.scrollTo(0, f.getBoundingClientRect().top + scrollY - (window.innerHeight - 60)));
      await page.waitForTimeout(200);
      await figs.nth(i).focus();
      await page.waitForTimeout(250);
      const o = await figs.nth(i).evaluate((f) => { const t = document.querySelector('.orcf-tip'); if (!t || getComputedStyle(t).display === 'none') return 0; const a = f.getBoundingClientRect(), b = t.getBoundingClientRect(); return Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) * Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)); });
      if (o > 0) covered.push(i);
    }
    check('phone: cards near the screen bottom never cover their figure', covered.length === 0, { n, covered });
    check('r9: no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();

    // U28: loading footnote on a cold start
    const cold = await launch(profile('r9-cold', false));
    const q = cold.pages()[0];
    await open(q, '/rankings');
    await q.waitForSelector('#orcf-revenue .orcf-progress', { timeout: 30000 }).catch(() => {});
    const foot = await q.evaluate(() => [...document.querySelectorAll('#orcf-revenue p.orcf-xs')].map((p) => p.textContent).join(' '));
    check('loading footnote makes no claim about 0 models', !/Based on 0 /.test(foot), foot.slice(0, 160));
    await cold.close();

    // Y26: the app-usage retry runs on an idle page
    const ctx3 = await launch(profile('r9-apps'));
    let failUntil = Date.now() + 25_000;
    await ctx3.route(/stats\/top-apps-for-model/, (r) => (Date.now() < failUntil ? r.fulfill({ status: 502, body: '{}' }) : r.continue()));
    const p3 = ctx3.pages()[0];
    await open(p3, '/anthropic/claude-haiku-4.5');
    await p3.waitForSelector('#apps', { timeout: 30000 });
    await p3.evaluate(() => document.getElementById('apps').scrollIntoView());
    failUntil = Date.now() + 15_000;
    await p3.waitForTimeout(45_000);
    const lines = await p3.evaluate(() => [...document.querySelectorAll('#apps .orcf-row-extra')].map((e) => e.innerText.trim()));
    check('idle model page retries app usage and fills the rows', lines.length > 0 && lines.every((t) => /\$/.test(t)), lines.slice(0, 5));
    await ctx3.close();
  },

  /** round 10: unit-priced audio, non-token labels, list-price copy, free-split failure, author keys */
  async r10() {
    const ctx = await launch(profile('r10'));
    const page = ctx.pages()[0];
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message.slice(0, 150)));
    const card = () => page.evaluate(() => document.querySelector('[data-orcf].rounded-lg')?.innerText.replace(/\s+/g, ' '));

    // V28: a text-to-speech model priced per minute is "not per token", not $0
    await open(page, '/bytedance-seed/seed-audio-1-0');
    await page.waitForSelector('[data-orcf].rounded-lg', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(4000);
    const seed = { card: await card(), sec: await page.evaluate(() => document.querySelector('#orcf-model-revenue .orcf-empty')?.textContent) };
    check('per-minute TTS model says not per token', /not per token/.test(seed.card ?? '') && /per second/.test(seed.sec ?? ''), seed);

    // V29: per-second video apps rows match the header card
    await open(page, '/runway/gen-4.5');
    await page.waitForSelector('[data-orcf].rounded-lg', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(5000);
    const vrows = await page.evaluate(() => [...document.querySelectorAll('#apps .orcf-row-extra')].map((e) => e.innerText.trim()));
    check('per-second model app rows say not per token', vrows.every((t) => !/price unknown/.test(t)), vrows.slice(0, 4));

    // V30: a standard reranker's list-price footnote
    await open(page, '/mongodb/rerank-2.5-lite');
    await page.waitForSelector('#orcf-model-revenue .orcf-stat-value', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const foot = await page.evaluate(() => [...document.querySelectorAll('#orcf-model-revenue p.orcf-xs')].map((p) => p.textContent).join(' '));
    check('reranker footnote: "this model", no cache clause', /for this model/.test(foot) && !/cache-read/.test(foot), foot.slice(0, 200));

    // U31 / U32: author keys on /rankings
    await open(page, '/rankings');
    await settled(page, '#orcf-revenue .orcf-stat-value');
    const more = page.locator('#orcf-revenue .orcf-more');
    await page.locator('#orcf-revenue [aria-label="Group revenue by"] button:has-text("Authors")').click();
    await page.waitForTimeout(800);
    for (let i = 0; i < 4 && (await more.count()); i++) { await more.click(); await page.waitForTimeout(400); }
    const authors = await page.evaluate(() => [...document.querySelectorAll('#orcf-revenue .orcf-tr:not(.is-head) a[href]')].map((a) => a.getAttribute('href')));
    const dup = authors.filter((h, i) => authors.findIndex((x) => x.toLowerCase() === h.toLowerCase()) !== i || /[A-Z]/.test(h));
    check('Authors grouping: no case duplicates or capitalised slugs', dup.length === 0, dup);
    await page.locator('#orcf-revenue [aria-label="Group revenue by"] button:has-text("Models")').click();
    await page.waitForTimeout(800);
    for (let i = 0; i < 25 && (await more.count()); i++) { await more.click(); await page.waitForTimeout(250); }
    const undef = await page.evaluate(() => [...document.querySelectorAll('#orcf-revenue .orcf-sub')].filter((e) => /undefined/.test(e.textContent)).length);
    check('Models grouping: no "undefined" subtitles', undef === 0, undef);
    check('r10: no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();

    // U30 / Y28: a failed free-variant lookup doesn't price free traffic as paid
    const ctx2 = await launch(profile('r10-freefail', false));
    await ctx2.route(/stats\/model-activity\?.*nemotron-3-ultra.*variant=free/, (r) => r.fulfill({ status: 500, body: '{}' }));
    const q = ctx2.pages()[0];
    await open(q, '/apps/kilo-code');
    await q.waitForSelector('.orcf-stat-value', { timeout: 120000 });
    await q.waitForTimeout(4000);
    const k = await q.evaluate(() => ({
      rows: [...document.querySelectorAll('.orcf-row-extra')].map((e) => e.closest('a,li,div[class*="flex"]')?.innerText.replace(/\s+/g, ' ').slice(0, 90)).filter((t) => /Nemotron 3 Ultra/.test(t ?? '')),
      foot: [...document.querySelectorAll('.orcf p.orcf-xs')].map((p) => p.textContent).join(' '),
    }));
    const usd = (t) => { const m = (t ?? '').match(/\$([\d.]+)([KMB]?)/); return m ? Number(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[m[2]] ?? 1) : NaN; };
    check('free lookup failure: Nemotron 3 Ultra capped, not priced as all-paid', !k.rows[0] || usd(k.rows[0]) < 200_000, k.rows);
    check('free lookup failure is disclosed', /free\/paid split couldn’t be loaded/.test(k.foot), k.foot.slice(-220));
    await ctx2.close();
  },

  /** round 11: phone reload on our section, failed-split tooltips, disclosures */
  async r11() {
    const ctx = await launch(profile('r11'), { width: 390, height: 844 });
    const page = ctx.pages()[0];
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message.slice(0, 150)));
    // V31: reloading on a phone while reading Revenue returns to Revenue
    for (const [path, id] of [['/anthropic/claude-sonnet-4.5', 'orcf-model-revenue'], ['/rankings', 'orcf-revenue']]) {
      await open(page, path);
      await page.waitForSelector(`#${id} .orcf-stat-value`, { timeout: 90000 });
      await page.waitForTimeout(1500);
      await page.evaluate((id) => { const s = document.getElementById(id); window.scrollTo(0, s.getBoundingClientRect().top + scrollY - 170); }, id);
      await page.waitForTimeout(2000);
      await page.reload({ waitUntil: 'load' });
      await page.waitForTimeout(9000);
      const r = await page.evaluate((id) => ({ hash: location.hash, top: Math.round(document.getElementById(id)?.getBoundingClientRect().top ?? -99999) }), id);
      check(`phone reload on ${path} stays on Revenue`, r.hash === `#${id}` && r.top > -50 && r.top < 400, r);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    // W29: "price unknown" app row explains the free share
    await open(page, '/apps/kilo-code');
    await page.waitForSelector('.orcf-stat-value', { timeout: 90000 });
    await page.waitForTimeout(3000);
    const unk = await page.evaluate(() => [...document.querySelectorAll('.orcf-row-extra [title]')].map((e) => e.getAttribute('title')).filter((t) => /no price data/.test(t)));
    check('price-unknown app rows mention the free share', unk.every((t) => /free variant count as \$0/.test(t)), unk.slice(0, 1));
    const foot = await page.evaluate(() => [...document.querySelectorAll('.orcf p.orcf-xs')].map((p) => p.textContent).join(' '));
    check('app footnote mentions BYOK', /bring-your-own-key/.test(foot), foot.slice(0, 120));
    await open(page, '/provider/deepinfra');
    await settled(page);
    const pf = await page.evaluate(() => [...document.querySelectorAll('[data-orcf] p.orcf-xs')].map((p) => p.textContent).join(' '));
    check('provider footnote says per-second models are not included', /per second or per item/.test(pf), pf.slice(0, 160));
    check('r11: no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();

    // Y31 / U33 / W30: failed free/paid split in tooltips
    const ctx2 = await launch(profile('r11-freefail', false));
    await ctx2.route(/stats\/model-activity\?.*nemotron-3-ultra.*variant=free/, (r) => r.fulfill({ status: 500, body: '{}' }));
    const q = ctx2.pages()[0];
    await open(q, '/apps/kilo-code');
    await q.waitForSelector('.orcf-stat-value', { timeout: 120000 });
    await q.waitForTimeout(4000);
    const nemo = q.locator('.orcf-row-extra .orcf-inline[tabindex]').filter({ hasText: '$' });
    let tip = '';
    for (let i = 0; i < (await nemo.count()); i++) {
      const row = await nemo.nth(i).evaluate((e) => e.closest('a,li,div[class*="flex"]')?.innerText ?? '');
      if (!/Nemotron 3 Ultra/.test(row)) continue;
      await nemo.nth(i).focus();
      await q.waitForTimeout(400);
      tip = await q.evaluate(() => document.querySelector('.orcf-tip')?.innerText ?? '');
      break;
    }
    check('row tooltip on a failed split explains the cap', /couldn’t be loaded/.test(tip) && !/split by OpenRouter’s free\/paid mix/.test(tip), tip.slice(0, 220));
    await open(q, '/rankings');
    await q.waitForSelector('#apps [data-orcf] .orcf-inline:not(.is-loading)', { timeout: 120000 });
    await q.waitForTimeout(3000);
    const kilo = q.locator('#apps [data-orcf] .orcf-inline').nth(0);
    let atip = '';
    const n = await q.locator('#apps [data-orcf] .orcf-inline').count();
    for (let i = 0; i < n; i++) {
      const el = q.locator('#apps [data-orcf] .orcf-inline').nth(i);
      const row = await el.evaluate((e) => e.closest('a,li,div[class*="grid"]')?.innerText ?? '');
      if (!/Kilo/i.test(row)) continue;
      await el.scrollIntoViewIfNeeded();
      await el.hover();
      await q.waitForTimeout(500);
      atip = await q.evaluate(() => document.querySelector('.orcf-tip')?.innerText ?? '');
      break;
    }
    check('Top Apps tooltip warns on a failed split', /may be high/.test(atip) && !/\b0% of\s+tokens matched/.test(atip), atip.slice(-200));
    await ctx2.close();
  },

  /** round 12: reading position across links and reloads; failed split counted as priced */
  async r12() {
    const cases = [
      ['link', '/anthropic/claude-sonnet-4.5', 'performance', { width: 1440, height: 900 }, 0],
      ['link', '/anthropic/claude-sonnet-4.5', 'performance', { width: 390, height: 844 }, 0],
      ['reload', '/anthropic/claude-sonnet-4.5', 'orcf-model-revenue', { width: 390, height: 844 }, 700],
      ['reload', '/rankings', 'performance', { width: 390, height: 844 }, 300],
      ['reload', '/rankings', 'performance', { width: 820, height: 1180 }, 300],
      ['reload', '/rankings', 'apps', { width: 1440, height: 900 }, 100],
    ];
    for (const [mode, path, id, vw, dy] of cases) {
      const ctx = await launch(profile('r12'), vw);
      const page = ctx.pages()[0];
      const top = () => page.evaluate((id) => Math.round(document.getElementById(id)?.getBoundingClientRect().top ?? -99999), id);
      if (mode === 'link') {
        await page.goto('https://openrouter.ai' + path + '#' + id, { waitUntil: 'load' });
        await page.waitForTimeout(8000);
        const t = await top();
        check(`link ${path}#${id} @${vw.width} lands on it`, t > 0 && t < 260, { top: t });
      } else {
        await open(page, path);
        await page.waitForTimeout(7000);
        await page.evaluate(([id, dy]) => { const s = document.getElementById(id); window.scrollTo(0, s.getBoundingClientRect().top + scrollY + dy); }, [id, dy]);
        await page.waitForTimeout(2000);
        const before = await top();
        const after = [];
        for (let i = 0; i < 2; i++) { await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(8000); after.push(await top()); }
        check(`reload in ${path} ${id} @${vw.width} keeps the reading position`, after.every((t) => Math.abs(t - before) <= 6), { before, after });
      }
      await ctx.close();
    }
    // Y33 / W33: a failed split isn't reported as unpriced
    const ctx2 = await launch(profile('r12-freefail', false));
    await ctx2.route(/stats\/model-activity\?.*variant=free/, (r) => r.fulfill({ status: 500, body: '{}' }));
    const q = ctx2.pages()[0];
    await open(q, '/apps/kilo-code');
    await q.waitForSelector('.orcf-stat-value', { timeout: 120000 });
    await q.locator('.orcf [aria-label="Time window"] button:has-text("7 days")').first().click();
    await q.waitForTimeout(4000);
    const k = await q.evaluate(() => ({ tiles: [...document.querySelectorAll('.orcf-stat')].map((e) => e.innerText.replace(/\s+/g, ' ')).join(' | '), foot: [...document.querySelectorAll('.orcf p.orcf-xs')].map((p) => p.textContent).join(' ') }));
    check('failed splits: no "0% priced" / "mostly estimated"', !/\b0% (of tokens )?priced|mostly estimated/.test(k.tiles), k.tiles);
    check('failed splits: footnote keeps the "may be high" note only', /may be high/.test(k.foot) && !/could be priced per model \(the rest went/.test(k.foot), k.foot.slice(-240));
    await ctx2.close();
  },

  /** round 13: Back navigation, late growth, interactions, app-row fallback, unit-priced cards */
  async r13() {
    const top = (page, id) => page.evaluate((id) => Math.round(document.getElementById(id)?.getBoundingClientRect().top ?? -99999), id);
    // V34: in-app Back from an app to a model page keeps Apps where it was
    {
      const ctx = await launch(profile('r13'));
      const page = ctx.pages()[0];
      await open(page, '/anthropic/claude-sonnet-4.5');
      await page.waitForSelector('#orcf-model-revenue .orcf-stat-value', { timeout: 60000 });
      await page.waitForTimeout(2000);
      await page.evaluate(() => { const s = document.getElementById('apps'); window.scrollTo(0, s.getBoundingClientRect().top + scrollY - 100); });
      await page.waitForTimeout(1500);
      await page.locator('#apps a[href^="/apps/"]').first().click();
      await page.waitForURL(/\/apps\//, { timeout: 20000 });
      await page.waitForTimeout(3000);
      await page.goBack();
      await page.waitForTimeout(6000);
      const t = await top(page, 'apps');
      check('in-app Back keeps Apps near the top', t > -50 && t < 300, { top: t });
      // V35: Back from another site (no back/forward cache in Playwright, so the page reloads)
      await page.evaluate(() => { const s = document.getElementById('apps'); window.scrollTo(0, s.getBoundingClientRect().top + scrollY - 100); });
      await page.waitForTimeout(1500);
      await page.goto('https://example.com/');
      await page.goBack({ waitUntil: 'load' });
      await page.waitForTimeout(8000);
      const t2 = await top(page, 'apps');
      check('Back from another site restores the reading position', Math.abs(t2 - 100) <= 8, { top: t2 });
      // interaction inside our section is not undone: "Show all" doesn't scroll the page
      await open(page, '/openai/gpt-oss-120b');
      await page.waitForSelector('#orcf-model-revenue .orcf-stat-value', { timeout: 60000 });
      const more = page.locator('#orcf-model-revenue .orcf-more');
      if (await more.count()) {
        await more.scrollIntoViewIfNeeded();
        await page.evaluate(() => window.scrollBy(0, 200));
        await page.waitForTimeout(800);
        const y0 = await page.evaluate(() => scrollY);
        await more.click();
        await page.waitForTimeout(1200);
        const y1 = await page.evaluate(() => scrollY);
        check('clicking "Show all" in our section does not scroll the page', Math.abs(y1 - y0) <= 2, { y0, y1 });
      } else check('a model with a "Show all" button exists for the interaction check', false);
      await ctx.close();
    }
    // V36: figures arriving late don't push a #performance reader down
    {
      const ctx = await launch(profile('r13-slow', false));
      await ctx.route(/\/api\/frontend\/v1\/stats\//, async (r) => { await new Promise((res) => setTimeout(res, 2500)); await r.continue(); });
      const page = ctx.pages()[0];
      await page.goto('https://openrouter.ai/anthropic/claude-sonnet-4.5#performance', { waitUntil: 'load' });
      await page.waitForTimeout(16000);
      const t = await top(page, 'performance');
      const hash = await page.evaluate(() => location.hash);
      check('late figures keep a #performance reader on Performance', t > 0 && t < 260 && hash === '#performance', { top: t, hash });
      await ctx.close();
    }
    // W34: app rows never flash the all-paid figure on a cold load, and stay sane when the app usage fails
    {
      const ctx = await launch(profile('r13-cold', false));
      const page = ctx.pages()[0];
      await page.goto('https://openrouter.ai/apps/kilo-code', { waitUntil: 'load' });
      const usd = (t) => { const m = (t ?? '').match(/\$([\d.]+)([KMB]?)/); return m ? Number(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[m[2]] ?? 1) : NaN; };
      let peak = 0;
      for (let i = 0; i < 40; i++) {
        const v = await page.evaluate(() => [...document.querySelectorAll('.orcf-row-extra')].map((e) => ({ row: e.closest('a,li,div[class*="flex"]')?.innerText ?? '', fig: e.innerText })).find((x) => /Nemotron 3 Ultra/.test(x.row))?.fig ?? '');
        if (v) peak = Math.max(peak, usd(v) || 0);
        await page.waitForTimeout(250);
      }
      check('cold load: Nemotron 3 Ultra row never shows the all-paid figure', peak > 0 && peak < 200_000, { peak });
      await ctx.close();
      const ctx2 = await launch(profile('r13-rscfail'));
      await ctx2.route(/openrouter\.ai\/apps\//, (r) => (r.request().headers()['rsc'] ? r.fulfill({ status: 500, body: '' }) : r.continue()));
      await ctx2.route(/stats\/model-activity\?.*variant=free/, (r) => r.continue());
      const q = ctx2.pages()[0];
      await open(q, '/apps/kilo-code');
      await q.waitForTimeout(12000);
      const rows = await q.evaluate(() => [...document.querySelectorAll('.orcf-row-extra')].map((e) => ({ row: (e.closest('a,li,div[class*="flex"]')?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 60), fig: e.innerText })));
      const nemo = rows.find((x) => /Nemotron 3 Ultra/.test(x.row));
      check('app usage failing: Nemotron 3 Ultra row free-aware', !nemo || !(usd(nemo.fig) > 200_000), nemo);
      await ctx2.close();
    }
    // W35: header warns when the split is unknown
    {
      const ctx = await launch(profile('r13-split', false));
      await ctx.route(/stats\/model-activity\?.*variant=free/, (r) => r.fulfill({ status: 500, body: '{}' }));
      const page = ctx.pages()[0];
      await open(page, '/apps/kilo-code');
      await page.waitForFunction(() => /may be high|≈|estimate/.test(document.querySelector('.orcf-grid5 [data-orcf]')?.textContent ?? ''), null, { timeout: 90000 }).catch(() => {});
      const h = await page.evaluate(() => document.querySelector('.orcf-grid5 [data-orcf]')?.innerText.replace(/\s+/g, ' '));
      check('header stat says "may be high" when a split failed', /may be high/.test(h ?? ''), h);
      await ctx.close();
    }
    // W36: speech-to-text cards say "not per token"
    {
      const ctx = await launch(profile('r13-stt'));
      const page = ctx.pages()[0];
      await open(page, '/provider/deepinfra');
      await settled(page);
      await page.waitForTimeout(2000);
      const stt = await page.evaluate(() => [...document.querySelectorAll('[data-testid="model-list-item"]')].filter((c) => /whisper/i.test(c.textContent)).map((c) => c.querySelector('[data-orcf]')?.textContent?.trim()));
      check('speech-to-text cards say not per token', stt.length > 0 && stt.every((t) => t === 'not per token'), stt);
      await ctx.close();
    }
  },

  /** round 13 (U, on /rankings): links to OpenRouter's sections, Back without cache, footer reload, sidebar click after reload */
  async r13u() {
    const top = (page, id) => page.evaluate((id) => Math.round(document.getElementById(id)?.getBoundingClientRect().top ?? -99999), id);
    for (const [vw, id, want] of [[{ width: 1440, height: 900 }, 'task-spend', 128], [{ width: 1024, height: 900 }, 'performance', 128], [{ width: 390, height: 844 }, 'performance', 160], [{ width: 820, height: 1180 }, 'apps', 168]]) {
      const ctx = await launch(profile('r13u'), vw);
      const page = ctx.pages()[0];
      await page.goto('https://openrouter.ai/rankings#' + id, { waitUntil: 'load' });
      await page.waitForTimeout(8000);
      const t = await top(page, id);
      const hash = await page.evaluate(() => location.hash);
      check(`/rankings#${id} @${vw.width} lands on it`, Math.abs(t - want) <= 4 && hash === '#' + id, { top: t, hash });
      await ctx.close();
    }
    const ctx = await launch(profile('r13u'));
    const page = ctx.pages()[0];
    await open(page, '/rankings');
    await page.waitForSelector('#orcf-revenue .orcf-stat-value', { timeout: 60000 });
    await page.waitForTimeout(2000);
    // U36: Back from another site (Playwright has no back/forward cache: the page loads again)
    await page.evaluate(() => { const s = document.getElementById('performance'); window.scrollTo(0, s.getBoundingClientRect().top + scrollY + 300); });
    await page.waitForTimeout(1500);
    await page.goto('https://example.com/');
    await page.goBack({ waitUntil: 'load' });
    await page.waitForTimeout(8000);
    const b = await top(page, 'performance');
    check('/rankings Back from another site keeps the reading position', Math.abs(b + 300) <= 6, { top: b });
    // U37: reload with the footer in view stays at the bottom
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(1500);
    const fb = await page.evaluate(() => document.documentElement.scrollHeight - scrollY);
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(9000);
    const fa = await page.evaluate(() => document.documentElement.scrollHeight - scrollY);
    check('reload at the footer stays at the bottom', Math.abs(fa - fb) <= 8, { before: fb, after: fa });
    // U38: a sidebar click right after a reload reaches its section
    await page.evaluate(() => { const s = document.getElementById('performance'); window.scrollTo(0, s.getBoundingClientRect().top + scrollY + 300); });
    await page.waitForTimeout(1500);
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#orcf-revenue', { state: 'attached', timeout: 30000 });
    await page.waitForTimeout(300);
    await page.locator('a[href="#top-models"]:not([data-orcf])').first().click();
    await page.waitForTimeout(3500);
    const tm = await top(page, 'top-models');
    check('sidebar click right after a reload reaches its section', Math.abs(tm - 128) <= 6, { top: tm });
    await ctx.close();
  },

  /** round 14: per-page saved positions, gaps between sections, stealth models, row upper bound, tracking after reload */
  async r14() {
    const top = (page, id) => page.evaluate((id) => Math.round(document.getElementById(id)?.getBoundingClientRect().top ?? -99999), id);
    const usd = (t) => { const m = (t ?? '').match(/\$([\d.]+)([KMB]?)/); return m ? Number(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[m[2]] ?? 1) : NaN; };
    // Y34: leaving another OpenRouter page doesn't erase this page's saved position
    {
      const ctx = await launch(profile('r14'));
      const page = ctx.pages()[0];
      await open(page, '/anthropic/claude-sonnet-4.5');
      await page.waitForSelector('#orcf-model-revenue .orcf-stat-value', { timeout: 60000 });
      await page.waitForTimeout(1500);
      await page.evaluate(() => { const s = document.getElementById('apps'); window.scrollTo(0, s.getBoundingClientRect().top + scrollY - 100); });
      await page.waitForTimeout(1200);
      await page.goto('https://openrouter.ai/anthropic/claude-haiku-4.5', { waitUntil: 'load' });
      await page.waitForTimeout(4000);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(500);
      await page.goBack({ waitUntil: 'load' });
      await page.waitForTimeout(8000);
      const t = await top(page, 'apps');
      check('Back after visiting another model page restores Apps', Math.abs(t - 100) <= 8, { top: t });
      await ctx.close();
    }
    // V37 / U39: the reading line in a gap between sections
    for (const [path, id, vw] of [['/rankings', 'performance', { width: 1440, height: 900 }], ['/anthropic/claude-sonnet-4.5', 'uptime', { width: 1440, height: 900 }], ['/rankings', 'apps', { width: 390, height: 844 }]]) {
      const ctx = await launch(profile('r14-gap', false), vw);
      // only the extension's own requests are slowed (OpenRouter's own late content moves the page by itself)
      await ctx.route(/stats\/(provider-token-chart|effective-pricing|model-activity)|catalog\/models|rankings\/models/, async (r) => { await new Promise((res) => setTimeout(res, 1500)); await r.continue(); });
      const page = ctx.pages()[0];
      await page.goto('https://openrouter.ai' + path, { waitUntil: 'load' });
      // OpenRouter's own layout may still settle right after load: put the gap at the reading line until it holds
      for (let k = 0; k < 4; k++) {
        await page.evaluate((id) => { const s = document.getElementById(id); window.scrollTo(0, s.getBoundingClientRect().top + scrollY - 232); }, id);
        await page.waitForTimeout(150);
        if (Math.abs((await top(page, id)) - 232) <= 2) break;
      }
      const before = await top(page, id);
      await page.waitForTimeout(20000);
      const after = await top(page, id);
      // OpenRouter's own late content can move the page by itself (~60 px measured without the extension)
      check(`gap at the reading line: ${path} ${id} @${vw.width} stays put`, Math.abs(after - before) <= 80, { before, after });
      await ctx.close();
    }
    // W37: a retired stealth model is free, not priced at the app's average
    {
      const ctx = await launch(profile('r14-cc'));
      const page = ctx.pages()[0];
      await open(page, '/apps/url/https%3A%2F%2Fcommandcode.ai%2F');
      await page.waitForSelector('.orcf-stat-value', { timeout: 90000 });
      await page.locator('.orcf [aria-label="Time window"] button:has-text("30 days")').first().click();
      await page.waitForTimeout(3000);
      const v = await page.evaluate(() => document.querySelector('.orcf-stat-value')?.textContent);
      check('Command Code 30 days: retired stealth tokens cost $0', usd(v) < 10_000, v);
      await ctx.close();
    }
    // W38: both the app usage and the free split failing: rows are capped and marked as an upper bound
    {
      const ctx = await launch(profile('r14-both', false));
      await ctx.route(/openrouter\.ai\/apps\//, (r) => (r.request().headers()['rsc'] ? r.fulfill({ status: 500, body: '' }) : r.continue()));
      await ctx.route(/stats\/model-activity\?.*variant=free/, (r) => r.fulfill({ status: 500, body: '{}' }));
      const page = ctx.pages()[0];
      await open(page, '/apps/kilo-code');
      await page.waitForTimeout(25000);
      const nemo = await page.evaluate(() => [...document.querySelectorAll('.orcf-row-extra')].map((e) => ({ row: (e.closest('a,li,div[class*="flex"]')?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 50), fig: e.innerText.trim() })).find((x) => /Nemotron 3 Ultra/.test(x.row)));
      check('both failing: row capped and marked "≤"', !!nemo && /≤/.test(nemo.fig) && usd(nemo.fig) < 200_000, nemo);
      await ctx.close();
    }
    // U40: after a reload above our section, OpenRouter's tracking names what's on screen
    {
      const ctx = await launch(profile('r14-track'), { width: 1024, height: 768 });
      const page = ctx.pages()[0];
      await open(page, '/rankings');
      await page.waitForSelector('#orcf-revenue .orcf-stat-value', { timeout: 60000 });
      await page.waitForTimeout(1500);
      await page.evaluate(() => { const s = document.getElementById('orcf-revenue'); window.scrollTo(0, s.getBoundingClientRect().top + scrollY - 296); });
      await page.waitForTimeout(1500);
      await page.reload({ waitUntil: 'load' });
      await page.waitForTimeout(8000);
      const h = await page.evaluate(() => location.hash);
      check('reload above Revenue: hash names the section on screen', h === '#leaderboard-table', h);
      await ctx.close();
    }
  },

  /** round 15: Back within the site, the reader's own scrolling during load, the last strip of a loading block */
  async r15() {
    const slowOurs = (ctx, ms) => ctx.route(/stats\/(provider-token-chart|effective-pricing|model-activity)|catalog\/models|rankings\/models/, async (r) => { await new Promise((res) => setTimeout(res, ms)); await r.continue(); });
    // W39: in-site Back to a provider / app page returns to the same spot
    for (const [path, y] of [['/provider/deepinfra', 2600], ['/apps/kilo-code', 1500], ['/anthropic', 2200]]) {
      const ctx = await launch(profile('r15'));
      const page = ctx.pages()[0];
      await open(page, path);
      await settled(page, '[data-orcf-block] .orcf-stat-value', 90000);
      await page.waitForTimeout(2500);
      await page.evaluate((y) => window.scrollTo(0, y), y);
      await page.waitForTimeout(1200);
      const mark = await page.evaluate(() => { const e = document.elementFromPoint(innerWidth / 2, 245); return (e?.textContent ?? '').trim().slice(0, 40); });
      const link = page.locator('main a[href^="/"]:not([href^="/apps"]):not([data-orcf])').filter({ hasNotText: /^$/ }).first();
      await page.evaluate(() => { const a = [...document.querySelectorAll('main a[href^="/"]')].find((a) => { const r = a.getBoundingClientRect(); return r.top > 100 && r.bottom < innerHeight - 50 && !a.closest('[data-orcf]'); }); a?.setAttribute('data-orcf-test', '1'); });
      await page.locator('[data-orcf-test]').first().click();
      await page.waitForTimeout(3000);
      await page.goBack();
      await page.waitForTimeout(5000);
      const r = await page.evaluate(() => ({ y: Math.round(scrollY) }));
      const at = await page.evaluate(() => { const e = document.elementFromPoint(innerWidth / 2, 245); return (e?.textContent ?? '').trim().slice(0, 40); });
      check(`in-site Back to ${path} returns to the same spot`, Math.abs(r.y - y) <= 12, { y: r.y, want: y, before: mark, after: at });
      await ctx.close();
    }
    // U41: the reader's own wheel scrolling below our section while it fills in never shows a big shift
    {
      const ctx = await launch(profile('r15-wheel', false));
      await slowOurs(ctx, 1200);
      const page = ctx.pages()[0];
      await page.goto('https://openrouter.ai/rankings', { waitUntil: 'load' });
      await page.evaluate(() => { const s = document.getElementById('market-share'); window.scrollTo(0, s.getBoundingClientRect().top + scrollY - 200); });
      await page.mouse.move(720, 450);
      const t0 = await page.evaluate(() => Math.round(document.getElementById('market-share').getBoundingClientRect().top));
      let worst = 0, wheeled = 0;
      for (let i = 0; i < 120; i++) {
        await page.mouse.wheel(0, 50);
        wheeled += 50;
        await page.waitForTimeout(40);
        const t = await page.evaluate(() => document.getElementById('market-share').getBoundingClientRect().top);
        worst = Math.max(worst, Math.abs(t - (t0 - wheeled)));
      }
      check('wheel scrolling while our section fills in: no big shift', worst < 200, { worst: Math.round(worst) });
      // V39: scrolling up to the top while it fills in stays at the top
      await ctx.close();
      const ctx2 = await launch(profile('r15-up', false));
      await slowOurs(ctx2, 1500);
      const q = ctx2.pages()[0];
      await q.goto('https://openrouter.ai/anthropic/claude-sonnet-4.5', { waitUntil: 'load' });
      await q.evaluate(() => { const s = document.getElementById('performance'); window.scrollTo(0, s.getBoundingClientRect().top + scrollY + 300); });
      await q.mouse.move(720, 450);
      for (let i = 0; i < 60; i++) { await q.mouse.wheel(0, -100); await q.waitForTimeout(25); }
      for (let i = 0; i < 20; i++) { await q.mouse.wheel(0, -200); await q.waitForTimeout(25); }
      await q.waitForTimeout(8000);
      const y = await q.evaluate(() => Math.round(scrollY));
      check('scrolling to the top while data arrives stays at the top', y < 5, { y });
      await ctx2.close();
    }
    // V41 / W40: only the last strip of a loading block at the reading line: the content below stays
    for (const [path, vw] of [['/anthropic/claude-sonnet-4.5', { width: 1440, height: 900 }], ['/provider/deepinfra', { width: 1440, height: 900 }]]) {
      const ctx = await launch(profile('r15-strip', false), vw);
      await slowOurs(ctx, 2500);
      const page = ctx.pages()[0];
      await page.goto('https://openrouter.ai' + path, { waitUntil: 'load' });
      await page.waitForSelector('[data-orcf-block]', { timeout: 30000 });
      await page.waitForTimeout(300);
      const id = await page.evaluate(() => {
        const b = document.querySelector('[data-orcf-block]');
        window.scrollTo(0, b.getBoundingClientRect().bottom + scrollY - 250); // block ends 50 px below the reading line
        const next = b.nextElementSibling ?? b.parentElement.nextElementSibling;
        next.setAttribute('data-orcf-test-next', '1');
        return true;
      });
      const before = await page.evaluate(() => Math.round(document.querySelector('[data-orcf-test-next]').getBoundingClientRect().top));
      await page.waitForTimeout(12000);
      const after = await page.evaluate(() => Math.round(document.querySelector('[data-orcf-test-next]')?.getBoundingClientRect().top ?? -9999));
      check(`last strip of a loading block (${path}): what follows stays`, Math.abs(after - before) <= 80, { before, after });
      await ctx.close();
    }
  },

  /** round 16: leaderboard choices survive Back/reload; Back from a page we don't touch */
  async r16() {
    {
      const ctx = await launch(profile('r16'));
      const page = ctx.pages()[0];
      await open(page, '/rankings');
      await settled(page, '#orcf-revenue .orcf-stat-value');
      await page.locator('#orcf-revenue [aria-label="Group revenue by"] button:has-text("Models")').click();
      await page.locator('#orcf-revenue [aria-label="Time window"] button:has-text("30 days")').click();
      await page.waitForTimeout(800);
      await page.locator('#orcf-revenue .orcf-more').click();
      await page.waitForTimeout(800);
      const row = page.locator('#orcf-revenue .orcf-tr:not(.is-head) a.orcf-name, #orcf-revenue .orcf-tr:not(.is-head) a[href]').nth(20);
      await row.evaluate((a) => window.scrollTo(0, a.getBoundingClientRect().top + scrollY - 430));
      await page.waitForTimeout(1200);
      const before = await row.evaluate((a) => ({ text: a.textContent.trim().slice(0, 30), top: Math.round(a.getBoundingClientRect().top) }));
      await row.click();
      await page.waitForTimeout(3000);
      await page.goBack();
      await page.waitForTimeout(6000);
      const after = await page.evaluate(() => ({
        dim: document.querySelector('#orcf-revenue [aria-label="Group revenue by"] [aria-checked="true"]')?.textContent,
        period: document.querySelector('#orcf-revenue [aria-label="Time window"] [aria-checked="true"]')?.textContent,
        rows: document.querySelectorAll('#orcf-revenue .orcf-tr:not(.is-head)').length,
      }));
      const back = await page.evaluate((t) => { const a = [...document.querySelectorAll('#orcf-revenue .orcf-tr:not(.is-head) a[href]')].find((x) => x.textContent.trim().startsWith(t)); return a ? Math.round(a.getBoundingClientRect().top) : null; }, before.text);
      check('Back from a leaderboard row keeps grouping, window and rows', after.dim === 'Models' && after.period === '30 days' && after.rows >= 25, after);
      check('Back from a leaderboard row returns to that row', back !== null && Math.abs(back - before.top) <= 12, { before, back });
      await ctx.close();
    }
    // Y37: Back from a page the extension doesn't touch (/models) to a provider page
    {
      const ctx = await launch(profile('r16'));
      const page = ctx.pages()[0];
      await open(page, '/provider/deepinfra');
      await settled(page, '[data-orcf-block] .orcf-stat-value', 90000);
      await page.waitForTimeout(2500);
      await page.evaluate(() => window.scrollTo(0, 2600));
      await page.waitForTimeout(1200);
      await page.evaluate(() => { const a = [...document.querySelectorAll('a[href="/models"]')][0]; a?.setAttribute('data-orcf-test', '1'); });
      await page.locator('[data-orcf-test]').first().click();
      await page.waitForURL(/\/models/, { timeout: 15000 });
      await page.waitForTimeout(3500);
      await page.goBack();
      await page.waitForTimeout(5000);
      const y = await page.evaluate(() => Math.round(scrollY));
      check('Back from /models to a provider page returns to the same spot', Math.abs(y - 2600) <= 12, { y });
      await ctx.close();
    }
  },

  /** round 16 (V, W): jumps while our section fills in; restored positions after full page loads */
  async r16b() {
    const holdOurs = async (ctx) => {
      let release;
      const gate = new Promise((r) => (release = r));
      await ctx.route(/stats\/(provider-token-chart|effective-pricing|model-activity)|catalog\/models|rankings\/models/, async (r) => { await gate; await r.continue(); });
      return () => release();
    };
    const top = (page, id) => page.evaluate((id) => Math.round(document.getElementById(id)?.getBoundingClientRect().top ?? -99999), id);
    // V43: a sidebar jump to the section right after Revenue while Revenue fills in
    {
      const ctx = await launch(profile('r16b', false));
      const release = await holdOurs(ctx);
      const page = ctx.pages()[0];
      await page.goto('https://openrouter.ai/anthropic/claude-sonnet-4.5', { waitUntil: 'load' });
      await page.waitForSelector('#orcf-model-revenue', { state: 'attached', timeout: 30000 });
      await page.waitForTimeout(800);
      await page.locator('a[href="#performance"]:not([data-orcf])').first().click();
      await page.waitForTimeout(100);
      release();
      let worst = 0;
      for (let i = 0; i < 30; i++) { await page.waitForTimeout(100); }
      const t = await top(page, 'performance');
      check('sidebar jump while Revenue fills in lands on the section', Math.abs(t - 126) <= 4, { top: t });
      await ctx.close();
    }
    // V42: the phone section menu, same moment
    {
      const ctx = await launch(profile('r16b', false), { width: 390, height: 844 });
      const release = await holdOurs(ctx);
      const page = ctx.pages()[0];
      await page.goto('https://openrouter.ai/anthropic/claude-sonnet-4.5', { waitUntil: 'load' });
      await page.waitForSelector('#orcf-model-revenue', { state: 'attached', timeout: 30000 });
      await page.evaluate(() => { const s = document.getElementById('apps'); window.scrollTo(0, s.getBoundingClientRect().top + scrollY - 177); });
      await page.waitForTimeout(1000);
      await phoneTrigger(page, /Apps|Activity|Benchmarks|Uptime/).click();
      await page.waitForTimeout(500);
      await page.locator(PHONE_ITEMS).filter({ hasText: /^Uptime$/ }).first().click();
      await page.waitForTimeout(40);
      release();
      await page.waitForTimeout(4000);
      const t = await top(page, 'uptime');
      check('phone menu jump while Revenue fills in lands on the section', Math.abs(t - 177) <= 4, { top: t });
      await ctx.close();
    }
    // W42: Back from another site (page loads again) on provider / author pages
    for (const [path, y, vw] of [['/provider/deepinfra', 2600, { width: 1440, height: 900 }], ['/anthropic', 2200, { width: 390, height: 844 }]]) {
      const ctx = await launch(profile('r16b'), vw);
      const page = ctx.pages()[0];
      await open(page, path);
      await settled(page, '[data-orcf-block] .orcf-stat-value', 90000);
      await page.waitForTimeout(2500);
      await page.evaluate((y) => window.scrollTo(0, y), y);
      await page.waitForTimeout(1200);
      await page.goto('https://example.com/');
      await page.goBack({ waitUntil: 'load' });
      await page.waitForTimeout(9000);
      const got = await page.evaluate(() => Math.round(scrollY));
      check(`Back from another site to ${path} @${vw.width} returns to the same spot`, Math.abs(got - y) <= 12, { y: got, want: y });
      // W43: reload too
      await page.evaluate((y) => window.scrollTo(0, y), y);
      await page.waitForTimeout(1200);
      await page.reload({ waitUntil: 'load' });
      await page.waitForTimeout(9000);
      const got2 = await page.evaluate(() => Math.round(scrollY));
      check(`reload on ${path} @${vw.width} returns to the same spot`, Math.abs(got2 - y) <= 12, { y: got2, want: y });
      await ctx.close();
    }
  },

  /** round 17: the phone section sheet, Forward / second Back, input before mount, sticky controls, jumps */
  async r17() {
    const top = (page, id) => page.evaluate((id) => Math.round(document.getElementById(id)?.getBoundingClientRect().top ?? -99999), id);
    const y = (page) => page.evaluate(() => Math.round(scrollY));
    // U43: the sheet on /rankings — entry placement, the one selected item, their selection restored, trigger label
    {
      const ctx = await launch(profile('r17'), { width: 390, height: 844 });
      const page = ctx.pages()[0];
      await open(page, '/rankings');
      await settled(page, '#orcf-revenue .orcf-stat-value');
      const at = async (id) => {
        await page.evaluate((id) => { const s = document.getElementById(id); window.scrollTo(0, s.getBoundingClientRect().top + scrollY - 120); }, id);
        await page.waitForTimeout(1500);
        const label = (await phoneMenu(page)).triggers.find((t) => /Leaderboard|Revenue|Top|Market/.test(t));
        await phoneTrigger(page, /Leaderboard|Revenue|Top|Market/).click();
        await page.waitForTimeout(700);
        const m = await phoneMenu(page);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
        return { label, ...m };
      };
      const inRev = await at('orcf-revenue');
      check('sheet: Revenue right after Leaderboard', inRev.items.indexOf('Revenue') === inRev.items.indexOf('Leaderboard') + 1, inRev.items.slice(0, 4));
      check('sheet in Revenue: trigger says Revenue', inRev.label === 'Revenue', inRev.label);
      check('sheet in Revenue: only Revenue checked and ticked', inRev.checked.join() === 'Revenue' && inRev.ticked.join() === 'Revenue', { checked: inRev.checked, ticked: inRev.ticked });
      const inLb = await at('leaderboard-table');
      check('sheet in Leaderboard: their selection back, ours plain', inLb.checked.join() === 'Leaderboard' && inLb.ticked.join() === 'Leaderboard' && inLb.label !== 'Revenue', { checked: inLb.checked, ticked: inLb.ticked, label: inLb.label });
      // keyboard: from the checked Leaderboard radio, ArrowDown reaches ours, ArrowDown again leaves it
      await phoneTrigger(page, /Leaderboard|Top/).click();
      await page.waitForTimeout(700);
      await page.locator('[role=dialog] [data-option-value="leaderboard-table"] [role=radio]').focus();
      await page.keyboard.press('ArrowDown');
      const k1 = await focusedItem(page);
      await page.keyboard.press('ArrowDown');
      const k2 = await focusedItem(page);
      await page.keyboard.press('ArrowUp');
      const k3 = await focusedItem(page);
      check('sheet keys: Down into Revenue, Down out, Up back', k1 === 'Revenue' && k2 && k2 !== 'Revenue' && k3 === 'Revenue', [k1, k2, k3]);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(2000);
      const kt = await top(page, 'orcf-revenue');
      check('sheet keys: Enter on Revenue closes and jumps', !(await phoneMenu(page)).open && kt > 0 && kt < 300, { top: kt });
      // U44: choosing the grouping already selected keeps the rows shown
      await page.locator('#orcf-revenue .orcf-more').click();
      await page.waitForTimeout(800);
      const rows = () => page.evaluate(() => document.querySelectorAll('#orcf-revenue .orcf-tr:not(.is-head)').length);
      const before = await rows();
      await page.locator('#orcf-revenue [aria-label="Group revenue by"] [aria-checked="true"]').click();
      await page.waitForTimeout(800);
      check('re-choosing the current grouping keeps the rows', before > 10 && (await rows()) === before, { before, after: await rows() });
      await ctx.close();
    }
    // V44: Forward, and a second Back, to a model page (OpenRouter's scroll-spy puts a hash in the URL)
    for (const vw of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const ctx = await launch(profile('r17'), vw);
      const page = ctx.pages()[0];
      await open(page, '/anthropic/claude-sonnet-4.5');
      await settled(page, '#orcf-model-revenue .orcf-stat-value', 90000);
      await page.waitForTimeout(2000);
      const Y = vw.width > 1000 ? 3000 : 4200;
      await page.evaluate((Y) => window.scrollTo(0, Y), Y);
      await page.waitForTimeout(1500);
      const hashA = await page.evaluate(() => location.hash);
      const href = await page.evaluate(() => [...document.querySelectorAll('main a[href]')].map((a) => a.getAttribute('href')).find((h) => /^\/anthropic\/claude-[^/:#?]+$/.test(h) && h !== '/anthropic/claude-sonnet-4.5'));
      // (a DOM click: the link sits in a carousel, and a real click would first scroll it into view)
      await page.evaluate((h) => document.querySelector(`main a[href="${h}"]`).click(), href);
      await page.waitForURL((u) => u.pathname === href, { timeout: 20000 });
      await settled(page, '#orcf-model-revenue .orcf-stat-value', 90000);
      await page.waitForTimeout(2000);
      const YB = 1800;
      await page.evaluate((Y) => window.scrollTo(0, Y), YB);
      await page.waitForTimeout(1500);
      const back = async () => ({ y: await y(page), off: await page.evaluate((id) => { const el = document.getElementById(id); return el ? Math.round(el.getBoundingClientRect().top - (parseFloat(getComputedStyle(el).scrollMarginTop) || 0)) : null; }, hashA.slice(1)) });
      await page.goBack();
      await page.waitForTimeout(4500);
      const b1 = await back();
      await page.goForward();
      await page.waitForTimeout(4500);
      const f1 = await y(page);
      await page.goBack();
      await page.waitForTimeout(4500);
      const b2 = await back();
      const ok = (v, want) => Math.abs(v - want) <= 12;
      // OpenRouter's router answers Back to an entry whose URL has a section hash by putting that section at its
      // scroll margin (without the extension too): that, not the old offset, is what Back should show
      check(`model page @${vw.width}: first Back puts the URL's section where the router does`, !!hashA && Math.abs(b1.off ?? 99) <= 4, { hash: hashA, ...b1 });
      check(`model page @${vw.width}: Forward returns to the spot`, ok(f1, YB), { got: f1, want: YB });
      check(`model page @${vw.width}: second Back puts the URL's section where the router does`, Math.abs(b2.off ?? 99) <= 4, b2);
      await ctx.close();
    }
    // W44: the reader scrolls right after a reload, before our blocks are back: that isn't undone
    {
      const ctx = await launch(profile('r17'));
      const page = ctx.pages()[0];
      await open(page, '/provider/deepinfra');
      await settled(page, '[data-orcf-block] .orcf-stat-value', 90000);
      await page.waitForTimeout(2500);
      await page.evaluate(() => window.scrollTo(0, 2600));
      await page.waitForTimeout(1200);
      await page.reload({ waitUntil: 'load' });
      await page.mouse.move(700, 450);
      await page.mouse.wheel(0, 900);
      await page.waitForTimeout(400);
      // what the reader scrolled to: a text element at the reading line, outside our blocks
      const seen = await page.evaluate(() => {
        for (let yy = 300; yy < 800; yy += 20) {
          const el = document.elementFromPoint(720, yy);
          if (el && !el.closest('[data-orcf-block]') && el.childElementCount === 0 && el.textContent.trim()) {
            el.setAttribute('data-orcf-test-seen', '1');
            return { y: Math.round(scrollY), top: Math.round(el.getBoundingClientRect().top), text: el.textContent.trim().slice(0, 30) };
          }
        }
        return null;
      });
      await page.waitForTimeout(8000);
      const later = await page.evaluate(() => { const el = document.querySelector('[data-orcf-test-seen]'); return { y: Math.round(scrollY), top: el ? Math.round(el.getBoundingClientRect().top) : null }; });
      check('scrolling right after a reload is not undone', !!seen && later.top !== null && Math.abs(later.top - seen.top) <= 12, { seen, later });
      await ctx.close();
    }
    // W45: provider page's limit and the window stay as they were across a reload; the exact spot comes back
    {
      const ctx = await launch(profile('r17'));
      const page = ctx.pages()[0];
      await open(page, '/provider/deepinfra');
      await settled(page, '[data-orcf-block] .orcf-stat-value', 90000);
      await page.locator('[data-orcf-block] [aria-label="Time window"] button:has-text("30 days")').click();
      await settled(page, '[data-orcf-block] .orcf-stat-value', 90000);
      await page.waitForTimeout(1500);
      await page.locator('[data-orcf-block] .orcf-more').click();
      await page.waitForTimeout(1000);
      const state = () => page.evaluate(() => ({
        period: document.querySelector('[data-orcf-block] [aria-label="Time window"] [aria-checked="true"]')?.textContent,
        rows: document.querySelectorAll('[data-orcf-block] .orcf-tr:not(.is-head)').length,
      }));
      const before = await state();
      const anchor = await page.evaluate(() => { const rows = [...document.querySelectorAll('[data-orcf-block] .orcf-tr:not(.is-head)')]; const r = rows[Math.min(rows.length - 1, 18)]; window.scrollTo(0, r.getBoundingClientRect().top + scrollY - 400); return r.textContent.trim().slice(0, 40); });
      await page.waitForTimeout(1500);
      const Y = await y(page);
      await page.reload({ waitUntil: 'load' });
      await settled(page, '[data-orcf-block] .orcf-stat-value', 90000);
      await page.waitForTimeout(6000);
      const after = await state();
      const atLine = await page.evaluate((t) => { const r = [...document.querySelectorAll('[data-orcf-block] .orcf-tr:not(.is-head)')].find((x) => x.textContent.trim().startsWith(t)); return r ? Math.round(r.getBoundingClientRect().top) : null; }, anchor);
      check('reload keeps the window and rows shown', after.period === '30 days' && after.rows === before.rows && before.rows > 10, { before, after });
      check('reload with rows expanded returns to the same row', atLine !== null && Math.abs(atLine - 400) <= 12 && Math.abs((await y(page)) - Y) <= 12, { atLine, y: await y(page), Y });
      // the window is one for all pages in the tab (like before), so a reload elsewhere starts at 30 days too
      await open(page, '/anthropic');
      await settled(page, '[data-orcf-block] .orcf-stat-value', 90000);
      const p2 = await page.evaluate(() => document.querySelector('[data-orcf-block] [aria-label="Time window"] [aria-checked="true"]')?.textContent);
      check('the window carries to another page', p2 === '30 days', p2);
      await page.locator('[data-orcf-block] [aria-label="Time window"] button:has-text("7 days")').click();
      await ctx.close();
    }
    // Y38: a sidebar jump right after Back (restored position trusted) is still corrected when our block grows later
    {
      const ctx = await launch(profile('r17', false));
      const page = ctx.pages()[0];
      await page.goto('https://openrouter.ai/anthropic/claude-sonnet-4.5', { waitUntil: 'load' });
      await settled(page, '#orcf-model-revenue .orcf-stat-value', 180000);
      await page.waitForTimeout(1500);
      await page.evaluate(() => window.scrollTo(0, 2200));
      await page.waitForTimeout(1200);
      await page.goto('https://example.com/');
      let release;
      const gate = new Promise((r) => (release = r));
      await ctx.route(/stats\/(provider-token-chart|effective-pricing|model-activity)|catalog\/models/, async (r) => { await gate; await r.continue(); });
      await page.goBack({ waitUntil: 'load' });
      await page.waitForSelector('a[href="#performance"]:not([data-orcf])', { timeout: 30000 });
      await page.waitForTimeout(600);
      await page.locator('a[href="#performance"]:not([data-orcf])').first().click();
      await page.waitForTimeout(1500);
      const t0 = await top(page, 'performance');
      release();
      await page.waitForTimeout(5000);
      const t1 = await top(page, 'performance');
      check('jump after Back stays put while our block fills in', Math.abs(t1 - 126) <= 4, { afterJump: t0, later: t1 });
      await ctx.close();
    }
    // Y39: Ctrl+click on a section link opens a tab; this one doesn't move
    {
      const ctx = await launch(profile('r17'));
      const page = ctx.pages()[0];
      await open(page, '/anthropic/claude-sonnet-4.5');
      await settled(page, '#orcf-model-revenue .orcf-stat-value', 90000);
      await page.waitForTimeout(1500);
      await page.evaluate(() => window.scrollTo(0, 400));
      await page.waitForTimeout(800);
      const y0 = await y(page);
      // OpenRouter takes a Ctrl+click on its section links itself and scrolls this tab: then it lands like a click
      await page.locator('a[href="#performance"]:not([data-orcf])').first().click({ modifiers: ['Control'] });
      await page.waitForTimeout(2500);
      const t = await top(page, 'performance');
      check('Ctrl+click a section link OpenRouter handles lands like a click', Math.abs(t - 126) <= 4, { top: t, pages: ctx.pages().length });
      // a section link the page leaves to the browser: Ctrl+click opens a tab and this one stays put
      await page.evaluate(() => window.scrollTo(0, 400));
      await page.waitForTimeout(800);
      await page.evaluate(() => { const a = document.createElement('a'); a.href = '#performance'; a.textContent = 'plain link'; a.id = 'orcf-test-link'; Object.assign(a.style, { position: 'fixed', top: '300px', left: '600px', zIndex: 99999, background: 'white' }); document.body.append(a); });
      const tabs = ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null);
      await page.locator('#orcf-test-link').click({ modifiers: ['Control'] });
      await tabs;
      await page.waitForTimeout(1500);
      check('Ctrl+click a plain section link leaves this tab where it was', Math.abs((await y(page)) - 400) <= 2, { after: await y(page) });
      await ctx.close();
    }
  },
};

const order = ['main', 'layout', 'errors', 'nav', 'a11y', 'data', 'r7', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r13u', 'r14', 'r15', 'r16', 'r16b', 'r17', 'outage'];
const wanted = process.argv.slice(2);
for (const name of wanted.includes('all') ? order : wanted) {
  if (!SUITES[name]) {
    console.log('unknown suite', name);
    continue;
  }
  console.log(`\n== ${name}`);
  try {
    await SUITES[name]();
  } catch (e) {
    check(`${name}: suite crashed`, false, String(e?.message ?? e).slice(0, 200));
  }
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
