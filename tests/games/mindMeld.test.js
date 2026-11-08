'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const mindMeld = require('../../server/games/mindMeld');
const {
  createTestCtx,
  createRoom,
  makeHandlerSocket,
  registerGame,
  call,
  mockOpenAi,
  flush,
} = require('../helpers/harness');

test('contract shape', () => {
  assert.equal(mindMeld.id, 'mindmeld');
  assert.equal(mindMeld.minPlayers, 3);
  assert.equal(mindMeld.maxPlayers, 10);
});

test('startMindMeld: rejects non-host and too few players', async () => {
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob'], { game: 'mindmeld', phase: 'lobby' });
  mindMeld.onChoose(ctx, 'AAAA', room);
  const host = registerGame(mindMeld, ctx, makeHandlerSocket('AAAA', room.hostName));
  const other = registerGame(mindMeld, ctx, makeHandlerSocket('AAAA', 'Bob'));

  const tooFew = await call(host, 'startMindMeld');
  assert.equal(tooFew.ok, false);

  room.players.set('Cid', { socketId: 'sock-Cid', connected: true });
  const nonHost = await call(other, 'startMindMeld');
  assert.equal(nonHost.ok, false);
});

test('full round: numeric answers are ranked by closeness with a bullseye bonus', async (t) => {
  // Fixes the otherName (25%) and judged-kind (30%) branch rolls off, landing on the plain
  // self-question/numeric path every time, so the round's shape is deterministic.
  t.mock.method(Math, 'random', () => 0.9);

  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob', 'Cid'], { game: 'mindmeld', phase: 'lobby' });
  mindMeld.onChoose(ctx, 'AAAA', room);
  const sockets = Object.fromEntries(
    ['Ann', 'Bob', 'Cid'].map((n) => [n, registerGame(mindMeld, ctx, makeHandlerSocket('AAAA', n))])
  );

  const restore = mockOpenAi({ question: 'How many socks do you own?' });
  try {
    const res = await call(sockets[room.hostName], 'startMindMeld');
    assert.equal(res.ok, true);
    await flush();
  } finally {
    restore();
  }

  assert.equal(room.phase, 'answering');
  assert.equal(room.state.mindmeld.questionKind, 'number');
  const subject = room.state.mindmeld.rotationOrder[room.state.mindmeld.rotationIndex];
  const [closeGuesser, farGuesser] = ['Ann', 'Bob', 'Cid'].filter((n) => n !== subject);

  assert.equal((await call(sockets[subject], 'submitMmAnswer', { raw: '100' })).ok, true);
  assert.equal((await call(sockets[closeGuesser], 'submitMmAnswer', { raw: '100' })).ok, true); // bullseye
  const lastRes = await call(sockets[farGuesser], 'submitMmAnswer', { raw: '50' });
  assert.equal(lastRes.ok, true);

  assert.equal(room.phase, 'revealed');
  // totalPlayers = 2 guessers + 1 subject = 3. Rank 1 (bullseye): (3-1) + 2 bonus = 4. Rank 2: 3-2 = 1.
  assert.equal(room.state.mindmeld.scores[closeGuesser], 4);
  assert.equal(room.state.mindmeld.scores[farGuesser], 1);
  assert.equal(room.state.mindmeld.scores[subject], 0, 'the Subject never scores their own round');
});

test('submitMmAnswer: parses k/m/b suffixes and rejects garbage and duplicates', async (t) => {
  t.mock.method(Math, 'random', () => 0.9);
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob', 'Cid'], { game: 'mindmeld', phase: 'lobby' });
  mindMeld.onChoose(ctx, 'AAAA', room);
  const sockets = Object.fromEntries(
    ['Ann', 'Bob', 'Cid'].map((n) => [n, registerGame(mindMeld, ctx, makeHandlerSocket('AAAA', n))])
  );
  const restore = mockOpenAi({ question: 'How many fans does the loudest fan club have?' });
  try {
    await call(sockets[room.hostName], 'startMindMeld');
    await flush();
  } finally {
    restore();
  }

  const subject = room.state.mindmeld.rotationOrder[room.state.mindmeld.rotationIndex];
  const [guesser, otherGuesser] = ['Ann', 'Bob', 'Cid'].filter((n) => n !== subject);

  const garbage = await call(sockets[guesser], 'submitMmAnswer', { raw: 'banana' });
  assert.equal(garbage.ok, false);

  const good = await call(sockets[guesser], 'submitMmAnswer', { raw: '2k' });
  assert.equal(good.ok, true);
  assert.equal(room.state.mindmeld.answers[guesser], 2000);

  const dup = await call(sockets[guesser], 'submitMmAnswer', { raw: '5' });
  assert.equal(dup.ok, false, 'already submitted this round');

  // Finish the round so it resolves and its 60s answer-deadline timer is cleared, instead of
  // leaving a real pending timer dangling past the end of the test.
  await call(sockets[subject], 'submitMmAnswer', { raw: '100' });
  await call(sockets[otherGuesser], 'submitMmAnswer', { raw: '10' });
  assert.equal(room.phase, 'revealed');
});
