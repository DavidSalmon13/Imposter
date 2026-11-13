'use strict';

// Warfront engine system: move orders, heading a unit somewhere, stepping units along paths and
// collecting pickups on arrival. Imports layers 1–6 only (base system: other systems may use it).
// Must NOT contain: combat, hauling rules. Spec: "Movement".

const { findPath, pathCost } = require('../pathing');
const { TUNING } = require('../constants');
const { unitStats } = require('../data');
const { allUnits, stepMs, towerAt, garrisonOf } = require('../state');

/** Walking time (ms) along `path` for a unit of `type`: each step's stepMs summed. */
function walkMs(map, type, path) {
  let ms = 0;
  for (const t of path) ms += stepMs(map, type, t);
  return ms;
}

/**
 * Sends one unit toward `to`. A unit that's mid-step either carries on onto the tile
 * it's stepping to, or turns round on the spot and walks back to the tile it came
 * from, whichever reaches `to` sooner. Turning round never snaps it: the step back
 * starts from where it stands now. Returns false when there's nowhere to go.
 *
 * A unit stays on `tileId` until a step lands, so a turned-round unit whose step
 * leads back onto `tileId` remembers where it's walking from in `stepFrom`.
 */
function orderMove(state, unit, to, now) {
  const { map } = state;
  // Mid-step (or a finished step the next sim step hasn't applied yet).
  if (unit.path.length) {
    const next = unit.path[0];
    const from = unit.stepFrom != null ? unit.stepFrom : unit.tileId;
    const fwdRest = next === to ? [] : findPath(map, next, to);
    const fwdOk = next === to || fwdRest.length > 0;
    const dur = Math.max(1, unit.stepEndsAt - unit.stepStartedAt);
    const done = Math.max(0, Math.min(1, (now - unit.stepStartedAt) / dur)); // share of the step walked
    let back = null;
    if (from !== next && done < 1) {
      const backRest = from === to ? [] : findPath(map, from, to);
      if (from === to || backRest.length) {
        const backStep = stepMs(map, unit.type, from);
        const backMs = done * backStep + walkMs(map, unit.type, backRest);
        const fwdMs = fwdOk ? Math.max(0, unit.stepEndsAt - now) + walkMs(map, unit.type, fwdRest) : Infinity;
        if (backMs < fwdMs) back = { rest: backRest, step: backStep };
      }
    }
    if (back) {
      // Turn round: step from `next` back onto `from`, already (1 - done) of the way there.
      unit.path = [from, ...back.rest];
      unit.stepEndsAt = Math.round(now + done * back.step);
      unit.stepStartedAt = unit.stepEndsAt - back.step;
      unit.stepFrom = next === unit.tileId ? null : next;
    } else {
      if (!fwdOk) return false;
      unit.path = [next, ...fwdRest];
    }
  } else {
    const path = findPath(map, unit.tileId, to);
    if (!path.length) return false;
    unit.path = path;
    unit.stepFrom = null;
    unit.stepStartedAt = now;
    unit.stepEndsAt = now + stepMs(map, unit.type, path[0]);
  }
  unit.haul = null;
  unit.holding = false;
  unit.garrison = null; // any move climbs down off a Tower
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

/**
 * A unit that ends its walk on a friendly Tower climbs onto its roof when there's room
 * (TUNING.towerGarrison). Haulers pass through: they're busy.
 */
function climbTower(state, army, unit, events) {
  if (unit.path.length || unit.haul || unitStats(unit.type).move <= 0) return;
  const tower = towerAt(state, army.team, unit.tileId);
  if (!tower || garrisonOf(state, tower.id).length >= TUNING.towerGarrison) return;
  unit.garrison = tower.id;
  events.push({ type: 'garrison', tileId: unit.tileId, owner: unit.owner, team: army.team, unitId: unit.id, towerId: tower.id });
}

/** Collects whatever lies on the tile a unit just walked onto. */
function arriveAt(state, owner, unit, events) {
  const army = state.armies[owner];
  climbTower(state, army, unit, events);
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
      unit.stepFrom = null;
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
  climbTower,
  orderMove,
  headFor,
  nearestTile,
  stepMovement,
};
