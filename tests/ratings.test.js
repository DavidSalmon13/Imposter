'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeRatings } = require('../server/ratings');

test('finishing near the top of a big game rates well even without a win', () => {
  // 8 Bluff games of 7 players, always 2nd: beat 5 of 6 opponents every time.
  const { stats } = computeRatings({ bluff: { played: 8, won: 0, points: 48, placement: 5 / 6 } });
  assert.equal(stats.NRV, 83);
});

test('an average finish sits at the 50 baseline', () => {
  const { stats } = computeRatings({ bluff: { played: 8, won: 1, points: 32, placement: 0.5 } });
  assert.equal(stats.NRV, 50);
});

test('finishing below the middle still lowers the rating', () => {
  const { stats } = computeRatings({ bluff: { played: 8, won: 0, points: 10, placement: 0.1 } });
  assert.equal(stats.NRV, 10);
});

test('few games stay close to the baseline', () => {
  // 2 of 8 games for full confidence: 50 + (99 - 50) * 0.25
  const { stats } = computeRatings({ bluff: { played: 2, won: 2, points: 14, placement: 1 } });
  assert.equal(stats.NRV, 62);
});

test('falls back to win rate when no game had an opponent to compare against', () => {
  const { stats } = computeRatings({ bluff: { played: 8, won: 8, points: 8, placement: null } });
  assert.equal(stats.NRV, 99);
});

test('unplayed stats stay at the baseline', () => {
  const { stats, ovr, tier } = computeRatings({});
  assert.deepEqual(Object.values(stats), [50, 50, 50, 50, 50, 50]);
  assert.equal(ovr, 50);
  assert.equal(tier, 'bronze');
});

test('the temporary overall override applies to Jajuna and June Eiger only, and only until it expires', () => {
  const { applyOvrOverride } = require('../server/ratings');
  const real = computeRatings({ bluff: { played: 8, won: 1, points: 32, placement: 0.5 } });
  const tonight = Date.parse('2026-10-30T20:00:00Z');
  const tomorrow = Date.parse('2026-10-31T04:00:00Z');
  assert.deepEqual(applyOvrOverride(real, 'Jajuna', tonight), { ...real, ovr: 75, tier: 'gold' });
  assert.deepEqual(applyOvrOverride(real, 'june  eiger', tonight), { ...real, ovr: 75, tier: 'gold' });
  assert.deepEqual(applyOvrOverride(real, 'Someone', tonight), real);
  assert.deepEqual(applyOvrOverride(real, 'Jajuna', tomorrow), real);
});
