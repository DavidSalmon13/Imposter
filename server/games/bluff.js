'use strict';

const { buildDeck } = require('./pokerEval');
const { shuffle } = require('../lib/shuffle');
const {
  normalizeCalledRanks,
  calledRanksLabel,
  areRanksPresent,
  calledRanksPresence,
  strongestHand,
} = require('./bluffHands');
const betting = require('../betting');

const BF_MIN_PLAYERS = 2;
const BF_MAX_PLAYERS = 10;
const BF_LOSER_HIGHLIGHT_MS = 1500;
const BF_DEAL_ANIMATION_MS = 2200;
const BF_CHECK_COUNTDOWN_MS = 3000;

const SAVED_FIELDS = ['bfPlayers', 'bfCounts', 'bfRoundNumber', 'bfEliminationOrder'];

/** @type {Map<string, NodeJS.Timeout>} */
const bfTimers = new Map();

function clearBluffTimer(roomCode) {
  const handle = bfTimers.get(roomCode);
  if (handle) clearTimeout(handle);
  bfTimers.delete(roomCode);
}

/** @type {Map<string, NodeJS.Timeout>} roomCode -> pending hand-check reveal */
const bfCheckTimers = new Map();

function clearCheckTimer(roomCode) {
  const handle = bfCheckTimers.get(roomCode);
  if (handle) clearTimeout(handle);
  bfCheckTimers.delete(roomCode);
}

/** A hand check is mid-countdown (entered, not yet revealed). */
function checkPending(room) {
  return !!room.bfCheck && room.bfCheck.present === null;
}

function clearState(room, roomCode) {
  if (roomCode) {
    clearBluffTimer(roomCode);
    clearCheckTimer(roomCode);
  }
  room.bfPlayers = [];
  room.bfCounts = {};
  room.bfPendingStartCount = 0;
  room.bfRoundNumber = 0;
  room.bfEliminationOrder = [];
  room.bfHands = {};
  room.bfLastResult = null;
  room.bfCheck = null;
  room.bfEditing = false;
  room.bfEditCounts = {};
  // Betting state is match-scoped (see betting-implementation-plan.md, section 6) - without this,
  // a lingering elimination-bet window nobody ever placed/dismissed would wrongly re-offer
  // itself (or stay in someone's view) into a brand-new match.
  room.betGlobalWindows = {};
  room.betSideProposals = {};
}

/** A round is dealt and settled - not mid-highlight, not between rounds. */
function hasActiveRound(room) {
  return Object.keys(room.bfHands).length > 0 && room.bfLastResult == null;
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
  const winnerName = ranking.length ? ranking[0].name : null;
  for (const row of ranking) ctx.addScore(room, row.name, row.points);
  ctx.recordGameResult(
    room,
    'bluff',
    ranking.map((row, index) => ({
      name: row.name,
      won: index === 0,
      points: row.points,
      details: { place: index + 1 },
    })),
    {
      // Global bets resolve against the match's winner the moment its game row
      // exists - this is the only place that id is ever available (see
      // accounts.js's recordGameResult / server.js's ctx.recordGameResult).
      onRecorded(gameId) {
        ctx.betting.resolveGlobalBets(room, roomCode, { gameId, winnerName });
      },
    }
  );
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
      // Same icon the lobby shows: their sticker (or null for the name-hashed emoji
      // fallback), with the gold signed-in ring - purely cosmetic here.
      sticker: (p && p.sticker) || null,
      signedIn: !!(p && p.signedIn),
    };
  });
}

/**
 * Eliminated players (0 cards, still on the frozen roster) become spectators: instead of
 * their own (nonexistent) hand, they see every active player's hand - they're out of the
 * game, so there's no bluffing information left for them to exploit.
 */
function isBluffSpectator(room, viewerName) {
  return (
    room.phase === 'playing' &&
    room.bfPlayers.includes(viewerName) &&
    (room.bfCounts[viewerName] || 0) === 0
  );
}

function bluffAllHands(room) {
  return room.bfPlayers
    .filter((n) => (room.bfCounts[n] || 0) > 0)
    .map((n) => ({ name: n, cards: (room.bfHands[n] || []).slice() }));
}

/** Every other eliminated player's name - what a spectator is allowed to see bets for. */
function othersToReveal(room, viewerName) {
  return room.bfPlayers.filter((n) => n !== viewerName && (room.bfCounts[n] || 0) === 0);
}

/**
 * Pre-fetched by broadcastBluff (it needs a DB round trip - see that function's doc
 * comment) and threaded through as `bettingView`, rather than computed here, so this
 * stays a plain synchronous function - reconnectPayload, which must stay synchronous,
 * calls it directly with no bettingView and gets `betting: null` until the next regular
 * broadcast (fired right alongside it - see onReconnectBroadcast) corrects it.
 */
