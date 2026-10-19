'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const tenseconds = require('../../server/games/tenseconds');
const { createTestCtx, createRoom, makeHandlerSocket, registerGame, call } = require('../helpers/harness');

test('contract shape', () => {
  assert.equal(tenseconds.id, 'tenseconds');
  assert.equal(tenseconds.minPlayers, 2);
});

test('startTensSeconds: rejects non-host and too few players', async () => {
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob'], { game: 'tenseconds', phase: 'lobby' });
  tenseconds.onChoose(ctx, 'AAAA', room);
  assert.equal(room.phase, 'ready');

  const nonHost = registerGame(tenseconds, ctx, makeHandlerSocket('AAAA', 'Bob'));
  const rejected = await call(nonHost, 'startTensSeconds');
  assert.equal(rejected.ok, false);

  room.tsActivePlayers = ['Ann'];
  const hostSocket = registerGame(tenseconds, ctx, makeHandlerSocket('AAAA', room.hostName));
  const tooFew = await call(hostSocket, 'startTensSeconds');
  assert.equal(tooFew.ok, false);
});

test('full 3-player match: elimination order drives final scoreboard points', async () => {
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob', 'Cid'], { game: 'tenseconds', phase: 'lobby' });
  tenseconds.onChoose(ctx, 'AAAA', room);

  const sockets = Object.fromEntries(
    ['Ann', 'Bob', 'Cid'].map((n) => [n, registerGame(tenseconds, ctx, makeHandlerSocket('AAAA', n))])
  );

  const hostStart = await call(sockets[room.hostName], 'startTensSeconds');
  assert.equal(hostStart.ok, true);
  assert.equal(room.phase, 'running');
  room.tsRoundStartAt = Date.now() - 1; // skip the real 3s countdown

  // Round 1: Cid is farthest from the 10s target -> eliminated.
  assert.equal((await call(sockets.Ann, 'tsStop', 10000)).ok, true);
  assert.equal((await call(sockets.Bob, 'tsStop', 9000)).ok, true);
  assert.equal((await call(sockets.Cid, 'tsStop', 7000)).ok, true);

  assert.equal(room.phase, 'roundResults');
  assert.deepEqual(room.tsEliminatedOrder, ['Cid']);
  assert.deepEqual(room.tsActivePlayers, ['Ann', 'Bob']);

  const continueRes = await call(sockets[room.hostName], 'tsContinue');
  assert.equal(continueRes.ok, true);
  assert.equal(room.phase, 'ready');

  const startRound2 = await call(sockets[room.hostName], 'startTensSeconds');
  assert.equal(startRound2.ok, true);
  room.tsRoundStartAt = Date.now() - 1;

  // Round 2: Bob is farther from target -> eliminated -> only Ann left -> gameover.
  assert.equal((await call(sockets.Ann, 'tsStop', 10000)).ok, true);
  assert.equal((await call(sockets.Bob, 'tsStop', 11000)).ok, true);
  assert.equal(room.phase, 'roundResults');
  await call(sockets[room.hostName], 'tsContinue');

  assert.equal(room.phase, 'gameover');
  assert.deepEqual(room.tsActivePlayers, ['Ann']);
  assert.equal(room.scoreboard.Ann, 2, 'champion scores 2');
  assert.equal(room.scoreboard.Bob, 1, 'most-recently-eliminated (2nd place) scores 1');
  assert.equal(room.scoreboard.Cid, -1, 'first eliminated (last place) scores -1');
});

test('a tie for worst distance triggers sudden death between just the tied pair', async () => {
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob', 'Cid', 'Dee'], { game: 'tenseconds', phase: 'lobby' });
  tenseconds.onChoose(ctx, 'AAAA', room);
  const sockets = Object.fromEntries(
    ['Ann', 'Bob', 'Cid', 'Dee'].map((n) => [n, registerGame(tenseconds, ctx, makeHandlerSocket('AAAA', n))])
  );
  await call(sockets[room.hostName], 'startTensSeconds');
  room.tsRoundStartAt = Date.now() - 1;

  // Ann is clearly best; Bob and Cid tie for worst (both 2000ms off); Dee is in between.
  await call(sockets.Ann, 'tsStop', 10000);
  await call(sockets.Dee, 'tsStop', 9500);
  await call(sockets.Bob, 'tsStop', 8000);
  const res = await call(sockets.Cid, 'tsStop', 12000);
  assert.equal(res.ok, true);

  assert.equal(room.phase, 'running');
  assert.equal(room.tsSuddenDeath, true);
  assert.deepEqual(new Set(room.tsContenders), new Set(['Bob', 'Cid']));
  assert.deepEqual(room.tsActivePlayers, ['Ann', 'Bob', 'Cid', 'Dee'], 'nobody eliminated yet');
});

test('onDisconnect during a running round assigns a DNF and can resolve the round', async () => {
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob'], { game: 'tenseconds', phase: 'lobby' });
  tenseconds.onChoose(ctx, 'AAAA', room);
  const sockets = Object.fromEntries(
    ['Ann', 'Bob'].map((n) => [n, registerGame(tenseconds, ctx, makeHandlerSocket('AAAA', n))])
  );
  await call(sockets[room.hostName], 'startTensSeconds');
  room.tsRoundStartAt = Date.now() - 1;

  await call(sockets.Ann, 'tsStop', 10000);
  tenseconds.onDisconnect(ctx, 'AAAA', room, 'Bob');
  assert.equal(room.phase, 'roundResults');
  await call(sockets[room.hostName], 'tsContinue');

  assert.equal(room.phase, 'gameover');
  assert.deepEqual(room.tsActivePlayers, ['Ann']);
  assert.deepEqual(room.tsEliminatedOrder, ['Bob']);
});
