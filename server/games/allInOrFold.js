'use strict';

const { buildDeck, rankBoard } = require('./pokerEval');
const { shuffle } = require('../lib/shuffle');

const AIOF_MIN_PLAYERS = 2;
const AIOF_MAX_SEATS = 6;
const AIOF_STARTING_STACK = 150;
const AIOF_SMALL_BLIND = 5;
const AIOF_BIG_BLIND = 10;
const AIOF_REVEAL_STAGE_DELAY_MS = 2200;

const AIOF_REVEAL_SEQUENCE = [
  { stage: 'revealingTurn', revealedCount: 4 },
  { stage: 'revealingRiver', revealedCount: 5 },
];

const SAVED_FIELDS = [
  'aiofSeats',
  'aiofStacks',
  'aiofBuyIns',
  'aiofSittingOut',
  'aiofDealerSeat',
  'aiofEverSeated',
];

/** @type {Map<string, NodeJS.Timeout>} */
const aiofTimers = new Map();

function clearAiofTimer(roomCode) {
  const handle = aiofTimers.get(roomCode);
  if (handle) clearTimeout(handle);
  aiofTimers.delete(roomCode);
}

function clearState(room, roomCode) {
  if (roomCode) clearAiofTimer(roomCode);
  room.aiofSeats = [null, null, null, null, null, null];
  room.aiofStacks = {};
  room.aiofBuyIns = {};
  room.aiofSittingOut = {};
  room.aiofDealerSeat = -1;
  room.aiofEverSeated = [];
  room.aiofHand = null;
  room.aiofResults = null;
}

function occupiedSeatIndexes(room) {
  const out = [];
  room.aiofSeats.forEach((name, i) => {
    if (name) out.push(i);
  });
  return out;
}

function activeSeatIndexes(room) {
  return occupiedSeatIndexes(room).filter((i) => !room.aiofSittingOut[room.aiofSeats[i]]);
}

/** Occupied, not-sitting-out seats whose stack is 0 — a bust decision (buy-in/sit-out) hasn't
 * been made yet. Spec guarantees no player ever starts a hand at exactly 0, so any of these
 * must block dealing until resolved. */
function pendingBustSeatIndexes(room) {
  return activeSeatIndexes(room).filter((i) => (room.aiofStacks[room.aiofSeats[i]] || 0) === 0);
}

/** Next occupied (or active-only) seat clockwise from `fromIndex`, wrapping around. */
function nextSeatClockwise(room, fromIndex, { activeOnly = true } = {}) {
  const eligible = activeOnly ? activeSeatIndexes(room) : occupiedSeatIndexes(room);
  if (eligible.length === 0) return -1;
  let idx = fromIndex;
  for (let step = 0; step < AIOF_MAX_SEATS; step++) {
    idx = (idx + 1) % AIOF_MAX_SEATS;
    if (eligible.includes(idx)) return idx;
  }
  return -1;
}

function sitInSeat(ctx, room, name, seatIndex) {
  if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex >= AIOF_MAX_SEATS) {
    return { ok: false, error: 'Invalid seat' };
  }
  if (room.aiofSeats[seatIndex]) return { ok: false, error: 'Seat is taken' };
  if (room.aiofSeats.includes(name)) return { ok: false, error: 'Already seated' };

  room.aiofSeats[seatIndex] = name;
  if (!(name in room.aiofStacks)) {
    room.aiofStacks[name] = AIOF_STARTING_STACK;
    room.aiofBuyIns[name] = 1;
  }
  if (!room.aiofEverSeated.includes(name)) room.aiofEverSeated.push(name);
  return { ok: true };
}

/**
 * Shared by aiofLeaveTable and onDisconnect: a real disconnect is handled
 * identically to a voluntary leave. If a hand is in progress and `name` hasn't acted yet
 * this hand — including if it's currently their turn — records an implicit FOLD for them
 * first, then frees their seat unconditionally. Never touches aiofStacks/aiofBuyIns/
 * aiofEverSeated — those are preserved by name so a later rejoin resumes cleanly.
 */
