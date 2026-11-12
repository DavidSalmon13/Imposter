'use strict';

const TS_MIN_PLAYERS = 2;
const TS_TARGET_MS = 10000;
const TS_COUNTDOWN_MS = 3000;
const TS_FORCE_STOP_MS = 30000; // 3x target — distracted players get a real (non-DNF) result

// Keys within room.state.tenseconds to persist (see docs/plans/yes-sketch-a-low-risk-quiet-chipmunk.md).
const SAVED_FIELDS = [
  'activePlayers',
  'contenders',
  'eliminatedOrder',
  'roundStartAt',
  'roundResults',
  'roundNumber',
  'suddenDeath',
  'eliminationWaves',
];

/** Ten Seconds' namespaced room state. Replaces the former flat room.ts* fields. */
function createState() {
  return {
    activePlayers: [], // names still in the bracket
    contenders: [], // names racing the current round (subset during sudden death)
    eliminatedOrder: [], // elimination order (reversed for final standings)
    roundStartAt: null, // epoch ms when stopwatches start (after 3s countdown)
    roundResults: {}, // name -> { elapsedMs, distanceMs, dnf }
    roundNumber: 0,
    suddenDeath: false,
    eliminationWaves: [], // each entry = names eliminated together in one resolution step
  };
}

/** @type {Map<string, NodeJS.Timeout>} */
const tsForceStopHandles = new Map();

function clearTsForceStopHandle(roomCode) {
  const handle = tsForceStopHandles.get(roomCode);
  if (handle) clearTimeout(handle);
  tsForceStopHandles.delete(roomCode);
}

function clearState(room, roomCode) {
  if (roomCode) clearTsForceStopHandle(roomCode);
  room.state.tenseconds = createState();
}

function tsDisconnectedActive(room) {
  return room.state.tenseconds.activePlayers.filter((n) => {
    const p = room.players.get(n);
    return !p || !p.connected;
  });
}

function tensSecondsStatePayload(ctx, room, viewerName) {
  const eliminated = room.state.tenseconds.eliminatedOrder.includes(viewerName);
  const isContender = room.state.tenseconds.contenders.includes(viewerName);
  const myResult = room.state.tenseconds.roundResults[viewerName] || null;
  const disconnected = tsDisconnectedActive(room);

  const standings =
    room.phase === 'gameover'
      ? [...room.state.tenseconds.activePlayers, ...[...room.state.tenseconds.eliminatedOrder].reverse()]
      : null;

  return {
    game: 'tenseconds',
    phase: room.phase,
    host: room.hostName,
    roundNumber: room.state.tenseconds.roundNumber,
    suddenDeath: room.state.tenseconds.suddenDeath,
    activePlayers: room.state.tenseconds.activePlayers.slice(),
    contenders: room.state.tenseconds.contenders.slice(),
    eliminatedOrder: room.state.tenseconds.eliminatedOrder.slice(),
    roundStartAt: room.state.tenseconds.roundStartAt,
    results: room.state.tenseconds.roundResults,
    standings,
    eliminated,
    isContender,
    myResult,
    waitingOn: disconnected,
    canStart:
      room.phase === 'ready' &&
      disconnected.length === 0 &&
      room.state.tenseconds.activePlayers.length >= TS_MIN_PLAYERS,
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
  room.state.tenseconds.activePlayers = (playerNames || ctx.connectedNames(room)).slice();
  room.state.tenseconds.contenders = [];
  room.state.tenseconds.eliminatedOrder = [];
  room.state.tenseconds.roundStartAt = null;
  room.state.tenseconds.roundResults = {};
  room.state.tenseconds.roundNumber = 0;
  room.state.tenseconds.suddenDeath = false;
  room.state.tenseconds.eliminationWaves = [];
  room.phase = 'ready';
  broadcastTensSeconds(ctx, roomCode, room);
}

function startTensSecondsRound(ctx, roomCode, room, { suddenDeath = false, contenders = null } = {}) {
  const racers = contenders || room.state.tenseconds.activePlayers.slice();
  if (racers.length < 1) return;

  clearTsForceStopHandle(roomCode);
  room.state.tenseconds.suddenDeath = suddenDeath;
  if (!suddenDeath) room.state.tenseconds.roundNumber += 1;
  room.state.tenseconds.contenders = racers.slice();
  room.state.tenseconds.roundResults = {};
  room.state.tenseconds.roundStartAt = Date.now() + TS_COUNTDOWN_MS;
  room.phase = 'running';
  scheduleTsForceStop(ctx, roomCode, room);
  broadcastTensSeconds(ctx, roomCode, room);
}

function scheduleTsForceStop(ctx, roomCode, room) {
  clearTsForceStopHandle(roomCode);
  if (!room.state.tenseconds.roundStartAt) return;
  const delay = room.state.tenseconds.roundStartAt + TS_FORCE_STOP_MS - Date.now();
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
  for (const name of room.state.tenseconds.contenders) {
    if (room.state.tenseconds.roundResults[name]) continue;
    room.state.tenseconds.roundResults[name] = {
      elapsedMs: TS_FORCE_STOP_MS,
      distanceMs: Math.abs(TS_FORCE_STOP_MS - TS_TARGET_MS),
      dnf: false,
    };
    changed = true;
  }
  if (changed) maybeResolveTsRound(ctx, roomCode, room);
}

function assignTsDnf(room, name) {
  if (!room.state.tenseconds.contenders.includes(name)) return false;
  if (room.state.tenseconds.roundResults[name] && !room.state.tenseconds.roundResults[name].dnf) return false;
  room.state.tenseconds.roundResults[name] = { elapsedMs: null, distanceMs: Number.POSITIVE_INFINITY, dnf: true };
  return true;
}

function submitTsStop(room, name, elapsedMs) {
  if (!room.state.tenseconds.contenders.includes(name)) return { ok: false, error: 'Not racing this round' };
  if (room.state.tenseconds.roundResults[name] && !room.state.tenseconds.roundResults[name].dnf) {
    return { ok: false, error: 'Already stopped' };
  }
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return { ok: false, error: 'Invalid time' };
  }
  const clamped = Math.min(elapsedMs, TS_FORCE_STOP_MS * 2);
  room.state.tenseconds.roundResults[name] = {
    elapsedMs: clamped,
    distanceMs: Math.abs(clamped - TS_TARGET_MS),
    dnf: false,
  };
  return { ok: true };
}

