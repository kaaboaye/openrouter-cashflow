// Our islands appear and fill in after OpenRouter's page has rendered. Whatever the reader is looking at must not
// move because of that (a link to, or Back to, a section below one of ours; figures that arrive late). The browser's
// scroll anchoring doesn't reliably do it on these pages, so every change we make to the DOM goes through
// `keepReaderInPlace`: note an element at the reading line and where it is, make the change, and scroll back by
// however far it actually moved. (If the browser compensated already, it didn't move, and we do nothing.)
//
// Two moments are handled differently:
//  - a jump to a section (a sidebar or phone-menu entry, an in-page link): its smooth scroll heads for a position
//    computed before our block grew, and any scroll of ours (or the browser's anchoring) would cut it short or be
//    thrown away. So nothing is corrected while it runs, and when it settles the section is put exactly where a
//    jump lands it (its scroll margin).
//  - a restored scroll position (Back/Forward, reload): it was measured with our blocks on the page, so while they
//    re-appear nothing is corrected (see `trustRestoredScroll`).
//
// Our large blocks (the revenue sections and cards) carry `data-orcf-block`.

/**
 * A position being held instead (a link to our section, or a restored reload/Back position): applied right after
 * each of our changes, until it expires or the reader scrolls themselves.
 */
let holder: { apply: () => void; until: number } | null = null;
export function setHolder(h: { apply: () => void; until: number } | null) {
  holder = h;
}
function activeHolder() {
  if (holder && Date.now() > holder.until) holder = null;
  return holder;
}

/** A little below OpenRouter's sticky headers: where sections land when you jump to them. */
const READING_LINE = 200;

const root = () => document.scrollingElement as HTMLElement | null;

// ---- the browser's own scroll anchoring, switched off while a jump or a restored position is in charge ----

let anchoringOffUntil = 0;
let anchoringTimer: ReturnType<typeof setTimeout> | null = null;
function anchoringOff(ms: number) {
  const r = root();
  if (!r) return;
  anchoringOffUntil = Math.max(anchoringOffUntil, performance.now() + ms);
  r.style.overflowAnchor = 'none';
  if (anchoringTimer) clearTimeout(anchoringTimer);
  anchoringTimer = setTimeout(anchoringBackOn, Math.max(0, anchoringOffUntil - performance.now()));
}
function anchoringBackOn() {
  anchoringTimer = null;
  const left = anchoringOffUntil - performance.now();
  if (left > 0) return void (anchoringTimer = setTimeout(anchoringBackOn, left));
  const r = root();
  if (r?.style.overflowAnchor === 'none') r.style.overflowAnchor = '';
}

// ---- jumps to a section ----

let jump: { id: string; at: number } | null = null;
let lastForeignScroll = -Infinity;
let ownY: number | null = null;
let jumpTimer: ReturnType<typeof setInterval> | null = null;

/** A smooth scroll to the section `id` has started (or is about to). */
export function startJump(id: string) {
  if (!id || !document.getElementById(id)) return;
  jump = { id, at: performance.now() };
  suspendedUntil = 0; // the reader chose where to go: a restored position no longer applies
  anchoringOff(4000);
  if (!jumpTimer) jumpTimer = setInterval(checkJump, 100);
}

function endJump() {
  jump = null;
  if (jumpTimer) clearInterval(jumpTimer);
  jumpTimer = null;
  anchoringOffUntil = Math.min(anchoringOffUntil, suspendedUntil);
  anchoringBackOn();
}

/** Once the jump's scrolling has settled, put its section where a jump lands it. */
function checkJump() {
  if (!jump) return endJump();
  const now = performance.now();
  if (now - jump.at > 4000) return endJump();
  if (now - jump.at < 300 || now - lastForeignScroll < 200) return; // still on its way
  const el = document.getElementById(jump.id);
  if (el) {
    const want = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
    const dy = el.getBoundingClientRect().top - want;
    if (Math.abs(dy) > 2) {
      window.scrollBy(0, dy);
      ownY = window.scrollY;
    }
  }
  endJump();
}

