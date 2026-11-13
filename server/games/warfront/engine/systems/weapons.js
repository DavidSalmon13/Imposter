'use strict';

// Warfront engine system: firing a special weapon from the arsenal (artillery, emp, airdrop,
// bombard, aegis) and what each one does the instant it lands. Imports layers 1–6b only.
// Must NOT contain: weapon pickups (movement.js) or crafting (facilities.js); deaths are cleared
// by combat's next step like any other kill. Spec: "Special weapons", plan Step 10.

const { WF_MAX_UNITS_PER_PLAYER, TUNING } = require('../constants');
const { RACES, TERRAIN_TYPES, FACILITIES, WEAPON_EFFECTS, unitStats } = require('../data');
const { terrainAt, isPassable } = require('../grid');
const { makeUnit, allUnits, unitSlotsUsed, statsOf, garrisonOf } = require('../state');
const { visionFor } = require('../vision');

const onMap = (map, id) => Number.isInteger(id) && id >= 0 && id < map.width * map.height;
const round2 = (n) => Math.round(n * 100) / 100;

/** The enemy facility or Tower (finished or a site) standing on `tileId`, or null. */
function enemyFacilityAt(state, team, tileId) {
  for (const { unit, owner, team: t } of allUnits(state)) {
    if (t !== team && FACILITIES[unit.type] && unit.tileId === tileId && unit.hp > 0) return { unit, owner, team: t };
  }
  return null;
}

/**
 * Why `army` can't fire `weaponId` at `targetTileId`, or null when it can. Only checks the
 * aim; an aimed artillery strike may still find nobody there (it whiffs and is used up).
 */
function weaponBlocker(state, army, weaponId, targetTileId) {
  const { map } = state;
  if (!WEAPON_EFFECTS[weaponId]) return 'Unknown weapon';
  if (!army.arsenal.includes(weaponId)) return 'That weapon is not in your arsenal';
  if (!onMap(map, targetTileId)) return 'Aim at a tile on the battlefield';
  const enemy = army.team === 'red' ? 'blue' : 'red';
  if (weaponId === 'emp') {
    // Fogged tiles are refused so an EMP can't be used to probe the fog.
    if (!visionFor(state, army.team).has(targetTileId) || !enemyFacilityAt(state, army.team, targetTileId)) {
      return 'Aim the EMP at an enemy building you can see';
    }
  }
  if (weaponId === 'airdrop') {
    if (!isPassable(map, targetTileId)) return "Can't drop there";
    if (!visionFor(state, army.team).has(targetTileId)) return 'Drop only where your team can see';
    if (unitSlotsUsed(army) >= WF_MAX_UNITS_PER_PLAYER) return `Army is at the ${WF_MAX_UNITS_PER_PLAYER}-unit cap`;
  }
  if (weaponId === 'bombard' && targetTileId !== state.bases[enemy].tileId) return 'Aim the Bombard at the enemy base';
  if (weaponId === 'aegis' && targetTileId !== state.bases[army.team].tileId) return 'Aim the Aegis at your own base';
  return null;
}

/** Artillery: artilleryDmg to every enemy on the tile (not a Tower's roof), through terrain/structure defense. */
function artillery(state, owner, army, tileId, out) {
  const terrain = TERRAIN_TYPES[terrainAt(state.map, tileId)].defense || 1;
  const stats = statsOf(army);
  let hits = 0;
  for (const { unit, owner: vOwner, team } of allUnits(state)) {
    if (team === army.team || unit.tileId !== tileId || unit.hp <= 0 || unit.garrison) continue;
    const defense = terrain * (unitStats(unit.type).class === 'structure' ? TUNING.structureDefense : 1);
    const dmg = round2(TUNING.artilleryDmg / defense);
    unit.hp = round2(unit.hp - dmg);
    hits++;
    if (unit.hp <= 0) stats.kills += 1;
    out.push({ type: 'underAttack', tileId, owner: vOwner, team, unitId: unit.id, dmg, by: 'artillery' });
    // A Tower brought down drops its garrison, hurt by the fall (as in combat).
    if (unit.type === 'tower' && unit.hp <= 0) {
      for (const g of garrisonOf(state, unit.id)) {
        g.garrison = null;
        g.hp = Math.max(1, round2(g.hp - unitStats(g.type).hp * TUNING.towerFallDmg));
        out.push({ type: 'towerFall', tileId, owner: g.owner, team, unitId: g.id });
      }
    }
  }
  return { hits };
}

