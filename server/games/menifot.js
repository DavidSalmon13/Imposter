'use strict';

const { buildDeck, rankBoard } = require('./menifot-eval');
const { shuffle } = require('../lib/shuffle');

const MF_MIN_PLAYERS = 2;
const MF_MAX_PLAYERS = 8;
const MF_THREE_BOARD_MAX_PLAYERS = 3;
const MF_TARGET_SCORE = 10;

const SAVED_FIELDS = [
  'mfPlayers',
  'mfBoardCount',
  'mfBoards',
  'mfHands',
  'mfBurned',
  'mfScores',
  'mfRoundNumber',
  'mfRoundResults',
  'mfMatchWinners',
];

function clearState(room) {
  room.mfPlayers = [];
  room.mfBoardCount = 0;
  room.mfBoards = [];
  room.mfHands = {};
  room.mfBurned = [];
  room.mfScores = {};
  room.mfRoundNumber = 0;
  room.mfRoundResults = null;
  room.mfMatchWinners = [];
}

function emptyMfAllocation(boardCount) {
  const allocation = {};
  for (let i = 0; i < boardCount; i++) allocation[i] = [];
  return allocation;
}

function mfAllocationCounts(hand, boardCount) {
  const counts = [];
  for (let i = 0; i < boardCount; i++) {
    counts.push((hand.allocation[i] || hand.allocation[String(i)] || []).length);
  }
  return counts;
}

/** Final per-board size bounds for an even (±1) split of totalCards across boardCount boards. */
function mfBoardLimits(totalCards, boardCount) {
  const lo = Math.floor(totalCards / boardCount);
  const hi = Math.ceil(totalCards / boardCount);
  const hiSlots = totalCards % boardCount; // boards allowed at `hi` when hi > lo
  return { lo, hi, hiSlots };
}

/**
 * Whether a (possibly partial) allocation can still finish as a valid ±1 split.
 * Used to proactively reject illegal board taps before Lock.
 */
function mfCountsFeasible(counts, totalCards) {
  const boardCount = counts.length;
  if (boardCount < 1) return false;
  const { lo, hi, hiSlots } = mfBoardLimits(totalCards, boardCount);
  if (counts.some((c) => c < 0 || c > hi)) return false;

  const assigned = counts.reduce((a, b) => a + b, 0);
  if (assigned > totalCards) return false;
  const unassigned = totalCards - assigned;

  if (hi > lo) {
    const atHi = counts.filter((c) => c >= hi).length;
    if (atHi > hiSlots) return false;
  }

  const maxPlaceable = counts.reduce((s, c) => s + (hi - c), 0);
  if (unassigned > maxPlaceable) return false;

  let minNeeded = 0;
  for (const c of counts) {
    if (c < lo) minNeeded += lo - c;
  }
  if (minNeeded > unassigned) return false;

  return true;
}

function mfAllocationValid(hand, boardCount) {
  const assigned = [];
  for (let i = 0; i < boardCount; i++) {
    for (const c of hand.allocation[i] || hand.allocation[String(i)] || []) assigned.push(c);
  }
  if (assigned.length !== hand.cards.length) return false;
  const set = new Set(assigned);
  if (set.size !== assigned.length) return false;
  for (const c of hand.cards) {
    if (!set.has(c)) return false;
  }
  const counts = mfAllocationCounts(hand, boardCount);
  return Math.max(...counts) - Math.min(...counts) <= 1;
}

function mfCommunityCards(board) {
  return [...board.flop, board.turn, board.river];
}

function dealMenifotRound(room) {
  const playerCount = room.mfPlayers.length;
  const boardCount = room.mfBoardCount;
  const deck = shuffle(buildDeck());
  let idx = 0;

  const boards = [];
  for (let b = 0; b < boardCount; b++) {
    boards.push({
      flop: [deck[idx++], deck[idx++], deck[idx++]],
      turn: deck[idx++],
      river: deck[idx++],
      turnRevealed: false,
      riverRevealed: false,
    });
  }

  const remaining = deck.length - idx;
  const burnCount = remaining % playerCount;
  const burned = [];
  for (let i = 0; i < burnCount; i++) burned.push(deck[idx++]);

  const cardsPerPlayer = (remaining - burnCount) / playerCount;
  const hands = {};
  for (const name of room.mfPlayers) {
    const cards = [];
    for (let i = 0; i < cardsPerPlayer; i++) cards.push(deck[idx++]);
    hands[name] = {
      cards,
      allocation: emptyMfAllocation(boardCount),
      locked: false,
    };
  }

  room.mfBoards = boards;
  room.mfBurned = burned;
  room.mfHands = hands;
  room.mfRoundResults = null;
  room.mfRoundNumber += 1;
}

