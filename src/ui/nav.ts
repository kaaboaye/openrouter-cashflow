// Our section's entry in OpenRouter's own section navigation: the desktop sidebar (with its moving
// highlight "pill"), the phone section menu and its trigger label, the URL hash, and deep links.

import { setHolder, startJump } from './anchor.ts';

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 18V6"/></svg>`;

/**
 * Whether SectionNavs being constructed belong to a rebuild of the current page (e.g. at midnight UTC)
 * rather than a navigation; a rebuild never re-honours the URL's hash, which we may have written ourselves.
 */
let rebuilding = false;

/**
 * The URL as the content script first saw it. On a reload OpenRouter's scroll-spy rewrites the hash to
 * whichever of its sections the restored scroll position shows (before our section exists), so the hash
 * the reader reloaded with is only known this early.
 */
let initial: { path: string; hash: string } | null = { path: location.pathname, hash: location.hash };
export function asRebuild<T>(make: () => T): T {
  rebuilding = true;
  try {
    return make();
  } finally {
    rebuilding = false;
  }
}

const PIN_MS = 5000;
const USER_SCROLL = ['wheel', 'touchstart', 'keydown', 'mousedown'] as const;
/** one saved position per page: same-origin pages in a tab share sessionStorage */
const posKey = (path: string) => `orcf-reading-position:${path}`;

/** A reload, or Back/Forward that loaded the page again (not from the back/forward cache). */
function isRestoredNavigation(): boolean {
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  return nav?.type === 'reload' || nav?.type === 'back_forward';
}

type Saved = { id: string; top: number } | { fromBottom: number };

/**
 * Where the reader was when this page was last left (saved on pagehide): the section at the reading line and
 * where its top was, or — past the last section (the footer) — the distance from the bottom of the page.
 */
function savedPosition(path: string): Saved | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(posKey(path)) ?? 'null') as ({ path: string } & Partial<{ id: string; top: number; fromBottom: number }>) | null;
    if (!v || v.path !== path) return null;
    if (v.id && Number.isFinite(v.top)) return { id: v.id, top: v.top! };
    if (Number.isFinite(v.fromBottom)) return { fromBottom: v.fromBottom! };
    return null;
  } catch {
    return null;
  }
}

/** A held position that keeps an element's top at `top` px from the viewport's top. */
function elementAt(el: () => Element | null, top: number): () => number | null {
  return () => {
    const e = el();
    return e ? window.scrollY + e.getBoundingClientRect().top - top : null;
  };
}

/** The scroll position a held position wants right now (null: its element isn't there yet). */
type Pin = { target: () => number | null; until: number };

