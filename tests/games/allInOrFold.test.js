'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const aiof = require('../../server/games/allInOrFold');
const { createTestCtx, createRoom, makeHandlerSocket, registerGame, call } = require('../helpers/harness');

test('contract shape', () => {
  assert.equal(aiof.id, 'allinorfold');
  assert.equal(aiof.minPlayers, 2);
  assert.equal(aiof.maxPlayers, 6);
});

test('buildSidePots: layers contributions correctly across all-in stack sizes', () => {
  const noFolds = aiof.buildSidePots({ contributions: { A: 50, B: 100, C: 100 }, foldedNames: [] });
  assert.deepEqual(noFolds, [
    { amount: 150, eligibleNames: ['A', 'B', 'C'] },
    { amount: 100, eligibleNames: ['B', 'C'] },
  ]);
  const total = noFolds.reduce((sum, p) => sum + p.amount, 0);
  assert.equal(total, 250);
});

test('buildSidePots: a folded player\'s contribution becomes dead money in the main pot', () => {
  const withFold = aiof.buildSidePots({ contributions: { A: 50, B: 100, C: 100 }, foldedNames: ['A'] });
  assert.deepEqual(withFold, [{ amount: 250, eligibleNames: ['B', 'C'] }]);
});

test('aiofSitSeat: rejects a taken seat and sitting twice', async () => {
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob'], { game: 'allinorfold', phase: 'seating' });
  const annSocket = registerGame(aiof, ctx, makeHandlerSocket('AAAA', 'Ann'));
  const bobSocket = registerGame(aiof, ctx, makeHandlerSocket('AAAA', 'Bob'));

  const sit1 = await call(annSocket, 'aiofSitSeat', { seatIndex: 0 });
  assert.equal(sit1.ok, true);
  assert.equal(room.state.allinorfold.stacks.Ann, 150);

  const taken = await call(bobSocket, 'aiofSitSeat', { seatIndex: 0 });
  assert.equal(taken.ok, false);

  const sit2 = await call(bobSocket, 'aiofSitSeat', { seatIndex: 1 });
  assert.equal(sit2.ok, true);

  const twice = await call(annSocket, 'aiofSitSeat', { seatIndex: 2 });
  assert.equal(twice.ok, false, 'already seated elsewhere');
});

test('heads-up hand: an uncontested fold awards the full pot immediately, no timers involved', async () => {
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob'], { game: 'allinorfold', phase: 'seating' });
  const annSocket = registerGame(aiof, ctx, makeHandlerSocket('AAAA', 'Ann'));
  const bobSocket = registerGame(aiof, ctx, makeHandlerSocket('AAAA', 'Bob'));
  await call(annSocket, 'aiofSitSeat', { seatIndex: 0 });
  await call(bobSocket, 'aiofSitSeat', { seatIndex: 1 });

  const startRes = await call(annSocket, 'startAllInOrFold');
  assert.equal(startRes.ok, true);
  assert.equal(room.phase, 'playing');
  assert.ok(room.state.allinorfold.hand, 'a hand was dealt');

  const sbName = room.state.allinorfold.hand.actionOrder[0];
  const bbName = sbName === 'Ann' ? 'Bob' : 'Ann';
  assert.equal(room.state.allinorfold.stacks[sbName], 150 - 5, 'small blind posted');
  assert.equal(room.state.allinorfold.stacks[bbName], 150 - 10, 'big blind posted');

  const sbSocket = sbName === 'Ann' ? annSocket : bobSocket;
  const foldRes = await call(sbSocket, 'aiofDecision', { decision: 'FOLD' });
  assert.equal(foldRes.ok, true);

  assert.equal(room.state.allinorfold.hand, null, 'hand finishes synchronously on an uncontested win');
  assert.equal(room.state.allinorfold.results.uncontested, true);
  assert.deepEqual(room.state.allinorfold.results.winners, [bbName]);
  assert.equal(room.state.allinorfold.stacks[bbName], 140 + 15, 'wins the 15-chip pot (5 SB + 10 BB)');

  const endRes = await call(annSocket, 'endAllInOrFoldGame');
  assert.equal(endRes.ok, true);
  assert.equal(room.phase, 'gameover');
  assert.equal(room.scoreboard[bbName], 2, 'net winner gets top points');
  assert.equal(room.scoreboard[sbName], 1);
});

test('startAllInOrFold: rejects non-host and too few seated players', async () => {
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob'], { game: 'allinorfold', phase: 'seating' });
  const annSocket = registerGame(aiof, ctx, makeHandlerSocket('AAAA', 'Ann'));
  const bobSocket = registerGame(aiof, ctx, makeHandlerSocket('AAAA', 'Bob'));

  const tooFew = await call(annSocket, 'startAllInOrFold');
  assert.equal(tooFew.ok, false, 'nobody seated yet');

  await call(annSocket, 'aiofSitSeat', { seatIndex: 0 });
  const nonHost = await call(bobSocket, 'startAllInOrFold');
  assert.equal(nonHost.ok, false);
});