function leaveSeat(ctx, roomCode, room, name) {
  const seatIndex = room.aiofSeats.findIndex((n) => n === name);
  if (seatIndex < 0) return;

  const hand = room.aiofHand;
  if (hand && hand.stage === 'deciding' && hand.actionOrder.includes(name)) {
    const alreadyResolved = hand.folded.includes(name) || hand.autoActed.includes(name);
    if (!alreadyResolved) {
      const wasActingName = hand.actionOrder[hand.actingIndex] === name;
      hand.folded.push(name);
      const uncontested = checkUncontestedWin(ctx, roomCode, room);
      if (!uncontested && wasActingName) {
        hand.actingIndex += 1;
        advanceActingIndex(ctx, roomCode, room);
      }
    }
  }

  room.aiofSeats[seatIndex] = null;
  delete room.aiofSittingOut[name];
  broadcastAiof(ctx, roomCode, room);
}

/** Posts SB/BB from stacks, capping at the poster's stack if short (implicit all-in). */
function postBlinds(room, contributions, sbSeat, bbSeat, autoActed) {
  const post = (seatIndex, blindAmount) => {
    const name = room.aiofSeats[seatIndex];
    const stack = room.aiofStacks[name] || 0;
    const posted = Math.min(stack, blindAmount);
    room.aiofStacks[name] = stack - posted;
    contributions[name] = (contributions[name] || 0) + posted;
    if (posted < blindAmount) autoActed.push(name);
  };
  post(sbSeat, AIOF_SMALL_BLIND);
  post(bbSeat, AIOF_BIG_BLIND);
}

function dealNextHand(ctx, roomCode, room, { rotateDealer = true } = {}) {
  // Cancels any pending scheduled redeal from finishHand's own auto-advance pause — this can
  // be invoked directly (aiofSitSeat/aiofBuyIn/aiofDeclineBuyIn re-triggering after a
  // "waiting for players"/pending-bust gate clears) before that timer fires, and letting
  // both run would deal two hands back to back, silently double-advancing the dealer.
  clearAiofTimer(roomCode);

  // A stale scheduled redeal (or a re-trigger from aiofSitSeat/aiofBuyIn) can still fire
  // after the host has ended the game or the room has reset — only deal while actually
  // mid-match.
  if (room.phase !== 'playing') return;

  if (pendingBustSeatIndexes(room).length > 0) {
    room.aiofHand = null;
    broadcastAiof(ctx, roomCode, room);
    return;
  }

  const active = activeSeatIndexes(room);
  if (active.length < AIOF_MIN_PLAYERS) {
    room.aiofHand = null;
    broadcastAiof(ctx, roomCode, room);
    return;
  }

  const deck = shuffle(buildDeck());
  let idx = 0;
  const holeCards = {};
  for (const seatIndex of active) {
    const name = room.aiofSeats[seatIndex];
    holeCards[name] = deck.slice(idx, idx + 6);
    idx += 6;
  }
  const board = deck.slice(idx, idx + 5);

  // Moves clockwise every hand (skipping empty/sitting-out seats) — nextSeatClockwise
  // searches forward regardless of whether the *current* dealer seat is still valid, so
  // this also self-heals if the previous dealer's seat emptied out since the last hand.
  if (rotateDealer) {
    room.aiofDealerSeat = nextSeatClockwise(room, room.aiofDealerSeat);
  }

  // Heads-up exception: with exactly 2 active seats, the dealer posts the small blind
  // instead of the seat after them (standard poker heads-up rule).
  let sbSeat;
  let bbSeat;
  if (active.length === 2) {
    sbSeat = room.aiofDealerSeat;
    bbSeat = nextSeatClockwise(room, room.aiofDealerSeat);
  } else {
    sbSeat = nextSeatClockwise(room, room.aiofDealerSeat);
    bbSeat = nextSeatClockwise(room, sbSeat);
  }

  const contributions = {};
  for (const seatIndex of active) contributions[room.aiofSeats[seatIndex]] = 0;
  const autoActed = [];
  postBlinds(room, contributions, sbSeat, bbSeat, autoActed);

  // Action order: every active seat clockwise starting after BB, wrapping the whole table
  // once — this naturally ends with SB then BB, per the spec. Stored by NAME (frozen at
  // deal time), not seat index — a seat's occupant can change mid-hand if someone leaves
  // and a new player sits into the vacated seat, and that new player must not inherit the
  // departed player's turn in this already-dealt hand.
  const actionOrder = [];
  let cursor = bbSeat;
  for (let i = 0; i < active.length; i++) {
    cursor = nextSeatClockwise(room, cursor);
    actionOrder.push(room.aiofSeats[cursor]);
  }

  room.aiofHand = {
    stage: 'deciding',
    holeCards,
    board,
    revealedCount: 0,
    contributions,
    folded: [],
    autoActed,
    actionOrder,
    actingIndex: 0,
  };
  room.aiofResults = null;

  advanceActingIndex(ctx, roomCode, room);
}