function autoLockEvenSplit(hand, boardCount) {
  const allocation = emptyMfAllocation(boardCount);
  hand.cards.forEach((card, i) => {
    allocation[i % boardCount].push(card);
  });
  hand.allocation = allocation;
  hand.locked = true;
}

function menifotPublicBoards(room) {
  return room.mfBoards.map((b) => ({
    flop: b.flop.slice(),
    turn: b.turnRevealed ? b.turn : null,
    river: b.riverRevealed ? b.river : null,
    turnRevealed: !!b.turnRevealed,
    riverRevealed: !!b.riverRevealed,
  }));
}

function menifotLockStatus(room) {
  return room.mfPlayers.map((name) => {
    const hand = room.mfHands[name];
    const p = room.players.get(name);
    return {
      name,
      locked: !!(hand && hand.locked),
      connected: !!(p && p.connected),
    };
  });
}

function menifotStatePayload(ctx, room, viewerName) {
  const inMatch = room.mfPlayers.includes(viewerName);
  const hand = room.mfHands[viewerName] || null;
  const scores = {};
  for (const name of room.mfPlayers) scores[name] = room.mfScores[name] || 0;

  const standings =
    room.phase === 'gameover'
      ? room.mfPlayers
          .slice()
          .map((name) => ({ name, score: room.mfScores[name] || 0 }))
          .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      : null;

  return {
    game: 'menifot',
    phase: room.phase,
    host: room.hostName,
    boardCount: room.mfBoardCount,
    players: room.mfPlayers.slice(),
    roundNumber: room.mfRoundNumber,
    scores,
    boards: menifotPublicBoards(room),
    burned: room.phase === 'roundResults' || room.phase === 'gameover' ? room.mfBurned.slice() : [],
    lockStatus: menifotLockStatus(room),
    myHand: hand
      ? {
          cards: hand.cards.slice(),
          allocation: Object.fromEntries(
            Object.entries(hand.allocation).map(([k, v]) => [k, v.slice()])
          ),
          locked: !!hand.locked,
        }
      : null,
    inMatch,
    roundResults: room.mfRoundResults,
    matchWinners: room.mfMatchWinners.slice(),
    standings,
    canStart:
      room.phase === 'ready' &&
      (room.mfPlayers.length > 0 ||
        (ctx.connectedNames(room).length >= MF_MIN_PLAYERS &&
          ctx.connectedNames(room).length <= MF_MAX_PLAYERS)),
    scoreboard: room.phase === 'gameover' ? ctx.scoreboardEntries(room) : undefined,
  };
}

function broadcastMenifot(ctx, roomCode, room) {
  for (const [name, p] of room.players.entries()) {
    if (!p.connected || !p.socketId) continue;
    ctx.io.to(p.socketId).emit('menifotState', menifotStatePayload(ctx, room, name));
  }
}

function startMenifotMatch(ctx, roomCode, room, playerNames) {
  const names = (playerNames || ctx.connectedNames(room)).slice();
  if (names.length < MF_MIN_PLAYERS || names.length > MF_MAX_PLAYERS) return false;

  room.mfPlayers = names;
  room.mfBoardCount = names.length <= MF_THREE_BOARD_MAX_PLAYERS ? 3 : 2;
  room.mfScores = {};
  for (const name of names) room.mfScores[name] = 0;
  room.mfRoundNumber = 0;
  room.mfMatchWinners = [];
  room.mfRoundResults = null;
  dealMenifotRound(room);
  room.phase = 'allocating';

  // Auto-lock anyone already disconnected at deal time.
  for (const name of room.mfPlayers) {
    const p = room.players.get(name);
    if (!p || !p.connected) {
      autoLockEvenSplit(room.mfHands[name], room.mfBoardCount);
    }
  }
  broadcastMenifot(ctx, roomCode, room);
  return true;
}

function startMenifotNextRound(ctx, roomCode, room) {
  dealMenifotRound(room);
  room.phase = 'allocating';
  for (const name of room.mfPlayers) {
    const p = room.players.get(name);
    if (!p || !p.connected) {
      autoLockEvenSplit(room.mfHands[name], room.mfBoardCount);
    }
  }
  broadcastMenifot(ctx, roomCode, room);
}

function setMfCardBoard(hand, card, boardIndex, boardCount) {
  if (hand.locked) return { ok: false, error: 'Hand is locked' };
  if (!hand.cards.includes(card)) return { ok: false, error: 'Card not in hand' };

  const next = emptyMfAllocation(boardCount);
  for (let i = 0; i < boardCount; i++) {
    for (const c of hand.allocation[i] || hand.allocation[String(i)] || []) {
      if (c !== card) next[i].push(c);
    }
  }

  if (boardIndex !== null && boardIndex !== undefined && boardIndex !== -1) {
    const bi = Number(boardIndex);
    if (!Number.isInteger(bi) || bi < 0 || bi >= boardCount) {
      return { ok: false, error: 'Invalid board' };
    }
    next[bi].push(card);
  }

  const counts = [];
  for (let i = 0; i < boardCount; i++) counts.push(next[i].length);
  if (!mfCountsFeasible(counts, hand.cards.length)) {
    return { ok: false, error: 'That board can’t take another card (±1 rule)' };
  }

  hand.allocation = next;
  return { ok: true };
}

