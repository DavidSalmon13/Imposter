'use strict';

// Warfront shell: the room.state.warfront namespace (fields, persistence list, back-to-lobby
// reset), the game-module contract hooks (choose, reconnect, disconnect) and restart repair.
// Must NOT contain: socket handlers (handlers.js). Contract: docs/implementation/refactor_plan.md §4.

const { roomCodeOf } = require('./roster');
const { wfStatePayload, broadcastWfState } = require('./payloads');
const { stopLoop, startLoop } = require('./loop');
const engine = require('./engine');

// Keys within room.state.warfront to persist: all of them (no ephemeral fields in
// the namespace; the sim-loop interval handles live in a module-local map).
const SAVED_FIELDS = [
  'phaseConfig',
  'lobbyRaces',
  'seed',
  'tick',
  'nextUnitId',
  'winner',
  'map',
  'bases',
  'armies',
  'pickups',
  'lighthouses',
  'clock',
  'event',
  'nextEventAt',
  'mapHistory',
  'eventHistory',
];

function createState() {
  return {
    phaseConfig: {
      matchCapMs: engine.MATCH_LENGTHS[engine.DEFAULT_MATCH_LENGTH].ms,
      mapSize: engine.DEFAULT_MAP_SIZE,
    },
    lobbyRaces: {}, // name -> race, picked at team select, kept for Play Again
    seed: 0,
    tick: 0,
    nextUnitId: 1,
    winner: null, // 'red' | 'blue' | 'draw' | null
    map: null,
    bases: null,
    armies: {},
    pickups: null,
    lighthouses: [], // [{ tileId, team: 'red'|'blue'|null }] (D15)
    clock: null,
    event: null,
    nextEventAt: null,
    mapHistory: [],
    eventHistory: [],
  };
}

/** Back-to-lobby reset: keep the host's options, race picks and AI avoid-lists. */
function clearState(room, roomCode) {
  if (roomCode) stopLoop(roomCode); // tickRoom also stops itself once the room isn't playing
  const { phaseConfig, lobbyRaces, mapHistory, eventHistory } = room.state.warfront;
  room.state.warfront = createState();
  Object.assign(room.state.warfront, { phaseConfig, lobbyRaces, mapHistory, eventHistory });
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------
function onChoose(ctx, roomCode, room) {
  clearState(room, roomCode);
  for (const p of room.players.values()) {
    p.team = null;
    p.leader = false;
  }
  room.phase = 'teamSelect';
  broadcastWfState(ctx, roomCode, room);
}

function reconnectPayload(ctx, room, existingPlayer) {
  let viewerName = null;
  for (const [n, p] of room.players.entries()) {
    if (p === existingPlayer) {
      viewerName = n;
      break;
    }
  }
  return { ok: true, ...wfStatePayload(ctx, room, viewerName) };
}

function onDisconnect(ctx, roomCode, room) {
  broadcastWfState(ctx, roomCode, room);
}

function onReconnectBroadcast(ctx, roomCode, room) {
  broadcastWfState(ctx, roomCode, room);
}

function repairOnLoad(ctx, room) {
  // An in-flight map generation can't resume.
  if (room.phase === 'generating') room.phase = 'teamSelect';
  // A live match resumes where it left off: units, HP, queues and the clock were all in
  // the snapshot, but the sim loop is a module-local interval that died with the old
  // process. Reset lastTickAt so the first step uses a normal dt, not the downtime.
  const wf = room.state && room.state.warfront;
  if (room.phase === 'playing' && wf && wf.clock && !wf.winner) {
    wf.clock.lastTickAt = Date.now();
    const roomCode = roomCodeOf(ctx, room);
    if (roomCode) startLoop(ctx, roomCode);
  }
}

module.exports = {
  SAVED_FIELDS,
  createState,
  clearState,
  onChoose,
  reconnectPayload,
  onDisconnect,
  onReconnectBroadcast,
  repairOnLoad,
};