addEventListener(
  'scroll',
  (e) => {
    if (!e.isTrusted) return; // a nudge for OpenRouter's section tracking (see SectionNav), not a scroll
    if (ownY !== null && Math.abs(window.scrollY - ownY) < 1) return void (ownY = null);
    lastForeignScroll = performance.now();
  },
  { passive: true, capture: true },
);
// the reader taking over (wheel, touch, keys) ends a jump: their scrolling isn't to be undone
for (const ev of ['wheel', 'touchstart', 'keydown'] as const) addEventListener(ev, () => jump && endJump(), { passive: true, capture: true });
// what starts a jump: an in-page link, OpenRouter's phone section menu (items named like the sidebar's links)
addEventListener(
  'click',
  (e) => {
    if (!e.isTrusted) return;
    const t = e.target as Element | null;
    const a = t?.closest?.('a[href^="#"]');
    if (a) {
      const target = a.getAttribute('target');
      if (target && target !== '_self') return;
      const id = decodeURIComponent(a.getAttribute('href')!.slice(1));
      // Ctrl/Shift/…-click opens the link in another tab or window, unless the page handles the click itself and
      // scrolls this one (OpenRouter's section links do): known once the click has been dispatched
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return void setTimeout(() => e.defaultPrevented && startJump(id));
      return startJump(id);
    }
    // OpenRouter's section sheet (phones/tablets): options carry their section's id
    const option = t?.closest?.('[role="dialog"] [data-option-value]');
    if (option) return startJump(option.getAttribute('data-option-value')!);
    const item = t?.closest?.('[role="menuitem"]');
    if (item) {
      const label = item.textContent?.trim();
      const link = [...document.querySelectorAll('a[href^="#"]')].find((l) => l.textContent?.trim() === label);
      if (link) startJump(decodeURIComponent(link.getAttribute('href')!.slice(1)));
    }
  },
  { passive: true, capture: true },
);
addEventListener('hashchange', () => startJump(decodeURIComponent(location.hash.slice(1))));

// The reader clicking or typing in one of our blocks ("Show all", a period button): whatever it does to the block's
// height is what they asked for, so it grows downwards as usual — nothing below it is held in place.
let usedOursAt = -Infinity;
for (const ev of ['mousedown', 'keydown', 'touchstart'] as const) {
  addEventListener(ev, (e) => ((e.target as Element | null)?.closest?.('[data-orcf-block]') ? (usedOursAt = performance.now()) : 0), { passive: true, capture: true });
}

// ---- restored positions ----

/** the reader's first wheel/touch/key/mouse input since this script started (i.e. since the page loaded) */
let readerActedAt = -Infinity;
for (const ev of ['wheel', 'touchstart', 'keydown', 'mousedown'] as const) {
  addEventListener(ev, () => readerActedAt === -Infinity && (readerActedAt = performance.now()), { passive: true, capture: true });
}

/**
 * Right after a Back/Forward or a reload, the scroll position the browser or OpenRouter's router restores was
 * measured with our blocks on the page: correcting while they re-appear would count them twice. That goes for the
 * browser's own scroll anchoring too (it kicks in once our block is entirely above the screen), so it is switched
 * off for the page meanwhile.
 */
let suspendedUntil = 0;
/** while trusting: if this section is found at its scroll margin, the router jumped to it instead of restoring */
let unlessAt: string | null = null;
export function trustRestoredScroll(ms: number, unlessSectionAtMargin: string | null = null) {
  if (jump) endJump();
  suspendedUntil = performance.now() + ms;
  unlessAt = unlessSectionAtMargin;
  anchoringOff(ms);
}

/** The router jumped to the hash's section (it sits exactly at its scroll margin): correct as usual after all. */
function routerJumped(): boolean {
  if (!unlessAt) return false;
  const el = document.getElementById(unlessAt);
  if (!el) return false;
  const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
  if (Math.abs(el.getBoundingClientRect().top - margin) > 3) return false;
  suspendedUntil = 0;
  unlessAt = null;
  anchoringOffUntil = 0;
  anchoringBackOn();
  return true;
}

