import { useEffect, useState } from 'preact/hooks';

export interface Subscribable {
  subscribe(fn: () => void): () => void;
}

/**
 * Re-render when `store` notifies. Also re-renders right after subscribing: a store that already
 * finished (e.g. data cached in memory when the user comes Back) may have notified before this
 * component's effect ran, and that update would otherwise be lost.
 */
export function useStore<T extends Subscribable>(store: T, throttleMs = 0): T {
  const [, force] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bump = () => force((x) => x + 1);
    const onChange = () => {
      if (!throttleMs) return bump();
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        bump();
      }, throttleMs);
    };
    const off = store.subscribe(onChange);
    bump();
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [store]);
  return store;
}

/**
 * State the reader chose in one of our blocks (a grouping, a time window, "Show more") that survives leaving the
 * page and coming back (Back, reload) in this tab, so the block — and the reader's place in it — is as they left it.
 */
export function useStickyState<T extends string | number>(name: string, initial: T, valid: (v: unknown) => v is T): [T, (v: T) => void] {
  const key = `orcf-ui:${location.pathname}:${name}`;
  const [v, setV] = useState<T>(() => {
    try {
      const raw = sessionStorage.getItem(key);
      const parsed = raw === null ? null : JSON.parse(raw);
      return valid(parsed) ? parsed : initial;
    } catch {
      return initial;
    }
  });
  const set = (next: T) => {
    setV(next);
    try {
      sessionStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* storage blocked: it just won't survive a reload */
    }
  };
  return [v, set];
}
