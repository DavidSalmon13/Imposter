'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const menifot = require('../../server/games/menifot');
const { createTestCtx, createRoom, makeHandlerSocket, registerGame, call } = require('../helpers/harness');

test('contract shape', () => {
  assert.equal(menifot.id, 'menifot');
  assert.equal(menifot.minPlayers, 2);
  assert.equal(menifot.maxPlayers, 8);
});

test('startMenifot: deals a real round and picks 3 boards for <=3 players', async () => {
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob'], { game: 'menifot', phase: 'lobby' });
  menifot.onChoose(ctx, 'AAAA', room);
  assert.equal(room.phase, 'ready');

  const socket = registerGame(menifot, ctx, makeHandlerSocket('AAAA', room.hostName));
  const res = await call(socket, 'startMenifot');
  assert.equal(res.ok, true);
  assert.equal(room.phase, 'allocating');
  assert.equal(room.mfBoardCount, 3);
  assert.equal(room.mfBoards.length, 3);
  assert.equal(room.mfHands.Ann.cards.length, room.mfHands.Bob.cards.length);
});

test('mfAssignCard: rejects allocations that break the ±1 rule, mfLock requires every card placed', async () => {
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob'], { game: 'menifot', phase: 'allocating' });
  room.mfPlayers = ['Ann', 'Bob'];
  room.mfBoardCount = 2;
  room.mfHands = {
    Ann: { cards: ['Ah', 'Kh', 'Qh'], allocation: { 0: [], 1: [] }, locked: false },
    Bob: { cards: ['2c', '3c', '4c'], allocation: { 0: [], 1: [] }, locked: false },
  };

  const socket = registerGame(menifot, ctx, makeHandlerSocket('AAAA', 'Ann'));

  const lockTooEarly = await call(socket, 'mfLock');
  assert.equal(lockTooEarly.ok, false);

  // Stack all 3 cards on board 0 -> counts {0:3,1:0}, diff 3 > 1 -> rejected.
  await call(socket, 'mfAssignCard', { card: 'Ah', boardIndex: 0 });
  await call(socket, 'mfAssignCard', { card: 'Kh', boardIndex: 0 });
  const overLoad = await call(socket, 'mfAssignCard', { card: 'Qh', boardIndex: 0 });
  assert.equal(overLoad.ok, false);

  // A valid 2/1 split is accepted and lockable.
  const placeLast = await call(socket, 'mfAssignCard', { card: 'Qh', boardIndex: 1 });
  assert.equal(placeLast.ok, true);
  const lockRes = await call(socket, 'mfLock');
  assert.equal(lockRes.ok, true);
  assert.equal(room.mfHands.Ann.locked, true);
});

test('revealing every board resolves the round and scores the winner', async () => {
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob'], { game: 'menifot', phase: 'allocating' });
  room.mfPlayers = ['Ann', 'Bob'];
  room.mfBoardCount = 1;
  room.mfScores = { Ann: 0, Bob: 0 };
  room.mfRoundNumber = 1;
  room.mfBurned = [];
  room.mfHands = {
    // Ann holds Ah/Kh and the board's Qh/Jh/Th/9h complete a royal flush for her.
    Ann: { cards: ['Ah', 'Kh'], allocation: { 0: ['Ah', 'Kh'] }, locked: true },
    Bob: { cards: ['2c', '3d'], allocation: { 0: ['2c', '3d'] }, locked: true },
  };
  room.mfBoards = [
    { flop: ['Qh', 'Jh', 'Th'], turn: '9h', river: '2h', turnRevealed: false, riverRevealed: false },
  ];

  const socket = registerGame(menifot, ctx, makeHandlerSocket('AAAA', room.hostName));

  const riverTooEarly = await call(socket, 'mfRevealCard', { boardIndex: 0, part: 'river' });
  assert.equal(riverTooEarly.ok, false);

  const turnRes = await call(socket, 'mfRevealCard', { boardIndex: 0, part: 'turn' });
  assert.equal(turnRes.ok, true);
  assert.equal(room.phase, 'allocating', 'still allocating until every board is fully revealed');

  const riverRes = await call(socket, 'mfRevealCard', { boardIndex: 0, part: 'river' });
  assert.equal(riverRes.ok, true);

  assert.equal(room.mfRoundResults.boards[0].winners.length, 1);
  assert.equal(room.mfRoundResults.boards[0].winners[0], 'Ann');
  assert.equal(room.mfScores.Ann, 1);
  assert.equal(room.mfScores.Bob, 0);
});

test('reaching the target score ends the match and fans points into the scoreboard', async () => {
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob'], { game: 'menifot', phase: 'allocating' });
  room.mfPlayers = ['Ann', 'Bob'];
  room.mfBoardCount = 1;
  room.mfScores = { Ann: 9, Bob: 3 };
  room.mfRoundNumber = 5;
  room.mfBurned = [];
  room.mfHands = {
    Ann: { cards: ['Ah', 'Kh'], allocation: { 0: ['Ah', 'Kh'] }, locked: true },
    Bob: { cards: ['2c', '3d'], allocation: { 0: ['2c', '3d'] }, locked: true },
  };
  room.mfBoards = [
    { flop: ['Qh', 'Jh', 'Th'], turn: '9h', river: '2h', turnRevealed: false, riverRevealed: false },
  ];

  const socket = registerGame(menifot, ctx, makeHandlerSocket('AAAA', room.hostName));
  await call(socket, 'mfRevealCard', { boardIndex: 0, part: 'turn' });
  await call(socket, 'mfRevealCard', { boardIndex: 0, part: 'river' });

  assert.equal(room.mfScores.Ann, 10);
  assert.equal(room.phase, 'gameover');
  assert.deepEqual(room.mfMatchWinners, ['Ann']);
  assert.equal(room.scoreboard.Ann, 2, 'winner of a 2-player match gets N points (place 1)');
  assert.equal(room.scoreboard.Bob, 1, 'last place still gets N - 1 points');
});
