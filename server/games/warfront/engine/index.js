'use strict';

// Warfront engine public API: re-exports exactly what the old single-file engine exported.
// The engine is pure: no sockets, timers, Date.now(), Math.random(), OpenAI or DOM under engine/.
// Must NOT contain: logic. Code map: docs/implementation/warfront-code-map.md.

const m0 = require('./constants');
const m1 = require('./data');
const m2 = require('./systems/facilities');
const m3 = require('./grid');
const m4 = require('./pathing');
const m5 = require('./mapgen');
const m6 = require('./state');
const m7 = require('./systems/economy');
const m8 = require('./commands');
const m9 = require('./systems/combat');
const m10 = require('./sim');
const m11 = require('./systems/production');
const m12 = require('./systems/victory');
const m13 = require('./vision');
const m14 = require('./view');

module.exports = {
  WF_STEP_MS_BASE: m0.WF_STEP_MS_BASE,
  WF_MATCH_CAP_MS: m0.WF_MATCH_CAP_MS,
  WF_EVENT_MS: m0.WF_EVENT_MS,
  WF_VISION: m0.WF_VISION,
  WF_MAX_UNITS_PER_PLAYER: m0.WF_MAX_UNITS_PER_PLAYER,
  WF_MAX_DT_MS: m0.WF_MAX_DT_MS,
  WF_REVEAL_MS: m0.WF_REVEAL_MS,
  WF_LIGHTHOUSE_VISION: m0.WF_LIGHTHOUSE_VISION,
  MAX_LIGHTHOUSES: m0.MAX_LIGHTHOUSES,
  LIGHTHOUSE_HOME_RANGE: m0.LIGHTHOUSE_HOME_RANGE,
  TUNING: m0.TUNING,
  RACES: m1.RACES,
  RPS_CLASSES: m1.RPS_CLASSES,
  UNIT_CLASSES: m1.UNIT_CLASSES,
  RPS_BEATS: m1.RPS_BEATS,
  UNIT_TYPES: m1.UNIT_TYPES,
  TERRAIN_TYPES: m1.TERRAIN_TYPES,
  FACILITIES: m1.FACILITIES,
  FACILITY_UNITS: m1.FACILITY_UNITS,
  WEAPON_EFFECTS: m1.WEAPON_EFFECTS,
  EVENT_EFFECTS: m1.EVENT_EFFECTS,
  TEAM_PHRASES: m1.TEAM_PHRASES,
  MAP_SIZES: m1.MAP_SIZES,
  DEFAULT_MAP_SIZE: m1.DEFAULT_MAP_SIZE,
  MATCH_LENGTHS: m1.MATCH_LENGTHS,
  DEFAULT_MATCH_LENGTH: m1.DEFAULT_MATCH_LENGTH,
  producibleTypes: m1.producibleTypes,
  unitStats: m1.unitStats,
  facilityCost: m1.facilityCost,
  buildBlocker: m2.buildBlocker,
  rpsMultiplier: m1.rpsMultiplier,
  tileId: m3.tileId,
  tileXY: m3.tileXY,
  manhattan: m3.manhattan,
  neighbors: m3.neighbors,
  isPassable: m3.isPassable,
  floodFill: m4.floodFill,
  bfsPath: m4.bfsPath,
  findPath: m4.findPath,
  pathCost: m4.pathCost,
  validateMap: m5.validateMap,
  buildFallbackMap: m5.buildFallbackMap,
  makeUnit: m6.makeUnit,
  createBattleState: m6.createBattleState,
  stepMs: m6.stepMs,
  buildMs: m6.buildMs,
  supplyRate: m7.supplyRate,
  applyCommand: m8.applyCommand,
  isHigh: m3.isHigh,
  effectiveRange: m9.effectiveRange,
  canReach: m9.canReach,
  fallBackTile: m9.fallBackTile,
  stepSim: m10.stepSim,
  spawnPoints: m11.spawnPoints,
  depositTiles: m7.depositTiles,
  winnerByBaseHp: m12.winnerByBaseHp,
  checkWinner: m12.checkWinner,
  visionFor: m13.visionFor,
  viewForPlayer: m14.viewForPlayer,
  eventsForPlayer: m14.eventsForPlayer,
  finalView: m14.finalView,
};
