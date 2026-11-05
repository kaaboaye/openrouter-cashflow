// Thin client for OpenRouter's (undocumented) frontend API.
// Requests go through one priority queue so heavy background work never starves
// what the user is currently looking at.

import { dataEpoch } from './days.ts';

const BASE = 'https://openrouter.ai/api/frontend/v1/';
const CONCURRENCY = 8;
/** Background work never takes every slot, so what's on screen can start right away. */
const BACKGROUND_SLOTS = 5;

export type Params = Record<string, string | number | undefined | (string | number)[]>;

export const Priority = {
  background: 0,
  section: 5,
  visible: 10,
} as const;

interface Job {
  prio: number;
  seq: number;
  run: () => void;
}

let seq = 0;
let active = 0;
let activeBackground = 0;
const pending: Job[] = [];

function pump() {
  while (active < CONCURRENCY && pending.length) {
    let best = -1;
    for (let i = 0; i < pending.length; i++) {
      const a = pending[i];
      if (a.prio <= Priority.background && activeBackground >= BACKGROUND_SLOTS) continue;
      const b = best >= 0 ? pending[best] : null;
      if (!b || a.prio > b.prio || (a.prio === b.prio && a.seq < b.seq)) best = i;
    }
    if (best < 0) return;
    const [job] = pending.splice(best, 1);
    active++;
    job.run();
  }
}

function schedule<T>(prio: number, fn: () => Promise<T>): { promise: Promise<T>; job: Job } {
  let job!: Job;
  const promise = new Promise<T>((resolve, reject) => {
    job = {
      prio,
      seq: seq++,
      run: () => {
        const background = job.prio <= Priority.background;
        if (background) activeBackground++;
        fn().then(resolve, reject).finally(() => {
          active--;
          if (background) activeBackground--;
          pump();
        });
      },
    };
  });
  pending.push(job);
  queueMicrotask(pump);
  return { promise, job };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function buildUrl(path: string, params: Params = {}): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((x) => usp.append(k, String(x)));
    else usp.set(k, String(v));
  }
  const qs = usp.toString();
  return BASE + path + (qs ? '?' + qs : '');
}

/**
 * Circuit breaker: once several requests in a row have failed for good (and none succeeded since), the
 * stats are down — stop retrying each request with backoff, so pages can show their error quickly.
 */
let consecutiveFailures = 0;
const BREAKER = 6;

async function fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
  try {
    const res = await fetchWithRetries(url, init, consecutiveFailures >= BREAKER ? 0 : 3);
    consecutiveFailures = 0;
    return res;
  } catch (e) {
    consecutiveFailures++;
    throw e;
  }
}

async function fetchWithRetries(url: string, init: RequestInit | undefined, retries: number): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { credentials: 'omit', ...init });
    } catch (e) {
      // network error (offline, reset connection): retry like a 5xx
      if (attempt < retries) {
        await sleep(600 * 2 ** attempt);
        continue;
      }
      throw e;
    }
    if (res.ok) return res;
    if (attempt < retries && (res.status === 429 || res.status >= 500)) {
      await sleep(600 * 2 ** attempt);
      continue;
    }
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
}

interface InFlight {
  promise: Promise<unknown>;
  job: Job;
}
/** Requests that are queued or running — shared between callers, and boosted when a caller is more urgent. */
const inflight = new Map<string, InFlight>();
/** Completed small responses, kept until OpenRouter's next UTC day of data. */
const memo = new Map<string, { promise: Promise<unknown>; expires: number }>();
let memoEpoch = dataEpoch();
/** Forget memoised responses when the data epoch changes (midnight UTC, end of the settling window). */
function freshMemo() {
  const epoch = dataEpoch();
  if (epoch !== memoEpoch) {
    memo.clear();
    memoEpoch = epoch;
  }
  return memo;
}
function memoGet(url: string): Promise<unknown> | undefined {
  const e = freshMemo().get(url);
  if (e && e.expires > Date.now()) return e.promise;
  if (e) memo.delete(url);
  return undefined;
}

/**
 * GET a frontend API endpoint and return its `data` field.
 * Concurrent identical requests are always shared. Completed responses are memoised for the
 * page session unless `memoize` is false — use that for bulky payloads that get reduced and cached elsewhere.
 */
export function api<T>(path: string, params: Params = {}, opts: { prio?: number; memoize?: boolean } = {}): Promise<T> {
  const url = buildUrl(path, params);
  const prio = opts.prio ?? Priority.section;
  const done = memoGet(url);
  if (done) return done as Promise<T>;
  // A request started in an earlier data epoch (before midnight UTC, or in the settling window after it)
  // may carry older numbers: a caller in a later epoch never joins it.
  const epoch = dataEpoch();
  const key = `${epoch} ${url}`;
  const running = inflight.get(key);
  if (running) {
    if (running.job.prio < prio) running.job.prio = prio;
    return running.promise as Promise<T>;
  }
  const { promise, job } = schedule(prio, async () => {
    const res = await fetchWithRetry(url);
    const body = await res.json();
    return body.data as T;
  });
  inflight.set(key, { promise, job });
  promise.then(
    () => {
      inflight.delete(key);
      // only answers from the current epoch are kept; ones from the settling window only briefly
      if (opts.memoize !== false && epoch === dataEpoch())
        freshMemo().set(url, { promise, expires: epoch.endsWith('~settling') ? Date.now() + 2 * 60 * 1000 : Infinity });
    },
    () => inflight.delete(key),
  );
  return promise;
}

/** Fetch a page's React Server Components payload (used for data that only ships inside RSC, e.g. app pages). */
export function rsc(pathname: string, prio: number = Priority.section): Promise<string> {
  const url = 'https://openrouter.ai' + pathname;
  const key = `rsc:${dataEpoch()} ${url}`;
  const running = inflight.get(key);
  if (running) {
    if (running.job.prio < prio) running.job.prio = prio;
    return running.promise as Promise<string>;
  }
  const { promise, job } = schedule(prio, async () => {
    const res = await fetchWithRetry(url, { headers: { RSC: '1' } });
    return res.text();
  });
  inflight.set(key, { promise, job });
  promise.finally(() => inflight.delete(key)).catch(() => {});
  return promise;
}
