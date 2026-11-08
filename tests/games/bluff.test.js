'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Must be set before server/betting.js is first required (by bluff.js below) - it reads
// this once at module load, same pattern tests/games/betting.test.js uses.
process.env.BETTING_ENABLED = 'true';
const db = require('../../server/db');
const betting = require('../../server/betting');
const bluff = require('../../server/games/bluff');
const {
  createTestCtx,
  createRoom,
  addPlayer,
  makeHandlerSocket,
  registerGame,
  call,
  emissionsFor,
  flush,
} = require('../helpers/harness');

test('contract shape', () => {
  assert.equal(bluff.id, 'bluff');
  assert.equal(bluff.minPlayers, 2);
});

test('bfSetStartingCount: host-only, clamped to 1..floor(52/connectedCount)', async () => {
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob'], { game: 'bluff', phase: 'seating' });
  const host = registerGame(bluff, ctx, makeHandlerSocket('AAAA', room.hostName));
  const other = registerGame(bluff, ctx, makeHandlerSocket('AAAA', 'Bob'));

  const rejected = await call(other, 'bfSetStartingCount', { count: 5 });
  assert.equal(rejected.ok, false);

  const tooHigh = await call(host, 'bfSetStartingCount', { count: 999 });
  assert.equal(tooHigh.ok, true);
  assert.equal(room.state.bluff.pendingStartCount, 26, 'floor(52/2) = 26 max for 2 players');

  const tooLow = await call(host, 'bfSetStartingCount', { count: 0 });
  assert.equal(tooLow.ok, true);
  assert.equal(room.state.bluff.pendingStartCount, 1);
});

test('startBluffMatch: deals every connected player the chosen starting count', async () => {
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob', 'Cid'], { game: 'bluff', phase: 'seating' });
  const host = registerGame(bluff, ctx, makeHandlerSocket('AAAA', room.hostName));
  await call(host, 'bfSetStartingCount', { count: 3 });

  const res = await call(host, 'startBluffMatch');
  assert.equal(res.ok, true);
  assert.equal(room.phase, 'playing');
  assert.equal(room.state.bluff.roundNumber, 1);
  for (const name of ['Ann', 'Bob', 'Cid']) {
    assert.equal(room.state.bluff.counts[name], 3);
    assert.equal(room.state.bluff.hands[name].length, 3);
  }
});

test('bfSelectLoser down to one player ends the match immediately and scores by elimination order', async () => {
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob'], { game: 'bluff', phase: 'playing' });
  room.state.bluff.players = ['Ann', 'Bob'];
  room.state.bluff.counts = { Ann: 1, Bob: 1 };
  room.state.bluff.hands = { Ann: ['Ah'], Bob: ['2c'] };
  room.state.bluff.roundNumber = 1;
  room.state.bluff.eliminationOrder = [];

  const host = registerGame(bluff, ctx, makeHandlerSocket('AAAA', room.hostName));
  const res = await call(host, 'bfSelectLoser', { name: 'Bob' });
  assert.equal(res.ok, true);

  assert.equal(room.state.bluff.counts.Bob, 0);
  assert.equal(room.phase, 'gameover');
  assert.equal(room.scoreboard.Ann, 2, 'winner of a 2-player match scores N points');
  assert.equal(room.scoreboard.Bob, 1);
});

test('bfSelectLoser with players remaining schedules the next deal (not immediate)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob', 'Cid'], { game: 'bluff', phase: 'playing' });
  room.state.bluff.players = ['Ann', 'Bob', 'Cid'];
  room.state.bluff.counts = { Ann: 2, Bob: 2, Cid: 2 };
  room.state.bluff.hands = { Ann: ['Ah', 'Kh'], Bob: ['2c', '3c'], Cid: ['4d', '5d'] };
  room.state.bluff.roundNumber = 1;
  room.state.bluff.eliminationOrder = [];

  const host = registerGame(bluff, ctx, makeHandlerSocket('AAAA', room.hostName));
  const res = await call(host, 'bfSelectLoser', { name: 'Bob' });
  assert.equal(res.ok, true);
  assert.equal(room.state.bluff.counts.Bob, 1);
  assert.equal(room.phase, 'playing', 'match keeps going - Bob is not eliminated yet');
  assert.equal(room.state.bluff.roundNumber, 1, 'no new deal until the highlight pause elapses');

  t.mock.timers.tick(1500 + 2200);
  assert.equal(room.state.bluff.roundNumber, 2, 'the scheduled deal fired after the pause');
  assert.equal(room.state.bluff.lastResult, null);
});

