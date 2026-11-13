'use strict';

// Warfront engine system: building facilities (placement rules D4/D17), construction, the
// Workshop craft queue and losing a facility. Imports layers 1–6b only.
// Must NOT contain: Tower firing (systems/combat.js). Spec: "Facilities", plan Step 9 / D17.

const { WF_MAX_UNITS_PER_PLAYER, TUNING } = require('../constants');
const { FACILITIES, facilityCost, WEAPON_EFFECTS } = require('../data');
const { tileId, manhattan, isPassable } = require('../grid');
const { makeUnit, allUnits, unitSlotsUsed, builtFacilities, isDisabled, round3 } = require('../state');
const { visionFor } = require('../vision');

// ---------------------------------------------------------------------------
// Facilities and towers (spec "Facilities", "Towers"; D4, D17)
// ---------------------------------------------------------------------------
/**
 * Why `army` can't build `facility` on `tileId` right now, or null when it can (D4):
 * a passable tile in the team's vision, not a base, with no enemy unit and no
 * structure on it; a Refinery also needs a vein on or beside the tile.
 */
function buildBlocker(state, army, facility, tileId) {
  const { map } = state;
  if (!isPassable(map, tileId)) return "Can't build there";
  if (!visionFor(state, army.team).has(tileId)) return 'Build only where your team can see';
  if (tileId === state.bases.red.tileId || tileId === state.bases.blue.tileId) return "Can't build on a base";
  for (const { unit, team } of allUnits(state)) {
    if (unit.tileId !== tileId || unit.hp <= 0) continue;
    if (unit.class === 'structure') return 'There is already a structure there';
    if (team !== army.team) return 'An enemy is standing there';
  }
  if (FACILITIES[facility].needsVein && !map.veins.some((v) => manhattan(v.tileId, tileId, map.width) <= 1)) {
    return 'A Refinery goes on or next to a mineral vein';
  }
  return null;
}

/**
 * Build (D17): pays the 💎 now and places a construction site, a structure unit
 * that is attackable at once but does nothing until buildDoneAt. Counts toward the
 * unit cap like everything else on the field.
 */
function orderBuild(state, name, army, cmd, now) {
  const f = FACILITIES[cmd.facility];
  if (!f) return { ok: false, error: 'Unknown building' };
  const blocker = buildBlocker(state, army, f.id, cmd.tileId);
  if (blocker) return { ok: false, error: blocker };
  if (unitSlotsUsed(army) + 1 > WF_MAX_UNITS_PER_PLAYER) {
    return { ok: false, error: `Army is at the ${WF_MAX_UNITS_PER_PLAYER}-unit cap` };
  }
  const cost = facilityCost(army.race, f.id);
  if (army.minerals < cost) return { ok: false, error: 'Not enough Minerals' };
  army.minerals = round3(army.minerals - cost);
  const u = makeUnit(state.nextUnitId++, f.id, name, cmd.tileId);
  u.buildDoneAt = now + f.buildMs;
  army.units.push(u);
  army.facilities.push({ id: u.id, type: f.id, tileId: u.tileId });
  return { ok: true, unitId: u.id };
}

/**
 * Craft (D17): with a finished Workshop, pays workshopWeaponCost 💎 now and adds the
 * weapon to the player's sequential Workshop queue (one at a time per player).
 */
function orderCraft(state, army, cmd, now) {
  if (!WEAPON_EFFECTS[cmd.weaponId]) return { ok: false, error: 'Unknown weapon' };
  if (!builtFacilities(army, 'workshop').length) return { ok: false, error: 'Build a Workshop first' };
  if (army.minerals < TUNING.workshopWeaponCost) return { ok: false, error: 'Not enough Minerals' };
  army.minerals = round3(army.minerals - TUNING.workshopWeaponCost);
  const queue = army.workshop;
  const startsAt = queue.length ? Math.max(queue[queue.length - 1].doneAt, now) : now;
  queue.push({ weaponId: cmd.weaponId, doneAt: startsAt + TUNING.workshopWeaponMs });
  return { ok: true };
}

/** Construction sites whose time is up become working structures; an EMP'd site waits it out. */
function stepConstruction(state, dtMs, now, events) {
  for (const [owner, army] of Object.entries(state.armies)) {
    for (const u of army.units) {
      if (u.buildDoneAt && isDisabled(u, now)) u.buildDoneAt += dtMs;
      if (!u.buildDoneAt || u.buildDoneAt > now || u.hp <= 0) continue;
      u.buildDoneAt = 0;
      events.push({ type: 'built', tileId: u.tileId, owner, team: army.team, unitId: u.id, unitType: u.type });
    }
  }
}

/**
 * Finished Workshop weapons join the arsenal, one at a time. While an EMP has every one of
 * the player's Workshops switched off, the queue waits (each item `dtMs` later).
 */
function stepWorkshop(state, dtMs, now, events) {
  for (const [owner, army] of Object.entries(state.armies)) {
    const queue = army.workshop;
    if (!queue || !queue.length) continue;
    const shop = builtFacilities(army, 'workshop', now)[0];
    if (!shop && builtFacilities(army, 'workshop').length) {
      for (const item of queue) item.doneAt += dtMs;
      continue;
    }
    while (queue.length && queue[0].doneAt <= now) {
      const { weaponId } = queue.shift();
      army.arsenal.push(weaponId);
      events.push({ type: 'crafted', tileId: shop ? shop.tileId : state.bases[army.team].tileId, owner, team: army.team, weaponId });
    }
  }
}

/**
 * A facility just fell (D17): its work in progress is lost, no refund. A Forward
 * Barracks takes its spawn queue with it; the Workshop queue goes with the last Workshop.
 */
function loseFacility(army, u) {
  army.facilities = army.facilities.filter((f) => f.id !== u.id);
  if (u.type === 'barracks') delete army.queues[u.tileId];
  if (u.type === 'workshop' && !builtFacilities(army, 'workshop').some((w) => w.id !== u.id)) army.workshop = [];
}

module.exports = {
  buildBlocker,
  orderBuild,
  orderCraft,
  stepConstruction,
  stepWorkshop,
  loseFacility,
};
