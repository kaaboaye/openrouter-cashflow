import { useEffect, useState } from 'preact/hooks';
import type { Period } from '../core/days.ts';

// One time window, shared by every island (section, header card, row badges) and kept for the tab across pages and
// reloads, so the figures the reader was looking at come back with the page.
const KEY = 'orcf-ui:period';
const VALID: readonly string[] = ['1d', '7d', '30d'];
let current: Period = (() => {
  try {
    const v = sessionStorage.getItem(KEY);
    return v && VALID.includes(v) ? (v as Period) : '7d';
  } catch {
    return '7d';
  }
})();
const listeners = new Set<() => void>();

export function usePeriod(): [Period, (p: Period) => void] {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((x) => x + 1);
    listeners.add(f);
    return () => void listeners.delete(f);
  }, []);
  return [current, setPeriod];
}

export function setPeriod(p: Period) {
  current = p;
  try {
    sessionStorage.setItem(KEY, p);
  } catch {
    /* storage blocked: it just won't survive a reload */
  }
  listeners.forEach((f) => f());
}

export const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: '1d', label: 'Yesterday' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
];
