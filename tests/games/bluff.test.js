'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const bluff = require('../../server/games/bluff');
const { createTestCtx, createRoom, makeHandlerSocket, registerGame, call } = require('../helpers/harness');

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
  assert.equal(room.bfPendingStartCount, 26, 'floor(52/2) = 26 max for 2 players');

  const tooLow = await call(host, 'bfSetStartingCount', { count: 0 });
  assert.equal(tooLow.ok, true);
  assert.equal(room.bfPendingStartCount, 1);
});

test('startBluffMatch: deals every connected player the chosen starting count', async () => {
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob', 'Cid'], { game: 'bluff', phase: 'seating' });
  const host = registerGame(bluff, ctx, makeHandlerSocket('AAAA', room.hostName));
  await call(host, 'bfSetStartingCount', { count: 3 });

  const res = await call(host, 'startBluffMatch');
  assert.equal(res.ok, true);
  assert.equal(room.phase, 'playing');
  assert.equal(room.bfRoundNumber, 1);
  for (const name of ['Ann', 'Bob', 'Cid']) {
    assert.equal(room.bfCounts[name], 3);
    assert.equal(room.bfHands[name].length, 3);
  }
});

test('bfSelectLoser down to one player ends the match immediately and scores by elimination order', async () => {
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob'], { game: 'bluff', phase: 'playing' });
  room.bfPlayers = ['Ann', 'Bob'];
  room.bfCounts = { Ann: 1, Bob: 1 };
  room.bfHands = { Ann: ['Ah'], Bob: ['2c'] };
  room.bfRoundNumber = 1;
  room.bfEliminationOrder = [];

  const host = registerGame(bluff, ctx, makeHandlerSocket('AAAA', room.hostName));
  const res = await call(host, 'bfSelectLoser', { name: 'Bob' });
  assert.equal(res.ok, true);

  assert.equal(room.bfCounts.Bob, 0);
  assert.equal(room.phase, 'gameover');
  assert.equal(room.scoreboard.Ann, 2, 'winner of a 2-player match scores N points');
  assert.equal(room.scoreboard.Bob, 1);
});

test('bfSelectLoser with players remaining schedules the next deal (not immediate)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob', 'Cid'], { game: 'bluff', phase: 'playing' });
  room.bfPlayers = ['Ann', 'Bob', 'Cid'];
  room.bfCounts = { Ann: 2, Bob: 2, Cid: 2 };
  room.bfHands = { Ann: ['Ah', 'Kh'], Bob: ['2c', '3c'], Cid: ['4d', '5d'] };
  room.bfRoundNumber = 1;
  room.bfEliminationOrder = [];

  const host = registerGame(bluff, ctx, makeHandlerSocket('AAAA', room.hostName));
  const res = await call(host, 'bfSelectLoser', { name: 'Bob' });
  assert.equal(res.ok, true);
  assert.equal(room.bfCounts.Bob, 1);
  assert.equal(room.phase, 'playing', 'match keeps going - Bob is not eliminated yet');
  assert.equal(room.bfRoundNumber, 1, 'no new deal until the highlight pause elapses');

  t.mock.timers.tick(1500 + 2200);
  assert.equal(room.bfRoundNumber, 2, 'the scheduled deal fired after the pause');
  assert.equal(room.bfLastResult, null);
});

test('bfCheckHand: reveals presence after the countdown, host-only, one check at a time', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob'], { game: 'bluff', phase: 'playing' });
  room.bfPlayers = ['Ann', 'Bob'];
  room.bfCounts = { Ann: 2, Bob: 2 };
  room.bfHands = { Ann: ['Ah', 'Kh'], Bob: ['2c', '3c'] };
  room.bfRoundNumber = 1;

  const other = registerGame(bluff, ctx, makeHandlerSocket('AAAA', 'Bob'));
  const host = registerGame(bluff, ctx, makeHandlerSocket('AAAA', room.hostName));

  const rejected = await call(other, 'bfCheckHand', { ranks: ['A'] });
  assert.equal(rejected.ok, false);

  const present = await call(host, 'bfCheckHand', { ranks: ['A', '2'] });
  assert.equal(present.ok, true);
  assert.equal(room.bfCheck.present, null, 'result is withheld during the countdown');

  const duringCountdown = await call(host, 'bfCheckHand', { ranks: ['K'] });
  assert.equal(duringCountdown.ok, false);

  t.mock.timers.tick(3000);
  assert.equal(room.bfCheck.present, true, 'A and 2 are both in the pooled hands');
});

test('bfStartEdit / bfAdjustEditCount / bfConfirmEdit: host-only draft counts, capped by the deck', async () => {
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob'], { game: 'bluff', phase: 'playing' });
  room.bfPlayers = ['Ann', 'Bob'];
  room.bfCounts = { Ann: 2, Bob: 2 };
  room.bfHands = { Ann: ['Ah', 'Kh'], Bob: ['2c', '3c'] };
  room.bfRoundNumber = 1;

  const host = registerGame(bluff, ctx, makeHandlerSocket('AAAA', room.hostName));
  const start = await call(host, 'bfStartEdit');
  assert.equal(start.ok, true);
  assert.deepEqual(room.bfEditCounts, { Ann: 2, Bob: 2 });

  const bumped = await call(host, 'bfAdjustEditCount', { name: 'Ann', delta: 1 });
  assert.equal(bumped.ok, true);
  assert.equal(room.bfEditCounts.Ann, 3);

  const downToOne = await call(host, 'bfAdjustEditCount', { name: 'Bob', delta: -1 });
  assert.equal(downToOne.ok, true);
  const downToZero = await call(host, 'bfAdjustEditCount', { name: 'Bob', delta: -1 });
  assert.equal(downToZero.ok, true);
  assert.equal(room.bfEditCounts.Bob, 0);
  const tooLow = await call(host, 'bfAdjustEditCount', { name: 'Bob', delta: -1 });
  assert.equal(tooLow.ok, false, 'cannot go below 0');

  // Bring Bob back up before confirming so the match doesn't end as a side effect here -
  // that path (editing a player down to 0) is covered separately.
  await call(host, 'bfAdjustEditCount', { name: 'Bob', delta: 1 });

  const confirmed = await call(host, 'bfConfirmEdit');
  assert.equal(confirmed.ok, true);
  assert.equal(room.bfCounts.Ann, 3);
  assert.equal(room.bfCounts.Bob, 1);
  assert.equal(room.bfEditing, false);
});
