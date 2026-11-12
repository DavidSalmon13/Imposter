'use strict';

// Warfront shell constants: roster limits, the sim-loop tick, the OpenAI timeout, alert
// throttling and scoreboard points. Engine-side constants live in engine/constants.js.
// Must NOT contain: logic or requires.

const WF_MIN_PLAYERS = 2;
const WF_MAX_PLAYERS = 8;
const WF_MIN_TEAM_SIZE = 1;
const WF_MAX_TEAM_SIZE = 4;
const TEAMS = ['red', 'blue'];
// Give up on OpenAI after this long and use the procedural map instead.
const WF_MAP_TIMEOUT_MS = 25000;
// The sim loop: advance the world, then push each player their fogged view.
const WF_TICK_MS = 200;
const WF_BROADCAST_MS = 200; // == WF_TICK_MS: every tick is broadcast

// "Under attack!" alert throttle (spec "Under attack"): per player, at most one alert
// every WF_ALERT_COOLDOWN_MS unless the hit is WF_ALERT_AREA+ tiles from the last one.
const WF_ALERT_COOLDOWN_MS = 10000;
const WF_ALERT_AREA = 4;
// Scoreboard points for each player on the winning team (spec "Ending the match").
const WF_WIN_POINTS = 2;

module.exports = {
  WF_MIN_PLAYERS,
  WF_MAX_PLAYERS,
  WF_MIN_TEAM_SIZE,
  WF_MAX_TEAM_SIZE,
  TEAMS,
  WF_MAP_TIMEOUT_MS,
  WF_TICK_MS,
  WF_BROADCAST_MS,
  WF_ALERT_COOLDOWN_MS,
  WF_ALERT_AREA,
  WF_WIN_POINTS,
};
