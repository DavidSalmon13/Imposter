/**
 * Badge definitions. Each `check(history)` gets the player's recorded games, oldest
 * first ({ gameType, role, team, won, points, details }), and returns true once the
 * badge is earned. Checks run over the whole history (not just the latest game), so a
 * new badge added here is awarded retroactively the next time someone finishes a game
 * or signs in. Earned badges are stored in the `achievements` table by `id` - never
 * rename an id once shipped. Evaluation lives in server/accounts.js.
 */

const count = (history, pred) => history.filter(pred).length;

/** Longest run of consecutive `pred` matches within the games matching `filter`. */
function longestStreak(history, filter, pred) {
  let best = 0;
  let run = 0;
  for (const g of history) {
    if (!filter(g)) continue;
    run = pred(g) ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

const isImposterRound = (g) => g.gameType === 'imposter' && g.role === 'imposter';
const wonGame = (type) => (h) => h.some((g) => g.gameType === type && g.won);

const BADGES = [
  // General
  {
    id: 'general.first_game',
    emoji: '🎉',
    name: 'Welcome!',
    description: 'Finish your first game',
    check: (h) => h.length >= 1,
  },
  {
    id: 'general.on_fire',
    emoji: '🔥',
    name: 'On Fire',
    description: 'Win 3 games in a row',
    check: (h) => longestStreak(h, () => true, (g) => g.won) >= 3,
  },
  {
    id: 'general.all_rounder',
    emoji: '🌈',
    name: 'All-Rounder',
    description: 'Win 5 different games',
    check: (h) => new Set(h.filter((g) => g.won).map((g) => g.gameType)).size >= 5,
  },
  {
    id: 'general.regular',
    emoji: '🏠',
    name: 'Regular',
    description: 'Play 50 games',
    check: (h) => h.length >= 50,
  },

  // Imposter
  {
    id: 'imposter.undetected',
    emoji: '🕵️',
    name: 'Undetected',
    description: 'Survive a round as the imposter',
    check: (h) => h.some((g) => isImposterRound(g) && g.won),
  },
  {
    id: 'imposter.ghost',
    emoji: '👻',
    name: 'Ghost',
    description: 'Survive 3 imposter rounds in a row',
    check: (h) => longestStreak(h, isImposterRound, (g) => g.won) >= 3,
  },
  {
    id: 'imposter.lie_detector',
    emoji: '🔍',
    name: 'Human Lie Detector',
    description: 'Survive 10 Imposter rounds as crew',
    check: (h) => count(h, (g) => g.gameType === 'imposter' && g.role === 'crew' && g.won) >= 10,
  },

  // Codenames
  {
    id: 'codenames.spymaster',
    emoji: '🎯',
    name: 'Spymaster Supreme',
    description: 'Win 3 Codenames games as spymaster',
    check: (h) => count(h, (g) => g.gameType === 'codenames' && g.role === 'spymaster' && g.won) >= 3,
  },

  // One "win it once" badge per remaining game
  { id: 'tenseconds.champion', emoji: '⏱️', name: 'Clutch', description: 'Win a game of 10 Seconds', check: wonGame('tenseconds') },
  { id: 'menifot.winner', emoji: '🃏', name: 'Card Shark', description: 'Win a Menifot match', check: wonGame('menifot') },
  { id: 'musictimeline.winner', emoji: '🎵', name: 'DJ', description: 'Win a Music Timeline match', check: wonGame('musictimeline') },
  { id: 'mindmeld.winner', emoji: '🧠', name: 'Telepath', description: 'Win a Mind Meld match', check: wonGame('mindmeld') },
  { id: 'bluff.winner', emoji: '😐', name: 'Poker Face', description: 'Win a Bluff match', check: wonGame('bluff') },
  {
    id: 'allinorfold.high_roller',
    emoji: '🎰',
    name: 'High Roller',
    description: 'Double your money in All-In or Fold',
    check: (h) =>
      h.some(
        (g) =>
          g.gameType === 'allinorfold' &&
          g.details.totalBoughtIn > 0 &&
          g.details.netProfit >= g.details.totalBoughtIn
      ),
  },
];

/** Badge info safe to send to clients (no check functions). */
function publicBadge(b) {
  return { id: b.id, emoji: b.emoji, name: b.name, description: b.description };
}

module.exports = { BADGES, publicBadge };
