'use strict';

const { Hand } = require('pokersolver');

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];
const SUITS = ['s', 'h', 'd', 'c'];

function buildDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push(rank + suit);
  }
  return deck;
}

function combinations(arr, k) {
  const out = [];
  const n = arr.length;
  if (k > n || k <= 0) return out;
  const idx = Array.from({ length: k }, (_, i) => i);
  for (;;) {
    out.push(idx.map((i) => arr[i]));
    let i = k - 1;
    while (i >= 0 && idx[i] === i + n - k) i -= 1;
    if (i < 0) break;
    idx[i] += 1;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
  return out;
}

/**
 * Best Omaha-style hand: exactly 2 hole cards + exactly 3 board cards.
 * Returns { hand, holeUsed, boardUsed } or null if fewer than 2 hole cards.
 */
function bestOmahaHand(holeCards, boardCards) {
  if (!holeCards || holeCards.length < 2 || !boardCards || boardCards.length !== 5) {
    return null;
  }

  let best = null;
  for (const hole of combinations(holeCards, 2)) {
    for (const board of combinations(boardCards, 3)) {
      const solved = Hand.solve([...hole, ...board]);
      if (!best || solved.compare(best.hand) === -1) {
        best = { hand: solved, holeUsed: hole.slice(), boardUsed: board.slice() };
      }
    }
  }
  return best;
}

/**
 * Rank players on one board. Tied hands all win (split).
 * @returns {{ winners: string[], rankings: Array<{ name: string, descr: string, cards: string[] }> }}
 */
function rankBoard(playersOnBoard) {
  // playersOnBoard: [{ name, holeCards, boardCards }]
  const evaluated = [];
  for (const p of playersOnBoard) {
    const best = bestOmahaHand(p.holeCards, p.boardCards);
    if (!best) continue;
    evaluated.push({
      name: p.name,
      hand: best.hand,
      descr: best.hand.descr,
      cards: best.hand.cards.map((c) => c.toString()),
    });
  }

  if (evaluated.length === 0) {
    return { winners: [], rankings: [] };
  }

  const winnerHands = Hand.winners(evaluated.map((e) => e.hand));
  const winnerSet = new Set(winnerHands);
  const winners = evaluated.filter((e) => winnerSet.has(e.hand)).map((e) => e.name);

  const rankings = evaluated
    .slice()
    .sort((a, b) => a.hand.compare(b.hand))
    .map(({ name, descr, cards }) => ({ name, descr, cards }));

  return { winners, rankings };
}

module.exports = {
  buildDeck,
  combinations,
  bestOmahaHand,
  rankBoard,
};
