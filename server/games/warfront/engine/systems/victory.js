'use strict';

// Warfront engine system: the win check (a base at 0 HP, or the match cap → higher base HP).
// Imports layers 1–6 only. Must NOT contain: scoring/points (shell loop.js). Spec: "Winning".

// ---------------------------------------------------------------------------
// Win check (spec "Battlefield events, weapons, win check")
// ---------------------------------------------------------------------------
/** At the match cap: the team with more base HP wins; equal HP is a draw. */
function winnerByBaseHp(state) {
  const { red, blue } = state.bases;
  if (red.hp > blue.hp) return 'red';
  if (blue.hp > red.hp) return 'blue';
  return 'draw';
}

/**
 * The winner after this step, or null while the match goes on: a base at ≤0 HP
 * loses at once (both in the same step is a draw); at matchEndsAt the higher
 * base HP wins.
 */
function checkWinner(state, now) {
  const redDown = state.bases.red.hp <= 0;
  const blueDown = state.bases.blue.hp <= 0;
  if (redDown && blueDown) return { winner: 'draw', reason: 'base' };
  if (redDown) return { winner: 'blue', reason: 'base' };
  if (blueDown) return { winner: 'red', reason: 'base' };
  if (now >= state.clock.matchEndsAt) return { winner: winnerByBaseHp(state), reason: 'time' };
  return null;
}

module.exports = {
  winnerByBaseHp,
  checkWinner,
};
