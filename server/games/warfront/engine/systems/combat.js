'use strict';

// Warfront engine system: ranges, targeting, damage (RPS, luck, strategy edge, Archmage), base
// and Tower fire, falling back under fire, deaths and drops. May import layers 1–6 plus
// systems/movement.js and systems/facilities.js. Must NOT contain: win checks (victory.js).
// Spec: "Combat", "High ground", "Under attack".

const { WF_REVEAL_MS, TUNING } = require('../constants');
const { RPS_CLASSES, RPS_BEATS, TERRAIN_TYPES, FACILITIES, unitStats, rpsMultiplier } = require('../data');
const { tileId, manhattan, neighbors, terrainAt, isPassable, isHigh } = require('../grid');
const { allUnits, statsOf, garrisonOf, isDisabled } = require('../state');
const { orderMove } = require('./movement');
const { loseFacility } = require('./facilities');
const { rngFor } = require('../../../../lib/rng');

/**
 * How far `attacker` ({ tileId, range }) reaches toward `targetTileId` (D13). Ranged
 * units (base range ≥ 2) gain hillRangeBonus shooting down from a hill and lose
 * uphillRangePenalty shooting up at one; same level = plain range. Melee range is fixed.
 */
function effectiveRange(map, attacker, targetTileId) {
  const r = attacker.range;
  if (r < 2) return r;
  // On a Tower's roof: the tower's height instead of the ground's.
  if (attacker.onTower) return r + TUNING.towerRangeBonus;
  const high = isHigh(map, attacker.tileId);
  const targetHigh = isHigh(map, targetTileId);
  if (high && !targetHigh) return r + TUNING.hillRangeBonus;
  if (!high && targetHigh) return Math.max(0, r - TUNING.uphillRangePenalty);
  return r;
}

/** Whether `attacker` can hit a target on `targetTileId`: in range, and melee only on its own level. */
function canReach(map, attacker, targetTileId) {
  const d = manhattan(attacker.tileId, targetTileId, map.width);
  if (attacker.range >= 2) return d <= effectiveRange(map, attacker, targetTileId);
  return d <= attacker.range && isHigh(map, attacker.tileId) === isHigh(map, targetTileId);
}

/** Every fighter on the field this step: units (by id) and then both bases. */
function combatants(state) {
  const out = [];
  const towers = new Set(allUnits(state).filter(({ unit }) => unit.type === 'tower' && unit.hp > 0).map(({ unit }) => unit.id));
  for (const { unit, owner, team } of allUnits(state)) {
    if (unit.hp <= 0) continue;
    if (unit.garrison && !towers.has(unit.garrison)) unit.garrison = null; // its tower is gone
    const t = unitStats(unit.type);
    // A garrison stands on the Tower's roof: ranged units and casters shoot from it, melee hide.
    const onTower = Boolean(unit.garrison);
    out.push({
      kind: 'unit', id: unit.id, unit, owner, team, race: t.race, cls: t.class, flags: t.flags,
      tileId: unit.tileId, range: t.range, atk: onTower && t.range < 2 ? 0 : t.atk, attackMs: t.attackMs, onTower,
    });
  }
  out.sort((a, b) => a.id - b.id);
  for (const team of ['red', 'blue']) {
    const base = state.bases[team];
    out.push({
      kind: 'base', id: Infinity, base, owner: null, team, race: null, cls: 'structure', flags: [],
      tileId: base.tileId, range: TUNING.baseRange, atk: TUNING.baseAtk, attackMs: TUNING.baseAttackMs,
    });
  }
  return out;
}

/** A base can be damaged when it stands, isn't shielded, and no defender stands on it (D9). */
function baseDamageable(state, team, fighters, now) {
  const base = state.bases[team];
  if (base.hp <= 0 || base.shieldUntil > now) return false;
  return !fighters.some((f) => f.kind === 'unit' && f.team === team && f.tileId === base.tileId);
}

/** Whether `target` (a fighter) is something `attacker` may pick right now. */
function isValidTarget(state, attacker, target, fighters, now) {
  if (target.team === attacker.team) return false;
  if (target.kind === 'unit' && target.unit.hp <= 0) return false;
  // Nobody can hit a Tower's garrison: knock the tower down first.
  if (target.kind === 'unit' && target.onTower) return false;
  if (target.kind === 'base' && (attacker.kind === 'base' || !baseDamageable(state, target.team, fighters, now))) return false;
  return canReach(state.map, attacker, target.tileId);
}