function bluffStatePayload(ctx, room, viewerName, bettingView = null) {
  const connectedCount = ctx.connectedNames(room).length;
  const myHand = room.bfHands[viewerName] || null;
  const isSpectator = isBluffSpectator(room, viewerName);

  return {
    game: 'bluff',
    phase: room.phase,
    host: room.hostName,
    seats: bluffSeats(room),
    roundNumber: room.bfRoundNumber,
    myHand: myHand ? myHand.slice() : null,
    isSpectator,
    allHands: isSpectator ? bluffAllHands(room) : null,
    betting: bettingView,
    lastResult: room.bfLastResult,
    // `present`/`perCard`/`strongest` stay null until the countdown ends, so nobody can peek
    // at the answer early.
    check: room.bfCheck
      ? {
          id: room.bfCheck.id,
          label: room.bfCheck.label,
          remainingMs: Math.max(0, room.bfCheck.revealAt - Date.now()),
          present: room.bfCheck.present,
          perCard: room.bfCheck.perCard,
          strongest: room.bfCheck.strongest,
        }
      : null,
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
    canEdit:
      viewerName === room.hostName &&
      room.phase === 'playing' &&
      !room.bfEditing &&
      hasActiveRound(room) &&
      !checkPending(room),
    editing: room.bfEditing,
    editCounts: room.bfEditing ? { ...room.bfEditCounts } : null,
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
  if (roomCode) clearCheckTimer(roomCode);
  room.bfCheck = null;
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
  if (eliminated) {
    room.bfEliminationOrder.push(name);
    // Offered only to the player who just went out - they're the only one with nothing
    // left to do until the match ends. eligible is activeBluffPlayers *after* this
    // elimination, frozen here for the payout formula at resolution time.
    ctx.betting.openGlobalBetWindow(room, roomCode, {
      trigger: `elimination:${name}`,
      offerTo: [name],
      eligible: activeBluffPlayers(room),
    });
  }
  room.bfLastResult = { loserName: name, newCount, eliminated };
  // Fire-and-forget, same principle as every other betting call here - never awaited,
  // never blocks the round transition below.
  ctx.betting.resolveSideBets(room, roomCode, { roundNumber: room.bfRoundNumber, loserName: name });
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
  // Deliberately NOT awaited: betting.bettingViewFor needs a DB round trip, and this
  // function must stay synchronous - every existing call site (and every handler's
  // ack-then-broadcast ordering) depends on that. Pushing the betting view as a
  // same-event follow-up correction, a tick later, keeps that ordering intact and
  // means zero extra work happens at all while betting is disabled (bettingViewFor
  // resolves null for everyone, so nothing gets re-emitted below).
  pushBettingViews(ctx, roomCode, room);
}

async function pushBettingViews(ctx, roomCode, room) {
  const targets = [...room.players.entries()].filter(([, p]) => p.connected && p.socketId);
  let views;
  try {
    views = await Promise.all(
      targets.map(([name]) =>
        betting.bettingViewFor(room, roomCode, name, {
          isSpectator: isBluffSpectator(room, name),
          othersToReveal: othersToReveal(room, name),
        })
      )
    );
  } catch (err) {
    console.error('Building betting views for a Bluff broadcast failed:', err.message);
    return;
  }
  targets.forEach(([name, p], i) => {
    if (!views[i]) return; // betting disabled or a guest - nothing to correct
    ctx.io.to(p.socketId).emit('bluffState', bluffStatePayload(ctx, room, name, views[i]));
  });
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
    // Opened before dealBluffRound so its one broadcast already reflects the window -
    // offered to the whole frozen roster, eligible = that same roster. betting.js
    // itself no-ops entirely when betting is disabled.
    ctx.betting.openGlobalBetWindow(room, roomCode, { trigger: 'start', offerTo: room.bfPlayers, eligible: room.bfPlayers });
    dealBluffRound(ctx, roomCode, room);
  });

  // Places a bet on who wins the whole match, on an open window from
  // openGlobalBetWindow (match start or this player's own elimination).
  // placeGlobalBet (unlike resolveGlobalBets etc.) is called directly, not through ctx -
  // it's a synchronous request/response to the caller's own ack, nobody else's socket.
  socket.on('betPlaceGlobal', async (data, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'bluff' || room.phase !== 'playing') {
      return callback({ ok: false, error: 'Not playing right now' });
    }
    const player = room.players.get(socket.data.name);
    const userId = player && player.userId;
    if (!userId) return callback({ ok: false, error: 'Sign in to place a bet' });

    const result = await betting.placeGlobalBet(room, roomCode, {
      playerName: socket.data.name,
      userId,
      trigger: data && data.trigger,
      pick: data && data.pick,
      stake: data && data.stake,
    });
    callback(result);
    if (result.ok) broadcastBluff(ctx, roomCode, room);
  });

  // Proposes a side bet on who loses *this round*. No stake is at risk until someone
  // accepts it (betAcceptSide below). targetName null = open to whoever taps it first.
  socket.on('betProposeSide', async (data, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'bluff' || room.phase !== 'playing') {
      return callback({ ok: false, error: 'Not playing right now' });
    }
    // Same "round is live" predicate canEdit uses (bluffStatePayload above), minus the
    // host-only part - anyone, not just the host, can propose a side bet.
    if (!hasActiveRound(room) || checkPending(room) || room.bfEditing) {
      return callback({ ok: false, error: 'No active round to bet on' });
    }
    const player = room.players.get(socket.data.name);
    const userId = player && player.userId;
    if (!userId) return callback({ ok: false, error: 'Sign in to place a bet' });

    const result = await betting.proposeSideBet(room, roomCode, {
      roundNumber: room.bfRoundNumber,
      bettorName: socket.data.name,
      userId,
      pick: data && data.pick,
      stake: data && data.stake,
      targetName: (data && data.targetName) || null,
      eligible: activeBluffPlayers(room),
    });
    callback(result);
    if (result.ok) broadcastBluff(ctx, roomCode, room);
  });

  // Accepts an open side-bet proposal, locking both stakes at the proposer's amount.
  // acceptSideBet's own round-scoped lookup is what makes a stale (prior-round)
  // proposal simply unreachable - no extra guard needed here for that.
  socket.on('betAcceptSide', async (data, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'bluff' || room.phase !== 'playing') {
      return callback({ ok: false, error: 'Not playing right now' });
    }
    const player = room.players.get(socket.data.name);
    const userId = player && player.userId;
    if (!userId) return callback({ ok: false, error: 'Sign in to accept a bet' });

    const result = await betting.acceptSideBet(room, roomCode, {
      roundNumber: room.bfRoundNumber,
      proposalId: data && data.proposalId,
      accepterName: socket.data.name,
      accepterUserId: userId,
    });
    callback(result);
    if (result.ok) broadcastBluff(ctx, roomCode, room);
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
    if (checkPending(room)) {
      return callback({ ok: false, error: 'Wait for the hand check to finish' });
    }
    if (room.bfEditing) {
      return callback({ ok: false, error: 'Finish editing card counts first' });
    }

    const name = data && data.name;
    if (!room.bfPlayers.includes(name) || (room.bfCounts[name] || 0) <= 0) {
      return callback({ ok: false, error: 'Invalid player' });
    }

    callback({ ok: true });
    applyBluffLoss(ctx, roomCode, room, name);
  });

  // Host enters the card values called (suits ignored); after a short countdown everyone
  // sees whether all players' cards pooled together contain them.
  socket.on('bfCheckHand', (data, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'bluff' || room.phase !== 'playing') {
      return callback({ ok: false, error: 'Not playing right now' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can check a hand' });
    }
    if (Object.keys(room.bfHands).length === 0 || room.bfLastResult != null) {
      return callback({ ok: false, error: 'No active round to check' });
    }
    if (checkPending(room)) {
      return callback({ ok: false, error: 'Already checking - wait for the result' });
    }
    if (room.bfEditing) {
      return callback({ ok: false, error: 'Finish editing card counts first' });
    }

    const ranks = normalizeCalledRanks(data && data.ranks);
    if (!ranks) return callback({ ok: false, error: 'Pick the cards that were called' });

    room.bfCheck = {
      id: `${room.bfRoundNumber}:${Date.now()}`,
      ranks,
      label: calledRanksLabel(ranks),
      revealAt: Date.now() + BF_CHECK_COUNTDOWN_MS,
      present: null,
      perCard: null,
      strongest: null,
    };
    callback({ ok: true });
    broadcastBluff(ctx, roomCode, room);

    clearCheckTimer(roomCode);
    const check = room.bfCheck;
    bfCheckTimers.set(
      roomCode,
      setTimeout(() => {
        bfCheckTimers.delete(roomCode);
        if (room.bfCheck !== check) return;
        const pooled = Object.values(room.bfHands).flat();
        check.present = areRanksPresent(ranks, pooled);
        check.perCard = calledRanksPresence(ranks, pooled);
        check.strongest = strongestHand(pooled);
        broadcastBluff(ctx, roomCode, room);
      }, BF_CHECK_COUNTDOWN_MS)
    );
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
    clearCheckTimer(roomCode);
    room.bfCheck = null;
    room.bfCounts = {};
    room.bfRoundNumber = 0;
    room.bfEliminationOrder = [];
    room.bfHands = {};
    room.bfLastResult = null;
    room.bfEditing = false;
    room.bfEditCounts = {};
    // Resetting mid-match abandons any open bet the same way a restart does (see
    // betting-implementation-plan.md's "Known limitations") - no refund, but at least no
    // stale window/proposal leaks into the next match.
    room.betGlobalWindows = {};
    room.betSideProposals = {};
    room.phase = 'seating';

    callback({ ok: true });
    broadcastBluff(ctx, roomCode, room);
  });

  // Host-only correction tool: opens a draft of every player's card count (starting
  // from their current counts) that only takes effect on bfConfirmEdit - see
  // specs/bluff-specs.md "Editing card counts mid-match".
  socket.on('bfStartEdit', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'bluff' || room.phase !== 'playing') {
      return callback({ ok: false, error: 'Not playing right now' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can edit card counts' });
    }
    if (room.bfEditing) return callback({ ok: false, error: 'Already editing' });
    if (!hasActiveRound(room) || checkPending(room)) {
      return callback({ ok: false, error: 'Wait for the current round to settle first' });
    }

    room.bfEditing = true;
    room.bfEditCounts = { ...room.bfCounts };
    callback({ ok: true });
    broadcastBluff(ctx, roomCode, room);
  });

  // +/- one card on a single seat's draft count. Bounded at 0 and by the 52-card deck
  // (the sum of every seat's draft count can never exceed it).
  socket.on('bfAdjustEditCount', (data, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'bluff' || !room.bfEditing) {
      return callback({ ok: false, error: 'Not editing right now' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can edit card counts' });
    }

    const name = data && data.name;
    const delta = Number(data && data.delta);
    if (!room.bfPlayers.includes(name) || (delta !== 1 && delta !== -1)) {
      return callback({ ok: false, error: 'Invalid edit' });
    }

    const next = (room.bfEditCounts[name] || 0) + delta;
    if (next < 0) return callback({ ok: false, error: 'Out of range' });
    const totalOthers = Object.entries(room.bfEditCounts).reduce(
      (sum, [n, c]) => (n === name ? sum : sum + c),
      0
    );
    if (totalOthers + next > 52) return callback({ ok: false, error: 'Not enough cards in the deck' });

    room.bfEditCounts[name] = next;
    callback({ ok: true });
    broadcastBluff(ctx, roomCode, room);
  });

  socket.on('bfCancelEdit', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'bluff' || !room.bfEditing) {
      return callback({ ok: false, error: 'Not editing right now' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can edit card counts' });
    }

    room.bfEditing = false;
    room.bfEditCounts = {};
    callback({ ok: true });
    broadcastBluff(ctx, roomCode, room);
  });

  // Applies the draft and deals the next round off the adjusted counts - or, if the
  // edit leaves exactly one player with cards, ends the match the same way a normal
  // loss would.
  socket.on('bfConfirmEdit', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'bluff' || !room.bfEditing) {
      return callback({ ok: false, error: 'Not editing right now' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can edit card counts' });
    }

    const nextCounts = room.bfEditCounts;
    const activeAfter = room.bfPlayers.filter((n) => (nextCounts[n] || 0) > 0);
    if (activeAfter.length < 1) {
      return callback({ ok: false, error: 'At least one player needs cards' });
    }

    // Revived players (edited back above 0) come out of the elimination order; players
    // the edit newly zeroed go on the end of it, in seat order - keeps the final
    // ranking (computeBluffRanking) consistent with whatever the host just set.
    const revived = new Set(
      room.bfPlayers.filter((n) => (room.bfCounts[n] || 0) === 0 && (nextCounts[n] || 0) > 0)
    );
    room.bfEliminationOrder = room.bfEliminationOrder.filter((n) => !revived.has(n));
    for (const n of room.bfPlayers) {
      const wasActive = (room.bfCounts[n] || 0) > 0;
      const isActive = (nextCounts[n] || 0) > 0;
      if (wasActive && !isActive && !room.bfEliminationOrder.includes(n)) {
        room.bfEliminationOrder.push(n);
      }
    }

    room.bfCounts = { ...nextCounts };
    room.bfEditing = false;
    room.bfEditCounts = {};
    clearBluffTimer(roomCode);
    clearCheckTimer(roomCode);
    room.bfCheck = null;
    callback({ ok: true });

    // An edit is a correction tool, not a real round outcome - void and refund rather
    // than settle any side bet off of it. Fire-and-forget, same as resolveSideBets.
    ctx.betting.voidSideBets(room, roomCode, room.bfRoundNumber);

    if (activeAfter.length === 1) {
      room.bfHands = {};
      room.bfLastResult = null;
      finishBluffMatch(ctx, roomCode, room);
    } else {
      dealBluffRound(ctx, roomCode, room);
    }
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
