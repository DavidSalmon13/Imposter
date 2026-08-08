'use strict';

const TS_MIN_PLAYERS = 2;
const TS_TARGET_MS = 10000;
const TS_COUNTDOWN_MS = 3000;
const TS_FORCE_STOP_MS = 30000; // 3x target — distracted players get a real (non-DNF) result

const SAVED_FIELDS = [
  'tsActivePlayers',
  'tsContenders',
  'tsEliminatedOrder',
  'tsRoundStartAt',
  'tsRoundResults',
  'tsRoundNumber',
  'tsSuddenDeath',
  'tsEliminationWaves',
];

/** @type {Map<string, NodeJS.Timeout>} */
const tsForceStopHandles = new Map();

function clearTsForceStopHandle(roomCode) {
  const handle = tsForceStopHandles.get(roomCode);
  if (handle) clearTimeout(handle);
  tsForceStopHandles.delete(roomCode);
}

function clearState(room, roomCode) {
  if (roomCode) clearTsForceStopHandle(roomCode);
  room.tsActivePlayers = [];
  room.tsContenders = [];
  room.tsEliminatedOrder = [];
  room.tsRoundStartAt = null;
  room.tsRoundResults = {};
  room.tsRoundNumber = 0;
  room.tsSuddenDeath = false;
  room.tsEliminationWaves = [];
}

function tsDisconnectedActive(room) {
  return room.tsActivePlayers.filter((n) => {
    const p = room.players.get(n);
    return !p || !p.connected;
  });
}

function tensSecondsStatePayload(ctx, room, viewerName) {
  const eliminated = room.tsEliminatedOrder.includes(viewerName);
  const isContender = room.tsContenders.includes(viewerName);
  const myResult = room.tsRoundResults[viewerName] || null;
  const disconnected = tsDisconnectedActive(room);

  const standings =
    room.phase === 'gameover'
      ? [...room.tsActivePlayers, ...[...room.tsEliminatedOrder].reverse()]
      : null;

  return {
    game: 'tenseconds',
    phase: room.phase,
    host: room.hostName,
    roundNumber: room.tsRoundNumber,
    suddenDeath: room.tsSuddenDeath,
    activePlayers: room.tsActivePlayers.slice(),
    contenders: room.tsContenders.slice(),
    eliminatedOrder: room.tsEliminatedOrder.slice(),
    roundStartAt: room.tsRoundStartAt,
    results: room.tsRoundResults,
    standings,
    eliminated,
    isContender,
    myResult,
    waitingOn: disconnected,
    canStart:
      room.phase === 'ready' &&
      disconnected.length === 0 &&
      room.tsActivePlayers.length >= TS_MIN_PLAYERS,
    scoreboard: room.phase === 'gameover' ? ctx.scoreboardEntries(room) : undefined,
  };
}

function broadcastTensSeconds(ctx, roomCode, room) {
  for (const [name, p] of room.players.entries()) {
    if (!p.connected || !p.socketId) continue;
    ctx.io.to(p.socketId).emit('tensSecondsState', tensSecondsStatePayload(ctx, room, name));
  }
}

function initTensSecondsGame(ctx, roomCode, room, playerNames) {
  clearTsForceStopHandle(roomCode);
  room.tsActivePlayers = (playerNames || ctx.connectedNames(room)).slice();
  room.tsContenders = [];
  room.tsEliminatedOrder = [];
  room.tsRoundStartAt = null;
  room.tsRoundResults = {};
  room.tsRoundNumber = 0;
  room.tsSuddenDeath = false;
  room.tsEliminationWaves = [];
  room.phase = 'ready';
  broadcastTensSeconds(ctx, roomCode, room);
}

function startTensSecondsRound(ctx, roomCode, room, { suddenDeath = false, contenders = null } = {}) {
  const racers = contenders || room.tsActivePlayers.slice();
  if (racers.length < 1) return;

  clearTsForceStopHandle(roomCode);
  room.tsSuddenDeath = suddenDeath;
  if (!suddenDeath) room.tsRoundNumber += 1;
  room.tsContenders = racers.slice();
  room.tsRoundResults = {};
  room.tsRoundStartAt = Date.now() + TS_COUNTDOWN_MS;
  room.phase = 'running';
  scheduleTsForceStop(ctx, roomCode, room);
  broadcastTensSeconds(ctx, roomCode, room);
}

function scheduleTsForceStop(ctx, roomCode, room) {
  clearTsForceStopHandle(roomCode);
  if (!room.tsRoundStartAt) return;
  const delay = room.tsRoundStartAt + TS_FORCE_STOP_MS - Date.now();
  if (delay <= 0) {
    applyTsForceStops(ctx, roomCode);
    return;
  }
  tsForceStopHandles.set(
    roomCode,
    setTimeout(() => applyTsForceStops(ctx, roomCode), delay)
  );
}

