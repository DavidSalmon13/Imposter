/**
 * The six-stat rating card (FIFA Ultimate Team-style). Pure function of the `byGame`
 * shape `playerCard()` in server/accounts.js already computes ({ [gameType]: { played,
 * won, points, placement } }) - no DB, no HTTP. See specs/account-page-specs.md for the design.
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

const CONFIDENCE_GAMES = 8;
const BASELINE = 50;
const MAX_RATING = 99;

/**
 * 0-99 performance score for one game type the player has played at least once.
 * `placement` is the average share of opponents finished ahead of (ties count half,
 * 0 = always last, 1 = always first; see playerCard()), so finishing 2nd of 7 counts
 * for a lot even though only the winner has `won`. Falls back to win rate when no
 * game had an opponent to compare against.
 */
function perf({ played, won, placement }) {
  if (!played) return null;
  const score = placement ?? won / played;
  const confidence = Math.min(1, played / CONFIDENCE_GAMES);
  const raw = score * MAX_RATING;
  return BASELINE + (raw - BASELINE) * confidence;
}

function tierFor(ovr) {
  if (ovr < 65) return 'bronze';
  if (ovr < 75) return 'silver';
  return 'gold';
}

/**
 * byGame: { [gameType]: { played, won, points, placement } } (points unused here).
 * Returns { ovr, tier, stats: { SPD, COM, STR, TAC, NRV, DEC } }, each stat and ovr
 * rounded to an integer in [0, 99].
 */
function computeRatings(byGame) {
  const perfByGame = {};
  for (const [gameType, weights] of Object.entries(GAME_STAT_WEIGHTS)) {
    const g = byGame[gameType];
    if (g && g.played) perfByGame[gameType] = perf(g);
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

  const ovr = Math.round(STATS.reduce((sum, s) => sum + stats[s], 0) / STATS.length);
  return { ovr, tier: tierFor(ovr), stats };
}

// Temporary: a fixed overall for a few players until UNTIL, then real ratings come back on
// their own (the lobby's cached rating refreshes on the next join/return to lobby). Only
// ovr and tier change - the six stats stay real. Matched by display name, case-insensitive.
// Delete this block once it has expired.
const OVR_OVERRIDE = { names: ['jajuna', 'june eiger'], ovr: 75, until: Date.parse('2026-10-31T04:00:00Z') }; // 06:00 Israel time

function overrideActive(now = Date.now()) {
  return now < OVR_OVERRIDE.until;
}

function applyOvrOverride(ratings, displayName, now = Date.now()) {
  if (!overrideActive(now) || !OVR_OVERRIDE.names.includes(String(displayName || '').trim().toLowerCase().replace(/\s+/g, ' '))) {
    return ratings;
  }
  return { ...ratings, ovr: OVR_OVERRIDE.ovr, tier: tierFor(OVR_OVERRIDE.ovr) };
}

module.exports = { computeRatings, GAME_STAT_WEIGHTS, STATS, overrideActive, applyOvrOverride };
