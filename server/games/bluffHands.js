'use strict';

/**
 * Pure helpers for Bluff's "are the called cards on the table?" check. The host enters the
 * card values (ranks) that were called - suits are ignored - and we test whether every
 * player's cards pooled together contain them, counting repeats (7, 7, K needs two 7s).
 * Card codes match pokerEval's buildDeck(): rank ('2'..'9', 'T', 'J', 'Q', 'K', 'A') + suit.
 */

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const MAX_CALLED_CARDS = 20;

/** Returns the ranks sorted low->high, or null if the input isn't a valid call. */
function normalizeCalledRanks(ranks) {
  if (!Array.isArray(ranks) || ranks.length === 0 || ranks.length > MAX_CALLED_CARDS) return null;
  const counts = {};
  for (const r of ranks) {
    if (!RANKS.includes(r)) return null;
    counts[r] = (counts[r] || 0) + 1;
    // A deck only has four of each value.
    if (counts[r] > 4) return null;
  }
  return ranks.slice().sort((a, b) => RANKS.indexOf(a) - RANKS.indexOf(b));
}

function calledRanksLabel(ranks) {
  return ranks.map((r) => (r === 'T' ? '10' : r)).join(' ');
}

/** True if `cards` (every player's cards pooled) hold at least the called ranks. */
function areRanksPresent(ranks, cards) {
  const have = {};
  for (const card of cards) {
    const r = card.slice(0, -1);
    have[r] = (have[r] || 0) + 1;
  }
  const need = {};
  for (const r of ranks) need[r] = (need[r] || 0) + 1;
  return Object.keys(need).every((r) => (have[r] || 0) >= need[r]);
}

module.exports = { normalizeCalledRanks, calledRanksLabel, areRanksPresent };
