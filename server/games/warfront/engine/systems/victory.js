'use strict';

// Warfront engine system: the win check (last side standing, or the match cap → most base HP),
// knock-outs (a fallen side crumbles while the match goes on) and placings. Imports layers 1–6
// only. Must NOT contain: scoring/points (shell loop.js). Spec: "Winning", "Free-for-all mode"
// (Elimination, Winning, Placing and points).

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

// ---------------------------------------------------------------------------
// Knock-outs and placings (spec "Free-for-all mode", plan Step 27)
// ---------------------------------------------------------------------------
/**
 * A knocked-out side crumbles: every unit and building it has is removed (a `death` event each, no
 * Mineral drops), its queues and Workshop work are lost, and the lighthouses it held go neutral
 * (the lamp follows the live state; no `lighthouse` event, which announces a capture).
 */
function crumble(state, side, events) {
  for (const [owner, army] of Object.entries(state.armies)) {
    if (army.team !== side) continue;
    for (const u of army.units) {
      events.push({ type: 'death', tileId: u.tileId, owner, team: side, unitId: u.id, unitType: u.type, crumbled: true });
    }
    army.units = [];
    army.facilities = [];
    army.queues = {};
    army.workshop = [];
  }
  for (const l of state.lighthouses || []) {
    if (l.team === side) l.team = null;
  }
}

/**
 * Sides whose base fell this step get their place: later is better, and sides falling in the same
 * step share it (with `s` sides still in and `m` falling, place s - m + 1, so the last bases falling
 * together share 1st). Each emits `knockedOut { team, place }`. While the match goes on (`over`
 * false) they crumble; when this step ends the match, the final board is left as it stands.
 */
function stepKnockouts(state, events, over) {
  if (!state.placings) state.placings = [];
  const placed = new Set(state.placings.map((p) => p.side));
  const sides = Object.keys(state.bases);
  const fallen = sides.filter((side) => !placed.has(side) && state.bases[side].hp <= 0);
  if (!fallen.length) return;
  const place = sides.length - placed.size - fallen.length + 1;
  for (const side of fallen) {
    state.placings.push({ side, place });
    events.push({ type: 'knockedOut', team: side, place });
    if (!over) crumble(state, side, events);
  }
}

/** When the match ends: the sides still standing are ranked by base HP (equal HP share a place). */
function placeSurvivors(state) {
  if (!state.placings) state.placings = [];
  const standing = Object.keys(state.bases)
    .filter((side) => state.bases[side].hp > 0)
    .sort((a, b) => state.bases[b].hp - state.bases[a].hp);
  standing.forEach((side, i) => {
    const prev = i > 0 && state.bases[standing[i - 1]].hp === state.bases[side].hp;
    const place = prev ? state.placings[state.placings.length - 1].place : i + 1;
    state.placings.push({ side, place });
  });
}

module.exports = {
  winnerByBaseHp,
  checkWinner,
  stepKnockouts,
  placeSurvivors,
};
