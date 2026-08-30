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
 * @returns {{ winners: string[], rankings: Array<{ name: string, descr: string, holeUsed: string[], boardUsed: string[] }> }}
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
      holeUsed: best.holeUsed,
      boardUsed: best.boardUsed,
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
    .map(({ name, descr, holeUsed, boardUsed }) => ({ name, descr, holeUsed, boardUsed }));

  return { winners, rankings };
}

function nChooseK(n, k) {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return Math.round(result);
}

function randomCompletions(deck, needed, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const pool = deck.slice();
    const picked = [];
    for (let k = 0; k < needed; k++) {
      const idx = Math.floor(Math.random() * pool.length);
      picked.push(pool[idx]);
      pool.splice(idx, 1);
    }
    out.push(picked);
  }
  return out;
}

/**
 * Win/tie equity for each live player, given known hole cards, the currently-revealed
 * board, and `deadCards` (already dealt but ineligible to reappear as a board card — e.g.
 * folded players' hole cards). If the true number of ways to complete the board is at most
 * `sampleSize`, every one is enumerated (exact); otherwise `sampleSize` random completions
 * are sampled instead (Monte Carlo). A tied showdown splits a "win" evenly among the tied
 * names for that trial. Returns { name: percentage (0-100) } for every name in
 * `liveHoleCards`.
 */
function computeEquities({ liveHoleCards, boardCards, deadCards = [], sampleSize }) {
  const names = Object.keys(liveHoleCards);
  const tally = {};
  names.forEach((name) => {
    tally[name] = 0;
  });
  if (names.length === 0) return tally;

  const needed = 5 - boardCards.length;
  if (needed === 0) {
    const { winners } = rankBoard(names.map((name) => ({ name, holeCards: liveHoleCards[name], boardCards })));
    const share = winners.length ? 100 / winners.length : 0;
    winners.forEach((name) => {
      tally[name] = share;
    });
    return tally;
  }

  const usedCards = new Set([
    ...boardCards,
    ...deadCards,
    ...names.flatMap((name) => liveHoleCards[name]),
  ]);
  const deck = buildDeck().filter((card) => !usedCards.has(card));

  // Checks the theoretical combo count (O(1)) before ever materializing it — enumerating
  // e.g. C(40,5) = 658,008 five-card combinations just to measure `.length` would itself be
  // slower than the sampled path it's supposed to be avoiding.
  const totalCombos = nChooseK(deck.length, needed);
  const trials = totalCombos <= sampleSize ? combinations(deck, needed) : randomCompletions(deck, needed, sampleSize);

  trials.forEach((completion) => {
    const fullBoard = boardCards.concat(completion);
    const { winners } = rankBoard(
      names.map((name) => ({ name, holeCards: liveHoleCards[name], boardCards: fullBoard }))
    );
    const share = winners.length ? 100 / winners.length : 0;
    winners.forEach((name) => {
      tally[name] += share;
    });
  });

  const totalTrials = trials.length || 1;
  names.forEach((name) => {
    tally[name] = tally[name] / totalTrials;
  });
  return tally;
}

module.exports = {
  buildDeck,
  combinations,
  bestOmahaHand,
  rankBoard,
  computeEquities,
};
