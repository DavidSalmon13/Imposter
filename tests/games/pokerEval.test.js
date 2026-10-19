'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildDeck, rankBoard, computeEquities, bestOmahaHand } = require('../../server/games/pokerEval');

test('buildDeck: 52 unique cards', () => {
  const deck = buildDeck();
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck).size, 52);
});

test('bestOmahaHand: picks exactly 2 hole + 3 board cards for the best hand', () => {
  // Hole: Ah Kh; board: Qh Jh Th 9h 2h -> royal flush using Ah Kh + Qh Jh Th.
  const best = bestOmahaHand(['Ah', 'Kh'], ['Qh', 'Jh', 'Th', '9h', '2h']);
  assert.equal(best.hand.descr, 'Royal Flush');
  assert.equal(best.holeUsed.length, 2);
  assert.equal(best.boardUsed.length, 3);
});

test('rankBoard: higher hand wins outright (no split)', () => {
  const playersOnBoard = [
    { name: 'Ann', holeCards: ['Ah', 'Kh'], boardCards: ['Qh', 'Jh', 'Th', '9h', '2h'] },
    { name: 'Bob', holeCards: ['2c', '3d'], boardCards: ['Qh', 'Jh', 'Th', '9h', '2h'] },
  ];
  const { winners, rankings } = rankBoard(playersOnBoard);
  assert.deepEqual(winners, ['Ann']);
  assert.equal(rankings.length, 2);
});

test('rankBoard: identical best hands split the pot', () => {
  // Both players can only use the board's own straight - ties exactly.
  const playersOnBoard = [
    { name: 'Ann', holeCards: ['2c', '3c'], boardCards: ['4h', '5h', '6h', '7h', '8h'] },
    { name: 'Bob', holeCards: ['2d', '3d'], boardCards: ['4h', '5h', '6h', '7h', '8h'] },
  ];
  const { winners } = rankBoard(playersOnBoard);
  assert.deepEqual(new Set(winners), new Set(['Ann', 'Bob']));
});

test('rankBoard: a player with fewer than 2 hole cards is excluded', () => {
  const playersOnBoard = [
    { name: 'Ann', holeCards: ['Ah'], boardCards: ['Qh', 'Jh', 'Th', '9h', '2h'] },
    { name: 'Bob', holeCards: ['2c', '3d'], boardCards: ['Qh', 'Jh', 'Th', '9h', '2h'] },
  ];
  const { winners, rankings } = rankBoard(playersOnBoard);
  assert.deepEqual(winners, ['Bob']);
  assert.equal(rankings.length, 1);
});

test('computeEquities: a complete 5-card board is exact, not sampled', () => {
  const equities = computeEquities({
    liveHoleCards: { Ann: ['Ah', 'Kh'], Bob: ['2c', '3d'] },
    boardCards: ['Qh', 'Jh', 'Th', '9h', '2h'],
    sampleSize: 20,
  });
  assert.equal(equities.Ann, 100);
  assert.equal(equities.Bob, 0);
});

test('computeEquities: identical hole cards on an empty board split evenly', () => {
  const equities = computeEquities({
    liveHoleCards: { Ann: ['Ah', 'Kh'], Bob: ['Ad', 'Kd'] },
    boardCards: [],
    sampleSize: 50,
  });
  assert.ok(Math.abs(equities.Ann - equities.Bob) < 5, 'should be roughly even');
  assert.ok(equities.Ann > 40 && equities.Ann < 60);
});