function applyTsForceStops(ctx, roomCode) {
  const room = ctx.rooms.get(roomCode);
  if (!room || room.game !== 'tenseconds' || room.phase !== 'running') return;

  let changed = false;
  for (const name of room.tsContenders) {
    if (room.tsRoundResults[name]) continue;
    room.tsRoundResults[name] = {
      elapsedMs: TS_FORCE_STOP_MS,
      distanceMs: Math.abs(TS_FORCE_STOP_MS - TS_TARGET_MS),
      dnf: false,
    };
    changed = true;
  }
  if (changed) maybeResolveTsRound(ctx, roomCode, room);
}

function assignTsDnf(room, name) {
  if (!room.tsContenders.includes(name)) return false;
  if (room.tsRoundResults[name] && !room.tsRoundResults[name].dnf) return false;
  room.tsRoundResults[name] = { elapsedMs: null, distanceMs: Number.POSITIVE_INFINITY, dnf: true };
  return true;
}

function submitTsStop(room, name, elapsedMs) {
  if (!room.tsContenders.includes(name)) return { ok: false, error: 'Not racing this round' };
  if (room.tsRoundResults[name] && !room.tsRoundResults[name].dnf) {
    return { ok: false, error: 'Already stopped' };
  }
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return { ok: false, error: 'Invalid time' };
  }
  const clamped = Math.min(elapsedMs, TS_FORCE_STOP_MS * 2);
  room.tsRoundResults[name] = {
    elapsedMs: clamped,
    distanceMs: Math.abs(clamped - TS_TARGET_MS),
    dnf: false,
  };
  return { ok: true };
}

function allTsContendersIn(room) {
  return room.tsContenders.every((n) => !!room.tsRoundResults[n]);
}

function maybeResolveTsRound(ctx, roomCode, room) {
  if (!allTsContendersIn(room)) return;
  clearTsForceStopHandle(roomCode);
  resolveTsRound(ctx, roomCode, room);
}

function resolveTsRound(ctx, roomCode, room) {
  const contenders = room.tsContenders.slice();
  const dnfNames = contenders.filter((n) => room.tsRoundResults[n] && room.tsRoundResults[n].dnf);
  const finished = contenders.filter((n) => room.tsRoundResults[n] && !room.tsRoundResults[n].dnf);

  // All remaining racers DNF → void the round, retry from ready with same active set.
  if (dnfNames.length === contenders.length) {
    room.tsSuddenDeath = false;
    room.tsContenders = [];
    room.tsRoundStartAt = null;
    room.tsRoundResults = {};
    room.phase = 'ready';
    broadcastTensSeconds(ctx, roomCode, room);
    return;
  }

  // Multiple DNFs: eliminate all of them together (exception to one-elimination rule).
  if (dnfNames.length >= 2) {
    eliminateTsPlayers(room, dnfNames);
    finishTsRoundResolution(ctx, roomCode, room);
    return;
  }

  if (dnfNames.length === 1) {
    eliminateTsPlayers(room, dnfNames);
    finishTsRoundResolution(ctx, roomCode, room);
    return;
  }

  let worstDistance = -1;
  for (const name of finished) {
    const d = room.tsRoundResults[name].distanceMs;
    if (d > worstDistance) worstDistance = d;
  }
  const worst = finished.filter((n) => room.tsRoundResults[n].distanceMs === worstDistance);

  if (worst.length >= 2) {
    startTensSecondsRound(ctx, roomCode, room, { suddenDeath: true, contenders: worst });
    return;
  }

  eliminateTsPlayers(room, worst);
  finishTsRoundResolution(ctx, roomCode, room);
}

function eliminateTsPlayers(room, names) {
  const wave = [];
  for (const name of names) {
    if (!room.tsActivePlayers.includes(name)) continue;
    room.tsActivePlayers = room.tsActivePlayers.filter((n) => n !== name);
    if (!room.tsEliminatedOrder.includes(name)) {
      room.tsEliminatedOrder.push(name);
      wave.push(name);
    }
  }
  if (wave.length) {
    if (!room.tsEliminationWaves) room.tsEliminationWaves = [];
    room.tsEliminationWaves.push(wave);
  }
}

function finishTsRoundResolution(ctx, roomCode, room) {
  room.tsSuddenDeath = false;
  room.tsRoundStartAt = null;
  room.phase = 'roundResults';
  broadcastTensSeconds(ctx, roomCode, room);
}

function awardTensSecondsScores(ctx, room) {
  const champion = room.tsActivePlayers[0];
  if (!champion) return;

  ctx.addScore(room, champion, 2);

  const waves = room.tsEliminationWaves || [];
  if (waves.length === 0) return;

  // Only one elimination wave (includes the 2-player case): that group is last place.
  if (waves.length === 1) {
    for (const name of waves[0]) ctx.addScore(room, name, -1);
    return;
  }

  // Last wave = most recently eliminated = second place (+1).
  for (const name of waves[waves.length - 1]) ctx.addScore(room, name, 1);
  // First wave = earliest eliminated = last place (-1).
  for (const name of waves[0]) ctx.addScore(room, name, -1);
  // Middle waves get 0.
}

