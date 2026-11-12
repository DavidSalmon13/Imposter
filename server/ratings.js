/**
 * The six-stat rating card (FIFA Ultimate Team-style). Pure function of the `byGame`
 * shape `playerCard()` in server/accounts.js computes ({ [gameType]: { played, won,
 * points, placement, recent } }) - no DB, no HTTP. See docs/specs/account-page-specs.md
 * ("Rating formula") for the design and the reasoning behind each constant.
 *
 * Music Timeline and Mind Meld deliberately contribute to nothing here, per the
 * original ask to ignore them for now.
 */

const STATS = ['SPD', 'COM', 'STR', 'TAC', 'NRV', 'DEC'];

// game -> { STAT: weight }. Primary 1.0, secondary 0.6, tertiary 0.3.
const GAME_STAT_WEIGHTS = {
  tenseconds: { SPD: 1.0, NRV: 0.6 },
  codenames: { COM: 1.0, STR: 0.6 },
  imposter: { DEC: 1.0, COM: 0.6 },
  menifot: { TAC: 1.0, STR: 0.6 },
  allinorfold: { STR: 1.0, NRV: 0.6 },
  bluff: { NRV: 1.0, TAC: 0.6, COM: 0.3 },
};

// Rating of an exactly average player (beats half the table) and of a game type or
// stat with no games behind it yet.
const BASELINE = 60;
// Rating points per unit of placement: 0.5 -> 60, 0.75 -> 80, ~0.88 -> 90, 1 -> 99.
const SLOPE = 80;
const MIN_RATING = 1;
const MAX_RATING = 99;
// Recency: a game this many games ago counts half as much as the latest one, so form
// shows within a handful of games instead of being buried under a lifetime average.
const HALF_LIFE_GAMES = 8;
// Only this many most recent games per type are read (older ones weigh < 2%).
const RECENT_GAMES = 50;
// Shrinkage toward BASELINE for new game types: the score is blended with this many
// "imaginary" average games, so 1 lucky win reads ~70, not 99.
const PRIOR_GAMES = 3;
// A game type's say in the overall grows with games played, up to this cap - the
// games you actually play decide your overall, a one-off try barely moves it.
const OVR_WEIGHT_CAP = 20;

const clamp = (x) => Math.min(MAX_RATING, Math.max(MIN_RATING, x));

/**
 * The per-game scores to rate, newest first, each in [0, 1]. Uses `recent` when the
 * caller has per-game rows; otherwise (older callers/tests) treats the lifetime
 * average as `played` identical games.
 */
function recentScores({ played, won, placement, recent }) {
  if (Array.isArray(recent) && recent.length) return recent.slice(0, RECENT_GAMES);
  const score = placement ?? (played ? won / played : 0.5);
  return Array(Math.min(played, RECENT_GAMES)).fill(score);
}

/**
 * 1-99 performance score for one game type the player has played at least once:
 * recency-weighted placement, shrunk toward the baseline while there are few games,
 * then mapped linearly around BASELINE.
 */
function perf(g) {
  if (!g || !g.played) return null;
  const scores = recentScores(g);
  const decay = Math.pow(0.5, 1 / HALF_LIFE_GAMES);
  let sum = 0;
  let weight = 0;
  scores.forEach((s, i) => {
    const w = Math.pow(decay, i);
    sum += s * w;
    weight += w;
  });
  const placement = sum / weight;
  const raw = BASELINE + (placement - 0.5) * SLOPE;
  const n = scores.length;
  return clamp((raw * n + BASELINE * PRIOR_GAMES) / (n + PRIOR_GAMES));
}

function tierFor(ovr) {
  if (ovr < 65) return 'bronze';
  if (ovr < 75) return 'silver';
  return 'gold';
}

/**
 * byGame: { [gameType]: { played, won, points, placement, recent? } } (points unused).
 * Returns { ovr, tier, stats: { SPD, COM, STR, TAC, NRV, DEC } }, each an integer in
 * [1, 99].
 */
function computeRatings(byGame) {
  const perfByGame = {};
  for (const gameType of Object.keys(GAME_STAT_WEIGHTS)) {
    const p = perf(byGame[gameType]);
    if (p !== null) perfByGame[gameType] = p;
  }

  const stats = {};
  for (const stat of STATS) {
    let weightedSum = 0;
    let weightTotal = 0;
    for (const [gameType, weights] of Object.entries(GAME_STAT_WEIGHTS)) {
      const w = weights[stat];
      if (!w || !(gameType in perfByGame)) continue;
      weightedSum += perfByGame[gameType] * w;
      weightTotal += w;
    }
    stats[stat] = Math.round(weightTotal ? weightedSum / weightTotal : BASELINE);
  }

  // Overall comes from the games played, not the six stats, so stats nobody has fed
  // yet don't drag it to the baseline.
  let ovrSum = 0;
  let ovrWeight = 0;
  for (const [gameType, p] of Object.entries(perfByGame)) {
    const w = Math.min(byGame[gameType].played, OVR_WEIGHT_CAP);
    ovrSum += p * w;
    ovrWeight += w;
  }
  const ovr = Math.round(ovrWeight ? ovrSum / ovrWeight : BASELINE);
  return { ovr, tier: tierFor(ovr), stats };
}

module.exports = { computeRatings, GAME_STAT_WEIGHTS, STATS, BASELINE, RECENT_GAMES };