test('bfCheckHand: reveals presence after the countdown, host-only, one check at a time', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob'], { game: 'bluff', phase: 'playing' });
  room.state.bluff.players = ['Ann', 'Bob'];
  room.state.bluff.counts = { Ann: 2, Bob: 2 };
  room.state.bluff.hands = { Ann: ['Ah', 'Kh'], Bob: ['2c', '3c'] };
  room.state.bluff.roundNumber = 1;

  const other = registerGame(bluff, ctx, makeHandlerSocket('AAAA', 'Bob'));
  const host = registerGame(bluff, ctx, makeHandlerSocket('AAAA', room.hostName));

  const rejected = await call(other, 'bfCheckHand', { ranks: ['A'] });
  assert.equal(rejected.ok, false);

  const present = await call(host, 'bfCheckHand', { ranks: ['A', '2'] });
  assert.equal(present.ok, true);
  assert.equal(room.state.bluff.check.present, null, 'result is withheld during the countdown');

  const duringCountdown = await call(host, 'bfCheckHand', { ranks: ['K'] });
  assert.equal(duringCountdown.ok, false);

  t.mock.timers.tick(3000);
  assert.equal(room.state.bluff.check.present, true, 'A and 2 are both in the pooled hands');
});

test('bfStartEdit / bfAdjustEditCount / bfConfirmEdit: host-only draft counts, capped by the deck', async () => {
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob'], { game: 'bluff', phase: 'playing' });
  room.state.bluff.players = ['Ann', 'Bob'];
  room.state.bluff.counts = { Ann: 2, Bob: 2 };
  room.state.bluff.hands = { Ann: ['Ah', 'Kh'], Bob: ['2c', '3c'] };
  room.state.bluff.roundNumber = 1;

  const host = registerGame(bluff, ctx, makeHandlerSocket('AAAA', room.hostName));
  const start = await call(host, 'bfStartEdit');
  assert.equal(start.ok, true);
  assert.deepEqual(room.state.bluff.editCounts, { Ann: 2, Bob: 2 });

  const bumped = await call(host, 'bfAdjustEditCount', { name: 'Ann', delta: 1 });
  assert.equal(bumped.ok, true);
  assert.equal(room.state.bluff.editCounts.Ann, 3);

  const downToOne = await call(host, 'bfAdjustEditCount', { name: 'Bob', delta: -1 });
  assert.equal(downToOne.ok, true);
  const downToZero = await call(host, 'bfAdjustEditCount', { name: 'Bob', delta: -1 });
  assert.equal(downToZero.ok, true);
  assert.equal(room.state.bluff.editCounts.Bob, 0);
  const tooLow = await call(host, 'bfAdjustEditCount', { name: 'Bob', delta: -1 });
  assert.equal(tooLow.ok, false, 'cannot go below 0');

  // Bring Bob back up before confirming so the match doesn't end as a side effect here -
  // that path (editing a player down to 0) is covered separately.
  await call(host, 'bfAdjustEditCount', { name: 'Bob', delta: 1 });

  const confirmed = await call(host, 'bfConfirmEdit');
  assert.equal(confirmed.ok, true);
  assert.equal(room.state.bluff.counts.Ann, 3);
  assert.equal(room.state.bluff.counts.Bob, 1);
  assert.equal(room.state.bluff.editing, false);
});

test('an eliminated player becomes a spectator who sees every active hand', async () => {
  const { ctx, io } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob', 'Cid'], { game: 'bluff', phase: 'playing' });
  room.state.bluff.players = ['Ann', 'Bob', 'Cid'];
  room.state.bluff.counts = { Ann: 2, Bob: 1, Cid: 2 };
  room.state.bluff.hands = { Ann: ['Ah', 'Kh'], Bob: ['2c'], Cid: ['4d', '5d'] };
  room.state.bluff.roundNumber = 1;
  room.state.bluff.eliminationOrder = [];

  const host = registerGame(bluff, ctx, makeHandlerSocket('AAAA', room.hostName));
  const res = await call(host, 'bfSelectLoser', { name: 'Bob' });
  assert.equal(res.ok, true);
  assert.equal(room.state.bluff.counts.Bob, 0);

  const bobEmits = emissionsFor(io, room, 'Bob');
  const bobState = bobEmits[bobEmits.length - 1].payload;
  assert.equal(bobState.isSpectator, true);
  assert.deepEqual(
    bobState.allHands.map((h) => h.name).sort(),
    ['Ann', 'Cid']
  );

  const annEmits = emissionsFor(io, room, 'Ann');
  const annState = annEmits[annEmits.length - 1].payload;
  assert.equal(annState.isSpectator, false);
  assert.equal(annState.allHands, null);
});