/** OpenRouter marks the current menu item with extra classes only; the most common class is the plain one. */
function plainMenuClass(items: HTMLElement[]): string {
  const counts = new Map<string, number>();
  for (const i of items) if (!i.hasAttribute('data-orcf')) counts.set(i.className, (counts.get(i.className) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

export class SectionNav {
  private link: HTMLAnchorElement | null = null;
  private active = false;
  /** the sidebar link we un-highlighted, with the class it had, so we can hand the highlight back */
  private demoted: { el: HTMLAnchorElement; cls: string; asCls: string } | null = null;
  private inactiveCls: string | null = null;
  private activeCls: string | null = null;
  /** our label inside OpenRouter's phone section-menu button, shown while our section is current */
  private triggerLabel: HTMLElement | null = null;
  private raf = 0;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;

  private onScroll = () => {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.update();
    });
  };
  // OpenRouter's scroll-spy rewrites the URL hash after scrolling stops; re-assert ours right after it.
  private onScrollEnd = () => {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.update(), 150);
  };
  private onKeyDown = (e: KeyboardEvent) => this.menuKeys(e);

  /** decided once, from the URL the user navigated to — never from a hash we write while scrolling */
  private deepLink: boolean;
  /**
   * Holds a position while our section appears and fills in: a link to our section (its scroll margin), or the
   * spot saved before a reload. Released on the reader's first own scroll input, or after a few seconds.
   */
  private pin: Pin | null = null;
  private mounted = false;
  private release = () => this.setPin(null);
  private setPin(p: Pin | null) {
    this.pin = p;
    setHolder(p ? { apply: () => this.applyPin(), until: p.until } : null);
  }
  // The browser restores a reload's scroll position as an absolute offset measured while our section was on
  // the page, i.e. before it exists again: remember instead which section the reader was in and how far.
  private onPageHide = () => {
    try {
      const at = window.scrollY >= 1 ? this.readerSection(true) : null;
      const fromBottom = document.documentElement.scrollHeight - window.scrollY;
      const key = posKey(location.pathname);
      if (at) sessionStorage.setItem(key, JSON.stringify({ path: location.pathname, id: at.el.id, top: at.top }));
      else if (window.scrollY >= 1) sessionStorage.setItem(key, JSON.stringify({ path: location.pathname, fromBottom }));
      else sessionStorage.removeItem(key);
    } catch {
      /* storage blocked */
    }
  };

  constructor(private o: { sectionId: string; afterHref: string[]; menuAfter: string[]; label: string }) {
    const ours = `#${o.sectionId}`;
    const first = !!initial && initial.path === location.pathname;
    const reloadedOnUs = first && initial!.hash === ours;
    initial = null; // only the first page the script sees can be a reload
    this.deepLink = !rebuilding && (location.hash === ours || reloadedOnUs);
    const saved = !rebuilding && first && isRestoredNavigation() ? savedPosition(location.pathname) : null;
    if (saved) {
      // a reload (or Back/Forward that reloaded the page): the same spot in the same section, ours or theirs
      this.deepLink = false;
      this.setPin({ target: 'id' in saved ? elementAt(() => document.getElementById(saved.id), saved.top) : () => document.documentElement.scrollHeight - saved.fromBottom, until: Date.now() + PIN_MS });
    }
    window.addEventListener('scroll', this.onScroll, { passive: true });
    window.addEventListener('scrollend', this.onScrollEnd, { passive: true });
    // capture on window so we see menu keys before OpenRouter's (React) handlers do
    window.addEventListener('keydown', this.onKeyDown, true);
    for (const ev of USER_SCROLL) window.addEventListener(ev, this.release, { passive: true, capture: true });
    window.addEventListener('pagehide', this.onPageHide);
  }

  /** The section at the reading line (where sections land when you jump to them), with its viewport top. */
  private readerSection(includeOurs: boolean): { el: Element; top: number } | null {
    if (window.scrollY < 1) return null;
    const ids = new Set<string>();
    for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) ids.add(decodeURIComponent(a.getAttribute('href')!.slice(1)));
    if (!includeOurs) ids.delete(this.o.sectionId);
    let best: { el: Element; top: number } | null = null;
    for (const id of ids) {
      const el = id ? document.getElementById(id) : null;
      if (!el || (el.id !== this.o.sectionId && el.closest('[data-orcf]'))) continue;
      const r = el.getBoundingClientRect();
      if (r.top <= 240 && r.bottom > 0 && (!best || r.top > best.top)) best = { el, top: r.top };
    }
    return best;
  }

  private applyPin() {
    const p = this.pin;
    if (!p) return;
    if (Date.now() > p.until) return void this.setPin(null);
    const y = p.target();
    if (y !== null && Math.abs(y - window.scrollY) > 1) window.scrollTo(0, y);
  }

  private section() {
    return document.getElementById(this.o.sectionId);
  }

  /** The section is current once its top reaches the line it scrolls to (its scroll-margin), like OpenRouter's own sections. */
  private activeLine(s: HTMLElement) {
    const margin = parseFloat(getComputedStyle(s).scrollMarginTop);
    return (Number.isFinite(margin) && margin > 0 ? margin : 160) + 24;
  }

  private scrollToSection() {
    const s = this.section();
    if (!s) return;
    startJump(this.o.sectionId); // finished where it should land even if our section grows on the way
    s.scrollIntoView({ behavior: 'smooth', block: 'start' });
    history.replaceState(history.state, '', `#${this.o.sectionId}`);
  }

  tick() {
    this.ensureSidebarLink();
    this.ensureMenuItem();
    this.ensureSheetItem();
    // The browser's own jump to #id happened before our section existed, so do it once per page — not
    // again when the islands are rebuilt (e.g. at midnight UTC) while the reader is somewhere in the section.
    const s = this.section();
    if (this.deepLink && s) {
      this.deepLink = false;
      // land where a jump to the section lands (its scroll margin), or, on a reload, where the reader was in it
      const margin = parseFloat(getComputedStyle(s).scrollMarginTop) || 0;
      this.setPin({ target: elementAt(() => this.section(), margin), until: Date.now() + PIN_MS });
    }
    if (s) this.applyPin();
    if (s && !this.mounted) {
      this.mounted = true;
      // OpenRouter's section tracking last ran before our section existed (e.g. on a restored reload position it
      // may name a section that is now far below): let it look again at what is on screen now
      requestAnimationFrame(() => window.dispatchEvent(new Event('scroll')));
    }
    this.update();
  }

  private ensureSidebarLink() {
    const anchor = this.o.afterHref
      .map((h) => document.querySelector<HTMLAnchorElement>(`a[href="${h}"]:not([data-orcf])`))
      .find(Boolean);
    if (!anchor) return;
    if (!this.link) {
      const template = [...(anchor.parentElement?.querySelectorAll<HTMLAnchorElement>('a') ?? [])].find((a) => !a.hasAttribute('aria-current')) ?? anchor;
      const a = document.createElement('a');
      a.href = `#${this.o.sectionId}`;
      a.className = template.className;
      a.setAttribute('data-orcf', '');
      a.innerHTML = ICON + this.o.label;
      a.querySelector('svg')?.setAttribute('class', template.querySelector('svg')?.getAttribute('class') ?? '');
      a.addEventListener('click', (e) => {
        e.preventDefault();
        this.scrollToSection();
      });
      this.link = a;
    }
    if (anchor.nextElementSibling !== this.link) anchor.after(this.link);
  }

  /**
   * While our section is current: highlight our sidebar entry (moving OpenRouter's pill to it), show our
   * name on the phone section-menu button, and keep our hash in the URL. Runs on scroll, after scrolling
   * settles and on every DOM change, so when OpenRouter's scroll-spy re-marks one of its own sections we
   * take it back; when our section stops being current, everything is handed back.
   */
  private update() {
    const s = this.section();
    if (!s) return;
    const r = s.getBoundingClientRect();
    const line = this.activeLine(s);
    const active = r.top <= line && r.bottom > line;
    if (!active && !this.active) return;

    const link = this.link?.isConnected ? this.link : null;
    const list = link?.parentElement ?? null;
    const theirs = list ? [...list.querySelectorAll<HTMLAnchorElement>('a:not([data-orcf])')] : [];
    if (link) this.inactiveCls ??= theirs.find((a) => !a.hasAttribute('aria-current'))?.className ?? link.className;
    const current = () => theirs.find((a) => a.getAttribute('aria-current') === 'page');
    const pill = list?.previousElementSibling as HTMLElement | null | undefined;
    const movePill = (to: HTMLElement | null | undefined) => {
      if (!pill || !to || !pill.style.getPropertyValue('--pill-top')) return;
      if (pill.style.getPropertyValue('--pill-top') !== `${to.offsetTop}px`) pill.style.setProperty('--pill-top', `${to.offsetTop}px`);
      if (pill.style.getPropertyValue('--pill-height') !== `${to.offsetHeight}px`) pill.style.setProperty('--pill-height', `${to.offsetHeight}px`);
    };
    const ourHash = `#${this.o.sectionId}`;
    const sectionHash = (h: string) => h !== ourHash && !!h && !!document.getElementById(decodeURIComponent(h.slice(1)));

    if (active) {
      this.active = true;
      if (link) {
        const c = current();
        if (c) {
          this.activeCls = c.className;
          this.demoted = { el: c, cls: c.className, asCls: this.inactiveCls! };
          c.className = this.inactiveCls!;
          c.removeAttribute('aria-current');
        }
        if (this.activeCls && link.className !== this.activeCls) link.className = this.activeCls;
        if (link.getAttribute('aria-current') !== 'page') link.setAttribute('aria-current', 'page');
        movePill(link);
      }
      this.syncTrigger(true);
      this.syncMenu();
      this.syncSheet();
      // OpenRouter keeps the URL hash on the current section; keep ours there while we're current.
      if (sectionHash(location.hash)) history.replaceState(history.state, '', ourHash);
      return;
    }

    this.active = false;
    if (link) {
      link.className = this.inactiveCls ?? link.className;
      link.removeAttribute('aria-current');
      // Hand the highlight back unless OpenRouter has already moved it somewhere else.
      const d = this.demoted;
      this.demoted = null;
      if (d && d.el.isConnected && d.el.className === d.asCls && !current()) {
        d.el.className = d.cls;
        d.el.setAttribute('aria-current', 'page');
      }
      movePill(current());
    }
    this.syncTrigger(false);
    this.syncMenu();
    this.syncSheet();
    const now = current();
    if (location.hash === ourHash && now) history.replaceState(history.state, '', now.getAttribute('href') ?? '');
  }

  /** OpenRouter's phone section-menu button: the one whose label is one of its section names. */
  private findTrigger(): HTMLButtonElement | null {
    const names = new Set<string>(this.o.menuAfter);
    document.querySelectorAll('a[href^="#"]:not([data-orcf])').forEach((a) => names.add(a.textContent?.trim() ?? ''));
    // the phone/tablet section control: a dropdown menu, or (since Nov 2026) a bottom sheet
    for (const b of document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"], button[aria-haspopup="dialog"]')) {
      const label = [...b.children].find((c) => c.tagName === 'SPAN' && !c.hasAttribute('data-orcf') && !c.hasAttribute('aria-hidden'));
      if (label && names.has(label.textContent?.trim() ?? '')) return b;
    }
    return null;
  }

  /**
   * Show our name on the phone menu button while our section is current. We never touch OpenRouter's own
   * label node (React owns it); we hide it and put ours beside it, so its updates keep working.
   */
  private syncTrigger(active: boolean) {
    const trigger = this.findTrigger() ?? this.triggerLabel?.parentElement ?? null;
    if (!trigger) return;
    const theirs = [...trigger.children].find((c) => c.tagName === 'SPAN' && !c.hasAttribute('data-orcf') && !c.hasAttribute('aria-hidden')) as HTMLElement | undefined;
    if (active && theirs) {
      if (!this.triggerLabel) {
        const span = document.createElement('span');
        span.setAttribute('data-orcf', '');
        span.className = theirs.className;
        span.innerHTML = ICON + `<span class="${theirs.querySelector('span')?.className ?? ''}">${this.o.label}</span>`;
        span.querySelector('svg')?.setAttribute('class', theirs.querySelector('svg')?.getAttribute('class') ?? '');
        this.triggerLabel = span;
      }
      if (theirs.previousElementSibling !== this.triggerLabel) theirs.before(this.triggerLabel);
      if (theirs.style.display !== 'none') theirs.style.display = 'none';
    } else {
      this.triggerLabel?.remove();
      this.triggerLabel = null;
      if (theirs?.style.display === 'none') theirs.style.display = '';
    }
  }

  /** The phone layout replaces the sidebar with a dropdown menu; add our entry to it while it's open. */
  private ensureMenuItem() {
    for (const menu of document.querySelectorAll<HTMLElement>('[role="menu"]')) {
      if (menu.querySelector('[data-orcf]')) continue;
      const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
      const after = this.o.menuAfter.map((t) => items.find((i) => i.textContent?.trim() === t)).find(Boolean);
      if (!after) continue;
      const item = document.createElement('div');
      item.setAttribute('role', 'menuitem');
      item.setAttribute('tabindex', '-1');
      item.setAttribute('data-orcf', '');
      item.className = plainMenuClass(items) + ' orcf-menuitem';
      item.innerHTML = ICON + this.o.label;
      item.querySelector('svg')?.setAttribute('class', after.querySelector('svg')?.getAttribute('class') ?? '');
      item.addEventListener('click', () => this.chooseMenuItem(menu));
      // OpenRouter's menu highlights the item under the pointer by focusing it (its classes style :focus)
      item.addEventListener('mousemove', () => {
        if (document.activeElement !== item) item.focus({ preventScroll: true });
      });
      after.after(item);
    }
    this.syncMenu();
  }

  /** the class OpenRouter gives its current menu item, learned from whichever item had it */
  private menuActiveCls: string | null = null;
  private menuDemoted: { el: HTMLElement; cls: string; plain: string } | null = null;

  /** Like the sidebar: while our section is current, our menu item carries the highlight, not theirs. */
  private syncMenu() {
    for (const menu of document.querySelectorAll<HTMLElement>('[role="menu"]')) {
      const ours = menu.querySelector<HTMLElement>('[role="menuitem"][data-orcf]');
      if (!ours) continue;
      const theirs = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([data-orcf])')];
      const plain = plainMenuClass(theirs);
      const selected = theirs.find((i) => i.className !== plain);
      if (selected) this.menuActiveCls = selected.className;
      if (this.active) {
        if (selected) {
          this.menuDemoted = { el: selected, cls: selected.className, plain };
          selected.className = plain;
        }
        const want = (this.menuActiveCls ?? plain) + ' orcf-menuitem';
        if (ours.className !== want) ours.className = want;
      } else {
        const want = plain + ' orcf-menuitem';
        if (ours.className !== want) ours.className = want;
        const d = this.menuDemoted;
        this.menuDemoted = null;
        if (d && d.el.isConnected && d.el.className === d.plain && !selected) d.el.className = d.cls;
      }
    }
  }

  /**
   * Since Nov 2026 OpenRouter's phone/tablet section control opens a bottom sheet: a radio group of options named
   * by their section's id. Add ours after the section it follows, built from theirs so it looks the same.
   */
  private ensureSheetItem() {
    for (const group of document.querySelectorAll<HTMLElement>('[role="dialog"] [role="radiogroup"]')) {
      const options = [...group.querySelectorAll<HTMLElement>(':scope > [data-option-value]')];
      if (!options.length || group.querySelector(':scope > [data-orcf]')) continue;
      const after = this.o.afterHref.map((h) => options.find((o) => o.getAttribute('data-option-value') === h.slice(1))).find(Boolean);
      if (!after) continue;
      const [sr, label, check] = [...after.children] as HTMLElement[];
      const labelId = `orcf-sheet-${this.o.sectionId}`;
      const item = document.createElement('div');
      item.setAttribute('role', 'presentation');
      item.setAttribute('data-option-value', this.o.sectionId);
      item.setAttribute('data-orcf', '');
      item.className = plainMenuClass(options);
      const radioCls = sr?.querySelector('[role="radio"]')?.getAttribute('class') ?? '';
      item.innerHTML =
        `<span class="${sr?.className ?? 'sr-only'}"><span role="radio" tabindex="-1" aria-checked="false" aria-labelledby="${labelId}" class="${radioCls}"></span></span>` +
        `<span id="${labelId}" class="${label?.className ?? ''}"><span class="${label?.firstElementChild?.getAttribute('class') ?? ''}">${ICON}<span class="truncate">${this.o.label}</span></span></span>` +
        `<span class="${check?.className ?? ''}"></span>`;
      item.querySelector(`#${CSS.escape(labelId)} svg`)?.setAttribute('class', label?.querySelector('svg')?.getAttribute('class') ?? '');
      item.addEventListener('click', () => this.chooseSheetItem(group));
      after.after(item);
    }
    this.syncSheet();
  }

  private sheetSelectedCls: string | null = null;
  private sheetCheck: string | null = null;
  private sheetDemoted: { el: HTMLElement; cls: string; plain: string; checked: string | null; tab: string | null } | null = null;

  /** Like the sidebar: while our section is current, our option is the selected one, not theirs. */
  private syncSheet() {
    for (const group of document.querySelectorAll<HTMLElement>('[role="dialog"] [role="radiogroup"]')) {
      const ours = group.querySelector<HTMLElement>(':scope > [data-orcf][data-option-value]');
      if (!ours) continue;
      const theirs = [...group.querySelectorAll<HTMLElement>(':scope > [data-option-value]:not([data-orcf])')];
      const plain = plainMenuClass(theirs);
      const selected = theirs.find((o) => o.className !== plain);
      if (selected) {
        this.sheetSelectedCls = selected.className;
        this.sheetCheck = selected.lastElementChild?.innerHTML || this.sheetCheck;
      }
      const ourCheck = ours.lastElementChild as HTMLElement | null;
      const ourRadio = ours.querySelector('[role="radio"]');
      if (this.active) {
        if (selected) {
          const r = selected.querySelector('[role="radio"]');
          const prev = this.sheetDemoted;
          if (prev && prev.el !== selected) this.restoreSheet(selected); // their selection moved: un-hide the old check
          const same = prev?.el === selected; // re-rendered as selected: what it was is what we noted first
          this.sheetDemoted = {
            el: selected,
            cls: selected.className,
            plain,
            checked: same ? prev!.checked : (r?.getAttribute('aria-checked') ?? null),
            tab: same ? prev!.tab : (r?.getAttribute('tabindex') ?? null),
          };
          selected.className = plain;
          (selected.lastElementChild as HTMLElement | null)?.style.setProperty('visibility', 'hidden');
          r?.setAttribute('aria-checked', 'false');
          r?.setAttribute('tabindex', '-1');
        }
        const want = this.sheetSelectedCls ?? plain;
        if (ours.className !== want) ours.className = want;
        if (ourCheck && ourCheck.innerHTML !== (this.sheetCheck ?? '')) ourCheck.innerHTML = this.sheetCheck ?? '';
        ourRadio?.setAttribute('aria-checked', 'true');
        ourRadio?.setAttribute('tabindex', '0');
      } else {
        if (ours.className !== plain) ours.className = plain;
        if (ourCheck?.innerHTML) ourCheck.innerHTML = '';
        ourRadio?.setAttribute('aria-checked', 'false');
        ourRadio?.setAttribute('tabindex', '-1');
        this.restoreSheet(selected);
      }
    }
  }

  private restoreSheet(selectedNow?: HTMLElement) {
    const d = this.sheetDemoted;
    this.sheetDemoted = null;
    if (!d || !d.el.isConnected) return;
    (d.el.lastElementChild as HTMLElement | null)?.style.removeProperty('visibility');
    if (d.el.className === d.plain && !selectedNow) d.el.className = d.cls;
    const r = d.el.querySelector('[role="radio"]');
    if (r && !selectedNow) {
      if (d.checked !== null) r.setAttribute('aria-checked', d.checked);
      if (d.tab !== null) r.setAttribute('tabindex', d.tab);
    }
  }

  private chooseSheetItem(group: HTMLElement) {
    // close OpenRouter's sheet the way a reader would, then jump to the section
    const dialog = group.closest('[role="dialog"]');
    const close = dialog?.querySelector<HTMLElement>('[aria-label="Close"]');
    if (close) close.click();
    else dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    setTimeout(() => this.scrollToSection(), 50);
  }

  private chooseMenuItem(menu: HTMLElement) {
    // close OpenRouter's menu the way a user would, then jump to the section
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    setTimeout(() => this.scrollToSection(), 50);
  }

  /**
   * OpenRouter's menu only arrow-navigates the items it registered, so step into and out of ours by hand:
   * ArrowDown from the item before it lands on it, Enter/Space choose it, Up/Down leave it.
   */
  private menuKeys(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null;
    const group = target?.closest?.<HTMLElement>('[role="dialog"] [role="radiogroup"]');
    if (group) return this.sheetKeys(e, group, target!);
    const menu = target?.closest?.<HTMLElement>('[role="menu"]');
    const ours = menu?.querySelector<HTMLElement>('[role="menuitem"][data-orcf]');
    if (!menu || !ours) return;
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const i = items.indexOf(ours);
    const focus = (el: HTMLElement | undefined) => {
      if (!el) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      el.focus();
    };
    if (target === ours) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.chooseMenuItem(menu);
      } else if (e.key === 'ArrowDown') focus(items[i + 1] ?? items[0]);
      else if (e.key === 'ArrowUp') focus(items[i - 1]);
      return;
    }
    if (e.key === 'ArrowDown' && target === items[i - 1]) focus(ours);
    else if (e.key === 'ArrowUp' && target === items[i + 1]) focus(ours);
  }

  /** OpenRouter's sheet moves between its own radios only: step into and out of ours by hand. */
  private sheetKeys(e: KeyboardEvent, group: HTMLElement, target: HTMLElement) {
    const options = [...group.querySelectorAll<HTMLElement>(':scope > [data-option-value]')];
    const ours = options.find((o) => o.hasAttribute('data-orcf'));
    if (!ours) return;
    const i = options.indexOf(ours);
    const radio = (o: HTMLElement | undefined) => o?.querySelector<HTMLElement>('[role="radio"]');
    const focus = (o: HTMLElement | undefined) => {
      const r = radio(o);
      if (!r) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      r.focus();
    };
    if (ours.contains(target)) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.chooseSheetItem(group);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') focus(options[i + 1] ?? options[0]);
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') focus(options[i - 1] ?? options[options.length - 1]);
      return;
    }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowRight') && options[i - 1]?.contains(target)) focus(ours);
    else if ((e.key === 'ArrowUp' || e.key === 'ArrowLeft') && options[i + 1]?.contains(target)) focus(ours);
  }

  dispose() {
    this.setPin(null);
    for (const ev of USER_SCROLL) window.removeEventListener(ev, this.release, true);
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('scroll', this.onScroll);
    window.removeEventListener('scrollend', this.onScrollEnd);
    window.removeEventListener('keydown', this.onKeyDown, true);
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.settleTimer) clearTimeout(this.settleTimer);
    const d = this.demoted;
    if (d && d.el.isConnected && d.el.className === d.asCls) {
      d.el.className = d.cls;
      d.el.setAttribute('aria-current', 'page');
    }
    this.syncTrigger(false);
    this.link?.remove();
    const m = this.menuDemoted;
    this.menuDemoted = null;
    if (m && m.el.isConnected && m.el.className === m.plain) m.el.className = m.cls;
    document.querySelectorAll('[role="menu"] [data-orcf]').forEach((e) => e.remove());
    this.restoreSheet();
    document.querySelectorAll('[role="dialog"] [role="radiogroup"] > [data-orcf]').forEach((e) => e.remove());
  }
}