function livePlayers(room) {
  const hand = room.aiofHand;
  if (!hand) return [];
  return hand.actionOrder.filter((name) => !hand.folded.includes(name));
}

/** Moves actingIndex to the next player who still owes a decision, or starts the reveal. */
function advanceActingIndex(ctx, roomCode, room) {
  const hand = room.aiofHand;
  while (hand.actingIndex < hand.actionOrder.length) {
    const name = hand.actionOrder[hand.actingIndex];
    if (hand.folded.includes(name) || hand.autoActed.includes(name)) {
      hand.actingIndex += 1;
      continue;
    }
    broadcastAiof(ctx, roomCode, room);
    return;
  }
  runReveal(ctx, roomCode, room);
}

function applyDecision(ctx, roomCode, room, name, decision) {
  if (decision !== 'ALL_IN' && decision !== 'FOLD') {
    return { ok: false, error: 'Invalid decision' };
  }
  const hand = room.aiofHand;
  if (!hand || hand.stage !== 'deciding') return { ok: false, error: 'Not deciding right now' };

  if (hand.actionOrder[hand.actingIndex] !== name) return { ok: false, error: 'Not your turn' };

  if (decision === 'ALL_IN') {
    const stack = room.aiofStacks[name] || 0;
    hand.contributions[name] = (hand.contributions[name] || 0) + stack;
    room.aiofStacks[name] = 0;
  } else {
    hand.folded.push(name);
  }
  hand.actingIndex += 1;

  if (decision === 'FOLD' && checkUncontestedWin(ctx, roomCode, room)) {
    return { ok: true };
  }

  advanceActingIndex(ctx, roomCode, room);
  return { ok: true };
}

function checkUncontestedWin(ctx, roomCode, room) {
  const live = livePlayers(room);
  if (live.length !== 1) return false;

  const winner = live[0];
  const hand = room.aiofHand;
  const potTotal = Object.values(hand.contributions).reduce((a, b) => a + b, 0);
  room.aiofStacks[winner] = (room.aiofStacks[winner] || 0) + potTotal;
  room.aiofResults = { uncontested: true, winners: [winner], potTotal };
  finishHand(ctx, roomCode, room);
  return true;
}

function runReveal(ctx, roomCode, room) {
  const hand = room.aiofHand;
  hand.stage = 'revealingFlop';
  hand.revealedCount = 3;
  broadcastAiof(ctx, roomCode, room);
  scheduleRevealStage(ctx, roomCode, room, 0);
}

