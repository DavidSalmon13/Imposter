'use strict';

// Warfront engine, layer 6: battle state creation and small shared helpers every system uses
// (unit lookup, step/build times, unit slots, built facilities, stats, round3).
// Must NOT contain: per-tick rules (systems/*) or player views (view.js).

const { WF_STEP_MS_BASE, WF_MATCH_CAP_MS, WF_EVENT_MS, WF_MAX_UNITS_PER_PLAYER, TUNING } = require('./constants');
const { RACES, UNIT_TYPES, TERRAIN_TYPES, unitStats } = require('./data');
const { tileId, terrainAt, supplyWallOf } = require('./grid');

// ---------------------------------------------------------------------------
// Battle state (spec "Map generation" step 4)
// ---------------------------------------------------------------------------
/** A fresh unit of `type` owned by `owner`, standing on `tileId`. */
function makeUnit(id, type, owner, tileId) {
  const t = unitStats(type);
  return {
    id,
    type,
    class: t.class,
    tileId,
    hp: t.hp,
    owner,
    carrying: 0,
    carryKind: null, // what `carrying` is: 'minerals' | 'supply' (null/absent = minerals)
    path: [],
    stepStartedAt: 0,
    stepEndsAt: 0,
    stepFrom: null, // set while a turned-round unit walks back onto tileId: the tile it's walking from
    atkReadyAt: 0,
    haul: null,
    holding: false,
    garrison: null, // id of the friendly Tower this unit stands on top of
    revealedUntil: {}, // side -> until when that side sees this unit after it hit them (D14)
  };
}

/**
 * The full live-match state for a validated `map`. `roster` is
 * [{ name, team: a side with a base on the map, race }]; opts = { seed, now, matchCapMs }.
 * Returns the fields the module stores under room.state.warfront.
 */