function allTsContendersIn(room) {
  return room.state.tenseconds.contenders.every((n) => !!room.state.tenseconds.roundResults[n]);
}

function maybeResolveTsRound(ctx, roomCode, room) {
  if (!allTsContendersIn(room)) return;
  clearTsForceStopHandle(roomCode);
  resolveTsRound(ctx, roomCode, room);
}

function resolveTsRound(ctx, roomCode, room) {
  const contenders = room.state.tenseconds.contenders.slice();
  const dnfNames = contenders.filter((n) => room.state.tenseconds.roundResults[n] && room.state.tenseconds.roundResults[n].dnf);
  const finished = contenders.filter((n) => room.state.tenseconds.roundResults[n] && !room.state.tenseconds.roundResults[n].dnf);

  // All remaining racers DNF → void the round, retry from ready with same active set.
  if (dnfNames.length === contenders.length) {
    room.state.tenseconds.suddenDeath = false;
    room.state.tenseconds.contenders = [];
    room.state.tenseconds.roundStartAt = null;
    room.state.tenseconds.roundResults = {};
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
    const d = room.state.tenseconds.roundResults[name].distanceMs;
    if (d > worstDistance) worstDistance = d;
  }
  const worst = finished.filter((n) => room.state.tenseconds.roundResults[n].distanceMs === worstDistance);

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
    if (!room.state.tenseconds.activePlayers.includes(name)) continue;
    room.state.tenseconds.activePlayers = room.state.tenseconds.activePlayers.filter((n) => n !== name);
    if (!room.state.tenseconds.eliminatedOrder.includes(name)) {
      room.state.tenseconds.eliminatedOrder.push(name);
      wave.push(name);
    }
  }
  if (wave.length) {
    if (!room.state.tenseconds.eliminationWaves) room.state.tenseconds.eliminationWaves = [];
    room.state.tenseconds.eliminationWaves.push(wave);
  }
}

function finishTsRoundResolution(ctx, roomCode, room) {
  room.state.tenseconds.suddenDeath = false;
  room.state.tenseconds.roundStartAt = null;
  room.phase = 'roundResults';
  broadcastTensSeconds(ctx, roomCode, room);
}

function awardTensSecondsScores(ctx, room) {
  const champion = room.state.tenseconds.activePlayers[0];
  if (!champion) return;
  const waves = room.state.tenseconds.eliminationWaves || [];
  const pointsByName = { [champion]: 2 };

  // Only one elimination wave (includes the 2-player case): that group is last place.
  if (waves.length === 1) {
    for (const name of waves[0]) pointsByName[name] = -1;
  } else if (waves.length > 1) {
    // Last wave = most recently eliminated = second place (+1).
    for (const name of waves[waves.length - 1]) pointsByName[name] = 1;
    // First wave = earliest eliminated = last place (-1).
    for (const name of waves[0]) pointsByName[name] = -1;
    // Middle waves get 0.
  }
  for (const [name, points] of Object.entries(pointsByName)) ctx.addScore(room, name, points);

  // Place: champion 1st, then waves from most recently eliminated; a wave shares a place.
  const participants = [{ name: champion, won: true, points: 2, details: { place: 1 } }];
  let place = 2;
  for (const wave of waves.slice().reverse()) {
    for (const name of wave) {
      participants.push({ name, won: false, points: pointsByName[name] || 0, details: { place } });
    }
    place += wave.length;
  }
  ctx.recordGameResult(room, 'tenseconds', participants);
}

function continueTsAfterResults(ctx, roomCode, room) {
  if (room.state.tenseconds.activePlayers.length <= 1) {
    room.phase = 'gameover';
    room.state.tenseconds.contenders = [];
    awardTensSecondsScores(ctx, room);
    broadcastTensSeconds(ctx, roomCode, room);
    return;
  }
  room.phase = 'ready';
  room.state.tenseconds.contenders = [];
  room.state.tenseconds.roundResults = {};
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
    room.state.tenseconds.contenders.includes(name) &&
    !room.state.tenseconds.roundResults[name]
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
    room.state.tenseconds.contenders.includes(name) &&
    room.state.tenseconds.roundResults[name] &&
    room.state.tenseconds.roundResults[name].dnf
  ) {
    delete room.state.tenseconds.roundResults[name];
  }
  broadcastTensSeconds(ctx, roomCode, room);
}

function repairOnLoad(ctx, room) {
  if (!Array.isArray(room.state.tenseconds.eliminationWaves)) room.state.tenseconds.eliminationWaves = [];
  if (room.phase !== 'running' || !room.state.tenseconds.roundStartAt || !ctx || !ctx.rooms) return;

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
    if (room.state.tenseconds.activePlayers.length < TS_MIN_PLAYERS) {
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
    if (!room.state.tenseconds.roundStartAt || Date.now() < room.state.tenseconds.roundStartAt) {
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
    // Connected players only (the default) - room.players also holds people who closed the app.
    initTensSecondsGame(ctx, roomCode, room);
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
  namespaces: [{ id: 'tenseconds', createState, savedFields: SAVED_FIELDS }],
  repairOnLoad,
  clearState,
};