/**
 * Hold the page at an exact scroll position (the one saved when the reader left it, for a reload or a Back/Forward
 * that loads the page again) while our blocks re-appear, until the reader scrolls or `ms` passes. Once they are
 * back the page is laid out as it was, so the same offset shows the same content. (Model pages and /rankings
 * restore a section-relative position instead, see SectionNav — its hold replaces this one.)
 */
export function holdScrollY(y: number, ms: number) {
  if (readerActedAt > -Infinity) return; // they already scrolled or clicked: leave them where they are
  const h = {
    until: Date.now() + ms,
    apply: () => {
      if (Math.abs(window.scrollY - y) > 1) {
        window.scrollTo(0, y);
        ownY = window.scrollY;
      }
    },
  };
  holder = h;
  const inputs = ['wheel', 'touchstart', 'keydown', 'mousedown'] as const;
  const release = () => {
    if (holder === h) holder = null;
    for (const ev of inputs) removeEventListener(ev, release, true);
  };
  for (const ev of inputs) addEventListener(ev, release, { passive: true, capture: true });
  h.apply();
}

/** A navigation to another page: a jump on the old one is over. */
export function resetAnchoring() {
  if (jump) endJump();
}

// ---- keeping the reader in place ----

/**
 * The element to keep in place: the first thing at or below the reading line that is neither inside one of our
 * blocks (then the reader is reading it, and its own changes are what they're looking at — e.g. "Show all" grows
 * downwards) nor a container (in the gaps between sections the hit is the page column, which holds our block and
 * never moves when it grows: look a little further down instead).
 */
function snapshot(): { el: Element; top: number } | null {
  if (window.scrollY < 1) return null; // at the very top the reader expects to stay at the top
  if (performance.now() - usedOursAt < 2000) return null;
  const blocks = [...document.querySelectorAll('[data-orcf-block]')];
  const x = window.innerWidth / 2;
  for (let y = READING_LINE; y < window.innerHeight - 8; y += 40) {
    let el = document.elementFromPoint(x, y);
    if (!el) continue;
    const block = el.closest('[data-orcf-block]');
    if (block) {
      // only the last strip of our block is at the reading line: what fills the screen is below it
      const bottom = block.getBoundingClientRect().bottom;
      if (bottom - y < window.innerHeight * 0.25) {
        y = bottom + 8 - 40;
        continue;
      }
      return null;
    }
    // elementFromPoint returns the deepest element, so a hit much taller than the screen is a container showing
    // through a gap (e.g. the page column, before our block is even in it)
    if (blocks.some((b) => el!.contains(b)) || el.getBoundingClientRect().height > window.innerHeight * 1.5) continue;
    const small = el.closest('[data-orcf]');
    if (small) el = small.parentElement ?? el; // one of our figures inside OpenRouter's content: anchor on its row
    // A box hit in its padding (a model card) keeps its top when our figure is added inside it, though what the
    // reader reads in it moves down: prefer an element with no element children (text) just below the line.
    if (el.childElementCount > 0) {
      for (let dy = 6; dy <= 30; dy += 6) {
        const leaf = document.elementFromPoint(x, y + dy);
        if (leaf && leaf.childElementCount === 0 && el.contains(leaf) && !leaf.closest('[data-orcf]')) return { el: leaf, top: leaf.getBoundingClientRect().top };
      }
    }
    return { el, top: el.getBoundingClientRect().top };
  }
  return null;
}

export function keepReaderInPlace<T>(change: () => T): T {
  const h = activeHolder();
  if (h) {
    const out = change();
    h.apply();
    return out;
  }
  // a jump in progress (it is finished when it settles) or a restored position being re-built: leave it alone
  if (jump || (performance.now() < suspendedUntil && !routerJumped())) return change();
  const snap = snapshot();
  const out = change();
  if (snap && snap.el.isConnected) {
    const dy = snap.el.getBoundingClientRect().top - snap.top;
    if (Math.abs(dy) > 1) {
      window.scrollBy(0, dy);
      ownY = window.scrollY;
    }
  }
  return out;
}
