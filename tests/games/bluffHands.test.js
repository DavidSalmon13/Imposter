'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeCalledRanks, calledRanksLabel, areRanksPresent } = require('../../server/games/bluffHands');

test('normalizeCalledRanks: rejects empty, invalid ranks, and more than 4 of one rank', () => {
  assert.equal(normalizeCalledRanks([]), null);
  assert.equal(normalizeCalledRanks(['1', 'K']), null);
  assert.equal(normalizeCalledRanks(['7', '7', '7', '7', '7']), null);
  assert.equal(normalizeCalledRanks('not-an-array'), null);
});

test('normalizeCalledRanks: sorts low to high and allows up to 4 of a rank', () => {
  assert.deepEqual(normalizeCalledRanks(['K', '7', 'A', '2']), ['2', '7', 'K', 'A']);
  assert.deepEqual(normalizeCalledRanks(['7', '7', '7', '7']), ['7', '7', '7', '7']);
});

test('calledRanksLabel: renders T as 10', () => {
  assert.equal(calledRanksLabel(['7', 'T', 'A']), '7 10 A');
});

test('areRanksPresent: counts repeats across every player\'s pooled cards', () => {
  const pooled = ['7h', '7d', 'Kc', '2s'];
  assert.equal(areRanksPresent(['7'], pooled), true);
  assert.equal(areRanksPresent(['7', '7'], pooled), true);
  assert.equal(areRanksPresent(['7', '7', '7'], pooled), false, 'only two 7s are present');
  assert.equal(areRanksPresent(['A'], pooled), false);
});
