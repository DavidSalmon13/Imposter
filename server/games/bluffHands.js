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

function rankCounts(cards) {
  const counts = {};
  for (const card of cards) {
    const r = card.slice(0, -1);
    counts[r] = (counts[r] || 0) + 1;
  }
  return counts;
}

/** True if `cards` (every player's cards pooled) hold at least the called ranks. */
function areRanksPresent(ranks, cards) {
  const have = rankCounts(cards);
  const need = {};
  for (const r of ranks) need[r] = (need[r] || 0) + 1;
  return Object.keys(need).every((r) => (have[r] || 0) >= need[r]);
}

/**
 * Per-called-card breakdown: `ranks` is already sorted low->high with same-rank entries
 * adjacent (normalizeCalledRanks), so walking it in order and counting occurrences per rank
 * marks the first `have[r]` of each rank present and any extra over that missing - e.g.
 * calling 7,7,7 against a pool with only two 7s marks the first two present, the third missing.
 */
function calledRanksPresence(ranks, cards) {
  const have = rankCounts(cards);
  const seen = {};
  return ranks.map((r) => {
    seen[r] = (seen[r] || 0) + 1;
    return { rank: r, present: seen[r] <= (have[r] || 0) };
  });
}

const RANK_VALUE = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  T: 10, J: 11, Q: 12, K: 13, A: 14,
};
const RANK_PLURAL = { T: '10s', J: 'Jacks', Q: 'Queens', K: 'Kings', A: 'Aces' };
const RANK_SINGULAR = { T: '10', J: 'Jack', Q: 'Queen', K: 'King', A: 'Ace' };

function rankPlural(r) {
  return RANK_PLURAL[r] || `${r}s`;
}

function rankSingular(r) {
  return RANK_SINGULAR[r] || r;
}

/** Ranks (from `counts`) with at least `min` copies, highest value first. */
function ranksWithAtLeast(counts, min, exclude) {
  return Object.keys(counts)
    .filter((r) => counts[r] >= min && r !== exclude)
    .sort((a, b) => RANK_VALUE[b] - RANK_VALUE[a]);
}

/** Highest-ranked card in `counts` whose rank isn't in `excludeRanks`, or null if none left. */
function highestKicker(counts, excludeRanks) {
  const exclude = new Set(excludeRanks);
  let best = null;
  for (const r of Object.keys(counts)) {
    if (exclude.has(r)) continue;
    if (best === null || RANK_VALUE[r] > RANK_VALUE[best]) best = r;
  }
  return best;
}

function withKicker(label, kicker) {
  return kicker ? `${label} (kicker: ${rankSingular(kicker)})` : label;
}

/**
 * Best hand sitting in a pool of cards, counting ranks only - no flush or straight, since
 * the pool is everyone's cards combined rather than one 5-card hand. Standard strength order:
 * four of a kind > full house > three of a kind (set) > two pair > pair. Every hand but a full
 * house also reports a kicker (the next-highest card not used by the hand), when one exists.
 * Returns null if the pool doesn't even hold a pair.
 */
function strongestHand(cards) {
  const counts = rankCounts(cards);

  const quads = ranksWithAtLeast(counts, 4);
  if (quads.length) {
    const rank = quads[0];
    const kicker = highestKicker(counts, [rank]);
    return {
      type: 'four-of-a-kind',
      ranks: [rank],
      kicker,
      label: withKicker(`Four of a Kind, ${rankPlural(rank)}`, kicker),
    };
  }

  const trips = ranksWithAtLeast(counts, 3);
  if (trips.length) {
    const tripRank = trips[0];
    const pairRank = ranksWithAtLeast(counts, 2, tripRank)[0] || null;
    if (pairRank) {
      return {
        type: 'full-house',
        ranks: [tripRank, pairRank],
        kicker: null,
        label: `Full House, ${rankPlural(tripRank)} full of ${rankPlural(pairRank)}`,
      };
    }
    const kicker = highestKicker(counts, [tripRank]);
    return {
      type: 'three-of-a-kind',
      ranks: [tripRank],
      kicker,
      label: withKicker(`Three of a Kind, ${rankPlural(tripRank)}`, kicker),
    };
  }

  const pairs = ranksWithAtLeast(counts, 2);
  if (pairs.length >= 2) {
    const [high, low] = pairs;
    const kicker = highestKicker(counts, [high, low]);
    return {
      type: 'two-pair',
      ranks: [high, low],
      kicker,
      label: withKicker(`Two Pair, ${rankPlural(high)} and ${rankPlural(low)}`, kicker),
    };
  }
  if (pairs.length === 1) {
    const rank = pairs[0];
    const kicker = highestKicker(counts, [rank]);
    return {
      type: 'pair',
      ranks: [rank],
      kicker,
      label: withKicker(`Pair of ${rankPlural(rank)}`, kicker),
    };
  }

  return null;
}

module.exports = {
  normalizeCalledRanks,
  calledRanksLabel,
  areRanksPresent,
  calledRanksPresence,
  strongestHand,
};
