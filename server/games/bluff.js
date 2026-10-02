'use strict';

const { buildDeck } = require('./pokerEval');
const { shuffle } = require('../lib/shuffle');

const BF_MIN_PLAYERS = 2;
const BF_MAX_PLAYERS = 10;
const BF_LOSER_HIGHLIGHT_MS = 1500;
const BF_DEAL_ANIMATION_MS = 2200;

const SAVED_FIELDS = ['bfPlayers', 'bfCounts', 'bfRoundNumber', 'bfEliminationOrder'];

/** @type {Map<string, NodeJS.Timeout>} */
const bfTimers = new Map();

function clearBluffTimer(roomCode) {
  const handle = bfTimers.get(roomCode);
  if (handle) clearTimeout(handle);
  bfTimers.delete(roomCode);
}

function clearState(room, roomCode) {
  if (roomCode) clearBluffTimer(roomCode);
  room.bfPlayers = [];
  room.bfCounts = {};
  room.bfPendingStartCount = 0;
  room.bfRoundNumber = 0;
  room.bfEliminationOrder = [];
  room.bfHands = {};
  room.bfLastResult = null;
}

function activeBluffPlayers(room) {
  return room.bfPlayers.filter((n) => (room.bfCounts[n] || 0) > 0);
}

/**
 * Winner (the one active player) first, then bfEliminationOrder reversed - most-recently
 * eliminated ranks higher. No tie handling needed: elimination order is a strict total
 * order (exactly one loser per round), so every player gets a distinct rank.
 */
function computeBluffRanking(room) {
  const N = room.bfPlayers.length;
  const winner = activeBluffPlayers(room)[0] || null;
  const order = [winner, ...room.bfEliminationOrder.slice().reverse()].filter(Boolean);
  return order.map((name, index) => ({ name, points: N - index }));
}

function finishBluffMatch(ctx, roomCode, room) {
  const ranking = computeBluffRanking(room);
  for (const row of ranking) ctx.addScore(room, row.name, row.points);
  room.phase = 'gameover';
  broadcastBluff(ctx, roomCode, room);
}

/** Pure: 1..floor(52/connectedCount), defaulting to the max when `count` is missing/invalid. */
function clampStartingCount(count, connectedCount) {
  const max = Math.max(1, Math.floor(52 / Math.max(1, connectedCount)));
  const n = Number(count);
  if (!Number.isFinite(n)) return max;
  return Math.min(max, Math.max(1, Math.round(n)));
}

function bluffSeats(room) {
  return room.bfPlayers.map((name, seatIndex) => {
    const p = room.players.get(name);
    return {
      name,
      seatIndex,
      count: room.bfCounts[name] || 0,
      eliminated: (room.bfCounts[name] || 0) === 0,
      connected: !!(p && p.connected),
    };
  });
}

function bluffStatePayload(ctx, room, viewerName) {
  const connectedCount = ctx.connectedNames(room).length;
  const myHand = room.bfHands[viewerName] || null;

  return {
    game: 'bluff',
    phase: room.phase,
    host: room.hostName,
    seats: bluffSeats(room),
    roundNumber: room.bfRoundNumber,
    myHand: myHand ? myHand.slice() : null,
    lastResult: room.bfLastResult,
    startCountBounds:
      room.phase === 'seating'
        ? { min: 1, max: Math.max(1, Math.floor(52 / Math.max(1, connectedCount))) }
        : null,
    pendingStartCount: room.bfPendingStartCount,
    canStart:
      room.phase === 'seating' &&
      connectedCount >= BF_MIN_PLAYERS &&
      connectedCount <= BF_MAX_PLAYERS,
    canResetGame:
      viewerName === room.hostName && (room.phase === 'playing' || room.phase === 'gameover'),
    ranking: room.phase === 'gameover' ? computeBluffRanking(room) : undefined,
    scoreboard: room.phase === 'gameover' ? ctx.scoreboardEntries(room) : undefined,
  };
}

/**
 * Deals a fresh round to every player with cards left, off a freshly shuffled deck.
 * Leftover cards once every active player has their hand are simply unused (per spec).
 * Called both for round 1 (from startBluffMatch) and every later round (from
 * applyBluffLoss's scheduled timer, added in Step 3) — no round-1 special-casing.
 */
function dealBluffRound(ctx, roomCode, room) {
  const deck = shuffle(buildDeck());
  let idx = 0;
  const hands = {};
  for (const name of room.bfPlayers) {
    if ((room.bfCounts[name] || 0) <= 0) continue;
    hands[name] = deck.slice(idx, idx + room.bfCounts[name]);
    idx += room.bfCounts[name];
  }
  room.bfHands = hands;
  room.bfLastResult = null;
  room.bfRoundNumber += 1;
  broadcastBluff(ctx, roomCode, room);
}

/**
 * Records `name` as this round's loser, broadcasts the highlight immediately, then either
 * ends the match outright (if only one player has cards left - no further dealing, no
 * highlight pause) or schedules the next deal after the highlight + deal-animation pause.
 */
function applyBluffLoss(ctx, roomCode, room, name) {
  room.bfCounts[name] = (room.bfCounts[name] || 0) - 1;
  const newCount = room.bfCounts[name];
  const eliminated = newCount === 0;
  if (eliminated) room.bfEliminationOrder.push(name);
  room.bfLastResult = { loserName: name, newCount, eliminated };
  broadcastBluff(ctx, roomCode, room);

  clearBluffTimer(roomCode);

  if (activeBluffPlayers(room).length === 1) {
    finishBluffMatch(ctx, roomCode, room);
    return;
  }

  const handle = setTimeout(() => {
    bfTimers.delete(roomCode);
    dealBluffRound(ctx, roomCode, room);
  }, BF_LOSER_HIGHLIGHT_MS + BF_DEAL_ANIMATION_MS);
  bfTimers.set(roomCode, handle);
}

