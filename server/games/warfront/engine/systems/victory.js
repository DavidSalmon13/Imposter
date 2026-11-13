'use strict';

// Warfront engine system: the win check (last side standing, or the match cap → most base HP).
// Imports layers 1–6 only. Must NOT contain: scoring/points (shell loop.js). Spec: "Winning",
// "Free-for-all mode".

// ---------------------------------------------------------------------------
// Win check (spec "Battlefield events, weapons, win check")
// ---------------------------------------------------------------------------
/** At the match cap: the standing side with the most base HP wins; a shared top HP is a draw. */
function winnerByBaseHp(state) {
  const standing = Object.entries(state.bases).filter(([, b]) => b.hp > 0);
  if (!standing.length) return 'draw';
  const top = Math.max(...standing.map(([, b]) => b.hp));
  const best = standing.filter(([, b]) => b.hp === top);
  return best.length === 1 ? best[0][0] : 'draw';
}

/**
 * The winner after this step, or null while the match goes on: a side whose base is at ≤0 HP is
 * down; the last side standing wins at once (every remaining base falling in the same step is a
 * draw). At matchEndsAt the most base HP wins.
 */
function checkWinner(state, now) {
  const standing = Object.keys(state.bases).filter((side) => state.bases[side].hp > 0);
  if (standing.length === 0) return { winner: 'draw', reason: 'base' };
  if (standing.length === 1) return { winner: standing[0], reason: 'base' };
  if (now >= state.clock.matchEndsAt) return { winner: winnerByBaseHp(state), reason: 'time' };
  return null;
}

module.exports = {
  winnerByBaseHp,
  checkWinner,
};
