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

// Keys within room.state.bluff to persist (see docs/plans/yes-sketch-a-low-risk-quiet-chipmunk.md).
// hands/lastResult/check/editing/editCounts are intentionally ephemeral - a mid-round restart
// re-deals off the persisted counts (see repairOnLoad).
const SAVED_FIELDS = ['players', 'counts', 'roundNumber', 'eliminationOrder'];

/** Bluff's namespaced room state. Replaces the former flat room.bf* fields. */
function createState() {
  return {
    players: [], // frozen match roster, fixed order = round-table seat order
    counts: {}, // name -> current card count, persists across rounds, 0 on elimination
    pendingStartCount: 0, // seating-phase slider value, chosen before Start Match freezes it
    roundNumber: 0, // current round number, display-only
    eliminationOrder: [], // names in the order they hit 0 cards, oldest first
    hands: {}, // name -> this round's dealt cards (NOT persisted)
    lastResult: null, // { loserName, newCount, eliminated } during the highlight/deal pause (NOT persisted)
    check: null, // { id, ranks, label, revealAt, present } for the host's hand-check (NOT persisted)
    editing: false, // host is adjusting card counts via Edit Game (NOT persisted)
    editCounts: {}, // name -> draft count while editing (NOT persisted)
  };
}

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
  return !!room.state.bluff.check && room.state.bluff.check.present === null;
}

function clearState(room, roomCode) {
  if (roomCode) {
    clearBluffTimer(roomCode);
    clearCheckTimer(roomCode);
  }
  room.state.bluff = createState();
  // Betting state is match-scoped (see betting-implementation-plan.md, section 6) - without this,
  // a lingering elimination-bet window nobody ever placed/dismissed would wrongly re-offer
  // itself (or stay in someone's view) into a brand-new match.
  room.state.betting = betting.createState();
  // In-memory reset above isn't enough: an already-accepted bet's durable Postgres row
  // survives, and resolveGlobalBets/resolveSideBets sweep by room_code alone - so a bet
  // abandoned here would otherwise be mis-resolved against the *next* match in this room.
  // Expire the dangling rows too (no refund - same accepted gap as a restart).
  if (roomCode) betting.expireDanglingBets(roomCode);
}

/** A round is dealt and settled - not mid-highlight, not between rounds. */
function hasActiveRound(room) {
  return Object.keys(room.state.bluff.hands).length > 0 && room.state.bluff.lastResult == null;
}

function activeBluffPlayers(room) {
  return room.state.bluff.players.filter((n) => (room.state.bluff.counts[n] || 0) > 0);
}

/**
 * Winner (the one active player) first, then eliminationOrder reversed - most-recently
 * eliminated ranks higher. No tie handling needed: elimination order is a strict total
 * order (exactly one loser per round), so every player gets a distinct rank.
 */