function scheduleRevealStage(ctx, roomCode, room, sequenceIndex) {
  clearAiofTimer(roomCode);
  aiofTimers.set(
    roomCode,
    setTimeout(() => {
      aiofTimers.delete(roomCode);
      const hand = room.aiofHand;
      if (!hand) return;
      if (sequenceIndex >= AIOF_REVEAL_SEQUENCE.length) {
        runShowdown(ctx, roomCode, room);
        return;
      }
      const step = AIOF_REVEAL_SEQUENCE[sequenceIndex];
      hand.stage = step.stage;
      hand.revealedCount = step.revealedCount;
      broadcastAiof(ctx, roomCode, room);
      scheduleRevealStage(ctx, roomCode, room, sequenceIndex + 1);
    }, AIOF_REVEAL_STAGE_DELAY_MS)
  );
}

/**
 * Pure side-pot layering: folded players' contributions become dead money (added to the
 * main pot, ineligible to win); live players' distinct all-in amounts, sorted ascending,
 * each open a new pot layer contributed to (and eligible to) only players whose
 * contribution reaches that layer's threshold. No `room`/`ctx` — unit-testable standalone.
 */
function buildSidePots({ contributions, foldedNames }) {
  const folded = new Set(foldedNames || []);
  const liveNames = Object.keys(contributions).filter((name) => !folded.has(name));
  const deadMoney = Object.entries(contributions)
    .filter(([name]) => folded.has(name))
    .reduce((sum, [, amount]) => sum + amount, 0);

  const distinctThresholds = Array.from(
    new Set(liveNames.map((name) => contributions[name]))
  ).sort((a, b) => a - b);

  const pots = [];
  let prevThreshold = 0;
  distinctThresholds.forEach((threshold) => {
    const layerSize = threshold - prevThreshold;
    prevThreshold = threshold;
    if (layerSize <= 0) return;
    const eligibleNames = liveNames.filter((name) => contributions[name] >= threshold);
    let amount = layerSize * eligibleNames.length;
    if (pots.length === 0) amount += deadMoney;
    pots.push({ amount, eligibleNames });
  });

  return pots;
}

/** Adds each layer's pot (split among tied winners) to stacks, then ends the hand. */
function awardPots(ctx, room, sidePots, rankingsPerLayer) {
  const summaryLayers = [];
  sidePots.forEach((pot, i) => {
    const { winners, rankings } = rankingsPerLayer[i];
    const share = winners.length ? Math.floor(pot.amount / winners.length) : 0;
    let remainder = pot.amount - share * winners.length;
    winners.forEach((name) => {
      const extra = remainder > 0 ? 1 : 0;
      if (extra) remainder -= 1;
      room.aiofStacks[name] = (room.aiofStacks[name] || 0) + share + extra;
    });
    summaryLayers.push({ amount: pot.amount, winners, rankings });
  });
  room.aiofResults = { uncontested: false, pots: summaryLayers };
}

function runShowdown(ctx, roomCode, room) {
  const hand = room.aiofHand;
  if (!hand) return;
  hand.stage = 'showdown';

  const sidePots = buildSidePots({ contributions: hand.contributions, foldedNames: hand.folded });
  const rankingsPerLayer = sidePots.map((pot) => {
    const playersOnBoard = pot.eligibleNames.map((name) => ({
      name,
      holeCards: hand.holeCards[name],
      boardCards: hand.board,
    }));
    return rankBoard(playersOnBoard);
  });

  awardPots(ctx, room, sidePots, rankingsPerLayer);
  room.aiofResults.board = hand.board.slice();
  finishHand(ctx, roomCode, room);
}

/**
 * Ends the hand and leaves it for the host to advance: results stay on screen (with the
 * "Next Hand" button, see aiofNextHand handler) until they explicitly deal again — no more
 * auto-redeal timer here. `room.aiofResults` being non-null is what gates that button, and
 * is also what stops the sit/buy-in/decline handlers below from racing ahead of the host by
 * auto-redealing themselves while results are still showing.
 */
function finishHand(ctx, roomCode, room) {
  clearAiofTimer(roomCode);
  room.aiofHand = null;
  broadcastAiof(ctx, roomCode, room);
}

