// Small persistent cache. OpenRouter's usage data only changes once per UTC day, so anything we
// derive is keyed to the last complete day and kept for a few hours. This is invisible to the user;
// it just makes revisits instant and keeps request volume polite.

import { dataEpoch } from './days.ts';

const VERSION = 'v7';
const TTL_MS = 6 * 60 * 60 * 1000;

interface Entry<T> {
  v: T;
  /** the data epoch (see dataEpoch) the value was requested in */
  day: string;
  t: number;
  ttl?: number;
}



const mem = new Map<string, Entry<unknown>>();

const storage: chrome.storage.LocalStorageArea | null =
  typeof chrome !== 'undefined' && chrome.storage?.local ? chrome.storage.local : null;

// An entry is only good for the epoch it was requested in: a new UTC day, and also the end of the
// post-midnight settling window, make everything fetched before it stale.
function fresh(e: Entry<unknown> | undefined): boolean {
  return !!e && e.day === dataEpoch() && Date.now() - e.t < (e.ttl ?? TTL_MS);
}

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  const k = `${VERSION}:${key}`;
  const m = mem.get(k);
  if (fresh(m)) return m!.v as T;
  if (!storage) return undefined;
  try {
    const got = await storage.get(k);
    const e = got[k] as Entry<T> | undefined;
    if (fresh(e)) {
      mem.set(k, e!);
      return e!.v;
    }
  } catch {
    /* storage unavailable (e.g. extension reloaded) */
  }
  return undefined;
}

/**
 * `epoch` is the data epoch the value was requested in; data that crossed an epoch boundary in flight (midnight
 * UTC, or the end of the settling window) is not stored. Data from the settling window after midnight UTC
 * (OpenRouter's CDN may still serve the previous day) is kept in memory for two minutes only and never persisted.
 */
export function cacheSet<T>(key: string, v: T, epoch = dataEpoch()): void {
  if (epoch !== dataEpoch()) return;
  const k = `${VERSION}:${key}`;
  const settling = epoch.endsWith('~settling');
  const e: Entry<T> = { v, day: epoch, t: Date.now(), ttl: settling ? 2 * 60 * 1000 : TTL_MS };
  mem.set(k, e);
  if (!settling) storage?.set({ [k]: e }).catch(() => {});
}

/** Drop entries from previous days so storage doesn't grow forever. */
export async function cachePrune(): Promise<void> {
  if (!storage) return;
  try {
    const all = await storage.get(null);
    const stale = Object.entries(all)
      .filter(([k, e]) => !k.startsWith(`${VERSION}:`) || !fresh(e as Entry<unknown>))
      .map(([k]) => k);
    if (stale.length) await storage.remove(stale);
  } catch {
    /* ignore */
  }
}

/**
 * Read-through cache for an async loader. Concurrent misses each call `load()`; the API layer
 * shares the underlying requests (and raises their priority if a later caller is more urgent).
 */
export async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const epoch = dataEpoch();
  const hit = await cacheGet<T>(key);
  if (hit !== undefined) return hit;
  const v = await load();
  cacheSet(key, v, epoch);
  return v;
}
