// Main-thread cost of the extension: long tasks and script time per page, with vs without it.
//   ORCF_PROFILE=/tmp/warm-profile node scripts/perf.mjs
// Uses a warm profile (cached data) for the "with" runs, so it measures steady-state browsing.

import { chromium } from 'playwright-core';
import { cpSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const ext = resolve('dist');
const PAGES = ['/rankings', '/anthropic/claude-opus-5.5', '/provider/deepinfra', '/anthropic', '/apps/claude-code'];
const warm = process.env.ORCF_PROFILE ?? '/tmp/orcf-gallery-profile';

async function measure(withExt) {
  const dir = `/tmp/orcf-perf-${withExt ? 'ext' : 'plain'}`;
  rmSync(dir, { recursive: true, force: true });
  if (withExt) cpSync(warm, dir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(dir, {
    executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    args: withExt ? [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] : [],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.addInitScript(() => {
    localStorage.setItem('orcf-debug', '1');
    window.__lt = { n: 0, ms: 0, max: 0 };
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) { window.__lt.n++; window.__lt.ms += e.duration; window.__lt.max = Math.max(window.__lt.max, e.duration); }
    }).observe({ type: 'longtask', buffered: true });
  });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  const out = {};
  for (const p of PAGES) {
    const m0 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
    await page.goto('https://openrouter.ai' + p, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(12000);
    // scroll through the page like a reader
    for (let y = 0; y < 6; y++) { await page.mouse.wheel(0, 900); await page.waitForTimeout(400); }
    await page.waitForTimeout(2000);
    const m1 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
    const r = await page.evaluate(() => ({ lt: window.__lt, orcf: JSON.parse(document.documentElement.dataset.orcfPerf || 'null') }));
    out[p] = {
      scriptMs: Math.round((m1.ScriptDuration - m0.ScriptDuration) * 1000),
      taskMs: Math.round((m1.TaskDuration - m0.TaskDuration) * 1000),
      longTasks: r.lt.n,
      longTaskMs: Math.round(r.lt.ms),
      maxLongTaskMs: Math.round(r.lt.max),
      heapMB: Math.round(m1.JSHeapUsedSize / 1e6),
      ...(r.orcf ? { ourTicks: r.orcf.ticks, ourTickMs: r.orcf.totalMs, ourMaxTickMs: r.orcf.maxMs } : {}),
    };
  }
  await ctx.close();
  return out;
}

const plain = await measure(false);
const withExt = await measure(true);
for (const p of PAGES) {
  console.log(p);
  console.log('  without:', JSON.stringify(plain[p]));
  console.log('  with   :', JSON.stringify(withExt[p]));
}
