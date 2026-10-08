'use strict';

/**
 * Pure helpers for Bluff's "is the called hand on the table?" check: validate a hand the
 * host entered, label it, and test it against every player's cards pooled together.
 * Card codes match pokerEval's buildDeck(): rank ('2'..'9', 'T', 'J', 'Q', 'K', 'A') + suit.
 */

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS = ['s', 'h', 'd', 'c'];
const SUIT_NAMES = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' };

// Which fields each hand type needs: rank, rank2 (a second, different rank), suit.
// Straights are named by their top card, so the lowest is 5 (A-2-3-4-5).
const HAND_TYPES = {
  high: { rank: true },
  pair: { rank: true },
  twopair: { rank: true, rank2: true },
  trips: { rank: true },
  straight: { rank: true, straight: true },
  flush: { suit: true },
  fullhouse: { rank: true, rank2: true },
  quads: { rank: true },
  straightflush: { rank: true, suit: true, straight: true },
};

function rankName(r) {
  return r === 'T' ? '10' : r;
}

/** The five ranks of the straight topped by `high` (A plays low under a 5). */
function straightRanks(high) {
  if (high === '5') return ['A', '2', '3', '4', '5'];
  const i = RANKS.indexOf(high);
  return RANKS.slice(i - 4, i + 1);
}

/** Returns a clean { type, rank?, rank2?, suit? } or null if the input isn't a valid hand. */
function normalizeHand(data) {
  if (!data || typeof data !== 'object') return null;
  const spec = HAND_TYPES[data.type];
  if (!spec) return null;
  const hand = { type: data.type };
  if (spec.rank) {
    if (!RANKS.includes(data.rank)) return null;
    if (spec.straight && RANKS.indexOf(data.rank) < RANKS.indexOf('5')) return null;
    hand.rank = data.rank;
  }
  if (spec.rank2) {
    if (!RANKS.includes(data.rank2) || data.rank2 === data.rank) return null;
    hand.rank2 = data.rank2;
  }
  if (spec.suit) {
    if (!SUITS.includes(data.suit)) return null;
    hand.suit = data.suit;
  }
  return hand;
}

function handLabel(hand) {
  const r = rankName(hand.rank);
  const r2 = rankName(hand.rank2);
  switch (hand.type) {
    case 'high': return `High card ${r}`;
    case 'pair': return `Pair of ${r}s`;
    case 'twopair': return `Two pair: ${r}s and ${r2}s`;
    case 'trips': return `Three ${r}s`;
    case 'straight': return `Straight to ${r}`;
    case 'flush': return `Flush in ${SUIT_NAMES[hand.suit]}`;
    case 'fullhouse': return `Full house: ${r}s over ${r2}s`;
    case 'quads': return `Four ${r}s`;
    case 'straightflush': return `Straight flush to ${r} in ${SUIT_NAMES[hand.suit]}`;
    default: return 'Unknown hand';
  }
}

/** True if `hand` can be made from `cards` (every player's cards pooled together). */
function isHandPresent(hand, cards) {
  const rankCount = {};
  const suitCount = {};
  const has = new Set(cards);
  for (const card of cards) {
    const r = card.slice(0, -1);
    const s = card.slice(-1);
    rankCount[r] = (rankCount[r] || 0) + 1;
    suitCount[s] = (suitCount[s] || 0) + 1;
  }
  const rc = (r) => rankCount[r] || 0;

  switch (hand.type) {
    case 'high': return rc(hand.rank) >= 1;
    case 'pair': return rc(hand.rank) >= 2;
    case 'twopair': return rc(hand.rank) >= 2 && rc(hand.rank2) >= 2;
    case 'trips': return rc(hand.rank) >= 3;
    case 'straight': return straightRanks(hand.rank).every((r) => rc(r) >= 1);
    case 'flush': return (suitCount[hand.suit] || 0) >= 5;
    case 'fullhouse': return rc(hand.rank) >= 3 && rc(hand.rank2) >= 2;
    case 'quads': return rc(hand.rank) >= 4;
    case 'straightflush': return straightRanks(hand.rank).every((r) => has.has(r + hand.suit));
    default: return false;
  }
}

module.exports = { normalizeHand, handLabel, isHandPresent };
