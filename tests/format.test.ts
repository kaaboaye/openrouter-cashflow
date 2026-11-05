import { test } from 'node:test';
import assert from 'node:assert/strict';
import { money, pct, perM, tokens } from '../src/core/format.ts';

test('tokens keeps significant zeros in whole numbers', () => {
  assert.equal(tokens(450.1e9), '450B');
  assert.equal(tokens(100e12), '100T');
  assert.equal(tokens(200e6), '200M');
  assert.equal(tokens(45e9), '45B');
  assert.equal(tokens(1.5e12), '1.5T');
  assert.equal(tokens(2.98e12), '2.98T');
  assert.equal(tokens(10.04e9), '10B');
  assert.equal(tokens(999), '999');
});

test('money formats compactly without dropping whole-number zeros', () => {
  assert.equal(money(450_000), '$450K');
  assert.equal(money(100_000_000), '$100M');
  assert.equal(money(6_030_000), '$6.03M');
  assert.equal(money(1_500_000), '$1.5M');
  assert.equal(money(2_000_000), '$2M');
  assert.equal(money(33_900_000), '$33.9M');
  assert.equal(money(1_770_000_000), '$1.77B');
  assert.equal(money(540), '$540');
  assert.equal(money(0.4), '<$1');
  assert.equal(money(0), '$0');
});

test('per-M prices and percents', () => {
  assert.equal(perM(0.6747), '$0.675');
  assert.equal(perM(20), '$20.00');
  assert.equal(pct(0.153), '15.3%');
  assert.equal(pct(0.0004), '<0.1%');
});

test('values that round up move to the next unit', () => {
  assert.equal(money(999_999), '$1M');
  assert.equal(money(999_700_000), '$1B');
  assert.equal(money(999.7), '$1K');
  assert.equal(tokens(999_999_999), '1B');
  assert.equal(tokens(999.6e9), '1T');
});

test('names: empty or odd slugs never become "undefined"', async () => {
  const { prettify, authorName } = await import('../src/core/names.ts');
  assert.equal(prettify(''), '');
  assert.equal(prettify('foo--bar'), 'FOO BAR');
  assert.equal(authorName(''), '');
});
