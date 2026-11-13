'use strict';

// Warfront shell: socket handlers. Each one guards room/game/phase/authority, then calls
// the engine or another shell module, and answers callback({ ok, error }).
// Must NOT contain: rules (engine) or payload building (payloads.js). Spec: "Commands".

const { WF_MAX_TEAM_SIZE, TEAMS } = require('./constants');
const { teamMembers, startBlocker, canCommandMatch } = require('./roster');
const { broadcastWfState } = require('./payloads');
const { generateBattle } = require('./battlefield');
const { stopLoop } = require('./loop');
const { shuffle } = require('../../lib/shuffle');
const engine = require('./engine');

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
/**
 * Wraps a handler with the shared guards: in a room, Warfront chosen, the right
 * phase, and a joined player. `fn({ room, roomCode, name, p, data })` returns an
 * error string or nothing; on success the room is re-broadcast.
 */
function teamSelectHandler(ctx, socket, fn) {
  return (data, callback) => {
    if (typeof data === 'function') {
      callback = data;
      data = undefined;
    }
    callback = typeof callback === 'function' ? callback : () => {};
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'warfront' || room.phase !== 'teamSelect') {
      return callback({ ok: false, error: 'Not choosing teams right now' });
    }
    const name = socket.data.name;
    const p = room.players.get(name);
    if (!p) return callback({ ok: false, error: 'Not joined' });
    const error = fn({ room, roomCode, name, p, data });
    if (error) return callback({ ok: false, error });
    callback({ ok: true });
    broadcastWfState(ctx, roomCode, room);
  };
}

function registerHandlers(ctx, io, socket) {
  socket.on('joinWfTeam', teamSelectHandler(ctx, socket, ({ room, p, data }) => {
    if (!TEAMS.includes(data)) return 'Invalid team';
    if (p.team === data) return null;
    if (teamMembers(ctx, room, data).length >= WF_MAX_TEAM_SIZE) return 'That team is full';
    p.team = data;
    p.leader = false;
    return null;
  }));

  socket.on('claimWfCaptain', teamSelectHandler(ctx, socket, ({ room, name, p }) => {
    if (!p.team) return 'Join a team first';
    const current = teamMembers(ctx, room, p.team).find((n) => room.players.get(n).leader);
    if (current && current !== name) return 'This team already has a captain';
    p.leader = true;
    return null;
  }));

  socket.on('setWfRace', teamSelectHandler(ctx, socket, ({ room, name, data }) => {
    if (!engine.RACES[data]) return 'Invalid race';
    room.state.warfront.lobbyRaces[name] = data;
    return null;
  }));

  socket.on('setWfOptions', teamSelectHandler(ctx, socket, ({ room, name, data }) => {
    if (name !== room.hostName) return 'Only the host can change the settings';
    if (!data || typeof data !== 'object') return 'Invalid options';
    const { matchLength, mapSize } = data;
    if (matchLength !== undefined && !engine.MATCH_LENGTHS[matchLength]) return 'Invalid match length';
    if (mapSize !== undefined && !engine.MAP_SIZES[mapSize]) return 'Invalid map size';
    const cfg = room.state.warfront.phaseConfig;
    if (matchLength !== undefined) cfg.matchCapMs = engine.MATCH_LENGTHS[matchLength].ms;
    if (mapSize !== undefined) cfg.mapSize = mapSize;
    return null;
  }));

  socket.on('randomizeWfTeams', teamSelectHandler(ctx, socket, ({ room, name }) => {
    if (name !== room.hostName) return 'Only the host can randomize teams';
    // Alternate over a shuffled roster so sizes differ by at most one; captains are
    // cleared since their teams no longer exist. Races are untouched.
    const first = Math.random() < 0.5 ? 'red' : 'blue';
    const second = first === 'red' ? 'blue' : 'red';
    shuffle(ctx.connectedNames(room)).forEach((n, i) => {
      const pl = room.players.get(n);
      pl.team = i % 2 === 0 ? first : second;
      pl.leader = false;
    });
    return null;
  }));

  socket.on('startWarfront', (callback) => {
    callback = typeof callback === 'function' ? callback : () => {};
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'warfront' || room.phase !== 'teamSelect') {
      return callback({ ok: false, error: 'Not choosing teams right now' });
    }
    if (!canCommandMatch(room, socket.data.name)) {
      return callback({ ok: false, error: 'Only the host or a captain can start the battle' });
    }
    const blocker = startBlocker(ctx, room);
    if (blocker) return callback({ ok: false, error: blocker });

    callback({ ok: true });
    generateBattle(ctx, roomCode, room);
  });

  // Play Again: a fresh map, the same teams and races (D1: host or either captain).
  socket.on('playAgainWarfront', (callback) => {
    callback = typeof callback === 'function' ? callback : () => {};
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'warfront' || room.phase !== 'gameover') {
      return callback({ ok: false, error: 'The battle is not over yet' });
    }
    if (!canCommandMatch(room, socket.data.name)) {
      return callback({ ok: false, error: 'Only the host or a captain can start the next battle' });
    }
    const blocker = startBlocker(ctx, room);
    if (blocker) return callback({ ok: false, error: blocker });

    callback({ ok: true });
    generateBattle(ctx, roomCode, room);
  });

  // Restart mid-battle (in-game menu): abandon the running battle, no points awarded, and
  // regenerate a fresh map with the same teams and races. Host or either captain, like Play Again.
  socket.on('restartWarfront', (callback) => {
    callback = typeof callback === 'function' ? callback : () => {};
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'warfront' || room.phase !== 'playing') {
      return callback({ ok: false, error: 'No battle running' });
    }
    if (!canCommandMatch(room, socket.data.name)) {
      return callback({ ok: false, error: 'Only the host or a captain can restart the battle' });
    }
    const blocker = startBlocker(ctx, room);
    if (blocker) return callback({ ok: false, error: blocker });

    stopLoop(roomCode);
    callback({ ok: true });
    generateBattle(ctx, roomCode, room);
  });

  // Live orders (move, hold, produce, haul, build, craft, weapon). Applied the instant they arrive; the next tick shows the result,
  // so there's no broadcast here.
  socket.on('wfCommand', (cmd, callback) => {
    callback = typeof callback === 'function' ? callback : () => {};
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'warfront' || room.phase !== 'playing') {
      return callback({ ok: false, error: 'No battle running' });
    }
    const wf = room.state.warfront;
    const name = socket.data.name;
    if (!wf.armies[name]) return callback({ ok: false, error: 'You have no army in this battle' });
    const res = engine.applyCommand(wf, name, cmd, Date.now());
    callback(res.ok ? { ok: true } : { ok: false, error: res.error });
  });
}

module.exports = {
  registerHandlers,
};