function computeNetProfit(room, name) {
  return (room.aiofStacks[name] || 0) - AIOF_STARTING_STACK * (room.aiofBuyIns[name] || 0);
}

/**
 * Ranks every name that ever sat this match by net profit, descending, with standard
 * competition ranking (ties share the same points; the next distinct rank skips
 * accordingly) — mirrors awardMenifotScoreboard's tie logic exactly.
 */
function computeAiofRanking(room) {
  const N = room.aiofEverSeated.length;
  const ranked = room.aiofEverSeated
    .map((name) => ({
      name,
      stack: room.aiofStacks[name] || 0,
      netProfit: computeNetProfit(room, name),
    }))
    .sort((a, b) => b.netProfit - a.netProfit || a.name.localeCompare(b.name));

  let i = 0;
  while (i < ranked.length) {
    let j = i + 1;
    while (j < ranked.length && ranked[j].netProfit === ranked[i].netProfit) j += 1;
    const points = N - i;
    for (let k = i; k < j; k++) ranked[k].points = points;
    i = j;
  }
  return ranked;
}

function awardAiofScoreboard(ctx, room) {
  for (const row of computeAiofRanking(room)) ctx.addScore(room, row.name, row.points);
}

function seatsPayload(room) {
  return room.aiofSeats.map((name) => {
    if (!name) return null;
    return {
      name,
      stack: room.aiofStacks[name] || 0,
      sittingOut: !!room.aiofSittingOut[name],
    };
  });
}

function aiofStatePayload(ctx, room, viewerName) {
  const hand = room.aiofHand;
  let handPayload = null;
  if (hand) {
    const actingName =
      hand.actingIndex < hand.actionOrder.length ? hand.actionOrder[hand.actingIndex] : null;
    handPayload = {
      stage: hand.stage,
      board: hand.board.slice(0, hand.revealedCount),
      myHoleCards: hand.holeCards[viewerName] ? hand.holeCards[viewerName].slice() : null,
      potTotal: Object.values(hand.contributions).reduce((a, b) => a + b, 0),
      actingName,
      isMyTurn: actingName != null && actingName === viewerName,
      foldedNames: hand.folded.slice(),
    };
  }

  return {
    game: 'allinorfold',
    phase: room.phase,
    host: room.hostName,
    seats: seatsPayload(room),
    mySeatIndex: room.aiofSeats.findIndex((n) => n === viewerName),
    dealerSeat: room.aiofDealerSeat,
    canStart: room.phase === 'seating' && occupiedSeatIndexes(room).length >= AIOF_MIN_PLAYERS,
    hand: handPayload,
    results: room.aiofResults,
    canDealNextHand: room.phase === 'playing' && !hand && room.aiofResults != null,
    waitingForPlayers:
      room.phase === 'playing' && !hand && activeSeatIndexes(room).length < AIOF_MIN_PLAYERS,
    canEndGame: room.phase === 'playing' && !hand,
    ranking: room.phase === 'gameover' ? computeAiofRanking(room) : null,
    scoreboard: room.phase === 'gameover' ? ctx.scoreboardEntries(room) : undefined,
  };
}

function broadcastAiof(ctx, roomCode, room) {
  for (const [name, p] of room.players.entries()) {
    if (!p.connected || !p.socketId) continue;
    ctx.io.to(p.socketId).emit('aiofState', aiofStatePayload(ctx, room, name));
  }
}

function onChoose(ctx, roomCode, room) {
  clearState(room, roomCode);
  room.phase = 'seating';
  broadcastAiof(ctx, roomCode, room);
}

