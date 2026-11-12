'use strict';

// Warfront game module (docs/specs/warfront-specs.md, docs/implementation/warfront-plan.md):
// the game-module contract gameRegistry.js loads, plus what the tests reach into. Exactly the
// old warfront.js module.exports. Must NOT contain: logic. The shell around the pure engine
// (engine/) is split by job; see docs/implementation/warfront-code-map.md.

const { WF_MIN_PLAYERS, WF_MAX_PLAYERS, WF_MIN_TEAM_SIZE, WF_MAX_TEAM_SIZE, WF_MAP_TIMEOUT_MS, WF_TICK_MS,
  WF_BROADCAST_MS, WF_ALERT_COOLDOWN_MS, WF_ALERT_AREA, WF_WIN_POINTS } = require('./constants');
const { SAVED_FIELDS, createState, clearState, onChoose, reconnectPayload, onDisconnect, onReconnectBroadcast,
  repairOnLoad } = require('./lifecycle');
const { registerHandlers } = require('./handlers');
const { wfLoops, startLoop, stopLoop, tickRoom, finishBattle, awardWfScores } = require('./loop');
const { wfAlertLog } = require('./alerts');
const { generateBattle } = require('./battlefield');
const { wfStatePayload } = require('./payloads');

module.exports = {
  id: 'warfront',
  minPlayers: WF_MIN_PLAYERS,
  maxPlayers: WF_MAX_PLAYERS,
  onChoose,
  registerHandlers,
  reconnectPayload,
  onDisconnect,
  onReconnectBroadcast,
  namespaces: [{ id: 'warfront', createState, savedFields: SAVED_FIELDS }],
  repairOnLoad,
  clearState,
  // exported for tests
  WF_MAP_TIMEOUT_MS,
  WF_TICK_MS,
  WF_BROADCAST_MS,
  WF_ALERT_COOLDOWN_MS,
  WF_ALERT_AREA,
  wfLoops,
  wfAlertLog,
  startLoop,
  stopLoop,
  tickRoom,
  finishBattle,
  awardWfScores,
  WF_WIN_POINTS,
  generateBattle,
  WF_MIN_TEAM_SIZE,
  WF_MAX_TEAM_SIZE,
  wfStatePayload,
};
