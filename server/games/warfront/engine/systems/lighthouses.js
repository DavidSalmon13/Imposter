'use strict';

// Warfront engine system: lighthouse capture each step. Vision from held lighthouses is vision.js.
// Imports layers 1–6 only. Spec: "Lighthouses" (D15).

const { allUnits } = require('../state');

/**
 * Lighthouse capture (D15): a lighthouse flips to a team the moment only that
 * team's units stand on it. Both teams or nobody: it keeps its owner. Runs after
 * movement and combat, so the dead don't hold it.
 */
function stepLighthouses(state, events) {
  if (!state.lighthouses || !state.lighthouses.length) return;
  const present = new Map(); // tileId -> Set(team)
  for (const { unit, team } of allUnits(state)) {
    if (unit.hp <= 0) continue;
    if (!present.has(unit.tileId)) present.set(unit.tileId, new Set());
    present.get(unit.tileId).add(team);
  }
  for (const l of state.lighthouses) {
    const teams = present.get(l.tileId);
    if (!teams || teams.size !== 1) continue;
    const [team] = teams;
    if (l.team === team) continue;
    l.team = team;
    events.push({ type: 'lighthouse', tileId: l.tileId, team });
  }
}

module.exports = {
  stepLighthouses,
};
