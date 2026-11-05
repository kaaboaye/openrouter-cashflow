import { cloneElement, render, type VNode } from 'preact';

/** Something a page module mounts into OpenRouter's DOM. */
export interface Controller {
  /** Called (rAF-throttled) on every DOM mutation: (re)place our nodes. Must be idempotent and cheap. */
  tick(): void;
  dispose(): void;
}

/**
 * A node we own with a Preact tree inside. React may re-render the surrounding page and drop it,
 * so controllers call `after()/prepend()` on every tick to put it back.
 */
export class Island {
  readonly el: HTMLElement;
  private vnode: VNode | null = null;

  constructor(opts: { tag?: string; className?: string; id?: string } = {}) {
    this.el = document.createElement(opts.tag ?? 'div');
    this.el.className = opts.className ?? 'orcf';
    if (opts.id) this.el.id = opts.id;
    this.el.setAttribute('data-orcf', '');
  }

  render(vnode: VNode) {
    this.vnode = vnode;
    render(vnode, this.el);
  }

  /** Re-render with the same element (a fresh vnode, so Preact doesn't bail out on identity). */
  rerender() {
    if (this.vnode) render(cloneElement(this.vnode), this.el);
  }

  /** Keep this node right after `anchor`. */
  after(anchor: Element) {
    if (anchor.nextElementSibling !== this.el) anchor.after(this.el);
  }

  /** Keep this node right before `anchor`. */
  before(anchor: Element) {
    if (anchor.previousElementSibling !== this.el) anchor.before(this.el);
  }

  /** Keep this node as the last child of `parent` (alias of appendTo). */
  inside(parent: Element) {
    this.appendTo(parent);
  }

  /** Keep this node as the last child of `parent`. */
  appendTo(parent: Element) {
    if (this.el.parentElement !== parent || parent.lastElementChild !== this.el) parent.appendChild(this.el);
  }

  get mounted() {
    return this.el.isConnected;
  }

  dispose() {
    render(null, this.el);
    this.el.remove();
  }
}

/** One small island per host element (e.g. a badge in every leaderboard row). */
export class IslandSet<K extends Element> {
  private map = new Map<K, Island>();

  constructor(private make: () => Island) {}

  get(host: K): Island {
    let i = this.map.get(host);
    if (!i) {
      i = this.make();
      this.map.set(host, i);
    }
    return i;
  }

  /** Drop islands whose host left the DOM. */
  sweep() {
    for (const [host, i] of this.map) {
      if (!host.isConnected) {
        i.dispose();
        this.map.delete(host);
      }
    }
  }

  forEach(fn: (i: Island, host: K) => void) {
    this.map.forEach(fn);
  }

  dispose() {
    this.map.forEach((i) => i.dispose());
    this.map.clear();
  }
}

export function byText<T extends Element = HTMLElement>(selector: string, text: string | RegExp, root: ParentNode = document): T | null {
  for (const el of root.querySelectorAll<T>(selector)) {
    const t = el.textContent?.trim() ?? '';
    if (typeof text === 'string' ? t === text : text.test(t)) return el;
  }
  return null;
}

/** Raw (still URL-encoded) path of an <a href> on openrouter.ai. */
export function rawPath(a: Element | null): string | null {
  const h = a?.getAttribute('href');
  if (!h) return null;
  try {
    const u = new URL(h, location.origin);
    return u.origin === location.origin ? u.pathname : null;
  } catch {
    return null;
  }
}

/** Path of an <a href> relative to openrouter.ai, without query/hash. */
export function hrefPath(a: Element | null): string | null {
  const h = a?.getAttribute('href');
  if (!h) return null;
  try {
    const u = new URL(h, location.origin);
    if (u.origin !== location.origin) return null;
    return decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
}