test('startBluffMatch opens a start global-bet window for the whole frozen roster', async (t) => {
  const calls = [];
  t.mock.method(betting, 'openGlobalBetWindow', (room, roomCode, opts) => calls.push(opts));
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob', 'Cid'], { game: 'bluff', phase: 'seating' });
  const host = registerGame(bluff, ctx, makeHandlerSocket('AAAA', room.hostName));

  await call(host, 'startBluffMatch');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].trigger, 'start');
  assert.deepEqual(calls[0].offerTo.slice().sort(), ['Ann', 'Bob', 'Cid']);
  assert.deepEqual(calls[0].eligible.slice().sort(), ['Ann', 'Bob', 'Cid']);
});

test('eliminating a player opens a global-bet window offered only to them, eligible = who is still active', async (t) => {
  const calls = [];
  t.mock.method(betting, 'openGlobalBetWindow', (room, roomCode, opts) => calls.push(opts));
  t.mock.method(betting, 'resolveSideBets', async () => []);
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob', 'Cid'], { game: 'bluff', phase: 'playing' });
  room.state.bluff.players = ['Ann', 'Bob', 'Cid'];
  room.state.bluff.counts = { Ann: 2, Bob: 1, Cid: 2 };
  room.state.bluff.hands = { Ann: ['Ah', 'Kh'], Bob: ['2c'], Cid: ['4d', '5d'] };
  room.state.bluff.roundNumber = 1;
  const host = registerGame(bluff, ctx, makeHandlerSocket('AAAA', room.hostName));

  await call(host, 'bfSelectLoser', { name: 'Bob' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].trigger, 'elimination:Bob');
  assert.deepEqual(calls[0].offerTo, ['Bob']);
  assert.deepEqual(calls[0].eligible.slice().sort(), ['Ann', 'Cid']);
});

test('a round ending resolves side bets for that exact round and loser, win or not', async (t) => {
  const calls = [];
  t.mock.method(betting, 'resolveSideBets', async (room, roomCode, opts) => {
    calls.push(opts);
    return [];
  });
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob', 'Cid'], { game: 'bluff', phase: 'playing' });
  room.state.bluff.players = ['Ann', 'Bob', 'Cid'];
  room.state.bluff.counts = { Ann: 2, Bob: 2, Cid: 2 };
  room.state.bluff.hands = { Ann: ['Ah', 'Kh'], Bob: ['2c', '3c'], Cid: ['4d', '5d'] };
  room.state.bluff.roundNumber = 5;
  const host = registerGame(bluff, ctx, makeHandlerSocket('AAAA', room.hostName));

  await call(host, 'bfSelectLoser', { name: 'Bob' });
  assert.deepEqual(calls, [{ roundNumber: 5, loserName: 'Bob' }]);
});

test('the match ending resolves global bets once the game is recorded, naming the real winner', async (t) => {
  const calls = [];
  t.mock.method(betting, 'resolveGlobalBets', async (room, roomCode, opts) => {
    calls.push(opts);
    return [];
  });
  t.mock.method(betting, 'resolveSideBets', async () => []);
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob'], { game: 'bluff', phase: 'playing' });
  room.state.bluff.players = ['Ann', 'Bob'];
  room.state.bluff.counts = { Ann: 1, Bob: 1 };
  room.state.bluff.hands = { Ann: ['Ah'], Bob: ['2c'] };
  room.state.bluff.roundNumber = 1;
  const host = registerGame(bluff, ctx, makeHandlerSocket('AAAA', room.hostName));

  await call(host, 'bfSelectLoser', { name: 'Bob' });
  assert.equal(room.phase, 'gameover');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].winnerName, 'Ann', 'Ann is the one player left with cards');
  assert.equal(typeof calls[0].gameId, 'number', 'the fake gameId from ctx.recordGameResult\'s onRecorded');
});