function createBattleState(map, roster, { seed, now, matchCapMs = WF_MATCH_CAP_MS }) {
  let nextUnitId = 1;
  const baseOf = {};
  for (const b of map.bases) baseOf[b.team] = b.tileId;
  const bases = {};
  for (const b of map.bases) bases[b.team] = { hp: TUNING.baseHp, maxHp: TUNING.baseHp, tileId: b.tileId, shieldUntil: 0, atkReadyAt: 0 };
  const armies = {};
  for (const { name, team, race } of roster) {
    if (!RACES[race]) throw new Error(`unknown race "${race}" for ${name}`);
    if (!bases[team]) throw new Error(`unknown team "${team}" for ${name}`);
    const units = [];
    // The starting Workers go straight to carving 🔩 at their supply wall (the tile beside the base).
    const wall = supplyWallOf(map, team)[0];
    for (let i = 0; i < TUNING.startWorkers; i++) {
      const u = makeUnit(nextUnitId++, RACES[race].workerType, name, baseOf[team]);
      if (wall) u.haul = { veinTileId: wall.tileId, kind: 'supply', stage: 'toVein', luck: 0 };
      units.push(u);
    }
    armies[name] = {
      team,
      race,
      supply: TUNING.startSupply,
      minerals: TUNING.startMinerals,
      arsenal: [],
      facilities: [],
      queues: {},
      workshop: [],
      stats: { kills: 0, lost: 0, baseDmg: 0 },
      units,
    };
  }
  return {
    seed: seed >>> 0,
    tick: 0,
    nextUnitId,
    winner: null,
    // Free for all (Step 27): [{ side, place }] as sides are knocked out, then the survivors at the end.
    placings: [],
    map,
    bases,
    armies,
    pickups: {
      mineralDrops: {},
      weapons: map.weapons.map((w) => ({ tileId: w.tileId, weaponId: w.weaponId })),
    },
    // Home lighthouses start with their base's team, contested ones neutral (D15).
    lighthouses: (map.lighthouses || []).map((l) => ({ tileId: l.tileId, team: l.team || null })),
    clock: { startedAt: now, matchEndsAt: now + matchCapMs, lastTickAt: now },
    event: null,
    nextEventAt: now + WF_EVENT_MS,
  };
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------
function teamOf(state, name) {
  const a = state.armies[name];
  return a ? a.team : null;
}

/** A side whose base has fallen is out of the battle (free for all; a team battle ends right then). */
function isKnockedOut(state, team) {
  return Boolean(team && state.bases && state.bases[team] && state.bases[team].hp <= 0);
}

/** Every unit on the field, with its army's team: [{ unit, owner, team }]. */
function allUnits(state) {
  const out = [];
  for (const [owner, a] of Object.entries(state.armies)) {
    for (const u of a.units) out.push({ unit: u, owner, team: a.team });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Step and build times (spec "Movement (grid-step, real time)", "Economy")
// ---------------------------------------------------------------------------
/** Move 1 / 2 / 3 walk at ×1 / ×1.5 / ×2 the base speed (D16). */
function speedFactor(move) {
  return (1 + move) / 2;
}

/** Time to walk onto `toTileId`: WF_STEP_MS_BASE ÷ the speed factor × the entered tile's move cost. */
function stepMs(map, unitType, toTileId) {
  const move = unitStats(unitType).move;
  const cost = TERRAIN_TYPES[terrainAt(map, toTileId)].moveCost;
  return Math.round((WF_STEP_MS_BASE / speedFactor(move)) * cost);
}

const MAX_UNITS_PER_COMMAND = WF_MAX_UNITS_PER_PLAYER;

/** Build/spawn time of a unit type: buildMsPerCost × its 🔩 Supply cost. */
function buildMs(unitType) {
  return TUNING.buildMsPerCost * UNIT_TYPES[unitType].supply;
}

/** Unit slots a produce order takes: a Summoner brings its Golem along. */
function slotsFor(unitType) {
  return UNIT_TYPES[unitType].flags.includes('summonsGolem') ? 2 : 1;
}

/** Unit slots an army uses toward WF_MAX_UNITS_PER_PLAYER: units on the field plus everything queued (D12). */
function unitSlotsUsed(army) {
  let n = army.units.length;
  for (const q of Object.values(army.queues)) for (const item of q) n += slotsFor(item.unitType);
  return n;
}

/** Whether an EMP has `u` switched off at `now` (it does nothing until disabledUntil). */
function isDisabled(u, now) {
  return Boolean(u.disabledUntil) && u.disabledUntil > now;
}

/**
 * `army`'s finished facilities of `type` (construction sites don't count). With `now`,
 * only the working ones: a building an EMP switched off is left out until it recovers.
 */
function builtFacilities(army, type, now) {
  return army.units.filter((u) => u.type === type && !u.buildDoneAt && u.hp > 0 && (now == null || !isDisabled(u, now)));
}

// ---------------------------------------------------------------------------
// Tower garrisons (spec "Towers")
// ---------------------------------------------------------------------------
/** The finished, standing Tower of `team` on `tileId`, or null. */
function towerAt(state, team, tileId) {
  for (const { unit, team: t } of allUnits(state)) {
    if (t === team && unit.type === 'tower' && unit.tileId === tileId && !unit.buildDoneAt && unit.hp > 0) return unit;
  }
  return null;
}

/** The units standing on top of the Tower `towerId`. */
function garrisonOf(state, towerId) {
  return allUnits(state).filter(({ unit }) => unit.garrison === towerId).map(({ unit }) => unit);
}

const round3 = (n) => Math.round(n * 1000) / 1000;

/** An army's battle stats, created if an older saved match lacks them. */
function statsOf(army) {
  if (!army.stats) army.stats = { kills: 0, lost: 0, baseDmg: 0 };
  return army.stats;
}

module.exports = {
  makeUnit,
  createBattleState,
  teamOf,
  isKnockedOut,
  allUnits,
  stepMs,
  MAX_UNITS_PER_COMMAND,
  buildMs,
  slotsFor,
  unitSlotsUsed,
  builtFacilities,
  isDisabled,
  round3,
  statsOf,
  towerAt,
  garrisonOf,
};