function reconnectPayload(ctx, room, existingPlayer) {
  // Deliberate exception to every other game's reconnectPayload: a reconnecting player
  // always lands at the shared lobby (tile in "Rejoin" mode), never back at a seat — see
  // implementation/all-in-or-fold-plan.md's architecture note. Still reports `game` (so the
  // client's dual-entry tile knows to say "Rejoin" instead of "All-In or Fold") plus the
  // generic lobby fields main.js's shared lobby-render path needs — main.js's `atLobby`
  // check is what keeps this from being routed into the table-entry path instead.
  return {
    ok: true,
    atLobby: true,
    game: 'allinorfold',
    phase: 'lobby',
    players: ctx.connectedNames(room),
    host: room.hostName,
    scoreboard: ctx.scoreboardEntries(room),
    wordLanguage: room.wordLanguage || 'english',
    wordTheme: room.wordTheme || '',
  };
}

function onDisconnect(ctx, roomCode, room, name) {
  // A real disconnect is handled identically to a voluntary aiofLeaveTable — auto-fold if
  // pending, free the seat, broadcast. Host handoff is already generic (lobby.js runs it
  // before calling this), so nothing extra is needed here for that.
  leaveSeat(ctx, roomCode, room, name);
}

/**
 * A server restart drops every live connection at once with no per-player disconnect event
 * firing, so seats can't rely on onDisconnect to free them — every seat is reset here,
 * exactly like a mass simultaneous "Leave Lobby". Stacks/buy-ins/sitting-out/ever-seated
 * are preserved (persisted fields), so anyone who reconnects and re-sits resumes with their
 * exact prior numbers, same as the ordinary leave/rejoin flow. Any in-flight hand is
 * already discarded by construction (aiofHand isn't a persisted field), so this just makes
 * the rest of the room state consistent with that.
 */
function repairOnLoad(ctx, room) {
  room.aiofHand = null;
  room.aiofResults = null;
  room.aiofSeats = [null, null, null, null, null, null];
  if (!room.aiofStacks || typeof room.aiofStacks !== 'object') room.aiofStacks = {};
  if (!room.aiofBuyIns || typeof room.aiofBuyIns !== 'object') room.aiofBuyIns = {};
  if (!room.aiofSittingOut || typeof room.aiofSittingOut !== 'object') room.aiofSittingOut = {};
  if (!Array.isArray(room.aiofEverSeated)) room.aiofEverSeated = [];
}

