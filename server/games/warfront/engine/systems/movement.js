'use strict';

// Warfront engine system: move orders, heading a unit somewhere, stepping units along paths and
// collecting pickups on arrival. Imports layers 1–6 only (base system: other systems may use it).
// Must NOT contain: combat, hauling rules. Spec: "Movement".

const { findPath, pathCost } = require('../pathing');
const { allUnits, stepMs } = require('../state');

/**
 * Sends one unit toward `to`. A unit already mid-step finishes that step first
 * (its next tile is kept and the new path continues from there), so a re-issued
 * order never snaps a unit backwards. Returns false when there's nowhere to go.
 */
function orderMove(state, unit, to, now) {
  const { map } = state;
  // Mid-step (or a finished step the next sim step hasn't applied yet): keep it.
  if (unit.path.length) {
    const next = unit.path[0];
    const rest = next === to ? [] : findPath(map, next, to);
    if (next !== to && !rest.length) return false;
    unit.path = [next, ...rest];
  } else {
    const path = findPath(map, unit.tileId, to);
    if (!path.length) return false;
    unit.path = path;
    unit.stepStartedAt = now;
    unit.stepEndsAt = now + stepMs(map, unit.type, path[0]);
  }
  unit.haul = null;
  unit.holding = false;
  return true;
}

/** Points a hauler at `to` without dropping its haul loop (orderMove clears it). */
function headFor(state, army, u, to, now) {
  const haul = u.haul;
  if (u.tileId !== to || u.path.length) orderMove(state, u, to, now);
  u.haul = haul;
  u.holding = false;
}

/** Of `tiles`, the one with the quickest walk from where `u` stands (or is stepping to); ties keep list order. */
function nearestTile(state, u, tiles) {
  const from = u.path.length ? u.path[0] : u.tileId;
  let best = tiles[0];
  let bestLen = Infinity;
  for (const t of tiles) {
    const len = t === from ? 0 : pathCost(state.map, findPath(state.map, from, t)) || Infinity;
    if (len < bestLen) {
      best = t;
      bestLen = len;
    }
  }
  return best;
}

/** Collects whatever lies on the tile a unit just walked onto. */
function arriveAt(state, owner, unit, events) {
  const army = state.armies[owner];
  const { pickups } = state;
  const wi = pickups.weapons.findIndex((w) => w.tileId === unit.tileId);
  if (wi >= 0) {
    const [w] = pickups.weapons.splice(wi, 1);
    army.arsenal.push(w.weaponId);
    events.push({ type: 'pickup', tileId: unit.tileId, owner, team: army.team, weaponId: w.weaponId });
  }
  const drop = pickups.mineralDrops[unit.tileId];
  if (drop) {
    delete pickups.mineralDrops[unit.tileId];
    army.minerals += drop;
    events.push({ type: 'pickup', tileId: unit.tileId, owner, team: army.team, minerals: drop });
  }
}

/**
 * Walks every unit with a path through each step that finishes by `now`. A
 * new step starts when the last one ended, but never earlier than this sim
 * step began (`now - dtMs`), so a stalled loop or a restart can't fast-forward
 * a unit through a long backlog of steps.
 */
function stepMovement(state, dtMs, now, events) {
  const floor = now - dtMs;
  for (const { unit, owner } of allUnits(state)) {
    while (unit.path.length && unit.stepEndsAt <= now) {
      unit.tileId = unit.path.shift();
      arriveAt(state, owner, unit, events);
      if (unit.path.length) {
        unit.stepStartedAt = Math.max(unit.stepEndsAt, floor);
        unit.stepEndsAt = unit.stepStartedAt + stepMs(state.map, unit.type, unit.path[0]);
      } else {
        unit.stepStartedAt = 0;
        unit.stepEndsAt = 0;
      }
    }
  }
}

module.exports = {
  orderMove,
  headFor,
  nearestTile,
  stepMovement,
};
