'use strict';

// Warfront engine, layer 6b: which tiles a team can see (units, base, held lighthouses).
// Here, not in view.js, because systems (facilities' build rule D4) need it too.
// Must NOT contain: payload shaping (view.js). Spec: "Fog of war", "Lighthouses".

const { WF_VISION, WF_LIGHTHOUSE_VISION, TUNING } = require('./constants');
const { tileId, tileXY } = require('./grid');
const { allUnits } = require('./state');

// ---------------------------------------------------------------------------
// Fog of war + per-viewer view (spec "Fog of war")
// ---------------------------------------------------------------------------
/**
 * Tiles a team can see: Manhattan WF_VISION around its units and its base, plus
 * WF_LIGHTHOUSE_VISION around every lighthouse it controls.
 */
function visionFor(state, team) {
  const { width, height } = state.map;
  const seen = new Set();
  if (!team) return seen;
  const diamond = (src, r) => {
    const { x, y } = tileXY(src, width);
    for (let dy = -r; dy <= r; dy++) {
      const span = r - Math.abs(dy);
      for (let dx = -span; dx <= span; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < width && ny < height) seen.add(tileId(nx, ny, width));
      }
    }
  };
  const sources = new Set([state.bases[team].tileId]);
  for (const { unit, team: t } of allUnits(state)) if (t === team) sources.add(unit.tileId);
  for (const src of sources) diamond(src, WF_VISION);
  // A finished Tower sees further from its height.
  for (const { unit, team: t } of allUnits(state)) {
    if (t === team && unit.type === 'tower' && !unit.buildDoneAt) diamond(unit.tileId, WF_VISION + TUNING.towerVisionBonus);
  }
  for (const l of state.lighthouses || []) if (l.team === team) diamond(l.tileId, WF_LIGHTHOUSE_VISION);
  return seen;
}

/** Every lighthouse and who holds it (static features: everyone sees the owners). */
function lighthouseView(state) {
  return (state.lighthouses || []).map((l) => ({ tileId: l.tileId, team: l.team }));
}

module.exports = {
  visionFor,
  lighthouseView,
};