test('confirming a card-count edit voids side bets for the edited round before dealing on', async (t) => {
  const calls = [];
  t.mock.method(betting, 'voidSideBets', async (room, roomCode, roundNumber) => {
    calls.push(roundNumber);
    return [];
  });
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob', 'Cid'], { game: 'bluff', phase: 'playing' });
  room.state.bluff.players = ['Ann', 'Bob', 'Cid'];
  room.state.bluff.counts = { Ann: 2, Bob: 2, Cid: 2 };
  room.state.bluff.hands = { Ann: ['Ah', 'Kh'], Bob: ['2c', '3c'], Cid: ['4d', '5d'] };
  room.state.bluff.roundNumber = 3;
  room.state.bluff.editing = true;
  room.state.bluff.editCounts = { Ann: 2, Bob: 1, Cid: 2 };
  const host = registerGame(bluff, ctx, makeHandlerSocket('AAAA', room.hostName));

  const res = await call(host, 'bfConfirmEdit');
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [3]);
});

test('bfResetGame clears any open betting windows and proposals, and expires dangling DB bets', async (t) => {
  const expireCalls = [];
  t.mock.method(betting, 'expireDanglingBets', async (roomCode) => expireCalls.push(roomCode));
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob'], { game: 'bluff', phase: 'gameover' });
  room.state.betting.globalWindows = { start: { eligible: ['Ann'], offerTo: ['Ann'], responded: new Set() } };
  room.state.betting.sideProposals = { 1: [{ id: 1, bettorName: 'Ann' }] };
  const host = registerGame(bluff, ctx, makeHandlerSocket('AAAA', room.hostName));

  const res = await call(host, 'bfResetGame');
  assert.equal(res.ok, true);
  assert.deepEqual(room.state.betting.globalWindows, {});
  assert.deepEqual(room.state.betting.sideProposals, {});
  // Without this, an already-accepted bet's Postgres row would survive the reset and be
  // mis-resolved against the next match in this same room (room_code-scoped sweep).
  assert.deepEqual(expireCalls, ['AAAA']);
});

test('a synchronous broadcast omits the betting key, so the client keeps its betting UI', async (t) => {
  // The sync frame must NOT carry betting: null - that would make the client tear down the
  // betting panel/modal on every broadcast. betting rides only on the pushBettingViews
  // follow-up. We assert on what broadcastBluff actually emits over the fake io.
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob'], { game: 'bluff', phase: 'playing' });
  room.state.bluff.players = ['Ann', 'Bob'];
  room.state.bluff.counts = { Ann: 2, Bob: 2 };
  room.state.bluff.hands = { Ann: ['Ah', 'Kh'], Bob: ['2c', '3c'] };
  room.state.bluff.roundNumber = 1;
  registerGame(bluff, ctx, makeHandlerSocket('AAAA', room.hostName));

  // Drive a real synchronous broadcast and inspect exactly what went over the fake io.
  bluff.onReconnectBroadcast(ctx, 'AAAA', room);
  const frames = ctx.io.emissions.filter((e) => e.event === 'bluffState');
  assert.ok(frames.length > 0, 'a synchronous frame was emitted');
  for (const f of frames) {
    assert.equal('betting' in f.payload, false, 'sync frame does not carry a betting key');
  }
});

test('betPlaceGlobal/betProposeSide/betAcceptSide all reject a player who is not signed in', async () => {
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob'], { game: 'bluff', phase: 'playing' });
  room.state.bluff.players = ['Ann', 'Bob'];
  room.state.bluff.counts = { Ann: 2, Bob: 2 };
  room.state.bluff.hands = { Ann: ['Ah', 'Kh'], Bob: ['2c', '3c'] };
  room.state.bluff.roundNumber = 1;
  room.state.betting.globalWindows = { start: { eligible: ['Ann', 'Bob'], offerTo: ['Ann', 'Bob'], responded: new Set() } };
  const ann = registerGame(bluff, ctx, makeHandlerSocket('AAAA', 'Ann')); // no userId - a guest

  const place = await call(ann, 'betPlaceGlobal', { trigger: 'start', pick: 'Ann', stake: 50 });
  assert.equal(place.ok, false);
  const propose = await call(ann, 'betProposeSide', { pick: 'Bob', stake: 20 });
  assert.equal(propose.ok, false);
  const accept = await call(ann, 'betAcceptSide', { proposalId: 1 });
  assert.equal(accept.ok, false);
});