/** Nearest enemy `attacker` can hit; ties break by unit id, a base after units. */
function pickTarget(state, attacker, fighters, now) {
  let best = null;
  let bestD = Infinity;
  for (const f of fighters) {
    if (!isValidTarget(state, attacker, f, fighters, now)) continue;
    const d = manhattan(attacker.tileId, f.tileId, state.map.width);
    if (d < bestD || (d === bestD && f.id < best.id)) {
      best = f;
      bestD = d;
    }
  }
  return best;
}

/**
 * strategyEdge (D5): the enemy's dominant RPS class near the attacker, and the
 * fraction of the attacker's team's RPS units near it that counter that class.
 */
function strategyEdge(state, attacker, fighters) {
  const { width } = state.map;
  const near = (f) => f.kind === 'unit' && RPS_BEATS[f.cls] && manhattan(attacker.tileId, f.tileId, width) <= TUNING.dominantClassRadius;
  const counts = {};
  for (const f of fighters) if (f.team !== attacker.team && near(f)) counts[f.cls] = (counts[f.cls] || 0) + 1;
  let dominant = null;
  let top = 0;
  let tie = false;
  for (const cls of RPS_CLASSES) {
    const n = counts[cls] || 0;
    if (n > top) {
      dominant = cls;
      top = n;
      tie = false;
    } else if (n && n === top) {
      tie = true;
    }
  }
  if (!dominant || tie) return 0;
  const mine = fighters.filter((f) => f.team === attacker.team && near(f));
  if (!mine.length) return 0;
  return mine.filter((f) => RPS_BEATS[f.cls] === dominant).length / mine.length;
}

/** Whether a luckBend Archmage of `team` stands within luckBendRadius of `tileId` (D6). */
function archmageNear(state, team, tileId, fighters) {
  return fighters.some((f) => f.kind === 'unit' && f.team === team && f.flags.includes('luckBend')
    && manhattan(f.tileId, tileId, state.map.width) <= TUNING.luckBendRadius);
}

/** One hit's damage, per the spec's formula. Draws exactly one number from `rng`. */
function hitDamage(state, attacker, target, fighters, rng, now) {
  let atk = attacker.atk * rpsMultiplier(attacker.cls, target.cls);
  if (attacker.race === 'horde') atk *= TUNING.hordeAtkMult;
  if (attacker.cls === 'siege' && target.cls === 'structure') atk *= TUNING.siegeVsStructureMult;
  let defense = TERRAIN_TYPES[terrainAt(state.map, target.tileId)].defense || 1;
  if (target.cls === 'structure') defense *= TUNING.structureDefense;
  let luck = TUNING.luckMagnitude;
  if (attacker.race === 'horde') luck *= TUNING.hordeLuckMult;
  if (archmageNear(state, attacker.team, attacker.tileId, fighters)) luck *= TUNING.archmageOwnLuckMult;
  if (archmageNear(state, target.team, target.tileId, fighters)) luck *= TUNING.archmageEnemyLuckMult;
  const ev = state.event;
  if (ev && ev.effectId === 'sandstorm' && ev.endsAt > now) luck *= TUNING.sandstormLuck;
  const swing = (rng() * 2 - 1) * luck * (1 - strategyEdge(state, attacker, fighters));
  const dmg = (atk / defense) * (1 + swing);
  return Math.max(0, Math.round(dmg * 100) / 100);
}

/**
 * The nearest passable tile, at most fallBackMaxTiles steps away, out of
 * `attacker`'s reach (BFS, N/E/S/W tie-break), or null if there is none.
 */
function fallBackTile(state, unit, attacker) {
  const { map } = state;
  const depth = new Map([[unit.tileId, 0]]);
  const queue = [unit.tileId];
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    const d = depth.get(cur);
    if (d > 0 && !canReach(map, attacker, cur)) return cur;
    if (d >= TUNING.fallBackMaxTiles) continue;
    for (const n of neighbors(cur, map.width, map.height)) {
      if (depth.has(n) || !isPassable(map, n)) continue;
      depth.set(n, d + 1);
      queue.push(n);
    }
  }
  return null;
}

/**
 * Everyone whose cooldown is up hits the nearest enemy they can reach. Targets are
 * picked from the field as it stood at the start of the step and damage lands
 * together, so the order units are listed in never decides a fight.
 */