function registerHandlers(ctx, io, socket) {
  socket.on('enterAllInOrFold', (callback) => {
    callback = callback || (() => {});
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'allinorfold') return callback({ ok: false, error: 'No match running' });

    const name = socket.data.name;
    callback({ ok: true, ...aiofStatePayload(ctx, room, name) });
  });

  socket.on('aiofSitSeat', (data, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'allinorfold') return callback({ ok: false, error: 'Not playing All-In or Fold' });
    if (room.phase !== 'seating' && room.phase !== 'playing') {
      return callback({ ok: false, error: 'Not seating right now' });
    }

    const name = socket.data.name;
    const seatIndex = Number(data && data.seatIndex);
    const result = sitInSeat(ctx, room, name, seatIndex);
    if (!result.ok) return callback(result);

    callback({ ok: true });
    broadcastAiof(ctx, roomCode, room);
    // Re-attempt dealing if this sit brought the table out of "waiting for players" (only
    // meaningful once the match has started) — but not while a just-finished hand's results
    // are still on screen awaiting the host's "Next Hand" (see finishHand).
    if (room.phase === 'playing' && !room.aiofHand && !room.aiofResults) {
      dealNextHand(ctx, roomCode, room);
    }
  });

  socket.on('startAllInOrFold', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'allinorfold' || room.phase !== 'seating') {
      return callback({ ok: false, error: 'Not ready to start' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can start' });
    }
    if (occupiedSeatIndexes(room).length < AIOF_MIN_PLAYERS) {
      return callback({ ok: false, error: `Need at least ${AIOF_MIN_PLAYERS} seated players` });
    }

    room.aiofDealerSeat = room.aiofSeats.findIndex((n) => n === room.hostName);
    room.phase = 'playing';
    callback({ ok: true });
    dealNextHand(ctx, roomCode, room, { rotateDealer: false });
  });

  socket.on('aiofNextHand', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'allinorfold' || room.phase !== 'playing') {
      return callback({ ok: false, error: 'Not playing right now' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can deal the next hand' });
    }
    if (room.aiofHand != null) {
      return callback({ ok: false, error: 'Wait for the current hand to finish' });
    }

    room.aiofResults = null;
    callback({ ok: true });
    dealNextHand(ctx, roomCode, room);
  });

  socket.on('aiofDecision', (data, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'allinorfold') return callback({ ok: false, error: 'Not playing All-In or Fold' });

    const name = socket.data.name;
    const decision = data && data.decision;
    const result = applyDecision(ctx, roomCode, room, name, decision);
    if (!result.ok) return callback(result);

    callback({ ok: true });
  });

  socket.on('aiofBuyIn', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'allinorfold') return callback({ ok: false, error: 'Not playing All-In or Fold' });

    const name = socket.data.name;
    if (!room.aiofSeats.includes(name)) return callback({ ok: false, error: 'Not seated' });
    if ((room.aiofStacks[name] || 0) !== 0) {
      return callback({ ok: false, error: 'Only available when your stack is at 0' });
    }

    room.aiofStacks[name] = AIOF_STARTING_STACK;
    room.aiofBuyIns[name] = (room.aiofBuyIns[name] || 0) + 1;
    delete room.aiofSittingOut[name];

    callback({ ok: true });
    broadcastAiof(ctx, roomCode, room);
    if (!room.aiofHand && !room.aiofResults) dealNextHand(ctx, roomCode, room);
  });

  socket.on('aiofDeclineBuyIn', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'allinorfold') return callback({ ok: false, error: 'Not playing All-In or Fold' });

    const name = socket.data.name;
    if (!room.aiofSeats.includes(name)) return callback({ ok: false, error: 'Not seated' });
    if ((room.aiofStacks[name] || 0) !== 0) {
      return callback({ ok: false, error: 'Only available when your stack is at 0' });
    }

    room.aiofSittingOut[name] = true;

    callback({ ok: true });
    broadcastAiof(ctx, roomCode, room);
    if (!room.aiofHand && !room.aiofResults) dealNextHand(ctx, roomCode, room);
  });

  socket.on('aiofLeaveTable', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'allinorfold') return callback({ ok: false, error: 'Not playing All-In or Fold' });

    const name = socket.data.name;
    leaveSeat(ctx, roomCode, room, name);

    // The leaver is still a connected room member (this is a per-game seat exit, not a
    // room departure), so the shared disconnect-handoff logic in lobby.js never runs for
    // this case — reassign host here, same rule (first other connected player).
    if (room.hostName === name) {
      const [nextHost] = ctx.connectedNames(room).filter((n) => n !== name);
      room.hostName = nextHost || null;
      ctx.roomEmit(roomCode, 'hostUpdate', { host: room.hostName });
    }

    callback({ ok: true });
  });

  socket.on('endAllInOrFoldGame', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'allinorfold' || room.phase !== 'playing') {
      return callback({ ok: false, error: 'Not playing right now' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can end the game' });
    }
    if (room.aiofHand != null) {
      return callback({ ok: false, error: 'Wait for the current hand to finish' });
    }

    clearAiofTimer(roomCode);
    awardAiofScoreboard(ctx, room);
    room.phase = 'gameover';
    callback({ ok: true });
    broadcastAiof(ctx, roomCode, room);
  });
}

module.exports = {
  id: 'allinorfold',
  minPlayers: AIOF_MIN_PLAYERS,
  maxPlayers: AIOF_MAX_SEATS,
  onChoose,
  registerHandlers,
  reconnectPayload,
  onDisconnect,
  savedFields: SAVED_FIELDS,
  repairOnLoad,
  clearState,
  buildSidePots,
};