function computeBluffRanking(room) {
  const N = room.state.bluff.players.length;
  const winner = activeBluffPlayers(room)[0] || null;
  const order = [winner, ...room.state.bluff.eliminationOrder.slice().reverse()].filter(Boolean);
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
  return room.state.bluff.players.map((name, seatIndex) => {
    const p = room.players.get(name);
    return {
      name,
      seatIndex,
      count: room.state.bluff.counts[name] || 0,
      eliminated: (room.state.bluff.counts[name] || 0) === 0,
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
    room.state.bluff.players.includes(viewerName) &&
    (room.state.bluff.counts[viewerName] || 0) === 0
  );
}

function bluffAllHands(room) {
  return room.state.bluff.players
    .filter((n) => (room.state.bluff.counts[n] || 0) > 0)
    .map((n) => ({ name: n, cards: (room.state.bluff.hands[n] || []).slice() }));
}

/**
 * What match-winner odds are priced on (betting.computeGlobalOdds): each seat's cards
 * still in play, and their overall rating from the lobby's rating lookup (absent for
 * guests, who get the baseline).
 */
function bluffOddsInputs(room) {
  const inputs = {};
  for (const name of room.state.bluff.players) {
    const p = room.players.get(name);
    inputs[name] = { cards: room.state.bluff.counts[name] || 0, rating: p && p.rating ? p.rating.ovr : null };
  }
  return inputs;
}

/** Every other eliminated player's name - what a spectator is allowed to see bets for. */
function othersToReveal(room, viewerName) {
  return room.state.bluff.players.filter((n) => n !== viewerName && (room.state.bluff.counts[n] || 0) === 0);
}

/**
 * Pre-fetched by pushBettingViews (it needs a DB round trip - see broadcastBluff's doc
 * comment) and threaded through as `bettingView`, rather than computed here, so this
 * stays a plain synchronous function. The synchronous broadcast (and reconnectPayload,
 * which must stay synchronous) call it with no bettingView: `betting` is then *omitted
 * entirely* from the payload (not sent as `null`), so the client leaves its current
 * betting UI untouched until the pushBettingViews follow-up delivers the real view. This
 * is deliberate - sending `null` here would make the client tear down the betting panel
 * (and any open bet modal, discarding the player's in-progress pick) on every single
 * broadcast. `null` is reserved for the follow-up's "betting off / guest" signal.
 */
function bluffStatePayload(ctx, room, viewerName, bettingView) {
  const connectedCount = ctx.connectedNames(room).length;
  const myHand = room.state.bluff.hands[viewerName] || null;
  const isSpectator = isBluffSpectator(room, viewerName);

  const payload = {
    game: 'bluff',
    phase: room.phase,
    host: room.hostName,
    seats: bluffSeats(room),
    roundNumber: room.state.bluff.roundNumber,
    myHand: myHand ? myHand.slice() : null,
    isSpectator,
    allHands: isSpectator ? bluffAllHands(room) : null,
    lastResult: room.state.bluff.lastResult,
    // `present`/`perCard`/`strongest` stay null until the countdown ends, so nobody can peek
    // at the answer early.
    check: room.state.bluff.check
      ? {
          id: room.state.bluff.check.id,
          label: room.state.bluff.check.label,
          // What the host called - public, so every phone can lay the face-down cards out.
          ranks: room.state.bluff.check.ranks.slice(),
          remainingMs: Math.max(0, room.state.bluff.check.revealAt - Date.now()),
          present: room.state.bluff.check.present,
          perCard: room.state.bluff.check.perCard,
          strongest: room.state.bluff.check.strongest,
        }
      : null,
    startCountBounds:
      room.phase === 'seating'
        ? { min: 1, max: Math.max(1, Math.floor(52 / Math.max(1, connectedCount))) }
        : null,
    pendingStartCount: room.state.bluff.pendingStartCount,
    canStart:
      room.phase === 'seating' &&
      connectedCount >= BF_MIN_PLAYERS &&
      connectedCount <= BF_MAX_PLAYERS,
    canResetGame:
      viewerName === room.hostName && (room.phase === 'playing' || room.phase === 'gameover'),
    canEdit:
      viewerName === room.hostName &&
      room.phase === 'playing' &&
      !room.state.bluff.editing &&
      hasActiveRound(room) &&
      !checkPending(room),
    editing: room.state.bluff.editing,
    editCounts: room.state.bluff.editing ? { ...room.state.bluff.editCounts } : null,
    ranking: room.phase === 'gameover' ? computeBluffRanking(room) : undefined,
    scoreboard: room.phase === 'gameover' ? ctx.scoreboardEntries(room) : undefined,
  };
  // Only carry a `betting` key when a view was actually computed (the pushBettingViews
  // follow-up). A synchronous broadcast omits it so the client keeps its current betting
  // UI rather than tearing it down - see this function's doc comment.
  if (bettingView !== undefined) payload.betting = bettingView;
  return payload;
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
  for (const name of room.state.bluff.players) {
    if ((room.state.bluff.counts[name] || 0) <= 0) continue;
    hands[name] = deck.slice(idx, idx + room.state.bluff.counts[name]);
    idx += room.state.bluff.counts[name];
  }
  room.state.bluff.hands = hands;
  room.state.bluff.lastResult = null;
  if (roomCode) clearCheckTimer(roomCode);
  room.state.bluff.check = null;
  room.state.bluff.roundNumber += 1;
  broadcastBluff(ctx, roomCode, room);
}

/**
 * Records `name` as this round's loser, broadcasts the highlight immediately, then either
 * ends the match outright (if only one player has cards left - no further dealing, no
 * highlight pause) or schedules the next deal after the highlight + deal-animation pause.
 */
function applyBluffLoss(ctx, roomCode, room, name) {
  room.state.bluff.counts[name] = (room.state.bluff.counts[name] || 0) - 1;
  const newCount = room.state.bluff.counts[name];
  const eliminated = newCount === 0;
  if (eliminated) {
    room.state.bluff.eliminationOrder.push(name);
    // Offered only to the player who just went out - they're the only one with nothing
    // left to do until the match ends. eligible is activeBluffPlayers *after* this
    // elimination, frozen here for the payout formula at resolution time.
    ctx.betting.openGlobalBetWindow(room, roomCode, {
      trigger: `elimination:${name}`,
      offerTo: [name],
      eligible: activeBluffPlayers(room),
    });
  }
  room.state.bluff.lastResult = { loserName: name, newCount, eliminated };
  // Fire-and-forget, same principle as every other betting call here - never awaited,
  // never blocks the round transition below.
  ctx.betting.resolveSideBets(room, roomCode, { roundNumber: room.state.bluff.roundNumber, loserName: name });
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
          oddsInputs: bluffOddsInputs(room),
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
    room.state.bluff.pendingStartCount = clampStartingCount(data && data.count, connectedCount);

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
    const startCount = clampStartingCount(room.state.bluff.pendingStartCount || undefined, names.length);
    room.state.bluff.players = names;
    room.state.bluff.counts = {};
    for (const name of names) room.state.bluff.counts[name] = startCount;
    room.state.bluff.roundNumber = 0;
    room.state.bluff.eliminationOrder = [];
    room.phase = 'playing';

    callback({ ok: true });
    // Opened before dealBluffRound so its one broadcast already reflects the window -
    // offered to the whole frozen roster, eligible = that same roster. betting.js
    // itself no-ops entirely when betting is disabled.
    ctx.betting.openGlobalBetWindow(room, roomCode, { trigger: 'start', offerTo: room.state.bluff.players, eligible: room.state.bluff.players });
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
      odds: data && data.odds,
      oddsInputs: bluffOddsInputs(room),
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
    if (!hasActiveRound(room) || checkPending(room) || room.state.bluff.editing) {
      return callback({ ok: false, error: 'No active round to bet on' });
    }
    const player = room.players.get(socket.data.name);
    const userId = player && player.userId;
    if (!userId) return callback({ ok: false, error: 'Sign in to place a bet' });

    const result = await betting.proposeSideBet(room, roomCode, {
      roundNumber: room.state.bluff.roundNumber,
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
      roundNumber: room.state.bluff.roundNumber,
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
    if (Object.keys(room.state.bluff.hands).length === 0 || room.state.bluff.lastResult != null) {
      return callback({ ok: false, error: 'No active round to act on' });
    }
    if (checkPending(room)) {
      return callback({ ok: false, error: 'Wait for the hand check to finish' });
    }
    if (room.state.bluff.editing) {
      return callback({ ok: false, error: 'Finish editing card counts first' });
    }

    const name = data && data.name;
    if (!room.state.bluff.players.includes(name) || (room.state.bluff.counts[name] || 0) <= 0) {
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
    if (Object.keys(room.state.bluff.hands).length === 0 || room.state.bluff.lastResult != null) {
      return callback({ ok: false, error: 'No active round to check' });
    }
    if (checkPending(room)) {
      return callback({ ok: false, error: 'Already checking - wait for the result' });
    }
    if (room.state.bluff.editing) {
      return callback({ ok: false, error: 'Finish editing card counts first' });
    }

    const ranks = normalizeCalledRanks(data && data.ranks);
    if (!ranks) return callback({ ok: false, error: 'Pick the cards that were called' });

    room.state.bluff.check = {
      id: `${room.state.bluff.roundNumber}:${Date.now()}`,
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
    const check = room.state.bluff.check;
    bfCheckTimers.set(
      roomCode,
      setTimeout(() => {
        bfCheckTimers.delete(roomCode);
        if (room.state.bluff.check !== check) return;
        const pooled = Object.values(room.state.bluff.hands).flat();
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
    // Reset the table but keep the frozen roster and the host's slider value - a reset
    // returns to seating with the same players, who re-Start from the same count.
    const { players, pendingStartCount } = room.state.bluff;
    room.state.bluff = createState();
    Object.assign(room.state.bluff, { players, pendingStartCount });
    // Resetting mid-match abandons any open bet the same way a restart does (see
    // betting-implementation-plan.md's "Known limitations") - no refund, but at least no
    // stale window/proposal leaks into the next match. The in-memory reset below only
    // covers windows/proposals; expireDanglingBets closes the already-accepted Postgres
    // rows too, so they can't be swept into the next match's room_code-scoped resolution.
    room.state.betting = betting.createState();
    betting.expireDanglingBets(roomCode);
    room.phase = 'seating';

    callback({ ok: true });
    broadcastBluff(ctx, roomCode, room);
  });

  // Host-only correction tool: opens a draft of every player's card count (starting
  // from their current counts) that only takes effect on bfConfirmEdit - see
  // docs/specs/bluff-specs.md "Editing card counts mid-match".
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
    if (room.state.bluff.editing) return callback({ ok: false, error: 'Already editing' });
    if (!hasActiveRound(room) || checkPending(room)) {
      return callback({ ok: false, error: 'Wait for the current round to settle first' });
    }

    room.state.bluff.editing = true;
    room.state.bluff.editCounts = { ...room.state.bluff.counts };
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
    if (room.game !== 'bluff' || !room.state.bluff.editing) {
      return callback({ ok: false, error: 'Not editing right now' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can edit card counts' });
    }

    const name = data && data.name;
    const delta = Number(data && data.delta);
    if (!room.state.bluff.players.includes(name) || (delta !== 1 && delta !== -1)) {
      return callback({ ok: false, error: 'Invalid edit' });
    }

    const next = (room.state.bluff.editCounts[name] || 0) + delta;
    if (next < 0) return callback({ ok: false, error: 'Out of range' });
    const totalOthers = Object.entries(room.state.bluff.editCounts).reduce(
      (sum, [n, c]) => (n === name ? sum : sum + c),
      0
    );
    if (totalOthers + next > 52) return callback({ ok: false, error: 'Not enough cards in the deck' });

    room.state.bluff.editCounts[name] = next;
    callback({ ok: true });
    broadcastBluff(ctx, roomCode, room);
  });

  socket.on('bfCancelEdit', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'bluff' || !room.state.bluff.editing) {
      return callback({ ok: false, error: 'Not editing right now' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can edit card counts' });
    }

    room.state.bluff.editing = false;
    room.state.bluff.editCounts = {};
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
    if (room.game !== 'bluff' || !room.state.bluff.editing) {
      return callback({ ok: false, error: 'Not editing right now' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can edit card counts' });
    }

    const nextCounts = room.state.bluff.editCounts;
    const activeAfter = room.state.bluff.players.filter((n) => (nextCounts[n] || 0) > 0);
    if (activeAfter.length < 1) {
      return callback({ ok: false, error: 'At least one player needs cards' });
    }

    // Revived players (edited back above 0) come out of the elimination order; players
    // the edit newly zeroed go on the end of it, in seat order - keeps the final
    // ranking (computeBluffRanking) consistent with whatever the host just set.
    const revived = new Set(
      room.state.bluff.players.filter((n) => (room.state.bluff.counts[n] || 0) === 0 && (nextCounts[n] || 0) > 0)
    );
    room.state.bluff.eliminationOrder = room.state.bluff.eliminationOrder.filter((n) => !revived.has(n));
    for (const n of room.state.bluff.players) {
      const wasActive = (room.state.bluff.counts[n] || 0) > 0;
      const isActive = (nextCounts[n] || 0) > 0;
      if (wasActive && !isActive && !room.state.bluff.eliminationOrder.includes(n)) {
        room.state.bluff.eliminationOrder.push(n);
      }
    }

    room.state.bluff.counts = { ...nextCounts };
    room.state.bluff.editing = false;
    room.state.bluff.editCounts = {};
    clearBluffTimer(roomCode);
    clearCheckTimer(roomCode);
    room.state.bluff.check = null;
    callback({ ok: true });

    // An edit is a correction tool, not a real round outcome - void and refund rather
    // than settle any side bet off of it. Fire-and-forget, same as resolveSideBets.
    ctx.betting.voidSideBets(room, roomCode, room.state.bluff.roundNumber);

    if (activeAfter.length === 1) {
      room.state.bluff.hands = {};
      room.state.bluff.lastResult = null;
      finishBluffMatch(ctx, roomCode, room);
    } else {
      dealBluffRound(ctx, roomCode, room);
    }
  });
}

/**
 * The roster is frozen and doesn't depend on who's currently connected (unlike AIOF), so a
 * mid-match restart can safely re-deal the current round right away - no "waiting for
 * players" gate. hands/lastResult aren't persisted (see SAVED_FIELDS), so there's
 * nothing to resume: a fresh deal off the persisted counts is the only sane state.
 */
function repairOnLoad(ctx, room) {
  if (room.phase === 'seating') {
    if (!Number.isFinite(room.state.bluff.pendingStartCount) || room.state.bluff.pendingStartCount < 0) {
      room.state.bluff.pendingStartCount = 0;
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

  room.state.bluff.hands = {};
  room.state.bluff.lastResult = null;
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
  // Bluff owns two state namespaces: its own, plus the cross-cutting 'betting' namespace
  // (shared with server/betting.js). The betting namespace is fully ephemeral (no savedFields).
  namespaces: [
    { id: 'bluff', createState, savedFields: SAVED_FIELDS },
    { id: 'betting', createState: betting.createState },
  ],
  repairOnLoad,
  clearState,
};
