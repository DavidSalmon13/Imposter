'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeCalledRanks,
  calledRanksLabel,
  areRanksPresent,
  calledRanksPresence,
  strongestHand,
} = require('../../server/games/bluffHands');

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

test('calledRanksPresence: marks each called card present or missing individually', () => {
  const pooled = ['7h', '7d', '2s', '3c'];
  assert.deepEqual(calledRanksPresence(['7', '7', 'K'], pooled), [
    { rank: '7', present: true },
    { rank: '7', present: true },
    { rank: 'K', present: false },
  ]);
  assert.deepEqual(calledRanksPresence(['7', '7', '7'], pooled), [
    { rank: '7', present: true },
    { rank: '7', present: true },
    { rank: '7', present: false },
  ]);
});

test('strongestHand: finds a pair with a kicker', () => {
  const hand = strongestHand(['7h', '7d', 'Kc', '2s']);
  assert.equal(hand.type, 'pair');
  assert.deepEqual(hand.ranks, ['7']);
  assert.equal(hand.kicker, 'K');
  assert.equal(hand.label, 'Pair of 7s (kicker: King)');
});

test('strongestHand: two pair reports both ranks, higher first, plus a kicker', () => {
  const hand = strongestHand(['7h', '7d', 'Kc', 'Kd', '2s']);
  assert.equal(hand.type, 'two-pair');
  assert.deepEqual(hand.ranks, ['K', '7']);
  assert.equal(hand.kicker, '2');
  assert.equal(hand.label, 'Two Pair, Kings and 7s (kicker: 2)');
});

test('strongestHand: three of a kind (set) with a kicker', () => {
  const hand = strongestHand(['7h', '7d', '7c', 'Kc', '2s']);
  assert.equal(hand.type, 'three-of-a-kind');
  assert.deepEqual(hand.ranks, ['7']);
  assert.equal(hand.kicker, 'K');
  assert.equal(hand.label, 'Three of a Kind, 7s (kicker: King)');
});

test('strongestHand: full house has no kicker', () => {
  const hand = strongestHand(['7h', '7d', '7c', 'Kc', 'Kd']);
  assert.equal(hand.type, 'full-house');
  assert.deepEqual(hand.ranks, ['7', 'K']);
  assert.equal(hand.kicker, null);
  assert.equal(hand.label, 'Full House, 7s full of Kings');
});

test('strongestHand: four of a kind beats a full house, with a kicker', () => {
  const hand = strongestHand(['7h', '7d', '7c', '7s', 'Kc']);
  assert.equal(hand.type, 'four-of-a-kind');
  assert.deepEqual(hand.ranks, ['7']);
  assert.equal(hand.kicker, 'K');
  assert.equal(hand.label, 'Four of a Kind, 7s (kicker: King)');
});

test('strongestHand: null when the pool holds no pair', () => {
  assert.equal(strongestHand(['7h', 'Kc', '2s']), null);
});
