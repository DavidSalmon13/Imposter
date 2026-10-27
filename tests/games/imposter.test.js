'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const imposter = require('../../server/games/imposter');
const {
  createTestCtx,
  createRoom,
  makeHandlerSocket,
  registerGame,
  call,
  emissionsFor,
  mockOpenAi,
  mockOpenAiFailure,
  flush,
} = require('../helpers/harness');

test('contract shape', () => {
  assert.equal(imposter.id, 'imposter');
  assert.equal(imposter.minPlayers, 3);
  assert.ok(Array.isArray(imposter.savedFields));
});

test('vote: rejects wrong phase and invalid level, accepts a valid vote', async () => {
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob', 'Cid'], { game: 'imposter', phase: 'playing' });
  const socket = registerGame(imposter, ctx, makeHandlerSocket('AAAA', 'Ann'));

  const wrongPhase = await call(socket, 'vote', 'easy');
  assert.equal(wrongPhase.ok, false);

  room.phase = 'voting';
  const badLevel = await call(socket, 'vote', 'nightmare');
  assert.equal(badLevel.ok, false);

  const good = await call(socket, 'vote', 'easy');
  assert.equal(good.ok, true);
  assert.equal(room.players.get('Ann').vote, 'easy');
});

test('full round: voting -> generated word/roles -> reporting -> scored results', async () => {
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob', 'Cid'], { game: 'imposter', phase: 'lobby' });
  imposter.onChoose(ctx, 'AAAA', room);
  assert.equal(room.phase, 'voting');

  const annSocket = registerGame(imposter, ctx, makeHandlerSocket('AAAA', 'Ann'));
  const bobSocket = registerGame(imposter, ctx, makeHandlerSocket('AAAA', 'Bob'));
  const cidSocket = registerGame(imposter, ctx, makeHandlerSocket('AAAA', 'Cid'));

  const restoreOpenAi = mockOpenAi({ word: 'Guitar', hint: 'You strum it.' });
  try {
    await call(annSocket, 'vote', 'easy');
    await call(bobSocket, 'vote', 'easy');
    // The last vote fires finishVoting without awaiting it, so give that chain a tick to settle.
    await call(cidSocket, 'vote', 'easy');
    await flush();
  } finally {
    restoreOpenAi();
  }

  assert.equal(room.phase, 'playing');
  assert.equal(room.currentLevel, 'easy');

  const roles = ['Ann', 'Bob', 'Cid'].map((n) => room.players.get(n).role);
  const imposterCount = roles.filter((r) => r === 'imposter').length;
  assert.equal(imposterCount, 1, 'exactly one imposter with 3 players');
  assert.equal(roles.filter((r) => r === 'crew').length, 2);

  // Each connected player got their own private 'role' emit with the matching word/hint.
  for (const name of ['Ann', 'Bob', 'Cid']) {
    const p = room.players.get(name);
    const roleEmits = emissionsFor(ctx.io, room, name).filter((e) => e.event === 'role');
    assert.equal(roleEmits.length, 1);
    assert.equal(roleEmits[0].payload.role, p.role);
    if (p.role === 'imposter') {
      assert.equal(roleEmits[0].payload.word, null);
      assert.equal(roleEmits[0].payload.hint, 'You strum it.');
    } else {
      assert.equal(roleEmits[0].payload.word, 'Guitar');
      assert.equal(roleEmits[0].payload.hint, null);
    }
  }

  // Host ends the round -> reporting phase.
  const hostSocket = registerGame(imposter, ctx, makeHandlerSocket('AAAA', room.hostName));
  const endRes = await call(hostSocket, 'endImposterRound');
  assert.equal(endRes.ok, true);
  assert.equal(room.phase, 'reporting');

  // Everyone reports "not eliminated" -> imposter should score 3, crew should score 1 each.
  for (const name of ['Ann', 'Bob', 'Cid']) {
    const sock = registerGame(imposter, ctx, makeHandlerSocket('AAAA', name));
    const res = await call(sock, 'reportEliminated', false);
    assert.equal(res.ok, true);
  }

  assert.equal(room.phase, 'roundResults');
  for (const name of ['Ann', 'Bob', 'Cid']) {
    const p = room.players.get(name);
    const expected = p.role === 'imposter' ? 3 : 1;
    assert.equal(room.scoreboard[name], expected, `${name} (${p.role}) should score ${expected}`);
  }
});

test('failed OpenAI call falls back to voting with an error broadcast', async () => {
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob', 'Cid'], { game: 'imposter', phase: 'voting' });
  const sockets = ['Ann', 'Bob', 'Cid'].map((n) => registerGame(imposter, ctx, makeHandlerSocket('AAAA', n)));

  const restoreOpenAi = mockOpenAiFailure();
  try {
    await call(sockets[0], 'vote', 'easy');
    await call(sockets[1], 'vote', 'easy');
    await call(sockets[2], 'vote', 'easy');
    await flush();
  } finally {
    restoreOpenAi();
  }

  assert.equal(room.phase, 'voting');
  assert.equal(room.currentLevel, null);
});

test('non-host cannot end the round', async () => {
  const { ctx } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob', 'Cid'], { game: 'imposter', phase: 'playing' });
  const socket = registerGame(imposter, ctx, makeHandlerSocket('AAAA', 'Bob'));
  assert.notEqual(room.hostName, 'Bob');

  const res = await call(socket, 'endImposterRound');
  assert.equal(res.ok, false);
  assert.equal(room.phase, 'playing');
});

test('players who closed the app are not dealt in, so they are not scored as eliminated', async () => {
  const { ctx, recordedResults } = createTestCtx();
  const room = createRoom(ctx, 'AAAA', ['Ann', 'Bob', 'Cid', 'Gone'], { game: 'imposter', phase: 'lobby' });
  room.players.get('Gone').connected = false;
  imposter.onChoose(ctx, 'AAAA', room);

  const sockets = Object.fromEntries(
    ['Ann', 'Bob', 'Cid'].map((n) => [n, registerGame(imposter, ctx, makeHandlerSocket('AAAA', n))])
  );
  const restoreOpenAi = mockOpenAi({ word: 'Guitar', hint: 'You strum it.' });
  try {
    for (const n of ['Ann', 'Bob', 'Cid']) await call(sockets[n], 'vote', 'easy');
    await flush();
  } finally {
    restoreOpenAi();
  }
  assert.equal(room.phase, 'playing');
  assert.equal(room.players.get('Gone').role, null);

  await call(sockets.Ann, 'endImposterRound');
  for (const n of ['Ann', 'Bob', 'Cid']) await call(sockets[n], 'reportEliminated', false);

  assert.equal(room.phase, 'roundResults');
  assert.deepEqual(room.imposterRoundResults.map((r) => r.name).sort(), ['Ann', 'Bob', 'Cid']);
  assert.equal(room.scoreboard.Gone, undefined);
  assert.ok(!recordedResults[0].participants.some((p) => p.name === 'Gone'));
});