function lockMfHand(room, name) {
  const hand = room.mfHands[name];
  if (!hand) return { ok: false, error: 'Not in this match' };
  if (hand.locked) return { ok: false, error: 'Already locked' };
  if (!mfAllocationValid(hand, room.mfBoardCount)) {
    return { ok: false, error: 'Assign every card with board counts differing by at most 1' };
  }
  hand.locked = true;
  return { ok: true };
}

function allMfLocked(room) {
  return room.mfPlayers.every((name) => room.mfHands[name] && room.mfHands[name].locked);
}

function awardMenifotScoreboard(ctx, room) {
  const N = room.mfPlayers.length;
  if (N < 1) return;
  const ranked = room.mfPlayers
    .map((name) => ({ name, score: room.mfScores[name] || 0 }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  let i = 0;
  while (i < ranked.length) {
    let j = i + 1;
    while (j < ranked.length && ranked[j].score === ranked[i].score) j += 1;
    const points = N - i;
    for (let k = i; k < j; k++) ctx.addScore(room, ranked[k].name, points);
    i = j;
  }
}

function finalizeMenifotRound(ctx, roomCode, room) {
  const boardResults = [];
  const pointsAwarded = {};
  for (const name of room.mfPlayers) pointsAwarded[name] = 0;

  for (let bi = 0; bi < room.mfBoardCount; bi++) {
    const board = room.mfBoards[bi];
    const community = mfCommunityCards(board);
    const playersOnBoard = room.mfPlayers.map((name) => ({
      name,
      holeCards: (room.mfHands[name].allocation[bi] || []).slice(),
      boardCards: community,
    }));
    const { winners, rankings } = rankBoard(playersOnBoard);
    for (const w of winners) pointsAwarded[w] = (pointsAwarded[w] || 0) + 1;
    boardResults.push({ boardIndex: bi, winners, rankings });
  }

  for (const name of room.mfPlayers) {
    room.mfScores[name] = (room.mfScores[name] || 0) + (pointsAwarded[name] || 0);
  }

  room.mfRoundResults = {
    boards: boardResults,
    pointsAwarded,
    burned: room.mfBurned.slice(),
    allocations: Object.fromEntries(
      room.mfPlayers.map((name) => [
        name,
        Object.fromEntries(
          Object.entries(room.mfHands[name].allocation).map(([k, v]) => [k, v.slice()])
        ),
      ])
    ),
  };

  const reached = room.mfPlayers.filter((n) => (room.mfScores[n] || 0) >= MF_TARGET_SCORE);
  if (reached.length > 0) {
    room.mfMatchWinners = reached.slice();
    awardMenifotScoreboard(ctx, room);
    room.phase = 'gameover';
  } else {
    room.phase = 'roundResults';
  }

  broadcastMenifot(ctx, roomCode, room);
}

// Once everyone has locked, the host reveals each board's turn and river by tapping the
// face-down card (turn before river, per board). Stays in the 'allocating' phase the
// whole time — every hand is already locked, so no further allocation moves are
// possible, and the client renders locked boards read-only aside from the host's taps.
function revealMfCard(room, boardIndex, part) {
  if (!allMfLocked(room)) return { ok: false, error: 'Waiting for everyone to lock' };
  const board = room.mfBoards[boardIndex];
  if (!board) return { ok: false, error: 'Invalid board' };
  if (part !== 'turn' && part !== 'river') return { ok: false, error: 'Invalid card' };

  const key = part === 'turn' ? 'turnRevealed' : 'riverRevealed';
  if (board[key]) return { ok: false, error: 'Already revealed' };
  if (part === 'river' && !board.turnRevealed) {
    return { ok: false, error: 'Reveal the turn first' };
  }

  board[key] = true;
  return { ok: true };
}

function onChoose(ctx, roomCode, room) {
  clearState(room);
  room.phase = 'ready';
  broadcastMenifot(ctx, roomCode, room);
}

function reconnectPayload(ctx, room, existingPlayer) {
  let viewerName = null;
  for (const [n, p] of room.players.entries()) {
    if (p === existingPlayer) {
      viewerName = n;
      break;
    }
  }
  return { ok: true, ...menifotStatePayload(ctx, room, viewerName) };
}

function onDisconnect(ctx, roomCode, room, name) {
  if (room.phase === 'allocating' && room.mfHands[name] && !room.mfHands[name].locked) {
    autoLockEvenSplit(room.mfHands[name], room.mfBoardCount);
  }
  broadcastMenifot(ctx, roomCode, room);
}

function onReconnectBroadcast(ctx, roomCode, room) {
  broadcastMenifot(ctx, roomCode, room);
}

function repairOnLoad(_ctx, room) {
  // Mid-allocation / mid-reveal can't safely resume — drop to ready-for-next-round
  // (or pre-Start ready) with match scores / roster preserved.
  if (room.phase === 'allocating' || room.phase === 'roundResults') {
    if (room.phase === 'allocating') {
      room.mfBoards = [];
      room.mfHands = {};
      room.mfBurned = [];
      room.mfRoundResults = null;
      room.phase = 'ready';
    }
  }
  if (!room.mfScores || typeof room.mfScores !== 'object') room.mfScores = {};
  if (!Array.isArray(room.mfPlayers)) room.mfPlayers = [];
}

function registerHandlers(ctx, io, socket) {
  socket.on('startMenifot', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'menifot' || room.phase !== 'ready') {
      return callback({ ok: false, error: 'Not ready to start' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can start' });
    }

    // Mid-match ready (e.g. after server restart): reuse frozen roster.
    if (room.mfPlayers.length > 0) {
      callback({ ok: true });
      startMenifotNextRound(ctx, roomCode, room);
      return;
    }

    const names = ctx.connectedNames(room);
    if (names.length < MF_MIN_PLAYERS) {
      return callback({ ok: false, error: `Need at least ${MF_MIN_PLAYERS} players` });
    }
    if (names.length > MF_MAX_PLAYERS) {
      return callback({ ok: false, error: `Menifot supports at most ${MF_MAX_PLAYERS} players` });
    }

    callback({ ok: true });
    startMenifotMatch(ctx, roomCode, room, names);
  });

  socket.on('mfAssignCard', (data, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'menifot' || room.phase !== 'allocating') {
      return callback({ ok: false, error: 'Not allocating right now' });
    }

    const name = socket.data.name;
    const hand = room.mfHands[name];
    if (!hand) return callback({ ok: false, error: 'Not in this match' });

    const card = data && data.card;
    const boardIndex = data && data.boardIndex;
    const result = setMfCardBoard(hand, card, boardIndex, room.mfBoardCount);
    if (!result.ok) return callback(result);

    callback({ ok: true });
    broadcastMenifot(ctx, roomCode, room);
  });

  socket.on('mfLock', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'menifot' || room.phase !== 'allocating') {
      return callback({ ok: false, error: 'Not allocating right now' });
    }

    const name = socket.data.name;
    const result = lockMfHand(room, name);
    if (!result.ok) return callback(result);

    callback({ ok: true });
    broadcastMenifot(ctx, roomCode, room);
  });

  socket.on('mfRevealCard', (data, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'menifot' || room.phase !== 'allocating') {
      return callback({ ok: false, error: 'Not ready to reveal' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can reveal cards' });
    }

    const boardIndex = Number(data && data.boardIndex);
    const part = data && data.part;
    const result = revealMfCard(room, boardIndex, part);
    if (!result.ok) return callback(result);

    callback({ ok: true });
    broadcastMenifot(ctx, roomCode, room);
    if (room.mfBoards.every((b) => b.turnRevealed && b.riverRevealed)) {
      finalizeMenifotRound(ctx, roomCode, room);
    }
  });

  socket.on('mfNextRound', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'menifot' || room.phase !== 'roundResults') {
      return callback({ ok: false, error: 'No results to continue from' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can continue' });
    }

    callback({ ok: true });
    startMenifotNextRound(ctx, roomCode, room);
  });

  socket.on('playAgainMenifot', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'menifot' || room.phase !== 'gameover') {
      return callback({ ok: false, error: 'Match is not over yet' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can play again' });
    }

    const names = ctx.connectedNames(room);
    if (names.length < MF_MIN_PLAYERS) {
      return callback({ ok: false, error: `Need at least ${MF_MIN_PLAYERS} players` });
    }
    if (names.length > MF_MAX_PLAYERS) {
      return callback({ ok: false, error: `Menifot supports at most ${MF_MAX_PLAYERS} players` });
    }

    callback({ ok: true });
    startMenifotMatch(ctx, roomCode, room, names);
  });
}

module.exports = {
  id: 'menifot',
  minPlayers: MF_MIN_PLAYERS,
  maxPlayers: MF_MAX_PLAYERS,
  onChoose,
  registerHandlers,
  reconnectPayload,
  onDisconnect,
  onReconnectBroadcast,
  savedFields: SAVED_FIELDS,
  repairOnLoad,
  clearState,
};
