/**
 * Badge definitions. Each `check(history)` gets the player's recorded games, oldest
 * first ({ gameType, role, team, won, points, details }), and returns true once the
 * badge is earned. Checks run over the whole history (not just the latest game), so a
 * new badge added here is awarded retroactively the next time someone finishes a game
 * or signs in. Earned badges are stored in the `achievements` table by `id` - never
 * rename an id once shipped. Evaluation lives in server/accounts.js.
 *
 * `sticker` is the badge's picture: a filename from the built-in sticker bank
 * (public/images/stickers). `emoji` is used when there's no sticker or its file is removed.
 */
const { isValidSticker } = require('./stickers');

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
    sticker: '10ba2cfe-a09d-4f29-a686-38f67b1b4691.webp',
    emoji: '🎉',
    name: 'Welcome!',
    description: 'Finish your first game',
    check: (h) => h.length >= 1,
  },
  {
    id: 'general.on_fire',
    sticker: '1a2e4a90-9f0f-49b7-82b9-a53bdea32b32.webp',
    emoji: '🔥',
    name: 'On Fire',
    description: 'Win 3 games in a row',
    check: (h) => longestStreak(h, () => true, (g) => g.won) >= 3,
  },
  {
    id: 'general.all_rounder',
    sticker: 'b4c9322a-e532-43a2-b0b8-3481da2cdcea.webp',
    emoji: '🌈',
    name: 'All-Rounder',
    description: 'Win 5 different games',
    check: (h) => new Set(h.filter((g) => g.won).map((g) => g.gameType)).size >= 5,
  },
  {
    id: 'general.regular',
    sticker: '8529cc18-3469-4d6a-851d-547a7dba2225.webp',
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
    sticker: 'a549c348-9f51-4538-9cda-b1c0170946cc.webp',
    emoji: '👻',
    name: 'Ghost',
    description: 'Survive 3 imposter rounds in a row',
    check: (h) => longestStreak(h, isImposterRound, (g) => g.won) >= 3,
  },
  {
    id: 'imposter.lie_detector',
    sticker: '5a2df0c7-17fa-40e7-ae98-c59cf858d32b.webp',
    emoji: '🔍',
    name: 'Human Lie Detector',
    description: 'Survive 10 Imposter rounds as crew',
    check: (h) => count(h, (g) => g.gameType === 'imposter' && g.role === 'crew' && g.won) >= 10,
  },

  // Codenames
  {
    id: 'codenames.spymaster',
    sticker: 'd3b78bcb-128e-40fe-8273-a59640daa549.webp',
    emoji: '🎯',
    name: 'Spymaster Supreme',
    description: 'Win 3 Codenames games as spymaster',
    check: (h) => count(h, (g) => g.gameType === 'codenames' && g.role === 'spymaster' && g.won) >= 3,
  },

  // One "win it once" badge per remaining game
  { id: 'tenseconds.champion', sticker: 'ff6eca8a-9135-4b94-85e9-04ab02f464e6.webp', emoji: '⏱️', name: 'Clutch', description: 'Win a game of 10 Seconds', check: wonGame('tenseconds') },
  { id: 'menifot.winner', sticker: '3741e064-dd40-47bf-88b6-64bf96a87f79.webp', emoji: '🃏', name: 'Card Shark', description: 'Win a Menifot match', check: wonGame('menifot') },
  { id: 'musictimeline.winner', sticker: '8cf3f7e0-d1c7-486e-9cbc-e53d56ee3edd.webp', emoji: '🎵', name: 'DJ', description: 'Win a Music Timeline match', check: wonGame('musictimeline') },
  { id: 'mindmeld.winner', sticker: '65e3b128-db99-4452-bc02-45d7d1602674.webp', emoji: '🧠', name: 'Telepath', description: 'Win a Mind Meld match', check: wonGame('mindmeld') },
  { id: 'bluff.winner', sticker: '2ac82037-877a-401b-8f83-8974df8efae4.webp', emoji: '😐', name: 'Poker Face', description: 'Win a Bluff match', check: wonGame('bluff') },
  {
    id: 'allinorfold.high_roller',
    sticker: 'machine-smelly.webp',
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
  return {
    id: b.id,
    emoji: b.emoji,
    sticker: isValidSticker(b.sticker) ? b.sticker : null,
    name: b.name,
    description: b.description,
  };
}

for (const b of BADGES) {
  if (b.sticker && !isValidSticker(b.sticker)) console.warn(`Badge ${b.id}: sticker ${b.sticker} not found, using its emoji`);
}

module.exports = { BADGES, publicBadge };