test('betPlaceGlobal: a signed-in player places a bet on an open window end to end', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  // Covers pushBettingViews' own getBalance/bettingViewFor reads, fired as a
  // fire-and-forget side effect of every broadcast - not the point of this test.
  t.mock.method(db, 'query', async () => ({ rows: [] }));
  t.mock.method(db, 'transaction', async (fn) => fn({ query: async () => ({ rows: [], rowCount: 1 }) }));
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob'], { game: 'bluff', phase: 'seating' });
  addPlayer(room, 'Ann', { userId: 1 });
  const host = registerGame(bluff, ctx, makeHandlerSocket('AAAA', 'Ann'));
  await call(host, 'startBluffMatch');
  assert.deepEqual(room.state.betting.globalWindows.start.offerTo.slice().sort(), ['Ann', 'Bob']);

  const res = await call(host, 'betPlaceGlobal', { trigger: 'start', pick: 'Ann', stake: 50 });
  assert.equal(res.ok, true);
  assert.equal(room.state.betting.globalWindows.start.responded.has('Ann'), true);
});

test('betProposeSide then betAcceptSide locks in a side bet and clears the proposal, end to end', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  t.mock.method(db, 'query', async () => ({ rows: [{ balance: 500 }] }));
  t.mock.method(db, 'transaction', async (fn) => fn({ query: async () => ({ rows: [], rowCount: 1 }) }));
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob', 'Cid'], { game: 'bluff', phase: 'playing' });
  addPlayer(room, 'Ann', { userId: 1 });
  addPlayer(room, 'Bob', { userId: 2 });
  room.state.bluff.players = ['Ann', 'Bob', 'Cid'];
  room.state.bluff.counts = { Ann: 2, Bob: 2, Cid: 2 };
  room.state.bluff.hands = { Ann: ['Ah', 'Kh'], Bob: ['2c', '3c'], Cid: ['4d', '5d'] };
  room.state.bluff.roundNumber = 1;
  const ann = registerGame(bluff, ctx, makeHandlerSocket('AAAA', 'Ann'));
  const bob = registerGame(bluff, ctx, makeHandlerSocket('AAAA', 'Bob'));

  const proposed = await call(ann, 'betProposeSide', { pick: 'Cid', stake: 20, targetName: 'Bob' });
  assert.equal(proposed.ok, true);

  const accepted = await call(bob, 'betAcceptSide', { proposalId: proposed.proposal.id });
  assert.equal(accepted.ok, true);
  assert.deepEqual(room.state.betting.sideProposals[1], []);
});

test('a resolved side bet pushes a betResolved toast to both the bettor and the accepter', async (t) => {
  t.mock.method(db, 'isEnabled', () => true);
  t.mock.method(db, 'query', async (text) => {
    if (/^SELECT.*bets\b/s.test(text) && /kind = 'side'/.test(text)) {
      return { rows: [{ id: 1, bettor_user_id: 1, opponent_user_id: 2, pick_name: 'Cid', stake: 20 }] };
    }
    return { rows: [] };
  });
  t.mock.method(db, 'transaction', async (fn) => fn({ query: async () => ({ rows: [], rowCount: 1 }) }));
  const { ctx, io } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob', 'Cid'], { game: 'bluff', phase: 'playing' });
  addPlayer(room, 'Ann', { userId: 1 });
  addPlayer(room, 'Bob', { userId: 2 });
  room.state.bluff.players = ['Ann', 'Bob', 'Cid'];
  room.state.bluff.counts = { Ann: 2, Bob: 2, Cid: 2 };
  room.state.bluff.hands = { Ann: ['Ah', 'Kh'], Bob: ['2c', '3c'], Cid: ['4d', '5d'] };
  room.state.bluff.roundNumber = 1;
  const host = registerGame(bluff, ctx, makeHandlerSocket('AAAA', room.hostName));

  // Ann bet Cid would lose this round; Cid really does - Ann wins, Bob loses.
  const res = await call(host, 'bfSelectLoser', { name: 'Cid' });
  assert.equal(res.ok, true);
  await flush();

  const annResolved = emissionsFor(io, room, 'Ann').find((e) => e.event === 'betResolved');
  const bobResolved = emissionsFor(io, room, 'Bob').find((e) => e.event === 'betResolved');
  assert.ok(annResolved, 'Ann (the bettor, correct pick) gets a toast');
  assert.equal(annResolved.payload.won, true);
  assert.equal(annResolved.payload.payout, 40);
  assert.ok(bobResolved, 'Bob (the accepter, wrong side) gets a toast too');
  assert.equal(bobResolved.payload.won, false);
});