function broadcastBluff(ctx, roomCode, room) {
  for (const [name, p] of room.players.entries()) {
    if (!p.connected || !p.socketId) continue;
    ctx.io.to(p.socketId).emit('bluffState', bluffStatePayload(ctx, room, name));
  }
}

function onChoose(ctx, roomCode, room) {
  clearState(room, roomCode);
  room.phase = 'seating';
  broadcastBluff(ctx, roomCode, room);
}

function reconnectPayload(ctx, room, existingPlayer) {
  let viewerName = null;
  for (const [n, p] of room.players.entries()) {
    if (p === existingPlayer) {
      viewerName = n;
      break;
    }
  }
  return { ok: true, ...bluffStatePayload(ctx, room, viewerName) };
}

function onDisconnect(ctx, roomCode, room, name) {
  broadcastBluff(ctx, roomCode, room);
}

function onReconnectBroadcast(ctx, roomCode, room) {
  broadcastBluff(ctx, roomCode, room);
}

function registerHandlers(ctx, io, socket) {
  socket.on('bfSetStartingCount', (data, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'bluff' || room.phase !== 'seating') {
      return callback({ ok: false, error: 'Not in seating' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can set the starting count' });
    }

    const connectedCount = ctx.connectedNames(room).length;
    room.bfPendingStartCount = clampStartingCount(data && data.count, connectedCount);

    callback({ ok: true });
    broadcastBluff(ctx, roomCode, room);
  });

  socket.on('startBluffMatch', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'bluff' || room.phase !== 'seating') {
      return callback({ ok: false, error: 'Not ready to start' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can start' });
    }

    const names = ctx.connectedNames(room);
    if (names.length < BF_MIN_PLAYERS) {
      return callback({ ok: false, error: `Need at least ${BF_MIN_PLAYERS} players` });
    }
    if (names.length > BF_MAX_PLAYERS) {
      return callback({ ok: false, error: `Bluff supports at most ${BF_MAX_PLAYERS} players` });
    }

    // 0 is clearState's "never touched" sentinel - clampStartingCount(undefined, ...)
    // falls back to the slider's max, matching the spec's default.
    const startCount = clampStartingCount(room.bfPendingStartCount || undefined, names.length);
    room.bfPlayers = names;
    room.bfCounts = {};
    for (const name of names) room.bfCounts[name] = startCount;
    room.bfRoundNumber = 0;
    room.bfEliminationOrder = [];
    room.phase = 'playing';

    callback({ ok: true });
    dealBluffRound(ctx, roomCode, room);
  });

  socket.on('bfSelectLoser', (data, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'bluff' || room.phase !== 'playing') {
      return callback({ ok: false, error: 'Not playing right now' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can pick a loser' });
    }
    if (Object.keys(room.bfHands).length === 0 || room.bfLastResult != null) {
      return callback({ ok: false, error: 'No active round to act on' });
    }

    const name = data && data.name;
    if (!room.bfPlayers.includes(name) || (room.bfCounts[name] || 0) <= 0) {
      return callback({ ok: false, error: 'Invalid player' });
    }

    callback({ ok: true });
    applyBluffLoss(ctx, roomCode, room, name);
  });

  socket.on('bfResetGame', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'bluff' || (room.phase !== 'playing' && room.phase !== 'gameover')) {
      return callback({ ok: false, error: 'Nothing to reset' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can reset the game' });
    }

    clearBluffTimer(roomCode);
    room.bfCounts = {};
    room.bfRoundNumber = 0;
    room.bfEliminationOrder = [];
    room.bfHands = {};
    room.bfLastResult = null;
    room.phase = 'seating';

    callback({ ok: true });
    broadcastBluff(ctx, roomCode, room);
  });
}

/**
 * The roster is frozen and doesn't depend on who's currently connected (unlike AIOF), so a
 * mid-match restart can safely re-deal the current round right away - no "waiting for
 * players" gate. bfHands/bfLastResult aren't persisted (see roomStore.js), so there's
 * nothing to resume: a fresh deal off the persisted bfCounts is the only sane state.
 */
function repairOnLoad(ctx, room) {
  if (room.phase === 'seating') {
    if (!Number.isFinite(room.bfPendingStartCount) || room.bfPendingStartCount < 0) {
      room.bfPendingStartCount = 0;
    }
    return;
  }
  if (room.phase !== 'playing' || !ctx || !ctx.rooms) return;

  let roomCode = null;
  for (const [code, r] of ctx.rooms.entries()) {
    if (r === room) {
      roomCode = code;
      break;
    }
  }
  if (!roomCode) return;

  room.bfHands = {};
  room.bfLastResult = null;
  dealBluffRound(ctx, roomCode, room);
}

module.exports = {
  id: 'bluff',
  minPlayers: BF_MIN_PLAYERS,
  maxPlayers: BF_MAX_PLAYERS,
  onChoose,
  registerHandlers,
  reconnectPayload,
  onDisconnect,
  onReconnectBroadcast,
  savedFields: SAVED_FIELDS,
  repairOnLoad,
  clearState,
};