/** EMP: the enemy building on the tile does nothing for empMs (its timers wait it out). */
function emp(state, army, tileId, now, out) {
  const { unit, owner, team } = enemyFacilityAt(state, army.team, tileId);
  unit.disabledUntil = Math.max(unit.disabledUntil || 0, now + TUNING.empMs);
  out.push({ type: 'disabled', tileId, owner, team, unitId: unit.id, until: unit.disabledUntil });
  return { unitId: unit.id, until: unit.disabledUntil };
}

/** Airdrop: up to airdropCount of the race's basic melee unit land on the tile, as many as the cap allows. */
function airdrop(state, owner, army, tileId, out) {
  const type = RACES[army.race].airdropUnit;
  const n = Math.min(TUNING.airdropCount, WF_MAX_UNITS_PER_PLAYER - unitSlotsUsed(army));
  for (let i = 0; i < n; i++) {
    const u = makeUnit(state.nextUnitId++, type, owner, tileId);
    army.units.push(u);
    out.push({ type: 'spawn', tileId, owner, team: army.team, unitId: u.id, unitType: type, airdrop: true });
  }
  return { spawned: n };
}

/** Bombard: bombardDmg straight to the enemy base, contested or not; an Aegis still stops it. */
function bombard(state, army, now, out) {
  const enemy = army.team === 'red' ? 'blue' : 'red';
  const base = state.bases[enemy];
  if (base.hp <= 0 || base.shieldUntil > now) return { dmg: 0, shielded: base.shieldUntil > now };
  const before = base.hp;
  base.hp = Math.max(0, round2(base.hp - TUNING.bombardDmg));
  const dmg = round2(before - base.hp);
  const stats = statsOf(army);
  stats.baseDmg = round2(stats.baseDmg + dmg);
  out.push({ type: 'baseHit', team: enemy, tileId: base.tileId, hp: base.hp, dmg, by: 'bombard' });
  return { dmg };
}

/** Aegis: your base takes no damage at all for aegisMs (a second one extends from now). */
function aegis(state, army, now) {
  const base = state.bases[army.team];
  base.shieldUntil = Math.max(base.shieldUntil || 0, now + TUNING.aegisMs);
  return { until: base.shieldUntil };
}

/**
 * Fire weapon: spends one `weaponId` from the arsenal and applies it at once. Its events
 * wait in `state.pendingEvents` (not persisted) for the next sim step to send out.
 */
function orderWeapon(state, name, army, cmd, now) {
  const { weaponId, targetTileId } = cmd;
  const blocker = weaponBlocker(state, army, weaponId, targetTileId);
  if (blocker) return { ok: false, error: blocker };
  army.arsenal.splice(army.arsenal.indexOf(weaponId), 1);
  const out = [];
  let result;
  if (weaponId === 'artillery') result = artillery(state, name, army, targetTileId, out);
  else if (weaponId === 'emp') result = emp(state, army, targetTileId, now, out);
  else if (weaponId === 'airdrop') result = airdrop(state, name, army, targetTileId, out);
  else if (weaponId === 'bombard') result = bombard(state, army, now, out);
  else result = aegis(state, army, now);
  const events = state.pendingEvents || (state.pendingEvents = []);
  events.push({ type: 'weapon', weaponId, tileId: targetTileId, owner: name, team: army.team, ...result }, ...out);
  return { ok: true, weaponId, ...result };
}

module.exports = {
  weaponBlocker,
  orderWeapon,
};
