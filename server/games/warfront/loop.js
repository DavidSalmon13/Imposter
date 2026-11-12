'use strict';

// Warfront shell: the per-room sim loop (one setInterval per playing room), the tick,
// finishing a battle and awarding scoreboard points. Owns wfLoops.
// Must NOT contain: rules (engine/sim.js) or payload shapes (payloads.js). Plan "Architecture".

const { WF_TICK_MS, WF_WIN_POINTS } = require('./constants');
const { wfAlertLog, sendAlerts } = require('./alerts');
const { broadcastWfState, broadcastLive } = require('./payloads');
const engine = require('./engine');

// Dev/testing only: set WF_DEV_MATCH_MS (e.g. 60000) to make every match that long,
// so a full match can be played through to the game-over screen quickly.
function devMatchMs() {
  const ms = Number(process.env.WF_DEV_MATCH_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

// roomCode -> interval handle of that room's sim loop (ephemeral, never persisted).
const wfLoops = new Map();

// ---------------------------------------------------------------------------
// Sim loop (one setInterval per playing room)
// ---------------------------------------------------------------------------
function stopLoop(roomCode) {
  const handle = wfLoops.get(roomCode);
  if (handle) clearInterval(handle);
  wfLoops.delete(roomCode);
  wfAlertLog.delete(roomCode);
}

function startLoop(ctx, roomCode) {
  stopLoop(roomCode);
  const handle = setInterval(() => tickRoom(ctx, roomCode), WF_TICK_MS);
  // The loop alone never keeps the process alive (tests, shutdown).
  if (handle && typeof handle.unref === 'function') handle.unref();
  wfLoops.set(roomCode, handle);
}

/**
 * One sim step for a room: clamp dt, step the engine, push every player their
 * view. Exception-safe: a throw is logged and the next tick runs as normal.
 */
function tickRoom(ctx, roomCode) {
  const room = ctx.rooms.get(roomCode);
  if (!room || room.game !== 'warfront' || room.phase !== 'playing' || !room.state.warfront.clock) {
    stopLoop(roomCode);
    return;
  }
  const wf = room.state.warfront;
  try {
    const now = Date.now();
    const dt = Math.min(Math.max(0, now - wf.clock.lastTickAt), engine.WF_MAX_DT_MS);
    const { events } = engine.stepSim(wf, dt, { now });
    wf.clock.lastTickAt = now;
    broadcastLive(ctx, roomCode, room, events);
    if (wf.winner) {
      finishBattle(ctx, roomCode, room, wf.winner);
      return;
    }
    sendAlerts(ctx, roomCode, room, events, now);
  } catch (err) {
    console.error(`Warfront tick failed in room ${roomCode}:`, err);
  }
}

/**
 * The match is decided: stop the loop, move to gameover, pay out points, record
 * the result, and send everyone the final (unfogged) state.
 */
function finishBattle(ctx, roomCode, room, winner) {
  stopLoop(roomCode);
  const wf = room.state.warfront;
  wf.winner = winner;
  if (!wf.clock.endedAt) wf.clock.endedAt = Date.now();
  room.phase = 'gameover';
  awardWfScores(ctx, room, winner);
  broadcastWfState(ctx, roomCode, room);
}

/** +2 to every player on the winning team, 0 to the losers and to everyone on a draw. */
function awardWfScores(ctx, room, winner) {
  const participants = Object.entries(room.state.warfront.armies).map(([name, army]) => {
    const won = army.team === winner;
    if (won) ctx.addScore(room, name, WF_WIN_POINTS);
    return { name, team: army.team, won, points: won ? WF_WIN_POINTS : 0 };
  });
  ctx.recordGameResult(room, 'warfront', participants);
}

module.exports = {
  devMatchMs,
  wfLoops,
  stopLoop,
  startLoop,
  tickRoom,
  finishBattle,
  awardWfScores,
};
