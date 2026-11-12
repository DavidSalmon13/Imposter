'use strict';

// Warfront engine, layer 1: engine-side constants (spec "Configurable constants") and TUNING.
// Socket/loop timing (WF_TICK_MS, WF_BROADCAST_MS, roster limits) lives in the shell, ../constants.js.
// Must NOT contain: logic, data tables, requires of other engine files.

// One plains tile at Move 1 (D16, sped up ×1.5 on 2026-11-11): a Warrior crosses a medium map in ~40 s.
const WF_STEP_MS_BASE = 2867;
const WF_MATCH_CAP_MS = 720000;
const WF_EVENT_MS = 60000;
const WF_VISION = 2;
const WF_MAX_UNITS_PER_PLAYER = 30;
const WF_MAX_DT_MS = 1000;
// How long an attacker stays visible to the team it just hit (spec "Under attack").
const WF_REVEAL_MS = 3000;
// Lighthouses (spec "Lighthouses", D15): at most this many per map, and the
// vision radius (Manhattan) around each one a team controls.
const MAX_LIGHTHOUSES = 4;
const WF_LIGHTHOUSE_VISION = 5;
// A home lighthouse stands within this many tiles of its base.
const LIGHTHOUSE_HOME_RANGE = 4;
// An extra (contested) lighthouse is fair if its distances to the two bases differ by at most this.
const LIGHTHOUSE_FAIRNESS = 2;

const TUNING = Object.freeze({
  baseHp: 120,
  baseAtk: 2,
  baseRange: 1,
  baseAttackMs: 1500,
  startSupply: 6,
  startMinerals: 0,
  startWorkers: 2,
  baseTrickleSec: 0.3,
  supplyPerWorkerSec: 0.5,
  forgeWorkerBonusSec: 0.25,
  forgeStructureDiscount: 1,
  mineLoadSec: 0.5,
  carryCap: 4,
  buildMsPerCost: 1200,
  attackMs: 1000,
  luckMagnitude: 0.35,
  structureDefense: 1.5,
  veinLuckMagnitude: 0.4,
  artilleryDmg: 8,
  bombardDmg: 15,
  empMs: 15000,
  aegisMs: 10000,
  airdropCount: 3,
  workshopWeaponCost: 6,
  workshopWeaponMs: 10000,
  supplyDropAmount: 5,
  sandstormLuck: 2,
  // Combat modifiers named in the spec's Combat section.
  rpsCounter: 1.5,
  rpsCountered: 0.67,
  hordeAtkMult: 1.15,
  hordeLuckMult: 0.6,
  archmageOwnLuckMult: 0.5,
  archmageEnemyLuckMult: 1.5,
  luckBendRadius: 2,
  dominantClassRadius: 2,
  siegeVsStructureMult: 3,
  // High ground (D13) and falling back out of reach (D14).
  hillRangeBonus: 1,
  uphillRangePenalty: 1,
  fallBackMaxTiles: 3,
  // Economy modifiers named in the spec's Facilities / Events sections.
  refineryVeinBonus: 1,
  mineralRushMult: 2,
  // AI variety windows.
  mapHistoryWindow: 8,
  eventHistoryWindow: 8,
});

module.exports = {
  WF_STEP_MS_BASE,
  WF_MATCH_CAP_MS,
  WF_EVENT_MS,
  WF_VISION,
  WF_MAX_UNITS_PER_PLAYER,
  WF_MAX_DT_MS,
  WF_REVEAL_MS,
  MAX_LIGHTHOUSES,
  WF_LIGHTHOUSE_VISION,
  LIGHTHOUSE_HOME_RANGE,
  LIGHTHOUSE_FAIRNESS,
  TUNING,
};