function stepCombat(state, now, events) {
  const rng = rngFor(state.seed, state.tick);
  const fighters = combatants(state);
  const hits = [];
  for (const attacker of fighters) {
    const holder = attacker.kind === 'unit' ? attacker.unit : attacker.base;
    if (holder.atkReadyAt > now) continue;
    // Facilities other than the Tower never attack, and a construction site waits until it's done.
    if (attacker.atk <= 0 || (attacker.kind === 'unit' && attacker.unit.buildDoneAt)) continue;
    if (attacker.kind === 'unit' && isDisabled(attacker.unit, now)) continue; // switched off by an EMP
    if (attacker.kind === 'base' && attacker.base.hp <= 0) continue;
    const target = pickTarget(state, attacker, fighters, now);
    if (!target) continue;
    holder.atkReadyAt = now + attacker.attackMs;
    const victims = attacker.flags.includes('aoe') && target.kind === 'unit'
      ? fighters.filter((f) => f.kind === 'unit' && f.team !== attacker.team && f.tileId === target.tileId && !f.onTower)
      : [target];
    for (const victim of victims) hits.push({ attacker, victim, dmg: hitDamage(state, attacker, victim, fighters, rng, now) });
  }

  const hitBy = new Map(); // unit id -> attackers that hit it this step
  for (const { attacker, victim, dmg } of hits) {
    const base = {
      tileId: victim.tileId, fromTileId: attacker.tileId, dmg,
      by: attacker.kind === 'unit' ? attacker.unit.type : 'base', ranged: attacker.range >= 2,
      ...(attacker.onTower ? { fromTower: true } : {}), // shot from a Tower's roof
    };
    // Battle stats (display only): the hit that drops a unit gets the kill, and
    // base damage counts what the base actually lost.
    const stats = attacker.kind === 'unit' ? statsOf(state.armies[attacker.owner]) : null;
    if (victim.kind === 'base') {
      const before = victim.base.hp;
      victim.base.hp = Math.max(0, Math.round((victim.base.hp - dmg) * 100) / 100);
      if (stats) stats.baseDmg = Math.round((stats.baseDmg + before - victim.base.hp) * 100) / 100;
      events.push({ type: 'baseHit', team: victim.team, hp: victim.base.hp, ...base });
    } else {
      const before = victim.unit.hp;
      victim.unit.hp = Math.round((victim.unit.hp - dmg) * 100) / 100;
      if (stats && before > 0 && victim.unit.hp <= 0) stats.kills += 1;
      events.push({ type: 'underAttack', owner: victim.owner, team: victim.team, unitId: victim.id, ...base });
      if (!hitBy.has(victim.id)) hitBy.set(victim.id, []);
      hitBy.get(victim.id).push(attacker);
    }
    // The victim's team sees whoever just hit them for a moment (D14).
    if (attacker.kind === 'unit') {
      const u = attacker.unit;
      u.revealedUntil = { red: 0, blue: 0, ...u.revealedUntil, [victim.team]: now + WF_REVEAL_MS };
    }
  }

  // A fallen Tower drops its garrison to the ground, hurt by the fall (never killed by it).
  for (const f of fighters) {
    if (f.kind !== 'unit' || f.unit.type !== 'tower' || f.unit.hp > 0) continue;
    for (const g of garrisonOf(state, f.id)) {
      g.garrison = null;
      g.hp = Math.max(1, Math.round((g.hp - unitStats(g.type).hp * TUNING.towerFallDmg) * 100) / 100);
      events.push({ type: 'towerFall', tileId: g.tileId, owner: g.owner, team: f.team, unitId: g.id });
    }
  }

  // Deaths: a loaded Worker leaves its cargo on the tile.
  for (const [owner, army] of Object.entries(state.armies)) {
    army.units = army.units.filter((u) => {
      if (u.hp > 0) return true;
      if (u.carrying > 0) {
        state.pickups.mineralDrops[u.tileId] = (state.pickups.mineralDrops[u.tileId] || 0) + u.carrying;
      }
      statsOf(army).lost += 1;
      if (FACILITIES[u.type]) loseFacility(army, u);
      events.push({ type: 'death', tileId: u.tileId, owner, team: army.team, unitId: u.id, unitType: u.type });
      return false;
    });
  }

  // Fall back: an idle unit hit only by enemies it can't answer steps out of reach.
  for (const f of fighters) {
    const attackers = f.kind === 'unit' && hitBy.get(f.id);
    if (!attackers) continue;
    const u = f.unit;
    if (u.hp <= 0 || u.path.length || u.haul || u.holding || u.garrison || unitStats(u.type).move <= 0) continue;
    const live = attackers.filter((a) => a.kind === 'base' || a.unit.hp > 0);
    if (!live.length) continue;
    const me = { ...f, tileId: u.tileId };
    if (live.some((a) => isValidTarget(state, me, a, fighters, now))) continue;
    const to = fallBackTile(state, u, live[0]);
    if (to != null) orderMove(state, u, to, now);
  }
}

module.exports = {
  effectiveRange,
  canReach,
  fallBackTile,
  stepCombat,
};