function continueTsAfterResults(ctx, roomCode, room) {
  if (room.tsActivePlayers.length <= 1) {
    room.phase = 'gameover';
    room.tsContenders = [];
    awardTensSecondsScores(ctx, room);
    broadcastTensSeconds(ctx, roomCode, room);
    return;
  }
  room.phase = 'ready';
  room.tsContenders = [];
  room.tsRoundResults = {};
  broadcastTensSeconds(ctx, roomCode, room);
}

function onChoose(ctx, roomCode, room) {
  initTensSecondsGame(ctx, roomCode, room);
}

function reconnectPayload(ctx, room, existingPlayer) {
  let viewerName = null;
  for (const [n, p] of room.players.entries()) {
    if (p === existingPlayer) {
      viewerName = n;
      break;
    }
  }
  return { ok: true, ...tensSecondsStatePayload(ctx, room, viewerName) };
}

function onDisconnect(ctx, roomCode, room, name) {
  if (
    room.phase === 'running' &&
    room.tsContenders.includes(name) &&
    !room.tsRoundResults[name]
  ) {
    assignTsDnf(room, name);
    broadcastTensSeconds(ctx, roomCode, room);
    maybeResolveTsRound(ctx, roomCode, room);
  } else {
    broadcastTensSeconds(ctx, roomCode, room);
  }
}

function onReconnectBroadcast(ctx, roomCode, room, name) {
  // Clear a mid-round DNF so a reconnecting player can still submit a live stop.
  if (
    name &&
    room.phase === 'running' &&
    room.tsContenders.includes(name) &&
    room.tsRoundResults[name] &&
    room.tsRoundResults[name].dnf
  ) {
    delete room.tsRoundResults[name];
  }
  broadcastTensSeconds(ctx, roomCode, room);
}

function repairOnLoad(ctx, room) {
  if (!Array.isArray(room.tsEliminationWaves)) room.tsEliminationWaves = [];
  if (room.phase !== 'running' || !room.tsRoundStartAt || !ctx || !ctx.rooms) return;

  let roomCode = null;
  for (const [code, r] of ctx.rooms.entries()) {
    if (r === room) {
      roomCode = code;
      break;
    }
  }
  if (roomCode) scheduleTsForceStop(ctx, roomCode, room);
}

function registerHandlers(ctx, io, socket) {
  socket.on('startTensSeconds', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'tenseconds' || room.phase !== 'ready') {
      return callback({ ok: false, error: 'Not ready to start' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can start the round' });
    }
    if (room.tsActivePlayers.length < TS_MIN_PLAYERS) {
      return callback({ ok: false, error: `Need at least ${TS_MIN_PLAYERS} players` });
    }
    const waiting = tsDisconnectedActive(room);
    if (waiting.length > 0) {
      return callback({ ok: false, error: `Waiting for ${waiting.join(', ')} to reconnect` });
    }

    callback({ ok: true });
    startTensSecondsRound(ctx, roomCode, room);
  });

  socket.on('tsStop', (elapsedMs, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'tenseconds' || room.phase !== 'running') {
      return callback({ ok: false, error: 'Round is not running' });
    }
    if (!room.tsRoundStartAt || Date.now() < room.tsRoundStartAt) {
      return callback({ ok: false, error: 'Countdown still in progress' });
    }

    const name = socket.data.name;
    const result = submitTsStop(room, name, Number(elapsedMs));
    if (!result.ok) return callback(result);

    callback({ ok: true });
    broadcastTensSeconds(ctx, roomCode, room);
    maybeResolveTsRound(ctx, roomCode, room);
  });

  socket.on('tsContinue', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'tenseconds' || room.phase !== 'roundResults') {
      return callback({ ok: false, error: 'No results to continue from' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can continue' });
    }

    callback({ ok: true });
    continueTsAfterResults(ctx, roomCode, room);
  });

  socket.on('playAgainTensSeconds', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'tenseconds' || room.phase !== 'gameover') {
      return callback({ ok: false, error: 'Game is not over yet' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can play again' });
    }
    if (ctx.connectedNames(room).length < TS_MIN_PLAYERS) {
      return callback({ ok: false, error: `Need at least ${TS_MIN_PLAYERS} players` });
    }

    callback({ ok: true });
    initTensSecondsGame(ctx, roomCode, room, Array.from(room.players.keys()));
  });
}

module.exports = {
  id: 'tenseconds',
  minPlayers: TS_MIN_PLAYERS,
  maxPlayers: null,
  onChoose,
  registerHandlers,
  reconnectPayload,
  onDisconnect,
  onReconnectBroadcast,
  savedFields: SAVED_FIELDS,
  repairOnLoad,
  clearState,
};
