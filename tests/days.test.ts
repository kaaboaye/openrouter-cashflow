import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dataEpoch } from '../src/core/days.ts';

test('the data epoch changes at midnight UTC and again once the settling window is over', () => {
  assert.equal(dataEpoch(new Date('2026-01-01T23:59:00Z')), '2025-12-31');
  assert.equal(dataEpoch(new Date('2026-01-02T00:05:00Z')), '2026-01-01~settling');
  assert.equal(dataEpoch(new Date('2026-01-02T00:45:00Z')), '2026-01-01');
});
